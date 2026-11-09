import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import {
  advertisementDescribesNextModel,
  recordOnlyConfigOptionVerdict,
  recordOnlyModelVerdict,
} from "../src/session/record-only-set.js";
import type { SessionAcpxState, SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// brick 5c44d8ba — an ownerless `acpx <agent> set …` records what the record can vouch for and
// starts nothing; everything else goes live through the gate (DESIGN §6, §7 N1–N4; N5 retired with the late-owner hand-over, brick 1281e50e). The gate rows
// (N6) live in test/capacity-wake.test.ts beside A1's full-box fixture; N7 extends
// test/set-recycle-owner-regression.test.ts.
//
// ⚠️ THE ADAPTER COMMANDS ARE REAL-SHAPED AND CLASSIFIED ON PURPOSE (acpx PROJECT.md: synthetic
// `"agent"` commands are unclassified, and an unclassified adapter routes live — every row here
// would pass for the wrong reason). Each is `node <tmp>/<adapter>/dist/index.js`, a SENTINEL: run, it
// appends its kind to <tmp>/SPAWNED and exits 1. "SPAWNED absent" is the no-adapter proof.
//
// Record shapes are copied from real records sampled read-only on 2026-11-07 (DESIGN §2):
// claude c8a61971-664b-497c-be27-869cf88859aa · codex 01a1b26e-2e27-7452-bbab-59d7434ddbec ·
// pi 565eff19-d631-4630-adb2-9ad8e87e0f11.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type Kind = "claude" | "codex" | "pi";
const ADAPTER_DIR: Record<Kind, string> = {
  claude: "claude-agent-acp",
  codex: "codex-acp",
  pi: "pi-acp",
};

function select(
  id: string,
  category: string,
  currentValue: string,
  values: readonly string[],
): SessionConfigOption {
  return {
    id,
    name: id,
    category,
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  } as SessionConfigOption;
}

const CLAUDE_MODELS = ["default", "opus", "fable", "sonnet", "haiku"];

/** claude c8a61971: a `default` session; `snapshotModel` is what the stored advertisement names. */
function claudeAcpx(params: { model?: string; snapshotModel?: string } = {}): SessionAcpxState {
  const model = params.model ?? "default";
  return {
    config_options: [
      select("mode", "mode", "default", [
        "auto",
        "default",
        "acceptEdits",
        "plan",
        "dontAsk",
        "bypassPermissions",
      ]),
      select("model", "model", params.snapshotModel ?? "default", CLAUDE_MODELS),
      select("effort", "thought_level", "default", [
        "default",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
      select("outputStyle", "mode", "default", ["default", "Proactive", "Concise"]),
    ],
    session_options: { model, effort: "high", model_source: "inherited" },
    current_model_id: model,
    available_models: CLAUDE_MODELS,
    desired_config_options: { effort: "high" },
  };
}

/** codex 01a1b26e: the model rides a composed id; the snapshot carries no model option. */
function codexAcpx(): SessionAcpxState {
  return {
    config_options: [select("fast-mode", "fast-mode", "off", ["off", "on"])],
    session_options: { model: "gpt-6.1-sol[high]", model_source: "succession" },
    current_model_id: "gpt-6.1-sol[high]",
    available_models: ["gpt-6.1-sol[low]", "gpt-6.1-sol[medium]", "gpt-6.1-sol[high]"],
  };
}

const PI_MODEL = "openrouter/z-ai/glm-5.3-flash";
const PI_OTHER = "openrouter/aion-labs/aion-3.0";

/** pi 565eff19: model is `set-model`, depth is the `mode` mechanism over `thought_level`. */
function piAcpx(): SessionAcpxState {
  return {
    config_options: [
      select("model", "model", PI_MODEL, [PI_OTHER, PI_MODEL]),
      select("thought_level", "thought_level", "high", ["low", "high"]),
    ],
    session_options: { model: PI_MODEL, model_source: "inherited" },
    current_model_id: PI_MODEL,
    available_models: [PI_OTHER, PI_MODEL],
  };
}

type Home = {
  root: string;
  env: NodeJS.ProcessEnv;
  spawned: string;
  adapter: Record<Kind, string>;
};

function makeHome(): Home {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-set-record-"));
  fs.mkdirSync(path.join(root, ".acpx", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, "work"));
  const spawned = path.join(root, "SPAWNED");
  const adapter = {} as Record<Kind, string>;
  for (const kind of Object.keys(ADAPTER_DIR) as Kind[]) {
    const file = path.join(root, ADAPTER_DIR[kind], "dist", "index.js");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `require("node:fs").appendFileSync(${JSON.stringify(spawned)}, ${JSON.stringify(kind)} + "\\n");\nprocess.exit(1);\n`,
    );
    adapter[kind] = `node ${file}`;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    ACPX_STATE_HOME: root,
    ACPX_ADMISSION_DIR: path.join(root, "admission"),
    ACPX_CAPACITY_PODINFO_DIR: path.join(root, "no-podinfo"),
  };
  // A shell outside any agent — atrium's runner shape (caller identity stripped, no class).
  for (const key of [
    "ACPX_SESSION_URL",
    "ACPX_SEAT_URL",
    "ACPX_SESSION_NAME",
    "ACPX_SESSION_RECORD_ID",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_PARENT_SEAT_URL",
    "ACPX_ADMISSION_CLASS",
    "ACPX_BRICK",
    "ACPX_BRICK_PATH",
    "ACPX_TASK_FOLDER",
    "ACPX_OWNER_LOG",
  ]) {
    delete env[key];
  }
  return { root, env, spawned, adapter };
}

function recordFile(home: Home, id: string): string {
  return path.join(home.root, ".acpx", "sessions", `${id}.json`);
}

function seed(home: Home, kind: Kind, acpx: SessionAcpxState): string {
  const id = randomUUID();
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: randomUUID(),
    agentCommand: home.adapter[kind],
    cwd: path.join(home.root, "work"),
    acpx,
  });
  fs.writeFileSync(
    recordFile(home, id),
    `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`,
  );
  return id;
}

