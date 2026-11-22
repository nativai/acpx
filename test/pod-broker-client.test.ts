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
import { startFakeBroker, wellFormedAgentRequest } from "./pod-kit/fake-broker.js";
import { rawHttp } from "./pod-raw-http.js";

// A6.0 / C4 — the broker client against X1's fake broker (`test/pod-kit/fake-broker.ts`), which follows the real
// `broker.py`: it judges every request as the real broker does, so the body here is a WELL-FORMED C4 body and its
// key is the one the real broker derives (sha256(sessionId)[:24]). A few rows need a misbehaving server the kit does
// not model (no headers at all, a malformed or failing `GET /v1/agents`, a DELETE answering 503 or an odd body):
// they use `rawHttp` and are listed as KIT GAPS in brick 557fb3e7's report.
const WELL = wellFormedAgentRequest("11111111-1111-4111-8111-111111111111");
const KEY = WELL.key;
const REQUEST = { ...WELL.body, contract: AGENT_BROKER_CONTRACT } as unknown as BrokerAgentRequest;
const READY = `ready ip=10.1.2.3 pod=ag-${KEY} uid=33333333-3333-4333-8333-333333333333 node=n1 placement=pool`;

test("C4: the wake bound is 20 s (spike g)", () => {
  assert.equal(WAKE_BOUND_MS, 20_000);
});

test("ensure: streamed steps then ready; the request is the C4 body on POST /v1/agents/<key>", async () => {
  const broker = await startFakeBroker({
    default: { steps: ["scheduling", "pulling", "pulling", "starting"], final: READY },
  });
  try {
    const steps: BrokerStep[] = [];
    const result = await ensureAgentPod(KEY, REQUEST, {
      origin: broker.url,
      onStep: (step) => steps.push(step),
    });
    assert.deepEqual(result, {
      kind: "ready",
      ip: "10.1.2.3",
      pod: `ag-${KEY}`,
      uid: "33333333-3333-4333-8333-333333333333",
      node: "n1",
      placement: "pool",
    });
    assert.deepEqual(
      steps,
      ["scheduling", "pulling", "starting"],
      "a repeated step is reported once",
    );
    assert.equal(broker.requests[0]?.method, "POST");
    assert.equal(broker.requests[0]?.path, `/v1/agents/${KEY}`);
    assert.deepEqual(JSON.parse(broker.requests[0]?.bodyText ?? ""), REQUEST);
    assert.deepEqual(broker.requests[0]?.problems, [], "the real broker would accept this body");
  } finally {
    await broker.close();
  }
});

test("ensure: each refusal reason of C4 maps with its live/cap figures", async () => {
  for (const reason of ["agent_cap", "quota", "home_full", "too_big"] as const) {
    const broker = await startFakeBroker({
      default: { steps: ["scheduling"], final: `refused reason=${reason} live=7 cap=9` },
    });
    try {
      assert.deepEqual(await ensureAgentPod(KEY, REQUEST, { origin: broker.url }), {
        kind: "refused",
        reason,
        live: 7,
        cap: 9,
      });
    } finally {
      await broker.close();
    }
  }
});

test("ensure: `error <reason>` is a named failure, not a refusal", async () => {
  const broker = await startFakeBroker({
    default: { final: "error unsupported_contract -- contract 2 is not served" },
  });
  try {
    assert.deepEqual(await ensureAgentPod(KEY, REQUEST, { origin: broker.url }), {
      kind: "error",
      reason: "unsupported_contract",
      detail: "contract 2 is not served",
    });
  } finally {
    await broker.close();
  }
});

test("ensure: stops reading at the wake bound and names the last step; the connection is closed (the Job continues)", async () => {
  const broker = await startFakeBroker({
    default: { steps: ["scheduling", "pulling"], hang: true },
  });
  try {
    const started = Date.now();
    const result = await ensureAgentPod(KEY, REQUEST, { origin: broker.url, wakeBoundMs: 300 });
    assert.deepEqual(result, { kind: "wake_bound", phase: "pulling" });
    assert.ok(Date.now() - started < 2_000, "did not wait past the bound");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      broker.requests[0]?.outcome,
      "client_closed_while_hung",
      "the caller left; the broker's Job is not ours to wait for",
    );
  } finally {
    await broker.close();
  }
});

