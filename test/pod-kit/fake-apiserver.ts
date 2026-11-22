// X1 test kit — the fake Kubernetes API server, for the death proof (CONTRACTS-r4.md C3.3).
//
// One file, Node standard library only, erasable TypeScript only — imported by acpx's tests
//   import { startFakeApiServer } from "./pod-kit/fake-apiserver.js"
// or run as a process by any repo
//   node fake-apiserver.ts --port 0 --script <file|inline json>
// (first stdout line: `{"fake":"kube-api","host":"127.0.0.1","port":<n>}`).
//
// What it speaks: the real Kubernetes REST shapes acpx's death proof sends — see
// DEATH-PROOF-QUERIES.md of block A5: `GET /api/v1/namespaces/<ns>/pods/<name>` and
// `GET /api/v1/nodes/<name>` — answered from a state you build (pods, nodes), as a Pod / Node
// object or a `Status` 404. Beyond that, for the atrium server's pod-address watch (C6.1): pod and
// node lists with label / field selectors, and `?watch=true` streams. Plain HTTP only: acpx reaches
// it through its test seam (`ACPX_POD_API_URL`, `ACPX_POD_SA_DIR`, honoured under NODE_TEST_CONTEXT).
//
// "No answer": a fault — hang (never answers), reset (connection cut), a failure status
// (401/403/429/5xx with a `Status` body), slow, malformed (200, not JSON). See README.md.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";

export type ReadyStatus = "True" | "False" | "Unknown";

export interface PodSeed {
  name: string;
  namespace?: string;
  uid?: string;
  /** spec.nodeName; absent = unscheduled (the key is absent from the pod, as on the real API). */
  node?: string;
  /** spec.serviceAccountName; default "default". */
  serviceAccount?: string;
  /** Default `Running`. `Succeeded` and `Failed` are the terminal phases (C3.3). */
  phase?: string;
  /** The pod's Ready condition status; default "True" while Running, else "False". */
  ready?: ReadyStatus;
  /**
   * `status.conditions[type=Ready].lastTransitionTime` (A-1): acpx counts its `agent_unreachable` bound from
   * it. An ISO time; default: now.
   */
  readyTransitionTime?: string;
  podIP?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  /** Sets metadata.deletionTimestamp: the pod is terminating, and still exists. */
  deleting?: boolean;
}

export interface NodeSeed {
  name: string;
  /** The Ready condition's status. `null`: the node reports no Ready condition at all. Default "True". */
  ready?: ReadyStatus | null;
  /** The Ready condition's `lastTransitionTime` (ISO); default: now. */
  readyTransitionTime?: string;
  /** spec.unschedulable (cordoned); absent otherwise, as on the real API. */
  unschedulable?: boolean;
  labels?: Record<string, string>;
}

export type FaultMode = "hang" | "reset" | "status" | "slow" | "malformed" | "notfound";

/**
 * A 404 that is NOT the proof of absence (DEATH-PROOF-QUERIES.md v1.1, "NotFound"): acpx must read each as
 * `unknown`. `text` — `text/plain`; `empty` — no body; `other_reason` — a Status with another reason;
 * `other_name` — details naming another object; `other_kind` — details of another kind.
 */
export type NotFoundVariant = "text" | "empty" | "other_reason" | "other_name" | "other_kind";

export interface ApiFault {
  mode: FaultMode;
  /** Only requests whose path starts with this; default every request. */
  path?: string;
  method?: string;
  /** For `status`: the HTTP status (default 503). */
  status?: number;
  /** For `notfound`: which wrong 404 (default `text`). The fault answers 404 even where the object exists. */
  variant?: NotFoundVariant;
  /** For `slow`: wait this long, then answer normally. */
  delayMs?: number;
  /** The fault applies to this many requests, then is spent (default: for ever). */
  times?: number;
}

export interface ApiScript {
  /** Namespace of pods that name none. Default "default". */
  namespace?: string;
  pods?: PodSeed[];
  nodes?: NodeSeed[];
  /** When set, a request without `Authorization: Bearer <token>` gets a 401 `Status`. */
  token?: string;
  faults?: ApiFault[];
}

