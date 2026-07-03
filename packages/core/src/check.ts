import type ts from "typescript";
import type { ApiSurface, SemverLevel } from "./model.js";
import { extractSurface } from "./extract.js";
import { diffSurfaces } from "./diff.js";
import { refineFindings } from "./assignability.js";
import { classify, sortFindings, type Finding } from "./findings.js";

export interface CheckResult {
  /** The highest-impact semver level across all findings. */
  level: SemverLevel;
  /** All findings, sorted most-severe first. */
  findings: Finding[];
}

/**
 * Diff two already-extracted surfaces and classify the result.
 *
 * This is the pure, string-model path — use it when you only have serialized
 * surfaces (e.g. a committed API lockfile). For the most accurate result when
 * both source entry points are available, prefer {@link checkEntries}, which
 * additionally applies assignability-based refinement.
 */
export function checkSurfaces(before: ApiSurface, after: ApiSurface): CheckResult {
  const findings = sortFindings(diffSurfaces(before, after));
  return { level: classify(findings), findings };
}

export interface CheckEntriesOptions {
  /**
   * Apply assignability-based refinement (distinguish widening from narrowing,
   * drop false-positive type changes). Default: true.
   */
  assignability?: boolean;
  compilerOptions?: ts.CompilerOptions;
}

/**
 * Extract, diff, and classify two packages given their entry points. When
 * `assignability` is enabled (default), a combined program is built from both
 * entries so type changes can be classified by variance instead of the
 * conservative string comparison.
 */
export function checkEntries(
  oldEntry: string,
  newEntry: string,
  options: CheckEntriesOptions = {},
): CheckResult {
  const before = extractSurface({ entryPoint: oldEntry, compilerOptions: options.compilerOptions });
  const after = extractSurface({ entryPoint: newEntry, compilerOptions: options.compilerOptions });

  let findings = diffSurfaces(before, after);
  if (options.assignability !== false) {
    findings = refineFindings(findings, oldEntry, newEntry, options.compilerOptions);
  }

  findings = sortFindings(findings);
  return { level: classify(findings), findings };
}
