import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readLedgerFile } from "../src/capacity/ledger.js";
import { reapLeftBehindTranscripts } from "../src/config/transcript-reap.js";
import { connectAndLoadSession } from "../src/runtime/engine/reconnect.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import {
  admissionDir,
  agentStarts,
  asAgent,
  createdRecordIds,
  type Fixture,
  leaseFiles,
  makeBox,
  makeTarget,
  methods,
  operations,
  readRecord,
  recordPath,
  runCli,
  sessionsDir,
} from "./umq-rig.js";

// UMQ lane A2 (CONCEPTION §6, CONTRACTS §4) — sleeping sessions: `sessions new|copy --sleeping`
// writes the record and starts nothing; the first wake materialises it; every reader of
// `acpSessionId` reads "" as "not started". Each N-A2-* id below is a committed negative case the
// G1 executor finds by name (TEST-PLAN §4.2).

const AUTOMATION = { ACPX_ADMISSION_CLASS: "automation" };

const baseArgs = (f: Fixture, global: string[] = []): string[] => [
  "--agent",
  f.agent,
  "--cwd",
  path.join(f.root, "work"),
  "--approve-all",
  ...global,
];

type Created = Record<string, unknown> & { acpxRecordId: string };

async function sleepingNew(
  f: Fixture,
  extra: string[] = [],
  global: string[] = [],
  env: NodeJS.ProcessEnv = { ...f.env, ...AUTOMATION },
) {
  return await runCli(
    [...baseArgs(f, global), "--format", "json", "sessions", "new", "--sleeping", ...extra],
    env,
    f.root,
  );
}

function jsonOf(run: { stdout: string }): Created {
  return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Created;
}

const seatCount = (f: Fixture): number => {
  try {
    const store = JSON.parse(fs.readFileSync(path.join(sessionsDir(f), "seats.json"), "utf8")) as {
      seats?: Record<string, unknown>;
    };
    return Object.keys(store.seats ?? store).length;
  } catch {
    return 0;
  }
};

const census = (f: Fixture) => ({ records: createdRecordIds(f).length, seats: seatCount(f) });

test("N-A2-1 · G6 K7 Q5: `sessions new --sleeping` on a FULL box succeeds and starts nothing; the twin without the class exits 2 and creates nothing", async () => {
  const f = makeBox({ requestMib: 2048 });
  const before = census(f);
  const leasesBefore = leaseFiles(f);

  // The control: the SAME call without --sleeping is gated — exit 75, nothing created.
  const gated = await runCli(
    [...baseArgs(f), "--format", "json", "sessions", "new"],
    { ...f.env, ...AUTOMATION },
    f.root,
  );
  assert.equal(gated.code, 75, gated.stderr);
  assert.deepEqual(census(f), before, "the gated create left nothing");

  const run = await sleepingNew(f);
  assert.equal(run.code, 0, run.stderr);
  const created = jsonOf(run);
  assert.equal(created.sleeping, true);
  assert.equal(created.promptQueued, false);
  assert.equal(created.acpxSessionId, "");
  assert.equal(agentStarts(f), 0, "no adapter spawn");
  assert.deepEqual(
    operations(f),
    [],
    "no ACP operation of any kind: no session/new, no model apply",
  );
  assert.deepEqual(leaseFiles(f), leasesBefore, "no lease");
  assert.deepEqual(await readLedgerFile(admissionDir(f)), [], "no reservation");
  const record = readRecord(f, created.acpxRecordId) as {
    acp_session_id: string;
    acpx: { sleeping?: { since: string; fork?: unknown } };
    seat_id?: string;
  };
  assert.equal(record.acp_session_id, "");
  assert.ok(record.acpx.sleeping?.since, "acpx.sleeping marks it");
  assert.equal(record.acpx.sleeping?.fork, undefined, "a fresh session has no template");
  assert.ok(record.seat_id, "a seat, as a normal create");
  assert.equal(census(f).records, before.records + 1);

  // The twin: differs only in the missing class.
  const mid = census(f);
  for (const env of [
    f.env,
    { ...f.env, ACPX_ADMISSION_CLASS: "interactive" },
    { ...f.env, ACPX_ADMISSION_CLASS: "spawn" },
    { ...f.env, ACPX_ADMISSION_CLASS: "delivery" },
  ]) {
    // Text format: the usage error is on stderr (json carries it as an error object on stdout).
    const refused = await runCli([...baseArgs(f), "sessions", "new", "--sleeping"], env, f.root);
    assert.equal(refused.code, 2, `${env.ACPX_ADMISSION_CLASS}: ${refused.stderr}`);
    assert.match(
      refused.stderr,
      /acpx: --sleeping is for atrium's automated starts \(ACPX_ADMISSION_CLASS=automation\)/u,
    );
  }
  assert.deepEqual(census(f), mid, "the refused twins created nothing");
});

