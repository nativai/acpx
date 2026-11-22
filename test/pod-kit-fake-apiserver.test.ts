import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startFakeApiServer } from "./pod-kit/fake-apiserver.js";
import type { ApiScript, FakeApiServer } from "./pod-kit/fake-apiserver.js";

// Self-test of the X1 fake Kubernetes API server. The rows are the decision table of block A5's
// DEATH-PROOF-QUERIES.md (C3.3): each row names what the death proof READS, and this file proves
// the fake serves exactly that — so a lane testing proveDeath against it exercises the real row,
// and a scripted fault demonstrably happens on the wire (never only that the script was read).

const NS = "dev-test";
const POD_UID = "11111111-2222-4333-8444-555555555555";

async function withApi(script: ApiScript, run: (api: FakeApiServer) => Promise<void>) {
  const api = await startFakeApiServer({ namespace: NS, ...script });
  try {
    await run(api);
  } finally {
    await api.close();
  }
}

async function getJson(
  api: FakeApiServer,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`${api.url}${path}`, { headers });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const podPath = (name: string) => `/api/v1/namespaces/${NS}/pods/${name}`;

test("row: pod present, uid equal, phase Running — the pod answers with uid and phase", async () => {
  await withApi({ pods: [{ name: "ag-a", uid: POD_UID, node: "n1" }] }, async (api) => {
    const { status, body } = await getJson(api, podPath("ag-a"));
    assert.equal(status, 200);
    assert.equal(body.kind, "Pod");
    assert.equal(body.metadata.uid, POD_UID);
    assert.equal(body.metadata.name, "ag-a");
    assert.equal(body.metadata.namespace, NS);
    assert.equal(body.spec.nodeName, "n1");
    assert.equal(body.status.phase, "Running");
    assert.equal(body.metadata.deletionTimestamp, undefined);
  });
});

test("row: terminal phases Succeeded and Failed are served as such", async () => {
  await withApi(
    {
      pods: [
        { name: "ag-done", uid: POD_UID, phase: "Succeeded" },
        { name: "ag-failed", phase: "Failed" },
      ],
    },
    async (api) => {
      assert.equal((await getJson(api, podPath("ag-done"))).body.status.phase, "Succeeded");
      assert.equal((await getJson(api, podPath("ag-failed"))).body.status.phase, "Failed");
    },
  );
});

test("row: a terminating pod still exists — deletionTimestamp set, phase not terminal", async () => {
  await withApi({ pods: [{ name: "ag-t", deleting: true }] }, async (api) => {
    const { body } = await getJson(api, podPath("ag-t"));
    assert.ok(typeof body.metadata.deletionTimestamp === "string");
    assert.equal(body.status.phase, "Running");
  });
});

test("row: pod absent — a Status 404 NotFound exactly as the real API words it", async () => {
  await withApi({}, async (api) => {
    const { status, body } = await getJson(api, podPath("ag-nope"));
    assert.equal(status, 404);
    assert.deepEqual(body, {
      kind: "Status",
      apiVersion: "v1",
      metadata: {},
      status: "Failure",
      message: 'pods "ag-nope" not found',
      reason: "NotFound",
      details: { name: "ag-nope", kind: "pods" },
      code: 404,
    });
  });
});

test("row: a pod of the same name with a DIFFERENT uid (replaced pod) answers 200 with that uid", async () => {
  await withApi(
    { pods: [{ name: "ag-a", uid: "99999999-2222-4333-8444-555555555555" }] },
    async (api) => {
      const { body } = await getJson(api, podPath("ag-a"));
      assert.notEqual(body.metadata.uid, POD_UID);
    },
  );
});

test("a pod in another namespace is not found under this one", async () => {
  await withApi({ pods: [{ name: "ag-a", namespace: "other" }] }, async (api) => {
    assert.equal((await getJson(api, podPath("ag-a"))).status, 404);
    assert.equal((await getJson(api, "/api/v1/namespaces/other/pods/ag-a")).status, 200);
  });
});