test("ensure: a bound reached before any step names no phase", async () => {
  const broker = await startFakeBroker({ default: { hang: true } });
  try {
    assert.deepEqual(
      await ensureAgentPod(KEY, REQUEST, { origin: broker.url, wakeBoundMs: 1500 }),
      {
        kind: "wake_bound",
        phase: undefined,
      },
    );
  } finally {
    await broker.close();
  }
});

test("ensure: a broker that never answers, refuses the connection, or answers 5xx is `unavailable`", async () => {
  // A server that never sends response headers: a wedged or frozen real broker does (not by protocol); the kit's
  // `hang` sends the 200 first.
  const silent = await rawHttp(() => undefined);
  try {
    const result = await ensureAgentPod(KEY, REQUEST, { origin: silent.url, wakeBoundMs: 200 });
    assert.equal(result.kind, "unavailable");
  } finally {
    silent.close();
  }
  const down = await startFakeBroker({});
  const deadOrigin = down.url;
  await down.close();
  assert.equal((await ensureAgentPod(KEY, REQUEST, { origin: deadOrigin })).kind, "unavailable");
  const broken = await startFakeBroker({
    default: { respond: { status: 503, body: "upstream unavailable" } },
  });
  try {
    assert.equal((await ensureAgentPod(KEY, REQUEST, { origin: broken.url })).kind, "unavailable");
  } finally {
    await broken.close();
  }
});

test("ensure: an answer that ends without a final line is `unavailable`, never a guess", async () => {
  // The kit's `truncate`: the real broker's run() can raise past its catches after the 200 and some steps.
  const broker = await startFakeBroker({
    default: { steps: ["scheduling", "starting"], truncate: true },
  });
  try {
    assert.equal((await ensureAgentPod(KEY, REQUEST, { origin: broker.url })).kind, "unavailable");
    assert.equal(broker.requests[0]?.outcome, "truncated");
    assert.deepEqual(
      broker.requests[0]?.linesSent,
      ["scheduling", "starting"],
      "no final line was sent",
    );
  } finally {
    await broker.close();
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
    const broker = await startFakeBroker({ default: { final: line } });
    try {
      const result = await ensureAgentPod(KEY, REQUEST, { origin: broker.url });
      assert.equal(result.kind, "error", line);
    } finally {
      await broker.close();
    }
  }
});

test("ensure: unknown progress lines are ignored (C4 rule 2: new fields and steps are additive)", async () => {
  const broker = await startFakeBroker({
    default: { steps: ["warming-cache eta=3", "scheduling extra=1"], final: READY },
  });
  try {
    assert.equal((await ensureAgentPod(KEY, REQUEST, { origin: broker.url })).kind, "ready");
  } finally {
    await broker.close();
  }
});

