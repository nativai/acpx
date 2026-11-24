import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  readQueueOwnerLeaseFile,
  tryAcquireQueueOwnerLease,
  type LeaseFile,
} from "../src/cli/queue/lease-store.js";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import { heldLeasePod } from "../src/cli/session/pod-wake-guard.js";
import { localProofScope } from "../src/pod/proof-scope.js";
import {
  clearNodes,
  clearPods,
  failWith,
  putNode,
  putPod,
  requestLines,
  startKitApi,
  type FakeApiServer,
} from "./pod-kit-api-helpers.js";
import { makeWorld, withEnv, worldEnv, type PodWorld, type WorldEnv } from "./pod-owner-helpers.js";
import {
  makeSessionRecord,
  sessionFilePath,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// A-69 (brick b2abea18; C3.1 removal, C1.1 the lease decides, A-16's hold; test-plan rows 69.1, 72.1 and
// the A-16 real-CLI row). A lease acpx cannot parse is NEVER removed by age on a host that has the pod's
// identity: bytes that cannot be read or are not JSON, and JSON that is not an object (A-72), are held;
// JSON the record schema refuses is judged by its `pod` KEY (A-68's `podFieldOf`): a `pod` that names no
// pod is held, a readable `pod` is removed only by the control pod on C3.3 `gone` after 15 s unchanged,
// no key follows today's 15 s rule on the control pod and waits in an agent pod. A host WITHOUT the
// identity keeps today's rule exactly. Red at 14f83458: `acquireUnderGuard` removed every body by age on
// every host (TE-7, `afterAcquireExists:false`).
// Pods are stood up through the product's own seams; every state home is the world's sandbox.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const ID = "rec-a69-unparsable-1";
const STALE = "2026-01-01T00:00:00.000Z";
const GONE_UID = "66666666-6666-4666-8666-666666666666";
const OTHER_POD = { name: "ag-a69-other", uid: GONE_UID, node: "n-a69" };

/** The four shapes of a `pod` key that names no pod (A-68). */
const NO_POD_SHAPES: Array<[string, unknown]> = [
  ["no uid", { name: "ag-a69-other" }],
  ["a string", "ag-a69-other"],
  ["null", null],
  ["empty object", {}],
];

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(child.pid, "spawned a short-lived process");
  return child.pid;
}

