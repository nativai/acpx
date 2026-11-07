// brick 6e27669f (DESIGN-R2 §A) — a settings change never kills a queued prompt.
//
// Before the fix every settings verb SIGTERMed a live queue owner after its record write, so the
// next prompt cold-respawned with the new value. A prompt the owner had already dequeued (held in
// a local variable, invisible to `queryActiveTurn` and to the queue depth) or whose turn was just
// starting died with `Queue owner disconnected before prompt completion`. Now a capable owner (its
// lease carries `settingsRebind`) is never stopped: at its next turn start it sees the record's
// settings differ from those its client was built from and rebuilds that client in place.
//
//   NA1 GA1/GA4  all 8 verbs: a capable idle owner survives; a legacy one is recycled as before
//   NA2 GA1      structural: no setter stops an owner except through `bindSettingsChange`
//   NA3 GA2      the pre-turn policy asks for the rebind exactly when the binding differs
//   NA4 GA1+GA2  real owner + mock adapter: `set effort` / `set model` → the SAME owner rebinds
//   NA5 GA1      a pending output style keeps a prompt queued behind the turn alive
//   NA6 GA1      a record-only set hands nothing to a capable late owner
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
import { isProcessAlive, readQueueOwnerProcessIdentity } from "../src/cli/queue/lease-store.js";
import { applyQueuedTaskSubscriptionLockPolicy } from "../src/cli/session/runtime.js";
import {
  setRecordOnlyRecheckHookForTests,
  setSessionAutoFailover,
  setSessionAutoSubscription,
  setSessionConfigOption,
  setSessionFableDegrade,
  setSessionModel,
  setSessionOutputStyle,
  setSessionProfile,
  setSessionSubscription,
} from "../src/cli/session/session-control.js";
import { resolveSessionRecord } from "../src/session/persistence/repository.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { settingsBindingFingerprint } from "../src/session/settings-binding.js";
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
type OwnerKind = "legacy" | "capable";
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

/** The marker every lease of the fixed build carries (T-A2); a legacy lease has none. */
async function markLeaseCapable(lockPath: string): Promise<void> {
  const lease = JSON.parse(await fsp.readFile(lockPath, "utf8")) as Record<string, unknown>;
  await fsp.writeFile(lockPath, `${JSON.stringify({ ...lease, settingsRebind: 1 })}\n`, "utf8");
}