test("sessions new --sleeping: every flag that would start or feed an agent is refused (exit 2), nothing created", async () => {
  const f = makeBox({ requestMib: 4000 });
  const target = await makeTarget(f);
  const prompt = path.join(f.root, "p.md");
  fs.writeFileSync(prompt, "hi");
  const before = census(f);
  const cases: string[][] = [
    ["--prompt", "hello"],
    ["--prompt-file", prompt],
    ["--from", target],
    ["--seat", "5ea7c0de-0000-4000-8000-000000000009"],
    ["--from-template", target],
    ["--resume-session", "abc"],
  ];
  for (const extra of cases) {
    const run = await sleepingNew(f, extra);
    assert.equal(run.code, 2, `${extra.join(" ")}: ${run.stderr}`);
  }
  const copyCases: string[][] = [
    ["--ephemeral"],
    ["--prompt", "hello"],
    ["--prompt-file", prompt],
    ["--at-index", "1"],
  ];
  for (const extra of copyCases) {
    const run = await runCli(
      [
        ...baseArgs(f),
        "--format",
        "json",
        "sessions",
        "copy",
        "--from",
        target,
        "--sleeping",
        ...extra,
      ],
      { ...f.env, ...AUTOMATION },
      f.root,
    );
    assert.equal(run.code, 2, `copy ${extra.join(" ")}: ${run.stderr}`);
  }
  assert.deepEqual(census(f), before, "nothing was created by any refusal");
  // --no-prompt is accepted (redundant).
  const ok = await sleepingNew(f, ["--no-prompt"]);
  assert.equal(ok.code, 0, ok.stderr);
});

test("N-A2-6 · G7: a sleeping record's first prompt materialises it — session/new, the model ONCE, acpSessionId written and `sleeping` deleted; the prompt follows", async () => {
  const f = makeBox({ requestMib: 4000 });
  const run = await sleepingNew(f, [], ["--model", "sonnet"]);
  assert.equal(run.code, 0, run.stderr);
  const id = jsonOf(run).acpxRecordId;
  assert.deepEqual(methods(f), [], "creating started nothing");
  const sleepingRecord = readRecord(f, id) as {
    acpx: { session_options?: { model?: string }; sleeping?: unknown };
  };
  assert.equal(
    sleepingRecord.acpx.session_options?.model,
    "sonnet",
    "the requested model is pinned",
  );

  // The first wake: a prompt as a person (no agent identity) — admitted on room, an owner starts.
  const wake = await runCli([...baseArgs(f), "prompt", "--session-id", id, "hello"], f.env, f.root);
  assert.equal(wake.code, 0, wake.stderr);
  const ops = methods(f);
  assert.equal(ops[0], "session/new", ops.join(","));
  const prompt = ops.indexOf("session/prompt");
  assert.ok(prompt > 0, ops.join(","));
  assert.equal(
    ops.filter((method) => method === "session/set_model").length,
    1,
    `the model is applied ONCE: ${ops.join(",")}`,
  );
  assert.ok(ops.indexOf("session/set_model") < prompt, "the model precedes the prompt frame");
  assert.equal(ops.filter((method) => method === "session/new").length, 1);
  const record = readRecord(f, id) as {
    acp_session_id: string;
    acpx: { session_options?: { model?: string }; sleeping?: unknown };
  };
  assert.notEqual(record.acp_session_id, "", "acpSessionId written");
  assert.equal(record.acpx.sleeping, undefined, "sleeping deleted");
  assert.equal(record.acpx.session_options?.model, "sonnet", "the pin survives the turn");
  const indexRaw = JSON.parse(fs.readFileSync(path.join(sessionsDir(f), "index.json"), "utf8")) as {
    entries: Array<{ acpxRecordId: string; sleeping?: boolean; acpSessionId: string }>;
  };
  const entry = indexRaw.entries.find((candidate) => candidate.acpxRecordId === id);
  assert.equal(entry?.sleeping, undefined, "the index entry no longer says sleeping");
  assert.notEqual(entry?.acpSessionId, "");
});

