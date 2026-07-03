import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface FetchedBaseline {
  /** Absolute path to the installed package directory (temp/node_modules/<name>). */
  dir: string;
  /** Remove the temp install directory. */
  cleanup: () => void;
}

export class BaselineError extends Error {}

// npm package name: optional @scope/, then name characters.
const NAME_RE = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
// Conservative version/dist-tag spec: digits, letters, dots, dashes (e.g. 1.2.3, latest, next).
const VERSION_RE = /^[\w.-]+$/;

/**
 * Download a published package version from npm into a throwaway directory using
 * `npm install`. Installing (rather than just `npm pack` + untar) also pulls the
 * package's own dependencies, so its `.d.ts` files' type references resolve.
 */
export function fetchBaselinePackage(
  name: string,
  version: string,
  log: (msg: string) => void = () => {},
): FetchedBaseline {
  if (!NAME_RE.test(name)) {
    throw new BaselineError(`Refusing to fetch: '${name}' is not a valid npm package name.`);
  }
  if (!VERSION_RE.test(version)) {
    throw new BaselineError(
      `Refusing to fetch: '${version}' is not a valid version or dist-tag (letters, digits, '.', '-').`,
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tssc-baseline-"));
  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  };

  try {
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "tssc-baseline-temp", version: "0.0.0", private: true }),
    );

    const spec = `${name}@${version}`;
    log(`Fetching ${spec} from npm…`);

    // Run through a shell so the platform's `npm` shim resolves (npm.cmd on
    // Windows). `name` and `version` are validated above and `tmp` is quoted, so
    // the concatenated command line carries no untrusted shell metacharacters.
    // Passing a single command string (not an args array) avoids Node's DEP0190.
    const command =
      `npm install ${spec} --prefix "${tmp}" ` +
      `--no-save --ignore-scripts --no-audit --no-fund --loglevel=error`;
    const result = spawnSync(command, {
      shell: true,
      encoding: "utf8",
      cwd: tmp,
    });

    if (result.error) {
      throw new BaselineError(
        `Failed to run npm (${result.error.message}). Is npm on your PATH?`,
      );
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      throw new BaselineError(`npm install ${spec} failed:\n${detail}`);
    }

    const installedDir = path.join(tmp, "node_modules", ...name.split("/"));
    if (!fs.existsSync(path.join(installedDir, "package.json"))) {
      throw new BaselineError(
        `npm reported success but ${name} was not found in the install directory.`,
      );
    }

    return { dir: installedDir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
