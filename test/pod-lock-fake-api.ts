import http from "node:http";
import type { AddressInfo } from "node:net";
import { KIT_TOKEN } from "./pod-kit/two-pods.js";

/**
 * A minimal fake Kubernetes API for A5's own rows (brick 8d85cb47), answering exactly the two GETs
 * in DEATH-PROOF-QUERIES.md. Lane X1's `test/pod-kit/fake-apiserver` is the shared one; this stays
 * the smallest thing that serves the C3.3 table until it lands.
 */

export type FakePod = {
  uid: string;
  phase: string;
  /** Optional status detail, for the terminal-reason rows (A4): container states and the pod's own reason. */
  containerStatuses?: unknown[];
  reason?: string;
};
export type FakeApiState = {
  pods: Map<string, FakePod>;
  /** node name → its Ready condition status ("True" / "False" / "Unknown"). Missing ⇒ 404. */
  nodes: Map<string, string>;
  /** "stall" never answers; "500" answers 500 to everything. */
  failure?: "stall" | "500";
  /** A non-Kubernetes 404 (`text/plain`, no Status body) — to every path, or only to nodes (F1). */
  bare404?: "all" | "nodes";
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
    if (
      state.bare404 === "all" ||
      (state.bare404 === "nodes" && url.startsWith("/api/v1/nodes/"))
    ) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("404 page not found\n");
      return;
    }
    const pod = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/?]+)$/.exec(url);
    const node = /^\/api\/v1\/nodes\/([^/?]+)$/.exec(url);
    if (pod) {
      const name = decodeURIComponent(pod[2]);
      // Pods live in `namespace`; any other namespace has none (a real NotFound, as the API answers).
      const found = decodeURIComponent(pod[1]) === namespace ? state.pods.get(name) : undefined;
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
          status: {
            phase: found.phase,
            ...(found.reason ? { reason: found.reason } : {}),
            ...(found.containerStatuses ? { containerStatuses: found.containerStatuses } : {}),
          },
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
