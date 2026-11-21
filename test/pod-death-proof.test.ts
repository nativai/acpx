import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEATH_PROOF_TIMEOUT_MS, apiConfig, apiGet, proveDeath } from "../src/pod/death-proof.js";
import { KIT_NAMESPACE, makeServiceAccountDir } from "./pod-kit/two-pods.js";
import { startFakeApi, type FakeApi } from "./pod-lock-fake-api.js";

// C3.3 — the death proof, one row per line of its table (brick 8d85cb47; TEST-PLAN NG-K7.3).
// The requests asserted here are the published ones: reports/DEATH-PROOF-QUERIES.md.

const HOLDER = { name: "ag-holder", uid: "11111111-1111-4111-8111-111111111111", node: "node-a" };
const POD_PATH = `GET /api/v1/namespaces/${KIT_NAMESPACE}/pods/ag-holder`;
const NODE_PATH = "GET /api/v1/nodes/node-a";

let api: FakeApi;
let saDir: string;
let env: NodeJS.ProcessEnv;

test.before(async () => {
  saDir = makeServiceAccountDir(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-proof-")));
  api = await startFakeApi(KIT_NAMESPACE);
  env = { NODE_TEST_CONTEXT: "child-v8", ACPX_POD_API_URL: api.url, ACPX_POD_SA_DIR: saDir };
});
test.after(async () => {
  await api.close();
});
test.beforeEach(() => {
  api.state.pods.clear();
  api.state.nodes.clear();
  api.state.failure = undefined;
  api.state.bare404 = undefined;
  api.state.requests.length = 0;
});

test("exists: a pod with that uid, not terminal — one request, the node is not asked", async () => {
  api.state.pods.set("ag-holder", { uid: HOLDER.uid, phase: "Running" });
  assert.equal(await proveDeath(HOLDER, { env }), "exists");
  assert.deepEqual(api.state.requests, [POD_PATH]);
});

for (const phase of ["Succeeded", "Failed"]) {
  test(`gone: the pod with that uid is terminal (${phase}) — even while its node is NotReady`, async () => {
    api.state.pods.set("ag-holder", { uid: HOLDER.uid, phase });
    api.state.nodes.set("node-a", "False");
    assert.equal(await proveDeath(HOLDER, { env }), "gone");
    assert.deepEqual(api.state.requests, [POD_PATH]);
  });
}

test("gone: no pod of that name, its node Ready", async () => {
  api.state.nodes.set("node-a", "True");
  assert.equal(await proveDeath(HOLDER, { env }), "gone");
  assert.deepEqual(api.state.requests, [POD_PATH, NODE_PATH]);
});

test("gone: no pod of that name, its node no longer exists", async () => {
  assert.equal(await proveDeath(HOLDER, { env }), "gone");
  assert.deepEqual(api.state.requests, [POD_PATH, NODE_PATH]);
});

test("gone: the pod of that name is ANOTHER incarnation (other uid), the holder's node Ready", async () => {
  api.state.pods.set("ag-holder", {
    uid: "22222222-2222-4222-8222-222222222222",
    phase: "Running",
  });
  api.state.nodes.set("node-a", "True");
  assert.equal(await proveDeath(HOLDER, { env }), "gone");
});

for (const ready of ["False", "Unknown"]) {
  test(`unknown (negative): no such pod but its node is not Ready (Ready=${ready}) — never gone`, async () => {
    api.state.nodes.set("node-a", ready);
    assert.equal(await proveDeath(HOLDER, { env }), "unknown");
  });
}

test("unknown (negative): another incarnation by name, but the holder's node NotReady", async () => {
  api.state.pods.set("ag-holder", {
    uid: "22222222-2222-4222-8222-222222222222",
    phase: "Running",
  });
  api.state.nodes.set("node-a", "False");
  assert.equal(await proveDeath(HOLDER, { env }), "unknown");
});

test("unknown (negative): no such pod and the body names no node — the node clause cannot be met", async () => {
  api.state.nodes.set("node-a", "True");
  assert.equal(await proveDeath({ name: HOLDER.name, uid: HOLDER.uid }, { env }), "unknown");
  assert.deepEqual(api.state.requests, [POD_PATH]);
});

test("unknown (negative): the API server answers 500", async () => {
  api.state.failure = "500";
  assert.equal(await proveDeath(HOLDER, { env }), "unknown");
});

test("unknown (negative): a wrong token (401) is no answer, not an absence", async () => {
  const otherSa = makeServiceAccountDir(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-proof-")));
  fs.writeFileSync(path.join(otherSa, "token"), "wrong\n");
  assert.equal(await proveDeath(HOLDER, { env: { ...env, ACPX_POD_SA_DIR: otherSa } }), "unknown");
});

test("unknown (negative): the API server does not answer — bounded by the caller's lower deadline", async () => {
  api.state.failure = "stall";
  const started = Date.now();
  assert.equal(await proveDeath(HOLDER, { env, timeoutMs: 300 }), "unknown");
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});

test("the deadline cannot be raised past DEATH_PROOF_TIMEOUT_MS (3 s)", async () => {
  api.state.failure = "stall";
  const started = Date.now();
  assert.equal(await proveDeath(HOLDER, { env, timeoutMs: 60_000 }), "unknown");
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed >= DEATH_PROOF_TIMEOUT_MS - 100 && elapsed < DEATH_PROOF_TIMEOUT_MS + 1_500,
    `took ${elapsed} ms`,
  );
});

test("unknown (negative): no API configured — no request is made", async () => {
  assert.equal(
    await proveDeath(HOLDER, {
      env: { NODE_TEST_CONTEXT: "x", ACPX_POD_SA_DIR: "/nonexistent/sa" },
    }),
    "unknown",
  );
  assert.deepEqual(api.state.requests, []);
});

test("the test seam is dead outside NODE_TEST_CONTEXT: ACPX_POD_API_URL / ACPX_POD_SA_DIR are ignored", async () => {
  api.state.nodes.set("node-a", "True");
  const { NODE_TEST_CONTEXT: _dropped, ...production } = env;
  // No KUBERNETES_SERVICE_* and the real SA dir is ignored for the seam ⇒ no answer, no request.
  delete production.KUBERNETES_SERVICE_HOST;
  assert.equal(await proveDeath(HOLDER, { env: production }), "unknown");
  assert.deepEqual(api.state.requests, [], "the fake API was never reached");
});

test("the namespace defaults to the reader's own (service-account file) and is URL-encoded in the path", async () => {
  api.state.pods.set("ag-holder", { uid: HOLDER.uid, phase: "Running" });
  assert.equal(await proveDeath(HOLDER, { env }), "exists");
  api.state.nodes.set("node-a", "False");
  assert.equal(await proveDeath({ ...HOLDER, namespace: "else where" }, { env }), "unknown");
  assert.deepEqual(api.state.requests, [
    POD_PATH,
    "GET /api/v1/namespaces/else%20where/pods/ag-holder",
    NODE_PATH,
  ]);
});

test("unknown (negative): a ref without a name proves nothing — no request (a JS caller can pass anything)", async () => {
  api.state.nodes.set("node-a", "True");
  const nameless = { uid: HOLDER.uid, node: "node-a" } as unknown as Parameters<
    typeof proveDeath
  >[0];
  assert.equal(await proveDeath(nameless, { env }), "unknown");
  assert.deepEqual(api.state.requests, []);
});

// F1 (test-engineer, 175aa1cc): a 404 proves "no such object" ONLY as the API server's own
// `Status NotFound` naming that object. A proxy, a wrong base path or a non-Kubernetes listener
// answers 404 to every path — read as absence, it would prove every holder gone.

test("F1 NEVER: a bare (non-Kubernetes) 404 for the pod is no answer → unknown, never gone", async () => {
  api.state.bare404 = "all";
  api.state.nodes.set("node-a", "True");
  assert.equal(await proveDeath(HOLDER, { env }), "unknown");
  assert.deepEqual(api.state.requests, [POD_PATH], "the node is not even asked");
});

test("F1 NEVER: the pod's real NotFound but a bare 404 for the node → unknown, never gone", async () => {
  api.state.bare404 = "nodes";
  assert.equal(await proveDeath(HOLDER, { env }), "unknown");
  assert.deepEqual(api.state.requests, [POD_PATH, NODE_PATH]);
});

test("F1 NEVER: a Status NotFound naming ANOTHER object is no answer about this one → unknown", async () => {
  // A server whose every 404 is a well-formed NotFound — but for `ag-holder`, while we ask about
  // `ag-someone-else`.
  const shim = http.createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        kind: "Status",
        apiVersion: "v1",
        status: "Failure",
        reason: "NotFound",
        details: { name: "ag-holder", kind: "pods" },
        code: 404,
      }),
    );
  });
  await new Promise<void>((resolve) => shim.listen(0, "127.0.0.1", resolve));
  const { port } = shim.address() as AddressInfo;
  try {
    const asked = { ...HOLDER, name: "ag-someone-else" };
    const shimEnv = { ...env, ACPX_POD_API_URL: `http://127.0.0.1:${port}` };
    assert.equal(await proveDeath(asked, { env: shimEnv }), "unknown");
  } finally {
    shim.closeAllConnections();
    await new Promise<void>((resolve) => shim.close(() => resolve()));
  }
});

// Carried from A6: the HTTP GET is exported so `agent-pod-lookup.ts` drops its copy. One client.

test("apiConfig / apiGet are exported: the seam-configured client answers a GET, query string included, and bounds the body", async () => {
  const config = apiConfig(env);
  assert.ok(config, "configured from the seam");
  assert.equal(config.namespace, KIT_NAMESPACE);
  api.state.pods.set("ag-holder", { uid: HOLDER.uid, phase: "Running" });
  const answer = await apiGet(
    config,
    `/api/v1/namespaces/${KIT_NAMESPACE}/pods/ag-holder`,
    AbortSignal.timeout(2_000),
  );
  assert.equal(answer?.status, 200);
  // a body over the caller's cap is no answer (undefined), never a truncated one
  assert.equal(
    await apiGet(
      config,
      `/api/v1/namespaces/${KIT_NAMESPACE}/pods/ag-holder`,
      AbortSignal.timeout(2_000),
      20,
    ),
    undefined,
  );
  assert.equal(
    apiConfig({ NODE_TEST_CONTEXT: "x", ACPX_POD_SA_DIR: "/nonexistent/sa" }),
    undefined,
  );
});
