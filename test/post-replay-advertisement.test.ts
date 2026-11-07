import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { AcpClient } from "../src/acp/client.js";
import {
  connectAndLoadSession,
  type ConnectedSessionController,
} from "../src/runtime/engine/reconnect.js";
import { queuePaths } from "./queue-test-helpers.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
} from "./runtime-test-helpers.js";

// brick e0fc06d8 (DESIGN-R2 §B) — after the replay, `connectAndLoadSession` stores the LAST list the
// adapter advertised during THIS connect (GB1), never one from before it began (GB2).
//
// ⚠️ The queue-owner rows classify the mock as claude with `--claude-agent-acp`, an adapter-named
// flag (round-1 N2 in test/record-only-set.test.ts). That is a SYNTHETIC command shape — no real
// record carries it (acpx PROJECT.md). The real-path rows (RB1–RB5) run the real adapter:
// /wisdom/Bricks/e0fc06d8-d85d-4a0f-9e06-58e316a5946f/impl/TESTER-PLAN.md.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

// test/mock-agent.ts: `sonnet` gets the compact ladder, `default-model` the opus one — so the ladder
// alone tells which model a stored list describes.
const COMPACT_LADDER = ["low", "medium", "high"];
const OPUS_LADDER = ["default", "low", "medium", "high", "xhigh", "max"];

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

function claudeList(model: string, ladder: readonly string[]): SessionConfigOption[] {
  return [
    select("model", "model", model, ["default", "opus", "sonnet", "haiku"]),
    select("effort", "thought_level", ladder.includes("high") ? "high" : "medium", ladder),
  ];
}

// ---------------------------------------------------------------------------------------------
// NB2 (GB2) — a list advertised before the current connect began is never stored
// ---------------------------------------------------------------------------------------------

type ClientInternals = {
  handleSessionUpdate: (notification: unknown) => Promise<void>;
};

function realClient(): AcpClient {
  return new AcpClient({
    agentCommand: `node ${MOCK_AGENT_PATH}`,
    cwd: process.cwd(),
    permissionMode: "approve-reads",
  });
}

async function push(client: AcpClient, configOptions: SessionConfigOption[]): Promise<void> {
  await (client as unknown as ClientInternals).handleSessionUpdate({
    sessionId: "s",
    update: { sessionUpdate: "config_option_update", configOptions },
  });
}

test("NB2 GB2: advertisedConfigOptionsSince(mark) is undefined until a list is stored AFTER the mark", async () => {
  const client = realClient();
  const stale = claudeList("opus", OPUS_LADDER);
  const fresh = claudeList("sonnet", COMPACT_LADDER);

  await push(client, stale);
  const mark = client.markAdvertisement();
  // The trap's premise: the client still holds the earlier list.
  assert.deepEqual(client.getAdvertisedConfigOptions(), stale);
  assert.equal(client.advertisedConfigOptionsSince(mark), undefined, "a pre-mark list leaked");

  // An empty push is not an advertisement (rememberConfigOptions ignores it).
  await push(client, []);
  assert.equal(client.advertisedConfigOptionsSince(mark), undefined, "an empty push moved it");

  await push(client, fresh);
  assert.deepEqual(client.advertisedConfigOptionsSince(mark), fresh);
});

const ACTIVE_CONTROLLER: ConnectedSessionController = {
  hasActivePrompt: () => false,
  requestCancelActivePrompt: async () => false,
  setSessionMode: async () => {},
  setSessionModel: async () => {},
  setSessionConfigOption: async () => ({ configOptions: [] }),
};

/** A resume-capable fake whose advertisement history is a REAL AcpClient's. */
function reusedClientFake(params: {
  real: AcpClient;
  resumeList: SessionConfigOption[];
  onSetConfigOption?: (configId: string, value: string) => Promise<SessionConfigOption[]>;
}) {
  const configCalls: string[] = [];
  const client = {
    hasReusableSession: () => false,
    start: async () => {},
    markAdvertisement: () => params.real.markAdvertisement(),
    advertisedConfigOptionsSince: (mark: number) => params.real.advertisedConfigOptionsSince(mark),
    getAgentLifecycleSnapshot: () => ({ running: true }),
    supportsLoadSession: () => false,
    supportsResumeSession: () => true,
    // Like the real client, a resume response is returned, not remembered (client.ts resumeSession).
    resumeSession: async () => ({
      agentSessionId: "runtime-session",
      configOptions: params.resumeList,
    }),
    loadSessionWithOptions: async () => {
      throw new Error("loadSessionWithOptions should not be called");
    },
    createSession: async () => {
      throw new Error("createSession should not be called");
    },
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async (_sessionId: string, configId: string, value: string) => {
      configCalls.push(`${configId}=${value}`);
      return { configOptions: (await params.onSetConfigOption?.(configId, value)) ?? [] };
    },
  };
  return { client, configCalls };
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-post-replay-adv-", run);
}