test("connectAndLoadSession on a sleeping record: session/new → model → (effort/mode/config) once → ids written and `sleeping` deleted BEFORE it returns; a materialisation failure leaves the record sleeping byte for byte", async () => {
  const calls: string[] = [];
  const makeClient = (failAt?: string) => ({
    hasReusableSession: () => false,
    start: async () => {
      calls.push("start");
    },
    markAdvertisement: () => 0,
    advertisedConfigOptionsSince: () => undefined,
    getAgentLifecycleSnapshot: () => ({ running: true }),
    supportsLoadSession: () => true,
    supportsResumeSession: () => true,
    resumeSession: async () => {
      throw new Error("a sleeping record never resumes");
    },
    loadSessionWithOptions: async () => {
      throw new Error("a sleeping record never loads");
    },
    createSession: async () => {
      calls.push("session/new");
      if (failAt === "session/new") {
        throw new Error("adapter will not start");
      }
      return {
        sessionId: "fresh-acp-session",
        agentSessionId: "fresh-agent-session",
        models: {
          currentModelId: "default-model",
          availableModels: [
            { modelId: "default-model", name: "default-model" },
            { modelId: "sonnet", name: "sonnet" },
          ],
        },
      };
    },
    setSessionMode: async (_sessionId: string, modeId: string) => {
      calls.push(`mode=${modeId}`);
    },
    setSessionModel: async (_sessionId: string, modelId: string) => {
      calls.push(`model=${modelId}`);
      if (failAt === "model") {
        throw new Error("model unservable");
      }
    },
    setSessionConfigOption: async (_sessionId: string, configId: string, value: string) => {
      calls.push(`config:${configId}=${value}`);
      return { configOptions: [] };
    },
  });
  const controller = {
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => false,
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
  };
  const sleepingRecord = () =>
    makeSessionRecord(
      {
        acpxRecordId: "sleeping-unit",
        acpSessionId: "",
        agentCommand: "agent",
        cwd: process.cwd(),
        acpx: {
          sleeping: { since: "2026-11-09T10:00:00.000Z" },
          session_options: { model: "sonnet" },
          desired_mode_id: "plan",
          desired_config_options: { somepref: "on" },
        },
      },
      { defaultAcpx: false },
    );

  const record = sleepingRecord();
  await connectAndLoadSession({
    client: makeClient() as never,
    record,
    timeoutMs: 1_000,
    activeController: controller,
  });
  assert.deepEqual(calls, [
    "start",
    "session/new",
    "mode=plan",
    "model=sonnet",
    "config:somepref=on",
  ]);
  assert.equal(record.acpSessionId, "fresh-acp-session");
  assert.equal(record.agentSessionId, "fresh-agent-session");
  assert.equal(
    record.acpx?.sleeping,
    undefined,
    "sleeping deleted before the prompt frame is built",
  );

  // The twins: the adapter fails `session/new`, or the model.
  for (const failAt of ["session/new", "model"]) {
    calls.length = 0;
    const failing = sleepingRecord();
    const snapshot = JSON.stringify({ id: failing.acpSessionId, acpx: failing.acpx });
    await assert.rejects(
      connectAndLoadSession({
        client: makeClient(failAt) as never,
        record: failing,
        timeoutMs: 1_000,
        activeController: controller,
      }),
      (error: unknown) => {
        // Every failure inside the materialisation carries ONE code — atrium has a row for it.
        assert.equal(
          (error as { detailCode?: string }).detailCode,
          "SESSION_MATERIALISATION_FAILED",
          failAt,
        );
        assert.match((error as Error).message, /adapter will not start|model unservable/u);
        return true;
      },
    );
    assert.deepEqual(
      JSON.stringify({ id: failing.acpSessionId, acpx: failing.acpx }),
      snapshot,
      `${failAt}: the record is still sleeping, byte for byte`,
    );
  }
});

