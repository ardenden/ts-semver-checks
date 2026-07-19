import * as path from "node:path";
import ts from "typescript";
import type { Finding } from "./findings.js";

/**
 * Assignability-based refinement of structural findings.
 *
 * The structural differ (diff.ts) compares types as strings and, when it can't
 * prove a direction, conservatively reports `major`. This module builds a single
 * program containing BOTH the old and new entry points — so one type checker can
 * compare types across the two versions — and uses the compiler's assignability
 * relation to reclassify the cases where variance is unambiguous:
 *
 *   - Parameters are contravariant: a widened parameter (new accepts everything
 *     old did) is non-breaking (minor); a narrowed one is breaking (major).
 *   - Return types, and READONLY properties (read-only = consumers only ever
 *     read them, same as a return type), are covariant: narrowing is
 *     non-breaking (minor); widening is breaking (major).
 *   - Mutable properties and type aliases can be used by unknown consumers in
 *     both read and write positions, so direction can't be safely assumed for
 *     them; only mutual assignability (true equivalence, e.g. `string[]` vs
 *     `Array<string>`) is reclassified — as a dropped false positive — and any
 *     other change is left exactly as the structural differ reported it.
 *   - A type-parameter constraint is an upper bound on what callers may
 *     instantiate the parameter with. Relaxing/removing it (old bound assignable
 *     to new) is non-breaking (minor); tightening/adding it is breaking (major).
 *
 * Anything it can't confidently reclassify is left exactly as-is.
 */

interface FnSignature {
  params: ts.Type[];
  ret: ts.Type;
}

interface PropertyInfo {
  type: ts.Type;
  readonly: boolean;
}

interface Comparison {
  checker: ts.TypeChecker;
  oldFns: Map<string, FnSignature>;
  newFns: Map<string, FnSignature>;
  oldProps: Map<string, PropertyInfo>;
  newProps: Map<string, PropertyInfo>;
  oldAliases: Map<string, ts.Type>;
  newAliases: Map<string, ts.Type>;
  // owner name -> per-position type-parameter constraint (undefined = unconstrained)
  oldConstraints: Map<string, (ts.Type | undefined)[]>;
  newConstraints: Map<string, (ts.Type | undefined)[]>;
}

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
};

const PARAM_PATH = /^(.+)\.params\[(\d+)\]$/;
const RETURN_PATH = /^(.+)\.returnType$/;
const TYPEPARAM_PATH = /^(.+)\.typeParams\[(\d+)\]$/;

/**
 * Refine structural findings using assignability. Returns a new list; findings
 * that turn out to be false positives are omitted. If the combined program can't
 * be built, the input findings are returned unchanged.
 */
export function refineFindings(
  findings: readonly Finding[],
  oldEntry: string,
  newEntry: string,
  compilerOptions?: ts.CompilerOptions,
): Finding[] {
  const cmp = buildComparison(oldEntry, newEntry, compilerOptions);
  if (!cmp) return [...findings];

  const out: Finding[] = [];
  for (const finding of findings) {
    const refined = refineOne(finding, cmp);
    if (refined) out.push(refined);
  }
  return out;
}

function buildComparison(
  oldEntry: string,
  newEntry: string,
  compilerOptions?: ts.CompilerOptions,
): Comparison | undefined {
  const oldPath = path.resolve(oldEntry);
  const newPath = path.resolve(newEntry);
  if (oldPath === newPath) return undefined;

  let program: ts.Program;
  try {
    program = ts.createProgram({
      rootNames: [oldPath, newPath],
      options: { ...DEFAULT_COMPILER_OPTIONS, ...compilerOptions },
    });
  } catch {
    return undefined;
  }

  const checker = program.getTypeChecker();
  const oldCollected = collectSymbols(program, checker, oldPath);
  const newCollected = collectSymbols(program, checker, newPath);
  if (!oldCollected || !newCollected) return undefined;

  return {
    checker,
    oldFns: oldCollected.fns,
    newFns: newCollected.fns,
    oldProps: oldCollected.props,
    newProps: newCollected.props,
    oldAliases: oldCollected.aliases,
    newAliases: newCollected.aliases,
    oldConstraints: oldCollected.constraints,
    newConstraints: newCollected.constraints,
  };
}

interface Collected {
  fns: Map<string, FnSignature>;
  props: Map<string, PropertyInfo>;
  aliases: Map<string, ts.Type>;
  constraints: Map<string, (ts.Type | undefined)[]>;
}

