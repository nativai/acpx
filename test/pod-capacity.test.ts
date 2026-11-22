import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { waitingLineRefusal, waitingLineRefusalError } from "../src/pod/create-plan.js";
import { podCapacitySnapshot, podRoom, WAITING_LINE_FACTOR } from "../src/pod/pod-capacity.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { type BrokerStatus, startFakeBroker } from "./pod-kit/fake-broker.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import {
  admissionDir,
  createdRecordIds,
  makeBox,
  refusedUrl,
  runCli,
  type Fixture,
} from "./umq-rig.js";

// Block A9 (brick fcc2ac37) — C7.3: `capacity`, `capacity --need`, `capacity admit-wake` answer from the
// broker's `GET /v1/agents`, and C7.2: the waiting line refuses a create. The numbers below are the
// broker's — scripted per row into the kit's fake broker; no figure is assumed by the product.

const CLAUDE = "node /opt/claude-agent-acp/release-2/dist/index.js";
const CODEX = "node /opt/codex-acp/dist/index.js";
const BROKER = (status: BrokerStatus) => startFakeBroker({ status });

// ───────────────────────── podRoom: the arithmetic, one limit at a time ─────────────────────────

const agents = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over });
function base() {
  return {
    live: 3,
    cap: 10,
    reserve: 1,
    quota: { used: 3, hard: 10 },
    home: { live: 0, cap: 2 },
    pool: { state: "ready" },
  };
}
const room = (a: ReturnType<typeof base>, extra: Partial<Parameters<typeof podRoom>[1]> = {}) =>
  podRoom(a, { harness: "claude", admissionClass: "spawn", waitingCount: 0, ...extra });

test("podRoom: the cap less the people's reserve, less what lives", () => {
  assert.equal(room(agents()).slots, 6); // 10 − 1 − 3
  const full = room(agents({ live: 9 }));
  assert.deepEqual([full.slots, full.why], [0, "cap"]);
  // NEGATIVE of the same input: an interactive request keeps the reserve slot (C4: only other classes lose it)
  assert.equal(room(agents({ live: 9 }), { admissionClass: "interactive" }).slots, 1);
});

test("podRoom: the quota binds when it is the smaller limit (a box without its quota patch has hard 0)", () => {
  const out = room(agents({ quota: { used: 0, hard: 0 } }));
  assert.deepEqual([out.slots, out.why], [0, "quota"]);
  assert.equal(room(agents({ quota: { used: 8, hard: 10 } })).slots, 2);
  // the same input with the quota not binding is not refused for it
  assert.equal(room(agents({ quota: { used: 0, hard: 10 } })).why, undefined);
});

test("podRoom: a home-only harness is bound by the home cap; a pool harness is not", () => {
  const homeFull = agents({ home: { live: 2, cap: 2 } });
  const codex = room(homeFull, { harness: "codex" });
  assert.deepEqual([codex.slots, codex.why], [0, "home_full"]);
  assert.equal(room(homeFull, { harness: "claude" }).slots, 6, "claude does not use the home cap");
  // home cap 1 (the floor, A-37): one home-only session fits, the next does not
  assert.equal(room(agents({ home: { live: 0, cap: 1 } }), { harness: "codex" }).slots, 1);
  assert.equal(room(agents({ home: { live: 1, cap: 1 } }), { harness: "codex" }).slots, 0);
});

test("podRoom: spawn is net of what waits first, automation is gross, and the why is the cap", () => {
  const spawn = room(agents(), { waitingCount: 6 });
  assert.deepEqual([spawn.slots, spawn.gross, spawn.why], [0, 6, "cap"]);
  const automation = room(agents(), { admissionClass: "automation", waitingCount: 6 });
  assert.deepEqual([automation.slots, automation.why], [6, undefined]);
  assert.equal(room(agents(), { waitingCount: 5 }).slots, 1);
});

