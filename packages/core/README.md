# @ts-semver-checks/core

The pure library behind [`ts-semver-checks`](https://www.npmjs.com/package/ts-semver-checks):
extract, diff, and classify the exported type surface of a TypeScript package.

```ts
import { extractSurface, checkSurfaces } from "@ts-semver-checks/core";

const before = extractSurface({ entryPoint: "baseline/index.d.ts" });
const after = extractSurface({ entryPoint: "src/index.ts" });
const { level, findings } = checkSurfaces(before, after);
// level: "major" | "minor" | "patch"
```

See the [monorepo README](https://github.com/ardenden/ts-semver-checks#readme) for the
surface model, rule set, and known limitations.

MIT © ardenden
