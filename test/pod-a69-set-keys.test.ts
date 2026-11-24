import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import * as sessionControl from "../src/cli/session/session-control.js";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { CapacityRefusedError } from "../src/errors.js";
import {
  clearNodes,
  clearPods,
  failWith,
  putNode,
  putPod,
  startKitApi,
  type FakeApiServer,
} from "./pod-kit-api-helpers.js";
import { makeWorld, withEnv, worldEnv, type PodWorld } from "./pod-owner-helpers.js";

// A-69 (3) row 69.6 (brick e357bdd8; architect #17's clarification, LOW-6 / TE R2-2b of b2abea18). Every key of
// `set` is `owner-if-pod` (C1.2, one class per command path), and a held session keeps its pod until it is proven
// gone (A-16). The six keys acpx handles OUTSIDE the generic config path — `subscription`, `profile`, `outputStyle`,
// `auto-failover`, `auto-subscription`, `fable-degrade` — therefore refuse on a held lease and write nothing: no
// record edit, no transcript copy, no adapter. Red at 985877a7: all six wrote the record (rc 0) where the same
// session with a parseable lease naming the pod got 75.
// Pods are stood up through the product's own seams; every state home is the world's sandbox.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const ID = "rec-a69-set-keys-1";
const STALE = "2026-01-01T00:00:00.000Z";
const GONE_UID = "77777777-7777-4777-8777-777777777777";
const OTHER_POD = { name: "ag-a69-keys-other", uid: GONE_UID, node: "n-a69-keys" };
const OLD_MS = 60_000; // well past the 15 s rule

type Proof = "gone" | "exists";
function setProof(api: FakeApiServer, proof: Proof): void {
  clearPods(api);
  clearNodes(api);
  failWith(api, undefined);
  putNode(api, OTHER_POD.node, "True");
  if (proof === "exists") {
    putPod(api, OTHER_POD.name, { uid: GONE_UID, phase: "Running", node: OTHER_POD.node });
  }
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(child.pid, "spawned a short-lived process");
  return child.pid;
}

/** A whole lease whose ONLY fault is `ownerGeneration: "g-3"` (a newer writer's field type), the A-69 bodies' base. */
function schemaRefused(
  world: PodWorld,
  pod: { present: false } | { present: true; value: unknown },
): string {
  return `${JSON.stringify(
    {
      sessionId: ID,
      pid: deadPid(),
      socketPath: path.join(world.root, "a69k.sock"),
      createdAt: STALE,
      heartbeatAt: STALE,
      ownerGeneration: "g-3",
      queueDepth: 0,
      ...(pod.present ? { pod: pod.value } : {}),
    },
    null,
    2,
  )}\n`;
}

/** The parseable control: the same lease with a valid `ownerGeneration`. It already refuses before this row. */
function parseableLease(world: PodWorld): string {
  return schemaRefused(world, { present: true, value: OTHER_POD }).replace(
    '"ownerGeneration": "g-3"',
    '"ownerGeneration": 3',
  );
}

// ---- the six keys: the real CLI argv, and what a WRITE leaves in the record ----

type SessionOptions = Record<string, unknown>;
type Key = {
  key: string;
  argv: (id: string) => string[];
  /** The record field the setter writes, as read from the on-disk record. */
  written: (options: SessionOptions) => unknown;
  value: unknown;
};

const KEYS: Key[] = [
  {
    key: "subscription",
    argv: (id) => ["set", "subscription", "subB", "--session-id", id],
    written: (o) => o.subscription,
    value: "subB",
  },
  {
    key: "profile",
    argv: (id) => ["set", "profile", "subB", "--session-id", id],
    written: (o) => o.profile,
    value: "subB",
  },
  {
    key: "outputStyle",
    argv: (id) => ["set", "outputStyle", "Proactive", "--session-id", id],
    written: (o) => o.output_style,
    value: "Proactive",
  },
  {
    key: "auto-failover",
    argv: (id) => ["set", "auto-failover", "off", "--session-id", id],
    written: (o) => o.auto_failover,
    value: false,
  },
  {
    key: "auto-subscription",
    argv: (id) => ["set", "auto-subscription", "off", "--session-id", id],
    written: (o) => o.auto_subscription,
    value: false,
  },
  {
    key: "fable-degrade",
    argv: (id) => ["set", "fable-degrade", "on", "--session-id", id],
    written: (o) => o.fable_degrade_ok,
    value: true,
  },
];

type Run = { status: number | null; stdout: string; stderr: string };
type Rig = {
  world: PodWorld;
  env: NodeJS.ProcessEnv;
  agent: string;
  ops: string;
  cwd: string;
};