export interface ApiRequestRecord {
  seq: number;
  atMs: number;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  /** What the fake did: pod | pod_list | node | node_list | watch | not_found | unauthorized | fault:<mode> | … */
  answer: string;
  status: number | null;
}

interface PodEvent {
  rv: number;
  type: "ADDED" | "MODIFIED" | "DELETED";
  object: KubeObject;
}

type KubeObject = Record<string, unknown> & { metadata: Record<string, unknown> };

interface Watcher {
  namespace: string | null;
  labelSelector: string;
  fieldSelector: string;
  response: ServerResponse;
}

function uuidFrom(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function statusBody(code: number, message: string, reason: string, details?: object): object {
  return {
    kind: "Status",
    apiVersion: "v1",
    metadata: {},
    status: "Failure",
    message,
    reason,
    ...(details === undefined ? {} : { details }),
    code,
  };
}

const REASONS: Record<number, string> = {
  400: "BadRequest",
  401: "Unauthorized",
  403: "Forbidden",
  404: "NotFound",
  405: "MethodNotAllowed",
  429: "TooManyRequests",
  500: "InternalError",
  503: "ServiceUnavailable",
  504: "Timeout",
};

class SelectorError extends Error {}

function splitTerms(selector: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    }
    if (char === "," && depth === 0) {
      terms.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) {
    terms.push(current.trim());
  }
  return terms.filter((term) => term.length > 0);
}

/** Kubernetes label-selector grammar: `k=v`, `k==v`, `k!=v`, `k`, `!k`, `k in (a,b)`, `k notin (a,b)`. */
export function matchesLabelSelector(labels: Record<string, string>, selector: string): boolean {
  for (const term of splitTerms(selector)) {
    const setMatch = /^([^\s!=]+)\s+(in|notin)\s*\((.*)\)$/.exec(term);
    if (setMatch !== null) {
      const values = (setMatch[3] ?? "").split(",").map((value) => value.trim());
      const has = labels[setMatch[1] ?? ""];
      const inSet = has !== undefined && values.includes(has);
      if (setMatch[2] === "in" ? !inSet : inSet) {
        return false;
      }
    } else if (term.includes("!=")) {
      const [key, value] = term.split("!=");
      if (labels[(key ?? "").trim()] === (value ?? "").trim()) {
        return false;
      }
    } else if (term.includes("=")) {
      const [key, value] = term.split(/[=]=?/);
      if (labels[(key ?? "").trim()] !== (value ?? "").trim()) {
        return false;
      }
    } else if (term.startsWith("!")) {
      if (term.slice(1).trim() in labels) {
        return false;
      }
    } else if (!(term in labels)) {
      return false;
    }
  }
  return true;
}

