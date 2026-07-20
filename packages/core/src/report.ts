import type { SemverLevel } from "./model.js";
import type { CheckResult } from "./check.js";

export interface RenderOptions {
  /** Emit ANSI colors. Default: false (caller decides based on TTY). */
  color?: boolean;
}

const LEVEL_LABEL: Record<SemverLevel, string> = {
  major: "MAJOR",
  minor: "MINOR",
  patch: "PATCH",
};

const ANSI: Record<SemverLevel | "dim" | "bold" | "reset", string> = {
  major: "\x1b[31m", // red
  minor: "\x1b[33m", // yellow
  patch: "\x1b[32m", // green
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

/** Render a check result as a human-readable, optionally colored report. */
export function renderReport(result: CheckResult, options: RenderOptions = {}): string {
  const paint = (code: keyof typeof ANSI, text: string) =>
    options.color ? `${ANSI[code]}${text}${ANSI.reset}` : text;

  const lines: string[] = [];
  const counts: Record<SemverLevel, number> = { major: 0, minor: 0, patch: 0 };
  for (const f of result.findings) counts[f.level]++;

  if (result.findings.length === 0) {
    lines.push(paint("patch", "No public API changes detected."));
    lines.push("");
    lines.push(`Required version bump: ${paint("patch", LEVEL_LABEL.patch)}`);
    return lines.join("\n");
  }

  for (const f of result.findings) {
    const badge = paint(f.level, LEVEL_LABEL[f.level].padEnd(5));
    lines.push(`${badge}  ${f.message}`);
    // Qualify the location with the package and exports subpath when there is
    // one, so a finding in "./utils" of one workspace package isn't mistaken
    // for one in another package's root entry point.
    const parts = [f.packageName, f.entryPoint, f.path].filter(Boolean);
    lines.push(`       ${paint("dim", `${f.code} @ ${parts.join(" → ")}`)}`);
  }

  lines.push("");
  const summary = `${counts.major} major, ${counts.minor} minor`;
  lines.push(paint("dim", summary));
  lines.push(
    `Required version bump: ${paint("bold", "")}${paint(result.level, LEVEL_LABEL[result.level])}`,
  );

  return lines.join("\n");
}
