import type {
  ApiSurface,
  CallSignature,
  ClassSymbol,
  EnumSymbol,
  ExportedSymbol,
  FunctionSymbol,
  InterfaceSymbol,
  Parameter,
  PropertyMember,
  TypeAliasSymbol,
  TypeParameter,
  VariableSymbol,
} from "./model.js";
import type { Finding } from "./findings.js";

/**
 * Compare two extracted surfaces and produce a list of findings.
 *
 * LIMITATION: types are compared as normalized strings, not via the compiler's
 * assignability relation. So "did this type widen or narrow?" cannot be answered
 * precisely across two independent builds. Where a change *could* be breaking, we
 * classify it as `major` — a checker meant to fail CI should err toward safety.
 * Cases where structure alone proves the direction (adding an optional param,
 * relaxing `required` to `optional`) are classified precisely.
 */
export function diffSurfaces(before: ApiSurface, after: ApiSurface): Finding[] {
  const findings: Finding[] = [];
  const beforeNames = new Set(Object.keys(before.exports));
  const afterNames = new Set(Object.keys(after.exports));

  for (const name of beforeNames) {
    if (!afterNames.has(name)) {
      findings.push({
        level: "major",
        code: "export.removed",
        path: name,
        message: `Exported symbol '${name}' was removed.`,
      });
    }
  }

  for (const name of afterNames) {
    if (!beforeNames.has(name)) {
      findings.push({
        level: "minor",
        code: "export.added",
        path: name,
        message: `New exported symbol '${name}' was added.`,
      });
    }
  }

  for (const name of beforeNames) {
    if (!afterNames.has(name)) continue;
    const oldSym = before.exports[name]!;
    const newSym = after.exports[name]!;
    if (oldSym.kind !== newSym.kind) {
      findings.push({
        level: "major",
        code: "export.kindChanged",
        path: name,
        message: `'${name}' changed from ${oldSym.kind} to ${newSym.kind}.`,
      });
      continue;
    }
    diffSymbol(name, oldSym, newSym, findings);
  }

  return findings;
}

