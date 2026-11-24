import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ensureOwnerIsUsable,
  readQueueOwnerRecord,
  readQueueOwnerState,
  readQueueOwnerStatus,
  recoverQueueOwnerForSession,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/lease-store.js";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import { podFieldOf } from "../src/pod/identity.js";
import { localProofScope } from "../src/pod/proof-scope.js";
import { refuseWhilePodNotGone } from "../src/pod/turnover-guard.js";
import {
  judgeLockHolder,
  lockBreakLedgerPath,
  sweepOwnPodLocks,
} from "../src/session/persistence/identity-file-lock.js";
import { sessionBaseDir } from "../src/session/persistence/session-base-dir.js";
import { clearPods, putNode, putPod, requestLines, startKitApi } from "./pod-kit-api-helpers.js";
import { makeWorld, withEnv, worldEnv, type PodWorld } from "./pod-owner-helpers.js";

// A-68 (brick c365682f; C3.2 "A `pod` key that names no pod", C3.1, C3.3, C1.1; test-plan row 68.1).
// A lease or lock body that has a `pod` KEY carries `pod`, whatever the value. One whose `pod` names no
// pod is a holder in ANOTHER pod on every host: no judgement removes it — never the pid rule, birth
// identity or age — and the session is not local while it stands (`not-local-proof`, `pod-unreadable`).
// The passing pair: the same body with NO `pod` key is still reaped by the pid rule, as today.
// Red at 523c63c0 (and 9c44d2ae): `judgeLease` read the four shapes as podless, took the pid rule on the
// control pod, read `dead_owner` and unlinked the lease (A11 TE round 2, LOW-1b).
// Pods are stood up through the product's own seams; every state home is the world's sandbox.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const STALE = "2026-01-01T00:00:00.000Z";
const ID = "rec-a68-lease-judge-1";

/** The four shapes of a `pod` key that names no pod (row 68.1). */
const SHAPES: Array<[string, unknown]> = [
  ["no uid", { name: "ag-a68" }],
  ["a string", "ag-a68"],
  ["null", null],
  ["empty object", {}],
];

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(child.pid, "spawned a short-lived process");
  return child.pid;
}

/** A lease body: pid dead on this host's table, no process identity (the legacy pid rule's input). */
function leaseBody(
  world: PodWorld,
  id: string,
  heartbeatAt: string,
  pod: { present: false } | { present: true; value: unknown },
): Record<string, unknown> {
  return {
    sessionId: id,
    pid: deadPid(),
    socketPath: path.join(world.root, `${id}.sock`),
    createdAt: STALE,
    heartbeatAt,
    ownerGeneration: 3,
    queueDepth: 0,
    ...(pod.present ? { pod: pod.value } : {}),
  };
}