async function plantOwner(
  homeDir: string,
  sessionId: string,
  server: ReturnType<typeof createSingleRequestServer>,
  kind: OwnerKind,
): Promise<Keeper> {
  const keeper = await startKeeperProcess();
  const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
  await listenServer(server, socketPath);
  const processIdentity = keeper.pid ? await readQueueOwnerProcessIdentity(keeper.pid) : undefined;
  await writeQueueOwnerLock({ lockPath, pid: keeper.pid, sessionId, socketPath, processIdentity });
  if (kind === "capable") {
    await markLeaseCapable(lockPath);
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

async function waitUntilDead(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline && isProcessAlive(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

for (const kind of ["capable", "legacy"] as const) {
  test(`NA1 ${kind === "capable" ? "GA1" : "GA4"}: all 8 settings verbs on a ${kind} idle owner`, async () => {
    assert.equal(VERBS.length, 8, "the verb table names every settings verb");
    for (const row of VERBS) {
      await withTempHome(async (homeDir) => {
        const sessionId = `na1-${kind}-${row.verb.replace(/\W+/g, "-")}`;
        const loadOpts = await seedRegistry(homeDir);
        await seedSession(homeDir, sessionId, row.acpx);
        const requests: OwnerRequest[] = [];
        const server = recordingOwner(requests);
        const keeper = await plantOwner(homeDir, sessionId, server, kind);
        const { lockPath } = queuePaths(homeDir, sessionId);
        const generation = () =>
          (JSON.parse(fs.readFileSync(lockPath, "utf8")) as { ownerGeneration: number })
            .ownerGeneration;
        const before = generation();
        try {
          const result = await row.run(sessionId, loadOpts);
          const label = `${kind} ${row.verb}`;
          assert.equal(row.written(await resolveSessionRecord(sessionId)), row.expected, label);
          if (kind === "capable") {
            assert.equal(result.ownerRestarted, false, `${label}: ${JSON.stringify(result)}`);
            assert.equal(result.ownerRebind, "next-turn", label);
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(isProcessAlive(keeper.pid), true, `${label}: the owner was stopped`);
            assert.equal(generation(), before, `${label}: the lease changed hands`);
          } else {
            assert.equal(result.ownerRestarted, true, `${label}: ${JSON.stringify(result)}`);
            assert.equal(result.ownerRebind, undefined, label);
            await waitUntilDead(keeper.pid as number);
            assert.equal(isProcessAlive(keeper.pid), false, `${label}: the owner survived`);
          }
        } finally {
          await closeServer(server);
          stopProcess(keeper);
        }
      });
    }
  });
}

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
      const policy = await applyQueuedTaskSubscriptionLockPolicy(sessionId, {
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
      });
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

function recordOnlyAcpx(): SessionAcpxState {
  const select = (id: string, category: string, current: string, values: string[]) => ({
    id,
    name: id,
    category,
    type: "select" as const,
    currentValue: current,
    options: values.map((value) => ({ value, name: value })),
  });
  return {
    config_options: [
      select("model", "model", "default", ["default", "opus", "sonnet", "haiku"]),
      select("effort", "thought_level", "default", ["default", "low", "medium", "high"]),
    ],
    session_options: { model: "default", effort: "high", model_source: "inherited" },
    current_model_id: "default",
    available_models: ["default", "opus", "sonnet", "haiku"],
    desired_config_options: { effort: "high" },
  } as SessionAcpxState;
}

for (const kind of ["capable", "legacy"] as const) {
  test(`NA6 ${kind === "capable" ? "GA1" : "GA4"}: a ${kind} owner that takes the lease during a record-only set`, async () => {
    await withTempHome(async (homeDir) => {
      const sessionId = randomUUID();
      const file = path.join(homeDir, ".acpx", "sessions", `${sessionId}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const record = makeSessionRecord({
        acpxRecordId: sessionId,
        acpSessionId: `${sessionId}-acp`,
        // Real-shaped and classified (record-only-set.test.ts header), so the verdict says YES.
        agentCommand: `node ${path.join(homeDir, "claude-agent-acp", "dist", "index.js")}`,
        cwd: homeDir,
        acpx: recordOnlyAcpx(),
      });
      fs.writeFileSync(file, `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`);
      const requests: OwnerRequest[] = [];
      const server = recordingOwner(requests);
      let keeper: Keeper | undefined;
      setRecordOnlyRecheckHookForTests(async () => {
        keeper = await plantOwner(homeDir, sessionId, server, kind);
      });
      try {
        const result = await setSessionConfigOption({
          sessionId,
          configId: "effort",
          value: "low",
          recycleOwner: true,
        });
        assert.equal(
          (await resolveSessionRecord(sessionId)).acpx?.desired_config_options?.effort,
          "low",
        );
        if (kind === "capable") {
          assert.deepEqual(requests, [], "the capable late owner was sent something");
          assert.equal(result.validatedAgainst, "record");
          assert.notEqual(result.ownerRestarted, true);
          assert.equal(isProcessAlive(keeper?.pid), true);
        } else {
          assert.equal(requests.filter((r) => r.type === "set_config_option").length, 1);
          assert.equal(result.validatedAgainst, "adapter");
          assert.equal(result.ownerRestarted, true, "the legacy late owner was not recycled");
        }
      } finally {
        setRecordOnlyRecheckHookForTests(undefined);
        await closeServer(server);
        if (keeper) {
          stopProcess(keeper);
        }
      }
    });
  });
}
