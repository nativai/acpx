// brick://1d1cd13a — no test file may tear a temp HOME down by hand again.
//
// WHY A SCAN AND NOT A LIST. The base carried ~38 private `withTempHome` copies and
// a dozen hand-rolled `mkdtemp(...home...)` + `fs.rm(..., force)` teardowns, each of
// which lost the same race to a detached child still writing under the home
// (`temp-home.ts` has the mechanism). A hand-maintained list of "the files that
// were fixed" survives its own violation: the next file to copy the pattern is simply
// not on it. So this check DISCOVERS its subjects — every `test/*.ts` file — and
// flags a home-like `mkdtemp` directory removed directly with `rm`/`rmSync`. It is
// proven by negative cases below, which build a fresh offending source and expect it
// flagged without registering it anywhere.
//
// "HOME-LIKE" is a syntactic definition, kept deliberately dumb: the variable is
// pinned as `HOME`/`ACPX_STATE_HOME` in the same file, is named like a home, or its
// `mkdtemp` prefix says home/state. A cwd or a fake-agent directory is none of these
// and is removed however its author likes.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Resolved from this module: the compiled copy runs from `dist-test/test/`, and the
// sources it must read are the `.ts` originals (same trick as owner-reaper-coverage).
const TEST_DIR = fileURLToPath(new URL("../../test/", import.meta.url));

/** The files that ARE the teardown, or prove it: the only places allowed to call
 *  `rm`/`rmSync` on a home directory. */
const EXEMPT = new Set(["temp-home.ts", "temp-home.test.ts", "temp-home-coverage.test.ts"]);

const HOME_NAME = /^(home|homeDir|tempHome|stateHome|fakeHome|childHome|homeOnly)$/i;

type HandRolledTeardown = { variable: string; reason: string };

/** Every home-like `mkdtemp` variable in `source` that is removed by a bare
 *  `rm`/`rmSync` instead of `removeTempHome`/`removeTempHomeSync`/`withTempHome`. */
