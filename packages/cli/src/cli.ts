#!/usr/bin/env node
import { createRequire } from "node:module";
import { run } from "./run.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const code = run(process.argv.slice(2), {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  version: pkg.version,
});

process.exitCode = code;
