import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// brick f933f372 — the discovery behind `session-record-file-name.test.ts`: a REAL PARSE of `src/` (as A9's K4
// did for ledger-entry callers), because the first version of this guard was line-based and knew two spellings
// of "a `.json` suffix test". Comments and strings in prose are not code here, so a comment can neither hide
// a filter nor satisfy a rule.

//
// ## WHAT THIS CAN AND CANNOT SEE — named limits (a scan cannot win an arms race; it guards the idiomatic forms)
//
// Seen: `endsWith` with a literal / template / constant (any file) / concatenation / multi-line call; `extname`,
// `slice`, `substring`, `substr`, `at`, `split().pop()` compared with `.json`/`json` — directly, or through ONE
// local (`const ext = path.extname(n); ext === ".json"`); `[".json",…].includes(<suffix call or local>)`;
// regex literals and `new RegExp(…)` ending `\.json$`; `glob`/`globSync`/`matchesGlob` with a pattern ending
// `.json` (a glob is a listing AND a suffix test in one call); and every call that LISTS a directory through
// `readdir`/`opendir`/`glob*`, an import alias, or a bound / destructured / promisified copy.
//
// NOT seen (named, on purpose — the TE measured 24 of 46 fresh spellings escaping; chasing them all is the
// arms race): `switch` on a suffix · `path.parse(n).ext` and `basename(n, ext)` · an import or re-export alias of
// a constant or of `path`/`fs` (`import * as p`, `export { x as y }`) · `.call` / `.apply` / `.bind` and element
// access (`fs["readdir"]`) · a listing function copied through an OBJECT property · other glob libraries
// (`fast-glob`, `globby`, …) · `lastIndexOf` / `indexOf` suffix tests · a suffix computed through more than one
// local hop · a suffix test passed as a callback. What keeps an escape cheap is the rest of the net: the
// predicate is the only thing the index, the archive scan and the backfill call, and a suffix test that
// bypasses it shows as index churn (see test/delivery-json-sidecar.test.ts).
// OVER-FIRES, accepted: a comparison of `at(-1)`, `split().pop()` or `slice(0, 4)` with the string `"json"` on
// a NON-file-name value (the one in `flows/json.ts`, a Markdown fence tag, is exempted per occurrence).

export function* tsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* tsFiles(full);
    } else if (entry.name.endsWith(".ts")) {
      yield full;
    }
  }
}

export type Parsed = { relative: string; sf: ts.SourceFile };

export function parseTree(root: string): Parsed[] {
  return [...tsFiles(root)].map((file) => ({
    relative: path.relative(root, file).split(path.sep).join("/"),
    sf: ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true),
  }));
}

// ---- string evaluation: literals, concatenation, and `const` names (any file: a constant suffix may be imported) ----

export type Constants = Map<string, string[]>;

function literalText(node: ts.Node): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

export function stringValues(
  node: ts.Node | undefined,
  constants: Constants,
  depth = 0,
): string[] | undefined {
  if (node === undefined || depth > 6) {
    return undefined;
  }
  const literal = literalText(node);
  if (literal !== undefined) {
    return [literal];
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return stringValues(node.expression, constants, depth + 1);
  }
  if (ts.isIdentifier(node)) {
    return constants.get(node.text);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = stringValues(node.left, constants, depth + 1);
    const right = stringValues(node.right, constants, depth + 1);
    return left && right ? left.flatMap((l) => right.map((r) => l + r)) : undefined;
  }
  if (ts.isTemplateExpression(node)) {
    let values = [node.head.text];
    for (const span of node.templateSpans) {
      const inner = stringValues(span.expression, constants, depth + 1);
      if (!inner) {
        return undefined;
      }
      values = values.flatMap((v) => inner.map((i) => v + i + span.literal.text));
    }
    return values;
  }
  return undefined;
}

export function collectConstants(files: readonly Parsed[]): Constants {
  const constants: Constants = new Map();
  const empty: Constants = new Map();
  for (const { sf } of files) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0
      ) {
        const values = stringValues(node.initializer, empty);
        if (values) {
          constants.set(node.name.text, [...(constants.get(node.name.text) ?? []), ...values]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return constants;
}

// ---- sites -------------------------------------------------------------------------------------------------

export type Site = { file: string; fn: string; text: string };

function collapsed(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/gu, " ").trim();
}

function enclosingFunction(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name !== undefined
    ) {
      return current.name.getText();
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
  }
  return "<module>";
}

const SUFFIX_CALLS = new Set(["extname", "slice", "substring", "substr", "pop", "at"]);
const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
}

function containsSuffixCall(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child) && SUFFIX_CALLS.has(calleeName(child) ?? "")) {
      found = true;
    }
    if (!found) {
      ts.forEachChild(child, visit);
    }
  };
  visit(node);
  return found;
}

