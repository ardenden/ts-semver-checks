import type { SemverLevel } from "@ts-semver-checks/core";

export interface ParsedArgs {
  beforeEntry?: string;
  afterEntry?: string;
  /** Present => baseline mode: compare the local package against this published version. */
  baseline?: string;
  /** Local package directory to check (baseline mode). Defaults to cwd. */
  packageDir?: string;
  /** Override the resolved local type entry (baseline mode). */
  localEntry?: string;
  json: boolean;
  color: boolean;
  expect?: SemverLevel;
  help: boolean;
  version: boolean;
}

export class ArgError extends Error {}

const LEVELS: readonly SemverLevel[] = ["major", "minor", "patch"];

function isLevel(value: string): value is SemverLevel {
  return (LEVELS as readonly string[]).includes(value);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const result: ParsedArgs = {
    json: false,
    color: process.stdout.isTTY === true,
    help: false,
    version: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        result.help = true;
        break;
      case "--version":
      case "-v":
        result.version = true;
        break;
      case "--json":
        result.json = true;
        break;
      case "--color":
        result.color = true;
        break;
      case "--no-color":
        result.color = false;
        break;
      case "--expect": {
        const value = argv[++i];
        if (!value || !isLevel(value)) {
          throw new ArgError(`--expect requires one of: ${LEVELS.join(", ")}`);
        }
        result.expect = value;
        break;
      }
      case "--baseline": {
        // Optional value: `--baseline 1.2.0` or bare `--baseline` (=> latest).
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          result.baseline = next;
          i++;
        } else {
          result.baseline = "latest";
        }
        break;
      }
      case "--package-dir": {
        const value = argv[++i];
        if (!value) throw new ArgError("--package-dir requires a path.");
        result.packageDir = value;
        break;
      }
      case "--local-entry": {
        const value = argv[++i];
        if (!value) throw new ArgError("--local-entry requires a path.");
        result.localEntry = value;
        break;
      }
      default:
        if (arg.startsWith("--expect=")) {
          const value = arg.slice("--expect=".length);
          if (!isLevel(value)) {
            throw new ArgError(`--expect requires one of: ${LEVELS.join(", ")}`);
          }
          result.expect = value;
        } else if (arg.startsWith("--baseline=")) {
          result.baseline = arg.slice("--baseline=".length) || "latest";
        } else if (arg.startsWith("--package-dir=")) {
          result.packageDir = arg.slice("--package-dir=".length);
        } else if (arg.startsWith("--local-entry=")) {
          result.localEntry = arg.slice("--local-entry=".length);
        } else if (arg.startsWith("-")) {
          throw new ArgError(`Unknown option: ${arg}`);
        } else {
          positionals.push(arg);
        }
    }
  }

  result.beforeEntry = positionals[0];
  result.afterEntry = positionals[1];
  return result;
}

export const HELP_TEXT = `ts-semver-checks — classify TypeScript API changes as major/minor/patch

USAGE
  ts-semver-checks <before-entry> <after-entry> [options]   (compare two files)
  ts-semver-checks --baseline [version] [options]           (compare vs npm)

BASELINE MODE
  Fetches your package's published version from npm and diffs it against your
  local build. The package name and type entry are read from package.json.

  --baseline [version]   Published version or dist-tag to compare against
                         (default: latest).
  --package-dir <dir>    Local package directory to check (default: cwd).
  --local-entry <path>   Override the resolved local type entry.

ARGUMENTS (two-file mode)
  before-entry   Path to the baseline entry file (.ts or .d.ts)
  after-entry    Path to the candidate entry file (.ts or .d.ts)

OPTIONS
  --expect <level>   Fail (exit 1) if the required bump exceeds this level
                     (major | minor | patch). Use in CI with your intended bump.
  --json             Emit machine-readable JSON instead of a text report.
  --no-color         Disable ANSI colors (auto-off when not a TTY).
  -h, --help         Show this help.
  -v, --version      Show version.

EXIT CODES
  0   OK (or required bump is within --expect)
  1   Required bump exceeds --expect
  2   Usage error
  3   Baseline fetch / resolution error

EXAMPLES
  ts-semver-checks ./baseline/index.d.ts ./src/index.ts --expect minor
  ts-semver-checks --baseline --expect minor        # vs latest published
  ts-semver-checks --baseline 1.4.0 --package-dir packages/core
`;
