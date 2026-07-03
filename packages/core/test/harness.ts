import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSurfaces, extractSurface, type SemverLevel } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, "fixtures");

export interface FixtureExpectation {
  /** Expected overall semver classification. */
  level: SemverLevel;
  /** Finding codes that MUST appear (order-independent, subset match). */
  codes?: string[];
  /** Optional human note about what the fixture demonstrates. */
  description?: string;
}

export interface Fixture {
  name: string;
  dir: string;
  beforeEntry: string;
  afterEntry: string;
  expected: FixtureExpectation;
}

/** Discover every fixture directory that has before/after entries + expected.json. */
export function loadFixtures(): Fixture[] {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  const fixtures: Fixture[] = [];

  for (const name of fs.readdirSync(FIXTURES_DIR).sort()) {
    const dir = path.join(FIXTURES_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;

    const beforeEntry = resolveEntry(dir, "before");
    const afterEntry = resolveEntry(dir, "after");
    const expectedPath = path.join(dir, "expected.json");
    if (!beforeEntry || !afterEntry || !fs.existsSync(expectedPath)) continue;

    const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as FixtureExpectation;
    fixtures.push({ name, dir, beforeEntry, afterEntry, expected });
  }

  return fixtures;
}

function resolveEntry(dir: string, base: string): string | undefined {
  for (const ext of [".ts", ".d.ts"]) {
    const candidate = path.join(dir, `${base}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Run a single fixture end-to-end: extract both surfaces and check them. */
export function runFixture(fixture: Fixture) {
  const before = extractSurface({ entryPoint: fixture.beforeEntry });
  const after = extractSurface({ entryPoint: fixture.afterEntry });
  return checkSurfaces(before, after);
}
