import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli, tmpDir } from "./pod-a3-helpers.js";

// brick 3bc340d5 — json lows round 4, from the json-lows-r3 TE (acf6a89c) and the archive/restore output TE
// (d2026e20): text-mode `people help [leaf]` (F2), ONE `--format` precedence for every verb family — the verb's own
// word wins (O1, TE-d202-1) — and the strict-help stdout pin (row 3 of json-lows-r3). Real CLI, isolated home.

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const STRICT_REQUIRES = "--json-strict requires --format json";

function host(configFormat?: string): { home: string; cwd: string; env: NodeJS.ProcessEnv } {
  const home = tmpDir("acpx-jlr4-home-");
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
  return { home, cwd: tmpDir("acpx-jlr4-cwd-"), env };
}

type UsageDocument = { error: { code: number; message: string } };
const usageMessage = (stdout: string): string =>
  (JSON.parse(stdout) as UsageDocument).error.message;
const isJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};
/** `--format json`'s compact one-line document — `config show`'s TEXT view is pretty-printed JSON, so "parses" is not enough. */
const isCompactJson = (text: string): boolean => isJson(text) && !text.trimEnd().includes("\n");

// ---- F2: text-mode `people help [leaf]` --------------------------------------------------------------------------

test('F2: TEXT-mode `people help` and `people help <leaf>` are help the caller asked for — the help text, exit 0, no "(outputHelp)" (same as every other group)', async () => {
  const { cwd, env } = host();
  for (const [argv, usageLine] of [
    [["people", "help"], /^Usage: acpx people \[options\] \[command\]/mu],
    [["people", "help", "list"], /^Usage: acpx people list /mu],
    [["people", "help", "resolve"], /^Usage: acpx people resolve /mu],
    [["people", "help", "set-owner"], /^Usage: acpx people set-owner /mu],
    [["people", "help", "principal"], /^Usage: acpx people principal /mu],
  ] as const) {
    const r = await runCli([...argv], env, { cwd });
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, usageLine, argv.join(" "));
    assert.equal(r.stderr, "", argv.join(" "));
    assert.doesNotMatch(r.stdout + r.stderr, /outputHelp/u, argv.join(" "));
  }
  // the same help the explicit --help form gives, byte for byte
  const viaHelp = await runCli(["people", "help", "list"], env, { cwd });
  const viaFlag = await runCli(["people", "list", "--help"], env, { cwd });
  assert.equal(viaHelp.stdout, viaFlag.stdout);
});

test("F2 negatives: a BARE `people` and `people <bogus>` stay people's own usage error in text mode (exit 2, usage on stderr), and `capacity`'s usage errors are untouched", async () => {
  const { cwd, env } = host();
  const bare = await runCli(["people"], env, { cwd });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /^Usage: acpx people /mu);
  const bogus = await runCli(["people", "list", "extra-operand"], env, { cwd });
  assert.equal(bogus.status, 2, `${bogus.stdout}${bogus.stderr}`);
  assert.match(bogus.stderr, /too many arguments/u);
  const missing = await runCli(["people", "resolve"], env, { cwd });
  assert.equal(missing.status, 2, `${missing.stdout}${missing.stderr}`);
  assert.match(missing.stderr, /missing required argument/u);
});

// ---- O1: one precedence — the verb's own `--format` wins ---------------------------------------------------------

// One row per VERB FAMILY, i.e. per source file that registers a `--format` / `--json` option; the discovery test
// below fails on a file that is not listed. `read` rows can be run for real in an isolated home and answer a document
// (json) or the text view; `refusal` rows are not safe or not useful to run, so only the refusal is asserted.
type Family = {
  file: string;
  verb: string[];
  /** `read`: runs for real, prints one JSON document or text; `act`: runs but answers an error/usage document */
  kind: "read" | "act";
};
const FAMILIES: Family[] = [
  { file: "agent-folders-command.ts", verb: ["agent-folders", "migrate"], kind: "act" },
  { file: "agents-command.ts", verb: ["agents", "list"], kind: "read" },
  { file: "capacity-command.ts", verb: ["capacity"], kind: "read" },
  { file: "command-registration.ts", verb: ["sessions", "set-parent", "--dry-run"], kind: "act" },
  { file: "config-command.ts", verb: ["config", "show"], kind: "read" },
  { file: "governor-command.ts", verb: ["governor", "status"], kind: "read" },
  { file: "models-command.ts", verb: ["models", "list"], kind: "read" },
  { file: "profiles-command.ts", verb: ["profiles", "list"], kind: "read" },
  { file: "providers-command.ts", verb: ["providers", "list"], kind: "read" },
  { file: "seats-command.ts", verb: ["seats", "list"], kind: "read" },
  { file: "subscriptions-command.ts", verb: ["subscriptions", "list"], kind: "read" },
  { file: "transcripts-command.ts", verb: ["transcripts", "dedup"], kind: "read" },
  // box-command.ts is a family too, but `box refresh` RUNS the box's refresh script: it is discovered (the
  // coverage test below) and proven only through the precedence unit row, never executed here.
  { file: "box-command.ts", verb: ["box", "refresh"], kind: "act" },
];
const EXECUTED = FAMILIES.filter((family) => family.file !== "box-command.ts");

