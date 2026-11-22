import { startFakeApiServer, type FakeApiServer } from "./pod-kit/fake-apiserver.js";
import { KIT_TOKEN } from "./pod-kit/two-pods.js";

/**
 * Thin helpers for the A5 rows (the death proof, the lock and lease rows) over X1's kit API server
 * (`test/pod-kit/fake-apiserver.ts`), which follows the real Kubernetes API. They hold NO server logic: each is
 * one or two calls on the kit's own state-mutation surface (`addPod`, `addNode`, `setFaults`, `requests`), so a row
 * reads `putPod(api, name, {...})` where the retired local fake read `api.state.pods.set(name, {...})`.
 */
export type { FakeApiServer };

const tracked = new WeakMap<FakeApiServer, { pods: Set<string>; nodes: Set<string> }>();

function known(api: FakeApiServer): { pods: Set<string>; nodes: Set<string> } {
  let entry = tracked.get(api);
  if (entry === undefined) {
    entry = { pods: new Set(), nodes: new Set() };
    tracked.set(api, entry);
  }
  return entry;
}

/** The kit API server requiring the service-account token the kit's `makeServiceAccountDir` writes. */
export async function startKitApi(namespace: string): Promise<FakeApiServer> {
  return await startFakeApiServer({ namespace, token: KIT_TOKEN });
}

export type PutPod = {
  uid: string;
  phase: string;
  node?: string;
  /** Terminal detail (`state.terminated.reason` …) — the kit's `PodSeed` carries it. */
  containerStatuses?: unknown[];
  reason?: string;
};

export function putPod(api: FakeApiServer, name: string, pod: PutPod): void {
  known(api).pods.add(name);
  api.addPod({
    name,
    uid: pod.uid,
    phase: pod.phase,
    ...(pod.node === undefined ? {} : { node: pod.node }),
    ...(pod.containerStatuses === undefined ? {} : { containerStatuses: pod.containerStatuses }),
    ...(pod.reason === undefined ? {} : { reason: pod.reason }),
  });
}

export function putNode(
  api: FakeApiServer,
  name: string,
  ready: "True" | "False" | "Unknown",
): void {
  known(api).nodes.add(name);
  api.addNode({ name, ready });
}

export function clearPods(api: FakeApiServer): void {
  for (const name of known(api).pods) {
    api.removePod(name);
  }
  known(api).pods.clear();
}

export function clearNodes(api: FakeApiServer): void {
  for (const name of known(api).nodes) {
    api.removeNode(name);
  }
  known(api).nodes.clear();
}

/** `"500"`: every request is a 500; `"stall"`: none is answered; `undefined`: healthy again. */
export function failWith(api: FakeApiServer, failure: "500" | "stall" | undefined): void {
  api.setFaults(
    failure === "500"
      ? [{ mode: "status", status: 500 }]
      : failure === "stall"
        ? [{ mode: "hang" }]
        : [],
  );
}

/** A 404 that is not Kubernetes's own (`text/plain`) — on every path, or only on node lookups. */
export function bare404(api: FakeApiServer, where: "all" | "nodes" | undefined): void {
  api.setFaults(
    where === undefined
      ? []
      : [
          {
            mode: "notfound",
            variant: "text",
            ...(where === "nodes" ? { path: "/api/v1/nodes/" } : {}),
          },
        ],
  );
}

/** The requests the server saw, as `METHOD /path` (no query), in order. */
export function requestLines(api: FakeApiServer): string[] {
  return api.requests.map((request) => `${request.method} ${request.path}`);
}