function findHandRolledHomeTeardowns(source: string): HandRolledTeardown[] {
  const found: HandRolledTeardown[] = [];
  const declaration =
    /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:fs\.|fsp\.)?mkdtemp(?:Sync)?\(([^;]*?)\);/g;
  for (const match of source.matchAll(declaration)) {
    const variable = match[1] ?? "";
    const argument = match[2] ?? "";
    const pinned = new RegExp(`(?:\\bHOME|ACPX_STATE_HOME)"?\\]?\\s*[:=]\\s*${variable}\\b`).test(
      source,
    );
    const homeLike = pinned || HOME_NAME.test(variable) || /home|state/i.test(argument);
    if (!homeLike) {
      continue;
    }
    const removedByHand = new RegExp(`\\brm(?:Sync)?\\(\\s*${variable}\\s*,`).test(source);
    if (removedByHand) {
      found.push({
        variable,
        reason: pinned ? "pinned as HOME" : "named / prefixed like a home",
      });
    }
  }
  // A removal can also name its target through a receiver (`fixture.homeDir`) or an
  // assignment (`home = mkdtempSync(...)`), neither of which a `const x = mkdtemp`
  // declaration scan sees. Any removal whose target's LAST segment is a home name is
  // the same teardown.
  for (const match of source.matchAll(/\brm(?:Sync)?\(\s*((?:\w+\.)*(\w+))\s*,\s*\{/g)) {
    const target = match[1] ?? "";
    const last = match[2] ?? "";
    if (HOME_NAME.test(last) && !found.some((hit) => hit.variable === target)) {
      found.push({ variable: target, reason: "named like a home" });
    }
  }
  return found;
}

/** A local `withTempHome` that removes anything itself is a private copy of the
 *  teardown, whatever it names its directory. */
function findPrivateWithTempHomeTeardown(source: string): boolean {
  const start = source.search(/function withTempHome\b/);
  if (start < 0) {
    return false;
  }
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end < 0 ? undefined : end);
  return /\brm(?:Sync)?\(/.test(body);
}

function testSources(): { file: string; source: string }[] {
  return readdirSync(TEST_DIR)
    .filter((entry) => entry.endsWith(".ts") && !EXEMPT.has(entry))
    .map((file) => ({ file, source: readFileSync(path.join(TEST_DIR, file), "utf8") }));
}

test("no test file hand-rolls a home teardown with rm/rmSync (brick://1d1cd13a)", () => {
  const sources = testSources();

  // Controls first: a scan that read nothing reports the same green as a clean repo.
  assert.ok(sources.length > 100, `expected to read the test dir, got ${String(sources.length)}`);
  const usingShared = sources.filter((entry) => entry.source.includes('"./temp-home.js"'));
  assert.ok(
    usingShared.length > 10,
    `only ${String(usingShared.length)} files import temp-home.js — the migration is not what this scan assumes`,
  );

  const offenders: string[] = [];
  for (const { file, source } of sources) {
    for (const hit of findHandRolledHomeTeardowns(source)) {
      offenders.push(`${file}: \`${hit.variable}\` (${hit.reason}) is removed with rm/rmSync`);
    }
    if (findPrivateWithTempHomeTeardown(source)) {
      offenders.push(`${file}: a local withTempHome removes the directory itself`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Remove a temp HOME with removeTempHome / removeTempHomeSync / withTempHome from ` +
      `./temp-home.js — a bare rm loses the race to a detached child still writing ` +
      `under it (ENOTEMPTY) and leaves it holding the home:\n${offenders.join("\n")}`,
  );
});

test("the scan flags a fresh offending source it has never been told about (negative cases)", () => {
  const pinned = [
    'const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "x-"));',
    "env: { HOME: homeDir };",
    "await fs.rm(homeDir, { recursive: true, force: true });",
  ].join("\n");
  assert.deepEqual(
    findHandRolledHomeTeardowns(pinned).map((hit) => hit.variable),
    ["homeDir"],
  );

  const bySyncPrefix = [
    'const d = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-some-home-"));',
    "rmSync(d, { recursive: true, force: true });",
  ].join("\n");
  assert.deepEqual(
    findHandRolledHomeTeardowns(bySyncPrefix).map((hit) => hit.variable),
    ["d"],
  );

  const stateVar = [
    'const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "y-"));',
    "fs.rmSync(stateHome, { recursive: true, force: true });",
  ].join("\n");
  assert.deepEqual(
    findHandRolledHomeTeardowns(stateVar).map((hit) => hit.variable),
    ["stateHome"],
  );

  assert.deepEqual(
    findHandRolledHomeTeardowns("rmSync(fixture.homeDir, { recursive: true, force: true });").map(
      (hit) => hit.variable,
    ),
    ["fixture.homeDir"],
  );

  assert.equal(
    findPrivateWithTempHomeTeardown(
      [
        "async function withTempHome(run) {",
        '  const dir = await mkdtemp(path.join(os.tmpdir(), "z-"));',
        "  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }",
        "}",
        "",
      ].join("\n"),
    ),
    true,
  );
});

test("the scan does not flag what it must leave alone (positive controls)", () => {
  // A cwd directory is not a home, however it is removed.
  const cwdOnly = [
    'const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-integration-cwd-"));',
    "await fs.rm(cwd, { recursive: true, force: true });",
  ].join("\n");
  assert.deepEqual(findHandRolledHomeTeardowns(cwdOnly), []);

  // A home removed through the shared helper is the goal state.
  const shared = [
    'const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "x-"));',
    "env: { HOME: homeDir };",
    "await removeTempHome(homeDir);",
  ].join("\n");
  assert.deepEqual(findHandRolledHomeTeardowns(shared), []);

  // A thin wrapper over the shared fixture owns no teardown.
  assert.equal(
    findPrivateWithTempHomeTeardown(
      'function withTempHome(run) {\n  return withTempHomeFixture("p-", run);\n}\n',
    ),
    false,
  );
});