test("podCapacitySnapshot: the broker's figures, per harness, and no memory basis", () => {
  const snapshot = podCapacitySnapshot({
    agents: agents({ home: { live: 2, cap: 2 } }),
    box: "devbox",
    agent: "claude",
    admissionClass: "spawn",
  });
  assert.equal(snapshot.basis, "pod");
  assert.deepEqual(snapshot.freeSlots, { claude: 6, codex: 0, pi: 0 });
  assert.equal(snapshot.freeSlotsInteractive.claude, 7);
  assert.equal(snapshot.bindingGuard.codex, "home_full");
  assert.equal("budgetBytes" in snapshot, false, "nothing of the control pod's memory");
  assert.equal(snapshot.verdict, "room");
});

// ───────────────────────── the waiting line (a seam with injected broker) ─────────────────────────

const seamEnv = { NODE_TEST_CONTEXT: "child", NV_AGENT_BROKER_URL: "http://broker.test" };
const answer = (over: Record<string, unknown> = {}): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ ...base(), ...over }), { status: 200 })) as typeof fetch;
const waitingOf = (count: number) => ({
  count,
  items: Array.from({ length: count }, (_, i) => ({
    key: `delivery:${i}`,
    kind: "delivery",
    ref: String(i),
    label: "",
    harness: "claude",
    since: "2026-11-22T10:00:00Z",
  })),
});

test("waiting line: refuses only ABOVE 2 × the broker's cap; the boundary itself is admitted", async () => {
  assert.equal(WAITING_LINE_FACTOR, 2);
  const at = await waitingLineRefusal({
    env: seamEnv,
    fetchImpl: answer(),
    waiting: waitingOf(20),
  });
  assert.equal(at, undefined, "20 waiting on cap 10 is the line, not over it");
  const over = await waitingLineRefusal({
    env: seamEnv,
    fetchImpl: answer(),
    waiting: waitingOf(21),
  });
  assert.deepEqual([over?.live, over?.cap], [3, 10]);
  const token = waitingLineRefusalError(over ?? { live: 0, cap: 0, box: "" }).message.split(
    "\n",
  )[0];
  assert.match(
    token,
    /^acpx: REFUSED reason=agent_cap nothing_started=true protocol=1 retry_after_s=60 live=3 cap=10 box=\S+ why=waiting-line$/u,
  );
});

test("waiting line: the cap is the broker's — the same queue is over a small cap and under a large one", async () => {
  const small = await waitingLineRefusal({
    env: seamEnv,
    fetchImpl: answer({ cap: 2 }),
    waiting: waitingOf(5),
  });
  assert.equal(small?.cap, 2);
  const large = await waitingLineRefusal({
    env: seamEnv,
    fetchImpl: answer({ cap: 100 }),
    waiting: waitingOf(5),
  });
  assert.equal(large, undefined);
  // a box without its patch (cap 0): any waiting item is over the line
  const zero = await waitingLineRefusal({
    env: seamEnv,
    fetchImpl: answer({ cap: 0 }),
    waiting: waitingOf(1),
  });
  assert.equal(zero?.cap, 0);
});

test("waiting line: an empty queue never asks the broker; a broker that does not answer never refuses a create", async () => {
  let asked = 0;
  const counting: typeof fetch = (async () => {
    asked += 1;
    return new Response(JSON.stringify(base()));
  }) as typeof fetch;
  assert.equal(
    await waitingLineRefusal({ env: seamEnv, fetchImpl: counting, waiting: waitingOf(0) }),
    undefined,
  );
  assert.equal(asked, 0);
  const down: typeof fetch = (async () => {
    throw new Error("connection refused");
  }) as typeof fetch;
  assert.equal(
    await waitingLineRefusal({ env: seamEnv, fetchImpl: down, waiting: waitingOf(500) }),
    undefined,
  );
  const malformed: typeof fetch = (async () => new Response("{}")) as typeof fetch;
  assert.equal(
    await waitingLineRefusal({ env: seamEnv, fetchImpl: malformed, waiting: waitingOf(500) }),
    undefined,
  );
});

// ───────────────────────── the REAL CLI in pod mode against the kit's fake broker ─────────────────────────