for (const family of EXECUTED) {
  test(`O1 [${family.file}]: \`${family.verb.join(" ")}\` — the verb's own --format beats the program's: strict + leaf text is the refusal, strict + leaf json is accepted`, async () => {
    const { cwd, env } = host();
    // program json (strict), verb text: the VERB's word wins → text → strict refuses
    const refused = await runCli(
      ["--format", "json", "--json-strict", ...family.verb, "--format", "text"],
      env,
      { cwd },
    );
    assert.equal(refused.status, 2, `${refused.stdout}${refused.stderr}`);
    assert.equal(usageMessage(refused.stdout), STRICT_REQUIRES);
    assert.equal(refused.stderr, "");
    // program text, verb json (strict): the VERB's word wins → json → accepted (not the refusal), one document
    const accepted = await runCli(
      ["--format", "text", "--json-strict", ...family.verb, "--format", "json"],
      env,
      { cwd },
    );
    assert.ok(
      isJson(accepted.stdout),
      `not one JSON document: ${accepted.stdout}${accepted.stderr}`,
    );
    assert.doesNotMatch(accepted.stdout, /requires --format json/u);
    if (family.kind === "read") {
      assert.equal(accepted.status, 0, `${accepted.stdout}${accepted.stderr}`);
      assert.equal(accepted.stderr, "");
    }
  });

  if (family.kind === "read") {
    test(`O1 [${family.file}] non-strict: \`${family.verb.join(" ")}\` — program text + verb json prints JSON; program json + verb text prints the text view`, async () => {
      const { cwd, env } = host();
      const json = await runCli(["--format", "text", ...family.verb, "--format", "json"], env, {
        cwd,
      });
      assert.equal(json.status, 0, `${json.stdout}${json.stderr}`);
      assert.ok(isCompactJson(json.stdout), json.stdout);
      const text = await runCli(["--format", "json", ...family.verb, "--format", "text"], env, {
        cwd,
      });
      assert.equal(text.status, 0, `${text.stdout}${text.stderr}`);
      assert.ok(
        !isCompactJson(text.stdout),
        `the verb said text but got a document: ${text.stdout}`,
      );
    });
  }
}

test("O1 negatives: with NO verb-level word the program's (or config's) format still applies — nothing became sticky to the leaf", async () => {
  for (const verb of [
    ["profiles", "list"],
    ["providers", "list"],
    ["governor", "status"],
    ["models", "list"],
  ]) {
    const { cwd, env } = host();
    const json = await runCli(["--format", "json", ...verb], env, { cwd });
    assert.ok(isJson(json.stdout), `${verb.join(" ")}: ${json.stdout}`);
    const strictNoJson = await runCli(["--json-strict", ...verb], env, { cwd });
    assert.equal(strictNoJson.status, 2, verb.join(" "));
    assert.equal(usageMessage(strictNoJson.stdout), STRICT_REQUIRES);
  }
});

test("O1 + config: the verb's own word beats the config file's `format` both ways, on a verb that always let the program win", async () => {
  const asText = host("json");
  const text = await runCli(["profiles", "list", "--format", "text"], asText.env, {
    cwd: asText.cwd,
  });
  assert.ok(!isJson(text.stdout), `config json + verb text must print text: ${text.stdout}`);
  const asJson = host("text");
  const json = await runCli(["providers", "list", "--format", "json"], asJson.env, {
    cwd: asJson.cwd,
  });
  assert.ok(isJson(json.stdout), `config text + verb json must print json: ${json.stdout}`);
  // no word anywhere but the config: the config applies
  const cfg = host("json");
  const viaConfig = await runCli(["governor", "status"], cfg.env, { cwd: cfg.cwd });
  assert.ok(isJson(viaConfig.stdout), viaConfig.stdout);
});