/** The real API's timestamps have second precision: `2026-11-18T08:22:07Z`. */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fieldValue(object: KubeObject, path: string, supported: string[]): string {
  if (!supported.includes(path)) {
    // The real API's answer to a field it cannot select on — measured for metadata.uid (A5's report).
    throw new SelectorError(`field label not supported: ${path}`);
  }
  let value: unknown = object;
  for (const part of path.split(".")) {
    value =
      typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)[part]
        : undefined;
  }
  if (value === undefined && path === "spec.unschedulable") {
    return "false"; // an absent field selects as false, as on the real API
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

const POD_FIELDS = [
  "metadata.name",
  "metadata.namespace",
  "spec.nodeName",
  "spec.serviceAccountName",
  "spec.restartPolicy",
  "status.phase",
  "status.podIP",
];
const NODE_FIELDS = ["metadata.name", "spec.unschedulable"];

function matchesFieldSelector(object: KubeObject, selector: string, supported: string[]): boolean {
  for (const term of splitTerms(selector)) {
    const negated = term.includes("!=");
    const [path, value] = term.split(negated ? "!=" : /[=]=?/);
    const actual = fieldValue(object, (path ?? "").trim(), supported);
    if (negated ? actual === (value ?? "").trim() : actual !== (value ?? "").trim()) {
      return false;
    }
  }
  return true;
}

export class FakeApiServer {
  readonly requests: ApiRequestRecord[] = [];
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly startedAt = Date.now();
  private readonly pods = new Map<string, KubeObject>();
  private readonly nodes = new Map<string, KubeObject>();
  private readonly events: PodEvent[] = [];
  private readonly watchers = new Set<Watcher>();
  private readonly faultsLeft = new Map<ApiFault, number>();
  private faults: ApiFault[] = [];
  private token: string | undefined;
  private defaultNamespace = "default";
  private resourceVersion = 1000;
  /** Events older than this resourceVersion are no longer held (`compact()`): a watch from before it is Expired. */
  private minResourceVersion = 0;
  private podCounter = 0;
  private hostName = "127.0.0.1";

  constructor(script: ApiScript = {}) {
    this.server = createServer((request, response) => {
      try {
        this.handle(request, response);
      } catch (error: unknown) {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end(JSON.stringify(statusBody(500, String(error), "InternalError")));
      }
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.setScript(script);
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<number> {
    this.hostName = host;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, resolve);
    });
    return (this.server.address() as AddressInfo).port;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `http://${this.hostName}:${String(this.port)}`;
  }

  /** Stops answering: open requests and watches are cut, the port refuses connections afterwards. */
  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Replace the whole state (pods, nodes, token, faults); the request record stays. */
  setScript(script: ApiScript): void {
    this.pods.clear();
    this.nodes.clear();
    this.events.length = 0;
    this.defaultNamespace = script.namespace ?? "default";
    this.token = script.token;
    this.setFaults(script.faults ?? []);
    for (const pod of script.pods ?? []) {
      this.addPod(pod);
    }
    for (const node of script.nodes ?? []) {
      this.addNode(node);
    }
  }

  setFaults(faults: ApiFault[]): void {
    this.faults = faults;
    this.faultsLeft.clear();
    for (const fault of faults) {
      if (fault.times !== undefined) {
        this.faultsLeft.set(fault, fault.times);
      }
    }
  }

  reset(): void {
    this.requests.length = 0;
  }

  /** The server forgets its watch history up to now: a watch resumed from an older resourceVersion gets `410 Expired`. */
  compact(): void {
    this.minResourceVersion = this.resourceVersion;
    this.events.length = 0;
  }

  // ---- state mutation: a test moves the cluster between two asks -------------------------------

  /** Create the pod, or replace it (same namespace and name) — a watcher sees ADDED or MODIFIED. */
  addPod(seed: PodSeed): KubeObject {
    const namespace = seed.namespace ?? this.defaultNamespace;
    this.podCounter += 1;
    this.resourceVersion += 1;
    const pod: KubeObject = {
      kind: "Pod",
      apiVersion: "v1",
      metadata: {
        name: seed.name,
        namespace,
        uid: seed.uid ?? uuidFrom(`${namespace}/${seed.name}/${String(this.podCounter)}`),
        resourceVersion: String(this.resourceVersion),
        creationTimestamp: nowIso(),
        labels: seed.labels ?? {},
        annotations: seed.annotations ?? {},
        ...(seed.deleting === true ? { deletionTimestamp: nowIso() } : {}),
      },
      // an unscheduled pod has no nodeName key at all
      spec: {
        ...(seed.node === undefined || seed.node === "" ? {} : { nodeName: seed.node }),
        serviceAccountName: seed.serviceAccount ?? "default",
        restartPolicy: "Never",
      },
      status: {
        phase: seed.phase ?? "Running",
        ...(seed.podIP === undefined ? {} : { podIP: seed.podIP }),
        // a Pending pod that never became Ready reports no Ready condition (only PodScheduled), as on the real API
        conditions:
          (seed.phase ?? "Running") === "Pending" &&
          seed.ready === undefined &&
          seed.readyTransitionTime === undefined
            ? [
                {
                  type: "PodScheduled",
                  status: seed.node === undefined || seed.node === "" ? "False" : "True",
                  lastTransitionTime: nowIso(),
                },
              ]
            : [
                {
                  type: "Ready",
                  status:
                    seed.ready ?? ((seed.phase ?? "Running") === "Running" ? "True" : "False"),
                  lastTransitionTime: seed.readyTransitionTime ?? nowIso(),
                },
              ],
      },
    };
    const id = `${namespace}/${seed.name}`;
    const existed = this.pods.has(id);
    this.pods.set(id, pod);
    this.emit(existed ? "MODIFIED" : "ADDED", pod);
    return pod;
  }

  setPodPhase(name: string, phase: string, namespace = this.defaultNamespace): void {
    const pod = this.pods.get(`${namespace}/${name}`);
    if (pod === undefined) {
      throw new Error(`fake-apiserver: no pod ${namespace}/${name}`);
    }
    this.resourceVersion += 1;
    (pod.status as Record<string, unknown>).phase = phase;
    pod.metadata.resourceVersion = String(this.resourceVersion);
    this.emit("MODIFIED", pod);
  }

  /** Flip the pod's Ready condition; `lastTransitionTime` moves with it (now unless given). */
  setPodReady(
    name: string,
    ready: ReadyStatus,
    transitionTime?: string,
    namespace = this.defaultNamespace,
  ): void {
    const pod = this.pods.get(`${namespace}/${name}`);
    if (pod === undefined) {
      throw new Error(`fake-apiserver: no pod ${namespace}/${name}`);
    }
    this.resourceVersion += 1;
    const conditions = (pod.status as { conditions: Array<Record<string, unknown>> }).conditions;
    const entry = conditions.find((condition) => condition.type === "Ready");
    if (entry !== undefined) {
      entry.status = ready;
      entry.lastTransitionTime = transitionTime ?? nowIso();
    } else {
      conditions.push({
        type: "Ready",
        status: ready,
        lastTransitionTime: transitionTime ?? nowIso(),
      });
    }
    pod.metadata.resourceVersion = String(this.resourceVersion);
    this.emit("MODIFIED", pod);
  }

  removePod(name: string, namespace = this.defaultNamespace): void {
    const pod = this.pods.get(`${namespace}/${name}`);
    if (pod !== undefined) {
      this.pods.delete(`${namespace}/${name}`);
      this.resourceVersion += 1;
      pod.metadata.resourceVersion = String(this.resourceVersion);
      this.emit("DELETED", pod);
    }
  }

  addNode(seed: NodeSeed): void {
    const ready = seed.ready === undefined ? "True" : seed.ready;
    this.nodes.set(seed.name, {
      kind: "Node",
      apiVersion: "v1",
      metadata: {
        name: seed.name,
        uid: uuidFrom(`node/${seed.name}`),
        labels: seed.labels ?? {},
        resourceVersion: "1",
      },
      spec: seed.unschedulable === true ? { unschedulable: true } : {},
      status: {
        conditions:
          ready === null
            ? [{ type: "MemoryPressure", status: "False" }]
            : [
                {
                  type: "Ready",
                  status: ready,
                  reason:
                    ready === "True"
                      ? "KubeletReady"
                      : ready === "False"
                        ? "KubeletNotReady"
                        : "NodeStatusUnknown",
                  lastHeartbeatTime: nowIso(),
                  lastTransitionTime: seed.readyTransitionTime ?? nowIso(),
                },
              ],
      },
    });
  }

  setNodeReady(name: string, ready: ReadyStatus | null): void {
    this.addNode({ name, ready });
  }

  removeNode(name: string): void {
    this.nodes.delete(name);
  }

  requestsFor(pathPrefix: string): ApiRequestRecord[] {
    return this.requests.filter((entry) => entry.path.startsWith(pathPrefix));
  }

  // ---- serving ---------------------------------------------------------------------------------

  private emit(type: PodEvent["type"], pod: KubeObject): void {
    const snapshot = structuredClone(pod);
    this.events.push({ rv: this.resourceVersion, type, object: snapshot });
    for (const watcher of this.watchers) {
      if (this.watcherWants(watcher, snapshot)) {
        watcher.response.write(`${JSON.stringify({ type, object: snapshot })}\n`);
      }
    }
  }

  private watcherWants(watcher: Watcher, pod: KubeObject): boolean {
    if (watcher.namespace !== null && pod.metadata.namespace !== watcher.namespace) {
      return false;
    }
    const labels = (pod.metadata.labels ?? {}) as Record<string, string>;
    return (
      matchesLabelSelector(labels, watcher.labelSelector) &&
      matchesFieldSelector(pod, watcher.fieldSelector, POD_FIELDS)
    );
  }

  private nextFault(method: string, path: string): ApiFault | undefined {
    for (const fault of this.faults) {
      if (fault.path !== undefined && !path.startsWith(fault.path)) {
        continue;
      }
      if (fault.method !== undefined && fault.method !== method) {
        continue;
      }
      const left = this.faultsLeft.get(fault);
      if (left !== undefined) {
        if (left <= 0) {
          continue;
        }
        this.faultsLeft.set(fault, left - 1);
      }
      return fault;
    }
    return undefined;
  }

  private send(
    response: ServerResponse,
    record: ApiRequestRecord,
    status: number,
    body: unknown,
  ): void {
    record.status = status;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  private sendStatus(
    response: ServerResponse,
    record: ApiRequestRecord,
    code: number,
    message: string,
    details?: object,
  ): void {
    this.send(
      response,
      record,
      code,
      statusBody(code, message, REASONS[code] ?? "Failure", details),
    );
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://fake-apiserver.invalid");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
    }
    const record: ApiRequestRecord = {
      seq: this.requests.length + 1,
      atMs: Date.now() - this.startedAt,
      method,
      path: url.pathname,
      query: url.search.slice(1),
      headers,
      answer: "pending",
      status: null,
    };
    this.requests.push(record);
    request.resume();

    if (url.pathname.startsWith("/_kit/")) {
      this.handleControl(method, url.pathname, request, response, record);
      return;
    }
    const fault = this.nextFault(method, url.pathname);
    if (fault !== undefined && fault.mode !== "slow") {
      record.answer = `fault:${fault.mode}`;
      if (fault.mode === "reset") {
        request.socket.destroy();
      } else if (fault.mode === "status") {
        this.sendStatus(response, record, fault.status ?? 503, "scripted failure");
      } else if (fault.mode === "malformed") {
        this.send(response, record, 200, "<html>upstream gateway</html>");
      } else if (fault.mode === "notfound") {
        this.wrongNotFound(url.pathname, fault.variant ?? "text", response, record);
      }
      // hang: no answer, ever
      return;
    }
    if (fault?.mode === "slow") {
      record.answer = "fault:slow";
      setTimeout(() => this.route(method, url, response, record), fault.delayMs ?? 1000);
      return;
    }
    this.route(method, url, response, record);
  }

  private wrongNotFound(
    path: string,
    variant: NotFoundVariant,
    response: ServerResponse,
    record: ApiRequestRecord,
  ): void {
    const asked = /\/(pods|nodes)\/([^/]+)$/.exec(path);
    const kind = asked?.[1] ?? "pods";
    const name = asked?.[2] ?? "x";
    if (variant === "text") {
      record.status = 404;
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("404 page not found\n");
    } else if (variant === "empty") {
      record.status = 404;
      response.writeHead(404);
      response.end();
    } else if (variant === "other_reason") {
      this.send(
        response,
        record,
        404,
        statusBody(404, `${kind} "${name}" gone`, "Gone", { name, kind }),
      );
    } else if (variant === "other_name") {
      this.send(
        response,
        record,
        404,
        statusBody(404, `${kind} "other" not found`, "NotFound", { name: `${name}-other`, kind }),
      );
    } else {
      this.send(
        response,
        record,
        404,
        statusBody(404, `services "${name}" not found`, "NotFound", { name, kind: "services" }),
      );
    }
  }

  private route(
    method: string,
    url: URL,
    response: ServerResponse,
    record: ApiRequestRecord,
  ): void {
    if (this.token !== undefined && record.headers.authorization !== `Bearer ${this.token}`) {
      record.answer = "unauthorized";
      this.sendStatus(response, record, 401, "Unauthorized");
      return;
    }
    if (method !== "GET") {
      record.answer = "method_not_allowed";
      this.sendStatus(response, record, 405, `${method} is not supported by the fake`);
      return;
    }
    const path = url.pathname;
    const podOne = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)$/.exec(path);
    const podList = /^\/api\/v1\/(?:namespaces\/([^/]+)\/)?pods$/.exec(path);
    const nodeOne = /^\/api\/v1\/nodes\/([^/]+)$/.exec(path);
    try {
      if (podOne !== null) {
        const [, namespace = "", name = ""] = podOne;
        const pod = this.pods.get(`${namespace}/${name}`);
        if (pod === undefined) {
          record.answer = "pod_not_found";
          this.sendStatus(response, record, 404, `pods "${name}" not found`, {
            name,
            kind: "pods",
          });
        } else {
          record.answer = "pod";
          this.send(response, record, 200, pod);
        }
        return;
      }
      if (nodeOne !== null) {
        const name = nodeOne[1] ?? "";
        const node = this.nodes.get(name);
        if (node === undefined) {
          record.answer = "node_not_found";
          this.sendStatus(response, record, 404, `nodes "${name}" not found`, {
            name,
            kind: "nodes",
          });
        } else {
          record.answer = "node";
          this.send(response, record, 200, node);
        }
        return;
      }
      if (podList !== null) {
        this.listOrWatchPods(podList[1] ?? null, url, response, record);
        return;
      }
      if (path === "/api/v1/nodes") {
        const labelSelector = url.searchParams.get("labelSelector") ?? "";
        const fieldSelector = url.searchParams.get("fieldSelector") ?? "";
        const items = [...this.nodes.values()].filter(
          (node) =>
            matchesLabelSelector(
              (node.metadata.labels ?? {}) as Record<string, string>,
              labelSelector,
            ) && matchesFieldSelector(node, fieldSelector, NODE_FIELDS),
        );
        record.answer = "node_list";
        this.send(response, record, 200, this.list("NodeList", items));
        return;
      }
    } catch (error: unknown) {
      if (error instanceof SelectorError) {
        record.answer = "bad_selector";
        this.sendStatus(response, record, 400, error.message);
        return;
      }
      throw error;
    }
    record.answer = "not_found";
    this.sendStatus(response, record, 404, "the server could not find the requested resource");
  }

  private list(kind: string, items: KubeObject[]): object {
    return {
      kind,
      apiVersion: "v1",
      metadata: { resourceVersion: String(this.resourceVersion) },
      // the real list's items carry no kind / apiVersion of their own
      items: items.map((item) => {
        const { kind: _kind, apiVersion: _apiVersion, ...rest } = item;
        return rest;
      }),
    };
  }

  private listOrWatchPods(
    namespace: string | null,
    url: URL,
    response: ServerResponse,
    record: ApiRequestRecord,
  ): void {
    const labelSelector = url.searchParams.get("labelSelector") ?? "";
    const fieldSelector = url.searchParams.get("fieldSelector") ?? "";
    const watcher: Watcher = { namespace, labelSelector, fieldSelector, response };
    const matching = [...this.pods.values()].filter((pod) => this.watcherWants(watcher, pod));
    const watch = ["true", "1"].includes(url.searchParams.get("watch") ?? "");
    if (!watch) {
      record.answer = "pod_list";
      this.send(response, record, 200, this.list("PodList", matching));
      return;
    }
    record.answer = "watch";
    record.status = 200;
    response.writeHead(200, { "content-type": "application/json", "transfer-encoding": "chunked" });
    response.flushHeaders();
    const since = Number(url.searchParams.get("resourceVersion") ?? "0");
    if (Number.isFinite(since) && since > 0 && since < this.minResourceVersion) {
      // as the real API, for a resourceVersion older than what it still holds: an ERROR event, 410 Expired
      response.write(
        `${JSON.stringify({
          type: "ERROR",
          object: statusBody(
            410,
            `too old resource version: ${String(since)} (${String(this.minResourceVersion)})`,
            "Expired",
          ),
        })}\n`,
      );
      response.end();
      return;
    }
    if (!Number.isFinite(since) || since <= 0) {
      for (const pod of matching) {
        response.write(`${JSON.stringify({ type: "ADDED", object: pod })}\n`);
      }
    } else {
      for (const event of this.events) {
        if (event.rv > since && this.watcherWants(watcher, event.object)) {
          response.write(`${JSON.stringify({ type: event.type, object: event.object })}\n`);
        }
      }
    }
    this.watchers.add(watcher);
    const timeoutSeconds = Number(url.searchParams.get("timeoutSeconds") ?? "0");
    const timer =
      timeoutSeconds > 0 ? setTimeout(() => response.end(), timeoutSeconds * 1000) : undefined;
    response.once("close", () => {
      this.watchers.delete(watcher);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    });
  }

  private handleControl(
    method: string,
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
    record: ApiRequestRecord,
  ): void {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      record.answer = "kit";
      if (method === "GET" && path === "/_kit/record") {
        this.send(response, record, 200, {
          requests: this.requests.filter((entry) => !entry.path.startsWith("/_kit/")),
        });
      } else if (method === "POST" && path === "/_kit/script") {
        this.setScript(JSON.parse(text) as ApiScript);
        this.send(response, record, 200, { ok: true });
      } else if (method === "POST" && path === "/_kit/op") {
        this.applyOp(JSON.parse(text) as KitOp);
        this.send(response, record, 200, { ok: true });
      } else if (method === "POST" && path === "/_kit/reset") {
        this.reset();
        this.send(response, record, 200, { ok: true });
      } else {
        this.sendStatus(response, record, 404, "not a kit route");
      }
    });
  }

  private applyOp(op: KitOp): void {
    switch (op.op) {
      case "addPod":
        this.addPod(op.pod);
        break;
      case "removePod":
        this.removePod(op.name, op.namespace);
        break;
      case "setPodPhase":
        this.setPodPhase(op.name, op.phase, op.namespace);
        break;
      case "setPodReady":
        this.setPodReady(op.name, op.ready, op.transitionTime, op.namespace);
        break;
      case "addNode":
        this.addNode(op.node);
        break;
      case "removeNode":
        this.removeNode(op.name);
        break;
      case "setNodeReady":
        this.setNodeReady(op.name, op.ready);
        break;
      case "setFaults":
        this.setFaults(op.faults);
        break;
      case "compact":
        this.compact();
        break;
    }
  }
}

