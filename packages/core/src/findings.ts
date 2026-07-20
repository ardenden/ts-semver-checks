import type { SemverLevel } from "./model.js";

export interface Finding {
  /** The semver impact of this single change. */
  level: SemverLevel;
  /** Stable machine-readable code, e.g. `export.removed`, `param.typeChanged`. */
  code: string;
  /**
   * Dotted path to the affected surface location, e.g. `parseConfig.params[0]`.
   * Always relative to its entry point — never prefixed with the subpath — so
   * assignability refinement can resolve it against the compiler's symbols.
   */
  path: string;
  /**
   * The package `exports` subpath this finding came from, e.g. `./utils`.
   * Omitted for the root entry point and for single-entry comparisons.
   */
  entryPoint?: string;
  /**
   * The workspace package this finding came from, e.g. `@scope/utils`.
   * Only set when checking a monorepo workspace.
   */
  packageName?: string;
  /** Human-readable one-line explanation. */
  message: string;
}

const ORDER: Record<SemverLevel, number> = { patch: 0, minor: 1, major: 2 };

/** Reduce a set of findings to the single highest-impact semver level. */
export function classify(findings: readonly Finding[]): SemverLevel {
  let level: SemverLevel = "patch";
  for (const f of findings) {
    if (ORDER[f.level] > ORDER[level]) level = f.level;
  }
  return level;
}

/**
 * Sort findings most-severe first, then grouped by package and entry point
 * (root first), then by path for stable output.
 */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const byLevel = ORDER[b.level] - ORDER[a.level];
    if (byLevel !== 0) return byLevel;
    const byPackage = (a.packageName ?? "").localeCompare(b.packageName ?? "");
    if (byPackage !== 0) return byPackage;
    // Root/unlabelled entry point sorts before named subpaths.
    const byEntry = (a.entryPoint ?? "").localeCompare(b.entryPoint ?? "");
    if (byEntry !== 0) return byEntry;
    return a.path.localeCompare(b.path);
  });
}
