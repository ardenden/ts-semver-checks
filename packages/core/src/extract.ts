import * as path from "node:path";
import ts from "typescript";
import type {
  ApiSurface,
  CallSignature,
  ClassSymbol,
  EnumSymbol,
  ExportedSymbol,
  FunctionSymbol,
  InterfaceSymbol,
  Parameter,
  PropertyMember,
  TypeAliasSymbol,
  TypeParameter,
  VariableSymbol,
} from "./model.js";
import { normalizeTypeParameters } from "./normalize.js";

export interface ExtractOptions {
  /** Path to the entry file (`.ts` or `.d.ts`) whose exports form the surface. */
  entryPoint: string;
  /** Compiler options to use. Sensible strict defaults are applied when omitted. */
  compilerOptions?: ts.CompilerOptions;
  /**
   * Pre-built program to reuse (e.g. one created over a whole package). When
   * provided, `compilerOptions` is ignored.
   */
  program?: ts.Program;
}

// NOTE: deliberately NOT using UseFullyQualifiedType — it renders local types
// as their absolute import path (which differs between two builds/checkouts of
// the same package), producing false "type changed" findings.
const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrayAsGenericType;

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
};

/**
 * Extract the exported type surface reachable from a single entry point.
 *
 * NOTE: Types are captured as normalized strings produced by the compiler's
 * printer. Diffing therefore compares structure, not assignability — see
 * `diff.ts` for how that shapes classification and its known limitations.
 */
export function extractSurface(options: ExtractOptions): ApiSurface {
  const entryPoint = path.resolve(options.entryPoint);
  const program =
    options.program ??
    ts.createProgram({
      rootNames: [entryPoint],
      options: { ...DEFAULT_COMPILER_OPTIONS, ...options.compilerOptions },
    });

  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entryPoint);
  if (!sourceFile) {
    throw new Error(`Could not load entry point as a source file: ${entryPoint}`);
  }

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    // A source file with no exports still yields an empty, valid surface.
    return { entryPoint: options.entryPoint, exports: {} };
  }

  const exports: Record<string, ExportedSymbol> = {};
  for (const exportSymbol of checker.getExportsOfModule(moduleSymbol)) {
    const resolved = resolveAlias(exportSymbol, checker);
    const serialized = serializeSymbol(exportSymbol.getName(), resolved, checker);
    if (serialized) {
      exports[exportSymbol.getName()] = serialized;
    }
  }

  // CommonJS `export = X` (TypeScript export-assignment) is not returned by
  // getExportsOfModule; it lives on the module symbol under "export=". This is
  // how packages like `mri` expose their main function.
  const exportEquals = moduleSymbol.exports?.get("export=" as ts.__String);
  if (exportEquals) {
    const resolved = resolveAlias(exportEquals, checker);
    const serialized = serializeSymbol("export=", resolved, checker);
    if (serialized) {
      exports["export="] = serialized;
    }
  }

  // Rewrite type-parameter names to positional placeholders so that a pure
  // rename (`<T, U>` -> `<TIn, TOut>`) doesn't read as a pile of type changes.
  return normalizeTypeParameters({ entryPoint: options.entryPoint, exports });
}

function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function serializeSymbol(
  name: string,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): ExportedSymbol | undefined {
  const flags = symbol.getFlags();

  if (flags & ts.SymbolFlags.TypeAlias) return serializeTypeAlias(name, symbol, checker);
  if (flags & ts.SymbolFlags.Interface) return serializeInterface(name, symbol, checker);
  if (flags & ts.SymbolFlags.Class) return serializeClass(name, symbol, checker);
  if (flags & ts.SymbolFlags.Enum || flags & ts.SymbolFlags.ConstEnum)
    return serializeEnum(name, symbol, checker);
  if (flags & ts.SymbolFlags.Function) return serializeFunction(name, symbol, checker);
  if (flags & (ts.SymbolFlags.Variable | ts.SymbolFlags.BlockScopedVariable))
    return serializeVariable(name, symbol, checker);

  return undefined;
}

