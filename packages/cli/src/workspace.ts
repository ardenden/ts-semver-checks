import * as fs from "node:fs";
import * as path from "node:path";

export interface WorkspacePackage {
  /** Package name from its package.json. */
  name: string;
  /** Absolute path to the package directory. */
  dir: string;
  /** `private: true` packages are never published, so they have no semver contract. */
  private: boolean;
}

export class WorkspaceError extends Error {}

/**
 * Discover the packages of a monorepo workspace.
 *
 * Supports pnpm (`pnpm-workspace.yaml`) and npm/yarn/bun (`workspaces` in
 * package.json). Returns packages in stable name order. Private packages are
 * included but flagged, so callers can skip them — they are never published and
 * therefore have no published baseline to compare against.
 */
export function discoverWorkspacePackages(rootDir: string): WorkspacePackage[] {
  const root = path.resolve(rootDir);
  const patterns = readWorkspacePatterns(root);
  if (!patterns) {
    throw new WorkspaceError(
      `No workspace found in ${root}. Expected a "packages" list in pnpm-workspace.yaml ` +
        `or a "workspaces" field in package.json.`,
    );
  }

  const seen = new Set<string>();
  const packages: WorkspacePackage[] = [];

  for (const pattern of patterns) {
    for (const dir of expandPattern(root, pattern)) {
      if (seen.has(dir)) continue;
      seen.add(dir);

      const pkgPath = path.join(dir, "package.json");
      if (!fs.existsSync(pkgPath)) continue;

      let pkg: { name?: string; private?: boolean };
      try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as typeof pkg;
      } catch {
        continue; // unparseable package.json -> not a usable workspace member
      }
      if (!pkg.name) continue;

      packages.push({ name: pkg.name, dir, private: pkg.private === true });
    }
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

/** True when `dir` looks like the root of a supported workspace. */
export function isWorkspaceRoot(dir: string): boolean {
  return readWorkspacePatterns(path.resolve(dir)) !== undefined;
}

function readWorkspacePatterns(root: string): string[] | undefined {
  const pnpmFile = path.join(root, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmFile)) {
    const patterns = parsePnpmWorkspacePackages(fs.readFileSync(pnpmFile, "utf8"));
    if (patterns.length > 0) return patterns;
  }

  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const ws = pkg.workspaces;
      if (Array.isArray(ws)) {
        if (ws.length > 0) return ws;
      } else if (ws && typeof ws === "object") {
        if (Array.isArray(ws.packages) && ws.packages.length > 0) return ws.packages;
      }
    } catch {
      /* fall through */
    }
  }

  return undefined;
}

/**
 * Extract the `packages:` list from pnpm-workspace.yaml without a YAML
 * dependency. The file may hold other top-level keys (e.g. `allowBuilds`), so
 * only the indented `- item` lines directly under `packages:` are taken.
 */
function parsePnpmWorkspacePackages(source: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, ""); // strip comments
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;

    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (item) {
      patterns.push(stripQuotes(item[1]!));
      continue;
    }
    // A non-indented, non-empty line ends the packages block.
    if (line.trim() !== "" && !/^\s/.test(line)) inPackages = false;
  }

  return patterns;
}

function stripQuotes(value: string): string {
  const m = /^(['"])(.*)\1$/.exec(value);
  return m ? m[2]! : value;
}

/**
 * Expand a workspace glob into concrete directories. Supports the patterns
 * workspaces actually use: literal paths, `*` (one path segment) and `**` (any
 * depth). Negation (`!pattern`) is ignored rather than mis-handled.
 */
function expandPattern(root: string, pattern: string): string[] {
  if (pattern.startsWith("!")) return [];

  const segments = pattern.split("/").filter((s) => s !== "" && s !== ".");
  let current = [root];

  for (const segment of segments) {
    const next: string[] = [];

    for (const dir of current) {
      if (segment === "**") {
        next.push(...walkDirectories(dir));
      } else if (segment.includes("*")) {
        const re = segmentToRegExp(segment);
        for (const child of readDirectories(dir)) {
          if (re.test(path.basename(child))) next.push(child);
        }
      } else {
        const child = path.join(dir, segment);
        if (isDirectory(child)) next.push(child);
      }
    }

    current = next;
    if (current.length === 0) break;
  }

  return current;
}

function segmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function readDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** All directories at or below `dir`, excluding node_modules and dotfiles. */
function walkDirectories(dir: string): string[] {
  const out: string[] = [dir];
  for (const child of readDirectories(dir)) {
    out.push(...walkDirectories(child));
  }
  return out;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
