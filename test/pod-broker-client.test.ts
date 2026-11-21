import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_BROKER_CONTRACT,
  deleteAgent,
  ensureAgentPod,
  getAgents,
  resolveAgentBrokerOrigin,
  WAKE_BOUND_MS,
  type BrokerAgentRequest,
  type BrokerStep,
} from "../src/pod/broker-client.js";
import { startBroker } from "./pod-local-fake-broker.js";

// A6.0 / C4 — the broker client against a scripted local fake (until X1's test/pod-kit fake broker
// lands on agent-pods: then this file's `startBroker` is replaced by the kit's).

const KEY = "0123456789abcdef01234567";
const REQUEST: BrokerAgentRequest = {
  contract: AGENT_BROKER_CONTRACT,
  sessionId: "11111111-1111-4111-8111-111111111111",
  seat: "22222222-2222-4222-8222-222222222222",
  harness: "claude",
  placement: "auto",
  class: "interactive",
  releases: { acpx: "abc-1" },
};
const READY =
  "ready ip=10.1.2.3 pod=ag-0123456789abcdef01234567 uid=33333333-3333-4333-8333-333333333333 node=n1 placement=pool";

test("C4: the wake bound is 20 s (spike g)", () => {
  assert.equal(WAKE_BOUND_MS, 20_000);
});

test("ensure: streamed steps then ready; the request is the C4 body on POST /v1/agents/<key>", async () => {
  const broker = await startBroker({
    lines: ["scheduling", "pulling", "pulling", "starting", READY],
  });
  try {
    const steps: BrokerStep[] = [];
    const result = await ensureAgentPod(KEY, REQUEST, {
      origin: broker.origin,
      onStep: (step) => steps.push(step),
    });
    assert.deepEqual(result, {
      kind: "ready",
      ip: "10.1.2.3",
      pod: "ag-0123456789abcdef01234567",
      uid: "33333333-3333-4333-8333-333333333333",
      node: "n1",
      placement: "pool",
    });
    assert.deepEqual(
      steps,
      ["scheduling", "pulling", "starting"],
      "a repeated step is reported once",
    );
    assert.equal(broker.seen[0]?.method, "POST");
    assert.equal(broker.seen[0]?.url, `/v1/agents/${KEY}`);
    assert.deepEqual(JSON.parse(broker.seen[0]?.body ?? ""), REQUEST);
  } finally {
    broker.close();
  }
});

test("ensure: each refusal reason of C4 maps with its live/cap figures", async () => {
  for (const reason of ["agent_cap", "quota", "home_full", "too_big"] as const) {
    const broker = await startBroker({
      lines: ["scheduling", `refused reason=${reason} live=7 cap=9`],
    });
    try {
      assert.deepEqual(await ensureAgentPod(KEY, REQUEST, { origin: broker.origin }), {
        kind: "refused",
        reason,
        live: 7,
        cap: 9,
      });
    } finally {
      broker.close();
    }
  }
});

test("ensure: `error <reason>` is a named failure, not a refusal", async () => {
  const broker = await startBroker({
    lines: ["error unsupported_contract -- contract 2 is not served"],
  });
  try {
    assert.deepEqual(await ensureAgentPod(KEY, REQUEST, { origin: broker.origin }), {
      kind: "error",
      reason: "unsupported_contract",
      detail: "contract 2 is not served",
    });
  } finally {
    broker.close();
  }
});

test("ensure: stops reading at the wake bound and names the last step; the connection is closed (the Job continues)", async () => {
  const broker = await startBroker({ lines: ["scheduling", "pulling"], stall: true });
  try {
    const started = Date.now();
    const result = await ensureAgentPod(KEY, REQUEST, { origin: broker.origin, wakeBoundMs: 300 });
    assert.deepEqual(result, { kind: "wake_bound", phase: "pulling" });
    assert.ok(Date.now() - started < 2_000, "did not wait past the bound");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      broker.seen[0]?.closedEarly,
      true,
      "the caller left; the broker's Job is not ours to wait for",
    );
  } finally {
    broker.close();
  }
});