/** Names bound (anywhere in the file) to a suffix-derived value: `const ext = path.extname(n)`. One hop. */
export type SuffixLocals = ReadonlySet<string>;

export function suffixLocals(sf: ts.SourceFile): SuffixLocals {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      containsSuffixCall(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function mentionsAny(node: ts.Node, names: SuffixLocals): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child) && names.has(child.text)) {
      found = true;
    }
    if (!found) {
      ts.forEachChild(child, visit);
    }
  };
  visit(node);
  return found;
}

const derivedFromSuffix = (node: ts.Node, locals: SuffixLocals): boolean =>
  containsSuffixCall(node) || mentionsAny(node, locals);

const GLOB_CALLS = new Set(["glob", "globSync", "matchesGlob"]);

const isJsonish = (values: readonly string[] | undefined): boolean =>
  values?.some((value) => value === ".json" || value === "json" || value.endsWith(".json")) ??
  false;
const REGEX_JSON_END = /(?:\\\.|\.)json\)?\$\/?[dgimsuvy]*$/u;

function jsonSuffixTest(node: ts.Node, constants: Constants, locals: SuffixLocals): boolean {
  if (ts.isRegularExpressionLiteral(node)) {
    return REGEX_JSON_END.test(node.text);
  }
  if (
    (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
    node.expression.getText() === "RegExp"
  ) {
    return (
      stringValues(node.arguments?.[0], constants)?.some((v) => /(?:\\\.|\.)json\)?\$$/u.test(v)) ??
      false
    );
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name === "endsWith") {
      return isJsonish(stringValues(node.arguments[0], constants));
    }
    if (GLOB_CALLS.has(name ?? "")) {
      return node.arguments.some((argument) => isJsonish(stringValues(argument, constants)));
    }
    if (name === "includes" || name === "has" || name === "indexOf") {
      const receiver = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.expression
        : undefined;
      const members =
        receiver && ts.isArrayLiteralExpression(receiver)
          ? receiver.elements.flatMap((element) => stringValues(element, constants) ?? [])
          : [];
      return (
        isJsonish(members) && node.arguments.some((argument) => derivedFromSuffix(argument, locals))
      );
    }
  }
  if (ts.isBinaryExpression(node) && COMPARISONS.has(node.operatorToken.kind)) {
    const sides: [ts.Node, ts.Node][] = [
      [node.left, node.right],
      [node.right, node.left],
    ];
    return sides.some(
      ([literal, other]) =>
        isJsonish(stringValues(literal, constants)) && derivedFromSuffix(other, locals),
    );
  }
  return false;
}

/** Every place that TESTS a name's suffix for `.json`, in any spelling the parse can see. */
export function jsonSuffixSites(parsed: readonly Parsed[], constants: Constants): Site[] {
  const sites: Site[] = [];
  for (const { relative, sf } of parsed) {
    const locals = suffixLocals(sf);
    const visit = (node: ts.Node): void => {
      if (jsonSuffixTest(node, constants, locals)) {
        sites.push({ file: relative, fn: enclosingFunction(node), text: collapsed(node, sf) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

const LISTING = new Set(["readdir", "readdirSync", "opendir", "opendirSync", "glob", "globSync"]);

function listingAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>();
  const isListing = (node: ts.Node | undefined): boolean => {
    if (!node) {
      return false;
    }
    if (ts.isIdentifier(node)) {
      return LISTING.has(node.text) || aliases.has(node.text);
    }
    if (ts.isPropertyAccessExpression(node)) {
      return LISTING.has(node.name.text);
    }
    if (ts.isCallExpression(node)) {
      return node.arguments.some(isListing) || isListing(node.expression);
    }
    return ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      ? isListing(node.expression)
      : false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && LISTING.has((node.propertyName ?? node.name).text)) {
      aliases.add(node.name.text);
    } else if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && isListing(node.initializer)) {
        aliases.add(node.name.text);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (
            ts.isIdentifier(element.name) &&
            LISTING.has((element.propertyName ?? element.name).getText())
          ) {
            aliases.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return aliases;
}

/** Every call that lists a directory — through `readdir`/`opendir`, an import alias, or a bound/destructured copy. */
export function listingSites(parsed: readonly Parsed[]): Site[] {
  const sites: Site[] = [];
  for (const { relative, sf } of parsed) {
    const aliases = listingAliases(sf);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const listed =
          (ts.isIdentifier(callee) && (LISTING.has(callee.text) || aliases.has(callee.text))) ||
          (ts.isPropertyAccessExpression(callee) && LISTING.has(callee.name.text));
        if (listed) {
          sites.push({ file: relative, fn: enclosingFunction(node), text: collapsed(node, sf) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

/** Non-import references to `name` — a mention in a comment is not one. */
export function referencesOf(sf: ts.SourceFile, name: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      !ts.isImportSpecifier(node.parent) &&
      !ts.isImportClause(node.parent)
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}
