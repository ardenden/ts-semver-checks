import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchedBaseline } from "./baseline.js";

export class GitBaselineError extends Error {}

/**
 * Baseline values prefixed with `git:` name a git ref (tag, branch, or commit)
 * instead of an npm version/dist-tag, e.g. `--baseline git:v1.4.0`.
 */
export const GIT_REF_PREFIX = "git:";

export function isGitBaselineSpec(value: string): boolean {
  return value.startsWith(GIT_REF_PREFIX);
}

export function parseGitRef(value: string): string {
  return value.slice(GIT_REF_PREFIX.length);
}

/**
 * Check out `ref` from the git repository containing `packageDir` into a
 * throwaway worktree, and return the path to the same package subdirectory
 * within it. Args are passed to `git` as an array (no shell), so no ref/path
 * validation beyond what `git rev-parse` itself performs is needed.
 */
export function fetchGitBaseline(
  ref: string,
  packageDir: string,
  log: (msg: string) => void = () => {},
): FetchedBaseline {
  if (!ref) {
    throw new GitBaselineError("git-ref baseline requires a ref: --baseline git:<ref>");
  }

  const repoRoot = resolveGitRoot(packageDir);
  const sha = resolveCommit(repoRoot, ref);

  const relPackageDir = path.relative(repoRoot, path.resolve(packageDir));
  const tmp = path.join(os.tmpdir(), `tssc-git-baseline-${crypto.randomBytes(6).toString("hex")}`);

  const cleanup = () => {
    const result = spawnSync("git", ["worktree", "remove", "--force", tmp], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      // Worktree metadata may be gone already, or removal failed for another
      // reason; either way, best-effort delete whatever is left on disk.
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  log(`Checking out ${ref} (${sha.slice(0, 12)}) into a temp worktree…`);
  const add = spawnSync("git", ["worktree", "add", "--detach", tmp, sha], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (add.error) {
    throw new GitBaselineError(`Failed to run git (${add.error.message}). Is git on your PATH?`);
  }
  if (add.status !== 0) {
    throw new GitBaselineError(
      `git worktree add failed for ref '${ref}':\n${(add.stderr || add.stdout || "").trim()}`,
    );
  }

  const dir = relPackageDir ? path.join(tmp, relPackageDir) : tmp;
  if (!fs.existsSync(dir)) {
    cleanup();
    throw new GitBaselineError(
      `Package directory '${relPackageDir || "."}' does not exist at ref '${ref}'.`,
    );
  }

  return { dir, cleanup };
}

function resolveGitRoot(startDir: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: startDir,
    encoding: "utf8",
  });
  if (result.error) {
    throw new GitBaselineError(`Failed to run git (${result.error.message}). Is git on your PATH?`);
  }
  if (result.status !== 0) {
    throw new GitBaselineError(
      `'${startDir}' is not inside a git repository (required for a git-ref baseline).`,
    );
  }
  return result.stdout.trim();
}

function resolveCommit(repoRoot: string, ref: string): string {
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new GitBaselineError(`git ref not found: '${ref}'`);
  }
  return result.stdout.trim();
}