test("NB2 GB2: a reused client holding a stale list, a resume and nothing to replay — the record keeps the RESUME list", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fsp.mkdir(cwd, { recursive: true });
    const real = realClient();
    const stale = claudeList("opus", OPUS_LADDER);
    await push(real, stale);
    const resumeList = claudeList("default", OPUS_LADDER);
    const record = makeSessionRecordFixture(
      {
        acpxRecordId: "nb2-record",
        acpSessionId: "nb2-session",
        agentCommand: "agent",
        cwd,
      },
      { defaultAcpx: false },
    );
    const { client, configCalls } = reusedClientFake({ real, resumeList });

    await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.deepEqual(configCalls, [], "the control replayed something");
    assert.deepEqual(
      record.acpx?.config_options,
      resumeList,
      "a list advertised before this connect was stored",
    );
  });
});

test("NB2 GB1 control: the same reused client, and a replay that re-advertises — the record keeps the REPLAY's list", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fsp.mkdir(cwd, { recursive: true });
    const real = realClient();
    await push(real, claudeList("opus", OPUS_LADDER));
    const resumeList = claudeList("default", OPUS_LADDER);
    const replayed = claudeList("sonnet", COMPACT_LADDER);
    const record = makeSessionRecordFixture(
      {
        acpxRecordId: "nb2-replay-record",
        acpSessionId: "nb2-replay-session",
        agentCommand: "agent",
        cwd,
        acpx: { desired_config_options: { effort: "low" } },
      },
      { defaultAcpx: false },
    );
    const { client, configCalls } = reusedClientFake({
      real,
      resumeList,
      onSetConfigOption: async () => {
        await push(real, replayed);
        return replayed;
      },
    });

    await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.deepEqual(configCalls, ["effort=low"]);
    assert.deepEqual(record.acpx?.config_options, replayed);
  });
});

// ---------------------------------------------------------------------------------------------
// NB1 (GB1, through a REAL turn) and NB3 (GB1 on the direct path) — queue owner + mock adapter
// ---------------------------------------------------------------------------------------------

type Home = { root: string; env: NodeJS.ProcessEnv; ops: string; agent: string };

function makeHome(): Home {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-post-replay-adv-"));
  fs.mkdirSync(path.join(root, ".acpx", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, "work"));
  const ops = path.join(root, "ops.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    ACPX_STATE_HOME: root,
    ACPX_ADMISSION_DIR: path.join(root, "admission"),
    ACPX_CAPACITY_PODINFO_DIR: path.join(root, "no-podinfo"),
    // The owner's release after the last turn (checked every 5 s): released at its first check.
    ACPX_OWNER_IDLE_RELEASE_MS: "1",
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
  // `--push-config-on-set-model` is what claude-agent-acp 356a1ed and pi-acp do (MEASUREMENT P1).
  const agent = `node ${JSON.stringify(MOCK_AGENT_PATH)} --claude-agent-acp --advertise-models --advertise-config-options --supports-resume-session --push-config-on-set-model --log-config-option-ops --operation-log ${JSON.stringify(ops)}`;
  return { root, env, ops, agent };
}

type Run = { code: number | null; stdout: string; stderr: string };

function runCli(home: Home, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, "--agent", home.agent, ...args], {
      env: home.env,
      cwd: home.root,
      stdio: "pipe",
    });
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

type Op = { method?: string; modelId?: string; configId?: string; value?: unknown };

function readOps(home: Home): Op[] {
  try {
    return fs
      .readFileSync(home.ops, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Op);
  } catch {
    return [];
  }
}

