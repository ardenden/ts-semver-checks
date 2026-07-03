import * as fs from "node:fs";
import {
  checkSurfaces,
  extractSurface,
  renderReport,
  type CheckResult,
  type SemverLevel,
} from "@ts-semver-checks/core";
import { ArgError, HELP_TEXT, parseArgs, type ParsedArgs } from "./args.js";

export interface RunIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  version: string;
}

const LEVEL_RANK: Record<SemverLevel, number> = { patch: 0, minor: 1, major: 2 };

/**
 * Execute the CLI with the given argv (excluding node + script path).
 * Returns the process exit code instead of calling process.exit, so it is
 * testable in-process.
 */
export function run(argv: readonly string[], io: RunIO): number {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      io.stderr(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  if (args.help) {
    io.stdout(HELP_TEXT);
    return 0;
  }
  if (args.version) {
    io.stdout(`${io.version}\n`);
    return 0;
  }

  if (!args.beforeEntry || !args.afterEntry) {
    io.stderr("Expected two entry paths: <before-entry> <after-entry>\n\n");
    io.stderr(HELP_TEXT);
    return 2;
  }

  for (const entry of [args.beforeEntry, args.afterEntry]) {
    if (!fs.existsSync(entry)) {
      io.stderr(`Entry file not found: ${entry}\n`);
      return 2;
    }
  }

  const before = extractSurface({ entryPoint: args.beforeEntry });
  const after = extractSurface({ entryPoint: args.afterEntry });
  const result = checkSurfaces(before, after);

  if (args.json) {
    io.stdout(JSON.stringify(toJson(result, args), null, 2) + "\n");
  } else {
    io.stdout(renderReport(result, { color: args.color }) + "\n");
  }

  if (args.expect) {
    if (LEVEL_RANK[result.level] > LEVEL_RANK[args.expect]) {
      if (!args.json) {
        io.stderr(
          `\nRequired bump is '${result.level}' but --expect was '${args.expect}'.\n`,
        );
      }
      return 1;
    }
  }

  return 0;
}

function toJson(result: CheckResult, args: ParsedArgs) {
  const withinExpected = args.expect
    ? LEVEL_RANK[result.level] <= LEVEL_RANK[args.expect]
    : undefined;
  return {
    level: result.level,
    expect: args.expect ?? null,
    withinExpected: withinExpected ?? null,
    findingCount: result.findings.length,
    findings: result.findings,
  };
}
