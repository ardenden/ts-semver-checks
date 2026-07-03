export type {
  ApiSurface,
  CallSignature,
  ClassSymbol,
  EnumSymbol,
  ExportedSymbol,
  FunctionSymbol,
  InterfaceSymbol,
  Parameter,
  PropertyMember,
  SemverLevel,
  SymbolKind,
  TypeAliasSymbol,
  TypeParameter,
  VariableSymbol,
} from "./model.js";

export { extractSurface } from "./extract.js";
export type { ExtractOptions } from "./extract.js";

export { diffSurfaces } from "./diff.js";

export { classify, sortFindings } from "./findings.js";
export type { Finding } from "./findings.js";

export { checkSurfaces } from "./check.js";
export type { CheckResult } from "./check.js";

export { renderReport } from "./report.js";
export type { RenderOptions } from "./report.js";
