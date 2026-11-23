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
// Seen: `endsWith` with a literal / template / constant (any file) / concatenation / multi-line call, AND with an
// ELEMENT of a constant list or Set — the parameter of a `.some/.find/.findLast/.findIndex/.every/.filter/.map/
// .flatMap/.forEach` callback over it, or the variable of `for (const s of LIST)` (the predicate's own idiom; a
// list may be inline, `as const`, spread into `[...LIST]`, `Array.from(LIST)`, `LIST.slice()` / `.toSorted()` /
// `.toReversed()`, a `new Set([…])`, an alias, or imported from any file) — and the iterated ELEMENT compared with
// `===`/`!==` against a suffix-derived value instead of `endsWith` (F-17: `EXTS.some((e) => ext === e)`);
// `extname`, `slice`, `substring`, `substr`, `at`, `split().pop()` compared with `.json`/`json` — directly, or
// through ONE local of the same function (`const ext = path.extname(n); ext === ".json"`) — including when that
// local is READ in a nested closure of the function that declared it (F-18: `const isRecord = () => ext === ".json"`); `includes`/`has`/
// `indexOf` on a literal OR constant array/Set holding `.json` with an argument derived from such a call or
// local (`EXTS.has(path.extname(n))`); regex literals and `new RegExp(…)` ending `\.json$`;
// `glob`/`globSync`/`matchesGlob` with a pattern ending `.json` (a glob is a listing AND a suffix test in one
// call); and every call that LISTS a directory through `readdir`/`opendir`/`glob*`, an import alias, or a bound /
// destructured / promisified copy.
//
// ⚠️ THE RULE THIS GUARD CANNOT ENFORCE FOR YOU: a suffix list must be THE PREDICATE'S OWN. Never test `.json`
// membership through a list of your own — `[".json", …].some((s) => n.endsWith(s))` is seen and flagged here, but
// the right edit is to call `isSessionRecordFileName` (the one place that iterates a list, per occurrence below).
//
// NOT seen (named, on purpose — a scan cannot win an arms race; the TE measured 24 of 46 fresh spellings escaping
// round 1 and 6 more in round 2, and the parent ruled to name them rather than chase them):
//   · an object constant (`const X = { json: ".json" }; n.endsWith(X.json)`) or any property-access constant
//   · a generic helper (`hasSuffix(n, ".json")`, `endsWithAny(n, EXTS)`) — only calls named `endsWith` count
//   · a case-insensitive or oddly built pattern: `/\.JSON$/i`, `String.raw` in a RegExp, a pattern from a template
//   · `switch` on a suffix · `path.parse(n).ext` · `basename(n, ext)` · `lastIndexOf` / `indexOf` suffix tests
//   · an import or re-export alias of a constant, of `path` or of `fs` (`import * as p`, `export { x as y }`)
//   · `.call` / `.apply` / `.bind`, `Reflect.apply(fn, thisArg, args)` and element access (`fs["readdir"]`)
//   · a listing function copied through an OBJECT property, assigned with `let`, or promisified INLINE
//     (`promisify(fs.readdir)(d)`); a listing handed to a callback (`run(fs.readdir)`); other glob libraries
//   · list iteration through `reduce` (the element is the SECOND parameter), a counted index loop
//     (`for (let i = 0; i < LIST.length; i += 1) n.endsWith(LIST[i])`), `LIST.entries()` / `Object.entries(…)`
//     destructuring, or an element handed to a helper (F-17, the part that is not cheap)
//   · a list copy other than spread / `Array.from` / `slice` / `toSorted` / `toReversed` — `concat`, `filter`,
//     `flatMap`, `map` — and `Object.is(a, b)` in place of `===`
//   · a suffix local that is DESTRUCTURED (`const { ext } = path.parse(n)`) or assigned AFTER its declaration
//     (`let ext; ext = path.extname(n);`) — a declaration binds one only when it HAS the suffix call as its
//     initialiser, `const` or `let` alike (`let ext = path.extname(n)` is seen) (F-25)
//   · a suffix taken with `reverse()[0]`, or through more than one local hop, or passed to a callback
// What keeps an escape cheap is the rest of the net: the predicate is the only thing the index, the archive scan
// and the backfill call, and a suffix test that bypasses it shows as index churn (test/delivery-json-sidecar.test.ts).
// OVER-FIRES, accepted: a comparison of `at(-1)`, `split().pop()` or `slice(0, 4)` with the string `"json"` on a
// NON-file-name value (the one in `flows/json.ts`, a Markdown fence tag, is exempted per occurrence).

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

// ---- constant LISTS: `const X = [".json", …]`, `new Set([…])`, `as const`, and aliases of those ---------------------

/** name → every string element of a constant array / Set (any file; an alias `const A = B` follows B). */
export type Lists = Map<string, string[]>;

function listElements(
  node: ts.Node,
  constants: Constants,
  lists: Lists,
  depth = 0,
): string[] | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return listElements(node.expression, constants, lists, depth + 1);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.flatMap((element) =>
      ts.isSpreadElement(element)
        ? (listElements(element.expression, constants, lists, depth + 1) ?? [])
        : (stringValues(element, constants) ?? []),
    );
  }
  if (ts.isNewExpression(node) && node.expression.getText() === "Set" && node.arguments?.[0]) {
    return listElements(node.arguments[0], constants, lists, depth + 1);
  }
  if (ts.isIdentifier(node)) {
    return lists.get(node.text);
  }
  if (ts.isCallExpression(node)) {
    // `Array.from(LIST)` and the copies of a list that keep its elements
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      if (
        callee.expression.getText() === "Array" &&
        callee.name.text === "from" &&
        node.arguments[0]
      ) {
        return listElements(node.arguments[0], constants, lists, depth + 1);
      }
      if (["slice", "values", "toSorted", "toReversed"].includes(callee.name.text)) {
        return listElements(callee.expression, constants, lists, depth + 1);
      }
    }
  }
  return undefined;
}