test("rows: node Ready True / False / Unknown / no Ready condition / node absent", async () => {
  await withApi(
    {
      nodes: [
        { name: "n-true", ready: "True" },
        { name: "n-false", ready: "False" },
        { name: "n-unknown", ready: "Unknown" },
        { name: "n-silent", ready: null },
      ],
    },
    async (api) => {
      const ready = async (name: string): Promise<string | undefined> => {
        const { status, body } = await getJson(api, `/api/v1/nodes/${name}`);
        assert.equal(status, 200);
        assert.equal(body.kind, "Node");
        assert.equal(body.metadata.name, name);
        return (body.status.conditions as Array<{ type: string; status: string }>).find(
          (condition) => condition.type === "Ready",
        )?.status;
      };
      assert.equal(await ready("n-true"), "True");
      assert.equal(await ready("n-false"), "False");
      assert.equal(await ready("n-unknown"), "Unknown");
      assert.equal(await ready("n-silent"), undefined);
      const absent = await getJson(api, "/api/v1/nodes/n-gone");
      assert.equal(absent.status, 404);
      assert.equal(absent.body.reason, "NotFound");
      assert.deepEqual(absent.body.details, { name: "n-gone", kind: "nodes" });
    },
  );
});

test("state moves between two asks: phase change, pod gone, node turning NotReady", async () => {
  await withApi({ pods: [{ name: "ag-a", node: "n1" }], nodes: [{ name: "n1" }] }, async (api) => {
    assert.equal((await getJson(api, podPath("ag-a"))).body.status.phase, "Running");
    api.setPodPhase("ag-a", "Failed", NS);
    assert.equal((await getJson(api, podPath("ag-a"))).body.status.phase, "Failed");
    api.removePod("ag-a", NS);
    assert.equal((await getJson(api, podPath("ag-a"))).status, 404);
    api.setNodeReady("n1", "Unknown");
    const node = (await getJson(api, "/api/v1/nodes/n1")).body;
    assert.equal(node.status.conditions[0].status, "Unknown");
    api.removeNode("n1");
    assert.equal((await getJson(api, "/api/v1/nodes/n1")).status, 404);
  });
});

test("the bearer token is checked: a wrong or absent one is a 401 Status; the right one passes", async () => {
  await withApi({ token: "tok-1", pods: [{ name: "ag-a" }] }, async (api) => {
    const absent = await getJson(api, podPath("ag-a"));
    assert.equal(absent.status, 401);
    assert.equal(absent.body.reason, "Unauthorized");
    assert.equal(
      (await getJson(api, podPath("ag-a"), { authorization: "Bearer wrong" })).status,
      401,
    );
    assert.equal(
      (await getJson(api, podPath("ag-a"), { authorization: "Bearer tok-1" })).status,
      200,
    );
    assert.deepEqual(
      api.requests.map((entry) => entry.answer),
      ["unauthorized", "unauthorized", "pod"],
    );
  });
});

test("the request record holds what acpx sent: method, path, Accept and Authorization", async () => {
  await withApi({ pods: [{ name: "ag-a" }] }, async (api) => {
    await getJson(api, podPath("ag-a"), { authorization: "Bearer t", accept: "application/json" });
    const [entry] = api.requests;
    assert.equal(entry?.method, "GET");
    assert.equal(entry?.path, podPath("ag-a"));
    assert.equal(entry?.query, "");
    assert.equal(entry?.headers.authorization, "Bearer t");
    assert.equal(entry?.headers.accept, "application/json");
    assert.equal(entry?.status, 200);
  });
});

test("faults: a failure status is a Status body with the scripted code (401, 403, 500, 503)", async () => {
  for (const status of [401, 403, 500, 503]) {
    await withApi(
      { faults: [{ mode: "status", status }], pods: [{ name: "ag-a" }] },
      async (api) => {
        const answer = await getJson(api, podPath("ag-a"));
        assert.equal(answer.status, status);
        assert.equal(answer.body.kind, "Status");
        assert.equal(answer.body.code, status);
        assert.equal(api.requests[0]?.answer, "fault:status");
      },
    );
  }
});

test("faults: hang never answers — the client's own deadline is what ends the wait", async () => {
  await withApi({ faults: [{ mode: "hang" }], pods: [{ name: "ag-a" }] }, async (api) => {
    await assert.rejects(
      fetch(`${api.url}${podPath("ag-a")}`, { signal: AbortSignal.timeout(300) }),
    );
    assert.equal(api.requests[0]?.answer, "fault:hang");
    assert.equal(api.requests[0]?.status, null, "no status line was ever sent");
  });
});