function diffSymbol(
  name: string,
  before: ExportedSymbol,
  after: ExportedSymbol,
  findings: Finding[],
): void {
  switch (before.kind) {
    case "function":
      diffFunction(name, before, after as FunctionSymbol, findings);
      break;
    case "interface":
      diffInterface(name, before, after as InterfaceSymbol, findings);
      break;
    case "class":
      diffClass(name, before, after as ClassSymbol, findings);
      break;
    case "enum":
      diffEnum(name, before, after as EnumSymbol, findings);
      break;
    case "typeAlias":
      diffTypeAlias(name, before, after as TypeAliasSymbol, findings);
      break;
    case "variable":
      diffVariable(name, before, after as VariableSymbol, findings);
      break;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function renderSignature(sig: CallSignature): string {
  const tp =
    sig.typeParameters.length > 0
      ? `<${sig.typeParameters.map(renderTypeParam).join(", ")}>`
      : "";
  const params = sig.parameters
    .map((p) => `${p.rest ? "..." : ""}${p.name}${p.optional ? "?" : ""}: ${p.type}`)
    .join(", ");
  return `${tp}(${params}) => ${sig.returnType}`;
}

function renderTypeParam(tp: TypeParameter): string {
  let s = tp.name;
  if (tp.constraint) s += ` extends ${tp.constraint}`;
  if (tp.default) s += ` = ${tp.default}`;
  return s;
}

function diffTypeParameters(
  owner: string,
  before: TypeParameter[],
  after: TypeParameter[],
  findings: Finding[],
): void {
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) {
    const b = before[i];
    const a = after[i];
    const path = `${owner}.typeParams[${i}]`;

    if (b && !a) {
      findings.push({
        level: "major",
        code: "generics.typeParamRemoved",
        path,
        message: `Type parameter '${b.name}' was removed.`,
      });
      continue;
    }
    if (!b && a) {
      if (a.default) {
        // Added with a default -> existing usages still compile.
        findings.push({
          level: "minor",
          code: "generics.typeParamAdded",
          path,
          message: `New type parameter '${renderTypeParam(a)}' was added with a default.`,
        });
      } else {
        findings.push({
          level: "major",
          code: "generics.typeParamAddedRequired",
          path,
          message: `New required type parameter '${renderTypeParam(a)}' was added.`,
        });
      }
      continue;
    }
    if (b && a) diffOneTypeParameter(path, b, a, findings);
  }
}

function diffOneTypeParameter(
  path: string,
  before: TypeParameter,
  after: TypeParameter,
  findings: Finding[],
): void {
  // A type parameter's constraint is an upper bound on what callers may
  // instantiate it with. Relaxing/removing it is safe (widening), tightening/
  // adding it is breaking (narrowing). We can't tell direction from strings, so
  // report a conservative `major` here; assignability refinement decides.
  if (before.constraint !== after.constraint) {
    findings.push({
      level: "major",
      code: "generics.constraintChanged",
      path,
      message:
        `Type parameter '${after.name}' constraint changed from ` +
        `'${before.constraint ?? "(unconstrained)"}' to '${after.constraint ?? "(unconstrained)"}'.`,
    });
  }

  if (before.default !== after.default) {
    if (!before.default && after.default) {
      findings.push({
        level: "minor",
        code: "generics.defaultAdded",
        path,
        message: `Type parameter '${after.name}' gained a default of '${after.default}'.`,
      });
    } else if (before.default && !after.default) {
      findings.push({
        level: "major",
        code: "generics.defaultRemoved",
        path,
        message: `Type parameter '${after.name}' lost its default of '${before.default}'.`,
      });
    } else {
      findings.push({
        level: "major",
        code: "generics.defaultChanged",
        path,
        message: `Type parameter '${after.name}' default changed from '${before.default}' to '${after.default}'.`,
      });
    }
  }
  // A name-only change is positional/cosmetic and not breaking — no finding.
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

function diffFunction(
  name: string,
  before: FunctionSymbol,
  after: FunctionSymbol,
  findings: Finding[],
): void {
  // Single signature on each side is the common case; diff it at parameter level
  // so we can distinguish "added optional param" (minor) from "added required".
  if (before.signatures.length === 1 && after.signatures.length === 1) {
    diffSignature(name, before.signatures[0]!, after.signatures[0]!, findings, "param");
    return;
  }

  // Overloaded: compare the set of rendered signatures.
  const beforeSigs = new Map(before.signatures.map((s) => [renderSignature(s), s]));
  const afterSigs = new Set(after.signatures.map(renderSignature));

  for (const [rendered] of beforeSigs) {
    if (!afterSigs.has(rendered)) {
      findings.push({
        level: "major",
        code: "overload.removedOrChanged",
        path: name,
        message: `Call signature no longer present: ${rendered}`,
      });
    }
  }
  for (const rendered of afterSigs) {
    if (!beforeSigs.has(rendered)) {
      findings.push({
        level: "minor",
        code: "overload.added",
        path: name,
        message: `New call signature added: ${rendered}`,
      });
    }
  }
}

/**
 * Diff two call signatures at the parameter level.
 * `role` distinguishes plain parameters from constructor parameters for messaging.
 */
function diffSignature(
  path: string,
  before: CallSignature,
  after: CallSignature,
  findings: Finding[],
  role: "param" | "ctor",
): void {
  diffTypeParameters(path, before.typeParameters, after.typeParameters, findings);

  const max = Math.max(before.parameters.length, after.parameters.length);
  for (let i = 0; i < max; i++) {
    const b = before.parameters[i];
    const a = after.parameters[i];
    const paramPath = `${path}.${role === "ctor" ? "ctor." : ""}params[${i}]`;

    if (b && !a) {
      findings.push({
        level: "major",
        code: "param.removed",
        path: paramPath,
        message: `Parameter '${b.name}' was removed.`,
      });
      continue;
    }
    if (!b && a) {
      if (a.optional || a.rest) {
        findings.push({
          level: "minor",
          code: "param.addedOptional",
          path: paramPath,
          message: `New optional parameter '${a.name}: ${a.type}' was added.`,
        });
      } else {
        findings.push({
          level: "major",
          code: "param.addedRequired",
          path: paramPath,
          message: `New required parameter '${a.name}: ${a.type}' was added.`,
        });
      }
      continue;
    }
    if (b && a) diffParameter(paramPath, b, a, findings);
  }

  if (before.returnType !== after.returnType) {
    findings.push({
      level: "major",
      code: "returnType.changed",
      path: `${path}.returnType`,
      message: `Return type changed from '${before.returnType}' to '${after.returnType}'.`,
    });
  }
}

function diffParameter(path: string, before: Parameter, after: Parameter, findings: Finding[]): void {
  if (before.type !== after.type) {
    findings.push({
      level: "major",
      code: "param.typeChanged",
      path,
      message: `Parameter '${before.name}' type changed from '${before.type}' to '${after.type}'.`,
    });
  }
  if (before.optional && !after.optional) {
    findings.push({
      level: "major",
      code: "param.madeRequired",
      path,
      message: `Parameter '${before.name}' changed from optional to required.`,
    });
  } else if (!before.optional && after.optional) {
    findings.push({
      level: "minor",
      code: "param.madeOptional",
      path,
      message: `Parameter '${before.name}' changed from required to optional.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Interfaces & classes (structural members)
// ---------------------------------------------------------------------------

function diffInterface(
  name: string,
  before: InterfaceSymbol,
  after: InterfaceSymbol,
  findings: Finding[],
): void {
  diffTypeParameters(name, before.typeParameters, after.typeParameters, findings);
  // For interfaces, adding a required member is breaking (implementers/object
  // literals must now provide it).
  diffProperties(name, before.properties, after.properties, findings, "interface");
  diffMethods(name, before.methods, after.methods, findings, "interface");
}

function diffClass(name: string, before: ClassSymbol, after: ClassSymbol, findings: Finding[]): void {
  diffTypeParameters(name, before.typeParameters, after.typeParameters, findings);

  if (!before.abstract && after.abstract) {
    findings.push({
      level: "major",
      code: "class.madeAbstract",
      path: name,
      message: `Class '${name}' was made abstract and can no longer be instantiated directly.`,
    });
  } else if (before.abstract && !after.abstract) {
    findings.push({
      level: "minor",
      code: "class.madeConcrete",
      path: name,
      message: `Class '${name}' is no longer abstract.`,
    });
  }

  // For classes, adding a public member is non-breaking (consumers don't implement
  // classes structurally in practice); removing/changing is breaking.
  diffProperties(name, before.properties, after.properties, findings, "class");
  diffMethods(name, before.methods, after.methods, findings, "class");

  diffConstructors(name, before.constructors, after.constructors, findings);
}

function diffConstructors(
  name: string,
  before: CallSignature[],
  after: CallSignature[],
  findings: Finding[],
): void {
  if (before.length === 0 && after.length === 0) return;
  // Compare the primary construct signature at parameter level.
  const b = before[0];
  const a = after[0];
  if (b && a) {
    diffSignature(name, b, a, findings, "ctor");
  } else if (b && !a) {
    findings.push({
      level: "major",
      code: "constructor.removed",
      path: `${name}.ctor`,
      message: `Constructor of '${name}' was removed.`,
    });
  }
}

type MemberOwner = "interface" | "class";

function diffProperties(
  owner: string,
  before: Record<string, PropertyMember>,
  after: Record<string, PropertyMember>,
  findings: Finding[],
  kind: MemberOwner,
): void {
  for (const [propName, b] of Object.entries(before)) {
    const a = after[propName];
    const path = `${owner}.${propName}`;
    if (!a) {
      findings.push({
        level: "major",
        code: "property.removed",
        path,
        message: `Property '${propName}' was removed from '${owner}'.`,
      });
      continue;
    }
    if (b.type !== a.type) {
      findings.push({
        level: "major",
        code: "property.typeChanged",
        path,
        message: `Property '${propName}' type changed from '${b.type}' to '${a.type}'.`,
      });
    }
    if (b.optional && !a.optional) {
      findings.push({
        level: "major",
        code: "property.madeRequired",
        path,
        message: `Property '${propName}' changed from optional to required.`,
      });
    } else if (!b.optional && a.optional) {
      findings.push({
        level: "minor",
        code: "property.madeOptional",
        path,
        message: `Property '${propName}' changed from required to optional.`,
      });
    }
    if (!b.readonly && a.readonly) {
      findings.push({
        level: "major",
        code: "property.madeReadonly",
        path,
        message: `Property '${propName}' was made readonly.`,
      });
    } else if (b.readonly && !a.readonly) {
      findings.push({
        level: "minor",
        code: "property.readonlyRemoved",
        path,
        message: `Property '${propName}' is no longer readonly.`,
      });
    }
  }

  for (const [propName, a] of Object.entries(after)) {
    if (before[propName]) continue;
    const path = `${owner}.${propName}`;
    if (kind === "class") {
      findings.push({
        level: "minor",
        code: "property.added",
        path,
        message: `New property '${propName}: ${a.type}' was added to class '${owner}'.`,
      });
    } else if (a.optional) {
      findings.push({
        level: "minor",
        code: "property.addedOptional",
        path,
        message: `New optional property '${propName}?: ${a.type}' was added.`,
      });
    } else {
      findings.push({
        level: "major",
        code: "property.addedRequired",
        path,
        message: `New required property '${propName}: ${a.type}' was added to interface '${owner}'.`,
      });
    }
  }
}

function diffMethods(
  owner: string,
  before: Record<string, CallSignature[]>,
  after: Record<string, CallSignature[]>,
  findings: Finding[],
  kind: MemberOwner,
): void {
  for (const [methodName, b] of Object.entries(before)) {
    const a = after[methodName];
    const path = `${owner}.${methodName}()`;
    if (!a) {
      findings.push({
        level: "major",
        code: "method.removed",
        path,
        message: `Method '${methodName}' was removed from '${owner}'.`,
      });
      continue;
    }
    const beforeStr = b.map(renderSignature).join(" | ");
    const afterStr = a.map(renderSignature).join(" | ");
    if (beforeStr !== afterStr) {
      findings.push({
        level: "major",
        code: "method.signatureChanged",
        path,
        message: `Method '${methodName}' signature changed from '${beforeStr}' to '${afterStr}'.`,
      });
    }
  }

  for (const methodName of Object.keys(after)) {
    if (before[methodName]) continue;
    const path = `${owner}.${methodName}()`;
    if (kind === "class") {
      findings.push({
        level: "minor",
        code: "method.added",
        path,
        message: `New method '${methodName}' was added to class '${owner}'.`,
      });
    } else {
      findings.push({
        level: "major",
        code: "method.addedRequired",
        path,
        message: `New method '${methodName}' was added to interface '${owner}' (implementers must provide it).`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Enums, type aliases, variables
// ---------------------------------------------------------------------------

function diffEnum(name: string, before: EnumSymbol, after: EnumSymbol, findings: Finding[]): void {
  if (before.const !== after.const) {
    findings.push({
      level: "major",
      code: "enum.constnessChanged",
      path: name,
      message: `Enum '${name}' ${after.const ? "became" : "is no longer"} a const enum.`,
    });
  }

  for (const [member, value] of Object.entries(before.members)) {
    const newValue = after.members[member];
    const path = `${name}.${member}`;
    if (newValue === undefined) {
      findings.push({
        level: "major",
        code: "enum.memberRemoved",
        path,
        message: `Enum member '${member}' was removed.`,
      });
    } else if (newValue !== value) {
      findings.push({
        level: "major",
        code: "enum.valueChanged",
        path,
        message: `Enum member '${member}' value changed from '${value}' to '${newValue}'.`,
      });
    }
  }

  for (const member of Object.keys(after.members)) {
    if (before.members[member] !== undefined) continue;
    findings.push({
      level: "minor",
      code: "enum.memberAdded",
      path: `${name}.${member}`,
      message: `New enum member '${member}' was added.`,
    });
  }
}

function diffTypeAlias(
  name: string,
  before: TypeAliasSymbol,
  after: TypeAliasSymbol,
  findings: Finding[],
): void {
  diffTypeParameters(name, before.typeParameters, after.typeParameters, findings);
  if (before.type !== after.type) {
    findings.push({
      level: "major",
      code: "typeAlias.changed",
      path: name,
      message: `Type alias '${name}' changed from '${before.type}' to '${after.type}'.`,
    });
  }
}

function diffVariable(
  name: string,
  before: VariableSymbol,
  after: VariableSymbol,
  findings: Finding[],
): void {
  if (before.type !== after.type) {
    findings.push({
      level: "major",
      code: "variable.typeChanged",
      path: name,
      message: `Exported value '${name}' type changed from '${before.type}' to '${after.type}'.`,
    });
  }
}
