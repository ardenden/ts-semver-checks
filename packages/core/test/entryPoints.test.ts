import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkEntryPoints } from "../src/index.js";

const tmpDirs: string[] = [];

function makeFiles(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tssc-entrypoints-"));
  tmpDirs.push(dir);
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

describe("checkEntryPoints", () => {
  it("detects a breaking change in a non-root subpath", () => {
    const dir = makeFiles({
      "old/index.d.ts": "export declare function a(): void;",
      "new/index.d.ts": "export declare function a(): void;",
      "old/utils.d.ts": "export declare function helper(x: string): void;",
      "new/utils.d.ts": "export declare function helper(x: string, y: number): void;",
    });

    const result = checkEntryPoints([
      { subpath: ".", oldEntry: path.join(dir, "old/index.d.ts"), newEntry: path.join(dir, "new/index.d.ts") },
      { subpath: "./utils", oldEntry: path.join(dir, "old/utils.d.ts"), newEntry: path.join(dir, "new/utils.d.ts") },
    ]);

    expect(result.level).toBe("major");
    const finding = result.findings.find((f) => f.code === "param.addedRequired");
    expect(finding).toBeDefined();
    // Attributed to the subpath it came from, with the path left un-prefixed.
    expect(finding!.entryPoint).toBe("./utils");
    expect(finding!.path).toBe("helper.params[1]");
  });

  it("leaves root-entry findings untagged", () => {
    const dir = makeFiles({
      "old/index.d.ts": "export declare function a(x: string): void;",
      "new/index.d.ts": "export declare function a(x: string, y: number): void;",
    });

    const result = checkEntryPoints([
      { subpath: ".", oldEntry: path.join(dir, "old/index.d.ts"), newEntry: path.join(dir, "new/index.d.ts") },
    ]);

    expect(result.level).toBe("major");
    expect(result.findings[0]!.entryPoint).toBeUndefined();
  });

  it("treats a removed entry point as major", () => {
    const dir = makeFiles({ "old/utils.d.ts": "export declare const x: number;" });

    const result = checkEntryPoints([
      { subpath: "./utils", oldEntry: path.join(dir, "old/utils.d.ts") },
    ]);

    expect(result.level).toBe("major");
    expect(result.findings[0]!.code).toBe("entryPoint.removed");
  });

  it("treats an added entry point as minor", () => {
    const dir = makeFiles({ "new/utils.d.ts": "export declare const x: number;" });

    const result = checkEntryPoints([
      { subpath: "./utils", newEntry: path.join(dir, "new/utils.d.ts") },
    ]);

    expect(result.level).toBe("minor");
    expect(result.findings[0]!.code).toBe("entryPoint.added");
  });

  it("reports patch when no entry point changed", () => {
    const dir = makeFiles({
      "old/index.d.ts": "export declare const x: number;",
      "new/index.d.ts": "export declare const x: number;",
      "old/utils.d.ts": "export declare const y: string;",
      "new/utils.d.ts": "export declare const y: string;",
    });

    const result = checkEntryPoints([
      { subpath: ".", oldEntry: path.join(dir, "old/index.d.ts"), newEntry: path.join(dir, "new/index.d.ts") },
      { subpath: "./utils", oldEntry: path.join(dir, "old/utils.d.ts"), newEntry: path.join(dir, "new/utils.d.ts") },
    ]);

    expect(result.level).toBe("patch");
    expect(result.findings).toHaveLength(0);
  });
});
