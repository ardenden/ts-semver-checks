import * as fs from "node:fs";
import * as path from "node:path";
import {
  checkEntries,
  checkEntryPoints,
  classify,
  renderReport,
  sortFindings,
  type CheckResult,
  type EntryPointPair,
  type Finding,
  type SemverLevel,
} from "ts-semver-checks-core";
import { ArgError, HELP_TEXT, parseArgs, type ParsedArgs } from "./args.js";
import { resolvePackage, resolvePackageEntries, ResolveError } from "./resolve.js";
import {
  discoverWorkspacePackages,
  WorkspaceError,
  type WorkspacePackage,
} from "./workspace.js";
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

  if (args.workspace) {
    if (args.baseline === undefined) {
      io.stderr("--workspace requires --baseline (there is nothing to compare against).\n");
      return 2;
    }
    return runWorkspace(args, io);
  }
  if (args.baseline !== undefined) {
    return runBaseline(args, io);
  }
  return runDirect(args, io);
}

// ---------------------------------------------------------------------------
// Workspace (monorepo) mode
// ---------------------------------------------------------------------------

function runWorkspace(args: ParsedArgs, io: RunIO): number {
  const spec = args.baseline ?? "latest";
  const rootDir = path.resolve(args.packageDir ?? process.cwd());
  const isGit = isGitBaselineSpec(spec);

  let members;
  try {
    members = discoverWorkspacePackages(rootDir);
  } catch (err) {
    if (err instanceof WorkspaceError) {
      io.stderr(`${err.message}\n`);
      return 3;
    }
    throw err;
  }

  // Private packages are never published, so they have no semver contract.
  const publishable = members.filter((m) => !m.private);
  const skippedPrivate = members.length - publishable.length;

  if (publishable.length === 0) {
    io.stderr(
      `No publishable packages found in the workspace at ${rootDir}` +
        (skippedPrivate > 0 ? ` (${skippedPrivate} private package(s) skipped).` : ".") +
        "\n",
    );
    return 3;
  }

  io.stderr(
    `Checking ${publishable.length} workspace package(s) against ${isGit ? spec : `npm ${spec}`}` +
      (skippedPrivate > 0 ? `, skipping ${skippedPrivate} private` : "") +
      "…\n",
  );

  // For a git baseline the whole repo is checked out once and every package is
  // read from that single worktree; an npm baseline is fetched per package.
  let sharedGitBaseline: FetchedBaseline | undefined;
  if (isGit) {
    try {
      sharedGitBaseline = fetchGitBaseline(parseGitRef(spec), rootDir, (m) => io.stderr(`${m}\n`));
    } catch (err) {
      if (err instanceof GitBaselineError) {
        io.stderr(`${err.message}\n`);
        return 3;
      }
      throw err;
    }
  }

  const all: Finding[] = [];
  let checked = 0;

  try {
    for (const member of publishable) {
      const outcome = checkWorkspaceMember(member, rootDir, spec, isGit, sharedGitBaseline, io);
      if (outcome === "skipped") continue;
      checked++;
      all.push(...outcome);
    }
  } finally {
    sharedGitBaseline?.cleanup();
  }

  if (checked === 0) {
    io.stderr("No workspace package could be compared against a baseline.\n");
    return 3;
  }

  const findings = sortFindings(all);
  return report({ level: classify(findings), findings }, args, io);
}

/**
 * Check a single workspace member, returning its findings tagged with the
 * package name, or "skipped" when it has no comparable baseline (e.g. a package
 * that isn't published yet, or doesn't exist at the baseline git ref).
 */
function checkWorkspaceMember(
  member: WorkspacePackage,
  rootDir: string,
  spec: string,
  isGit: boolean,
  sharedGitBaseline: FetchedBaseline | undefined,
  io: RunIO,
): Finding[] | "skipped" {
  let localEntries: Map<string, string>;
  try {
    localEntries = resolvePackageEntries(member.dir).entries;
  } catch (err) {
    if (err instanceof ResolveError) {
      io.stderr(`  ${member.name}: skipped — ${err.message}\n`);
      return "skipped";
    }
    throw err;
  }

  let baselineDir: string;
  let cleanup: (() => void) | undefined;

  if (isGit) {
    // Same relative location inside the single shared worktree.
    baselineDir = path.join(sharedGitBaseline!.dir, path.relative(rootDir, member.dir));
    if (!fs.existsSync(baselineDir)) {
      io.stderr(`  ${member.name}: skipped — did not exist at ${spec}.\n`);
      return "skipped";
    }
  } else {
    try {
      const fetched = fetchBaselinePackage(member.name, spec, () => {});
      baselineDir = fetched.dir;
      cleanup = fetched.cleanup;
    } catch (err) {
      if (err instanceof BaselineError) {
        // Most commonly: not published yet. That's expected in a monorepo.
        io.stderr(`  ${member.name}: skipped — no published ${spec} version found.\n`);
        return "skipped";
      }
      throw err;
    }
  }

  try {
    let baselineEntries: Map<string, string>;
    try {
      baselineEntries = resolvePackageEntries(baselineDir).entries;
    } catch (err) {
      if (err instanceof ResolveError) {
        io.stderr(`  ${member.name}: skipped — baseline has no type entry (${err.message}).\n`);
        return "skipped";
      }
      throw err;
    }

    const pairs = buildEntryPointPairs(baselineEntries, localEntries);
    const result = checkEntryPoints(pairs);
    return result.findings.map((f) => ({ ...f, packageName: member.name }));
  } finally {
    cleanup?.();
  }
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
