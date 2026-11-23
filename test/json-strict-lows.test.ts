import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { runCli, tmpDir } from "./pod-a3-helpers.js";

// brick bfbb74e3 — the json-strict lows the WP3 TE found beside F-23: N1 (a strict usage error on a subcommand
// printed nothing at all), N2 (`config show` said loaded.project:true for a project config a control pod ignores),
// N3 (`models list` ignored a CLI-wide `--format json`). Every row drives the real CLI in an isolated home.

function host(options: { control: boolean; projectConfig: boolean }): {
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  const home = tmpDir("acpx-jsl-home-");
  const cwd = tmpDir("acpx-jsl-cwd-");
  if (options.projectConfig) {
    fs.writeFileSync(path.join(cwd, ".acpxrc.json"), "{}\n");
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ...(options.control ? { NV_DEV_SERVER_ROLE: "control" } : { NV_DEV_SERVER_ROLE: "workbench" }),
  };
  for (const name of ["ACPX_OWNER_PLACEMENT", "ACPX_POD_TEST_HOME", "ACPX_STATE_HOME"]) {
    delete env[name];
  }
  return { cwd, env };
}

type UsageDocument = {
  jsonrpc: string;
  id: null;
  error: { code: number; message: string; data: { acpxCode: string; origin: string } };
};

// ---- N1 ---------------------------------------------------------------------------------------------------

for (const [name, argv, message] of [
  ["an unknown option", ["agents", "list", "--bogus"], /unknown option '--bogus'/u],
  ["too many arguments", ["agents", "list", "extra"], /too many arguments for 'list'/u],
  ["an unknown subverb", ["models", "bogusverb"], /too many arguments for 'models'/u],
] as const) {
  test(`N1: under --json-strict ${name} on a subcommand is ONE JSON usage document on stdout (the top level's shape), exit 2, stderr empty`, async () => {
    const { cwd, env } = host({ control: false, projectConfig: false });
    const r = await runCli(["--format", "json", "--json-strict", ...argv], env, { cwd });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.equal(r.stderr, "", "json-strict: empty stderr");
    const doc = JSON.parse(r.stdout) as UsageDocument;
    assert.equal(doc.jsonrpc, "2.0");
    assert.equal(doc.id, null);
    assert.equal(doc.error.code, -32602);
    assert.equal(doc.error.data.acpxCode, "USAGE");
    assert.equal(doc.error.data.origin, "cli");
    assert.match(doc.error.message, message);
  });
}

test("N1: it is the SAME document the top level emits for the same mistake (no new shape) — compared field for field", async () => {
  const { cwd, env } = host({ control: false, projectConfig: false });
  const top = JSON.parse(
    (await runCli(["--format", "json", "--json-strict", "--bogus"], env, { cwd })).stdout,
  ) as UsageDocument;
  const sub = JSON.parse(
    (await runCli(["--format", "json", "--json-strict", "agents", "list", "--bogus"], env, { cwd }))
      .stdout,
  ) as UsageDocument;
  assert.deepEqual(Object.keys(sub), Object.keys(top));
  assert.deepEqual(Object.keys(sub.error), Object.keys(top.error));
  assert.deepEqual(Object.keys(sub.error.data), Object.keys(top.error.data));
  assert.equal(sub.error.code, top.error.code);
});

test("N1 plain json: the same mistake also yields the document (stdout) and exit 2 — json mode no longer swallows it", async () => {
  const { cwd, env } = host({ control: false, projectConfig: false });
  const r = await runCli(["--format", "json", "agents", "list", "--bogus"], env, { cwd });
  assert.equal(r.status, 2, r.stderr);
  assert.equal((JSON.parse(r.stdout) as UsageDocument).error.data.acpxCode, "USAGE");
});