export function collectLists(files: readonly Parsed[], constants: Constants): Lists {
  const lists: Lists = new Map();
  // two passes, so an alias declared before its target (or in another file) resolves
  for (let pass = 0; pass < 2; pass += 1) {
    for (const { sf } of files) {
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0
        ) {
          const elements = listElements(node.initializer, constants, lists);
          if (elements) {
            lists.set(node.name.text, elements);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return lists;
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

/**
 * EVERY named function around `node`, innermost first (`isRecord`, `f` for a closure inside `f`). A suffix-derived
 * local is declared in one function (`f`) and may be READ in a closure of it (`const isRecord = () => ext ===
 * ".json"`): the lookup walks the chain (F-18) while the scoping still stops a name leaking between siblings.
 */
function enclosingFunctionChain(node: ts.Node): string[] {
  const chain: string[] = [];
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) &&
      current.name !== undefined
    ) {
      chain.push(current.name.getText());
    } else if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      chain.push(current.parent.name.text);
    }
  }
  return chain.length > 0 ? chain : ["<module>"];
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

/**
 * `function::name` of every local bound to a suffix-derived value: `const ext = path.extname(n)`. One hop,
 * SCOPED to the enclosing function — a file-wide name set made `OUTPUT_FORMATS.includes(value)` in cli-core.ts
 * look like a suffix test because another function there binds a `value` from a `slice`.
 */
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
      names.add(`${enclosingFunction(node)}::${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function mentionsAny(node: ts.Node, names: SuffixLocals): boolean {
  let found = false;
  const chain = enclosingFunctionChain(node);
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child) && chain.some((fn) => names.has(`${fn}::${child.text}`))) {
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

const ITERATING_CALLS = new Set([
  "some",
  "find",
  "findLast",
  "findIndex",
  "every",
  "filter",
  "map",
  "flatMap",
  "forEach",
]);

/**
 * The constant list an identifier is an ELEMENT of: the parameter of a callback given to `.some/.find/.every/…`
 * on that list, or the loop variable of `for (const s of LIST)`. (F-14: iterating a constant suffix list is
 * the idiom the predicate itself uses; `LIST.some((s) => n.endsWith(s))` is a suffix test.)
 */
function elementsOfIterated(
  identifier: ts.Identifier,
  constants: Constants,
  lists: Lists,
): string[] | undefined {
  for (let current: ts.Node | undefined = identifier.parent; current; current = current.parent) {
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      current.parameters.some((parameter) => parameter.name.getText() === identifier.text) &&
      ts.isCallExpression(current.parent) &&
      ts.isPropertyAccessExpression(current.parent.expression) &&
      ITERATING_CALLS.has(current.parent.expression.name.text)
    ) {
      return listElements(current.parent.expression.expression, constants, lists);
    }
    if (
      ts.isForOfStatement(current) &&
      ts.isVariableDeclarationList(current.initializer) &&
      current.initializer.declarations.some(
        (declaration) => declaration.name.getText() === identifier.text,
      )
    ) {
      return listElements(current.expression, constants, lists);
    }
  }
  return undefined;
}

const GLOB_CALLS = new Set(["glob", "globSync", "matchesGlob"]);

const isJsonish = (values: readonly string[] | undefined): boolean =>
  values?.some((value) => value === ".json" || value === "json" || value.endsWith(".json")) ??
  false;
const REGEX_JSON_END = /(?:\\\.|\.)json\)?\$\/?[dgimsuvy]*$/u;

function jsonSuffixTest(
  node: ts.Node,
  constants: Constants,
  locals: SuffixLocals,
  lists: Lists,
): boolean {
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
      const argument = node.arguments[0];
      return (
        isJsonish(stringValues(argument, constants)) ||
        (argument !== undefined &&
          ts.isIdentifier(argument) &&
          isJsonish(elementsOfIterated(argument, constants, lists)))
      );
    }
    if (GLOB_CALLS.has(name ?? "")) {
      return node.arguments.some((argument) => isJsonish(stringValues(argument, constants)));
    }
    if (name === "includes" || name === "has" || name === "indexOf") {
      // F-15: the receiver may be a literal OR a constant array / Set (`EXTS.has(extname(n))`)
      const receiver = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.expression
        : undefined;
      const members = receiver ? (listElements(receiver, constants, lists) ?? []) : [];
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
    // F-17: `ext === s` where `s` is an element of a `.json`-holding constant list being iterated
    const elementCompared = sides.some(
      ([element, other]) =>
        ts.isIdentifier(element) &&
        isJsonish(elementsOfIterated(element, constants, lists)) &&
        derivedFromSuffix(other, locals),
    );
    return (
      elementCompared ||
      sides.some(
        ([literal, other]) =>
          isJsonish(stringValues(literal, constants)) && derivedFromSuffix(other, locals),
      )
    );
  }
  return false;
}

/** Every place that TESTS a name's suffix for `.json`, in any spelling the parse can see. */
export function jsonSuffixSites(parsed: readonly Parsed[], constants: Constants): Site[] {
  const sites: Site[] = [];
  const lists = collectLists(parsed, constants);
  for (const { relative, sf } of parsed) {
    const locals = suffixLocals(sf);
    const visit = (node: ts.Node): void => {
      if (jsonSuffixTest(node, constants, locals, lists)) {
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
