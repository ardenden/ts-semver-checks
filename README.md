# ts-semver-checks

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

## Status

Early MVP. It proves the full pipeline end-to-end — extract → diff → classify — over a
growing fixture corpus that doubles as the spec.

## Packages

| Package | Install it? | What it is |
| --- | --- | --- |
| [`ts-semver-checks`](packages/cli) | **Yes — this is the tool** | CLI: arg parsing, report rendering, CI exit codes. |
| [`ts-semver-checks-core`](packages/core) | Only for programmatic use | Library: `extractSurface`, `diffSurfaces`, `classify`, `checkSurfaces`, `renderReport`. Installed automatically as a dependency of the CLI. |

## CLI usage

Two modes:

```
# Baseline mode — compare your local build against a published npm version.
ts-semver-checks --baseline [version] [--package-dir <dir>] [--local-entry <path>]

# Two-file mode — compare two entry files directly.
ts-semver-checks <before-entry> <after-entry>

  --expect <level>   Fail (exit 1) if the required bump exceeds this level.
  --json             Machine-readable output.
  --no-color         Disable ANSI colors (auto-off when not a TTY).
```

**Baseline mode** reads the package name and type entry from your `package.json`,
downloads the published version from npm (default: `latest`) into a temp dir, and diffs
it against your local build. This is the "did I break my published API?" workflow:

```bash
# In CI, after building, compare HEAD against what's on npm:
ts-semver-checks --baseline --expect minor
```

The `--expect` flag is the CI hook: pass your intended version bump, and the process
exits non-zero if the actual change demands more.

```bash
# Two-file mode:
ts-semver-checks ./baseline/index.d.ts ./dist/index.d.ts --expect minor
```

Exit codes: `0` OK / within `--expect`, `1` required bump exceeds `--expect`, `2` usage
error, `3` baseline fetch/resolution error.

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
  parameter type **narrowed**, return type **widened**, optional→required, removed/changed
  interface member, new required interface member/method, removed/changed enum member,
  type-alias/generic-constraint change, class made abstract, removed constructor.
- **minor:** new export, new optional parameter/property, required→optional, parameter
  type **widened**, return type **narrowed**, new class member, new enum member, added
  overload, type parameter added with a default.
- **patch:** no surface change (including type changes that are actually equivalent, e.g.
  `string[]` ↔ `Array<string>`).

### Assignability

When both entry points are available (baseline mode and two-file mode), type changes on
**function parameters and return types** are classified by the compiler's *assignability*
relation rather than by string comparison:

- Parameters are contravariant — a **widened** parameter still accepts every previous
  input, so it's **minor**; a **narrowed** one is **major**.
- Return types are covariant — a **narrowed** return is a subtype of the old one, so it's
  **minor**; a **widened** one is **major**.
- Types that are mutually assignable are treated as **equivalent** and produce no finding.

This is done by building a single program containing both the old and new entry points,
so one checker can compare types across the two versions.

**Still conservative:** interface/class property types, type aliases, and generic
constraints are compared structurally (as strings) and, when a direction can't be proven,
classified **major** — a CI gate should err toward safety. Extending assignability to
those is future work. The pure string path (`checkSurfaces` over serialized surfaces) is
also always conservative, since it has no live types to compare.

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
means adding a fixture. The harness discovers them automatically.

## Roadmap

- ~~npm baseline fetch (`--baseline <version>`, default latest published)~~ ✅ done.
- ~~CommonJS `export =` extraction~~ ✅ done.
- ~~Assignability-based widening/narrowing detection (parameters + return types)~~ ✅ done.
- Extend assignability to property types, type aliases, and generic constraints.
- git-ref baseline checkout (`--baseline <git-ref>`).
- Multi-entry-point / `package.json` `exports` map traversal (multiple subpaths).
- Monorepo multi-package orchestration.
