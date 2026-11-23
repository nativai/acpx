import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runCli, tmpDir } from "./pod-a3-helpers.js";

// brick acf6a89c — json lows round 3, from the json-lows-r2 TE: `people` "(outputHelp)" (C1-a), the explicit
// `<group> help [leaf]` wording (C1-b), and the models strict edges: config-file format json (C2-a), a leaf
// `--format text` under an ancestor json (C2-b), `--verbose` (C2-c), the text success line of `fav add` /
// `last-used set` (C2-d). Real CLI, isolated home, a non-control host.

function host(configFormat?: string): { home: string; cwd: string; env: NodeJS.ProcessEnv } {
  const home = tmpDir("acpx-jlr3-home-");
  if (configFormat !== undefined) {
    fs.mkdirSync(path.join(home, ".acpx"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".acpx", "config.json"),
      JSON.stringify({ format: configFormat }),
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NV_DEV_SERVER_ROLE: "workbench" };
  for (const name of ["ACPX_OWNER_PLACEMENT", "ACPX_POD_TEST_HOME", "ACPX_STATE_HOME"]) {
    delete env[name];
  }
  return { home, cwd: tmpDir("acpx-jlr3-cwd-"), env };
}

type UsageDocument = {
  error: { code: number; message: string; data: { acpxCode: string; origin: string } };
};
const usage = (stdout: string): UsageDocument => JSON.parse(stdout) as UsageDocument;
const STRICT_REQUIRES = "--json-strict requires --format json";
const KEY = "claude-subscription:opus";

// ---- C1-a: people ---------------------------------------------------------------------------------------------

test('C1-a: a bare `people` under json (strict and plain) says what it needs — the group and its subcommands — not "(outputHelp)"', async () => {
  const { cwd, env } = host();
  for (const argv of [
    ["--format", "json", "people"],
    ["--format", "json", "--json-strict", "people"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, 2, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    const doc = usage(r.stdout);
    assert.equal(doc.error.code, -32602);
    assert.equal(doc.error.data.acpxCode, "USAGE");
    assert.doesNotMatch(doc.error.message, /outputHelp/u);
    assert.match(
      doc.error.message,
      /'acpx people' needs a subcommand \(one of: list, resolve, set-owner, principal\)/u,
    );
    if (argv.includes("--json-strict")) {
      assert.equal(r.stderr, "");
    }
  }
});

test("C1-a negatives: `people list` still runs under strict; text mode shows the help on stderr (exit 2, `people`'s own §4.1 rule)", async () => {
  const { cwd, env } = host();
  const ok = await runCli(["--format", "json", "--json-strict", "people", "list"], env, { cwd });
  assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
  const text = await runCli(["people"], env, { cwd });
  // `people` rethrows its own usage errors (people-command.ts §4.1), so its text-mode exit has always been 2
  assert.equal(text.status, 2);
  assert.match(text.stderr, /^Usage: acpx people /mu);
});

// ---- C1-b: `<group> help [leaf]` ------------------------------------------------------------------------------------

test("C1-b: `<group> help [leaf]` is HELP the caller asked for — exit 0 and the leaf's or group's help text, never \"<leaf> needs a subcommand\" (same as `--help`)", async () => {
  const { cwd, env } = host();
  for (const [argv, usageLine] of [
    [["seats", "help", "reconcile-archive"], /^Usage: acpx seats reconcile-archive /mu],
    [["seats", "help"], /^Usage: acpx seats \[options\] \[command\]/mu],
    [["people", "help"], /^Usage: acpx people \[options\] \[command\]/mu],
  ] as const) {
    const r = await runCli(["--format", "json", ...argv], env, { cwd });
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, usageLine, argv.join(" "));
    assert.doesNotMatch(r.stdout + r.stderr, /needs a subcommand|outputHelp/u, argv.join(" "));
  }
  // the same help the explicit --help form gives
  const viaHelp = await runCli(["--format", "json", "seats", "help", "reconcile-archive"], env, {
    cwd,
  });
  const viaFlag = await runCli(["--format", "json", "seats", "reconcile-archive", "--help"], env, {
    cwd,
  });
  assert.equal(viaHelp.stdout, viaFlag.stdout);
  // strict is silent for help exactly as `--help` is: exit 0, nothing printed
  const strict = await runCli(
    ["--format", "json", "--json-strict", "seats", "help", "reconcile-archive"],
    env,
    { cwd },
  );
  assert.equal(strict.status, 0);
  assert.equal(strict.stderr, "");
  // ... and prints NOTHING to stdout either (brick 3bc340d5: the pin the r3 TE found missing) — the same silence as
  // `--help` under strict, for the leaf form AND the group form. The plain-json twin prints the help on stdout, so
  // the empty strict stdout is a property of strict, not of a verb that prints no help at all.
  assert.equal(strict.stdout, "");
  assert.notEqual(viaHelp.stdout, "");
  for (const argv of [
    ["seats", "help"],
    ["seats", "reconcile-archive", "--help"],
    ["people", "help", "list"],
  ]) {
    const silent = await runCli(["--format", "json", "--json-strict", ...argv], env, { cwd });
    assert.equal(silent.status, 0, argv.join(" "));
    assert.equal(silent.stdout, "", argv.join(" "));
    assert.equal(silent.stderr, "", argv.join(" "));
  }
});

test("C1-b negative: a bare group is STILL the 'needs a subcommand' error (exit 2), and `help <unknown>` names the group", async () => {
  const { cwd, env } = host();
  const bare = await runCli(["--format", "json", "--json-strict", "seats"], env, { cwd });
  assert.equal(bare.status, 2);
  assert.match(usage(bare.stdout).error.message, /'acpx seats' needs a subcommand/u);
  const unknown = await runCli(
    ["--format", "json", "--json-strict", "seats", "help", "nope"],
    env,
    { cwd },
  );
  assert.equal(unknown.status, 2);
  assert.match(usage(unknown.stdout).error.message, /'acpx seats' needs a subcommand/u);
});

// ---- C2-a: config-file format json ------------------------------------------------------------------------------------

test("C2-a: a config-file `format: json` counts for models — strict `models list` is JSON, and `models show <unknown>` is the USAGE document with empty stderr", async () => {
  const { cwd, env } = host("json");
  const list = await runCli(["--json-strict", "models", "list"], env, { cwd });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stderr, "");
  assert.doesNotThrow(() => JSON.parse(list.stdout), "JSON, not the text table");
  for (const argv of [
    ["--json-strict", "models", "show", "nope/nothing"],
    ["models", "show", "nope/nothing"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, 2, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stderr, "", `${argv.join(" ")}: the error is the document`);
    assert.match(
      usage(r.stdout).error.message,
      /no model "nope\/nothing" in this box's catalogue/u,
    );
  }
});

test("C2-a negatives: a config of `text` (or none) changes nothing — the text table, and strict still refuses; a leaf `--format text` beats the config json", async () => {
  for (const configFormat of [undefined, "text"]) {
    const { cwd, env } = host(configFormat);
    const plain = await runCli(["models", "list"], env, { cwd });
    assert.throws(() => JSON.parse(plain.stdout), `config ${String(configFormat)}: text table`);
    const strict = await runCli(["--json-strict", "models", "list"], env, { cwd });
    assert.equal(strict.status, 2);
    assert.equal(usage(strict.stdout).error.message, STRICT_REQUIRES);
  }
  const { cwd, env } = host("json");
  const leafText = await runCli(["models", "list", "--format", "text"], env, { cwd });
  assert.throws(
    () => JSON.parse(leafText.stdout),
    "the verb's own text wins over the config's json",
  );
});

// ---- C2-b: a leaf --format text under an ancestor json, strict -------------------------------------------------------------

test("C2-b: `--format json --json-strict models list --format text` is the SAME conflict refusal as everywhere (exit 2, the other verbs' document), not a text table", async () => {
  const { cwd, env } = host();
  const reference = await runCli(["--json-strict", "agents", "list"], env, { cwd });
  for (const argv of [
    ["--format", "json", "--json-strict", "models", "list", "--format", "text"],
    ["--format", "json", "--json-strict", "models", "--format", "text", "list"],
    ["--format", "json", "--json-strict", "models", "show", KEY, "--format", "text"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, 2, argv.join(" "));
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, reference.stdout, `${argv.join(" ")}: the other verbs' document`);
  }
});

test("C2-b negatives: non-strict leaf text under an ancestor json still prints the table; strict + leaf json is fine", async () => {
  const { cwd, env } = host();
  const table = await runCli(["--format", "json", "models", "list", "--format", "text"], env, {
    cwd,
  });
  assert.equal(table.status, 0, table.stderr);
  assert.throws(() => JSON.parse(table.stdout));
  const ok = await runCli(
    ["--format", "json", "--json-strict", "models", "list", "--format", "json"],
    env,
    { cwd },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.doesNotThrow(() => JSON.parse(ok.stdout));
});

// ---- C2-c: --verbose -----------------------------------------------------------------------------------------------------

test("C2-c: `--json-strict --verbose` is refused by every models verb exactly as by the other verbs (the same document, exit 2)", async () => {
  const { cwd, env } = host();
  const reference = await runCli(
    ["--format", "json", "--json-strict", "--verbose", "agents", "list"],
    env,
    { cwd },
  );
  assert.equal(reference.status, 2);
  assert.equal(
    usage(reference.stdout).error.message,
    "--json-strict cannot be combined with --verbose",
  );
  for (const argv of [
    ["--format", "json", "--json-strict", "--verbose", "models", "list"],
    ["--format", "json", "--json-strict", "--verbose", "models"],
    ["--format", "json", "--json-strict", "--verbose", "models", "fav"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, 2, argv.join(" "));
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, reference.stdout, argv.join(" "));
  }
});

test("C2-c negatives: `--verbose` without strict is accepted; strict without --verbose is accepted", async () => {
  const { cwd, env } = host();
  const verbose = await runCli(["--format", "json", "--verbose", "models", "fav"], env, { cwd });
  assert.equal(verbose.status, 0, verbose.stderr);
  const strict = await runCli(["--format", "json", "--json-strict", "models", "fav"], env, { cwd });
  assert.equal(strict.status, 0, strict.stderr);
});

// ---- C2-d: success documents ------------------------------------------------------------------------------------------------

test("C2-d: under json (strict included) `fav add`, `fav rm` and `last-used set` print ONE JSON document on success — stdout parses, stderr empty", async () => {
  const { cwd, env } = host();
  for (const strict of [true, false]) {
    const base = strict ? ["--format", "json", "--json-strict"] : ["--format", "json"];
    const add = await runCli([...base, "models", "fav", "add", KEY], env, { cwd });
    assert.equal(add.status, 0, add.stderr);
    assert.deepEqual(JSON.parse(add.stdout), {
      action: "fav-add",
      key: KEY,
      favorited: true,
      favorites: 1,
    });
    if (strict) {
      assert.equal(add.stderr, "");
    }
    const rm = await runCli([...base, "models", "fav", "rm", KEY], env, { cwd });
    assert.deepEqual(JSON.parse(rm.stdout), {
      action: "fav-rm",
      key: KEY,
      favorited: false,
      favorites: 0,
    });
    const set = await runCli([...base, "models", "last-used", "set", "claude", KEY], env, { cwd });
    assert.equal(set.status, 0, set.stderr);
    assert.deepEqual(JSON.parse(set.stdout), {
      action: "last-used-set",
      agentType: "claude",
      modelKey: KEY,
    });
  }
});

test("C2-d negatives: TEXT mode keeps its one-line success message; the aliases (`star`, `unstar`) follow the same rule", async () => {
  const { cwd, env } = host();
  const star = await runCli(["models", "fav", "star", KEY], env, { cwd });
  assert.match(star.stdout, /^ {2}★ starred claude-subscription:opus — 1 favorites on /u);
  const set = await runCli(["models", "last-used", "set", "claude", KEY], env, { cwd });
  assert.match(set.stdout, /^ {2}last-used for claude is now claude-subscription:opus on /u);
  const unstar = await runCli(
    ["--format", "json", "--json-strict", "models", "fav", "unstar", KEY],
    env,
    { cwd },
  );
  assert.deepEqual(JSON.parse(unstar.stdout), {
    action: "fav-rm",
    key: KEY,
    favorited: false,
    favorites: 0,
  });
});
