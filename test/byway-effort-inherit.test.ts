import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { removeTempHomeSync } from "./temp-home.js";
import { type Fixture, makeBox, makeTarget, operations, readRecord, runCli } from "./umq-rig.js";

// brick 94d01658 — a by-the-way (a cut `sessions copy --at-log-index`) of a Claude session must keep
// its source's reasoning effort, on the record AND on the wire of its first turn.
//
// The defect, measured on devbox 2026-11-23 (claude-agent-acp 842fb79): a Claude copy is a DURABLE
// fork whose id the creating adapter has not registered. acpx set the effort on it at creation,
// the adapter answered `-32603 … Failed to resume forked session … for config op`, and the
// creation-time catch took that as "the agent rejected this level" and wrote the advertised current
// value over the intent. Every by-the-way therefore recorded the wrong effort and ran its first turn
// at the settings tier instead of its source's `max`.
//
// The mock is classified as Claude (`--claude-agent-acp`), so acpx really materialises a durable
// fork, and `--config-op-requires-registered-session` makes a config op on an id it never registered
// fail with that measured error. Without that flag the mock accepts any id, and these rows would pass
// on the unfixed build.

type Rig = Fixture & { work: string; subDir: (id: string) => string };

function makeRig(): Rig {
  const f = makeBox({
    requestMib: 4000,
    withMockExtraArgs: [
      "--claude-agent-acp",
      "--advertise-config-options",
      "--log-config-option-ops",
      "--config-op-requires-registered-session",
    ],
  });
  const subscriptions = path.join(f.root, ".acpx", "subscriptions");
  const subDir = (id: string) => path.join(subscriptions, id);
  fs.mkdirSync(subDir("subA"), { recursive: true });
  fs.writeFileSync(
    path.join(subscriptions, "registry.json"),
    JSON.stringify({
      version: 3,
      default: "subA",
      profiles: [
        {
          id: "subA",
          label: "subA",
          authMode: "subscription",
          adapter: "claude",
          account: "acct-subA",
          credentialSource: subDir("subA"),
        },
      ],
    }),
  );
  return { ...f, agent: asFakeClaudePackage(f), work: path.join(f.root, "work"), subDir };
}

/**
 * Re-point the rig's agent at a fake `claude-agent-acp` package: `<pkg>/dist/index.js` runs the
 * rig's mock wrapper, and `<pkg>/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` gives acpx's
 * `materializeClaudeForkSession` an SDK `forkSession` to call. Without that SDK acpx finds no fork
 * module, skips the durable substitution, and the copy keeps the mock's own (registered) fork id —
 * so the defect this file pins could never occur here.
 */