function firstDeclaration(symbol: ts.Symbol): ts.Declaration | undefined {
  return symbol.getDeclarations()?.[0] ?? symbol.valueDeclaration;
}

function typeToString(type: ts.Type, checker: ts.TypeChecker, enclosing?: ts.Node): string {
  return checker.typeToString(type, enclosing, TYPE_FORMAT_FLAGS);
}

/**
 * Render the type of a declared member. Prefers the author's written type
 * annotation when present, because the compiler's resolved type for optional
 * parameters/properties includes a synthetic `| undefined` that would otherwise
 * make `foo?: string` and `foo: string` look like unrelated types.
 */
function annotatedTypeString(
  decl: ts.Declaration | undefined,
  fallback: ts.Type,
  checker: ts.TypeChecker,
): string {
  if (
    decl &&
    (ts.isParameter(decl) || ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl)) &&
    decl.type
  ) {
    return decl.type.getText();
  }
  return typeToString(fallback, checker, decl);
}

function serializeTypeParameters(
  params: readonly ts.TypeParameterDeclaration[] | undefined,
  checker: ts.TypeChecker,
): TypeParameter[] {
  if (!params) return [];
  return params.map((tp) => {
    const result: TypeParameter = { name: tp.name.text };
    if (tp.constraint) result.constraint = tp.constraint.getText();
    if (tp.default) result.default = tp.default.getText();
    return result;
  });
}

function serializeSignature(sig: ts.Signature, checker: ts.TypeChecker): CallSignature {
  const parameters: Parameter[] = sig.getParameters().map((paramSymbol) => {
    const decl = paramSymbol.valueDeclaration as ts.ParameterDeclaration | undefined;
    const paramType = checker.getTypeOfSymbolAtLocation(
      paramSymbol,
      decl ?? paramSymbol.declarations![0]!,
    );
    return {
      name: paramSymbol.getName(),
      type: annotatedTypeString(decl, paramType, checker),
      optional: decl ? checker.isOptionalParameter(decl) : false,
      rest: decl?.dotDotDotToken !== undefined,
    };
  });

  const typeParameters = (sig.getTypeParameters() ?? []).map((tp): TypeParameter => {
    const result: TypeParameter = { name: tp.symbol.getName() };
    const constraint = tp.getConstraint();
    if (constraint) result.constraint = typeToString(constraint, checker);
    const dflt = tp.getDefault();
    if (dflt) result.default = typeToString(dflt, checker);
    return result;
  });

  return {
    typeParameters,
    parameters,
    returnType: typeToString(sig.getReturnType(), checker),
  };
}

function serializeFunction(
  name: string,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): FunctionSymbol {
  const decl = firstDeclaration(symbol);
  const type = checker.getTypeOfSymbolAtLocation(symbol, decl ?? symbol.valueDeclaration!);
  const signatures = type.getCallSignatures().map((sig) => serializeSignature(sig, checker));
  return { kind: "function", name, signatures };
}

function isMethodSymbol(member: ts.Symbol): boolean {
  return (member.getFlags() & ts.SymbolFlags.Method) !== 0;
}

function isReadonlyMember(member: ts.Symbol): boolean {
  const decl = member.getDeclarations()?.[0];
  if (!decl || !ts.canHaveModifiers(decl)) return false;
  return (
    ts
      .getModifiers(decl)
      ?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false
  );
}

function serializeProperty(member: ts.Symbol, checker: ts.TypeChecker): PropertyMember {
  const decl = member.getDeclarations()?.[0];
  const type = decl
    ? checker.getTypeOfSymbolAtLocation(member, decl)
    : checker.getTypeOfSymbol(member);
  return {
    name: member.getName(),
    type: annotatedTypeString(decl, type, checker),
    optional: (member.getFlags() & ts.SymbolFlags.Optional) !== 0,
    readonly: isReadonlyMember(member),
  };
}

