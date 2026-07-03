# Project: TypeScript Semantic Semver Checker (working name: `ts-semver-checks`)

## What this is

An open-source CLI + CI tool that diffs the **exported type surface** of a TypeScript
package between two versions and classifies the change as **major / minor / patch**
per semver semantics — the TypeScript equivalent of Rust's `cargo-semver-checks`.

Core promise: "Run this in CI and it will fail the build if your PR is a breaking
change but the version bump says otherwise."

## Why it doesn't already exist (competitive landscape)

- `cargo-semver-checks` (Rust) — the proven analog; no good TS equivalent exists.
- `api-extractor` (Microsoft) — heavyweight, opinionated, focused on API reports and
  rollups, not semver classification. Poor DX for small libraries.
- `@arethetypeswrong/cli` (attw) — checks **packaging** correctness (ESM/CJS exports,
  types resolution), NOT API compatibility between versions. Complementary, not a rival.
- `ts-api-guardian` (Angular) — internal-ish, snapshot-based, not semver-aware.

Gap: nothing lightweight that answers "is v1.4.0 → this commit a breaking change?"

## MVP scope

1. Input: two package states — (a) published version pulled from npm, (b) local build.
2. Extract the public type surface of each using the TypeScript compiler API
   (start from the entry points in `package.json` `exports` / `types`).
3. Diff the surfaces and classify findings:
   - **Breaking (major):** removed export, narrowed parameter type, widened return
     type, added required param, removed union member consumers rely on, changed
     generic constraints, removed overload, interface property removed/made required.
   - **Additive (minor):** new export, new optional param/property, widened input types.
   - **Patch:** no surface change.
4. Output: human-readable report + `--json` + exit code for CI.
5. `--baseline <version|git-ref>` flag; default = latest published version on npm.

## Explicitly out of scope for MVP

- Runtime behavior changes (type-level only).
- JSDoc/`@deprecated` policy enforcement (later).
- Monorepo multi-package orchestration (later — but design the core as a library
  so a monorepo wrapper is easy).

## Architecture sketch

- `packages/core` — pure library: `extractSurface(entryPoint): ApiSurface`,
  `diffSurfaces(old, new): Finding[]`, `classify(findings): SemverLevel`.
- `packages/cli` — thin wrapper (arg parsing, npm tarball fetch, git-ref checkout
  into temp dir, report rendering).
- Surface representation: serializable JSON model of exported symbols (so baselines
  can be cached/committed, like a lockfile for your API).
- Key technical risk: type comparison. Don't reinvent assignability — use
  `checker.isTypeAssignableTo` style checks via the compiler API where possible;
  fall back to structural comparison of the serialized model for the rest.

## Tech decisions

- TypeScript, ESM-only, Node >= 20.
- TS compiler API directly (no api-extractor dependency).
- Vitest for tests; fixture-based testing: pairs of `before/` + `after/` mini-packages
  with expected classification — this fixture corpus IS the spec.
- pnpm workspace monorepo.

## Origin note

This started as an internal "cross-team breaking-change checker" concept for shared
API tooling; this OSS version is the generalization. Internal adoption = dogfooding.

## First tasks

1. Scaffold pnpm workspace with `core` and `cli` packages.
2. Implement `extractSurface` for a single entry point (exports, functions,
   interfaces, type aliases, classes, enums, consts).
3. Build the fixture test harness before writing the differ.
4. Implement removal-of-export detection end-to-end (simplest breaking change)
   to prove the pipeline, then expand the rule set.
