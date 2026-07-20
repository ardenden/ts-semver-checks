import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkEntries,
  checkEntryPoints,
  renderReport,
  type CheckResult,
  type EntryPointPair,
  type SemverLevel,
} from "ts-semver-checks-core";
import { ArgError, HELP_TEXT, parseArgs, type ParsedArgs } from "./args.js";
import { resolvePackage, resolvePackageEntries, ResolveError } from "./resolve.js";
import { BaselineError, fetchBaselinePackage, type FetchedBaseline } from "./baseline.js";
import { GitBaselineError, fetchGitBaseline, isGitBaselineSpec, parseGitRef } from "./gitBaseline.js";

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

  if (args.baseline !== undefined) {
    return runBaseline(args, io);
  }
  return runDirect(args, io);
}

// ---------------------------------------------------------------------------
// Two-file mode
// ---------------------------------------------------------------------------

function runDirect(args: ParsedArgs, io: RunIO): number {
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

  return report(checkEntries(args.beforeEntry, args.afterEntry), args, io);
}

// ---------------------------------------------------------------------------
// Baseline (vs npm) mode
// ---------------------------------------------------------------------------

function runBaseline(args: ParsedArgs, io: RunIO): number {
  const spec = args.baseline ?? "latest";
  const packageDir = path.resolve(args.packageDir ?? process.cwd());
  const isGit = isGitBaselineSpec(spec);

  // An explicit entry override targets one specific file, so it opts out of
  // multi-subpath traversal; otherwise check every typed `exports` subpath.
  const multiEntry = !args.localEntry && !args.baselineEntry;

  let packageName: string;
  let localEntries: Map<string, string> | undefined;
  let local: ReturnType<typeof resolvePackage> | undefined;
  try {
    if (multiEntry) {
      const resolved = resolvePackageEntries(packageDir);
      packageName = resolved.name;
      localEntries = resolved.entries;
    } else {
      local = resolvePackage(packageDir, args.localEntry);
      packageName = local.name;
    }
  } catch (err) {
    if (err instanceof ResolveError) {
      io.stderr(`${err.message}\n`);
      return 3;
    }
    throw err;
  }

  const localLabel = localEntries
    ? describeEntries(localEntries)
    : path.relative(process.cwd(), local!.typesEntry) || local!.typesEntry;

  let fetched: FetchedBaseline;
  if (isGit) {
    const ref = parseGitRef(spec);
    io.stderr(`Comparing git:${ref}  →  local ${localLabel}\n`);
    try {
      fetched = fetchGitBaseline(ref, packageDir, (m) => io.stderr(`${m}\n`));
    } catch (err) {
      if (err instanceof GitBaselineError) {
        io.stderr(`${err.message}\n`);
        return 3;
      }
      throw err;
    }
  } else {
    io.stderr(`Comparing ${packageName}@${spec} (npm)  →  local ${localLabel}\n`);
    try {
      fetched = fetchBaselinePackage(packageName, spec, (m) => io.stderr(`${m}\n`));
    } catch (err) {
      if (err instanceof BaselineError) {
        io.stderr(`${err.message}\n`);
        return 3;
      }
      throw err;
    }
  }

  try {
    const source = isGit ? "git baseline" : "published baseline";

    if (localEntries) {
      let baselineEntries: Map<string, string>;
      try {
        baselineEntries = resolvePackageEntries(fetched.dir).entries;
      } catch (err) {
        if (err instanceof ResolveError) {
          io.stderr(`Could not read the ${source}: ${err.message}\n`);
          return 3;
        }
        throw err;
      }

      const pairs = buildEntryPointPairs(baselineEntries, localEntries);
      if (pairs.length > 1) {
        io.stderr(`Checking ${pairs.length} entry points…\n`);
      }
      return report(checkEntryPoints(pairs), args, io);
    }

    let baselineEntry: string;
    try {
      // args.baselineEntry is relative to the fetched/checked-out package dir
      // (a temp path the user can't know in advance), not to cwd.
      const override = args.baselineEntry
        ? path.join(fetched.dir, args.baselineEntry)
        : undefined;
      baselineEntry = resolvePackage(fetched.dir, override).typesEntry;
    } catch (err) {
      if (err instanceof ResolveError) {
        io.stderr(`Could not read the ${source}: ${err.message}\n`);
        return 3;
      }
      throw err;
    }

    return report(checkEntries(baselineEntry, local!.typesEntry), args, io);
  } finally {
    fetched.cleanup();
  }
}

/** Union of both versions' subpaths, root first then alphabetical. */
function buildEntryPointPairs(
  baseline: Map<string, string>,
  local: Map<string, string>,
): EntryPointPair[] {
  const subpaths = [...new Set([...baseline.keys(), ...local.keys()])].sort((a, b) => {
    if (a === ".") return -1;
    if (b === ".") return 1;
    return a.localeCompare(b);
  });

  return subpaths.map((subpath) => ({
    subpath,
    oldEntry: baseline.get(subpath),
    newEntry: local.get(subpath),
  }));
}

function describeEntries(entries: Map<string, string>): string {
  const root = entries.get(".");
  const label = root ? path.relative(process.cwd(), root) || root : `${entries.size} entry points`;
  return entries.size > 1 ? `${label} (+${entries.size - 1} more entry points)` : label;
}

// ---------------------------------------------------------------------------
// Shared output + exit gate
// ---------------------------------------------------------------------------

function report(result: CheckResult, args: ParsedArgs, io: RunIO): number {
  if (args.json) {
    io.stdout(JSON.stringify(toJson(result, args), null, 2) + "\n");
  } else {
    io.stdout(renderReport(result, { color: args.color }) + "\n");
  }

  if (args.expect && LEVEL_RANK[result.level] > LEVEL_RANK[args.expect]) {
    if (!args.json) {
      io.stderr(`\nRequired bump is '${result.level}' but --expect was '${args.expect}'.\n`);
    }
    return 1;
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
