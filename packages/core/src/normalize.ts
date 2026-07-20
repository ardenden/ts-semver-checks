import type {
  ApiSurface,
  CallSignature,
  ClassSymbol,
  ExportedSymbol,
  InterfaceSymbol,
  PropertyMember,
  TypeAliasSymbol,
  TypeParameter,
} from "./model.js";

/**
 * Alpha-normalize type-parameter names in an extracted surface.
 *
 * A type parameter's name is a local binding: callers instantiate it
 * positionally (`map<string, number>(...)`) and cannot refer to it by name, so
 * renaming `<T, U>` to `<TIn, TOut>` is not observable to consumers. Comparing
 * the rendered type strings directly would report every such rename as a pile
 * of breaking type changes.
 *
 * Each type parameter in scope is therefore rewritten to a positional
 * placeholder before diffing, so two surfaces that differ only in type
 * parameter *names* compare equal, while a change in which position a type is
 * used at still shows up. Declared names are preserved on the `TypeParameter`
 * nodes themselves so report messages stay readable.
 */
export function normalizeTypeParameters(surface: ApiSurface): ApiSurface {
  const exports: Record<string, ExportedSymbol> = {};
  for (const [name, symbol] of Object.entries(surface.exports)) {
    exports[name] = normalizeSymbol(symbol);
  }
  return { ...surface, exports };
}

type Scope = ReadonlyMap<string, string>;

const EMPTY_SCOPE: Scope = new Map();

function normalizeSymbol(symbol: ExportedSymbol): ExportedSymbol {
  switch (symbol.kind) {
    case "function":
      return { ...symbol, signatures: symbol.signatures.map((s) => normalizeSignature(s, EMPTY_SCOPE)) };
    case "interface":
      return normalizeInterface(symbol);
    case "class":
      return normalizeClass(symbol);
    case "typeAlias":
      return normalizeTypeAlias(symbol);
    default:
      // Enums and variables have no type parameters of their own.
      return symbol;
  }
}

function normalizeInterface(symbol: InterfaceSymbol): InterfaceSymbol {
  const scope = containerScope(symbol.typeParameters);
  return {
    ...symbol,
    typeParameters: normalizeTypeParamNodes(symbol.typeParameters, scope),
    properties: normalizeProperties(symbol.properties, scope),
    methods: normalizeMethods(symbol.methods, scope),
  };
}

function normalizeClass(symbol: ClassSymbol): ClassSymbol {
  const scope = containerScope(symbol.typeParameters);
  return {
    ...symbol,
    typeParameters: normalizeTypeParamNodes(symbol.typeParameters, scope),
    constructors: symbol.constructors.map((s) => normalizeSignature(s, scope)),
    properties: normalizeProperties(symbol.properties, scope),
    methods: normalizeMethods(symbol.methods, scope),
  };
}

function normalizeTypeAlias(symbol: TypeAliasSymbol): TypeAliasSymbol {
  const scope = containerScope(symbol.typeParameters);
  return {
    ...symbol,
    typeParameters: normalizeTypeParamNodes(symbol.typeParameters, scope),
    type: substitute(symbol.type, scope),
  };
}

/** Positional placeholders for a container's (interface/class/alias) parameters. */
function containerScope(typeParameters: readonly TypeParameter[]): Scope {
  const scope = new Map<string, string>();
  typeParameters.forEach((tp, i) => scope.set(tp.name, `«c${i}»`));
  return scope;
}

function normalizeSignature(sig: CallSignature, outer: Scope): CallSignature {
  // A signature's own type parameters shadow the container's.
  const scope = new Map(outer);
  sig.typeParameters.forEach((tp, i) => scope.set(tp.name, `«s${i}»`));

  return {
    typeParameters: normalizeTypeParamNodes(sig.typeParameters, scope),
    parameters: sig.parameters.map((p) => ({ ...p, type: substitute(p.type, scope) })),
    returnType: substitute(sig.returnType, scope),
  };
}

function normalizeTypeParamNodes(
  typeParameters: readonly TypeParameter[],
  scope: Scope,
): TypeParameter[] {
  return typeParameters.map((tp) => {
    // Keep `name` as declared: it is not compared (a rename alone produces no
    // finding) and it keeps report messages readable.
    const result: TypeParameter = { name: tp.name };
    if (tp.constraint !== undefined) result.constraint = substitute(tp.constraint, scope);
    if (tp.default !== undefined) result.default = substitute(tp.default, scope);
    return result;
  });
}

function normalizeProperties(
  properties: Record<string, PropertyMember>,
  scope: Scope,
): Record<string, PropertyMember> {
  const out: Record<string, PropertyMember> = {};
  for (const [name, prop] of Object.entries(properties)) {
    out[name] = { ...prop, type: substitute(prop.type, scope) };
  }
  return out;
}

function normalizeMethods(
  methods: Record<string, CallSignature[]>,
  scope: Scope,
): Record<string, CallSignature[]> {
  const out: Record<string, CallSignature[]> = {};
  for (const [name, signatures] of Object.entries(methods)) {
    out[name] = signatures.map((s) => normalizeSignature(s, scope));
  }
  return out;
}

/**
 * Replace whole-identifier occurrences of in-scope type parameters. Matching
 * complete identifiers means `T` never matches inside `TValue` or `Toolbar`,
 * and placeholders (which contain `«»`) can't be rewritten again by a later
 * pass.
 */
function substitute(text: string, scope: Scope): string {
  if (scope.size === 0) return text;
  return text.replace(/[A-Za-z_$][A-Za-z0-9_$]*/g, (id) => scope.get(id) ?? id);
}