test("O1: a verb-level `--json` counts for `--json-strict` on EVERY verb that has one (models always did; agents, archive and restore refused it)", async () => {
  const { home, cwd, env } = host();
  fs.mkdirSync(path.join(home, ".acpx", "sessions"), { recursive: true });
  for (const argv of [
    ["--json-strict", "agents", "list", "--json"],
    ["--json-strict", "agents", "show", "claude", "--json"],
    ["--json-strict", "models", "list", "--json"],
    ["--json-strict", "sessions", "archive", "--dry-run", "--json"],
    ["--json-strict", "sessions", "restore", "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", "--json"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.ok(isJson(r.stdout), `${argv.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /requires --format json/u, argv.join(" "));
    assert.equal(r.stderr, "", argv.join(" "));
  }
  // ... and `agents list --json` is the same document with or without strict
  const plain = await runCli(["agents", "list", "--json"], env, { cwd });
  const strict = await runCli(["--json-strict", "agents", "list", "--json"], env, { cwd });
  assert.equal(strict.status, 0);
  assert.equal(strict.stdout, plain.stdout);
});

test("O1 negatives: strict still needs a json request somewhere, and `--verbose` is still refused beside it", async () => {
  const { cwd, env } = host();
  for (const argv of [
    ["--json-strict", "agents", "list"],
    ["--json-strict", "sessions", "archive", "--dry-run"],
    ["--json-strict", "models", "list"],
  ]) {
    const r = await runCli(argv, env, { cwd });
    assert.equal(r.status, 2, argv.join(" "));
    assert.equal(usageMessage(r.stdout), STRICT_REQUIRES, argv.join(" "));
  }
  const verbose = await runCli(["--json-strict", "--verbose", "agents", "list", "--json"], env, {
    cwd,
  });
  assert.equal(verbose.status, 2);
  assert.equal(usageMessage(verbose.stdout), "--json-strict cannot be combined with --verbose");
});

test("O1: a verb with no `--format` of its own (`people`, `sessions list`) takes the program's — and says so for a leaf word it does not have", async () => {
  const { cwd, env } = host();
  const json = await runCli(["--format", "json", "people", "list"], env, { cwd });
  assert.ok(isJson(json.stdout), json.stdout);
  const text = await runCli(["--format", "text", "people", "list"], env, { cwd });
  assert.ok(!isJson(text.stdout), text.stdout);
  const leaf = await runCli(
    ["--format", "json", "--json-strict", "people", "list", "--format", "text"],
    env,
    {
      cwd,
    },
  );
  assert.equal(leaf.status, 2);
  assert.match(usageMessage(leaf.stdout), /unknown option '--format'/u);
});

// ---- O1 coverage: every family is listed, and the format is read in ONE place --------------------------------------

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

/** The files under `dir` that register a verb-level `--format` or `--json` option — found by SCANNING, never listed. */
function filesRegisteringFormatOptions(dir: string): string[] {
  return sourceFiles(dir)
    .filter((file) => /\.option\(\s*"--(?:format|json)\b/u.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.basename(file))
    .toSorted();
}

/** The files under `dir` that read the output format off a commander options object — only flags.ts may. */
function filesReadingFormatOption(dir: string): string[] {
  return sourceFiles(dir)
    .filter((file) => path.basename(file) !== "flags.ts")
    .filter((file) =>
      /(?:\bopts(?:WithGlobals)?\s*(?:<[^>]*>)?\s*\(\)|\bopts)\s*\.\s*format\b|\.opts<\{\s*format/u.test(
        fs.readFileSync(file, "utf8"),
      ),
    )
    .map((file) => path.basename(file))
    .toSorted();
}

test("O1 coverage: every source file that registers a --format/--json option has a family row above (discovered by scanning)", () => {
  const discovered = filesRegisteringFormatOptions(path.join(SRC_DIR, "cli")).filter(
    (name) => name !== "flags.ts",
  );
  assert.deepEqual(
    discovered,
    FAMILIES.map((family) => family.file).toSorted(),
    "a registration file with no row (or a row for a file that no longer registers one)",
  );
  // the scan itself can fail: a fresh file with a verb-level --format is found without being registered anywhere
  const fresh = tmpDir("acpx-jlr4-scan-");
  fs.writeFileSync(
    path.join(fresh, "fresh-command.ts"),
    'export const x = c.option("--format <fmt>", "Output format");\n',
  );
  fs.writeFileSync(path.join(fresh, "other.ts"), "export const y = 1;\n");
  assert.deepEqual(filesRegisteringFormatOptions(fresh), ["fresh-command.ts"]);
});

test("O1 coverage: no source file outside flags.ts reads the format off an options object — a second reader is a second precedence", () => {
  assert.deepEqual(filesReadingFormatOption(SRC_DIR), []);
  // the scan can fail: planted readers are flagged
  const fresh = tmpDir("acpx-jlr4-scan-");
  fs.writeFileSync(path.join(fresh, "a.ts"), "const f = command.optsWithGlobals().format;\n");
  fs.writeFileSync(path.join(fresh, "b.ts"), "const f = opts.format;\n");
  fs.writeFileSync(path.join(fresh, "c.ts"), "const f = ancestor.opts<{ format?: string }>();\n");
  fs.writeFileSync(path.join(fresh, "d.ts"), "const f = flags.format;\n");
  assert.deepEqual(filesReadingFormatOption(fresh), ["a.ts", "b.ts", "c.ts"]);
});