function serializeMembers(
  type: ts.Type,
  checker: ts.TypeChecker,
): { properties: Record<string, PropertyMember>; methods: Record<string, CallSignature[]> } {
  const properties: Record<string, PropertyMember> = {};
  const methods: Record<string, CallSignature[]> = {};

  for (const member of type.getProperties()) {
    const memberName = member.getName();
    // Skip private / internal members (leading underscore is a common convention,
    // and truly private class members are excluded from the apparent type already).
    if (isMethodSymbol(member)) {
      const decl = member.getDeclarations()?.[0];
      const memberType = decl
        ? checker.getTypeOfSymbolAtLocation(member, decl)
        : checker.getTypeOfSymbol(member);
      const sigs = memberType.getCallSignatures().map((s) => serializeSignature(s, checker));
      methods[memberName] = sigs;
    } else {
      properties[memberName] = serializeProperty(member, checker);
    }
  }

  return { properties, methods };
}

function serializeTypeAlias(
  name: string,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): TypeAliasSymbol {
  const decl = symbol.getDeclarations()?.find(ts.isTypeAliasDeclaration);
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  // Prefer the written type text when available; fall back to the resolved type.
  const rendered = decl?.type ? decl.type.getText() : typeToString(type, checker, decl);
  return {
    kind: "typeAlias",
    name,
    typeParameters: serializeTypeParameters(decl?.typeParameters, checker),
    type: rendered,
  };
}

function serializeInterface(
  name: string,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): InterfaceSymbol {
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  const decl = symbol.getDeclarations()?.find(ts.isInterfaceDeclaration);
  const { properties, methods } = serializeMembers(type, checker);
  return {
    kind: "interface",
    name,
    typeParameters: serializeTypeParameters(decl?.typeParameters, checker),
    properties,
    methods,
  };
}

function serializeClass(name: string, symbol: ts.Symbol, checker: ts.TypeChecker): ClassSymbol {
  const instanceType = checker.getDeclaredTypeOfSymbol(symbol);
  const decl = symbol.getDeclarations()?.find(ts.isClassDeclaration);
  const { properties, methods } = serializeMembers(instanceType, checker);

  // Construct signatures live on the static (constructor) side of the class.
  const staticType = checker.getTypeOfSymbolAtLocation(
    symbol,
    decl ?? symbol.valueDeclaration!,
  );
  const constructors = staticType
    .getConstructSignatures()
    .map((sig) => serializeSignature(sig, checker));

  const abstract =
    decl?.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) ?? false;

  return {
    kind: "class",
    name,
    abstract,
    typeParameters: serializeTypeParameters(decl?.typeParameters, checker),
    constructors,
    properties,
    methods,
  };
}

function serializeEnum(name: string, symbol: ts.Symbol, checker: ts.TypeChecker): EnumSymbol {
  const members: Record<string, string> = {};
  const isConst = (symbol.getFlags() & ts.SymbolFlags.ConstEnum) !== 0;

  for (const decl of symbol.getDeclarations() ?? []) {
    if (!ts.isEnumDeclaration(decl)) continue;
    for (const member of decl.members) {
      const memberName = member.name.getText();
      const value = checker.getConstantValue(member);
      members[memberName] = value === undefined ? "<computed>" : String(value);
    }
  }

  return { kind: "enum", name, const: isConst, members };
}

function serializeVariable(
  name: string,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): VariableSymbol {
  const decl = firstDeclaration(symbol);
  const type = checker.getTypeOfSymbolAtLocation(symbol, decl ?? symbol.valueDeclaration!);
  const isConst =
    decl !== undefined &&
    ts.isVariableDeclaration(decl) &&
    decl.parent !== undefined &&
    ts.isVariableDeclarationList(decl.parent) &&
    (decl.parent.flags & ts.NodeFlags.Const) !== 0;

  return { kind: "variable", name, const: isConst, type: typeToString(type, checker, decl) };
}
