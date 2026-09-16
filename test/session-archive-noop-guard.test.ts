import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A DISCOVERING guard against dead no-op statements left behind by a botched edit
 * in the cold-archive tier.
 *
 * 🛑 WHY THIS EXISTS — a real incident on the sibling acpx-ui lane. A programmatic
 * edit meant to rewrite a `useEffect` replaced the entire block with the single
 * token `NaN`. Every instrument said fine: `tsc` PASSED (a bare value is a valid
 * expression statement), the build PASSED, and all 37 unit tests PASSED — while
 * the feature the block implemented silently stopped existing. It was caught by
 * someone reading the file, which that lane rightly called luck rather than
 * method.
 *
 * ⚠️ THE COMPILER PROVABLY CANNOT BE THE INSTRUMENT HERE, and that is the whole
 * argument for this file. `typecheck` exits 0 both with and without the defect —
 * verified by mutation, not assumed. So a guard has to look at the text.
 *
 * DISCOVERING, not a list: it walks the tree and flags ANY bare value line, so a
 * future `undefined` / `null` / `0` left by the same class of edit fails without
 * anyone having registered it anywhere. A per-file allowlist would survive its own
 * violation — the failure mode this whole feature's review has hit repeatedly.
 */

/** Scope: this lane's own code. Widening it is safe; narrowing it is not. */
const SCANNED = ["src/session/archive", "src/cli/archive-command.ts"];

/**
 * A line whose ENTIRE content is a value with no effect.
 *
 * ⚠️ DELIBERATELY NARROW — literals only, never a bare identifier. An identifier
 * would collide with object-literal shorthand (`{ id, archivedAt }` spans lines
 * exactly like this), and a guard that cries wolf on real code gets deleted.
 * These tokens are never something a person writes on purpose as a statement.
 */
const NO_OP_LINE = /^\s*(NaN|undefined|null|true|false|void 0|0)\s*;?\s*$/;

function repoRoot(): string {
  // Compiled to `<root>/dist-test/test/<name>.js`, so two levels up is the root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function collectFiles(target: string, out: string[]): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (target.endsWith(".ts")) {
      out.push(target);
    }
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    collectFiles(path.join(target, entry.name), out);
  }
}

/**
 * ⚠️ `}` IS IN THIS SET BECAUSE ITS ABSENCE WAS THE SIBLING GUARD'S OWN BLIND SPOT.
 * Its first version considered only `{`, `;` and `)`, so a no-op planted
 * immediately after a CLOSING BRACE — the single likeliest landing spot for a
 * botched block replacement — was missed entirely while the guard reported the
 * tree clean. It found that only because it wrote a control for itself. The
 * control for this one is `flags a no-op directly after a closing brace` below.
 */
function precedesAStatement(previous: string): boolean {
  return /^\s*(\*|\/\/)/.test(previous) || /[{};)]\s*$/.test(previous);
}

export function scanForNoOpStatements(source: string, label = "<source>"): string[] {
  const hits: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line == null || !NO_OP_LINE.test(line)) {
      continue;
    }
    // Inside a template literal or a block comment a bare `null` is ordinary
    // text. Cheap disambiguation via the previous non-blank line: a false
    // positive costs one glance, a false negative costs a silently deleted
    // feature.
    const previous =
      lines
        .slice(0, i)
        .toReversed()
        .find((candidate) => candidate.trim() !== "") ?? "";
    if (precedesAStatement(previous)) {
      hits.push(`${label}:${i + 1}: ${line.trim()}`);
    }
  }
  return hits;
}

test("no dead no-op statements in the archive tier", () => {
  const root = repoRoot();
  const files: string[] = [];
  for (const target of SCANNED) {
    collectFiles(path.join(root, target), files);
  }

  // ⚠️ THE SCAN MUST HAVE FOUND SOMETHING TO LOOK AT. Without this, a broken path
  // makes the guard pass by scanning zero files — the exact shape of a check that
  // survives its own violation.
  assert.ok(
    files.length >= 10,
    `expected to scan the archive tier, found only ${files.length} file(s) under ${root}`,
  );

  const hits = files.flatMap((file) =>
    scanForNoOpStatements(fs.readFileSync(file, "utf8"), path.relative(root, file)),
  );
  assert.deepEqual(hits, [], `dead no-op statement(s) found:\n${hits.join("\n")}`);
});

// ── controls for the guard itself ───────────────────────────────────────────────
// A guard without a control is a guess about your own blind spot.

test("control: flags the real defect — a block replaced by a bare `NaN`", () => {
  const source = ["function f() {", "  doWork();", "  NaN", "}"].join("\n");
  assert.equal(scanForNoOpStatements(source).length, 1);
});

test("control: flags a no-op directly after a CLOSING BRACE — the sibling's blind spot", () => {
  // The likeliest landing spot for a botched block replacement, and the case the
  // first version of the sibling guard silently missed.
  const source = ["if (ready) {", "  run();", "}", "undefined;", "next();"].join("\n");
  const hits = scanForNoOpStatements(source);
  assert.equal(hits.length, 1, "a no-op after `}` must be flagged");
  assert.match(hits[0], /undefined;/);
});

test("control: flags each bare literal the same class of edit can leave behind", () => {
  for (const token of ["NaN", "undefined", "null", "true", "false", "void 0", "0"]) {
    const source = ["run();", token].join("\n");
    assert.equal(scanForNoOpStatements(source).length, 1, `\`${token}\` must be flagged`);
  }
});

test("control: does NOT flag real code that merely looks similar", () => {
  // Object-literal shorthand and array elements span lines exactly like a bare
  // value. Flagging them would make the guard useless and it would be deleted.
  const source = [
    "const entry = {",
    "  id,",
    "  archivedAt,",
    "};",
    "const flags = [",
    "  true,",
    "  false,",
    "];",
    "void command;",
    "return null;",
    "const x = cond ? null : 0;",
  ].join("\n");
  assert.deepEqual(scanForNoOpStatements(source), []);
});

test("control: does NOT flag a bare value that is a continuation of an expression", () => {
  // The previous line does not end a statement, so this `null` is an argument,
  // not a statement.
  const source = ["const value = pick(", "  null", ");"].join("\n");
  assert.deepEqual(scanForNoOpStatements(source), []);
});
