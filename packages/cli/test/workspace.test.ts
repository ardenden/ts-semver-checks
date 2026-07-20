import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverWorkspacePackages, isWorkspaceRoot, WorkspaceError } from "../src/workspace.js";

const tmpDirs: string[] = [];

function makeTree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tssc-workspace-"));
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const pkg = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, version: "1.0.0", ...extra });

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("discoverWorkspacePackages", () => {
  it("reads pnpm-workspace.yaml globs", () => {
    const dir = makeTree({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/a/package.json": pkg("pkg-a"),
      "packages/b/package.json": pkg("pkg-b"),
    });
    expect(discoverWorkspacePackages(dir).map((p) => p.name)).toEqual(["pkg-a", "pkg-b"]);
  });

  it("ignores other top-level keys in pnpm-workspace.yaml", () => {
    // Mirrors this repo's own file, which has an allowBuilds block after packages.
    const dir = makeTree({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\nallowBuilds:\n  esbuild: true\n',
      "packages/a/package.json": pkg("pkg-a"),
    });
    expect(discoverWorkspacePackages(dir).map((p) => p.name)).toEqual(["pkg-a"]);
  });

  it("reads the npm/yarn workspaces array", () => {
    const dir = makeTree({
      "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
      "packages/a/package.json": pkg("pkg-a"),
    });
    expect(discoverWorkspacePackages(dir).map((p) => p.name)).toEqual(["pkg-a"]);
  });

  it("reads the workspaces.packages object form", () => {
    const dir = makeTree({
      "package.json": JSON.stringify({ name: "root", workspaces: { packages: ["libs/*"] } }),
      "libs/x/package.json": pkg("lib-x"),
    });
    expect(discoverWorkspacePackages(dir).map((p) => p.name)).toEqual(["lib-x"]);
  });

  it("flags private packages instead of dropping them", () => {
    const dir = makeTree({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/pub/package.json": pkg("pub"),
      "packages/secret/package.json": pkg("secret", { private: true }),
    });
    const found = discoverWorkspacePackages(dir);
    expect(found.find((p) => p.name === "secret")!.private).toBe(true);
    expect(found.find((p) => p.name === "pub")!.private).toBe(false);
  });

  it("never descends into node_modules", () => {
    const dir = makeTree({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/a/package.json": pkg("pkg-a"),
      "packages/node_modules/evil/package.json": pkg("evil"),
    });
    expect(discoverWorkspacePackages(dir).map((p) => p.name)).toEqual(["pkg-a"]);
  });

  it("supports ** for nested packages", () => {
    const dir = makeTree({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/**"\n',
      "packages/group/nested/package.json": pkg("nested-pkg"),
    });
    expect(discoverWorkspacePackages(dir).map((p) => p.name)).toContain("nested-pkg");
  });

  it("skips directories without a package.json", () => {
    const dir = makeTree({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/a/package.json": pkg("pkg-a"),
      "packages/not-a-package/readme.md": "hi",
    });
    expect(discoverWorkspacePackages(dir).map((p) => p.name)).toEqual(["pkg-a"]);
  });

  it("throws when the directory is not a workspace", () => {
    const dir = makeTree({ "package.json": pkg("solo") });
    expect(() => discoverWorkspacePackages(dir)).toThrow(WorkspaceError);
  });
});

describe("isWorkspaceRoot", () => {
  it("is true for a pnpm workspace and false for a plain package", () => {
    const ws = makeTree({
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/a/package.json": pkg("pkg-a"),
    });
    const solo = makeTree({ "package.json": pkg("solo") });
    expect(isWorkspaceRoot(ws)).toBe(true);
    expect(isWorkspaceRoot(solo)).toBe(false);
  });
});
