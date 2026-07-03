import { describe, expect, it } from "vitest";
import { extractSurface } from "ts-semver-checks-core";
import { fetchBaselinePackage } from "../src/baseline.js";
import { resolvePackage } from "../src/resolve.js";

// Network + npm required. Opt in with TSSC_E2E=1 (e.g. `TSSC_E2E=1 pnpm test`).
const runE2E = process.env.TSSC_E2E === "1";

describe.skipIf(!runE2E)("baseline fetch (e2e, network)", () => {
  it(
    "downloads a published package and extracts its surface",
    async () => {
      const fetched = fetchBaselinePackage("mri", "1.2.0");
      try {
        const pkg = resolvePackage(fetched.dir);
        expect(pkg.name).toBe("mri");
        const surface = extractSurface({ entryPoint: pkg.typesEntry });
        expect(Object.keys(surface.exports).length).toBeGreaterThan(0);
      } finally {
        fetched.cleanup();
      }
    },
    60_000,
  );

  it("rejects an invalid package name without touching the network", () => {
    expect(() => fetchBaselinePackage("../../etc/passwd", "1.0.0")).toThrow();
  });
});