/** The state moves a process-run fake accepts at `POST /_kit/op`. */
export type KitOp =
  | { op: "addPod"; pod: PodSeed }
  | { op: "removePod"; name: string; namespace?: string }
  | { op: "setPodPhase"; name: string; phase: string; namespace?: string }
  | {
      op: "setPodReady";
      name: string;
      ready: ReadyStatus;
      transitionTime?: string;
      namespace?: string;
    }
  | { op: "addNode"; node: NodeSeed }
  | { op: "removeNode"; name: string }
  | { op: "setNodeReady"; name: string; ready: ReadyStatus | null }
  | { op: "setFaults"; faults: ApiFault[] }
  | { op: "compact" };

export async function startFakeApiServer(
  script: ApiScript = {},
  options: { port?: number; host?: string } = {},
): Promise<FakeApiServer> {
  const api = new FakeApiServer(script);
  await api.listen(options.port ?? 0, options.host ?? "127.0.0.1");
  return api;
}

function parseArgs(argv: string[]): { port: number; host: string; script: ApiScript } {
  let port = 0;
  let host = "127.0.0.1";
  let script: ApiScript = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--port" && value !== undefined) {
      port = Number(value);
      index += 1;
    } else if (arg === "--host" && value !== undefined) {
      host = value;
      index += 1;
    } else if (arg === "--script" && value !== undefined) {
      const text = value.trimStart().startsWith("{") ? value : readFileSync(value, "utf8");
      script = JSON.parse(text) as ApiScript;
      index += 1;
    } else {
      throw new Error(`fake-apiserver: unknown argument ${arg ?? "<none>"}`);
    }
  }
  return { port, host, script };
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  const { port, host, script } = parseArgs(process.argv.slice(2));
  const api = await startFakeApiServer(script, { port, host });
  process.stdout.write(
    `${JSON.stringify({ fake: "kube-api", host, port: api.port, id: randomUUID() })}\n`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void api.close().finally(() => process.exit(0));
    });
  }
}