test("ensure: a bound reached before any step names no phase", async () => {
  const broker = await startBroker({ lines: [], stall: true });
  try {
    assert.deepEqual(
      await ensureAgentPod(KEY, REQUEST, { origin: broker.origin, wakeBoundMs: 200 }),
      {
        kind: "wake_bound",
        phase: undefined,
      },
    );
  } finally {
    broker.close();
  }
});

test("ensure: a broker that never answers, refuses the connection, or answers 5xx is `unavailable`", async () => {
  const silent = await startBroker({ noHeaders: true });
  try {
    const result = await ensureAgentPod(KEY, REQUEST, { origin: silent.origin, wakeBoundMs: 200 });
    assert.equal(result.kind, "unavailable");
  } finally {
    silent.close();
  }
  const down = await startBroker({});
  const deadOrigin = down.origin;
  down.close();
  assert.equal((await ensureAgentPod(KEY, REQUEST, { origin: deadOrigin })).kind, "unavailable");
  const broken = await startBroker({ status: 503, lines: ["upstream unavailable"] });
  try {
    assert.equal(
      (await ensureAgentPod(KEY, REQUEST, { origin: broken.origin })).kind,
      "unavailable",
    );
  } finally {
    broken.close();
  }
});

test("ensure: an answer that ends without a final line is `unavailable`, never a guess", async () => {
  const broker = await startBroker({ lines: ["scheduling", "starting"] });
  try {
    assert.equal(
      (await ensureAgentPod(KEY, REQUEST, { origin: broker.origin })).kind,
      "unavailable",
    );
  } finally {
    broker.close();
  }
});

test("ensure: a ready line missing what the call needs is an error, not a pod", async () => {
  const lines = [
    "ready ip=10.1.2.3 pod=ag-x node=n1 placement=pool", // no uid
    "ready ip=10.1.2.3 pod=ag-x uid=33333333-3333-4333-8333-333333333333 node=n1", // no placement
    "ready ip=not-an-ip pod=ag-x uid=33333333-3333-4333-8333-333333333333 node=n1 placement=home",
    "refused reason=agent_cap live=7", // no cap
    "refused reason=because live=1 cap=2", // unknown reason
  ];
  for (const line of lines) {
    const broker = await startBroker({ lines: [line] });
    try {
      const result = await ensureAgentPod(KEY, REQUEST, { origin: broker.origin });
      assert.equal(result.kind, "error", line);
    } finally {
      broker.close();
    }
  }
});

test("ensure: unknown progress lines are ignored (C4 rule 2: new fields and steps are additive)", async () => {
  const broker = await startBroker({ lines: ["warming-cache eta=3", "scheduling extra=1", READY] });
  try {
    assert.equal((await ensureAgentPod(KEY, REQUEST, { origin: broker.origin })).kind, "ready");
  } finally {
    broker.close();
  }
});

test("ensure: a 4xx that names nothing is a named failure; a key that is not a key never connects", async () => {
  const broker = await startBroker({ status: 400, lines: [] });
  try {
    assert.deepEqual(await ensureAgentPod(KEY, REQUEST, { origin: broker.origin }), {
      kind: "error",
      reason: "http_400",
      detail: "the broker refused the request",
    });
    const before = broker.seen.length;
    const bad = await ensureAgentPod("../etc/passwd", REQUEST, { origin: broker.origin });
    assert.equal(bad.kind, "error");
    assert.equal(broker.seen.length, before, "nothing was sent for a bad key");
  } finally {
    broker.close();
  }
});

