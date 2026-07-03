import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run, type RunIO } from "../src/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(here, "fixtures", "base.ts");
const BREAKING = path.join(here, "fixtures", "breaking.ts");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io: RunIO = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    version: "test",
  };
  return { io, out, err, get stdout() { return out.join(""); }, get stderr() { return err.join(""); } };
}

describe("cli run()", () => {
  it("prints help and exits 0", () => {
    const cap = capture();
    const code = run(["--help"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout).toContain("USAGE");
  });

  it("errors (exit 2) when entries are missing", () => {
    const cap = capture();
    const code = run([], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr).toContain("Expected two entry paths");
  });

  it("errors (exit 2) on an unknown option", () => {
    const cap = capture();
    const code = run(["--bogus", BASE, BREAKING], cap.io);
    expect(code).toBe(2);
    expect(cap.stderr).toContain("Unknown option");
  });

  it("reports a major bump for an added required param", () => {
    const cap = capture();
    const code = run([BASE, BREAKING, "--no-color"], cap.io);
    expect(code).toBe(0);
    expect(cap.stdout).toContain("MAJOR");
  });

  it("exits 1 when required bump exceeds --expect", () => {
    const cap = capture();
    const code = run([BASE, BREAKING, "--expect", "minor", "--no-color"], cap.io);
    expect(code).toBe(1);
    expect(cap.stderr).toContain("Required bump is 'major'");
  });

  it("exits 0 when required bump is within --expect", () => {
    const cap = capture();
    const code = run([BASE, BREAKING, "--expect", "major", "--no-color"], cap.io);
    expect(code).toBe(0);
  });

  it("emits valid JSON with --json", () => {
    const cap = capture();
    const code = run([BASE, BREAKING, "--json"], cap.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout);
    expect(parsed.level).toBe("major");
    expect(parsed.findings.length).toBeGreaterThan(0);
  });
});