type DiskAcpx = {
  session_options?: Record<string, unknown>;
  current_model_id?: string;
  desired_config_options?: Record<string, string>;
  desired_mode_id?: string;
};

function diskAcpx(home: Home, id: string): DiskAcpx {
  return (
    (JSON.parse(fs.readFileSync(recordFile(home, id), "utf8")) as { acpx?: DiskAcpx }).acpx ?? {}
  );
}

function spawnedKinds(home: Home): string[] {
  try {
    return fs.readFileSync(home.spawned, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

type Run = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env, cwd, stdio: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function lastJson(run: Run): Record<string, unknown> {
  const last = run.stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(last) as Record<string, unknown>;
  } catch {
    return assert.fail(`no JSON on stdout (rc ${run.code}): ${run.stdout}\n${run.stderr}`);
  }
}

const setCli = (home: Home, kind: Kind, id: string, args: string[]) =>
  runCli(["--format", "json", kind, ...args, "--session-id", id], home.env, home.root);

// ---------------------------------------------------------------------------------------------
// The verdicts — pure (T1)
// ---------------------------------------------------------------------------------------------

function recordWith(agentCommand: string, acpx: SessionAcpxState): SessionRecord {
  return makeSessionRecord({ acpxRecordId: "r", acpSessionId: "a", agentCommand, cwd: "/", acpx });
}

const CLAUDE_CMD = "node /opt/claude-agent-acp/dist/index.js";

test("verdict: the record says YES only for a classified adapter whose own advertisement lists the value", () => {
  assert.deepEqual(recordOnlyModelVerdict(recordWith(CLAUDE_CMD, claudeAcpx())), {
    kind: "record",
  });
  assert.equal(
    recordOnlyConfigOptionVerdict(recordWith(CLAUDE_CMD, claudeAcpx()), "effort", "max").kind,
    "record",
  );
  // Each non-YES is `live`, never a refusal (DESIGN Q2): the adapter decides.
  const live = (verdict: { kind: string }) => assert.equal(verdict.kind, "live");
  live(recordOnlyModelVerdict(recordWith("agent", claudeAcpx())));
  live(recordOnlyModelVerdict(recordWith(CLAUDE_CMD, { ...claudeAcpx(), available_models: [] })));
  live(
    recordOnlyModelVerdict(
      recordWith(CLAUDE_CMD, { ...claudeAcpx(), model_set_unsupported_for: CLAUDE_CMD }),
    ),
  );
  live(recordOnlyConfigOptionVerdict(recordWith("agent", claudeAcpx()), "effort", "max"));
  live(recordOnlyConfigOptionVerdict(recordWith(CLAUDE_CMD, claudeAcpx()), "effort", "ultra"));
  live(recordOnlyConfigOptionVerdict(recordWith(CLAUDE_CMD, claudeAcpx()), "nope", "x"));
  // A learned -32601 from a DIFFERENT adapter is no evidence about this one (F-12).
  assert.equal(
    recordOnlyModelVerdict(
      recordWith(CLAUDE_CMD, { ...claudeAcpx(), model_set_unsupported_for: "node other.js" }),
    ).kind,
    "record",
  );
});

test("verdict: grouped select values are flattened; a boolean option takes true/false only", () => {
  const grouped = {
    id: "effort",
    name: "effort",
    type: "select",
    currentValue: "low",
    options: [{ group: "g", name: "g", options: [{ value: "low", name: "low" }] }],
  } as unknown as SessionConfigOption;
  const flag = {
    id: "fast",
    name: "fast",
    type: "boolean",
    currentValue: false,
  } as unknown as SessionConfigOption;
  const record = recordWith(CLAUDE_CMD, { config_options: [grouped, flag] });
  assert.equal(recordOnlyConfigOptionVerdict(record, "effort", "low").kind, "record");
  assert.equal(recordOnlyConfigOptionVerdict(record, "fast", "true").kind, "record");
  assert.equal(recordOnlyConfigOptionVerdict(record, "fast", "on").kind, "live");
});

test("verdict: freshness — the snapshot's model option must name the model the next connect serves", () => {
  assert.equal(advertisementDescribesNextModel(recordWith(CLAUDE_CMD, claudeAcpx())), true);
  const pinned = claudeAcpx({ model: "opus", snapshotModel: "default" });
  assert.equal(advertisementDescribesNextModel(recordWith(CLAUDE_CMD, pinned)), false);
  // No model option at all (codex): no evidence of staleness.
  assert.equal(advertisementDescribesNextModel(recordWith(CLAUDE_CMD, codexAcpx())), true);
  // A `category:"model"` option under another id counts as the model option.
  const byCategory = recordWith(CLAUDE_CMD, {
    config_options: [select("m", "model", "default", CLAUDE_MODELS)],
    session_options: { model: "opus" },
  });
  assert.equal(advertisementDescribesNextModel(byCategory), false);
});

// ---------------------------------------------------------------------------------------------
// N1 (G1) — record-only starts nothing
// ---------------------------------------------------------------------------------------------

test("N1 G1: ownerless model ×3 adapters, claude effort, codex fast-mode → rc 0, validatedAgainst record, no adapter started, the §2 fields written", async () => {
  const home = makeHome();
  const rows: Array<{
    kind: Kind;
    acpx: SessionAcpxState;
    args: string[];
    check: (a: DiskAcpx) => void;
  }> = [
    {
      kind: "claude",
      acpx: claudeAcpx(),
      args: ["set", "model", "sonnet"],
      check: (a) => {
        assert.equal(a.session_options?.model, "sonnet");
        assert.equal(a.session_options?.model_source, "explicit");
        assert.equal(a.current_model_id, "sonnet");
      },
    },
    {
      kind: "codex",
      acpx: codexAcpx(),
      args: ["set", "model", "gpt-6.1-sol[low]"],
      check: (a) => {
        assert.equal(a.session_options?.model, "gpt-6.1-sol[low]");
        assert.equal(a.current_model_id, "gpt-6.1-sol[low]");
      },
    },
    {
      kind: "pi",
      acpx: piAcpx(),
      args: ["set", "model", PI_OTHER],
      check: (a) => {
        assert.equal(a.session_options?.model, PI_OTHER);
        assert.equal(a.current_model_id, PI_OTHER);
      },
    },
    {
      kind: "claude",
      acpx: claudeAcpx(),
      args: ["set", "effort", "low"],
      check: (a) => {
        assert.equal(a.desired_config_options?.effort, "low");
        assert.equal(a.session_options?.effort, "low");
      },
    },
    {
      kind: "codex",
      acpx: codexAcpx(),
      args: ["set", "fast-mode", "on"],
      check: (a) => assert.equal(a.desired_config_options?.["fast-mode"], "on"),
    },
  ];
  for (const row of rows) {
    const id = seed(home, row.kind, row.acpx);
    const run = await setCli(home, row.kind, id, row.args);
    const label = `${row.kind} ${row.args.join(" ")}`;
    assert.equal(run.code, 0, `${label}: ${run.stderr}`);
    assert.equal(lastJson(run).validatedAgainst, "record", label);
    assert.deepEqual(spawnedKinds(home), [], `${label}: an adapter was started`);
    row.check(diskAcpx(home, id));
    assert.equal(diskAcpx(home, id).desired_mode_id, undefined, label);
  }
});

// ---------------------------------------------------------------------------------------------
// N3 (G3) — a stale advertisement never vouches
// ---------------------------------------------------------------------------------------------

test("N3 G3: a snapshot captured for `default` on an opus-pinned session → set effort goes LIVE (adapter started); the fresh twin stays record-only", async () => {
  const home = makeHome();
  const stale = seed(home, "claude", claudeAcpx({ model: "opus", snapshotModel: "default" }));
  const run = await setCli(home, "claude", stale, ["set", "effort", "low"]);
  assert.notEqual(run.code, 0, "the sentinel adapter exits 1, so the live path fails");
  assert.deepEqual(spawnedKinds(home), ["claude"], "the live path started the adapter");
  assert.equal(diskAcpx(home, stale).desired_config_options?.effort, "high", "nothing written");

  // The control: identical but fresh (snapshot names the served model) → record-only.
  const fresh = seed(home, "claude", claudeAcpx({ model: "opus", snapshotModel: "opus" }));
  const control = await setCli(home, "claude", fresh, ["set", "effort", "low"]);
  assert.equal(control.code, 0, control.stderr);
  assert.equal(lastJson(control).validatedAgainst, "record");
  assert.deepEqual(spawnedKinds(home), ["claude"], "the fresh twin started nothing");
});

test("N3: model-then-depth while ownerless — the record-only model pin makes the next set effort go live", async () => {
  const home = makeHome();
  const id = seed(home, "claude", claudeAcpx());
  const model = await setCli(home, "claude", id, ["set", "model", "sonnet"]);
  assert.equal(lastJson(model).validatedAgainst, "record");
  const effort = await setCli(home, "claude", id, ["set", "effort", "max"]);
  assert.notEqual(effort.code, 0);
  assert.deepEqual(spawnedKinds(home), ["claude"], "checked against sonnet's live ladder");
});

// ---------------------------------------------------------------------------------------------
// N4 (G4) — anything that writes desired_mode_id is never record-only
// ---------------------------------------------------------------------------------------------

test("N4 G4: set-mode plan, set mode plan (advertised!) and pi set effort high all go live", async () => {
  const home = makeHome();
  const rows: Array<{ kind: Kind; acpx: SessionAcpxState; args: string[] }> = [
    { kind: "claude", acpx: claudeAcpx(), args: ["set-mode", "plan"] },
    { kind: "claude", acpx: claudeAcpx(), args: ["set", "mode", "plan"] },
    { kind: "pi", acpx: piAcpx(), args: ["set", "effort", "high"] },
  ];
  for (const [index, row] of rows.entries()) {
    const id = seed(home, row.kind, row.acpx);
    const run = await setCli(home, row.kind, id, row.args);
    const label = `${row.kind} ${row.args.join(" ")}`;
    assert.notEqual(run.code, 0, `${label}: the sentinel adapter exits 1`);
    assert.equal(spawnedKinds(home).length, index + 1, `${label}: no adapter was asked`);
    assert.equal(
      diskAcpx(home, id).desired_mode_id,
      undefined,
      `${label}: a mode reached the record`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// N2 (G2) — the next real turn serves the record-only setting, and it survives that turn
// ---------------------------------------------------------------------------------------------

type Op = { method?: string; modelId?: string; configId?: string; value?: unknown };

function readOps(file: string): Op[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Op);
  } catch {
    return [];
  }
}

test("N2 G2: record-only `set effort low` + `set model smart-model`, then a real prompt through the queue owner — the adapter receives both and the record keeps both", async () => {
  const home = makeHome();
  const ops = path.join(home.root, "ops.jsonl");
  // `--claude-agent-acp` classifies the mock as claude (an adapter-named flag), so the verdicts run.
  const agent = `node ${JSON.stringify(MOCK_AGENT_PATH)} --claude-agent-acp --advertise-models --advertise-config-options --log-config-option-ops --operation-log ${JSON.stringify(ops)}`;
  const sessions = path.join(home.root, ".acpx", "sessions");
  const before = new Set(fs.readdirSync(sessions));
  const created = await runCli(
    ["--agent", agent, "--cwd", path.join(home.root, "work"), "sessions", "new"],
    home.env,
    home.root,
  );
  assert.equal(created.code, 0, created.stderr);
  const file = fs
    .readdirSync(sessions)
    .find((name) => /^[0-9a-f-]{36}\.json$/u.test(name) && !before.has(name));
  assert.ok(file, "sessions new wrote a record");
  const id = file.replace(/\.json$/u, "");

  const opsAtSet = readOps(ops).length;
  for (const args of [
    ["set", "effort", "low"],
    ["set", "model", "smart-model"],
  ]) {
    const run = await runCli(
      ["--format", "json", "--agent", agent, ...args, "--session-id", id],
      home.env,
      home.root,
    );
    assert.equal(run.code, 0, `${args.join(" ")}: ${run.stderr}`);
    assert.equal(lastJson(run).validatedAgainst, "record", args.join(" "));
  }
  assert.equal(readOps(ops).length, opsAtSet, "a record-only set reached the adapter");

  const turn = await runCli(
    ["--agent", agent, "prompt", "--session-id", id, "hello"],
    home.env,
    home.root,
  );
  assert.equal(turn.code, 0, turn.stderr);
  const served = readOps(ops).slice(opsAtSet);
  const prompt = served.find((op) => op.method === "session/prompt");
  assert.equal(
    prompt?.modelId,
    "smart-model",
    `the turn was not served by the pinned model: ${JSON.stringify(served)}`,
  );
  assert.ok(
    served.some(
      (op) =>
        op.method === "session/set_config_option" && op.configId === "effort" && op.value === "low",
    ),
    `the replay did not send effort=low: ${JSON.stringify(served)}`,
  );
  const after = diskAcpx(home, id);
  assert.equal(
    after.session_options?.model,
    "smart-model",
    "the model pin did not survive the turn",
  );
  assert.equal(
    after.desired_config_options?.effort,
    "low",
    "desired effort did not survive the turn",
  );
  assert.equal(
    after.session_options?.effort,
    "low",
    "session_options.effort did not survive the turn",
  );
});