test("stray acpx.sleeping on a record that already RAN: the wake loads it (session/load), never session/new, acpSessionId unchanged, the flag removed and logged", async () => {
  const calls: string[] = [];
  const client = {
    hasReusableSession: () => false,
    start: async () => {
      calls.push("start");
    },
    markAdvertisement: () => 0,
    advertisedConfigOptionsSince: () => undefined,
    getAgentLifecycleSnapshot: () => ({ running: true }),
    supportsLoadSession: () => true,
    supportsResumeSession: () => false,
    loadSessionWithOptions: async () => {
      calls.push("session/load");
      return {};
    },
    createSession: async () => {
      calls.push("session/new");
      throw new Error("a record that already ran must never get a second session/new");
    },
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
  };
  const controller = {
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => false,
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
  };
  const record = makeSessionRecord(
    {
      acpxRecordId: "stray-sleeping-unit",
      acpSessionId: "fab74f21-real-acp-session",
      agentCommand: "agent",
      cwd: process.cwd(),
      acpx: { sleeping: { since: "2026-11-09T10:00:00.000Z" } },
    },
    { defaultAcpx: false },
  );
  const logged: string[] = [];
  const realHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-stray-sleeping-"));
  process.env.HOME = home; // the flag removal persists the record: keep it out of the real store
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logged.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: controller,
    });
  } finally {
    process.stderr.write = realWrite;
    if (realHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = realHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.ok(calls.includes("session/load"), calls.join(","));
  assert.ok(!calls.includes("session/new"), calls.join(","));
  assert.equal(record.acpSessionId, "fab74f21-real-acp-session", "the session id is unchanged");
  assert.equal(record.acpx?.sleeping, undefined, "the stray flag is removed");
  assert.ok(
    logged.some(
      (line) => line.includes("stray-sleeping-unit") && line.includes("stray acpx.sleeping"),
    ),
    `one log line names it: ${logged.join("|")}`,
  );
});

test("N-A2-6 twin · a materialisation failure fails the turn before it starts, leaves the session sleeping, and a later prompt wakes it", async () => {
  const f = makeBox({ requestMib: 4000, withMockExtraArgs: ["--set-session-model-fails"] });
  const run = await sleepingNew(f, [], ["--model", "sonnet"]);
  assert.equal(run.code, 0, run.stderr);
  const id = jsonOf(run).acpxRecordId;
  const wake = await runCli([...baseArgs(f), "prompt", "--session-id", id, "hello"], f.env, f.root);
  assert.notEqual(wake.code, 0, "the turn failed");
  const record = readRecord(f, id) as { acp_session_id: string; acpx: { sleeping?: unknown } };
  assert.equal(record.acp_session_id, "", "still not started");
  assert.ok(record.acpx.sleeping, "still sleeping");
  assert.equal(
    methods(f).includes("session/prompt"),
    false,
    "the prompt was never submitted — the failure is resend-safe",
  );
});