test("GET /v1/agents: the C4 snapshot; a malformed or failing answer is `ok:false`", async () => {
  const good = {
    live: 3,
    cap: 100,
    reserve: 1,
    quota: { used: 3, hard: 100 },
    home: { live: 1, cap: 4 },
    pool: { state: "ready" },
  };
  const broker = await startBroker({ json: good });
  try {
    assert.deepEqual(await getAgents({ origin: broker.origin }), { ok: true, agents: good });
    assert.equal(broker.seen[0]?.method, "GET");
    assert.equal(broker.seen[0]?.url, "/v1/agents");
  } finally {
    broker.close();
  }
  const malformed = await startBroker({ json: { ...good, cap: "100" } });
  try {
    assert.equal((await getAgents({ origin: malformed.origin })).ok, false);
  } finally {
    malformed.close();
  }
  const failing = await startBroker({ status: 500, json: {} });
  try {
    assert.equal((await getAgents({ origin: failing.origin })).ok, false);
  } finally {
    failing.close();
  }
});

test("origin: built from the namespace; NV_AGENT_BROKER_URL steers only under NODE_TEST_CONTEXT", () => {
  const sources = { resolvConf: "search dev-devbox.svc.cluster.local svc.cluster.local\n" };
  assert.equal(
    resolveAgentBrokerOrigin({}, sources),
    "http://workbench-broker.dev-devbox.svc.cluster.local:8081",
  );
  // Negative: in production nothing in the environment can point acpx at another broker.
  assert.equal(
    resolveAgentBrokerOrigin({ NV_AGENT_BROKER_URL: "http://evil.example:1" }, sources),
    "http://workbench-broker.dev-devbox.svc.cluster.local:8081",
  );
  assert.equal(
    resolveAgentBrokerOrigin(
      { NODE_TEST_CONTEXT: "child", NV_AGENT_BROKER_URL: "http://127.0.0.1:9/" },
      sources,
    ),
    "http://127.0.0.1:9",
  );
  assert.equal(resolveAgentBrokerOrigin({}, {}), undefined);
});

test("DELETE /v1/agents/<key>?uid=<uid>: 200 empty = deleted; 200 `refused reason=uid_mismatch` = refused; the uid is always sent", async () => {
  const UID = "33333333-3333-4333-8333-333333333333";
  const ok = await startBroker({ del: { body: "" } });
  try {
    assert.deepEqual(await deleteAgent(KEY, { uid: UID, origin: ok.origin }), { kind: "deleted" });
    assert.equal(ok.seen[0]?.method, "DELETE");
    assert.equal(ok.seen[0]?.url, `/v1/agents/${KEY}?uid=${UID}`);
  } finally {
    ok.close();
  }
  const mismatch = await startBroker({ del: { body: "refused reason=uid_mismatch\n" } });
  try {
    assert.deepEqual(await deleteAgent(KEY, { uid: UID, origin: mismatch.origin }), {
      kind: "refused",
      reason: "uid_mismatch",
    });
  } finally {
    mismatch.close();
  }
});

test("DELETE: a 5xx, a body that is no answer, a dead broker and a missing uid are never `deleted`", async () => {
  const UID = "33333333-3333-4333-8333-333333333333";
  for (const del of [{ status: 503, body: "" }, { body: "something odd" }]) {
    const broker = await startBroker({ del });
    try {
      assert.equal(
        (await deleteAgent(KEY, { uid: UID, origin: broker.origin })).kind,
        "unavailable",
      );
    } finally {
      broker.close();
    }
  }
  const dead = await startBroker({});
  const origin = dead.origin;
  dead.close();
  assert.equal((await deleteAgent(KEY, { uid: UID, origin })).kind, "unavailable");
  // Negative: without a well-formed uid nothing is sent (the broker would delete whatever pod the key has).
  const broker = await startBroker({ del: { body: "" } });
  try {
    assert.equal((await deleteAgent(KEY, { uid: "", origin: broker.origin })).kind, "unavailable");
    assert.equal(broker.seen.length, 0);
  } finally {
    broker.close();
  }
});
