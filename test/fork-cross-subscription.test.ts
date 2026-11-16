import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { removeTempHomeSync } from "./temp-home.js";
import { type Fixture, makeBox, makeTarget, operations, readRecord, runCli } from "./umq-rig.js";

// brick 765510a3 — a Claude template start failed after a forced subscription switch. A sleeping
// template copy forks its template at the first wake. Failover had moved the copy off the
// template's (exhausted) subscription, and the adapter, running under the copy's
// CLAUDE_CONFIG_DIR, could not find the template's transcript: `Resource not found: <new fork id>`,
// SESSION_MATERIALISATION_FAILED (production session 716286ae on devbox, 2026-11-16).
//
// The mock adapter is classified as Claude (`--claude-agent-acp`) and refuses a `session/fork` the
// way the real adapter does when `<CLAUDE_CONFIG_DIR>/projects/<slug(cwd)>/<source>.jsonl` is
// missing (`--claude-fork-requires-source-transcript`). So every row below forks for real under the
// copy's subscription, and only a source staged there can make it succeed.

const AUTOMATION = { ACPX_ADMISSION_CLASS: "automation" };

type Rig = Fixture & { work: string; subDir: (id: string) => string };

function makeRig(): Rig {
  const f = makeBox({
    requestMib: 4000,
    withMockExtraArgs: ["--claude-agent-acp", "--claude-fork-requires-source-transcript"],
  });
  const subscriptions = path.join(f.root, ".acpx", "subscriptions");
  const subDir = (id: string) => path.join(subscriptions, id);
  for (const id of ["subA", "subB"]) {
    fs.mkdirSync(subDir(id), { recursive: true });
  }
  fs.writeFileSync(
    path.join(subscriptions, "registry.json"),
    JSON.stringify({
      version: 3,
      // The default is subB, NOT the account the sources are baked on (subA): a copy that comes out on
      // subA can only have inherited it.
      default: "subB",
      profiles: ["subA", "subB"].map((id) => ({
        id,
        label: id,
        authMode: "subscription",
        adapter: "claude",
        account: `acct-${id}`,
        credentialSource: subDir(id),
      })),
    }),
  );
  return { ...f, work: path.join(f.root, "work"), subDir };
}

const baseArgs = (f: Rig, global: string[] = []): string[] => [
  "--agent",
  f.agent,
  "--cwd",
  f.work,
  "--approve-all",
  ...global,
];

/** A template whose one turn ran on subA; its transcript is written ONLY under `transcriptIn`. */
async function makeTemplate(
  f: Rig,
  transcriptIn: string | undefined,
): Promise<{ id: string; transcript: string | undefined; body: string }> {
  const id = await makeTarget(f, ["--subscription", "subA"]);
  const warm = await runCli(
    [...baseArgs(f), "prompt", "--session-id", id, "remember PELICAN-42"],
    f.env,
    f.root,
  );
  assert.equal(warm.code, 0, warm.stderr);
  const record = readRecord(f, id) as { acp_session_id: string; cwd: string };
  assert.match(record.acp_session_id, /^[0-9a-f-]{36}$/u);
  const body = `${JSON.stringify({ type: "user", uuid: "u-1", timestamp: "2026-11-16T11:49:00.000Z", message: { content: "remember PELICAN-42" } })}\n`;
  if (transcriptIn === undefined) {
    return { id, transcript: undefined, body };
  }
  const transcript = transcriptJsonlPath(f.subDir(transcriptIn), record.cwd, record.acp_session_id);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, body);
  return { id, transcript, body };
}

function lastFork(f: Rig): Record<string, unknown> | undefined {
  return operations(f).findLast((op) => op.method === "session/fork");
}

function jsonId(stdout: string): string {
  const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { acpxRecordId?: string };
  assert.ok(parsed.acpxRecordId, stdout);
  return parsed.acpxRecordId;
}