test("sleeping copy: nothing is forked at create; the fork notice is returned; the first wake forks the template, inherits its history and stamps template_last_used_at", async () => {
  const f = makeBox({ requestMib: 4000 });
  const template = await makeTarget(f);
  const warm = await runCli(
    [...baseArgs(f), "prompt", "--session-id", template, "hello template"],
    f.env,
    f.root,
  );
  assert.equal(warm.code, 0, warm.stderr);
  const afterWarm = methods(f).length;

  const run = await runCli(
    [
      ...baseArgs(f),
      "--format",
      "json",
      "sessions",
      "copy",
      "--from",
      template,
      "--sleeping",
      "--metadata",
      `template_source=${template}`,
      "--metadata",
      "fork_template_name=Nightly template",
    ],
    { ...f.env, ...AUTOMATION },
    f.root,
  );
  assert.equal(run.code, 0, run.stderr);
  const created = jsonOf(run) as Created & { forkNotice?: string };
  assert.equal(created.sleeping, true);
  assert.equal(created.promptQueued, false);
  assert.match(created.forkNotice ?? "", /^⟦FORK-NOTICE⟧\n/u);
  assert.equal(methods(f).length, afterWarm, "the sleeping copy asked the adapter for nothing");
  const sleeping = readRecord(f, created.acpxRecordId) as {
    acp_session_id: string;
    forked_from_session_id?: string;
    acpx: { sleeping?: { fork?: { from: string } } };
  };
  assert.equal(sleeping.acp_session_id, "");
  assert.equal(sleeping.acpx.sleeping?.fork?.from, template);
  assert.equal(sleeping.forked_from_session_id, template);
  const entries = JSON.parse(fs.readFileSync(path.join(sessionsDir(f), "index.json"), "utf8")) as {
    entries: Array<{ acpxRecordId: string; sleeping?: boolean; forkTemplate?: unknown }>;
  };
  const entry = entries.entries.find(
    (candidate) => candidate.acpxRecordId === created.acpxRecordId,
  );
  assert.equal(entry?.sleeping, true, "the index projection says sleeping");
  assert.deepEqual(entry?.forkTemplate, { id: template, name: "Nightly template" });

  const wake = await runCli(
    [...baseArgs(f), "prompt", "--session-id", created.acpxRecordId, "hello copy"],
    f.env,
    f.root,
  );
  assert.equal(wake.code, 0, wake.stderr);
  assert.ok(methods(f).slice(afterWarm).includes("session/fork"), methods(f).join(","));
  const woken = readRecord(f, created.acpxRecordId) as {
    acp_session_id: string;
    forked_at_message_index?: number;
    acpx: { sleeping?: unknown };
    metadata?: Record<string, string>;
  };
  assert.notEqual(woken.acp_session_id, "");
  assert.equal(woken.acpx.sleeping, undefined);
  assert.equal(woken.forked_at_message_index, 2, "the template's two messages were inherited");
  assert.ok(woken.metadata?.template_last_used_at, "the template's lastUsedAt, for traceability");
  assert.equal(woken.metadata?.template_source, template, "template_source is kept");
});

test("N-U2-14 · Q9: a template re-baked between the sleeping copy's create and its first wake — the first wake forks the RE-BAKED template (read at wake), template_source kept, template_last_used_at stamped", async () => {
  const f = makeBox({ requestMib: 4000 });
  const template = await makeTarget(f);
  const prompt = async (id: string, text: string) => {
    const run = await runCli([...baseArgs(f), "prompt", "--session-id", id, text], f.env, f.root);
    assert.equal(run.code, 0, run.stderr);
  };
  await prompt(template, "bake one");
  const baked = readRecord(f, template) as { last_used_at: string };

  const run = await runCli(
    [
      ...baseArgs(f),
      "--format",
      "json",
      "sessions",
      "copy",
      "--from",
      template,
      "--sleeping",
      "--metadata",
      `template_source=${template}`,
    ],
    { ...f.env, ...AUTOMATION },
    f.root,
  );
  assert.equal(run.code, 0, run.stderr);
  const copyId = jsonOf(run).acpxRecordId;

  // The re-bake: the template runs another turn AFTER the sleeping copy exists.
  await new Promise((resolve) => setTimeout(resolve, 25));
  await prompt(template, "bake two");
  const rebaked = readRecord(f, template) as { last_used_at: string; acp_session_id: string };
  assert.notEqual(
    rebaked.last_used_at,
    baked.last_used_at,
    "control: the re-bake moved the template",
  );
  const afterRebake = methods(f).length;

  await prompt(copyId, "hello copy");
  const woken = readRecord(f, copyId) as {
    acp_session_id: string;
    forked_from_session_id?: string;
    forked_at_message_index?: number;
    acpx: { sleeping?: unknown };
    metadata?: Record<string, string>;
  };
  assert.ok(methods(f).slice(afterRebake).includes("session/fork"), methods(f).join(","));
  assert.equal(woken.acpx.sleeping, undefined);
  assert.equal(woken.forked_from_session_id, template);
  assert.equal(
    woken.forked_at_message_index,
    4,
    "the copy inherited the RE-BAKED template's four messages — a pin at create time would give two",
  );
  assert.equal(
    woken.metadata?.template_last_used_at,
    rebaked.last_used_at,
    "stamped from the template as it is at the first wake, not as it was at the create",
  );
  assert.equal(woken.metadata?.template_source, template, "template_source is kept");
});

