// brick 6e27669f (DESIGN-R2 §A) — a settings change never kills a queued prompt.
//
// Before the fix every settings verb SIGTERMed a live queue owner after its record write, so the
// next prompt cold-respawned with the new value. A prompt the owner had already dequeued (held in
// a local variable, invisible to `queryActiveTurn` and to the queue depth) or whose turn was just
// starting died with `Queue owner disconnected before prompt completion`. Now a live owner is never
// stopped: at its next turn start it sees the record's settings differ from those its client was
// built from and rebuilds that client in place. (Brick 1281e50e removed the transition scaffolding:
// the lease marker `settingsRebind` and the legacy recycle of pre-fix owners.)
//
//   NA1 GA1      all 8 verbs: an idle owner survives; the no-lease case keeps its recycle result
//   NA2 GA1      structural: no setter stops an owner except through `bindSettingsChange`
//   NA3 GA2      the pre-turn policy asks for the rebind exactly when the binding differs
//   NA4 GA1+GA2  real owner + mock adapter: `set effort` / `set model` → the SAME owner rebinds
//   NA5 GA1      a pending output style keeps a prompt queued behind the turn alive
//   NA6 GA1      a record-only set talks to no owner at all
//   NA7 guard    every lease this build writes carries `settingsRebind:1` (rollback guard, never read)
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AcpClient } from "../src/acp/client.js";
import type { QueueTask } from "../src/cli/queue/ipc-server.js";
import {
  isProcessAlive,
  readQueueOwnerProcessIdentity,
  readQueueOwnerRecord,
  refreshQueueOwnerLease,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/lease-store.js";
import { isIdleDrainActivity } from "../src/cli/session/queue-owner-runtime.js";
import { applyQueuedTaskSubscriptionLockPolicy } from "../src/cli/session/runtime.js";
import {
  bindSettingsChange,
  setSessionAutoFailover,
  setSessionAutoSubscription,
  setSessionConfigOption,
  setSessionFableDegrade,
  setSessionModel,
  setSessionOutputStyle,
  setSessionProfile,
  setSessionSubscription,
} from "../src/cli/session/session-control.js";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { resolveSessionRecord } from "../src/session/persistence/repository.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { bindTurnOwnWrites, settingsBindingFingerprint } from "../src/session/settings-binding.js";
import type { SessionAcpxState, SessionRecord } from "../src/types.js";
import {
  closeServer,
  createSingleRequestServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

const SRC_DIR = fileURLToPath(new URL("../../src/", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
// Claude-shaped, so the account seam (`set profile`) accepts the record. Nothing is spawned: the
// planted owner answers every request over its socket.
const CLAUDE_CMD = "node /opt/claude-agent-acp/dist/index.js";

type Keeper = Awaited<ReturnType<typeof startKeeperProcess>>;
type OwnerRequest = { type: string; requestId: string; modelId?: string };

function recordingOwner(requests: OwnerRequest[]): ReturnType<typeof createSingleRequestServer> {
  return createSingleRequestServer((socket, request) => {
    requests.push(request as OwnerRequest);
    socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
    if (request.type === "query_active_turn") {
      socket.write(
        `${JSON.stringify({ type: "query_active_turn_result", requestId: request.requestId, active: false })}\n`,
      );
    } else if (request.type === "set_config_option") {
      socket.write(
        `${JSON.stringify({ type: "set_config_option_result", requestId: request.requestId, response: { configOptions: [] } })}\n`,
      );
    } else if (request.type === "set_model") {
      socket.write(
        `${JSON.stringify({ type: "set_model_result", requestId: request.requestId, modelId: (request as OwnerRequest).modelId ?? "" })}\n`,
      );
    }
    socket.end();
  });
}

async function plantOwner(
  homeDir: string,
  sessionId: string,
  server: ReturnType<typeof createSingleRequestServer>,
  withMarker = false,
): Promise<Keeper> {
  const keeper = await startKeeperProcess();
  const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
  await listenServer(server, socketPath);
  const processIdentity = keeper.pid ? await readQueueOwnerProcessIdentity(keeper.pid) : undefined;
  await writeQueueOwnerLock({ lockPath, pid: keeper.pid, sessionId, socketPath, processIdentity });
  if (withMarker) {
    // The marker this build writes on every lease (NA7).
    const lease = JSON.parse(await fsp.readFile(lockPath, "utf8")) as Record<string, unknown>;
    await fsp.writeFile(lockPath, `${JSON.stringify({ ...lease, settingsRebind: 1 })}\n`, "utf8");
  }
  return keeper;
}

async function seedSession(homeDir: string, sessionId: string, acpx: SessionAcpxState) {
  const file = path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(sessionId)}.json`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const record = makeSessionRecord({
    acpxRecordId: sessionId,
    acpSessionId: `${sessionId}-acp`,
    agentCommand: CLAUDE_CMD,
    cwd: homeDir,
    acpx,
  });
  await fsp.writeFile(file, `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`);
}

/** Two claude profiles (subA, subB) with config dirs, so `set profile/subscription` can switch. */
async function seedRegistry(homeDir: string): Promise<{ homeDir: string; registryPath: string }> {
  const subsDir = path.join(homeDir, ".acpx", "subscriptions");
  const registryPath = path.join(subsDir, "registry.json");
  const profiles = ["subA", "subB"].map((id) => {
    fs.mkdirSync(path.join(subsDir, id), { recursive: true });
    return {
      id,
      label: id,
      authMode: "subscription",
      adapter: "claude",
      account: `acct-${id}`,
      credentialSource: path.join(subsDir, id),
    };
  });
  await fsp.writeFile(registryPath, `${JSON.stringify({ version: 3, profiles })}\n`, {
    mode: 0o600,
  });
  return { homeDir, registryPath };
}

type SetterResult = { ownerRestarted?: boolean; ownerRebind?: string };
type Verb = {
  verb: string;
  acpx: SessionAcpxState;
  run: (
    sessionId: string,
    loadOpts: { homeDir: string; registryPath: string },
  ) => Promise<SetterResult>;
  written: (record: SessionRecord) => unknown;
  expected: unknown;
};

// ⚠️ ONE ROW PER SETTINGS VERB THAT USED TO RECYCLE THE OWNER — the carrier comment in
// src/session/settings-binding.ts points here. A new such verb needs a row and a fingerprint field.
const VERBS: Verb[] = [
  {
    verb: "set model",
    acpx: {},
    run: async (sessionId) =>
      await setSessionModel({ sessionId, modelId: "sonnet", recycleOwner: true }),
    written: (r) => r.acpx?.session_options?.model,
    expected: "sonnet",
  },
  {
    verb: "set effort",
    acpx: {},
    run: async (sessionId) =>
      await setSessionConfigOption({
        sessionId,
        configId: "effort",
        value: "low",
        recycleOwner: true,
      }),
    written: (r) => r.acpx?.desired_config_options?.effort,
    expected: "low",
  },
  {
    verb: "set outputStyle",
    acpx: { applied_output_style: "default" },
    run: async (sessionId) =>
      await setSessionOutputStyle({ sessionId, outputStyle: "Explanatory" }),
    written: (r) => r.acpx?.session_options?.output_style,
    expected: "Explanatory",
  },
  {
    verb: "set profile",
    acpx: { session_options: { profile: "subA" } },
    run: async (sessionId, loadOpts) =>
      await setSessionProfile({ sessionId, profileId: "subB", loadOpts }),
    written: (r) => r.acpx?.session_options?.profile,
    expected: "subB",
  },
  {
    verb: "set subscription",
    acpx: { session_options: { subscription: "subA" } },
    run: async (sessionId, loadOpts) =>
      await setSessionSubscription({ sessionId, subscriptionId: "subB", loadOpts }),
    written: (r) => r.acpx?.session_options?.subscription,
    expected: "subB",
  },
  {
    verb: "set auto-failover",
    acpx: {},
    run: async (sessionId) => await setSessionAutoFailover({ sessionId, autoFailover: false }),
    written: (r) => r.acpx?.session_options?.auto_failover,
    expected: false,
  },
  {
    verb: "set auto-subscription",
    acpx: {},
    run: async (sessionId) =>
      await setSessionAutoSubscription({ sessionId, autoSubscription: false }),
    written: (r) => r.acpx?.session_options?.auto_subscription,
    expected: false,
  },
  {
    verb: "set fable-degrade",
    acpx: {},
    run: async (sessionId) => await setSessionFableDegrade({ sessionId, fableDegradeOk: true }),
    written: (r) => r.acpx?.session_options?.fable_degrade_ok,
    expected: true,
  },
];

// ---------------------------------------------------------------------------------------------
// NA1 — every verb, both lease kinds
// ---------------------------------------------------------------------------------------------

// This build never READS the lease marker, so a lease without it (a plain planted lease) and one
// carrying `settingsRebind:1` (what this build writes, NA7) must behave the same — neither shape
// can fall into a third behaviour.
for (const withMarker of [false, true]) {
  test(`NA1 GA1: all 8 settings verbs on a live idle owner (lease ${withMarker ? "carrying the marker" : "without a marker"})`, async () => {
    assert.equal(VERBS.length, 8, "the verb table names every settings verb");
    for (const row of VERBS) {
      await withTempHome(async (homeDir) => {
        const sessionId = `na1-${withMarker ? "marked" : "plain"}-${row.verb.replace(/\W+/g, "-")}`;
        const loadOpts = await seedRegistry(homeDir);
        await seedSession(homeDir, sessionId, row.acpx);
        const requests: OwnerRequest[] = [];
        const server = recordingOwner(requests);
        const keeper = await plantOwner(homeDir, sessionId, server, withMarker);
        const { lockPath } = queuePaths(homeDir, sessionId);
        const generation = () =>
          (JSON.parse(fs.readFileSync(lockPath, "utf8")) as { ownerGeneration: number })
            .ownerGeneration;
        const before = generation();
        try {
          const result = await row.run(sessionId, loadOpts);
          assert.equal(row.written(await resolveSessionRecord(sessionId)), row.expected, row.verb);
          assert.equal(result.ownerRestarted, false, `${row.verb}: ${JSON.stringify(result)}`);
          assert.equal(result.ownerRebind, "next-turn", row.verb);
          await new Promise((resolve) => setTimeout(resolve, 100));
          assert.equal(isProcessAlive(keeper.pid), true, `${row.verb}: the owner was stopped`);
          assert.equal(generation(), before, `${row.verb}: the lease changed hands`);
        } finally {
          await closeServer(server);
          stopProcess(keeper);
        }
      });
    }
  });
}

test("NA1 GA1: with no lease at all (the owner already gone) bindSettingsChange keeps its recycle result", async () => {
  await withTempHome(async () => {
    const result = await bindSettingsChange("na1-no-lease");
    assert.equal(result.ownerRestarted, true, JSON.stringify(result));
    assert.equal(result.ownerRebind, undefined, "the no-lease result grew an ownerRebind");
  });
});

// ---------------------------------------------------------------------------------------------
// NA2 — structural: the stop lives in ONE place
// ---------------------------------------------------------------------------------------------

/** The `{ … }` body of `function <name>(…): Promise<…> {` in `source`, by brace matching. */
function functionBody(source: string, name: string): { start: number; end: number } {
  const head = source.indexOf(`function ${name}(`);
  assert.ok(head >= 0, `function ${name} not found`);
  // Both functions read here return a `Promise<…>`, so the body opens at the first `> {`.
  const index = source.indexOf("> {", head) + 2;
  let depth = 0;
  for (let cursor = index; cursor < source.length; cursor += 1) {
    if (source[cursor] === "{") {
      depth += 1;
    } else if (source[cursor] === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start: index, end: cursor };
      }
    }
  }
  return assert.fail(`unbalanced body for ${name}`);
}

/** Every `recycleLiveOwner(` call outside `bindSettingsChange` — the definition excepted. */
function strayOwnerStops(source: string): number[] {
  const allowed = functionBody(source, "bindSettingsChange");
  const stray: number[] = [];
  for (let at = source.indexOf("recycleLiveOwner("); at >= 0; ) {
    const isDefinition = source.slice(Math.max(0, at - 15), at).endsWith("function ");
    if (!isDefinition && (at < allowed.start || at > allowed.end)) {
      stray.push(source.slice(0, at).split("\n").length);
    }
    at = source.indexOf("recycleLiveOwner(", at + 1);
  }
  return stray;
}

test("NA2 GA1: in session-control.ts every owner stop sits inside bindSettingsChange", async () => {
  const source = await fsp.readFile(path.join(SRC_DIR, "cli/session/session-control.ts"), "utf8");
  assert.deepEqual(strayOwnerStops(source), [], "a setter stops the owner directly");
  // The instrument bites: a fresh setter with a bare stop is flagged without being registered.
  const planted = `${source}\nexport async function setSessionNewThing(id: string) {\n  return await recycleLiveOwner(id);\n}\n`;
  assert.equal(strayOwnerStops(planted).length, 1, "the guard did not flag a planted bare stop");
});

test("NA2 GA1: the owner's turn-boundary exit and idle release name no settings change", async () => {
  const source = await fsp.readFile(
    path.join(SRC_DIR, "cli/session/queue-owner-runtime.ts"),
    "utf8",
  );
  const exits = source.match(/^\s*if \(recycleOwnerAfterTask.*$/gm) ?? [];
  assert.deepEqual(
    exits.map((line) => line.trim()),
    ["if (recycleOwnerAfterTask) {"],
    "the turn-boundary exit grew a second condition",
  );
  const release = functionBody(source, "decideIdleOwnerRelease");
  assert.doesNotMatch(source.slice(release.start, release.end), /outputStyle|output-style/i);
  assert.match(
    source,
    /^export type IdleOwnerReleaseReason = "deploy-staleness" \| "idle-memory";$/m,
    "the release reasons changed — an output-style reason would bring the exit back",
  );
});

// ---------------------------------------------------------------------------------------------
// NA3 — the pre-turn policy
// ---------------------------------------------------------------------------------------------

test("NA3 GA2: the pre-turn policy rebinds exactly when the binding differs, and never recycles", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "na3-policy";
    await seedSession(homeDir, sessionId, { session_options: { model: "sonnet" } });
    const fresh = { fresh: true } as unknown as AcpClient;
    for (const row of [
      { differs: true, replacement: fresh },
      { differs: false, replacement: fresh },
      { differs: true, replacement: undefined },
    ]) {
      const reasons: unknown[] = [];
      let recycled = 0;
      let seen: SessionRecord | undefined;
      const policy = await applyQueuedTaskSubscriptionLockPolicy(
        sessionId,
        {
          settingsBindingDiffers: (record) => {
            seen = record;
            return row.differs;
          },
          replaceSharedClient: async (reason) => {
            reasons.push(reason);
            return row.replacement;
          },
          onFailoverSwitched: () => {
            recycled += 1;
          },
        },
        // The turn-start cwd check (brick 45917618) reads the task only to write a failed
        // terminal for a missing folder; this record's cwd is the temp HOME, which exists.
        [{ requestId: "na3-task" } as unknown as QueueTask],
      );
      const label = JSON.stringify({
        differs: row.differs,
        replaced: row.replacement !== undefined,
      });
      assert.equal(seen?.acpx?.session_options?.model, "sonnet", `${label}: fresh record`);
      assert.equal(recycled, 0, `${label}: a settings change recycled the owner`);
      assert.equal(policy.useFreshClient, false, label);
      if (!row.differs) {
        assert.deepEqual(reasons, [], `${label}: rebound without a change`);
        assert.equal(policy.replacementClient, undefined, label);
        continue;
      }
      assert.deepEqual(reasons, [{ kind: "settings" }], label);
      assert.equal(policy.replacementClient, row.replacement, `${label}: the turn's client`);
      assert.equal(policy.settingsChanged, true, label);
    }
  });
});

test("NA3: the fingerprint moves for every verb's field and ignores model_source", () => {
  const base = makeSessionRecord({
    acpxRecordId: "fp",
    acpSessionId: "fp",
    agentCommand: CLAUDE_CMD,
    cwd: "/",
    acpx: { session_options: { model: "opus", model_source: "explicit" } },
  });
  const changed = (acpx: SessionAcpxState) =>
    settingsBindingFingerprint({ ...base, acpx: { ...base.acpx, ...acpx } }) !==
    settingsBindingFingerprint(base);
  const options = base.acpx?.session_options ?? {};
  for (const [field, value] of [
    ["model", "sonnet"],
    ["effort", "low"],
    ["output_style", "Explanatory"],
    ["profile", "subB"],
    ["subscription", "subB"],
    ["auto_failover", false],
    ["auto_subscription", false],
    ["fable_degrade_ok", true],
  ] as const) {
    assert.ok(changed({ session_options: { ...options, [field]: value } }), field);
  }
  for (const id of ["effort", "reasoning_effort", "outputStyle"]) {
    assert.ok(changed({ desired_config_options: { [id]: "x" } }), `desired ${id}`);
  }
  assert.equal(
    changed({ session_options: { ...options, model_source: "inherited" } }),
    false,
    "model_source would rebind every turn (the reconnect guard rewrites it)",
  );
});

// ---------------------------------------------------------------------------------------------
// NA4 / NA5 — a real queue owner and the mock adapter
// ---------------------------------------------------------------------------------------------

type Rig = { root: string; env: NodeJS.ProcessEnv; ops: string; agent: string; id: string };
type Run = { code: number | null; stdout: string; stderr: string };
type Op = { method?: string; text?: string; modelId?: string; configId?: string; value?: unknown };

function runCli(rig: Pick<Rig, "root" | "env">, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: rig.env,
      cwd: rig.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function makeRig(mockFlags: string): Promise<Rig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-settings-rebind-"));
  fs.mkdirSync(path.join(root, ".acpx", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, "work"));
  const ops = path.join(root, "ops.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    ACPX_STATE_HOME: root,
    ACPX_ADMISSION_DIR: path.join(root, "admission"),
    ACPX_CAPACITY_PODINFO_DIR: path.join(root, "no-podinfo"),
    ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
  };
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
  const agent = `node ${JSON.stringify(MOCK_AGENT_PATH)} ${mockFlags} --operation-log ${JSON.stringify(ops)}`;
  const created = await runCli({ root, env }, [
    "--format",
    "json",
    "--agent",
    agent,
    "--cwd",
    path.join(root, "work"),
    "sessions",
    "new",
  ]);
  assert.equal(created.code, 0, created.stderr);
  const id = String((JSON.parse(created.stdout.trim()) as { acpxRecordId: unknown }).acpxRecordId);
  return { root, env, ops, agent, id };
}

const cli = (rig: Rig, args: string[]) =>
  runCli(rig, ["--format", "json", "--agent", rig.agent, "--ttl", "60", ...args]);

function readOps(rig: Rig): Op[] {
  try {
    return fs
      .readFileSync(rig.ops, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Op);
  } catch {
    return [];
  }
}

function lastJson(run: Run): Record<string, unknown> {
  const last = run.stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(last) as Record<string, unknown>;
  } catch {
    return assert.fail(`no JSON on stdout (rc ${run.code}): ${run.stdout}\n${run.stderr}`);
  }
}

const sessionsDir = (rig: Rig) => path.join(rig.root, ".acpx", "sessions");
const recordOf = (rig: Rig) =>
  JSON.parse(fs.readFileSync(path.join(sessionsDir(rig), `${rig.id}.json`), "utf8")) as {
    pid?: number;
    acpx?: SessionAcpxState;
  };
const ownerPidOf = (rig: Rig) =>
  (JSON.parse(fs.readFileSync(queuePaths(rig.root, rig.id).lockPath, "utf8")) as { pid: number })
    .pid;
const readText = (file: string) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const ownerLogOf = (rig: Rig) => readText(path.join(sessionsDir(rig), `${rig.id}.owner.log`));

async function waitFor(what: string, timeoutMs: number, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `${what} never happened within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const promptIndex = (ops: Op[], text: string) =>
  ops.findIndex((op) => op.method === "session/prompt" && op.text === text);

for (const change of [
  {
    verb: "effort",
    args: ["set", "effort", "low"],
    replayed: (op: Op) =>
      op.method === "session/set_config_option" && op.configId === "effort" && op.value === "low",
    kept: (acpx: SessionAcpxState | undefined) => acpx?.desired_config_options?.effort === "low",
  },
  {
    verb: "model",
    args: ["set", "model", "smart-model"],
    replayed: (op: Op) => op.method === "session/set_model" && op.modelId === "smart-model",
    kept: (acpx: SessionAcpxState | undefined) => acpx?.session_options?.model === "smart-model",
  },
]) {
  test(`NA4 GA1+GA2: set ${change.verb} on a warm owner — the SAME owner rebinds a fresh adapter at the next turn`, async () => {
    const rig = await makeRig(
      "--claude-agent-acp --supports-resume-session --advertise-models --advertise-config-options --log-config-option-ops",
    );
    try {
      const first = await cli(rig, ["prompt", "--session-id", rig.id, "echo turn-one"]);
      assert.equal(first.code, 0, first.stderr);
      const owner = ownerPidOf(rig);
      const adapterBefore = recordOf(rig).pid;
      assert.ok(adapterBefore && isProcessAlive(adapterBefore), "turn 1 left a warm adapter");

      const set = await cli(rig, [...change.args, "--session-id", rig.id]);
      assert.equal(set.code, 0, set.stderr);
      const result = lastJson(set);
      assert.equal(result.ownerRestarted, false, JSON.stringify(result));
      assert.equal(result.ownerRebind, "next-turn", JSON.stringify(result));
      assert.equal(ownerPidOf(rig), owner, "the set stopped the owner");
      assert.equal(isProcessAlive(owner), true);

      const second = await cli(rig, ["prompt", "--session-id", rig.id, "echo turn-two"]);
      assert.equal(second.code, 0, second.stderr);
      const ops = readOps(rig);
      const between = ops.slice(
        promptIndex(ops, "echo turn-one") + 1,
        promptIndex(ops, "echo turn-two"),
      );
      assert.ok(
        between.some(change.replayed),
        `no replay between the turns: ${JSON.stringify(between)}`,
      );
      // The discriminator: a warm reuse keeps the adapter; the rebind connects a NEW one.
      const adapterAfter = recordOf(rig).pid;
      assert.notEqual(adapterAfter, adapterBefore, "turn 2 ran on the old adapter — no rebind");
      assert.equal(isProcessAlive(adapterBefore), false, "the old adapter outlived the rebind");
      assert.equal(ownerPidOf(rig), owner, "the owner changed");
      assert.ok(change.kept(recordOf(rig).acpx), "the record lost the value");
      assert.match(ownerLogOf(rig), /queue owner rebound session .* \(reason=settings\)/);
    } finally {
      await runCli(rig, ["--agent", rig.agent, "sessions", "close", "--session-id", rig.id]).catch(
        () => undefined,
      );
      fs.rmSync(rig.root, { recursive: true, force: true });
    }
  });
}

test("NA5 GA1: a mid-turn output-style change keeps the prompt queued behind the turn — same owner, `done`, style first", async () => {
  // No `--claude-agent-acp`: the mock is not mid-turn injecting, so prompt 2 QUEUES behind turn 1.
  const rig = await makeRig(
    "--supports-resume-session --advertise-config-options --advertise-output-style --log-config-option-ops",
  );
  try {
    const warm = await cli(rig, ["prompt", "--session-id", rig.id, "echo warm"]);
    assert.equal(warm.code, 0, warm.stderr);
    const owner = ownerPidOf(rig);

    const long = cli(rig, ["prompt", "--session-id", rig.id, "sleep 3000"]);
    await waitFor("turn 1 starting", 30_000, () => promptIndex(readOps(rig), "sleep 3000") >= 0);

    const set = await cli(rig, ["set", "outputStyle", "Explanatory", "--session-id", rig.id]);
    assert.equal(set.code, 0, `${set.stdout}\n${set.stderr}`);
    assert.equal(lastJson(set).pending, true, set.stdout);

    const messageId = randomUUID();
    const queued = await cli(rig, [
      "prompt",
      "--session-id",
      rig.id,
      "--no-wait",
      "--message-id",
      messageId,
      "echo queued-two",
    ]);
    assert.equal(queued.code, 0, queued.stderr);
    assert.equal((await long).code, 0, "turn 1 failed");

    const stream = path.join(sessionsDir(rig), `${rig.id}.stream.ndjson`);
    const terminal = () =>
      readText(stream)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
        .filter((e) => e.method === "acpx/delivery" && e.params?.messageId === messageId)
        .map((e) => e.params?.phase)
        .find((phase) => phase === "done" || phase === "failed");
    await waitFor("the queued message's terminal", 60_000, () => terminal() !== undefined);
    assert.equal(terminal(), "done", "the queued prompt was lost to the style change");
    assert.equal(ownerPidOf(rig), owner, "the owner exited for the style change");
    const ops = readOps(rig);
    const style = ops.findIndex(
      (op) =>
        op.method === "session/set_config_option" &&
        op.configId === "outputStyle" &&
        op.value === "Explanatory",
    );
    assert.ok(style >= 0, `the style was never applied: ${JSON.stringify(ops)}`);
    assert.ok(
      style < promptIndex(ops, "echo queued-two"),
      "the queued prompt ran on the old style",
    );
  } finally {
    await runCli(rig, ["--agent", rig.agent, "sessions", "close", "--session-id", rig.id]).catch(
      () => undefined,
    );
    fs.rmSync(rig.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// NA6 — the record-only set and a late owner (round-1 N5, rewritten)
// ---------------------------------------------------------------------------------------------

test("NA6 GA1: the record-only arms never talk to an owner; the instrument flags a planted call", async () => {
  const source = await fsp.readFile(path.join(SRC_DIR, "cli/session/session-control.ts"), "utf8");
  const ownerCalls = (text: string, name: string): RegExpMatchArray | null => {
    const body = functionBody(text, name);
    return text.slice(body.start, body.end).match(/\btry\w+OnRunningOwner\(/);
  };
  for (const name of ["setSessionModelOnRecord", "setSessionConfigOptionOnRecord"]) {
    assert.equal(ownerCalls(source, name), null, `${name} sends the set to an owner`);
  }
  // The instrument bites: the call is flagged without being registered anywhere.
  const planted = source.replace(
    "writeModelPin(record, options.modelId);",
    "writeModelPin(record, options.modelId);\n  await trySetModelOnRunningOwner(options.sessionId, options.modelId);",
  );
  assert.notEqual(planted, source, "the planting anchor moved");
  assert.ok(
    ownerCalls(planted, "setSessionModelOnRecord"),
    "the guard did not flag a planted call",
  );
});

// ---------------------------------------------------------------------------------------------
// NA7 — the rollback guard is still WRITTEN (brick c36e09c3 removes it)
// ---------------------------------------------------------------------------------------------

test("NA7 rollback guard: a lease written by this build carries settingsRebind:1, through acquire and refresh", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("na7-marker");
    assert(lease);
    try {
      const onDisk = () =>
        JSON.parse(fs.readFileSync(lease.lockPath, "utf8")) as { settingsRebind?: unknown };
      // The raw bytes, not the parsed record: production main 5c21f164 reads exactly this key.
      assert.equal(onDisk().settingsRebind, 1, "a fresh lease lacks the marker");
      await refreshQueueOwnerLease(lease, { queueDepth: 1 }, () => "2026-03-26T00:00:00.000Z");
      assert.equal(onDisk().settingsRebind, 1, "a heartbeat rewrite dropped the marker");
      assert.equal((await readQueueOwnerRecord("na7-marker"))?.settingsRebind, 1);
    } finally {
      await releaseQueueOwnerLease(lease);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// F4 (9df709f4 VERIFICATION) — an owner-arm set on a WARM owner must not hold it past the idle
// release. The set's own request, response and the adapter's echo stamped the idle drain's
// activity clock, and the quiescence gate stayed closed for the TTL-derived window.
// ---------------------------------------------------------------------------------------------

test("F4 unit: only background work counts as idle-drain activity", () => {
  const update = (sessionUpdate: string) => ({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s", update: { sessionUpdate } },
  });
  const request = { jsonrpc: "2.0", id: 7, method: "session/set_config_option", params: {} };
  const response = { jsonrpc: "2.0", id: 7, result: { configOptions: [] } };
  // The owner's own settings traffic.
  assert.equal(isIdleDrainActivity("outbound", request), false, "the owner's own request");
  assert.equal(isIdleDrainActivity("inbound", response), false, "the response to it");
  assert.equal(isIdleDrainActivity("inbound", update("config_option_update")), false, "set echo");
  assert.equal(isIdleDrainActivity("inbound", update("current_mode_update")), false, "mode echo");
  // The real adapter's extra echo of a warm `set model` (claude-agent-acp 356a1ed, measured on the
  // fix-round real path: these two alone held a NEW owner past its idle release).
  assert.equal(isIdleDrainActivity("inbound", update("available_commands_update")), false);
  assert.equal(isIdleDrainActivity("inbound", update("usage_update")), false, "the usage echo");
  const snapshot = { jsonrpc: "2.0", method: "_claude/backgroundTasks", params: { tasks: [] } };
  assert.equal(isIdleDrainActivity("inbound", snapshot), false, "a background-task snapshot");
  // Background work keeps the gate closed, as before.
  for (const kind of [
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
  ]) {
    assert.equal(isIdleDrainActivity("inbound", update(kind)), true, kind);
  }
  const permission = { jsonrpc: "2.0", id: 9, method: "session/request_permission", params: {} };
  assert.equal(isIdleDrainActivity("inbound", permission), true, "an agent request");
});

for (const change of [
  { verb: "none", args: [] as string[] },
  { verb: "effort", args: ["set", "effort", "low"] },
  { verb: "model", args: ["set", "model", "smart-model"] },
]) {
  test(`F4: a warm owner idle-releases on time after ${change.verb === "none" ? "no set (control)" : `an owner-arm set ${change.verb}`}`, async () => {
    const rig = await makeRig(
      "--claude-agent-acp --supports-resume-session --advertise-models --advertise-config-options --push-config-on-set-model",
    );
    // A 2 s idle release under a 60 s TTL (`cli` passes --ttl 60): the quiescence window is 60 s,
    // so a set whose own traffic counted as relay activity holds the owner for a minute.
    rig.env.ACPX_OWNER_IDLE_RELEASE_MS = "2000";
    try {
      const first = await cli(rig, ["prompt", "--session-id", rig.id, "echo warm"]);
      assert.equal(first.code, 0, first.stderr);
      const owner = ownerPidOf(rig);
      if (change.args.length > 0) {
        const set = await cli(rig, [...change.args, "--session-id", rig.id]);
        assert.equal(set.code, 0, set.stderr);
        assert.equal(lastJson(set).ownerRebind, "next-turn", set.stdout);
        assert.equal(ownerPidOf(rig), owner, "the set stopped the owner");
      }
      const lease = queuePaths(rig.root, rig.id).lockPath;
      await waitFor("the idle release", 25_000, () => !fs.existsSync(lease));
      assert.match(ownerLogOf(rig), /releasing session .* \(reason=idle-memory\)/);
    } finally {
      await runCli(rig, ["--agent", rig.agent, "sessions", "close", "--session-id", rig.id]).catch(
        () => undefined,
      );
      fs.rmSync(rig.root, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// F3 (9df709f4 VERIFICATION) — a warm `set subscription` / `set profile` must survive to the next
// turn's pre-turn check. The idle drain wrote back the record it read when the owner went idle,
// and the durable overlay does not carry the account binding: the pick was erased, nothing rebound.
// ---------------------------------------------------------------------------------------------

for (const change of [
  {
    verb: "subscription",
    args: ["set", "subscription", "subB"],
    kept: (acpx: SessionAcpxState | undefined) =>
      acpx?.session_options?.subscription === "subB" &&
      acpx?.session_options?.subscription_switch?.to === "subB",
  },
  {
    verb: "profile",
    args: ["set", "profile", "subB"],
    kept: (acpx: SessionAcpxState | undefined) => acpx?.session_options?.profile === "subB",
  },
]) {
  test(`F3: a warm set ${change.verb} survives the idle write-back and rebinds the next turn`, async () => {
    const rig = await makeRig(
      "--claude-agent-acp --supports-resume-session --advertise-config-options",
    );
    const registry = await seedRegistry(rig.root);
    const raw = JSON.parse(fs.readFileSync(registry.registryPath, "utf8")) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(registry.registryPath, `${JSON.stringify({ ...raw, default: "subA" })}\n`);
    try {
      const first = await cli(rig, ["prompt", "--session-id", rig.id, "echo turn-one"]);
      assert.equal(first.code, 0, first.stderr);
      const owner = ownerPidOf(rig);
      // The mock writes no Claude transcript; the switch ports one, so plant it in subA.
      const disk = JSON.parse(
        fs.readFileSync(path.join(sessionsDir(rig), `${rig.id}.json`), "utf8"),
      ) as Record<string, unknown>;
      for (const key of ["acp_session_id", "agent_session_id", "acpSessionId", "agentSessionId"]) {
        if (typeof disk[key] === "string") {
          const file = transcriptJsonlPath(
            path.join(rig.root, ".acpx", "subscriptions", "subA"),
            path.join(rig.root, "work"),
            disk[key],
          );
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, "{}\n");
        }
      }
      const set = await cli(rig, [...change.args, "--session-id", rig.id]);
      assert.equal(set.code, 0, `${set.stdout}\n${set.stderr}`);
      assert.equal(lastJson(set).ownerRebind, "next-turn", set.stdout);
      assert.ok(change.kept(recordOf(rig).acpx), "the set did not write the record");

      const second = await cli(rig, ["prompt", "--session-id", rig.id, "echo turn-two"]);
      assert.equal(second.code, 0, second.stderr);
      assert.ok(
        change.kept(recordOf(rig).acpx),
        `the pick was erased before the next turn: ${JSON.stringify(recordOf(rig).acpx?.session_options)}`,
      );
      assert.equal(ownerPidOf(rig), owner, "the owner changed");
      assert.match(ownerLogOf(rig), /queue owner rebound session .* \(reason=settings\)/);
    } finally {
      await runCli(rig, ["--agent", rig.agent, "sessions", "close", "--session-id", rig.id]).catch(
        () => undefined,
      );
      fs.rmSync(rig.root, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// F1 (9df709f4 VERIFICATION) — a turn's own per-task `--model` must not make the next turn rebind
// (which kills the session's live background tasks); an outside set still must.
// ---------------------------------------------------------------------------------------------

test("F1 unit: a turn's own writes are bound slot by slot; an outside change stays pending", () => {
  const record = (session_options: Record<string, unknown>, desired?: Record<string, string>) =>
    makeSessionRecord({
      acpxRecordId: "f1",
      acpSessionId: "f1",
      agentCommand: CLAUDE_CMD,
      cwd: "/",
      acpx: {
        session_options,
        ...(desired ? { desired_config_options: desired } : {}),
      } as SessionAcpxState,
    });
  const bound = settingsBindingFingerprint(record({ model: "haiku" }));
  // The turn's own --model sonnet, written by the turn: bound.
  const own = record({ model: "sonnet" });
  assert.equal(bindTurnOwnWrites(bound, own, { model: "sonnet" }), settingsBindingFingerprint(own));
  // The record holds a value the turn did NOT ask for (an outside set): still pending.
  const outside = record({ model: "opus" });
  assert.notEqual(
    bindTurnOwnWrites(bound, outside, { model: "sonnet" }),
    settingsBindingFingerprint(outside),
  );
  assert.equal(bindTurnOwnWrites(bound, outside, undefined), bound, "no own options: unchanged");
  // Mixed: own model absorbed, an outside effort stays pending (and only that).
  const mixed = record({ model: "sonnet", effort: "low" }, { effort: "low" });
  const after = bindTurnOwnWrites(bound, mixed, { model: "sonnet" });
  assert.notEqual(after, settingsBindingFingerprint(mixed));
  assert.equal(
    bindTurnOwnWrites(after, mixed, { reasoningEffort: "low" }),
    settingsBindingFingerprint(mixed),
    "the effort slots are bound once the turn's own effort matches",
  );
});

test("F1: per-task --model switches cost no rebind; an outside set still rebinds the next turn", async () => {
  const rig = await makeRig(
    "--claude-agent-acp --supports-resume-session --advertise-models --advertise-config-options --push-config-on-set-model",
  );
  const rebinds = () => (ownerLogOf(rig).match(/\(reason=settings\)/g) ?? []).length;
  try {
    const first = await cli(rig, ["prompt", "--session-id", rig.id, "echo plain-one"]);
    assert.equal(first.code, 0, first.stderr);
    const owner = ownerPidOf(rig);
    const adapter = recordOf(rig).pid;
    for (const [flags, text] of [
      [["--model", "smart-model"], "echo flagged-smart"],
      [[], "echo plain-two"],
      [["--model", "fast-model"], "echo flagged-fast"],
      [["--model", "smart-model"], "echo flagged-smart-again"],
      [[], "echo plain-three"],
    ] as const) {
      const turn = await cli(rig, [...flags, "prompt", "--session-id", rig.id, text]);
      assert.equal(turn.code, 0, `${text}: ${turn.stderr}`);
      assert.equal(rebinds(), 0, `${text}: the turn's own flag made a later turn rebind`);
      assert.equal(recordOf(rig).pid, adapter, `${text}: the adapter was restarted`);
    }
    assert.equal(recordOf(rig).acpx?.session_options?.model, "smart-model", "the pin moved");
    // GA2 is not swallowed: an outside set rebinds the next turn.
    const set = await cli(rig, ["set", "effort", "low", "--session-id", rig.id]);
    assert.equal(set.code, 0, set.stderr);
    const last = await cli(rig, ["prompt", "--session-id", rig.id, "echo after-set"]);
    assert.equal(last.code, 0, last.stderr);
    assert.equal(rebinds(), 1, "the outside set did not rebind");
    assert.equal(ownerPidOf(rig), owner, "the owner changed");
  } finally {
    await runCli(rig, ["--agent", rig.agent, "sessions", "close", "--session-id", rig.id]).catch(
      () => undefined,
    );
    fs.rmSync(rig.root, { recursive: true, force: true });
  }
});

test("F6: set auto-failover / auto-subscription / fable-degrade report the owner outcome in JSON", async () => {
  const rig = await makeRig(
    "--claude-agent-acp --supports-resume-session --advertise-config-options",
  );
  try {
    const first = await cli(rig, ["prompt", "--session-id", rig.id, "echo warm"]);
    assert.equal(first.code, 0, first.stderr);
    for (const args of [
      ["set", "auto-failover", "off"],
      ["set", "auto-subscription", "off"],
      ["set", "fable-degrade", "on"],
    ]) {
      const set = await cli(rig, [...args, "--session-id", rig.id]);
      assert.equal(set.code, 0, `${args.join(" ")}: ${set.stderr}`);
      const json = lastJson(set);
      assert.equal(json.ownerRestarted, false, `${args.join(" ")}: ${set.stdout}`);
      assert.equal(json.ownerRebind, "next-turn", `${args.join(" ")}: ${set.stdout}`);
    }
  } finally {
    await runCli(rig, ["--agent", rig.agent, "sessions", "close", "--session-id", rig.id]).catch(
      () => undefined,
    );
    fs.rmSync(rig.root, { recursive: true, force: true });
  }
});