test("faults: reset cuts the connection; malformed answers 200 with a body that is not JSON", async () => {
  await withApi({ faults: [{ mode: "reset" }] }, async (api) => {
    await assert.rejects(fetch(`${api.url}${podPath("ag-a")}`));
  });
  await withApi({ faults: [{ mode: "malformed" }] }, async (api) => {
    const response = await fetch(`${api.url}${podPath("ag-a")}`);
    assert.equal(response.status, 200);
    assert.throws(() => JSON.parse("<html>upstream gateway</html>"));
    assert.equal(await response.text(), "<html>upstream gateway</html>");
  });
});

test("A-1: the pod's Ready lastTransitionTime is scriptable, defaults to now, moves with setPodReady", async () => {
  await withApi(
    {
      pods: [
        {
          name: "ag-a",
          ready: "False",
          readyTransitionTime: "2026-11-21T10:00:00.000Z",
          node: "n1",
        },
        { name: "ag-b" },
      ],
      nodes: [{ name: "n1", ready: "Unknown", readyTransitionTime: "2026-11-21T09:00:00.000Z" }],
    },
    async (api) => {
      const ready = async (name: string) => {
        const { body } = await getJson(api, podPath(name));
        return (body.status.conditions as Array<Record<string, string>>).find(
          (condition) => condition.type === "Ready",
        );
      };
      assert.deepEqual(await ready("ag-a"), {
        type: "Ready",
        status: "False",
        lastTransitionTime: "2026-11-21T10:00:00.000Z",
      });
      const before = Date.now();
      const defaulted = await ready("ag-b");
      assert.equal(defaulted?.status, "True");
      assert.ok(Date.parse(defaulted?.lastTransitionTime ?? "") >= before - 5_000);
      api.setPodReady("ag-a", "True", "2026-11-21T11:30:00.000Z", NS);
      assert.deepEqual(await ready("ag-a"), {
        type: "Ready",
        status: "True",
        lastTransitionTime: "2026-11-21T11:30:00.000Z",
      });
      const node = (await getJson(api, "/api/v1/nodes/n1")).body;
      assert.equal(node.status.conditions[0].lastTransitionTime, "2026-11-21T09:00:00.000Z");
      assert.equal(node.status.conditions[0].status, "Unknown");
    },
  );
});

test("v1.1 NotFound: the real 404 names the asked object; each other 404 shape is scriptable and differs in exactly one respect", async () => {
  await withApi({ pods: [{ name: "ag-a" }], nodes: [{ name: "n1" }] }, async (api) => {
    for (const [path, kind, name] of [
      [podPath("ag-nope"), "pods", "ag-nope"],
      ["/api/v1/nodes/n-nope", "nodes", "n-nope"],
    ] as const) {
      const { status, body } = await getJson(api, path);
      assert.equal(status, 404);
      assert.deepEqual(
        [body.kind, body.reason, body.details.kind, body.details.name, body.code],
        ["Status", "NotFound", kind, name, 404],
      );
    }
  });
  const wrong = async (variant: string) => {
    const api = await startFakeApiServer({
      namespace: NS,
      pods: [{ name: "ag-a" }],
      faults: [{ mode: "notfound", variant: variant as "text" }],
    });
    try {
      const response = await fetch(`${api.url}${podPath("ag-a")}`);
      const text = await response.text();
      let body: Record<string, any> | null = null;
      try {
        body = JSON.parse(text) as Record<string, any>;
      } catch {
        body = null;
      }
      return { status: response.status, type: response.headers.get("content-type"), text, body };
    } finally {
      await api.close();
    }
  };
  const text = await wrong("text");
  assert.deepEqual([text.status, text.type, text.body], [404, "text/plain", null]);
  const empty = await wrong("empty");
  assert.deepEqual([empty.status, empty.text], [404, ""]);
  const reason = await wrong("other_reason");
  assert.deepEqual(
    [reason.body?.kind, reason.body?.reason, reason.body?.details.kind, reason.body?.details.name],
    ["Status", "Gone", "pods", "ag-a"],
  );
  const name = await wrong("other_name");
  assert.deepEqual(
    [name.body?.reason, name.body?.details.kind, name.body?.details.name],
    ["NotFound", "pods", "ag-a-other"],
  );
  const kind = await wrong("other_kind");
  assert.deepEqual(
    [kind.body?.reason, kind.body?.details.kind, kind.body?.details.name],
    ["NotFound", "services", "ag-a"],
  );
  // the fault answers 404 even though the pod exists — that is what makes it a wrong 404
  assert.equal(text.status, 404);
});

