import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Command } from "commander";
import { registerDefaultCommands } from "../src/cli/command-registration.js";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";
import { runCli, tmpDir, type ChildRun } from "./pod-a3-helpers.js";

// brick ec04ee32 — MEDIUM-1 of the json-lows r4 TE: the ERROR document ignored a verb-level `--json`, so
// `agents show bogus --json` exited 2 with an EMPTY stdout and the text on stderr, and `agents list --json --bogus`
// exited 1 in text — while their `--format json` twins answered a JSON document, exit 2. Real CLI, isolated home.
// Every verb that declares `--json` is DISCOVERED from the live command tree (never listed), then each is held to
// its twin: the same call with `--format json` before the verb.

function fakeConfig(): ResolvedAcpxConfig {
  return { format: "text", agents: {}, mcpServers: [] } as unknown as ResolvedAcpxConfig;
}

/** Every command path (space-joined) under `program` that declares a `--json` option of its own. */
function declaringJson(program: Command): string[] {
  const found: string[] = [];
  const visit = (command: Command, trail: string[]): void => {
    for (const child of command.commands) {
      const here = [...trail, child.name()];
      if (child.options.some((option) => option.long === "--json")) {
        found.push(here.join(" "));
      }
      visit(child, here);
    }
  };
  visit(program, []);
  return found.toSorted();
}

function liveVerbs(): string[] {
  const program = new Command();
  registerDefaultCommands(program, fakeConfig());
  return declaringJson(program);
}

function host(configFormat?: string): { cwd: string; env: NodeJS.ProcessEnv } {
  const home = tmpDir("acpx-errdoc-home-");
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
  return { cwd: tmpDir("acpx-errdoc-cwd-"), env };
}

type ErrorDocument = {
  jsonrpc: string;
  error: { code: number; message: string; data?: { acpxCode?: string } };
};
function errorDocument(run: ChildRun, label: string): ErrorDocument {
  assert.ok(run.stdout.length > 0, `${label}: EMPTY stdout (stderr: ${run.stderr})`);
  let parsed: ErrorDocument;
  try {
    parsed = JSON.parse(run.stdout) as ErrorDocument;
  } catch {
    assert.fail(`${label}: stdout is not one JSON document: ${run.stdout}`);
  }
  assert.equal(parsed.jsonrpc, "2.0", label);
  assert.equal(typeof parsed.error.message, "string", label);
  return parsed;
}

