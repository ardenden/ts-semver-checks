import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePackage, ResolveError } from "../src/resolve.js";

const tmpDirs: string[] = [];

function makePackage(pkg: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tssc-resolve-"));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("resolvePackage", () => {
  it("resolves the top-level `types` field", () => {
    const dir = makePackage(
      { name: "pkg-a", version: "1.0.0", types: "index.d.ts" },
      { "index.d.ts": "export {};" },
    );
    const r = resolvePackage(dir);
    expect(r.name).toBe("pkg-a");
    expect(r.version).toBe("1.0.0");
    expect(path.basename(r.typesEntry)).toBe("index.d.ts");
  });

  it("resolves the legacy `typings` field", () => {
    const dir = makePackage(
      { name: "pkg-b", typings: "types/main.d.ts" },
      { "types/main.d.ts": "export {};" },
    );
    expect(path.basename(resolvePackage(dir).typesEntry)).toBe("main.d.ts");
  });

  it("resolves a `types` condition inside the exports map", () => {
    const dir = makePackage(
      {
        name: "pkg-c",
        exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
      },
      { "dist/index.d.ts": "export {};" },
    );
    expect(resolvePackage(dir).typesEntry.replace(/\\/g, "/")).toContain("dist/index.d.ts");
  });

  it("resolves a nested `types` under an import condition", () => {
    const dir = makePackage(
      {
        name: "pkg-d",
        exports: { ".": { import: { types: "./dist/index.d.ts", default: "./dist/index.js" } } },
      },
      { "dist/index.d.ts": "export {};" },
    );
    expect(resolvePackage(dir).typesEntry.replace(/\\/g, "/")).toContain("dist/index.d.ts");
  });

  it("falls back to index.d.ts when nothing is declared", () => {
    const dir = makePackage({ name: "pkg-e" }, { "index.d.ts": "export {};" });
    expect(path.basename(resolvePackage(dir).typesEntry)).toBe("index.d.ts");
  });

  it("honors an explicit entry override", () => {
    const dir = makePackage(
      { name: "pkg-f", types: "index.d.ts" },
      { "index.d.ts": "export {};", "other.d.ts": "export {};" },
    );
    const override = path.join(dir, "other.d.ts");
    expect(resolvePackage(dir, override).typesEntry).toBe(override);
  });

  it("throws when package.json is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tssc-empty-"));
    tmpDirs.push(dir);
    expect(() => resolvePackage(dir)).toThrow(ResolveError);
  });

  it("throws a helpful error when the declared entry does not exist", () => {
    const dir = makePackage({ name: "pkg-g", types: "dist/index.d.ts" });
    expect(() => resolvePackage(dir)).toThrow(/does not exist/);
  });

  it("throws when there is no name", () => {
    const dir = makePackage({ version: "1.0.0", types: "index.d.ts" }, { "index.d.ts": "" });
    expect(() => resolvePackage(dir)).toThrow(/no "name"/);
  });
});