async function newSession(home: Home): Promise<string> {
  const sessions = path.join(home.root, ".acpx", "sessions");
  const before = new Set(fs.readdirSync(sessions));
  const created = await runCli(home, ["--cwd", path.join(home.root, "work"), "sessions", "new"]);
  assert.equal(created.code, 0, created.stderr);
  const file = fs
    .readdirSync(sessions)
    .find((name) => /^[0-9a-f-]{36}\.json$/u.test(name) && !before.has(name));
  assert.ok(file, "sessions new wrote a record");
  return file.replace(/\.json$/u, "");
}

/** A turn through the queue owner, then wait until its idle release removed the lease. */
async function turnThenRelease(home: Home, id: string, text: string): Promise<void> {
  const turn = await runCli(home, ["prompt", "--session-id", id, text]);
  assert.equal(turn.code, 0, turn.stderr);
  const { lockPath } = queuePaths(home.root, id);
  const deadline = Date.now() + 30_000;
  while (fs.existsSync(lockPath)) {
    assert.ok(Date.now() < deadline, `the owner of ${id} never released its lease`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function set(home: Home, id: string, args: string[]): Promise<Record<string, unknown>> {
  const run = await runCli(home, ["--format", "json", "set", ...args, "--session-id", id]);
  assert.equal(run.code, 0, `${args.join(" ")}: ${run.stderr}`);
  return lastJson(run);
}

/** The stored advertisement, read from the root-anchored on-disk path `.acpx.config_options`. */
function storedList(home: Home, id: string): SessionConfigOption[] {
  const disk = JSON.parse(
    fs.readFileSync(path.join(home.root, ".acpx", "sessions", `${id}.json`), "utf8"),
  ) as { acpx?: { config_options?: SessionConfigOption[] } };
  return disk.acpx?.config_options ?? [];
}

function option(list: SessionConfigOption[], id: string) {
  const found = list.find((entry) => entry.id === id) as
    | { currentValue?: unknown; options?: Array<{ value: string }> }
    | undefined;
  return {
    currentValue: found?.currentValue,
    values: (found?.options ?? []).map((entry) => entry.value),
  };
}

test("NB1 GB1: a record-only model pin, then a REAL turn — the record names the served model and its ladder, so the next ownerless depth pick is record-only", async () => {
  const home = makeHome();
  const id = await newSession(home);
  await turnThenRelease(home, id, "one");

  assert.equal((await set(home, id, ["model", "sonnet"])).validatedAgainst, "record");
  // Planted positive for the path below: before the turn it reads the resume's model, not null.
  assert.equal(option(storedList(home, id), "model").currentValue, "default-model");
  assert.deepEqual(option(storedList(home, id), "effort").values, OPUS_LADDER);

  const opsBeforeTurn = readOps(home).length;
  await turnThenRelease(home, id, "two");
  const served = readOps(home).slice(opsBeforeTurn);
  assert.ok(
    served.some((op) => op.method === "session/set_model" && op.modelId === "sonnet"),
    `the turn's connect did not replay the pin: ${JSON.stringify(served)}`,
  );

  const after = storedList(home, id);
  assert.equal(option(after, "model").currentValue, "sonnet", "the record names the resume list");
  assert.deepEqual(option(after, "effort").values, COMPACT_LADDER);

  const opsAtSet = readOps(home).length;
  assert.equal((await set(home, id, ["effort", "low"])).validatedAgainst, "record");
  assert.equal(readOps(home).length, opsAtSet, "the depth pick reached an adapter");
});

test("NB3 GB1 direct path: an ownerless LIVE depth pick on a stale record heals it, so the next one is record-only", async () => {
  const home = makeHome();
  const id = await newSession(home);
  // A record-only model pin leaves the stored list naming `default-model` (stale, F3 by design).
  assert.equal((await set(home, id, ["model", "sonnet"])).validatedAgainst, "record");

  const opsAtLive = readOps(home).length;
  assert.equal((await set(home, id, ["effort", "low"])).validatedAgainst, "adapter");
  const live = readOps(home).slice(opsAtLive);
  assert.ok(
    live.some((op) => op.method === "session/set_model" && op.modelId === "sonnet"),
    `the live set's connect did not replay the pin: ${JSON.stringify(live)}`,
  );
  assert.equal(option(storedList(home, id), "model").currentValue, "sonnet");

  const opsAtSet = readOps(home).length;
  assert.equal((await set(home, id, ["effort", "medium"])).validatedAgainst, "record");
  assert.equal(readOps(home).length, opsAtSet, "the second depth pick reached an adapter");
});