test("765510a3: a sleeping template copy on ANOTHER subscription than the template's transcript wakes, forks under its own subscription, and leaves no staged copy", async () => {
  const f = makeRig();
  try {
    const template = await makeTemplate(f, "subA");
    const created = await runCli(
      [
        ...baseArgs(f, ["--subscription", "subB"]),
        "--format",
        "json",
        "sessions",
        "copy",
        "--from",
        template.id,
        "--sleeping",
      ],
      { ...f.env, ...AUTOMATION },
      f.root,
    );
    assert.equal(created.code, 0, created.stderr);
    const copyId = jsonId(created.stdout);

    const wake = await runCli(
      [...baseArgs(f), "prompt", "--session-id", copyId, "what was the codeword?"],
      f.env,
      f.root,
    );
    assert.equal(wake.code, 0, wake.stdout + wake.stderr);
    assert.doesNotMatch(wake.stdout + wake.stderr, /SESSION_MATERIALISATION_FAILED/u);

    const fork = lastFork(f);
    assert.equal(fork?.refused, undefined, JSON.stringify(fork));
    assert.equal(fork?.claudeConfigDir, f.subDir("subB"), "the fork ran under the copy's subB");
    assert.equal(fork?.claudeTranscriptAtRequestCwd, true, "the source was staged under subB");

    const woken = readRecord(f, copyId) as {
      acp_session_id: string;
      acpx: { sleeping?: unknown; session_options?: { subscription?: string; profile?: string } };
    };
    assert.match(woken.acp_session_id, /^[0-9a-f-]{36}$/u, "the copy has its own session now");
    assert.equal(woken.acpx.sleeping, undefined, "no longer sleeping");

    const templateRecord = readRecord(f, template.id) as { acp_session_id: string; cwd: string };
    const staged = transcriptJsonlPath(
      f.subDir("subB"),
      templateRecord.cwd,
      templateRecord.acp_session_id,
    );
    assert.equal(fs.existsSync(staged), false, "the staged source was removed after the fork");
    assert.equal(fs.existsSync(`${staged}.acpx-stage.lock`), false, "the stage lock was released");
    assert.equal(
      fs.readFileSync(template.transcript ?? "", "utf8"),
      template.body,
      "source unchanged",
    );
  } finally {
    removeTempHomeSync(f.root);
  }
});

test("765510a3: an eager same-cwd `sessions copy` pinned to another subscription than its source forks", async () => {
  const f = makeRig();
  try {
    const template = await makeTemplate(f, "subA");
    const copied = await runCli(
      [
        ...baseArgs(f, ["--subscription", "subB"]),
        "--format",
        "json",
        "sessions",
        "copy",
        "--from",
        template.id,
      ],
      f.env,
      f.root,
    );
    assert.equal(copied.code, 0, copied.stdout + copied.stderr);
    const fork = lastFork(f);
    assert.equal(fork?.refused, undefined, JSON.stringify(fork));
    assert.equal(fork?.claudeConfigDir, f.subDir("subB"));
    assert.equal(fork?.claudeTranscriptAtRequestCwd, true);
  } finally {
    removeTempHomeSync(f.root);
  }
});

test("765510a3: when the destination already holds a STALER copy of the source, the fork reads the freshest one and the stale copy is restored afterwards", async () => {
  const f = makeRig();
  try {
    const template = await makeTemplate(f, "subA");
    const templateRecord = readRecord(f, template.id) as { acp_session_id: string; cwd: string };
    const atB = transcriptJsonlPath(
      f.subDir("subB"),
      templateRecord.cwd,
      templateRecord.acp_session_id,
    );
    const stale = `${JSON.stringify({ type: "user", uuid: "u-0", timestamp: "2026-11-01T00:00:00.000Z", message: { content: "old" } })}\n`;
    fs.mkdirSync(path.dirname(atB), { recursive: true });
    fs.writeFileSync(atB, stale);

    const copied = await runCli(
      [
        ...baseArgs(f, ["--subscription", "subB"]),
        "--format",
        "json",
        "sessions",
        "copy",
        "--from",
        template.id,
      ],
      f.env,
      f.root,
    );
    assert.equal(copied.code, 0, copied.stdout + copied.stderr);
    assert.equal(lastFork(f)?.claudeTranscriptAtRequestCwd, true);
    assert.equal(fs.readFileSync(atB, "utf8"), stale, "the pre-existing copy is put back");
  } finally {
    removeTempHomeSync(f.root);
  }
});

// The committed negative case: the instrument can go red. With the source under NO subscription the
// adapter must refuse, the wake must fail as SESSION_MATERIALISATION_FAILED, and the copy must stay
// sleeping. If this row ever passes the wake, the mock stopped enforcing the source transcript and
// the rows above prove nothing.
test("765510a3 negative: a source transcript under NO subscription still fails the wake as SESSION_MATERIALISATION_FAILED, and the copy stays sleeping", async () => {
  const f = makeRig();
  try {
    const template = await makeTemplate(f, undefined);
    const created = await runCli(
      [
        ...baseArgs(f, ["--subscription", "subB"]),
        "--format",
        "json",
        "sessions",
        "copy",
        "--from",
        template.id,
        "--sleeping",
      ],
      { ...f.env, ...AUTOMATION },
      f.root,
    );
    assert.equal(created.code, 0, created.stderr);
    const copyId = jsonId(created.stdout);
    const wake = await runCli(
      [...baseArgs(f), "prompt", "--session-id", copyId, "hello"],
      f.env,
      f.root,
    );
    assert.notEqual(wake.code, 0, wake.stdout + wake.stderr);
    assert.match(wake.stdout + wake.stderr, /could not be started: Resource not found/u);
    assert.equal(lastFork(f)?.refused, "resource-not-found");
    const record = readRecord(f, copyId) as {
      acp_session_id: string;
      acpx: { sleeping?: unknown };
    };
    assert.equal(record.acp_session_id, "");
    assert.ok(record.acpx.sleeping, "still sleeping");
  } finally {
    removeTempHomeSync(f.root);
  }
});

