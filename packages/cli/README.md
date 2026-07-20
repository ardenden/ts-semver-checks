# ts-semver-checks

Fail your build when a PR breaks your TypeScript package's public API but the version
bump says otherwise — the TypeScript analog of Rust's `cargo-semver-checks`.

```bash
# Compare your local build against what's published on npm:
npx ts-semver-checks --baseline --expect minor
```

See the [monorepo README](https://github.com/ardenden/ts-semver-checks#readme) for full
usage, modes, and the rule set.

## Modes

```
ts-semver-checks --baseline [version]          # compare local build vs npm
ts-semver-checks --baseline git:<ref>          # compare local build vs a git tag/branch/commit
ts-semver-checks --baseline --workspace        # check every package in a monorepo
ts-semver-checks <before-entry> <after-entry>  # compare two entry files
```

Baseline mode checks **every typed subpath** in your `package.json` `exports` (`.`,
`./utils`, ...), not just the root, and attributes findings to the subpath they came from.

Key flags: `--expect <major|minor|patch>` (CI gate), `--json`, `--package-dir`,
`--local-entry`, `--baseline-entry`. Exit codes: `0` ok, `1` bump exceeds `--expect`,
`2` usage, `3` baseline fetch/resolution error.

MIT © ardenden
