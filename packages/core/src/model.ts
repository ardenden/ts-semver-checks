/**
 * Serializable model of a package's exported type surface.
 *
 * The whole point of this model is that it is plain JSON: a surface can be
 * written to disk (an "API lockfile"), committed, and diffed later against a
 * freshly extracted surface without needing the original TypeScript program.
 */

export type SemverLevel = "major" | "minor" | "patch";

export interface ApiSurface {
  /** Logical identifier of the entry point that produced this surface. */
  entryPoint: string;
  /** Exported symbols keyed by their exported name. */
  exports: Record<string, ExportedSymbol>;
}

export type ExportedSymbol =
  | FunctionSymbol
  | InterfaceSymbol
  | TypeAliasSymbol
  | ClassSymbol
  | EnumSymbol
  | VariableSymbol;

export type SymbolKind = ExportedSymbol["kind"];

export interface TypeParameter {
  name: string;
  constraint?: string;
  default?: string;
}

export interface Parameter {
  name: string;
  /** Rendered type string (normalized via the compiler's printer). */
  type: string;
  optional: boolean;
  rest: boolean;
}

export interface CallSignature {
  typeParameters: TypeParameter[];
  parameters: Parameter[];
  returnType: string;
}

export interface PropertyMember {
  name: string;
  type: string;
  optional: boolean;
  readonly: boolean;
}

export interface FunctionSymbol {
  kind: "function";
  name: string;
  signatures: CallSignature[];
}

export interface InterfaceSymbol {
  kind: "interface";
  name: string;
  typeParameters: TypeParameter[];
  properties: Record<string, PropertyMember>;
  methods: Record<string, CallSignature[]>;
}

export interface TypeAliasSymbol {
  kind: "typeAlias";
  name: string;
  typeParameters: TypeParameter[];
  type: string;
}

export interface ClassSymbol {
  kind: "class";
  name: string;
  abstract: boolean;
  typeParameters: TypeParameter[];
  constructors: CallSignature[];
  properties: Record<string, PropertyMember>;
  methods: Record<string, CallSignature[]>;
}

export interface EnumSymbol {
  kind: "enum";
  name: string;
  const: boolean;
  /** Member name -> constant value rendered as a string (or `undefined` if computed). */
  members: Record<string, string>;
}

export interface VariableSymbol {
  kind: "variable";
  name: string;
  const: boolean;
  type: string;
}