// ─── 765510a3 template binding: a template does not bind its sessions to a subscription ─────────

async function bakedSource(f: Rig, asTemplate: boolean): Promise<string> {
  const id = await makeTarget(f, ["--subscription", "subA", "--model", "smart-model"]);
  const warm = await runCli([...baseArgs(f), "prompt", "--session-id", id, "bake"], f.env, f.root);
  assert.equal(warm.code, 0, warm.stderr);
  const record = readRecord(f, id) as { acp_session_id: string; cwd: string };
  const transcript = transcriptJsonlPath(f.subDir("subA"), record.cwd, record.acp_session_id);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", uuid: "u-1", timestamp: "2026-11-16T11:49:00.000Z", message: { content: "bake" } })}\n`,
  );
  if (asTemplate) {
    const marked = await runCli(
      [...baseArgs(f), "sessions", "template", id, "--enable", "--slug", "tpl-765510a3"],
      f.env,
      f.root,
    );
    assert.equal(marked.code, 0, marked.stdout + marked.stderr);
    assert.ok((readRecord(f, id) as { template?: unknown }).template, "control: it IS a template");
  }
  const options = (readRecord(f, id) as { acpx: { session_options?: Record<string, unknown> } })
    .acpx.session_options;
  assert.equal(options?.profile ?? options?.subscription, "subA", "control: baked on subA");
  return id;
}

type Options = { profile?: string; subscription?: string; model?: string };
const optionsOf = (f: Rig, id: string): Options =>
  (readRecord(f, id) as { acpx: { session_options?: Options } }).acpx.session_options ?? {};

for (const sleeping of [false, true]) {
  const shape = sleeping ? "a sleeping" : "an eager";
  test(`765510a3 template binding: ${shape} copy of a TEMPLATE does not inherit its subscription, keeps its model`, async () => {
    const f = makeRig();
    try {
      const template = await bakedSource(f, true);
      const created = await runCli(
        [
          ...baseArgs(f),
          "--format",
          "json",
          "sessions",
          "copy",
          "--from",
          template,
          ...(sleeping ? ["--sleeping"] : []),
        ],
        { ...f.env, ...(sleeping ? AUTOMATION : {}) },
        f.root,
      );
      assert.equal(created.code, 0, created.stdout + created.stderr);
      const copyId = jsonId(created.stdout);
      const options = optionsOf(f, copyId);
      // Normal selection, measured: what a plain new session with no flag records on this box.
      const plain = optionsOf(f, await makeTarget(f));
      assert.equal(
        plain.profile ?? plain.subscription,
        "subB",
        "control: normal selection is subB",
      );
      assert.notEqual(options.profile ?? options.subscription, "subA", JSON.stringify(options));
      assert.equal(options.profile ?? options.subscription, plain.profile ?? plain.subscription);
      assert.equal(options.model, "smart-model", "model comes from the template");
      if (!sleeping) {
        // Normal selection (the registry default, subB), read from the adapter's own env.
        assert.equal(lastFork(f)?.claudeConfigDir, f.subDir("subB"));
      }
    } finally {
      removeTempHomeSync(f.root);
    }
  });
}

test("765510a3 template binding: an explicit --subscription on a template copy is still honoured", async () => {
  const f = makeRig();
  try {
    const template = await bakedSource(f, true);
    const created = await runCli(
      [
        ...baseArgs(f, ["--subscription", "subB"]),
        "--format",
        "json",
        "sessions",
        "copy",
        "--from",
        template,
      ],
      f.env,
      f.root,
    );
    assert.equal(created.code, 0, created.stdout + created.stderr);
    assert.equal(optionsOf(f, jsonId(created.stdout)).profile, "subB");
  } finally {
    removeTempHomeSync(f.root);
  }
});

// The other side of the gate: a fork of an ORDINARY session keeps its account, as before.
test("765510a3 template binding (control): a copy of an ordinary session still inherits its subscription", async () => {
  const f = makeRig();
  try {
    const source = await bakedSource(f, false);
    const created = await runCli(
      [...baseArgs(f), "--format", "json", "sessions", "copy", "--from", source],
      f.env,
      f.root,
    );
    assert.equal(created.code, 0, created.stdout + created.stderr);
    const options = optionsOf(f, jsonId(created.stdout));
    assert.equal(options.profile ?? options.subscription, "subA");
  } finally {
    removeTempHomeSync(f.root);
  }
});