/** `argv` (a `--json` call) must answer exactly what its `--format json` twin answers: same rc, document, stderr. */
async function assertTwin(
  argv: string[],
  twin: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ChildRun> {
  const label = argv.join(" ");
  const run = await runCli(argv, env, { cwd });
  const expected = await runCli(twin, env, { cwd });
  errorDocument(expected, `twin of ${label}`);
  assert.equal(run.status, expected.status, `${label}: rc (stderr: ${run.stderr})`);
  assert.equal(run.stdout, expected.stdout, `${label}: stdout`);
  assert.equal(run.stderr, expected.stderr, `${label}: stderr is not what the JSON path prints`);
  errorDocument(run, label);
  return run;
}

// ---- discovery: the rows below cover every verb that declares --json -----------------------------------------------

const EXPECTED_VERBS = [
  "agents",
  "agents list",
  "agents show",
  "models",
  "models endpoints",
  "models fav",
  "models last-used",
  "models list",
  "models show",
  "sessions archive",
  "sessions restore",
];

test("errdoc coverage: the verbs that declare `--json` are DISCOVERED from the command tree, and each has rows below", () => {
  assert.deepEqual(
    liveVerbs(),
    EXPECTED_VERBS,
    "a verb gained or lost a `--json` option: give it rows (and list it here)",
  );
  // the discovery itself can fail: a fresh command with `--json`, registered nowhere, is found
  const fresh = new Command("acpx");
  fresh.command("brand-new").command("leaf").option("--json");
  fresh.command("plain").option("--format <fmt>");
  assert.deepEqual(declaringJson(fresh), ["brand-new leaf"]);
});

// ---- the two examples from the brick, then one row per discovered verb ----------------------------------------------

test("MEDIUM-1 example 1: `agents show bogus --json` is a JSON error document on stdout, rc 2 — not empty stdout + text on stderr", async () => {
  const { cwd, env } = host();
  const run = await assertTwin(
    ["agents", "show", "bogus", "--json"],
    ["--format", "json", "agents", "show", "bogus"],
    env,
    cwd,
  );
  assert.equal(run.status, 2);
  assert.match(
    errorDocument(run, "agents show bogus --json").error.message,
    /Unknown agent "bogus"/u,
  );
  assert.equal(run.stderr, "", "a handler error: nothing on stderr on the JSON path");
});

test("MEDIUM-1 example 2: `agents list --json --bogus` is a JSON usage document, rc 2 — not rc 1 in text", async () => {
  const { cwd, env } = host();
  const run = await assertTwin(
    ["agents", "list", "--json", "--bogus"],
    ["--format", "json", "agents", "list", "--bogus"],
    env,
    cwd,
  );
  assert.equal(run.status, 2);
  assert.equal(errorDocument(run, "agents list --json --bogus").error.data?.acpxCode, "USAGE");
});

for (const verb of EXPECTED_VERBS) {
  const words = verb.split(" ");
  test(`MEDIUM-1 row [${verb}]: an unknown option beside \`--json\` (either order) is the JSON usage document of its \`--format json\` twin`, async () => {
    const { cwd, env } = host();
    const twin = ["--format", "json", ...words, "--no-such-flag"];
    const before = await assertTwin([...words, "--json", "--no-such-flag"], twin, env, cwd);
    assert.equal(before.status, 2, verb);
    assert.match(errorDocument(before, verb).error.message, /unknown option '--no-such-flag'/u);
    await assertTwin([...words, "--no-such-flag", "--json"], twin, env, cwd);
  });
}

test("MEDIUM-1 rows: a missing target and a bad target beside `--json` answer the JSON document of the `--format json` twin", async () => {
  const { cwd, env } = host();
  for (const [argv, twin] of [
    // missing required argument (commander)
    [
      ["agents", "show", "--json"],
      ["--format", "json", "agents", "show"],
    ],
    [
      ["sessions", "restore", "--json"],
      ["--format", "json", "sessions", "restore"],
    ],
    // too many arguments (commander)
    [
      ["agents", "list", "extra", "--json"],
      ["--format", "json", "agents", "list", "extra"],
    ],
    // a bad target the handler refuses
    [
      ["agents", "show", "bogus", "--json"],
      ["--format", "json", "agents", "show", "bogus"],
    ],
    // a bad option VALUE (commander argParser), `--json` after it
    [
      ["agents", "list", "--format", "bogus-format", "--json"],
      ["--format", "json", "agents", "list", "--format", "bogus-format"],
    ],
  ] as const) {
    await assertTwin([...argv], [...twin], env, cwd);
  }
});

test("MEDIUM-1: precedence on the error path is the verb's — `--json` beats a `--format` beside it, the nearest word beats the program's, the config applies last", async () => {
  const { cwd, env } = host();
  // same command: `--json` is `--format json` and wins over `--format text` beside it, in either order
  for (const argv of [
    ["agents", "show", "bogus", "--json", "--format", "text"],
    ["agents", "show", "bogus", "--format", "text", "--json"],
    // the program says text, the verb says --json: the nearest word wins
    ["--format", "text", "agents", "show", "bogus", "--json"],
    ["--format=quiet", "agents", "show", "bogus", "--json"],
  ]) {
    const run = await runCli(argv, env, { cwd });
    assert.equal(run.status, 2, argv.join(" "));
    assert.equal(run.stderr, "", argv.join(" "));
    errorDocument(run, argv.join(" "));
  }
  // a value-taking program flag's value is not mistaken for the command: `--cwd` then the verb
  const withCwd = await runCli(["--cwd", cwd, "agents", "show", "bogus", "--json"], env, { cwd });
  errorDocument(withCwd, "--cwd <dir> agents show bogus --json");
  // config json and nothing said: the config applies (green on base too)
  const configured = host("json");
  const viaConfig = await runCli(["agents", "show", "bogus"], configured.env, {
    cwd: configured.cwd,
  });
  errorDocument(viaConfig, "config json");
});

// ---- negatives: text stays text, strict is unchanged ----------------------------------------------------------------

test("MEDIUM-1 negatives: a verb that says `--format text` (or says nothing) still fails in TEXT — empty stdout, the message on stderr", async () => {
  const { cwd, env } = host();
  for (const argv of [
    ["agents", "show", "bogus", "--format", "text"],
    ["agents", "show", "bogus"],
    // the verb's own word beats the program's json
    ["--format", "json", "agents", "show", "bogus", "--format", "text"],
    ["--format", "json", "agents", "show", "bogus", "--format", "quiet"],
  ]) {
    const run = await runCli(argv, env, { cwd });
    const label = argv.join(" ");
    assert.equal(run.status, 2, label);
    assert.equal(run.stdout, "", label);
    assert.match(run.stderr, /Unknown agent "bogus"/u, label);
  }
  const unknown = await runCli(["agents", "list", "--bogus", "--format", "text"], env, { cwd });
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /unknown option '--bogus'/u);
  // config text + nothing said: text
  const asText = host("text");
  const viaConfig = await runCli(["agents", "show", "bogus"], asText.env, { cwd: asText.cwd });
  assert.equal(viaConfig.stdout, "");
  assert.match(viaConfig.stderr, /Unknown agent/u);
});

test("MEDIUM-1 negatives: `--json-strict` is unchanged — still the JSON document (rc 2, clean stderr) with or without a verb-level `--json`", async () => {
  const { cwd, env } = host();
  const withJson = await runCli(["--json-strict", "agents", "show", "bogus", "--json"], env, {
    cwd,
  });
  assert.equal(withJson.status, 2);
  assert.equal(withJson.stderr, "");
  assert.match(errorDocument(withJson, "strict + --json").error.message, /Unknown agent "bogus"/u);
  const withFormat = await runCli(
    ["--json-strict", "--format", "json", "agents", "show", "bogus"],
    env,
    { cwd },
  );
  assert.equal(withFormat.stdout, withJson.stdout);
  assert.equal(withFormat.stderr, "");
  // strict with no json request anywhere is still the refusal
  const refused = await runCli(["--json-strict", "agents", "show", "bogus"], env, { cwd });
  assert.equal(refused.status, 2);
  assert.match(errorDocument(refused, "strict, no json").error.message, /requires --format json/u);
});

test("MEDIUM-1: a SUCCESSFUL `--json` call is unchanged — one document, rc 0, nothing on stderr", async () => {
  const { cwd, env } = host();
  const run = await runCli(["agents", "list", "--json"], env, { cwd });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  assert.doesNotThrow(() => JSON.parse(run.stdout));
});
