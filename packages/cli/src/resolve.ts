import * as fs from "node:fs";
import * as path from "node:path";

export interface ResolvedPackage {
  /** Package name from package.json. */
  name: string;
  /** Package version from package.json (may be undefined for private/local). */
  version: string | undefined;
  /** Absolute path to the package directory. */
  dir: string;
  /** Absolute path to the resolved type entry (`.d.ts` or `.ts`). */
  typesEntry: string;
}

export interface ResolvedPackageEntries {
  /** Package name from package.json. */
  name: string;
  /** Package version from package.json (may be undefined for private/local). */
  version: string | undefined;
  /** Absolute path to the package directory. */
  dir: string;
  /** Exports subpath (`.`, `./utils`, ...) -> absolute path to its type entry. */
  entries: Map<string, string>;
}

interface PackageJson {
  name?: string;
  version?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
}

export class ResolveError extends Error {}

/**
 * Resolve a package's name and type entry point from its package.json.
 *
 * Entry resolution order:
 *   1. `exports["."]` (or bare `exports`) → nearest `types` condition
 *   2. top-level `types` / `typings`
 *   3. `index.d.ts` next to package.json
 * An explicit `entryOverride` short-circuits all of the above.
 */
export function resolvePackage(dir: string, entryOverride?: string): ResolvedPackage {
  const packageDir = path.resolve(dir);
  const pkg = readPackageJson(packageDir);

  if (!pkg.name) {
    throw new ResolveError(`package.json in ${packageDir} has no "name" field.`);
  }

  const typesEntry = entryOverride
    ? path.resolve(entryOverride)
    : resolveTypesEntry(packageDir, pkg);

  if (!typesEntry) {
    throw new ResolveError(
      `Could not find a type entry point for '${pkg.name}' in ${packageDir}. ` +
        `Add a "types" field to package.json, or pass --local-entry <path>.`,
    );
  }
  if (!fs.existsSync(typesEntry)) {
    throw new ResolveError(
      `Type entry point does not exist: ${typesEntry}. ` +
        `If this is your local package, build it first (its .d.ts must exist).`,
    );
  }

  return { name: pkg.name, version: pkg.version, dir: packageDir, typesEntry };
}

function resolveTypesEntry(dir: string, pkg: PackageJson): string | undefined {
  const fromExports = findTypesInExport(extractDotExport(pkg.exports));
  const candidate = fromExports ?? pkg.types ?? pkg.typings;
  if (candidate) return path.resolve(dir, candidate);

  const fallback = path.join(dir, "index.d.ts");
  return fs.existsSync(fallback) ? fallback : undefined;
}

/**
 * Every typed entry point a package exposes, keyed by its `exports` subpath
 * (`.`, `./utils`, ...). A package's public surface is the union of all of
 * them, so checking only the root would silently miss breaking changes in the
 * rest.
 *
 * Subpaths that resolve to no type declarations are skipped rather than
 * reported — `"./package.json": "./package.json"` is a common, untyped export.
 * Wildcard patterns (`./*`) can't be enumerated statically and are skipped too.
 * Falls back to a single `.` entry for packages with no `exports` map.
 */
export function resolvePackageEntries(dir: string): ResolvedPackageEntries {
  const packageDir = path.resolve(dir);
  const pkg = readPackageJson(packageDir);

  if (!pkg.name) {
    throw new ResolveError(`package.json in ${packageDir} has no "name" field.`);
  }

  const entries = new Map<string, string>();
  const exportsMap = pkg.exports;

  if (exportsMap && typeof exportsMap === "object") {
    const record = exportsMap as Record<string, unknown>;
    const subpathKeys = Object.keys(record).filter((k) => k.startsWith("."));

    for (const key of subpathKeys) {
      if (key.includes("*")) continue; // unenumerable pattern
      const rel = findTypesInExport(record[key]);
      if (!rel) continue; // untyped export (e.g. "./package.json")
      const abs = path.resolve(packageDir, rel);
      if (fs.existsSync(abs)) entries.set(key, abs);
    }
  }

  // No exports map (or none of its subpaths were typed): fall back to the
  // single root entry, matching resolvePackage's behavior.
  if (entries.size === 0) {
    const rootEntry = resolveTypesEntry(packageDir, pkg);
    if (rootEntry && fs.existsSync(rootEntry)) entries.set(".", rootEntry);
  }

  if (entries.size === 0) {
    throw new ResolveError(
      `Could not find any type entry point for '${pkg.name}' in ${packageDir}. ` +
        `Add a "types" field to package.json, or pass --local-entry <path>. ` +
        `If this is your local package, build it first (its .d.ts must exist).`,
    );
  }

  return { name: pkg.name, version: pkg.version, dir: packageDir, entries };
}

function readPackageJson(packageDir: string): PackageJson {
  const pkgPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new ResolveError(`No package.json found in ${packageDir}`);
  }
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;
  } catch (err) {
    throw new ResolveError(`Could not parse ${pkgPath}: ${(err as Error).message}`);
  }
}

/** Pull the "." subpath out of an exports map (or return the value if it's already a leaf). */
function extractDotExport(exports: unknown): unknown {
  if (exports === null || exports === undefined) return undefined;
  if (typeof exports === "string") return exports;
  if (typeof exports === "object") {
    const record = exports as Record<string, unknown>;
    // A subpath map has keys starting with ".". If "." is present, use it;
    // otherwise the object is itself a set of conditions for the root.
    if ("." in record) return record["."];
    const hasSubpaths = Object.keys(record).some((k) => k.startsWith("."));
    return hasSubpaths ? undefined : record;
  }
  return undefined;
}

/** Depth-first search for a `types` condition (or a `.d.ts` leaf) within an exports node. */
function findTypesInExport(node: unknown): string | undefined {
  if (typeof node === "string") {
    return node.endsWith(".d.ts") ? node : undefined;
  }
  if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (typeof record["types"] === "string") return record["types"];
    for (const key of ["node", "import", "require", "default"]) {
      const found = findTypesInExport(record[key]);
      if (found) return found;
    }
  }
  return undefined;
}