test("N-A2-7 · G7 audit: a sleeping SOURCE is refused by copy/fork — 'nothing to copy yet — it has never run'; transcript reap and dedup skip a sleeping record", async () => {
  const f = makeBox({ requestMib: 4000 });
  const run = await sleepingNew(f);
  assert.equal(run.code, 0, run.stderr);
  const id = jsonOf(run).acpxRecordId;
  const before = census(f);
  for (const env of [f.env, { ...f.env, ...AUTOMATION }]) {
    const copy = await runCli([...baseArgs(f), "sessions", "copy", "--from", id], env, f.root);
    assert.notEqual(copy.code, 0);
    assert.match(copy.stderr, /nothing to copy yet — it has never run/u);
  }
  assert.deepEqual(census(f), before, "the refused copy created nothing");

  // reap: a sleeping record has no transcript to reap or keep.
  const sleepingRecord = makeSessionRecord(
    {
      acpxRecordId: id,
      acpSessionId: "",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: f.root,
    },
    { defaultAcpx: false },
  );
  const summary = await reapLeftBehindTranscripts({ record: sleepingRecord });
  assert.deepEqual(summary.files, []);
  assert.deepEqual(summary.skipped, ["not-started"]);

  // dedup: a dry run over a store holding the sleeping record neither fails nor names it.
  const dedup = await runCli(["--format", "json", "transcripts", "dedup"], f.env, f.root);
  assert.equal(dedup.code, 0, dedup.stderr);
  assert.doesNotMatch(dedup.stdout + dedup.stderr, new RegExp(id, "u"));
});

test("N-A2-8 · §6.2: an ownerless `set model|mode|effort` on a sleeping record writes the pins only — nothing connects", async () => {
  const f = makeBox({ requestMib: 2048 }); // a FULL box: a connect would be refused (exit 75)
  const run = await sleepingNew(f);
  assert.equal(run.code, 0, run.stderr);
  const id = jsonOf(run).acpxRecordId;
  const startsBefore = agentStarts(f);

  const model = await runCli(
    [...baseArgs(f), "--format", "json", "set", "model", "sonnet", "--session-id", id],
    asAgent(f),
    f.root,
  );
  assert.equal(model.code, 0, model.stderr);
  const mode = await runCli(
    [...baseArgs(f), "--format", "json", "set-mode", "plan", "--session-id", id],
    asAgent(f),
    f.root,
  );
  assert.equal(mode.code, 0, mode.stderr);
  assert.equal(agentStarts(f), startsBefore, "no adapter started");
  assert.deepEqual(operations(f), []);
  const record = readRecord(f, id) as {
    acp_session_id: string;
    acpx: {
      sleeping?: unknown;
      session_options?: { model?: string };
      desired_mode_id?: string;
    };
  };
  assert.equal(record.acp_session_id, "");
  assert.ok(record.acpx.sleeping, "still sleeping");
  assert.equal(record.acpx.session_options?.model, "sonnet");
  assert.equal(record.acpx.desired_mode_id, "plan");
  assert.deepEqual(leaseFiles(f), ["caller.lock"]);
});

test("status, sessions list and seats show say a sleeping session is sleeping — not dead, not idle", async () => {
  const f = makeBox({ requestMib: 4000 });
  const run = await sleepingNew(f, ["-s", "nightly-rebake"]);
  assert.equal(run.code, 0, run.stderr);
  const created = jsonOf(run) as Created & { seatId: string };
  const text = "sleeping — no agent has run yet; its first message wakes it";

  const status = await runCli(
    [...baseArgs(f), "status", "--session-id", created.acpxRecordId],
    f.env,
    f.root,
  );
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, new RegExp(`status: ${text}`, "u"));
  const statusJson = await runCli(
    [...baseArgs(f), "--format", "json", "status", "--session-id", created.acpxRecordId],
    f.env,
    f.root,
  );
  const parsed = JSON.parse(statusJson.stdout.trim().split("\n").at(-1) ?? "{}") as {
    status: string;
    summary: string;
  };
  assert.equal(parsed.status, "sleeping");
  assert.equal(parsed.summary, text);

  const list = await runCli([...baseArgs(f), "sessions", "list", "--local"], f.env, f.root);
  assert.match(list.stdout, new RegExp(`${created.acpxRecordId} \\[sleeping\\]`, "u"));

  const seat = await runCli([...baseArgs(f), "seats", "show", created.seatId], f.env, f.root);
  assert.equal(seat.code, 0, seat.stderr);
  assert.ok(seat.stdout.includes(text), seat.stdout);
  assert.equal(fs.existsSync(recordPath(f, created.acpxRecordId)), true);
});