function collectSymbols(
  program: ts.Program,
  checker: ts.TypeChecker,
  entry: string,
): Collected | undefined {
  const sourceFile = program.getSourceFile(entry);
  if (!sourceFile) return undefined;
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    return { fns: new Map(), props: new Map(), aliases: new Map(), constraints: new Map() };
  }

  const fns = new Map<string, FnSignature>();
  const props = new Map<string, PropertyInfo>();
  const aliases = new Map<string, ts.Type>();
  const constraints = new Map<string, (ts.Type | undefined)[]>();

  const add = (name: string, symbol: ts.Symbol) => {
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const flags = resolved.getFlags();

    if (flags & ts.SymbolFlags.Function) {
      addFunction(name, resolved, checker, fns);
    } else if (flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) {
      addMembers(name, resolved, checker, props);
    } else if (flags & ts.SymbolFlags.TypeAlias) {
      aliases.set(name, checker.getDeclaredTypeOfSymbol(resolved));
    }

    const tpConstraints = collectConstraints(resolved, checker);
    if (tpConstraints) constraints.set(name, tpConstraints);
  };

  for (const exp of checker.getExportsOfModule(moduleSymbol)) {
    add(exp.getName(), exp);
  }
  const exportEquals = moduleSymbol.exports?.get("export=" as ts.__String);
  if (exportEquals) add("export=", exportEquals);

  return { fns, props, aliases, constraints };
}

/**
 * Per-position declared constraints of a symbol's type parameters, in order.
 * `undefined` at a position means that parameter is unconstrained. Returns
 * undefined when the symbol declares no type parameters.
 */
function collectConstraints(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): (ts.Type | undefined)[] | undefined {
  const decl = symbol
    .getDeclarations()
    ?.find((d) => (d as { typeParameters?: unknown }).typeParameters !== undefined);
  const tps = (decl as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> } | undefined)
    ?.typeParameters;
  if (!tps || tps.length === 0) return undefined;

  return tps.map((tp) => {
    if (!tp.constraint) return undefined;
    return checker.getTypeFromTypeNode(tp.constraint);
  });
}

function addFunction(
  name: string,
  resolved: ts.Symbol,
  checker: ts.TypeChecker,
  fns: Map<string, FnSignature>,
): void {
  if ((resolved.getFlags() & ts.SymbolFlags.Function) === 0) return;
  const decl = resolved.getDeclarations()?.[0] ?? resolved.valueDeclaration;
  if (!decl) return;
  const type = checker.getTypeOfSymbolAtLocation(resolved, decl);
  const signatures = type.getCallSignatures();
  // Only single-signature functions are refined; overloads are left as-is.
  if (signatures.length !== 1) return;
  const sig = signatures[0]!;
  const params = sig.getParameters().map((p) => {
    const pd = p.valueDeclaration ?? p.declarations?.[0];
    return pd ? checker.getTypeOfSymbolAtLocation(p, pd) : checker.getTypeOfSymbol(p);
  });
  fns.set(name, { params, ret: sig.getReturnType() });
}

function addMembers(
  ownerName: string,
  resolved: ts.Symbol,
  checker: ts.TypeChecker,
  props: Map<string, PropertyInfo>,
): void {
  const type = checker.getDeclaredTypeOfSymbol(resolved);
  for (const member of type.getProperties()) {
    if (member.getFlags() & ts.SymbolFlags.Method) continue; // methods refined structurally only
    const decl = member.getDeclarations()?.[0];
    const memberType = decl
      ? checker.getTypeOfSymbolAtLocation(member, decl)
      : checker.getTypeOfSymbol(member);
    props.set(`${ownerName}.${member.getName()}`, {
      type: memberType,
      readonly: isReadonlyMember(member),
    });
  }
}

function isReadonlyMember(member: ts.Symbol): boolean {
  const decl = member.getDeclarations()?.[0];
  if (!decl || !ts.canHaveModifiers(decl)) return false;
  return ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
}