function makeRig(label: string, identity: boolean, apiUrl: string): Rig {
  const world = makeWorld(label);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(
    worldEnv(world, {
      place: "control",
      podMode: false,
      identity,
      extra: { ACPX_POD_API_URL: apiUrl },
    }),
  )) {
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  env.ACPX_STATE_HOME = world.home;
  for (const name of Object.keys(env)) {
    // The box's own owner / pi / session-root settings must not steer a rig (the suite's scrub does the same).
    if (
      name === "ACPX_DEFAULT_OWNER" ||
      name.startsWith("ACPX_PI_") ||
      name === "ACPX_SESSION_ROOT"
    ) {
      delete env[name];
    }
  }
  const ops = path.join(world.root, "ops.jsonl");
  // Claude-shaped (the account seam accepts it) and advertising an output-style list; every operation is logged.
  const agent = `node ${JSON.stringify(MOCK_AGENT)} --claude-agent-acp --supports-resume-session --advertise-config-options --advertise-output-style --operation-log ${JSON.stringify(ops)}`;
  const cwd = fs.mkdtempSync(path.join(world.root, "cwd-"));
  seedRegistry(world);
  return { world, env, agent, ops, cwd };
}

/** Two claude profiles (subA the default, subB) with config dirs, so `set profile/subscription` can switch. */
function seedRegistry(world: PodWorld): void {
  const subsDir = path.join(world.home, ".acpx", "subscriptions");
  fs.mkdirSync(subsDir, { recursive: true });
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
  fs.writeFileSync(
    path.join(subsDir, "registry.json"),
    `${JSON.stringify({ version: 3, default: "subA", profiles })}\n`,
    { mode: 0o600 },
  );
}

function runCli(rig: Rig, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI, "--agent", rig.agent, "--cwd", rig.cwd, "--format", "json", ...args],
      { env: rig.env, cwd: rig.cwd },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function createSession(rig: Rig, name: string): Promise<string> {
  const created = await runCli(rig, ["sessions", "new", "--name", name]);
  const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
    created.stdout,
  )?.[1];
  assert.ok(
    id,
    `a session was created: ${created.stdout.slice(0, 300)} ${created.stderr.slice(0, 300)}`,
  );
  return id;
}

function recordFileOf(rig: Rig, id: string): string {
  return path.join(rig.world.home, ".acpx", "sessions", `${encodeURIComponent(id)}.json`);
}

type DiskRecord = {
  cwd?: string;
  acp_session_id?: string;
  acpx?: { session_options?: SessionOptions };
};
function diskRecord(rig: Rig, id: string): DiskRecord {
  return JSON.parse(fs.readFileSync(recordFileOf(rig, id), "utf8")) as DiskRecord;
}

function plantLease(rig: Rig, id: string, raw: string): string {
  const file = queueLockFilePath(id, rig.world.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw);
  const when = new Date(Date.now() - OLD_MS);
  fs.utimesSync(file, when, when);
  return file;
}

/** The session's transcript in `sub` (a config dir of the seeded registry). */
function transcriptIn(rig: Rig, id: string, sub: string): string {
  const record = diskRecord(rig, id);
  assert.ok(record.cwd && record.acp_session_id, "the record names a cwd and a session id");
  return transcriptJsonlPath(
    path.join(rig.world.home, ".acpx", "subscriptions", sub),
    record.cwd,
    record.acp_session_id,
  );
}

/** The mock agent has written no Claude transcript; a switch ports one, so plant it in the CURRENT account (subA). */
function plantTranscript(rig: Rig, id: string): void {
  const file = transcriptIn(rig, id, "subA");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{}\n");
}

function readOps(rig: Rig): string {
  try {
    return fs.readFileSync(rig.ops, "utf8");
  } catch {
    return "";
  }
}

const TURNOVER_TOKEN =
  /^acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=turnover wake=/;

// ---- row 69.6: the four held bodies (+ the parseable control) × the six keys ----

const HELD_BODIES: Array<[string, (w: PodWorld) => string]> = [
  ["parseable control (readable pod that exists)", parseableLease],
  ["empty", () => ""],
  ["truncated mid-pod", (w) => schemaRefused(w, { present: true, value: OTHER_POD }).slice(0, -90)],
  [
    "schema-refused, pod names no pod",
    (w) => schemaRefused(w, { present: true, value: "ag-a69-keys-other" }),
  ],
  [
    "schema-refused, readable pod that exists",
    (w) => schemaRefused(w, { present: true, value: OTHER_POD }),
  ],
];

test("69.6 a REAL set of each of the six record-edit keys, identity + switch OFF: every held body answers `pod_starting … phase=turnover` (75) — lease and record byte-identical, no transcript copied, no adapter started", async () => {
  const api = await startKitApi("dev-kit");
  try {
    setProof(api, "exists");
    const rig = makeRig("a69k-held", true, api.url);
    for (const [label, raw] of HELD_BODIES) {
      const id = await createSession(rig, `a69k-held-${label.replace(/\W/g, "")}`);
      plantTranscript(rig, id);
      const lease = plantLease(rig, id, raw(rig.world));
      const leaseBytes = fs.readFileSync(lease, "utf8");
      const recordBytes = fs.readFileSync(recordFileOf(rig, id), "utf8");
      const opsBytes = readOps(rig);
      for (const { key, argv } of KEYS) {
        const result = await runCli(rig, argv(id));
        const where = `${label} / set ${key}: rc ${result.status} ${result.stderr.slice(0, 300)}`;
        assert.equal(result.status, 75, where);
        assert.match(result.stderr.split("\n")[0] ?? "", TURNOVER_TOKEN, where);
        assert.equal(fs.readFileSync(lease, "utf8"), leaseBytes, `lease: ${where}`);
        assert.equal(
          fs.readFileSync(recordFileOf(rig, id), "utf8"),
          recordBytes,
          `record: ${where}`,
        );
        assert.equal(readOps(rig), opsBytes, `an adapter operation ran: ${where}`);
        assert.equal(
          fs.existsSync(transcriptIn(rig, id, "subB")),
          false,
          `a transcript was copied: ${where}`,
        );
      }
    }
  } finally {
    await api.close();
  }
});

