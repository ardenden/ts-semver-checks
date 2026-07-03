import { describe, expect, it } from "vitest";
import { loadFixtures, runFixture } from "./harness.js";

const fixtures = loadFixtures();

describe("fixture corpus", () => {
  it("discovers fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} → ${fixture.expected.level}`, () => {
      const result = runFixture(fixture);
      const emittedCodes = result.findings.map((f) => f.code);

      // The overall classification must match exactly.
      expect(result.level, `codes emitted: ${emittedCodes.join(", ") || "(none)"}`).toBe(
        fixture.expected.level,
      );

      // Every required code must be present (subset match).
      for (const code of fixture.expected.codes ?? []) {
        expect(emittedCodes, `expected finding code '${code}'`).toContain(code);
      }
    });
  }
});