test("ensure: a 4xx that names nothing is a named failure; a key that is not a key never connects", async () => {
  const broker = await startFakeBroker({ default: { respond: { status: 400 } } });
  try {
    assert.deepEqual(await ensureAgentPod(KEY, REQUEST, { origin: broker.url }), {
      kind: "error",
      reason: "http_400",
      detail: "the broker refused the request",
    });
    const before = broker.requests.length;
    const bad = await ensureAgentPod("../etc/passwd", REQUEST, { origin: broker.url });
    assert.equal(bad.kind, "error");
    assert.equal(broker.requests.length, before, "nothing was sent for a bad key");
  } finally {
    await broker.close();
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
  const broker = await startFakeBroker({
    status: {
      live: 3,
      cap: 100,
      reserve: 1,
      quota: { used: 3, hard: 100 },
      home: { live: 1, cap: 4 },
    },
  });
  try {
    // the kit serves `placement: {forced: null}` (A-49); an older broker's GET WITHOUT the field reads the same
    assert.deepEqual(await getAgents({ origin: broker.url }), {
      ok: true,
      agents: { ...good, placement: { forced: null } },
    });
    assert.equal(broker.requests[0]?.method, "GET");
    assert.equal(broker.requests[0]?.path, "/v1/agents");
  } finally {
    await broker.close();
  }
  // The real failure: `GET /v1/agents` answers 502 `{"error":"kube_api_error"}` when the kube API does.
  const failing = await startFakeBroker({ statusFails: true });
  try {
    assert.equal((await getAgents({ origin: failing.url })).ok, false);
    assert.equal(failing.requests[0]?.outcome, "status_failed");
  } finally {
    await failing.close();
  }
  // A 200 whose body is malformed is a shape NO real service produces (the broker builds the figures itself): kept
  // as a raw row for acpx's own strictness, with nothing in the kit to move it to.
  const malformed = await rawHttp((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...good, cap: "100" }));
  });
  try {
    assert.equal((await getAgents({ origin: malformed.url })).ok, false);
  } finally {
    malformed.close();
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
  // Nothing to delete (no pod of the key): the real broker answers a plain empty 200.
  const ok = await startFakeBroker({});
  try {
    assert.deepEqual(await deleteAgent(KEY, { uid: UID, origin: ok.url }), { kind: "deleted" });
    assert.equal(ok.requests[0]?.method, "DELETE");
    assert.equal(ok.requests[0]?.path, `/v1/agents/${KEY}`);
    assert.equal(ok.requests[0]?.query, `uid=${UID}`);
  } finally {
    await ok.close();
  }
  // A live pod whose uid is another: the real answer is `refused reason=uid_mismatch`, and nothing is deleted.
  const mismatch = await startFakeBroker({ default: { final: { ready: { uid: UID } } } });
  try {
    await ensureAgentPod(KEY, REQUEST, { origin: mismatch.url });
    const other = "44444444-4444-4444-8444-444444444444";
    assert.deepEqual(await deleteAgent(KEY, { uid: other, origin: mismatch.url }), {
      kind: "refused",
      reason: "uid_mismatch",
    });
    assert.deepEqual(await deleteAgent(KEY, { uid: UID, origin: mismatch.url }), {
      kind: "deleted",
    });
  } finally {
    await mismatch.close();
  }
});

test("DELETE: a 5xx, a body that is no answer, a dead broker and a missing uid are never `deleted`", async () => {
  const UID = "33333333-3333-4333-8333-333333333333";
  // The kit's DELETE failures are the real 504 / 502 bodies, on a pod that exists.
  for (const status of [504, 502]) {
    const broker = await startFakeBroker({
      default: { final: { ready: { uid: UID } } },
      delete: { status },
    });
    try {
      await ensureAgentPod(KEY, REQUEST, { origin: broker.url });
      assert.equal(
        (await deleteAgent(KEY, { uid: UID, origin: broker.url })).kind,
        "unavailable",
        String(status),
      );
    } finally {
      await broker.close();
    }
  }
  // A DELETE answering 503, or 200 with a body that is no C4 answer — neither exists on the real broker.
  for (const answer of [
    { status: 503, body: "" },
    { status: 200, body: "something odd" },
  ]) {
    const server = await rawHttp((_request, response) => {
      response.writeHead(answer.status, { "content-type": "text/plain" });
      response.end(answer.body);
    });
    try {
      assert.equal(
        (await deleteAgent(KEY, { uid: UID, origin: server.url })).kind,
        "unavailable",
        JSON.stringify(answer),
      );
    } finally {
      server.close();
    }
  }
  const dead = await startFakeBroker({});
  const origin = dead.url;
  await dead.close();
  assert.equal((await deleteAgent(KEY, { uid: UID, origin })).kind, "unavailable");
  // Negative: without a well-formed uid nothing is sent (the broker would delete whatever pod the key has).
  const broker = await startFakeBroker({});
  try {
    assert.equal((await deleteAgent(KEY, { uid: "", origin: broker.url })).kind, "unavailable");
    assert.equal(broker.requests.length, 0);
  } finally {
    await broker.close();
  }
});