/** A whole lease whose ONLY fault is `ownerGeneration: "g-3"`, a newer writer's field type (TE-7). */
function schemaRefused(
  world: PodWorld,
  pod: { present: false } | { present: true; value: unknown },
): string {
  return `${JSON.stringify(
    {
      sessionId: ID,
      pid: deadPid(),
      socketPath: path.join(world.root, "a69.sock"),
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

type BodyKind = "bytes" | "schema-no-pod" | "schema-readable" | "schema-no-key";
type Body = { label: string; kind: BodyKind; raw: (world: PodWorld) => string };

const BODIES: Body[] = [
  { label: "empty", kind: "bytes", raw: () => "" },
  {
    label: "truncated mid-pod",
    kind: "bytes",
    raw: (world) => schemaRefused(world, { present: true, value: OTHER_POD }).slice(0, -90),
  },
  // A-72 (1): JSON that is not an object is kind (1) — never "no `pod` key".
  ...["null", "[]", "7", '"x"', "true"].map(
    (raw): Body => ({ label: `JSON ${raw}`, kind: "bytes", raw: () => `${raw}\n` }),
  ),
  ...NO_POD_SHAPES.map(
    ([label, value]): Body => ({
      label: `schema-refused, pod ${label}`,
      kind: "schema-no-pod",
      raw: (world) => schemaRefused(world, { present: true, value }),
    }),
  ),
  {
    label: "schema-refused, readable pod",
    kind: "schema-readable",
    raw: (world) => schemaRefused(world, { present: true, value: OTHER_POD }),
  },
  {
    label: "schema-refused, no pod key",
    kind: "schema-no-key",
    raw: (world) => schemaRefused(world, { present: false }),
  },
];

type Host = "no identity" | "control, switch off" | "control, switch on" | "agent pod";
const HOSTS: Host[] = ["no identity", "control, switch off", "control, switch on", "agent pod"];

function hostEnv(world: PodWorld, host: Host, apiUrl?: string): Record<string, string | undefined> {
  const extra = apiUrl ? { ACPX_POD_API_URL: apiUrl } : undefined;
  const options: WorldEnv =
    host === "no identity"
      ? { place: "control", identity: false, extra }
      : host === "agent pod"
        ? { place: "agent-pod", podMode: true, extra }
        : { place: "control", podMode: host === "control, switch on", extra };
  return worldEnv(world, options);
}

/** C3.3's three answers, over the kit API server. */
type Proof = "gone" | "exists" | "unknown";
function setProof(api: FakeApiServer, proof: Proof): void {
  clearPods(api);
  clearNodes(api);
  failWith(api, undefined);
  if (proof === "gone") {
    putNode(api, OTHER_POD.node, "True"); // no pod with that uid, its node Ready or gone
  } else if (proof === "exists") {
    putNode(api, OTHER_POD.node, "True");
    putPod(api, OTHER_POD.name, { uid: GONE_UID, phase: "Running", node: OTHER_POD.node });
  } else {
    putNode(api, OTHER_POD.node, "False"); // the pod is gone but its node is not Ready
  }
}

function plant(world: PodWorld, raw: string, ageMs: number): string {
  const file = queueLockFilePath(ID, world.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
  return file;
}

type ProofScopeReading = Awaited<ReturnType<typeof localProofScope>>;
const OLD_MS = 60_000; // well past the 15 s rule
const YOUNG_MS = 2_000;

/** What acquire does with `kind` on `host`, the 15 s old body, once the proof (when asked) is `proof`. */
function expectRemoved(host: Host, kind: BodyKind, proof: Proof): boolean {
  if (host === "no identity") {
    return true; // today's rule, every body
  }
  const control = host !== "agent pod";
  if (kind === "schema-no-key") {
    return control;
  }
  return kind === "schema-readable" && control && proof === "gone";
}

async function acquireOnce(world: PodWorld, host: Host, api: FakeApiServer): Promise<void> {
  await withEnv(hostEnv(world, host, api.url), async () => {
    assert.equal(await tryAcquireQueueOwnerLease(ID), undefined, "a body that stands is not taken");
  });
}

test("69.1 the lease store's acquire, three hosts (four states) × every body: removed or held exactly as A-69 says, held bodies byte-identical", async () => {
  const api = await startKitApi("dev-kit");
  try {
    for (const host of HOSTS) {
      for (const body of BODIES) {
        const proofs: Proof[] =
          body.kind === "schema-readable" ? ["gone", "exists", "unknown"] : ["gone"];
        for (const proof of proofs) {
          setProof(api, proof);
          const before = requestLines(api).length;
          const world = makeWorld("a69-matrix");
          const raw = body.raw(world);
          const file = plant(world, raw, OLD_MS);
          const where = `${host} / ${body.label}${body.kind === "schema-readable" ? ` / C3.3 ${proof}` : ""}`;
          await acquireOnce(world, host, api);
          if (expectRemoved(host, body.kind, proof)) {
            assert.equal(fs.existsSync(file), false, `${where}: removed`);
          } else {
            assert.equal(fs.readFileSync(file, "utf8"), raw, `${where}: held, byte-identical`);
          }
          // The API server is asked ONLY for a readable pod, on the control pod with the identity.
          const asked = requestLines(api).length - before;
          const mayAsk = body.kind === "schema-readable" && host.startsWith("control");
          assert.equal(asked > 0, mayAsk, `${where}: API requests ${asked}`);
        }
      }
    }
  } finally {
    await api.close();
  }
});

test("69.1 negative cases: a body well-formed in every other respect is still held — young (not 15 s old), an API that cannot answer", async () => {
  const api = await startKitApi("dev-kit");
  try {
    for (const host of ["control, switch off", "control, switch on"] as const) {
      // Gone, but younger than 15 s: the age rule is the stand-in for the stale heartbeat it cannot read.
      setProof(api, "gone");
      const before = requestLines(api).length;
      const young = makeWorld("a69-young");
      const raw = schemaRefused(young, { present: true, value: OTHER_POD });
      const file = plant(young, raw, YOUNG_MS);
      await acquireOnce(young, host, api);
      assert.equal(fs.readFileSync(file, "utf8"), raw, `${host}: young body held`);
      assert.equal(requestLines(api).length, before, `${host}: a young body asks nothing`);

      // An API that answers 500 or stalls is `unknown`, which is alive.
      for (const failure of ["500", "stall"] as const) {
        setProof(api, "gone");
        failWith(api, failure);
        const world = makeWorld("a69-fault");
        const faulty = plant(
          world,
          schemaRefused(world, { present: true, value: OTHER_POD }),
          OLD_MS,
        );
        await acquireOnce(world, host, api);
        assert.ok(fs.existsSync(faulty), `${host}: API ${failure} is unknown, the body is held`);
      }
      failWith(api, undefined);
    }
  } finally {
    await api.close();
  }
});

test("69.1 negative case: a readable-pod body REWRITTEN while the proof is in flight is kept — the removal rests on the bytes that were judged", async () => {
  const api = await startKitApi("dev-kit");
  try {
    for (const host of ["control, switch off", "control, switch on"] as const) {
      setProof(api, "gone");
      api.setFaults([{ mode: "slow", delayMs: 1500 }]); // every answer comes 1.5 s late
      const world = makeWorld("a69-rewrite");
      const file = plant(world, schemaRefused(world, { present: true, value: OTHER_POD }), OLD_MS);
      const rewritten = schemaRefused(world, { present: true, value: OTHER_POD }).replace(
        '"g-3"',
        '"g-4"',
      );
      const acquiring = acquireOnce(world, host, api);
      await new Promise((resolve) => setTimeout(resolve, 400));
      fs.writeFileSync(file, rewritten); // a writer rewrote it: a fresh mtime, other bytes
      await acquiring;
      assert.equal(fs.readFileSync(file, "utf8"), rewritten, `${host}: the rewritten body stands`);
      failWith(api, undefined);
    }
  } finally {
    await api.close();
  }
});

test("69.1 C3.3 `gone` and 15 s unchanged remove a readable-pod body ONCE and the pod's end is kept on the session record", async () => {
  const api = await startKitApi("dev-kit");
  try {
    for (const host of ["control, switch off", "control, switch on"] as const) {
      setProof(api, "gone");
      const world = makeWorld("a69-once");
      await writeSessionRecordFile(
        world.home,
        makeSessionRecord({
          acpxRecordId: ID,
          acpSessionId: "acp-a69",
          agentCommand: "claude",
          cwd: world.home,
        }),
      );
      const file = plant(world, schemaRefused(world, { present: true, value: OTHER_POD }), OLD_MS);
      const before = requestLines(api).length;
      await acquireOnce(world, host, api);
      assert.equal(fs.existsSync(file), false, `${host}: removed`);
      const podGets = requestLines(api)
        .slice(before)
        .filter((line) => line.includes(`/pods/${OTHER_POD.name}`));
      assert.equal(podGets.length, 1, `${host}: the pod was proven once`);
      const stored = JSON.parse(fs.readFileSync(sessionFilePath(world.home, ID), "utf8")) as {
        acpx?: { last_pod_end?: { uid?: string; proof?: string } };
      };
      assert.equal(stored.acpx?.last_pod_end?.uid, GONE_UID, `${host}: the end is recorded`);
      assert.equal(stored.acpx?.last_pod_end?.proof, "pod-gone");
    }
  } finally {
    await api.close();
  }
});

test("69.1 passing pair: a host WITHOUT the identity removes an empty lease after 15 s exactly as today, and not before", async () => {
  const api = await startKitApi("dev-kit");
  try {
    const world = makeWorld("a69-pair");
    const young = plant(world, "", YOUNG_MS);
    await acquireOnce(world, "no identity", api);
    assert.ok(fs.existsSync(young), "a young empty lease is the starting pre-0a owner's: kept");
    const old = new Date(Date.now() - OLD_MS);
    fs.utimesSync(young, old, old);
    await acquireOnce(world, "no identity", api);
    assert.equal(fs.existsSync(young), false, "old and unchanged: removed");
    assert.deepEqual(requestLines(api), [], "no API request on a host without the identity");
  } finally {
    await api.close();
  }
});

test("69.1 passing pair: the same lease when parseable goes through `judgeLease` as before — a whole lease with a fresh heartbeat naming another pod is never taken, on every host", async () => {
  const api = await startKitApi("dev-kit");
  try {
    for (const host of HOSTS) {
      const world = makeWorld("a69-whole");
      const now = new Date().toISOString();
      const whole = `${JSON.stringify({
        sessionId: ID,
        pid: process.pid,
        socketPath: path.join(world.root, "a69.sock"),
        createdAt: now,
        heartbeatAt: now,
        ownerGeneration: 3,
        queueDepth: 0,
        pod: OTHER_POD,
      })}\n`;
      const file = plant(world, whole, OLD_MS);
      await acquireOnce(world, host, api);
      assert.equal(fs.readFileSync(file, "utf8"), whole, `${host}: a live holder stands`);
    }
  } finally {
    await api.close();
  }
});

// ---- the reader: kind (1) / kind (2), and A-72's five bodies on the kind (1) side ----

test('72.1 acpx half: JSON that is not an object (null, [], 7, "x", true) reads as kind (1), never as a body without a `pod` key', async () => {
  const world = makeWorld("a72-shape");
  await withEnv(hostEnv(world, "control, switch off"), async () => {
    const shapes = async (raw: string): Promise<LeaseFile> => {
      plant(world, raw, OLD_MS);
      return await readQueueOwnerLeaseFile(ID);
    };
    for (const raw of [
      "null",
      "[]",
      "7",
      '"x"',
      "true",
      "",
      "{",
      '{"pid":1,"pod":{"name":"ag-x","uid":"u',
    ]) {
      assert.deepEqual(
        await shapes(raw),
        { kind: "unparsable", shape: { kind: "bytes" } },
        `body ${JSON.stringify(raw)}`,
      );
    }
    // The passing pair: a JSON OBJECT the schema refuses is kind (2), judged by its key.
    assert.deepEqual(await shapes("{}"), {
      kind: "unparsable",
      shape: { kind: "schema", pod: { kind: "absent" } },
    });
    assert.deepEqual(await shapes('{"pod":null}'), {
      kind: "unparsable",
      shape: { kind: "schema", pod: { kind: "unreadable" } },
    });
    const readable = await shapes(JSON.stringify({ pod: OTHER_POD, ownerGeneration: "g-3" }));
    assert.deepEqual(readable, {
      kind: "unparsable",
      shape: { kind: "schema", pod: { kind: "pod", pod: OTHER_POD } },
    });
  });
});

test("69.4 a lease acpx cannot parse is local or not by the store's SHAPE: no `pod` key → local; a readable `pod` → not local `session-in-pod`; a `pod` naming no pod and every kind (1) body → `pod-unreadable`", async () => {
  const expected: Record<BodyKind, ProofScopeReading> = {
    bytes: { local: false, reason: "pod-unreadable" },
    "schema-no-pod": { local: false, reason: "pod-unreadable" },
    "schema-readable": { local: false, reason: "session-in-pod" },
    "schema-no-key": { local: true },
  };
  for (const body of BODIES) {
    const world = makeWorld("a69-scope");
    plant(world, body.raw(world), OLD_MS);
    await withEnv(hostEnv(world, "control, switch off"), async () => {
      assert.deepEqual(await localProofScope(ID), expected[body.kind], body.label);
    });
    // The host without the identity reads every lease as local (nothing there is a pod's), as before.
    await withEnv(hostEnv(world, "no identity"), async () => {
      assert.deepEqual(await localProofScope(ID), { local: true }, `${body.label}, no identity`);
    });
  }
});

// ---- A-16's hold, the guard's mapping ----

test("A-16 the wake guard's reading of a lease (`heldLeasePod`): what A-69 holds is held, on a host with the identity only", () => {
  const bytes: LeaseFile = { kind: "unparsable", shape: { kind: "bytes" } };
  const noPod: LeaseFile = {
    kind: "unparsable",
    shape: { kind: "schema", pod: { kind: "unreadable" } },
  };
  const readable: LeaseFile = {
    kind: "unparsable",
    shape: { kind: "schema", pod: { kind: "pod", pod: OTHER_POD } },
  };
  const noKey: LeaseFile = {
    kind: "unparsable",
    shape: { kind: "schema", pod: { kind: "absent" } },
  };
  assert.equal(heldLeasePod(bytes, true), "unreadable");
  assert.equal(heldLeasePod(noPod, true), "unreadable");
  assert.deepEqual(heldLeasePod(readable, true), OTHER_POD);
  assert.equal(heldLeasePod(noKey, true), undefined, "a control-pod writer's lease is not held");
  assert.equal(heldLeasePod({ kind: "missing" }, true), undefined);
  // Without the identity an unparsable lease is no lease, as before.
  for (const lease of [bytes, noPod, readable, noKey]) {
    assert.equal(heldLeasePod(lease, false), undefined);
  }
});

// ---- a REAL `acpx prompt` / `acpx sessions close` ----

type Run = { status: number | null; stdout: string; stderr: string };

function cliEnv(world: PodWorld, identity: boolean, apiUrl: string): NodeJS.ProcessEnv {
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
  return env;
}

function runCli(env: NodeJS.ProcessEnv, cwd: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "--agent", `node ${MOCK_AGENT}`, ...args], {
      env,
      cwd,
    });
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

async function createSession(env: NodeJS.ProcessEnv, cwd: string, name: string): Promise<string> {
  const created = await runCli(env, cwd, ["--format", "json", "sessions", "new", "--name", name]);
  const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
    created.stdout,
  )?.[1];
  assert.ok(
    id,
    `a session was created: ${created.stdout.slice(0, 300)} ${created.stderr.slice(0, 300)}`,
  );
  return id;
}

const TURNOVER_TOKEN =
  /^acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=turnover wake=/;
const CLOSE = (id: string) => ["--verbose", "sessions", "close", "--session-id", id];
const PROMPT = (id: string) => ["--format", "quiet", "prompt", "--session-id", id, "echo a69"];

function cliCwd(): string {
  return fs.mkdtempSync(
    path.join(process.env.ACPX_SESSION_SHARED_TMP || process.cwd(), "a69-cwd-"),
  );
}

function recordFileOf(world: PodWorld, id: string): string {
  return path.join(world.home, ".acpx", "sessions", `${encodeURIComponent(id)}.json`);
}

function plantFor(world: PodWorld, id: string, raw: string): string {
  const file = queueLockFilePath(id, world.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw);
  const when = new Date(Date.now() - OLD_MS);
  fs.utimesSync(file, when, when);
  return file;
}

test("A-16 / 69.1 a REAL prompt and close on a control pod with the identity and the switch OFF: a lease acpx cannot parse answers `pod_starting … phase=turnover` (75), record and lease byte-identical, nothing written", async () => {
  const api = await startKitApi("dev-kit");
  const world = makeWorld("a69-cli-held");
  const env = cliEnv(world, true, api.url);
  const cwd = cliCwd();
  try {
    setProof(api, "exists");
    const held: Array<[string, (w: PodWorld) => string]> = [
      ["empty", () => ""],
      [
        "truncated mid-pod",
        (w) => schemaRefused(w, { present: true, value: OTHER_POD }).slice(0, -90),
      ],
      ["JSON null", () => "null\n"],
      ["JSON []", () => "[]\n"],
      [
        "schema-refused, pod names no pod",
        (w) => schemaRefused(w, { present: true, value: "ag-a69-other" }),
      ],
      [
        "schema-refused, readable pod that exists",
        (w) => schemaRefused(w, { present: true, value: OTHER_POD }),
      ],
    ];
    for (const [label, raw] of held) {
      for (const verb of [CLOSE, PROMPT]) {
        const id = await createSession(env, cwd, `a69-held-${label.replace(/\W/g, "")}`);
        const lease = plantFor(world, id, raw(world));
        const bytes = fs.readFileSync(lease, "utf8");
        const record = fs.readFileSync(recordFileOf(world, id), "utf8");
        const result = await runCli(env, cwd, verb(id));
        const where = `${label} ${verb === CLOSE ? "close" : "prompt"}: ${result.stderr.slice(0, 300)}`;
        assert.equal(result.status, 75, where);
        assert.match(result.stderr.split("\n")[0] ?? "", TURNOVER_TOKEN, where);
        assert.equal(fs.readFileSync(lease, "utf8"), bytes, `lease: ${where}`);
        assert.equal(fs.readFileSync(recordFileOf(world, id), "utf8"), record, `record: ${where}`);
      }
    }
  } finally {
    await api.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("A-16 / 69.1 passing pairs through the real CLI: a host WITHOUT the identity, a body with no `pod` key, and a readable pod proven gone are not held — the close runs", async () => {
  const api = await startKitApi("dev-kit");
  const cwd = cliCwd();
  try {
    const cases: Array<[string, boolean, Proof, (w: PodWorld) => string]> = [
      ["no identity, empty lease", false, "exists", () => ""],
      ["identity, no `pod` key", true, "exists", (w) => schemaRefused(w, { present: false })],
      [
        "identity, readable pod, C3.3 gone",
        true,
        "gone",
        (w) => schemaRefused(w, { present: true, value: OTHER_POD }),
      ],
    ];
    for (const [label, identity, proof, raw] of cases) {
      setProof(api, proof);
      const world = makeWorld("a69-cli-pass");
      const env = cliEnv(world, identity, api.url);
      const id = await createSession(env, cwd, `a69-pass-${label.replace(/\W/g, "")}`);
      plantFor(world, id, raw(world));
      const result = await runCli(env, cwd, CLOSE(id));
      assert.doesNotMatch(result.stderr, /REFUSED /, `${label}: ${result.stderr.slice(0, 300)}`);
      assert.equal(
        result.status,
        0,
        `${label}: rc ${result.status} ${result.stderr.slice(0, 300)}`,
      );
    }
  } finally {
    await api.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ---- round 2 (TE F-1): the setting verbs' no-owner fallbacks and `cancel` ----
// A lease acpx cannot parse is no owner record, so `set-mode`, `set model`, `set <key>` and `cancel` read "no
// owner" and acted locally — `set-mode` & co. started a LOCAL ADAPTER and rewrote `acp_session_id`, while the same
// session with a PARSEABLE lease naming the same pod got the connect door's 75. Red at 0334cca7.

const SETTING_VERBS: Array<[string, (id: string) => string[]]> = [
  ["set-mode", (id) => ["set-mode", "plan", "--session-id", id]],
  ["set model", (id) => ["set", "model", "opus", "--session-id", id]],
  ["set <key>", (id) => ["set", "thought_level", "high", "--session-id", id]],
  ["cancel", (id) => ["cancel", "--session-id", id]],
];

/** A whole lease naming `OTHER_POD`, stale heartbeat, dead pid: the parseable control of the held bodies. */
function parseableLease(world: PodWorld): string {
  return schemaRefused(world, { present: true, value: OTHER_POD }).replace(
    '"ownerGeneration": "g-3"',
    '"ownerGeneration": 3',
  );
}

test("A-16 round 2 / 69.1 a REAL set-mode, set model, set <key> and cancel, identity + switch OFF: a lease acpx cannot parse answers 75 exactly as the parseable control does — record and lease byte-identical, no adapter started", async () => {
  const api = await startKitApi("dev-kit");
  const world = makeWorld("a69-cli-r2");
  const env = cliEnv(world, true, api.url);
  const cwd = cliCwd();
  try {
    setProof(api, "exists");
    const bodies: Array<[string, (w: PodWorld) => string]> = [
      ["parseable control (readable pod that exists)", parseableLease],
      ["empty", () => ""],
      [
        "truncated mid-pod",
        (w) => schemaRefused(w, { present: true, value: OTHER_POD }).slice(0, -90),
      ],
      ["JSON null", () => "null\n"],
      [
        "schema-refused, pod names no pod",
        (w) => schemaRefused(w, { present: true, value: "ag-a69-other" }),
      ],
      [
        "schema-refused, readable pod that exists",
        (w) => schemaRefused(w, { present: true, value: OTHER_POD }),
      ],
    ];
    for (const [label, raw] of bodies) {
      for (const [verb, argv] of SETTING_VERBS) {
        const id = await createSession(env, cwd, `a69-r2-${label.replace(/\W/g, "")}`);
        const lease = plantFor(world, id, raw(world));
        const bytes = fs.readFileSync(lease, "utf8");
        const record = fs.readFileSync(recordFileOf(world, id), "utf8");
        const result = await runCli(env, cwd, argv(id));
        const where = `${label} / ${verb}: rc ${result.status} ${result.stderr.slice(0, 300)}`;
        assert.equal(result.status, 75, where);
        assert.match(result.stderr.split("\n")[0] ?? "", TURNOVER_TOKEN, where);
        assert.equal(fs.readFileSync(lease, "utf8"), bytes, `lease: ${where}`);
        assert.equal(fs.readFileSync(recordFileOf(world, id), "utf8"), record, `record: ${where}`);
      }
    }
  } finally {
    await api.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("A-16 round 2 passing pairs through the real CLI: a host WITHOUT the identity, a body with no `pod` key, and a readable pod proven gone are not held — set-mode and cancel run", async () => {
  const api = await startKitApi("dev-kit");
  const cwd = cliCwd();
  try {
    const cases: Array<[string, boolean, Proof, (w: PodWorld) => string]> = [
      ["no identity, empty lease", false, "exists", () => ""],
      ["identity, no `pod` key", true, "exists", (w) => schemaRefused(w, { present: false })],
      [
        "identity, readable pod, C3.3 gone",
        true,
        "gone",
        (w) => schemaRefused(w, { present: true, value: OTHER_POD }),
      ],
    ];
    for (const [label, identity, proof, raw] of cases) {
      for (const [verb, argv] of [SETTING_VERBS[0], SETTING_VERBS[3]] as typeof SETTING_VERBS) {
        setProof(api, proof);
        const world = makeWorld("a69-cli-r2-pass");
        const env = cliEnv(world, identity, api.url);
        const id = await createSession(env, cwd, `a69-r2pass-${label.replace(/\W/g, "")}`);
        plantFor(world, id, raw(world));
        const result = await runCli(env, cwd, argv(id));
        const where = `${label} / ${verb}: rc ${result.status} ${result.stderr.slice(0, 300)}`;
        assert.doesNotMatch(result.stderr, /REFUSED /, where);
        assert.equal(result.status, 0, where);
      }
    }
  } finally {
    await api.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