test("closing a sleeping session starts no adapter and leaves a closed record that reopens as sleeping (AC13: a close ends held mail, the session stays closed)", async () => {
  const f = makeBox({ requestMib: 2048 });
  const run = await sleepingNew(f);
  assert.equal(run.code, 0, run.stderr);
  const id = jsonOf(run).acpxRecordId;
  const closed = await runCli(
    [...baseArgs(f), "sessions", "close", "--session-id", id],
    f.env,
    f.root,
  );
  assert.equal(closed.code, 0, closed.stderr);
  assert.equal(agentStarts(f), 0, "closing never spawned an adapter");
  const record = readRecord(f, id) as {
    closed?: boolean;
    acp_session_id: string;
    acpx: { sleeping?: unknown };
  };
  assert.equal(record.closed, true);
  assert.equal(record.acp_session_id, "");
  assert.ok(record.acpx.sleeping, "a closed sleeping session is still a session that never ran");
  const reopened = await runCli([...baseArgs(f), "sessions", "reopen", id], f.env, f.root);
  assert.equal(reopened.code, 0, reopened.stderr);
  assert.equal((readRecord(f, id) as { closed?: boolean }).closed, false);
});

test("the index projection: sleeping, createdBy (kind/label/ref from three metadata strings) and forkTemplate survive the index file; a bad createdBy kind is absent", async () => {
  const { toSessionIndexEntry, readSessionIndex, writeSessionIndex } =
    await import("../src/session/persistence/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-index-projection-"));
  try {
    const base = {
      acpxRecordId: "projection-1",
      acpSessionId: "",
      agentCommand: "agent",
      cwd: dir,
    };
    const record = makeSessionRecord(
      {
        ...base,
        acpx: { sleeping: { since: "2026-11-09T10:00:00.000Z", fork: { from: "tpl-1" } } },
        metadata: {
          created_by_kind: "wakeup",
          created_by_label: "nightly-rebake",
          created_by_ref: "wk_0f3d9b2c",
          template_source: "tpl-1",
          fork_template_name: "Nightly template",
        },
      },
      { defaultAcpx: false },
    );
    const entry = toSessionIndexEntry(record, "projection-1.json");
    assert.equal(entry.sleeping, true);
    assert.deepEqual(entry.createdBy, {
      kind: "wakeup",
      label: "nightly-rebake",
      ref: "wk_0f3d9b2c",
    });
    assert.deepEqual(entry.forkTemplate, { id: "tpl-1", name: "Nightly template" });
    await writeSessionIndex(dir, { files: ["projection-1.json"], entries: [entry] });
    const back = (await readSessionIndex(dir))?.entries[0];
    assert.equal(back?.sleeping, true, "BOTH index legs carry sleeping");
    assert.deepEqual(back?.createdBy, entry.createdBy, "…and createdBy");
    assert.deepEqual(back?.forkTemplate, entry.forkTemplate, "…and forkTemplate");

    const bad = toSessionIndexEntry(
      makeSessionRecord(
        {
          ...base,
          metadata: { created_by_kind: "cron", created_by_label: "x", created_by_ref: "y" },
        },
        { defaultAcpx: false },
      ),
      "projection-1.json",
    );
    assert.equal(bad.createdBy, undefined, "an unknown kind is absent, never guessed");
    assert.equal(bad.sleeping, undefined, "an ordinary record is not sleeping");
    assert.equal(bad.forkTemplate, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