function podEnv(f: Fixture, brokerUrl: string): NodeJS.ProcessEnv {
  const sa = path.join(f.root, "serviceaccount");
  fs.mkdirSync(sa, { recursive: true });
  fs.writeFileSync(path.join(sa, "namespace"), "dev-devbox\n");
  return {
    ...f.env,
    NODE_TEST_CONTEXT: "child",
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: f.root,
    ACPX_POD_SA_DIR: sa,
    NV_POD_NAME: "dev-server-0",
    NV_POD_UID: "00000000-0000-0000-0000-000000000001",
    NV_NODE_NAME: "node-a",
    NV_AGENT_BROKER_URL: brokerUrl,
  };
}

function writeWaiting(f: Fixture, count: number): void {
  const dir = path.join(admissionDir(f), "waiting");
  fs.mkdirSync(dir, { recursive: true });
  const since = new Date().toISOString();
  const items = waitingOf(count).items.map((item) => Object.assign({}, item, { since }));
  fs.writeFileSync(
    path.join(dir, "atrium.json"),
    JSON.stringify({ schema: 1, writer: "atrium-a9", writtenAt: new Date().toISOString(), items }),
  );
}

function writeRecord(f: Fixture, id: string, agentCommand: string): void {
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand,
    cwd: f.root,
  });
  fs.writeFileSync(
    path.join(f.root, ".acpx", "sessions", `${id}.json`),
    `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
  );
}

type Json = Record<string, unknown>;
const lastJson = (stdout: string): Json =>
  JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Json;

async function capacity(f: Fixture, url: string, args: string[]) {
  return await runCli(["--format", "json", "capacity", ...args], podEnv(f, url), f.root);
}

test("pod mode: `capacity --need 1` answers from the broker — a locally FULL box is not full (A9)", async () => {
  const f = makeBox({ requestMib: 2048 }); // the control pod's memory would refuse
  const control = await runCli(["--format", "json", "capacity", "--need", "1"], f.env, f.root);
  assert.equal(control.code, 75, "the control: without pod mode this box is full");
  const broker = await BROKER({ live: 3, cap: 10 });
  try {
    const run = await capacity(f, broker.url, ["--need", "1"]);
    assert.equal(run.code, 0, run.stderr);
    const json = lastJson(run.stdout);
    assert.equal(json.basis, "pod");
    assert.equal(json.needMet, true);
    assert.equal((json.freeSlots as Json).claude, 6);
    assert.equal("budgetBytes" in json, false);
    assert.ok(
      broker.requests.some((r) => r.method === "GET" && r.path === "/v1/agents"),
      "the answer came from GET /v1/agents",
    );
  } finally {
    await broker.close();
  }
});

test("pod mode NEGATIVE: each broker limit refuses `--need 1` with exit 75 and names what binds", async () => {
  const f = makeBox({ requestMib: 4000 }); // locally roomy: only the broker can refuse
  const cases: Array<{ name: string; status: BrokerStatus; args: string[]; binds: string }> = [
    { name: "cap less reserve", status: { live: 9, cap: 10 }, args: [], binds: "cap" },
    {
      name: "quota",
      status: { live: 0, cap: 10, quota: { used: 0, hard: 0 } },
      args: [],
      binds: "quota",
    },
    {
      name: "home cap for a home-only harness",
      status: { live: 0, cap: 10, home: { live: 0, cap: 0 } },
      args: ["--agent", "codex"],
      binds: "home_full",
    },
  ];
  for (const c of cases) {
    const broker = await BROKER(c.status);
    try {
      const run = await capacity(f, broker.url, ["--need", "1", ...c.args]);
      assert.equal(run.code, 75, `${c.name}: ${run.stderr}`);
      const json = lastJson(run.stdout);
      assert.equal(json.needMet, false, c.name);
      assert.match(
        String(json.needMetReason),
        new RegExp(
          c.binds === "cap"
            ? "cap is reached"
            : c.binds === "quota"
              ? "quota is used up"
              : "home machine",
        ),
        c.name,
      );
      assert.equal((json.bindingGuard as Json)[c.args[1] ?? "claude"], c.binds, c.name);
    } finally {
      await broker.close();
    }
  }
});

test("pod mode: the home cap binds codex, never claude, on the SAME broker answer", async () => {
  const f = makeBox({});
  const broker = await BROKER({ live: 0, cap: 10, home: { live: 0, cap: 0 } });
  try {
    assert.equal((await capacity(f, broker.url, ["--need", "1", "--agent", "claude"])).code, 0);
    assert.equal((await capacity(f, broker.url, ["--need", "1", "--agent", "codex"])).code, 75);
  } finally {
    await broker.close();
  }
});

test("pod mode: items waiting for room come off a `spawn` answer and not off `--class automation`", async () => {
  const f = makeBox({});
  writeWaiting(f, 6);
  const broker = await BROKER({ live: 3, cap: 10 }); // 6 slots, 6 waiting
  try {
    const spawn = await capacity(f, broker.url, ["--need", "1"]);
    assert.equal(spawn.code, 75, "the six waiting items start first");
    const automation = await capacity(f, broker.url, ["--need", "1", "--class", "automation"]);
    assert.equal(automation.code, 0, automation.stderr);
    assert.equal((lastJson(automation.stdout).waiting as Json).count as number, 6);
  } finally {
    await broker.close();
  }
});

test("pod mode: a broker that does not answer is `admission_busy` — `--need` holds (exit 75), it never passes", async () => {
  const f = makeBox({});
  const url = await refusedUrl();
  const need = await capacity(f, url, ["--need", "1"]);
  assert.equal(need.code, 75, need.stderr);
  assert.match(String(lastJson(need.stdout).needMetReason), /^admission_busy:/u);
  // A plain `capacity` still ANSWERS — with its features: atrium reads them from every answer (A-21).
  const plain = await capacity(f, url, []);
  assert.equal(plain.code, 0, plain.stderr);
  const json = lastJson(plain.stdout);
  assert.deepEqual((json.pod as Json).available, false);
  assert.ok((json.features as string[]).includes("fork-cut"));
  assert.match((json.warnings as string[])[0], /broker did not answer/u);
});

test("pod mode: text output names the broker's figures and what binds", async () => {
  const f = makeBox({});
  const broker = await BROKER({ live: 9, cap: 10 });
  try {
    const run = await runCli(["capacity", "--need", "1"], podEnv(f, broker.url), f.root);
    assert.equal(run.code, 75);
    assert.match(run.stdout, /pod plane/u);
    assert.match(
      run.stdout,
      /live 9 of cap 10; 1 kept for people; quota 9\/10; home 0\/0; bound by cap/u,
    );
    assert.match(run.stdout, /need 1 claude slot: NOT MET \(exit 75\)/u);
  } finally {
    await broker.close();
  }
});

// ── admit-wake ──────────────────────────────────────────────────────────────────────────────────

const wake = async (f: Fixture, url: string, id: string) =>
  await runCli(
    ["--format", "json", "capacity", "admit-wake", "--session-id", id, "--class", "delivery"],
    podEnv(f, url),
    f.root,
  );

test("pod mode admit-wake: room ⇒ exit 0, nothing reserved in the ledger, the decision logged", async () => {
  const f = makeBox({ requestMib: 2048 }); // locally full — irrelevant in pod mode
  writeRecord(f, "wake-1", CLAUDE);
  const broker = await BROKER({ live: 3, cap: 10 });
  try {
    const run = await wake(f, broker.url, "wake-1");
    assert.equal(run.code, 0, run.stderr);
    const json = lastJson(run.stdout);
    assert.deepEqual([json.decision, json.why], ["not-gated", "pod-room"]);
    assert.equal(
      fs.existsSync(path.join(admissionDir(f), "pending.json")),
      false,
      "no reservation",
    );
    const logs = fs.readdirSync(path.join(admissionDir(f), "log"));
    assert.match(
      fs.readFileSync(path.join(admissionDir(f), "log", logs[0]), "utf8"),
      /"why":"pod-room"/u,
    );
  } finally {
    await broker.close();
  }
});

test("pod mode admit-wake NEGATIVE: no room ⇒ exit 75 with C7.2's agent_cap line, `wake=<id>`, in the broker's numbers", async () => {
  const f = makeBox({ requestMib: 4000 });
  writeRecord(f, "wake-2", CLAUDE);
  writeRecord(f, "wake-3", CODEX);
  const scenarios: Array<{
    id: string;
    status: BrokerStatus;
    why: string;
    live: number;
    cap: number;
  }> = [
    { id: "wake-2", status: { live: 9, cap: 10 }, why: "cap", live: 9, cap: 10 },
    {
      id: "wake-2",
      status: { live: 2, cap: 10, quota: { used: 2, hard: 2 } },
      why: "quota",
      live: 2,
      cap: 10,
    },
    {
      id: "wake-3",
      status: { live: 0, cap: 10, home: { live: 0, cap: 0 } },
      why: "home_full",
      live: 0,
      cap: 10,
    },
  ];
  for (const s of scenarios) {
    const broker = await BROKER(s.status);
    try {
      const run = await wake(f, broker.url, s.id);
      assert.equal(run.code, 75, run.stderr);
      const token = run.stderr.split("\n")[0];
      assert.match(
        token,
        new RegExp(
          `^acpx: REFUSED reason=agent_cap nothing_started=true protocol=1 retry_after_s=60 live=${s.live} cap=${s.cap} box=\\S+ why=${s.why} wake=${s.id}$`,
          "u",
        ),
      );
      const refusal = lastJson(run.stdout).refusal as Json;
      assert.equal(refusal.reason, "agent_cap");
      assert.equal(String(refusal.message).startsWith(token), true);
      assert.equal(fs.existsSync(path.join(admissionDir(f), "pending.json")), false);
    } finally {
      await broker.close();
    }
  }
});

test("pod mode admit-wake NEGATIVE: a broker that does not answer refuses `admission_busy`, never admits", async () => {
  const f = makeBox({});
  writeRecord(f, "wake-4", CLAUDE);
  const run = await wake(f, await refusedUrl(), "wake-4");
  assert.equal(run.code, 75, run.stderr);
  assert.match(run.stderr, /^acpx: REFUSED reason=admission_busy /mu);
  assert.equal((lastJson(run.stdout).refusal as Json).reason, "admission_busy");
});

// ── the waiting line at create ──────────────────────────────────────────────────────────────────

const newSession = async (f: Fixture, url: string) =>
  await runCli(
    [
      "--agent",
      f.agent,
      "--cwd",
      path.join(f.root, "work"),
      "--approve-all",
      "--format",
      "json",
      "sessions",
      "new",
    ],
    podEnv(f, url),
    f.root,
  );

test("pod mode create: over 2 × the cap waiting ⇒ exit 75 `why=waiting-line`, nothing created; AT the line it is created", async () => {
  const f = makeBox({ requestMib: 2048 });
  const broker = await BROKER({ live: 3, cap: 10 });
  try {
    writeWaiting(f, 21);
    const refused = await newSession(f, broker.url);
    assert.equal(refused.code, 75, refused.stderr);
    assert.match(
      refused.stderr.split("\n")[0],
      /^acpx: REFUSED reason=agent_cap nothing_started=true protocol=1 retry_after_s=60 live=3 cap=10 box=\S+ why=waiting-line$/u,
    );
    assert.deepEqual(createdRecordIds(f), [], "nothing was created");

    writeWaiting(f, 20);
    const admitted = await newSession(f, broker.url);
    assert.equal(admitted.code, 0, admitted.stderr);
    assert.equal(createdRecordIds(f).length, 1, "the create at the line writes its record");
  } finally {
    await broker.close();
  }
});

test("pod mode create: a broker that does not answer never refuses a create (the line fails open)", async () => {
  const f = makeBox({ requestMib: 2048 });
  writeWaiting(f, 500);
  const run = await newSession(f, await refusedUrl());
  assert.equal(run.code, 0, run.stderr);
  assert.equal(createdRecordIds(f).length, 1);
});