test("faults: slow answers normally, after the delay", async () => {
  await withApi(
    { faults: [{ mode: "slow", delayMs: 250 }], pods: [{ name: "ag-a" }] },
    async (api) => {
      const started = Date.now();
      const answer = await getJson(api, podPath("ag-a"));
      assert.equal(answer.status, 200);
      assert.ok(Date.now() - started >= 230);
    },
  );
});

test("faults scoped by path and spent after `times`: the node ask fails, the pod ask does not; then it heals", async () => {
  await withApi(
    {
      faults: [{ mode: "status", status: 503, path: "/api/v1/nodes", times: 1 }],
      pods: [{ name: "ag-a" }],
      nodes: [{ name: "n1" }],
    },
    async (api) => {
      assert.equal(
        (await getJson(api, podPath("ag-a"))).status,
        200,
        "the pod path is not faulted",
      );
      assert.equal((await getJson(api, "/api/v1/nodes/n1")).status, 503);
      assert.equal(
        (await getJson(api, "/api/v1/nodes/n1")).status,
        200,
        "the fault was spent after one request",
      );
    },
  );
});

test("after close() the port refuses connections", async () => {
  const api = await startFakeApiServer({});
  const url = api.url;
  await api.close();
  await assert.rejects(fetch(`${url}${podPath("x")}`));
});

test("a uid cannot be selected, as on the real API: fieldSelector=metadata.uid is a 400", async () => {
  await withApi({ pods: [{ name: "ag-a", uid: POD_UID }] }, async (api) => {
    const answer = await getJson(
      api,
      `/api/v1/namespaces/${NS}/pods?fieldSelector=metadata.uid%3D${POD_UID}`,
    );
    assert.equal(answer.status, 400);
    assert.equal(answer.body.message, "field label not supported: metadata.uid");
  });
});

test("pod lists honour label and field selectors (the atrium agent-pod set)", async () => {
  await withApi(
    {
      pods: [
        {
          name: "ag-1",
          labels: { "workbench.nativai.de/kind": "agent", app: "x" },
          podIP: "10.0.0.1",
          node: "n1",
        },
        {
          name: "ag-2",
          labels: { "workbench.nativai.de/kind": "agent" },
          podIP: "10.0.0.2",
          node: "n2",
          phase: "Pending",
        },
        { name: "wb-1", labels: { "workbench.nativai.de/kind": "seat" } },
        { name: "far", namespace: "other", labels: { "workbench.nativai.de/kind": "agent" } },
      ],
    },
    async (api) => {
      const names = async (
        query: string,
        base = `/api/v1/namespaces/${NS}/pods`,
      ): Promise<string[]> => {
        const { status, body } = await getJson(api, `${base}?${query}`);
        assert.equal(status, 200);
        assert.equal(body.kind, "PodList");
        return (body.items as Array<{ metadata: { name: string } }>)
          .map((item) => item.metadata.name)
          .toSorted();
      };
      assert.deepEqual(await names("labelSelector=workbench.nativai.de/kind%3Dagent"), [
        "ag-1",
        "ag-2",
      ]);
      assert.deepEqual(await names("labelSelector=workbench.nativai.de/kind%20in%20(seat,other)"), [
        "wb-1",
      ]);
      assert.deepEqual(await names("labelSelector=workbench.nativai.de/kind!%3Dagent"), ["wb-1"]);
      assert.deepEqual(await names("labelSelector=app"), ["ag-1"]);
      assert.deepEqual(await names("labelSelector=!app,workbench.nativai.de/kind%3Dagent"), [
        "ag-2",
      ]);
      assert.deepEqual(await names("fieldSelector=status.phase%3DPending"), ["ag-2"]);
      assert.deepEqual(await names("fieldSelector=metadata.name%3Dag-1,spec.nodeName%3Dn1"), [
        "ag-1",
      ]);
      assert.deepEqual(
        await names("labelSelector=workbench.nativai.de/kind%3Dagent", "/api/v1/pods"),
        ["ag-1", "ag-2", "far"],
      );
    },
  );
});

