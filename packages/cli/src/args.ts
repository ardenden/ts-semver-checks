import type { SemverLevel } from "@ts-semver-checks/core";

export interface ParsedArgs {
  beforeEntry?: string;
  afterEntry?: string;
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
      default:
        if (arg.startsWith("--expect=")) {
          const value = arg.slice("--expect=".length);
          if (!isLevel(value)) {
            throw new ArgError(`--expect requires one of: ${LEVELS.join(", ")}`);
          }
          result.expect = value;
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
  ts-semver-checks <before-entry> <after-entry> [options]

ARGUMENTS
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

EXAMPLE
  ts-semver-checks ./baseline/index.d.ts ./src/index.ts --expect minor
`;