// ---- the passing pairs: each WRITES, as today ----

const PASSING: Array<[string, boolean, Proof, ((w: PodWorld) => string) | undefined]> = [
  ["no identity, empty lease", false, "exists", () => ""],
  ["identity, no `pod` key", true, "exists", (w) => schemaRefused(w, { present: false })],
  [
    "identity, readable pod, C3.3 gone",
    true,
    "gone",
    (w) => schemaRefused(w, { present: true, value: OTHER_POD }),
  ],
];

test("69.6 passing pairs through the real CLI: a host WITHOUT the identity, a body with no `pod` key, and a readable pod proven gone are not held — each of the six keys writes its field", async () => {
  const api = await startKitApi("dev-kit");
  try {
    for (const [label, identity, proof, raw] of PASSING) {
      setProof(api, proof);
      const rig = makeRig("a69k-pass", identity, api.url);
      for (const { key, argv, written, value } of KEYS) {
        const id = await createSession(rig, `a69k-pass-${key}`);
        if (key === "subscription" || key === "profile") {
          plantTranscript(rig, id);
        }
        if (raw) {
          plantLease(rig, id, raw(rig.world));
        }
        const result = await runCli(rig, argv(id));
        const where = `${label} / set ${key}: rc ${result.status} ${result.stderr.slice(0, 300)}`;
        assert.doesNotMatch(result.stderr, /REFUSED /, where);
        assert.equal(result.status, 0, where);
        assert.deepEqual(
          written(diskRecord(rig, id).acpx?.session_options ?? {}),
          value,
          `the setter did not write the record: ${where}`,
        );
        if (key === "subscription" || key === "profile") {
          // The positive control of the refused rows' "no transcript copied": the same probe finds the copy.
          assert.equal(
            fs.existsSync(transcriptIn(rig, id, "subB")),
            true,
            `the switch copied no transcript: ${where}`,
          );
        }
      }
    }
  } finally {
    await api.close();
  }
});

// ---- discovering: EVERY exported `setSession*` setter refuses first ----

function isTurnoverRefusal(error: unknown): boolean {
  return (
    error instanceof CapacityRefusedError &&
    (error.capacityRefusal.tokenLine ?? "").includes("phase=turnover")
  );
}

test("69.6 every exported `setSession*` setter of session-control answers the turnover refusal on a held lease before it reads anything (discovered, not listed)", async () => {
  const api = await startKitApi("dev-kit");
  const world = makeWorld("a69k-discover");
  try {
    setProof(api, "exists");
    const env = worldEnv(world, {
      place: "control",
      podMode: false,
      identity: true,
      extra: { ACPX_POD_API_URL: api.url },
    });
    const file = queueLockFilePath(ID, world.home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A lease acpx CANNOT parse (readable pod that exists): only the wake guard judges it. The parseable control
    // would be vacuous here — the lease read itself already answers 75 for it, whichever setter reads first.
    fs.writeFileSync(file, schemaRefused(world, { present: true, value: OTHER_POD }));
    const setters = Object.entries(sessionControl).filter(
      ([name, value]) => name.startsWith("setSession") && typeof value === "function",
    );
    // The discovery's own control: the six keys of this row and the family the earlier rows guarded are all found.
    for (const name of [
      "setSessionSubscription",
      "setSessionProfile",
      "setSessionOutputStyle",
      "setSessionAutoFailover",
      "setSessionAutoSubscription",
      "setSessionFableDegrade",
      "setSessionModel",
      "setSessionConfigOption",
      "setSessionDepth",
      "setSessionMode",
    ]) {
      assert.ok(
        setters.some(([found]) => found === name),
        `${name} was discovered`,
      );
    }
    // Negative control of the predicate: what an UNGUARDED setter throws on a session with no record is no refusal.
    assert.equal(isTurnoverRefusal(new Error("session not found")), false);
    await withEnv(env, async () => {
      for (const [name, setter] of setters) {
        // The session has NO record: a setter that reads anything first would fail with something else.
        await assert.rejects(
          (setter as (options: { sessionId: string }) => Promise<unknown>)({ sessionId: ID }),
          isTurnoverRefusal,
          `${name} did not refuse first`,
        );
      }
    });
  } finally {
    await api.close();
  }
});
