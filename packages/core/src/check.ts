import type { ApiSurface, SemverLevel } from "./model.js";
import { diffSurfaces } from "./diff.js";
import { classify, sortFindings, type Finding } from "./findings.js";

export interface CheckResult {
  /** The highest-impact semver level across all findings. */
  level: SemverLevel;
  /** All findings, sorted most-severe first. */
  findings: Finding[];
}

/**
 * Convenience: diff two surfaces and classify the result in one step.
 */
export function checkSurfaces(before: ApiSurface, after: ApiSurface): CheckResult {
  const findings = sortFindings(diffSurfaces(before, after));
  return { level: classify(findings), findings };
}