test("watch: ADDED for the current set, then MODIFIED / DELETED as the state moves; resourceVersion replays", async () => {
  await withApi({ pods: [{ name: "ag-1", labels: { k: "agent" } }] }, async (api) => {
    const controller = new AbortController();
    const response = await fetch(
      `${api.url}/api/v1/namespaces/${NS}/pods?watch=true&labelSelector=k%3Dagent`,
      {
        signal: controller.signal,
      },
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let text = "";
    const events = async (
      count: number,
    ): Promise<Array<{ type: string; object: { metadata: { name: string } } }>> => {
      while (text.split("\n").filter(Boolean).length < count) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    };
    assert.deepEqual(
      (await events(1)).map((event) => event.type),
      ["ADDED"],
    );
    api.addPod({ name: "ag-2", namespace: NS, labels: { k: "agent" } });
    api.addPod({ name: "unrelated", namespace: NS, labels: { k: "seat" } });
    api.setPodPhase("ag-2", "Failed", NS);
    api.removePod("ag-1", NS);
    const seen = await events(4);
    assert.deepEqual(
      seen.map((event) => `${event.type}:${event.object.metadata.name}`),
      ["ADDED:ag-1", "ADDED:ag-2", "MODIFIED:ag-2", "DELETED:ag-1"],
      "the unrelated pod (other label) never reaches this watcher",
    );
    controller.abort();
    const list = await getJson(api, `/api/v1/namespaces/${NS}/pods`);
    const rv = (list.body.metadata as { resourceVersion: string }).resourceVersion;
    api.setPodPhase("ag-2", "Succeeded", NS);
    const replay = await fetch(
      `${api.url}/api/v1/namespaces/${NS}/pods?watch=1&resourceVersion=${rv}&timeoutSeconds=1`,
    );
    const lines = (await replay.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(
      lines.map((line) => line.type),
      ["MODIFIED"],
      "only what happened after the given resourceVersion",
    );
  });
});

test("F13: list items carry no kind/apiVersion, timestamps are second precision, selectors the real API accepts are accepted", async () => {
  await withApi(
    {
      pods: [
        { name: "ag-a", node: "n1", serviceAccount: "dev-server-control" },
        { name: "ag-b", serviceAccount: "other" },
      ],
      nodes: [{ name: "n1" }, { name: "n2", unschedulable: true }],
    },
    async (api) => {
      const list = (await getJson(api, `/api/v1/namespaces/${NS}/pods`)).body;
      assert.equal(list.kind, "PodList");
      for (const item of list.items as Array<Record<string, any>>) {
        assert.equal(item.kind, undefined, "a list item names no kind");
        assert.equal(item.apiVersion, undefined);
        assert.match(item.metadata.creationTimestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
        assert.match(
          item.status.conditions[0].lastTransitionTime,
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/,
        );
      }
      assert.equal((await getJson(api, podPath("ag-a"))).body.kind, "Pod", "a single object does");
      const names = async (query: string, base: string) =>
        (
          (await getJson(api, `${base}?${query}`)).body.items as Array<{
            metadata: { name: string };
          }>
        )
          .map((item) => item.metadata.name)
          .toSorted();
      assert.deepEqual(
        await names(
          "fieldSelector=spec.serviceAccountName%3Ddev-server-control",
          `/api/v1/namespaces/${NS}/pods`,
        ),
        ["ag-a"],
      );
      assert.deepEqual(await names("fieldSelector=spec.unschedulable%3Dfalse", "/api/v1/nodes"), [
        "n1",
      ]);
      assert.deepEqual(await names("fieldSelector=spec.unschedulable%3Dtrue", "/api/v1/nodes"), [
        "n2",
      ]);
    },
  );
});

test("F13: an unscheduled Pending pod has no nodeName key and no Ready condition; a failing node is KubeletNotReady", async () => {
  await withApi(
    {
      pods: [
        { name: "ag-p", phase: "Pending" },
        { name: "ag-q", phase: "Pending", node: "n1" },
      ],
      nodes: [
        { name: "n1", ready: "False" },
        { name: "n2", ready: "Unknown" },
      ],
    },
    async (api) => {
      const pending = (await getJson(api, podPath("ag-p"))).body;
      assert.equal("nodeName" in pending.spec, false);
      assert.deepEqual(
        pending.status.conditions.map((c: { type: string; status: string }) => [c.type, c.status]),
        [["PodScheduled", "False"]],
      );
      const scheduled = (await getJson(api, podPath("ag-q"))).body;
      assert.equal(scheduled.spec.nodeName, "n1");
      assert.equal(
        scheduled.status.conditions[0].status,
        "True",
        "PodScheduled once it has a node",
      );
      assert.equal(
        (await getJson(api, "/api/v1/nodes/n1")).body.status.conditions[0].reason,
        "KubeletNotReady",
      );
      assert.equal(
        (await getJson(api, "/api/v1/nodes/n2")).body.status.conditions[0].reason,
        "NodeStatusUnknown",
      );
      // setPodReady adds the Ready condition a Pending pod did not have
      api.setPodReady("ag-p", "True", "2026-11-21T11:30:00Z", NS);
      const after = (await getJson(api, podPath("ag-p"))).body;
      assert.deepEqual(
        after.status.conditions.find((c: { type: string }) => c.type === "Ready"),
        { type: "Ready", status: "True", lastTransitionTime: "2026-11-21T11:30:00Z" },
      );
    },
  );
});

test("F13: a watch from a resourceVersion the server no longer holds gets an ERROR event, 410 Expired (atrium's re-list path)", async () => {
  await withApi({ pods: [{ name: "ag-1" }] }, async (api) => {
    const listed = (await getJson(api, `/api/v1/namespaces/${NS}/pods`)).body;
    const rv = (listed.metadata as { resourceVersion: string }).resourceVersion;
    api.setPodPhase("ag-1", "Failed", NS);
    api.compact();
    const expired = await fetch(
      `${api.url}/api/v1/namespaces/${NS}/pods?watch=true&resourceVersion=${rv}`,
    );
    const lines = (await expired.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.type, "ERROR");
    assert.deepEqual(
      [lines[0]?.object.kind, lines[0]?.object.reason, lines[0]?.object.code],
      ["Status", "Expired", 410],
    );
    // a watch from the current version is fine
    const fresh = (await getJson(api, `/api/v1/namespaces/${NS}/pods`)).body.metadata
      .resourceVersion;
    const ok = await fetch(
      `${api.url}/api/v1/namespaces/${NS}/pods?watch=1&resourceVersion=${fresh}&timeoutSeconds=1`,
    );
    assert.equal((await ok.text()).includes("ERROR"), false);
  });
});

test("an unknown path is a Status 404 and a non-GET is a Status 405", async () => {
  await withApi({}, async (api) => {
    assert.equal((await getJson(api, "/apis/apps/v1/deployments")).status, 404);
    const post = await fetch(`${api.url}${podPath("ag-a")}`, { method: "DELETE" });
    assert.equal(post.status, 405);
    assert.equal(((await post.json()) as { reason: string }).reason, "MethodNotAllowed");
  });
});

test("run as a process from its TypeScript source: prints its port, honours --script, is steerable over /_kit", async () => {
  const source = fileURLToPath(new URL("../../test/pod-kit/fake-apiserver.ts", import.meta.url));
  const script = JSON.stringify({
    namespace: NS,
    pods: [{ name: "ag-a", uid: POD_UID }],
    token: "t",
  });
  const child = spawn(process.execPath, [source, "--port", "0", "--script", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const firstLine = await new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.includes("\n")) {
          resolve(text.slice(0, text.indexOf("\n")));
        }
      });
      child.once("exit", (code) =>
        reject(new Error(`fake apiserver exited early rc=${String(code)}`)),
      );
    });
    const announced = JSON.parse(firstLine) as { fake: string; port: number };
    assert.equal(announced.fake, "kube-api");
    const base = `http://127.0.0.1:${String(announced.port)}`;
    const auth = { authorization: "Bearer t" };
    const first = await fetch(`${base}${podPath("ag-a")}`, { headers: auth });
    assert.equal(((await first.json()) as { metadata: { uid: string } }).metadata.uid, POD_UID);
    await fetch(`${base}/_kit/op`, {
      method: "POST",
      body: JSON.stringify({ op: "removePod", name: "ag-a", namespace: NS }),
    });
    assert.equal((await fetch(`${base}${podPath("ag-a")}`, { headers: auth })).status, 404);
    await fetch(`${base}/_kit/op`, {
      method: "POST",
      body: JSON.stringify({ op: "setFaults", faults: [{ mode: "status", status: 503 }] }),
    });
    assert.equal((await fetch(`${base}${podPath("ag-a")}`, { headers: auth })).status, 503);
    const record = (await (await fetch(`${base}/_kit/record`)).json()) as {
      requests: Array<{ answer: string }>;
    };
    assert.deepEqual(
      record.requests.map((entry) => entry.answer),
      ["pod", "pod_not_found", "fault:status"],
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