test("N1 negative: text mode is UNTOUCHED (commander's own message on stderr, exit 1, stdout empty) and valid strict commands still run", async () => {
  const { cwd, env } = host({ control: false, projectConfig: false });
  const text = await runCli(["agents", "list", "--bogus"], env, { cwd });
  assert.equal(text.status, 1);
  assert.equal(text.stdout, "");
  assert.match(text.stderr, /error: unknown option '--bogus'/u);
  const ok = await runCli(["--format", "json", "--json-strict", "agents", "list"], env, { cwd });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stderr, "");
  assert.doesNotThrow(() => JSON.parse(ok.stdout));
  // --help is not an error: exit 0
  const help = await runCli(["--format", "json", "agents", "list", "--help"], env, { cwd });
  assert.equal(help.status, 0, help.stderr);
});

// ---- N2 ---------------------------------------------------------------------------------------------------

type ConfigShow = {
  paths: { project: string };
  loaded: { global: boolean; project: boolean };
  ignored?: { project: string };
};

test("N2: a control-role host that IGNORES a project .acpxrc.json says loaded.project:false and ignored.project:'control-pod' — strict and non-strict alike", async () => {
  const { cwd, env } = host({ control: true, projectConfig: true });
  for (const argv of [
    ["--format", "json", "--json-strict", "config", "show"],
    ["--format", "json", "config", "show"],
    ["config", "show"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, 0, r.stderr);
    const shown = JSON.parse(r.stdout) as ConfigShow;
    assert.equal(shown.loaded.project, false, argv.join(" "));
    assert.deepEqual(shown.ignored, { project: "control-pod" }, argv.join(" "));
    assert.equal(shown.paths.project, path.join(cwd, ".acpxrc.json"), "the path is still reported");
  }
});

test("N2 negatives: a host that READS the project config says loaded.project:true with no `ignored`; no file says false with no `ignored`", async () => {
  const reads = host({ control: false, projectConfig: true });
  const read = JSON.parse(
    (await runCli(["--format", "json", "config", "show"], reads.env, { cwd: reads.cwd })).stdout,
  ) as ConfigShow;
  assert.equal(read.loaded.project, true);
  assert.equal("ignored" in read, false);
  const none = host({ control: true, projectConfig: false });
  const absent = JSON.parse(
    (await runCli(["--format", "json", "config", "show"], none.env, { cwd: none.cwd })).stdout,
  ) as ConfigShow;
  assert.equal(absent.loaded.project, false);
  assert.equal("ignored" in absent, false, "nothing was ignored when no file exists");
});

// ---- N3 ---------------------------------------------------------------------------------------------------

test("N3: `--format json` BEFORE the verb (and on the `models` parent) is honoured by models — one JSON document, no text table", async () => {
  const { cwd, env } = host({ control: false, projectConfig: false });
  const own = await runCli(["models", "list", "--format", "json"], env, { cwd });
  assert.equal(own.status, 0, own.stderr);
  for (const argv of [
    ["--format", "json", "models", "list"],
    ["models", "--format", "json", "list"],
    ["--format", "json", "models"],
    ["--format", "json", "--json-strict", "models", "list"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.stderr}`);
    const doc = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(doc),
      Object.keys(JSON.parse(own.stdout) as Record<string, unknown>),
      argv.join(" "),
    );
    if (argv.includes("--json-strict")) {
      assert.equal(r.stderr, "", "strict: empty stderr");
    }
  }
});

test("N3 negatives: with no json flag models still prints its text table; the subcommand's own flag wins; `fav` and `last-used` honour the global flag too", async () => {
  const { cwd, env } = host({ control: false, projectConfig: false });
  const text = await runCli(["models", "list"], env, { cwd });
  assert.equal(text.status, 0, text.stderr);
  assert.throws(() => JSON.parse(text.stdout), "the default is still the text table");
  const own = await runCli(["--format", "json", "models", "list", "--format", "text"], env, {
    cwd,
  });
  assert.throws(
    () => JSON.parse(own.stdout),
    "the verb's own --format text wins over the global json",
  );
  for (const argv of [
    ["--format", "json", "models", "fav"],
    ["--format", "json", "models", "last-used"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.stderr}`);
    assert.doesNotThrow(() => JSON.parse(r.stdout), argv.join(" "));
  }
});
