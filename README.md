# ts-semver-checks

Diff the **exported type surface** of a TypeScript package between two versions and
classify the change as **major / minor / patch** — the TypeScript equivalent of Rust's
[`cargo-semver-checks`](https://github.com/obi1kenobi/cargo-semver-checks).

> Run it in CI and it fails the build when a PR is a breaking change but the version
> bump says otherwise.

## Status

Early MVP. It proves the full pipeline end-to-end — extract → diff → classify — over a
growing fixture corpus that doubles as the spec.

## Packages

| Package | What it is |
| --- | --- |
| [`@ts-semver-checks/core`](packages/core) | Pure library: `extractSurface`, `diffSurfaces`, `classify`, `checkSurfaces`, `renderReport`. |
| [`ts-semver-checks`](packages/cli) | Thin CLI wrapper: arg parsing, report rendering, CI exit codes. |

## CLI usage

```
ts-semver-checks <before-entry> <after-entry> [options]

  --expect <level>   Fail (exit 1) if the required bump exceeds this level.
  --json             Machine-readable output.
  --no-color         Disable ANSI colors (auto-off when not a TTY).
```

The `--expect` flag is the CI hook: pass your intended version bump, and the process
exits non-zero if the actual change demands more.

```bash
# In CI, after building your candidate:
ts-semver-checks ./baseline/index.d.ts ./dist/index.d.ts --expect minor
```

Exit codes: `0` OK / within `--expect`, `1` required bump exceeds `--expect`, `2` usage error.

## Library usage

```ts
import { extractSurface, checkSurfaces } from "@ts-semver-checks/core";

const before = extractSurface({ entryPoint: "baseline/index.d.ts" });
const after = extractSurface({ entryPoint: "src/index.ts" });
const { level, findings } = checkSurfaces(before, after);
// level: "major" | "minor" | "patch"
```

## Classification rules

Currently detected (see [`packages/core/src/diff.ts`](packages/core/src/diff.ts)):

- **major:** removed export, changed export kind, removed/added-required parameter,
  parameter type change, return type change, optional→required, removed/changed
  interface member, new required interface member/method, removed/changed enum member,
  type-alias/generic-constraint change, class made abstract, removed constructor.
- **minor:** new export, new optional parameter/property, required→optional, new class
  member, new enum member, added overload, type parameter added with a default.
- **patch:** no surface change.

### Known limitation: assignability

Types are compared as **normalized strings**, not via the compiler's assignability
relation. Across two independent builds we can't always tell a *widening* (minor) from a
*narrowing* (major), so any ambiguous type change is classified **major** — a CI gate
should err toward safety. Structurally provable cases (adding an optional param,
relaxing `required`→`optional`) are classified precisely. Assignability-aware comparison
(building a combined program from both `.d.ts` snapshots) is the planned next step.

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

- npm baseline fetch (`--baseline <version>`, default latest published) and git-ref checkout.
- Assignability-based widening/narrowing detection.
- Multi-entry-point / `package.json` `exports` map traversal.
- Monorepo multi-package orchestration.
