# ts-semver-checks

[![CI](https://github.com/ardenden/ts-semver-checks/actions/workflows/ci.yml/badge.svg)](https://github.com/ardenden/ts-semver-checks/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ts-semver-checks.svg)](https://www.npmjs.com/package/ts-semver-checks)
[![license](https://img.shields.io/npm/l/ts-semver-checks.svg)](LICENSE)

Diff the **exported type surface** of a TypeScript package between two versions and
classify the change as **major / minor / patch** — the TypeScript equivalent of Rust's
[`cargo-semver-checks`](https://github.com/obi1kenobi/cargo-semver-checks).

> Run it in CI and it fails the build when a PR is a breaking change but the version
> bump says otherwise.

## Install

Most people want **just the CLI** — it's the whole tool:

```bash
npm install --save-dev ts-semver-checks
# or run without installing:
npx ts-semver-checks --baseline --expect minor
```

You do **not** need to install anything else. The CLI depends on the
[`ts-semver-checks-core`](https://www.npmjs.com/package/ts-semver-checks-core) library and
pulls it in automatically. Only install `ts-semver-checks-core` directly if you're
building your own tooling on top of the analysis engine (see [Library usage](#library-usage)).

**Requires `typescript` `>=5.0.0 <7.0.0`.** This tool is built on the classic TypeScript
Compiler API (`ts.createProgram`, `ts.TypeChecker`, …); TypeScript 7's native/Go-based
compiler doesn't expose that API, so it's explicitly excluded as a peer dependency.

## Status

Early MVP. It proves the full pipeline end-to-end — extract → diff → classify — over a
growing fixture corpus that doubles as the spec.

## Packages

| Package | Install it? | What it is |
| --- | --- | --- |
| [`ts-semver-checks`](packages/cli) | **Yes — this is the tool** | CLI: arg parsing, report rendering, CI exit codes. |
| [`ts-semver-checks-core`](packages/core) | Only for programmatic use | Library: `extractSurface`, `diffSurfaces`, `classify`, `checkSurfaces`, `renderReport`. Installed automatically as a dependency of the CLI. |

## CLI usage

```
# Baseline mode — compare your local build against a published npm version.
ts-semver-checks --baseline [version] [--package-dir <dir>] [--local-entry <path>]

# Baseline mode — compare against a git tag, branch, or commit instead of npm.
ts-semver-checks --baseline git:<ref> [--package-dir <dir>] [--baseline-entry <path>]

# Workspace mode — check every publishable package in a monorepo.
ts-semver-checks --baseline --workspace

# Two-file mode — compare two entry files directly.
ts-semver-checks <before-entry> <after-entry>

  --expect <level>   Fail (exit 1) if the required bump exceeds this level.
  --json             Machine-readable output.
  --no-color         Disable ANSI colors (auto-off when not a TTY).
```

**Baseline mode** reads the package name and type entries from your `package.json` and
diffs them against your local build. This is the "did I break my public API?" workflow:

```bash
# vs the latest version published on npm:
ts-semver-checks --baseline --expect minor

# vs a specific published version:
ts-semver-checks --baseline 1.4.0 --expect minor

# vs a git tag/branch/commit — no npm publish required, useful for pre-release
# branches or packages you haven't published yet:
ts-semver-checks --baseline git:v1.4.0 --expect minor
ts-semver-checks --baseline git:main
```

The `git:` form checks out `<ref>` into a temporary worktree (requires running inside a
git repository) and resolves the package the same way as the local side. If that ref
predates your build step (no committed `.d.ts`), point `--baseline-entry` at the source
entry instead, e.g. `--baseline-entry src/index.ts`.

The `--expect` flag is the CI hook: pass your intended version bump, and the process
exits non-zero if the actual change demands more.

```bash
# Two-file mode:
ts-semver-checks ./baseline/index.d.ts ./dist/index.d.ts --expect minor
```

Exit codes: `0` OK / within `--expect`, `1` required bump exceeds `--expect`, `2` usage
error, `3` baseline fetch/resolution error.

### Multiple entry points

A package's public surface is the union of **every** subpath it exports, so baseline mode
checks all of them — not just the root. Given:

```jsonc
{
  "exports": {
    ".":            { "types": "./dist/index.d.ts" },
    "./utils":      { "types": "./dist/utils.d.ts" },
    "./package.json": "./package.json"
  }
}
```

both `.` and `./utils` are checked, and findings outside the root are attributed to their
subpath:

```
MAJOR  New required parameter 'mode: number' was added.
       param.addedRequired @ ./utils → helper.params[1]
```

Adding a subpath is **minor** (`entryPoint.added`); removing one is **major**
(`entryPoint.removed`). Untyped exports (like `./package.json`) and wildcard patterns
(`./*`, which can't be enumerated statically) are skipped. Passing `--local-entry` or
`--baseline-entry` targets a single file and opts out of this traversal.

### Monorepos

`--workspace` checks every publishable package in the workspace in one run, so a single
CI step covers the whole repo:

```bash
ts-semver-checks --baseline --workspace --expect minor
```

It discovers packages from `pnpm-workspace.yaml` or the `workspaces` field in
package.json (npm/yarn/bun), and findings are attributed to the package they came from:

```
MAJOR  New required parameter 'y: number' was added.
       param.addedRequired @ mono-alpha-pkg → a.params[1]
MINOR  New exported symbol 'bNew' was added.
       export.added @ mono-beta-pkg → bNew
```

The reported bump is the highest across all packages, which is what `--expect` gates on.
Some practical behavior:

- **Private packages are skipped** — `"private": true` means it's never published, so
  there's no semver contract to check.
- **Unpublished packages are skipped with a note**, not treated as an error. A new package
  in a monorepo has no baseline on npm yet, which is normal.
- With `--baseline git:<ref>`, the repo is checked out **once** and every package is read
  from that single worktree; an npm baseline is fetched per package.

## Use in CI (GitHub Actions)

Baseline mode diffs your **local build** against your **published** version, so build
first, then run the check. Set `--expect` to the bump you intend for this release; the
job fails if the change actually demands more.

```yaml
name: semver-check
on: pull_request

jobs:
  api-compat:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci
      - run: npm run build          # must emit your .d.ts files

      # Fail the PR if it breaks the public API but is only labelled a minor bump.
      - run: npx ts-semver-checks --baseline --expect minor
```

Tips:

- **Build first.** Baseline mode reads the type entry (`types` / `exports` → `types`)
  from your `package.json`, so those `.d.ts` files must exist locally.
- Change `--expect` per release (`patch` / `minor` / `major`) — or drive it from your
  release tooling — so the gate matches your intended version bump.
- Add `--json` if a later step needs to parse the findings.

## Library usage

For building tools on top of the analysis engine (not needed to use the CLI):

```bash
npm install ts-semver-checks-core
```

```ts
import { extractSurface, checkSurfaces } from "ts-semver-checks-core";

const before = extractSurface({ entryPoint: "baseline/index.d.ts" });
const after = extractSurface({ entryPoint: "src/index.ts" });
const { level, findings } = checkSurfaces(before, after);
// level: "major" | "minor" | "patch"
```

## Classification rules

Currently detected (see [`packages/core/src/diff.ts`](packages/core/src/diff.ts)):

- **major:** removed export, changed export kind, removed/added-required parameter,
  parameter type **narrowed**, return/readonly-property type **widened**, optional→required,
  removed/changed interface member, new required interface member/method, removed/changed
  enum member, generic-constraint **tightened**/added, type-parameter default removed/changed,
  required type parameter added, type parameter removed, class made abstract, removed
  constructor, removed `exports` entry point.
- **minor:** new export, new optional parameter/property, required→optional, parameter
  type **widened**, return/readonly-property type **narrowed**, generic-constraint
  **relaxed**/removed, type-parameter default added, type parameter added with a default,
  new class member, new enum member, added overload, new `exports` entry point.
- **patch:** no surface change (including type changes that are actually equivalent, e.g.
  `string[]` ↔ `Array<string>`, on parameters, returns, properties, type aliases, or
  generic constraints — and type-parameter renames, see below).

### Type-parameter renames

A type parameter's name is a local binding: callers instantiate it positionally
(`map<string, number>(...)`) and can't refer to it by name. Renaming `<T, U>` to
`<TIn, TOut>` is therefore invisible to consumers, and reports as **patch**.

Type parameters are alpha-normalized to positional placeholders before diffing, so a
rename compares equal while a change in *which position* a type is used at does not:

```ts
// patch — pure rename
function map<T, U>(items: T[], fn: (item: T) => U): U[];
function map<TIn, TOut>(items: TIn[], fn: (item: TIn) => TOut): TOut[];

// major — the arguments now use different type parameters
function g<T, U>(a: T, b: U): void;
function g<T, U>(a: U, b: T): void;
```

Messages still show the names you declared, not the internal placeholders.

### Assignability

When both entry points are available (baseline mode and two-file mode), type changes are
classified by the compiler's *assignability* relation rather than by string comparison, by
building a single program containing both the old and new entry points so one checker can
compare types across the two versions:

- **Function parameters** are contravariant — a **widened** parameter still accepts every
  previous input, so it's **minor**; a **narrowed** one is **major**.
- **Return types** are covariant — a **narrowed** return is a subtype of the old one, so
  it's **minor**; a **widened** one is **major**.
- **Readonly interface/class properties** are covariant too (consumers can only ever read
  them, same as a return type) — narrowing is **minor**, widening is **major**.
- **Mutable properties and type aliases** can be used by unknown consumers in both read
  and write positions, so a safe direction can't be assumed — only true **equivalence**
  (mutually assignable, e.g. `string[]` vs `Array<string>`) is reclassified, as a dropped
  false positive. Any other change stays **major**, since we can't prove it's safe.
- **Generic type-parameter constraints** are an upper bound on what callers may instantiate
  the parameter with. Relaxing or removing a constraint (the old bound is assignable to the
  new one) allows all previous type arguments plus more, so it's **minor**; tightening or
  adding one is **major**.
- Anything mutually assignable in the applicable cases above is treated as **equivalent**
  and produces no finding at all — a **patch**.

**Still conservative:** mutable properties and type aliases fall back to equivalence-only
refinement (see above), and the pure string path (`checkSurfaces` over serialized surfaces)
is always conservative since it has no live types to compare. Renaming a type parameter that
appears in signatures is currently reported as a type change rather than recognized as a
no-op rename.

## Development

```bash
pnpm install
pnpm -r run build      # topological: core, then cli
pnpm -r run typecheck
pnpm test              # vitest, runs the fixture corpus
```

### The fixture corpus is the spec

Each directory under [`packages/core/test/fixtures`](packages/core/test/fixtures) is a
`before.ts` + `after.ts` pair plus `expected.json` (`{ level, codes }`). Adding a rule
means adding a fixture. The harness discovers them automatically — currently 43 fixtures
covering exports, parameters, properties, enums, classes, generic constraints/defaults,
CommonJS `export =`, and assignability-based widening/narrowing/equivalence.

[CI](.github/workflows/ci.yml) runs the full build → typecheck → test pipeline on every
push and PR, on both Ubuntu and Windows.

## Roadmap

- ~~npm baseline fetch (`--baseline <version>`, default latest published)~~ ✅ done.
- ~~CommonJS `export =` extraction~~ ✅ done.
- ~~Assignability-based widening/narrowing detection (parameters + return types)~~ ✅ done.
- ~~git-ref baseline checkout (`--baseline git:<ref>`)~~ ✅ done.
- ~~Extend assignability to property types and type aliases~~ ✅ done (equivalence for
  mutable properties/aliases; covariant narrow/widen for readonly properties).
- ~~Extend assignability to generic/type-parameter constraints~~ ✅ done (relax/tighten,
  add/remove constraint, defaults, add/remove type parameter).
- ~~Multi-entry-point / `package.json` `exports` map traversal (multiple subpaths)~~ ✅ done.
- ~~Monorepo multi-package orchestration (`--workspace`)~~ ✅ done.
- ~~Recognize type-parameter renames as non-breaking (alpha-normalize signatures)~~ ✅ done.
