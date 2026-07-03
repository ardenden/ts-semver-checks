import * as path from "node:path";
import ts from "typescript";
import type { Finding } from "./findings.js";

/**
 * Assignability-based refinement of structural findings.
 *
 * The structural differ (diff.ts) compares types as strings and, when it can't
 * prove a direction, conservatively reports `major`. This module builds a single
 * program containing BOTH the old and new entry points — so one type checker can
 * compare types across the two versions — and uses the compiler's assignability
 * relation to reclassify the cases where variance is unambiguous:
 *
 *   - Parameters are contravariant: a widened parameter (new accepts everything
 *     old did) is non-breaking (minor); a narrowed one is breaking (major).
 *   - Return types are covariant: a narrowed return (new returns a subtype of
 *     old) is non-breaking (minor); a widened one is breaking (major).
 *   - When the two types are mutually assignable they are equivalent, and the
 *     structural finding was a false positive (e.g. `string[]` vs `Array<string>`);
 *     it is dropped.
 *
 * Anything it can't confidently reclassify is left exactly as the structural
 * differ reported it.
 */

interface FnSignature {
  params: ts.Type[];
  ret: ts.Type;
}

interface Comparison {
  checker: ts.TypeChecker;
  oldFns: Map<string, FnSignature>;
  newFns: Map<string, FnSignature>;
}

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
};

const PARAM_PATH = /^(.+)\.params\[(\d+)\]$/;
const RETURN_PATH = /^(.+)\.returnType$/;

/**
 * Refine structural findings using assignability. Returns a new list; findings
 * that turn out to be false positives are omitted. If the combined program can't
 * be built, the input findings are returned unchanged.
 */
export function refineFindings(
  findings: readonly Finding[],
  oldEntry: string,
  newEntry: string,
  compilerOptions?: ts.CompilerOptions,
): Finding[] {
  const cmp = buildComparison(oldEntry, newEntry, compilerOptions);
  if (!cmp) return [...findings];

  const out: Finding[] = [];
  for (const finding of findings) {
    const refined = refineOne(finding, cmp);
    if (refined) out.push(refined);
  }
  return out;
}

function buildComparison(
  oldEntry: string,
  newEntry: string,
  compilerOptions?: ts.CompilerOptions,
): Comparison | undefined {
  const oldPath = path.resolve(oldEntry);
  const newPath = path.resolve(newEntry);
  if (oldPath === newPath) return undefined;

  let program: ts.Program;
  try {
    program = ts.createProgram({
      rootNames: [oldPath, newPath],
      options: { ...DEFAULT_COMPILER_OPTIONS, ...compilerOptions },
    });
  } catch {
    return undefined;
  }

  const checker = program.getTypeChecker();
  const oldFns = collectFunctions(program, checker, oldPath);
  const newFns = collectFunctions(program, checker, newPath);
  if (!oldFns || !newFns) return undefined;

  return { checker, oldFns, newFns };
}

function collectFunctions(
  program: ts.Program,
  checker: ts.TypeChecker,
  entry: string,
): Map<string, FnSignature> | undefined {
  const sourceFile = program.getSourceFile(entry);
  if (!sourceFile) return undefined;
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return new Map();

  const result = new Map<string, FnSignature>();

  const add = (name: string, symbol: ts.Symbol) => {
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if ((resolved.getFlags() & ts.SymbolFlags.Function) === 0) return;
    const decl = resolved.getDeclarations()?.[0] ?? resolved.valueDeclaration;
    if (!decl) return;
    const type = checker.getTypeOfSymbolAtLocation(resolved, decl);
    const signatures = type.getCallSignatures();
    // Only single-signature functions are refined; overloads are left as-is.
    if (signatures.length !== 1) return;
    const sig = signatures[0]!;
    const params = sig.getParameters().map((p) => {
      const pd = p.valueDeclaration ?? p.declarations?.[0];
      return pd ? checker.getTypeOfSymbolAtLocation(p, pd) : checker.getTypeOfSymbol(p);
    });
    result.set(name, { params, ret: sig.getReturnType() });
  };

  for (const exp of checker.getExportsOfModule(moduleSymbol)) {
    add(exp_name(exp), exp);
  }
  const exportEquals = moduleSymbol.exports?.get("export=" as ts.__String);
  if (exportEquals) add("export=", exportEquals);

  return result;
}

function exp_name(symbol: ts.Symbol): string {
  return symbol.getName();
}

function refineOne(finding: Finding, cmp: Comparison): Finding | null {
  if (finding.code === "param.typeChanged") {
    const m = PARAM_PATH.exec(finding.path);
    if (!m) return finding;
    const fnName = m[1]!;
    const index = Number(m[2]);
    const oldT = cmp.oldFns.get(fnName)?.params[index];
    const newT = cmp.newFns.get(fnName)?.params[index];
    if (!oldT || !newT) return finding;

    const oldToNew = cmp.checker.isTypeAssignableTo(oldT, newT);
    const newToOld = cmp.checker.isTypeAssignableTo(newT, oldT);

    if (oldToNew && newToOld) return null; // equivalent types → false positive
    if (oldToNew) {
      // New parameter accepts everything the old one did → widening → safe.
      return {
        ...finding,
        level: "minor",
        code: "param.typeWidened",
        message: finding.message.replace("type changed", "type widened") +
          " (still accepts all previous inputs).",
      };
    }
    return finding; // narrowed or incompatible → stays major
  }

  if (finding.code === "returnType.changed") {
    const m = RETURN_PATH.exec(finding.path);
    if (!m) return finding;
    const fnName = m[1]!;
    const oldR = cmp.oldFns.get(fnName)?.ret;
    const newR = cmp.newFns.get(fnName)?.ret;
    if (!oldR || !newR) return finding;

    const newToOld = cmp.checker.isTypeAssignableTo(newR, oldR);
    const oldToNew = cmp.checker.isTypeAssignableTo(oldR, newR);

    if (newToOld && oldToNew) return null; // equivalent
    if (newToOld) {
      // New return is a subtype of the old one → narrowing → safe for consumers.
      return {
        ...finding,
        level: "minor",
        code: "returnType.narrowed",
        message: finding.message.replace("changed", "narrowed") +
          " (a subtype of the previous return type).",
      };
    }
    return finding; // widened or incompatible → stays major
  }

  return finding;
}
