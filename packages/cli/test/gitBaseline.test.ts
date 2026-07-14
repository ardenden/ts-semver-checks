import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fetchGitBaseline,
  GitBaselineError,
  isGitBaselineSpec,
  parseGitRef,
} from "../src/gitBaseline.js";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

/** Build a throwaway git repo with two commits, tagging the first as "v1". */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tssc-gittest-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");

  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "sample", version: "1.0.0", types: "index.d.ts" }),
  );
  fs.writeFileSync(path.join(dir, "index.d.ts"), "export declare function f(a: string): void;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "v1");
  git(dir, "tag", "v1");

  fs.writeFileSync(
    path.join(dir, "index.d.ts"),
    "export declare function f(a: string, b: number): void;\n",
  );
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "v2");

  return dir;
}

const cleanups: Array<() => void> = [];
let repo: string;

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe("isGitBaselineSpec / parseGitRef", () => {
  it("recognizes the git: prefix", () => {
    expect(isGitBaselineSpec("git:v1.2.0")).toBe(true);
    expect(isGitBaselineSpec("1.2.0")).toBe(false);
    expect(isGitBaselineSpec("latest")).toBe(false);
  });

  it("strips the prefix", () => {
    expect(parseGitRef("git:v1.2.0")).toBe("v1.2.0");
    expect(parseGitRef("git:main")).toBe("main");
  });
});

describe("fetchGitBaseline", () => {
  it("checks out a tag and exposes the package at that ref", () => {
    const fetched = fetchGitBaseline("v1", repo);
    cleanups.push(fetched.cleanup);

    const pkg = JSON.parse(fs.readFileSync(path.join(fetched.dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("sample");
    const dts = fs.readFileSync(path.join(fetched.dir, "index.d.ts"), "utf8");
    expect(dts).toContain("f(a: string): void");
    expect(dts).not.toContain("b: number");
  });

  it("checks out a branch (HEAD, the second commit)", () => {
    const fetched = fetchGitBaseline("main", repo);
    cleanups.push(fetched.cleanup);

    const dts = fs.readFileSync(path.join(fetched.dir, "index.d.ts"), "utf8");
    expect(dts).toContain("b: number");
  });

  it("cleanup removes the worktree", () => {
    const fetched = fetchGitBaseline("v1", repo);
    expect(fs.existsSync(fetched.dir)).toBe(true);
    fetched.cleanup();
    expect(fs.existsSync(fetched.dir)).toBe(false);
  });

  it("throws GitBaselineError for a nonexistent ref", () => {
    expect(() => fetchGitBaseline("does-not-exist", repo)).toThrow(GitBaselineError);
  });

  it("throws GitBaselineError when packageDir is not inside a git repo", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tssc-notgit-"));
    try {
      expect(() => fetchGitBaseline("v1", outside)).toThrow(GitBaselineError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("resolves a package nested in a subdirectory (monorepo-style)", () => {
    const sub = path.join(repo, "packages", "pkg-a");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, "package.json"),
      JSON.stringify({ name: "pkg-a", version: "1.0.0", types: "index.d.ts" }),
    );
    fs.writeFileSync(path.join(sub, "index.d.ts"), "export declare const x: number;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "add nested package");

    const fetched = fetchGitBaseline("HEAD", sub);
    cleanups.push(fetched.cleanup);

    const pkg = JSON.parse(fs.readFileSync(path.join(fetched.dir, "package.json"), "utf8"));
    expect(pkg.name).toBe("pkg-a");
  });
});