function refineOne(finding: Finding, cmp: Comparison): Finding | null {
  if (finding.code === "param.typeChanged") {
    const m = PARAM_PATH.exec(finding.path);
    if (!m) return finding;
    const fnName = m[1]!;
    const index = Number(m[2]);
    const oldT = cmp.oldFns.get(fnName)?.params[index];
    const newT = cmp.newFns.get(fnName)?.params[index];
    if (!oldT || !newT) return finding;

    const oldToNew = cmp.checker.isTypeAssignableTo(oldT, newT);
    const newToOld = cmp.checker.isTypeAssignableTo(newT, oldT);

    if (oldToNew && newToOld) return null; // equivalent types → false positive
    if (oldToNew) {
      // New parameter accepts everything the old one did → widening → safe.
      return {
        ...finding,
        level: "minor",
        code: "param.typeWidened",
        message: finding.message.replace("type changed", "type widened") +
          " (still accepts all previous inputs).",
      };
    }
    return finding; // narrowed or incompatible → stays major
  }

  if (finding.code === "returnType.changed") {
    const m = RETURN_PATH.exec(finding.path);
    if (!m) return finding;
    const fnName = m[1]!;
    const oldR = cmp.oldFns.get(fnName)?.ret;
    const newR = cmp.newFns.get(fnName)?.ret;
    if (!oldR || !newR) return finding;

    return refineCovariant(finding, cmp.checker, oldR, newR, "returnType.narrowed", "return type");
  }

  if (finding.code === "property.typeChanged") {
    const oldP = cmp.oldProps.get(finding.path);
    const newP = cmp.newProps.get(finding.path);
    if (!oldP || !newP) return finding;

    // Both a reader (return-like) and a writer (param-like) unless the
    // property is readonly in both versions, in which case only reads are
    // possible and it is safe to treat like a return type (covariant).
    if (!oldP.readonly || !newP.readonly) {
      return refineInvariant(finding, cmp.checker, oldP.type, newP.type);
    }
    return refineCovariant(finding, cmp.checker, oldP.type, newP.type, "property.typeNarrowed", "property type");
  }

  if (finding.code === "typeAlias.changed") {
    const oldA = cmp.oldAliases.get(finding.path);
    const newA = cmp.newAliases.get(finding.path);
    if (!oldA || !newA) return finding;
    // A type alias's consumer-side variance is unknowable from the
    // declaration alone, so only equivalence (not directional widen/narrow)
    // is safe to reclassify here.
    return refineInvariant(finding, cmp.checker, oldA, newA);
  }

  if (finding.code === "generics.constraintChanged") {
    const m = TYPEPARAM_PATH.exec(finding.path);
    if (!m) return finding;
    const owner = m[1]!;
    const index = Number(m[2]);
    const oldC = cmp.oldConstraints.get(owner)?.[index];
    const newC = cmp.newConstraints.get(owner)?.[index];
    return refineConstraint(finding, cmp.checker, oldC, newC);
  }

  return finding;
}

/**
 * A type-parameter constraint is an upper bound on what callers may instantiate
 * the parameter with, so relaxing/removing it is safe (more instantiations
 * allowed) while tightening/adding it is breaking. Backward compatibility holds
 * iff the old bound is assignable to the new one.
 */
function refineConstraint(
  finding: Finding,
  checker: ts.TypeChecker,
  oldC: ts.Type | undefined,
  newC: ts.Type | undefined,
): Finding | null {
  const relaxed = (): Finding => ({
    ...finding,
    level: "minor",
    code: "generics.constraintRelaxed",
    message: finding.message.replace("constraint changed", "constraint relaxed") +
      " (accepts at least all previously-valid type arguments).",
  });

  // Removing a constraint entirely is an unambiguous relaxation.
  if (oldC && !newC) return relaxed();
  // Adding a constraint where there was none narrows what's allowed → breaking.
  if (!oldC && newC) return finding;
  // Both unconstrained: nothing meaningful changed.
  if (!oldC && !newC) return null;

  const oldToNew = checker.isTypeAssignableTo(oldC!, newC!);
  const newToOld = checker.isTypeAssignableTo(newC!, oldC!);
  if (oldToNew && newToOld) return null; // equivalent constraints
  if (oldToNew) return relaxed(); // new bound accepts everything the old did → safe
  return finding; // tightened or incompatible → stays major
}

/** Covariant refinement (return types, readonly properties): narrowing is safe. */
function refineCovariant(
  finding: Finding,
  checker: ts.TypeChecker,
  oldType: ts.Type,
  newType: ts.Type,
  narrowedCode: string,
  label: string,
): Finding | null {
  const newToOld = checker.isTypeAssignableTo(newType, oldType);
  const oldToNew = checker.isTypeAssignableTo(oldType, newType);

  if (newToOld && oldToNew) return null; // equivalent
  if (newToOld) {
    return {
      ...finding,
      level: "minor",
      code: narrowedCode,
      message: finding.message.replace(/(type )?changed/, "$1narrowed") +
        ` (a subtype of the previous ${label}).`,
    };
  }
  return finding; // widened or incompatible → stays major
}

/** Invariant refinement (mutable properties, type aliases): only equivalence is safe. */
function refineInvariant(
  finding: Finding,
  checker: ts.TypeChecker,
  oldType: ts.Type,
  newType: ts.Type,
): Finding | null {
  const oldToNew = checker.isTypeAssignableTo(oldType, newType);
  const newToOld = checker.isTypeAssignableTo(newType, oldType);
  return oldToNew && newToOld ? null : finding;
}