function asFakeClaudePackage(f: Fixture): string {
  const wrapper = path.join(f.root, "agent.mjs");
  const pkg = path.join(f.root, "fake-claude-agent-acp");
  const index = path.join(pkg, "dist", "index.js");
  const sdk = path.join(pkg, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs");
  fs.mkdirSync(path.dirname(index), { recursive: true });
  fs.mkdirSync(path.dirname(sdk), { recursive: true });
  fs.writeFileSync(index, `await import(${JSON.stringify(pathToFileURL(wrapper).href)});\n`);
  fs.writeFileSync(
    sdk,
    `import fs from "node:fs/promises";
import path from "node:path";
const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
export async function forkSession(sessionId, options = {}) {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", slug(options.dir));
  const newId = "durable-" + sessionId;
  const source = await fs.readFile(path.join(projects, sessionId + ".jsonl"), "utf8");
  await fs.writeFile(path.join(projects, newId + ".jsonl"), source, "utf8");
  return { sessionId: newId };
}
`,
  );
  const quotedWrapper = JSON.stringify(wrapper);
  assert.ok(f.agent.includes(quotedWrapper), f.agent);
  return f.agent.replace(quotedWrapper, JSON.stringify(index));
}

const baseArgs = (f: Rig, global: string[] = []): string[] => [
  "--agent",
  f.agent,
  "--cwd",
  f.work,
  "--approve-all",
  ...global,
];

type EffortRecord = {
  acp_session_id: string;
  cwd: string;
  acpx: {
    desired_config_options?: { effort?: string };
    session_options?: { effort?: string };
  };
};

/** An effort-`max` Claude source with one real turn and its transcript under subA. */
async function makeMaxSource(f: Rig): Promise<string> {
  const id = await makeTarget(f, ["--subscription", "subA", "--reasoning-effort", "max"]);
  const turn = await runCli(
    [...baseArgs(f), "prompt", "--session-id", id, "echo hello"],
    f.env,
    f.root,
  );
  assert.equal(turn.code, 0, turn.stderr);
  const record = readRecord(f, id) as EffortRecord;
  assert.equal(record.acpx.desired_config_options?.effort, "max", "the source runs at max");
  const transcript = transcriptJsonlPath(f.subDir("subA"), record.cwd, record.acp_session_id);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    [
      {
        type: "user",
        uuid: "u-1",
        timestamp: "2026-11-23T08:00:00.000Z",
        message: { content: "echo hello" },
      },
      {
        type: "assistant",
        uuid: "a-1",
        parentUuid: "u-1",
        timestamp: "2026-11-23T08:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
  return id;
}

function copiedId(stdout: string): string {
  const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { acpxRecordId?: string };
  assert.ok(parsed.acpxRecordId, stdout);
  return parsed.acpxRecordId;
}

async function copy(f: Rig, sourceId: string, global: string[], cut: string[]): Promise<string> {
  const run = await runCli(
    [...baseArgs(f, global), "--format", "json", "sessions", "copy", "--from", sourceId, ...cut],
    f.env,
    f.root,
  );
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const id = copiedId(run.stdout);
  const acpSessionId = (readRecord(f, id) as EffortRecord).acp_session_id;
  assert.match(acpSessionId, /^durable-/u, "the copy is a durable Claude fork");
  return id;
}

function effortOf(f: Rig, id: string): { desired?: string; sessionOption?: string } {
  const record = readRecord(f, id) as EffortRecord;
  return {
    desired: record.acpx.desired_config_options?.effort,
    sessionOption: record.acpx.session_options?.effort,
  };
}

/**
 * The effort the copy's first turn was served at: the `set_config_option effort` acpx put on the
 * wire for the copy's session AFTER it was resumed and BEFORE its first prompt. That is what the
 * adapter applies to the SDK query for the turn (`applyEffortToSdk`).
 */
async function firstTurnWireEffort(f: Rig, copyId: string): Promise<string | undefined> {
  const before = operations(f).length;
  const turn = await runCli(
    [...baseArgs(f), "prompt", "--session-id", copyId, "echo again"],
    f.env,
    f.root,
  );
  assert.equal(turn.code, 0, turn.stdout + turn.stderr);
  const sessionId = (readRecord(f, copyId) as EffortRecord).acp_session_id;
  const ops = operations(f).slice(before);
  const promptAt = ops.findIndex((op) => op.method === "session/prompt");
  assert.ok(promptAt > 0, JSON.stringify(ops));
  const set = ops
    .slice(0, promptAt)
    .findLast(
      (op) =>
        op.method === "session/set_config_option" &&
        op.configId === "effort" &&
        op.sessionId === sessionId,
    );
  assert.equal(set?.registered, true, "the effort was set on a resumed, registered session");
  return typeof set?.value === "string" ? set.value : undefined;
}

test("94d01658: a cut copy (--at-log-index) of an effort-max Claude source records max and serves its first turn at max", async () => {
  const f = makeRig();
  try {
    const source = await makeMaxSource(f);
    const copyId = await copy(f, source, [], ["--at-log-index", "2"]);

    assert.deepEqual(effortOf(f, copyId), { desired: "max", sessionOption: "max" });
    assert.equal(await firstTurnWireEffort(f, copyId), "max");
    // The record.acpx allowlist trap: the effort must survive the turn's rebuild of record.acpx.
    assert.deepEqual(effortOf(f, copyId), { desired: "max", sessionOption: "max" });
  } finally {
    removeTempHomeSync(f.root);
  }
});

test("94d01658: an explicit --reasoning-effort low on a cut copy records low and serves low", async () => {
  const f = makeRig();
  try {
    const source = await makeMaxSource(f);
    const copyId = await copy(f, source, ["--reasoning-effort", "low"], ["--at-log-index", "2"]);

    assert.deepEqual(effortOf(f, copyId), { desired: "low", sessionOption: "low" });
    assert.equal(await firstTurnWireEffort(f, copyId), "low");
  } finally {
    removeTempHomeSync(f.root);
  }
});

test("94d01658: a full copy (no cut) of an effort-max Claude source records max and serves max", async () => {
  const f = makeRig();
  try {
    const source = await makeMaxSource(f);
    const copyId = await copy(f, source, [], []);

    assert.deepEqual(effortOf(f, copyId), { desired: "max", sessionOption: "max" });
    assert.equal(await firstTurnWireEffort(f, copyId), "max");
  } finally {
    removeTempHomeSync(f.root);
  }
});

test("94d01658: no effort config op is sent on the unregistered durable fork id at creation", async () => {
  const f = makeRig();
  try {
    const source = await makeMaxSource(f);
    const before = operations(f).length;
    const copyId = await copy(f, source, [], ["--at-log-index", "2"]);
    const durableId = (readRecord(f, copyId) as EffortRecord).acp_session_id;
    const unregisteredSets = operations(f)
      .slice(before)
      .filter((op) => op.method === "session/set_config_option" && op.registered === false);
    assert.deepEqual(unregisteredSets, [], `durable id ${durableId}`);
  } finally {
    removeTempHomeSync(f.root);
  }
});
