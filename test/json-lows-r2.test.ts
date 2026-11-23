import assert from "node:assert/strict";
import test from "node:test";
import { runCli, tmpDir } from "./pod-a3-helpers.js";

// brick 4a34f245 — json lows round 2, from the json-strict-lows TE: a bare group's "(outputHelp)" message,
// `models` under --json-strict without --format json, and `models show <unknown>` writing a TEXT error under json.
// Real CLI, isolated home, a non-control host.

function host(): { cwd: string; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tmpDir("acpx-jlr2-home-"),
    NV_DEV_SERVER_ROLE: "workbench",
  };
  for (const name of ["ACPX_OWNER_PLACEMENT", "ACPX_POD_TEST_HOME", "ACPX_STATE_HOME"]) {
    delete env[name];
  }
  return { cwd: tmpDir("acpx-jlr2-cwd-"), env };
}

type UsageDocument = {
  jsonrpc: string;
  id: null;
  error: { code: number; message: string; data: { acpxCode: string; origin: string } };
};

const usage = (stdout: string): UsageDocument => JSON.parse(stdout) as UsageDocument;

// ---- (outputHelp) -------------------------------------------------------------------------------------------

for (const [group, sub] of [
  ["seats", "list"],
  ["box", "refresh"],
  ["flow", "run"],
] as const) {
  test(`a bare \`${group}\` under json says what it needs — the group and its subcommands — not "(outputHelp)"; same USAGE document, exit 2`, async () => {
    const { cwd, env } = host();
    for (const argv of [
      ["--format", "json", group],
      ["--format", "json", "--json-strict", group],
    ]) {
      const r = await runCli(argv, env, { cwd });
      assert.equal(r.status, 2, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
      const doc = usage(r.stdout);
      assert.equal(doc.error.code, -32602);
      assert.equal(doc.error.data.acpxCode, "USAGE");
      assert.equal(doc.error.data.origin, "cli");
      assert.doesNotMatch(doc.error.message, /outputHelp/u);
      assert.match(doc.error.message, new RegExp(`'acpx ${group}' needs a subcommand`, "u"));
      assert.match(
        doc.error.message,
        new RegExp(`\\b${sub}\\b`, "u"),
        "it names a real subcommand",
      );
      assert.doesNotMatch(
        doc.error.message,
        /\bhelp\b/u,
        "the implicit `help` command is not offered as a subcommand",
      );
      if (argv.includes("--json-strict")) {
        assert.equal(r.stderr, "", "strict: empty stderr");
      }
    }
  });
}

test("(outputHelp) negatives: text mode still shows the group's help on stderr (exit 1); `<group> --help` is exit 0; a group WITH a valid subcommand runs", async () => {
  const { cwd, env } = host();
  const text = await runCli(["seats"], env, { cwd });
  assert.equal(text.status, 1);
  assert.match(text.stderr, /^Usage: acpx seats /mu);
  assert.equal(text.stdout, "");
  const help = await runCli(["--format", "json", "seats", "--help"], env, { cwd });
  assert.equal(help.status, 0, help.stderr);
  const ok = await runCli(["--format", "json", "--json-strict", "agents", "list"], env, { cwd });
  assert.equal(ok.status, 0, ok.stderr);
});

// ---- models under --json-strict without --format json -----------------------------------------------------------

test("`models` under --json-strict WITHOUT --format json refuses exactly as the other verbs do: the same document, exit 2, empty stderr — for every verb", async () => {
  const { cwd, env } = host();
  const reference = await runCli(["--json-strict", "agents", "list"], env, { cwd });
  assert.equal(reference.status, 2);
  for (const argv of [
    ["--json-strict", "models"],
    ["--json-strict", "models", "list"],
    ["--json-strict", "models", "show", "claude-subscription:opus"],
    ["--json-strict", "models", "fav"],
    ["--json-strict", "models", "last-used"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, reference.status, argv.join(" "));
    assert.equal(r.stderr, "", argv.join(" "));
    assert.equal(
      r.stdout,
      reference.stdout,
      `${argv.join(" ")}: byte-for-byte the other verbs' document`,
    );
    assert.equal(usage(r.stdout).error.message, "--json-strict requires --format json");
  }
});

test("models + --json-strict negatives: any way of asking for json is accepted (global, on the verb, --json), and a non-strict `models` is untouched", async () => {
  const { cwd, env } = host();
  for (const argv of [
    ["--format", "json", "--json-strict", "models", "list"],
    ["--json-strict", "models", "list", "--format", "json"],
    ["--json-strict", "models", "list", "--json"],
    ["--json-strict", "models", "--format", "json", "list"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.stdout.slice(0, 80)}${r.stderr}`);
    assert.equal(r.stderr, "");
    assert.doesNotThrow(() => JSON.parse(r.stdout), argv.join(" "));
  }
  const plain = await runCli(["models", "list"], env, { cwd });
  assert.equal(plain.status, 0, plain.stderr);
  assert.throws(() => JSON.parse(plain.stdout), "no strict: the text table, as before");
  // strict with an explicit TEXT format is a conflict, like everywhere else
  const conflict = await runCli(["--format", "text", "--json-strict", "models", "list"], env, {
    cwd,
  });
  assert.equal(conflict.status, 2);
  assert.equal(usage(conflict.stdout).error.message, "--json-strict requires --format json");
});

// ---- models show <unknown> under json -----------------------------------------------------------------------------

test("`models show <unknown>` under json (strict included) is the JSON USAGE document on stdout, exit 2, nothing on stderr under strict — carrying the did-you-mean text", async () => {
  const { cwd, env } = host();
  for (const argv of [
    ["--format", "json", "--json-strict", "models", "show", "nope/nothing"],
    ["--format", "json", "models", "show", "nope/nothing"],
    ["models", "show", "nope/nothing", "--format", "json"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, 2, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stderr, "", `${argv.join(" ")}: the error is the document, not stderr text`);
    const doc = usage(r.stdout);
    assert.equal(doc.error.code, -32602);
    assert.equal(doc.error.data.acpxCode, "USAGE");
    assert.match(doc.error.message, /no model "nope\/nothing" in this box's catalogue/u);
    assert.match(doc.error.message, /did you mean:/u);
  }
});

test("models show negatives: TEXT mode keeps the message on stderr, stdout empty, exit 2; a known model still shows as JSON", async () => {
  const { cwd, env } = host();
  const text = await runCli(["models", "show", "nope/nothing"], env, { cwd });
  assert.equal(text.status, 2);
  assert.equal(text.stdout, "");
  assert.match(text.stderr, /^\[acpx\] no model "nope\/nothing" in this box's catalogue\./mu);
  const known = await runCli(
    ["--format", "json", "models", "show", "claude-subscription:opus"],
    env,
    { cwd },
  );
  assert.equal(known.status, 0, known.stderr);
  assert.equal((JSON.parse(known.stdout) as { id?: string }).id, "opus");
});
