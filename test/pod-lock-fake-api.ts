import http from "node:http";
import type { AddressInfo } from "node:net";
import { KIT_TOKEN } from "./pod-kit/two-pods.js";

/**
 * A minimal fake Kubernetes API for A5's own rows (brick 8d85cb47), answering exactly the two GETs
 * in DEATH-PROOF-QUERIES.md. Lane X1's `test/pod-kit/fake-apiserver` is the shared one; this stays
 * the smallest thing that serves the C3.3 table until it lands.
 */

export type FakePod = { uid: string; phase: string };
export type FakeApiState = {
  pods: Map<string, FakePod>;
  /** node name → its Ready condition status ("True" / "False" / "Unknown"). Missing ⇒ 404. */
  nodes: Map<string, string>;
  /** "stall" never answers; "500" answers 500 to everything. */
  failure?: "stall" | "500";
  requests: string[];
};

export type FakeApi = { url: string; state: FakeApiState; close: () => Promise<void> };

function notFound(response: http.ServerResponse, kind: string, name: string): void {
  response.writeHead(404, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      kind: "Status",
      apiVersion: "v1",
      metadata: {},
      status: "Failure",
      message: `${kind} "${name}" not found`,
      reason: "NotFound",
      details: { name, kind },
      code: 404,
    }),
  );
}

export async function startFakeApi(namespace: string): Promise<FakeApi> {
  const state: FakeApiState = { pods: new Map(), nodes: new Map(), requests: [] };
  const server = http.createServer((request, response) => {
    state.requests.push(`${request.method} ${request.url}`);
    if (state.failure === "stall") {
      return;
    }
    if (state.failure === "500" || request.headers.authorization !== `Bearer ${KIT_TOKEN}`) {
      response.writeHead(state.failure === "500" ? 500 : 401);
      response.end("{}");
      return;
    }
    const url = request.url ?? "";
    const pod = new RegExp(`^/api/v1/namespaces/${namespace}/pods/([^/?]+)$`).exec(url);
    const node = /^\/api\/v1\/nodes\/([^/?]+)$/.exec(url);
    if (pod) {
      const name = decodeURIComponent(pod[1]);
      const found = state.pods.get(name);
      if (!found) {
        notFound(response, "pods", name);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          kind: "Pod",
          apiVersion: "v1",
          metadata: { name, namespace, uid: found.uid },
          spec: { nodeName: "some-node" },
          status: { phase: found.phase },
        }),
      );
      return;
    }
    if (node) {
      const name = decodeURIComponent(node[1]);
      const ready = state.nodes.get(name);
      if (ready === undefined) {
        notFound(response, "nodes", name);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          kind: "Node",
          apiVersion: "v1",
          metadata: { name },
          status: {
            conditions: [
              { type: "MemoryPressure", status: "False" },
              { type: "Ready", status: ready },
            ],
          },
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