function plantLease(world: PodWorld, id: string, body: Record<string, unknown>): string {
  const file = queueLockFilePath(id, world.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return fs.readFileSync(file, "utf8");
}

/** The control pod, with the switch off and on. */
const SWITCHES = [false, true] as const;
const controlEnv = (
  world: PodWorld,
  podMode: boolean,
  extra?: Record<string, string | undefined>,
) => worldEnv(world, { place: "control", podMode, extra });

// ---- the lease judge and every remover that inherits it ----

test("68.1 lease: a `pod` key that names no pod is never reaped by the pid rule — every judging path, every shape, switch off and on, stale heartbeat", async () => {
  for (const [label, value] of SHAPES) {
    for (const podMode of SWITCHES) {
      const world = makeWorld(`a68-${label.replace(/\W/g, "")}-${podMode}`);
      const lease = plantLease(world, ID, leaseBody(world, ID, STALE, { present: true, value }));
      const file = queueLockFilePath(ID, world.home);
      const where = `${label}, podMode=${podMode}`;
      const untouched = (step: string) =>
        assert.equal(
          fs.readFileSync(file, "utf8"),
          lease,
          `${where}: lease untouched after ${step}`,
        );
      await withEnv(controlEnv(world, podMode), async () => {
        const state = await readQueueOwnerState(ID);
        assert.equal(state.ownerFound, true, where);
        assert.equal(state.state, "foreign_owner", `${where}: judged as another pod's holder`);
        assert.equal(state.recoverable, false, where);
        assert.notEqual(state.alive, false, `${where}: never dead_owner (unknown is alive)`);
        untouched("readQueueOwnerState");

        assert.notEqual(await readQueueOwnerStatus(ID), undefined, `${where}: status sees it`);
        untouched("readQueueOwnerStatus (the status sweep)");

        const record = await readQueueOwnerRecord(ID);
        assert.ok(record, where);
        assert.equal(await ensureOwnerIsUsable(ID, record), false, where);
        untouched("ensureOwnerIsUsable");

        await recoverQueueOwnerForSession(ID);
        untouched("recover");

        await terminateQueueOwnerForSession(ID); // what `sessions close` calls
        untouched("terminate (the close)");

        assert.equal(await tryAcquireQueueOwnerLease(ID), undefined, where);
        untouched("tryAcquireQueueOwnerLease");

        assert.deepEqual(
          await localProofScope(ID),
          { local: false, reason: "pod-unreadable" },
          `${where}: the session is not local while it stands`,
        );
      });
    }
  }
});

test("68.1 lease: a FRESH heartbeat reads alive; a `pod` key that names no pod is not asked to the API server", async () => {
  const api = await startKitApi("dev-kit");
  try {
    for (const [label, value] of SHAPES) {
      const world = makeWorld(`a68-fresh-${label.replace(/\W/g, "")}`);
      plantLease(
        world,
        ID,
        leaseBody(world, ID, new Date().toISOString(), { present: true, value }),
      );
      await withEnv(
        controlEnv(world, true, { ACPX_POD_SA_DIR: world.saDir, ACPX_POD_API_URL: api.url }),
        async () => {
          const state = await readQueueOwnerState(ID);
          assert.equal(state.alive, true, label);
          assert.equal(state.recoverable, false, label);
        },
      );
    }
    assert.deepEqual(requestLines(api), [], "no request for a pod that cannot be named");
  } finally {
    await api.close();
  }
});

test("68.1 lease passing pair: the same lease with NO `pod` key and a dead pid is reaped by the pid rule, exactly as today", async () => {
  for (const podMode of SWITCHES) {
    const world = makeWorld(`a68-nokey-${podMode}`);
    plantLease(world, ID, leaseBody(world, ID, STALE, { present: false }));
    const file = queueLockFilePath(ID, world.home);
    await withEnv(controlEnv(world, podMode), async () => {
      const state = await readQueueOwnerState(ID);
      assert.equal(state.state, "dead_owner", `podMode=${podMode}`);
      assert.equal(state.recoverable, true);
      assert.equal(await readQueueOwnerStatus(ID), undefined, "the status sweep reaps it");
    });
    assert.equal(fs.existsSync(file), false, `podMode=${podMode}: lease unlinked`);
  }
});

test("68.1 lease passing pair: a READABLE `pod` whose pod is gone (C3.3 `gone`) is reaped once", async () => {
  const api = await startKitApi("dev-kit");
  try {
    const world = makeWorld("a68-gone");
    const pod = { name: "ag-a68", uid: "22222222-2222-4222-8222-222222222222", node: "n1" };
    plantLease(world, ID, leaseBody(world, ID, STALE, { present: true, value: pod }));
    const file = queueLockFilePath(ID, world.home);
    clearPods(api);
    putNode(api, "n1", "True");
    await withEnv(
      controlEnv(world, true, { ACPX_POD_SA_DIR: world.saDir, ACPX_POD_API_URL: api.url }),
      async () => {
        assert.equal(await readQueueOwnerStatus(ID), undefined);
      },
    );
    assert.equal(fs.existsSync(file), false, "reaped on the proof");
  } finally {
    await api.close();
  }
});

// ---- the lock judge (a record-lock body) and the control pod's lock sweep ----

function lockBody(
  podField: { present: false } | { present: true; value: unknown },
): Record<string, unknown> {
  return {
    pid: deadPid(),
    host: "elsewhere",
    token: `t-${Math.random()}`,
    ...(podField.present ? { pod: podField.value } : {}),
  };
}

function ledger(uid: string): Record<string, unknown>[] {
  const file = lockBreakLedgerPath(uid);
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}

test("68.1 lock: a record-lock body whose `pod` names no pod is not broken by the control pod's lock sweep, and no break line is written — every shape, switch off and on", async () => {
  for (const [label, value] of SHAPES) {
    for (const podMode of SWITCHES) {
      const world = makeWorld(`a68-lock-${label.replace(/\W/g, "")}-${podMode}`);
      await withEnv(controlEnv(world, podMode), async () => {
        const dir = sessionBaseDir();
        fs.mkdirSync(dir, { recursive: true });
        const lock = path.join(dir, `${ID}.json.lock`);
        const raw = JSON.stringify(lockBody({ present: true, value }));
        fs.writeFileSync(lock, raw);
        const old = new Date(Date.now() - 10 * 60_000); // far past every stale age: age must not break it
        fs.utimesSync(lock, old, old);
        const result = await sweepOwnPodLocks({ dirs: [dir] });
        assert.deepEqual(result.removed, [], `${label}, podMode=${podMode}`);
        assert.equal(fs.readFileSync(lock, "utf8"), raw, "the lock body stands");
        assert.deepEqual(ledger(world.pod.uid), [], "no break line");
      });
    }
  }
});

test("68.1 lock passing pair: a record-lock body with NO `pod` key and a dead pid is broken by the control pod's sweep by the pid rule", async () => {
  for (const podMode of SWITCHES) {
    const world = makeWorld(`a68-lock-nokey-${podMode}`);
    await withEnv(controlEnv(world, podMode), async () => {
      const dir = sessionBaseDir();
      fs.mkdirSync(dir, { recursive: true });
      const lock = path.join(dir, `${ID}.json.lock`);
      fs.writeFileSync(lock, JSON.stringify(lockBody({ present: false })));
      const result = await sweepOwnPodLocks({ dirs: [dir] });
      assert.deepEqual(result.removed, [lock], `podMode=${podMode}`);
      assert.equal(fs.existsSync(lock), false);
      assert.deepEqual(
        ledger(world.pod.uid).map((line) => line.proof),
        ["pid"],
      );
    });
  }
});

// ---- a REAL `acpx sessions close` ----

type Run = { status: number | null; stdout: string; stderr: string };

function cliEnv(world: PodWorld, podMode: boolean, apiUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(
    controlEnv(world, podMode, { ACPX_POD_SA_DIR: world.saDir, ACPX_POD_API_URL: apiUrl }),
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

/** One real-CLI world: a sandbox state home, a cwd under /workspace, the kit API answering "no pod". */
type CliWorld = { world: PodWorld; env: NodeJS.ProcessEnv; cwd: string; podMode: boolean };

function cliWorld(label: string, podMode: boolean, apiUrl: string): CliWorld {
  const world = makeWorld(`a68-cli-${label}-${podMode}`);
  // In pod mode a close asks the API server whether the session has an agent pod (the kit API: none), and
  // routes one whose cwd is outside the shared roots (`cwd_not_shared`). Either would end it BEFORE it
  // reaches the lease and leave it "untouched" for the wrong reason: the cwd is under /workspace, the API
  // answers, and `assertRan` fails the test if a run was refused or routed when it should have run.
  const cwd = fs.mkdtempSync(
    path.join(process.env.ACPX_SESSION_SHARED_TMP || process.cwd(), "a68-cwd-"),
  );
  return { world, env: cliEnv(world, podMode, apiUrl), cwd, podMode };
}

function recordFileOf(w: CliWorld, id: string): string {
  return path.join(w.world.home, ".acpx", "sessions", `${encodeURIComponent(id)}.json`);
}

const CLOSE = (id: string) => ["--verbose", "sessions", "close", "--session-id", id];
const PROMPT = (id: string) => ["--format", "quiet", "prompt", "--session-id", id, "echo a68"];

/** The run was neither refused nor routed, and ended `rc` — never "untouched" because it never ran. */
function assertRan(result: Run, rc: number, where: string): void {
  assert.doesNotMatch(
    result.stderr,
    /ROUTED outcome=|REFUSED |admission_busy|cwd_not_shared/,
    where,
  );
  assert.equal(result.status, rc, `${where}: rc ${result.status} ${result.stderr.slice(0, 300)}`);
}

async function readsUnreadable(w: CliWorld, id: string, where: string): Promise<void> {
  await withEnv(controlEnv(w.world, w.podMode), async () => {
    assert.deepEqual(
      await localProofScope(id),
      { local: false, reason: "pod-unreadable" },
      `${where}: not local`,
    );
  });
}

test("68.1 a REAL `acpx sessions close`, pod mode ON (C2 decides there): the lease whose `pod` names no pod survives it byte for byte, the session stays not-local; a lease without a `pod` key is reaped by the same close", async () => {
  const api = await startKitApi("dev-kit");
  const w = cliWorld("on", true, api.url);
  try {
    for (const [label, value] of SHAPES) {
      const id = await createSession(w.env, w.cwd, `a68-on-${label.replace(/\W/g, "")}`);
      const lease = plantLease(
        w.world,
        id,
        leaseBody(w.world, id, STALE, { present: true, value }),
      );
      const close = await runCli(w.env, w.cwd, CLOSE(id));
      assertRan(close, 0, `${label}, pod mode ON`);
      assert.equal(fs.readFileSync(queueLockFilePath(id, w.world.home), "utf8"), lease, label);
      await readsUnreadable(w, id, label);
    }
    const id = await createSession(w.env, w.cwd, "a68-on-nokey");
    plantLease(w.world, id, leaseBody(w.world, id, STALE, { present: false }));
    assertRan(await runCli(w.env, w.cwd, CLOSE(id)), 0, "no key, pod mode ON");
    assert.equal(fs.existsSync(queueLockFilePath(id, w.world.home)), false, "reaped by the close");
  } finally {
    await api.close();
    fs.rmSync(w.cwd, { recursive: true, force: true });
  }
});

test("68.4 / A-16 a REAL close and prompt, pod mode OFF on the control pod: a lease whose `pod` names no pod answers `pod_starting … phase=turnover` (75) exactly as a readable pod that exists does — record and lease byte-identical, nothing written", async () => {
  const api = await startKitApi("dev-kit");
  const w = cliWorld("off", false, api.url);
  try {
    const exists = "55555555-5555-4555-8555-555555555555";
    const cases: Array<[string, unknown]> = [
      ...SHAPES,
      ["uid renamed (a newer writer's shape)", { name: "ag-a68", uuid: exists, node: "n1" }],
    ];
    for (const [label, value] of cases) {
      for (const verb of [CLOSE, PROMPT]) {
        const id = await createSession(w.env, w.cwd, `a68-off-${label.replace(/\W/g, "")}`);
        const lease = plantLease(
          w.world,
          id,
          leaseBody(w.world, id, STALE, { present: true, value }),
        );
        const record = fs.readFileSync(recordFileOf(w, id), "utf8");
        const result = await runCli(w.env, w.cwd, verb(id));
        const where = `${label} ${verb === CLOSE ? "close" : "prompt"}: ${result.stderr.slice(0, 300)}`;
        assert.equal(result.status, 75, where);
        assert.match(result.stderr.split("\n")[0] ?? "", TURNOVER_TOKEN, where);
        assert.equal(
          fs.readFileSync(queueLockFilePath(id, w.world.home), "utf8"),
          lease,
          `lease: ${where}`,
        );
        assert.equal(fs.readFileSync(recordFileOf(w, id), "utf8"), record, `record: ${where}`);
        await readsUnreadable(w, id, where);
      }
    }
    // The control: a READABLE pod that exists gets the same answer, so "the same as a readable pod" is measured.
    putPod(api, "ag-a68-readable", { uid: exists, phase: "Running" });
    const id = await createSession(w.env, w.cwd, "a68-off-readable");
    const readable = { name: "ag-a68-readable", uid: exists, node: "n1" };
    plantLease(w.world, id, leaseBody(w.world, id, STALE, { present: true, value: readable }));
    const refused = await runCli(w.env, w.cwd, CLOSE(id));
    assert.equal(refused.status, 75, refused.stderr.slice(0, 300));
    assert.match(refused.stderr.split("\n")[0] ?? "", TURNOVER_TOKEN);
  } finally {
    await api.close();
    fs.rmSync(w.cwd, { recursive: true, force: true });
  }
});

test("68.4 / A-16 passing pair, pod mode OFF: a lease with NO `pod` key and a dead pid is reaped by a real close, and a real prompt wakes a local owner — as before", async () => {
  const api = await startKitApi("dev-kit");
  const w = cliWorld("off-pair", false, api.url);
  try {
    const closed = await createSession(w.env, w.cwd, "a68-pair-close");
    plantLease(w.world, closed, leaseBody(w.world, closed, STALE, { present: false }));
    assertRan(await runCli(w.env, w.cwd, CLOSE(closed)), 0, "no key, close");
    assert.equal(
      fs.existsSync(queueLockFilePath(closed, w.world.home)),
      false,
      "reaped by the close",
    );

    const woken = await createSession(w.env, w.cwd, "a68-pair-prompt");
    plantLease(w.world, woken, leaseBody(w.world, woken, STALE, { present: false }));
    assertRan(await runCli(w.env, w.cwd, PROMPT(woken)), 0, "no key, prompt");
    await withEnv(controlEnv(w.world, false), async () => {
      await terminateQueueOwnerForSession(woken); // the owner the prompt started
    });
  } finally {
    await api.close();
    fs.rmSync(w.cwd, { recursive: true, force: true });
  }
});

// ---- the guard itself ----

test("68.4 / A-16 the turnover guard: an `unreadable` lease pod is refused without asking the API server wherever the guard applies, and passes where it does not", async () => {
  const asked: string[] = [];
  const deps = (applies: boolean) => ({
    applies: () => applies,
    prove: async () => {
      asked.push("prove");
      return { answer: "gone" as const, proof: "pod-gone" as const };
    },
  });
  await assert.rejects(refuseWhilePodNotGone("rec-a68", "unreadable", deps(true)), (error: Error) =>
    TURNOVER_TOKEN.test(error.message),
  );
  await refuseWhilePodNotGone("rec-a68", "unreadable", deps(false)); // pod mode ON / an agent pod: not this guard
  assert.deepEqual(asked, [], "no proof is asked for a pod that cannot be named");
});

// ---- one predicate for both judges ----

test("68.1 the lease reader and the lock judge agree through ONE predicate (`podFieldOf`): the KEY decides, never the parsed value", async () => {
  const world = makeWorld("a68-agree");
  const readable = { name: "ag-a68", uid: "33333333-3333-4333-8333-333333333333" };
  const cases: Array<[string, { present: false } | { present: true; value: unknown }, string]> = [
    ["absent", { present: false }, "absent"],
    ...SHAPES.map(([label, value]): [string, { present: true; value: unknown }, string] => [
      label,
      { present: true, value },
      "unreadable",
    ]),
    ["readable", { present: true, value: readable }, "pod"],
  ];
  for (const [label, pod, kind] of cases) {
    const id = `rec-a68-agree-${label.replace(/\W/g, "")}`;
    const body = lockBody(pod);
    assert.equal(podFieldOf(body).kind, kind, `podFieldOf: ${label}`);
    plantLease(world, id, leaseBody(world, id, STALE, pod));
    const record = await withEnv(controlEnv(world, false), async () => readQueueOwnerRecord(id));
    assert.ok(record, label);
    // The lease reader reads the same verdict the lock judge does.
    assert.equal(record.podUnreadable === true, kind === "unreadable", `lease: ${label}`);
    assert.equal(record.pod !== undefined, kind === "pod", `lease: ${label}`);
    if (kind === "unreadable") {
      assert.equal(judgeLockHolder(body), "unjudgeable", `lock: ${label} is never pid-judged`);
    }
  }
});
