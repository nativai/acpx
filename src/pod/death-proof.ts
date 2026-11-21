import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { readServiceAccountFile, serviceAccountDir, type PodRef } from "./identity.js";

/**
 * C3.3 — the death proof: ONE function, three answers, asked of the Kubernetes API server directly
 * (never the broker). brick 8d85cb47. Exported to the atrium server through `pod-lock.ts`, which
 * keeps no second implementation, so this file IS the rule for both repos.
 *
 *   gone    — no pod with that uid AND its node is Ready or no longer exists; or the pod is terminal
 *   exists  — a pod with that uid exists and is not terminal
 *   unknown — no answer, any unexpected answer, or the pod is gone but its node is not Ready
 *
 * `unknown` is ALIVE everywhere. It never throws. Asked ON THE CONTROL POD ONLY (C3.3 A-4): an agent
 * pod never asks the API about a lock holder — the lock primitive enforces that, not this function. The exact requests and the decision table are
 * published for the fake API server (lane X1): reports/DEATH-PROOF-QUERIES.md on brick 8d85cb47 —
 * change a request here and that file in the same breath.
 *
 * ⚠️ A POD IS LOOKED UP BY NAME, NOT BY UID: the API cannot select on `metadata.uid` (`400 field
 * label not supported`, measured on devbox 2026-11-21). A uid is bound to one object, and an object
 * never changes its name, so "no pod with that name" or "the pod of that name has another uid" both
 * mean "no pod with that uid".
 * ⚠️ DO NOT TREAT A POD THAT IS GONE AS DEAD WITHOUT THE NODE CHECK. A force-deleted pod on a
 * partitioned (NotReady) node can still be running its processes — that is C3.3's `unknown` row.
 */

export type DeathProof = "gone" | "exists" | "unknown";

/** The whole proof (both requests) ends by this deadline; a caller may only lower it. */
export const DEATH_PROOF_TIMEOUT_MS = 3_000;
/** Test seam: base URL of a (fake) API server; honoured ONLY under `NODE_TEST_CONTEXT`. */
export const POD_API_URL_ENV = "ACPX_POD_API_URL";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TERMINAL_PHASES = new Set(["Succeeded", "Failed"]);

export type ApiConfig = { base: URL; token: string; ca?: Buffer; namespace?: string };
export type ApiAnswer = { status: number; body: unknown } | undefined;

function testApiBase(env: NodeJS.ProcessEnv): URL | undefined {
  const override = env[POD_API_URL_ENV]?.trim();
  return env.NODE_TEST_CONTEXT && override ? new URL(override) : undefined;
}

function inClusterApiBase(env: NodeJS.ProcessEnv): URL | undefined {
  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  const port = env.KUBERNETES_SERVICE_PORT?.trim();
  if (!host || !port) {
    return undefined;
  }
  return new URL(`https://${host.includes(":") ? `[${host}]` : host}:${port}`);
}

function apiBase(env: NodeJS.ProcessEnv): URL | undefined {
  return testApiBase(env) ?? inClusterApiBase(env);
}

function readCa(env: NodeJS.ProcessEnv): Buffer | undefined {
  try {
    return readFileSync(path.join(serviceAccountDir(env), "ca.crt"));
  } catch {
    return undefined;
  }
}

/** The in-cluster API (or the test seam) from `env`: base URL, token, CA, namespace. Shared with A6. */
export function apiConfig(env: NodeJS.ProcessEnv): ApiConfig | undefined {
  let base: URL | undefined;
  try {
    base = apiBase(env);
  } catch {
    return undefined;
  }
  const token = readServiceAccountFile("token", env);
  if (!base || !token) {
    return undefined;
  }
  return { base, token, ca: readCa(env), namespace: readServiceAccountFile("namespace", env) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One GET; undefined on ANY transport failure (refused, reset, TLS, abort, oversized body).
 * Exported so `src/pod/agent-pod-lookup.ts` (A6) uses THIS client, not a copy; `maxBytes` defaults to
 * 1 MiB (a pod or node), a pod LIST asks for more. `apiPath` may carry a query string.
 */
export function apiGet(
  config: ApiConfig,
  apiPath: string,
  signal: AbortSignal,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<ApiAnswer> {
  const url = new URL(apiPath, config.base);
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const request = transport.request(
      url,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" },
        ...(url.protocol === "https:" && config.ca ? { ca: config.ca } : {}),
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy();
            resolve(undefined);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode ?? 0, body: parseJson(text) });
        });
        response.on("error", () => resolve(undefined));
      },
    );
    request.on("error", () => resolve(undefined));
    request.end();
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function answerBody(answer: ApiAnswer): Record<string, unknown> | undefined {
  return answer?.status === 200 ? record(answer.body) : undefined;
}

/**
 * A 404 that IS the API server's "no such object": `kind: Status`, `reason: NotFound`, and `details`
 * naming exactly the object asked (measured shape, pods and nodes, devbox 2026-11-21). ⚠️ DO NOT
 * RELAX THIS TO `status === 404`: a proxy, a wrong base path or any non-Kubernetes listener answers
 * 404 to every path, and that would prove every holder `gone` (test-engineer F1). Anything else is
 * `unknown`. `test/pod-death-proof.test.ts` "F1" rows pin it.
 */
function isNotFound(answer: ApiAnswer, kind: "pods" | "nodes", name: string): boolean {
  const body = answer?.status === 404 ? record(answer.body) : undefined;
  return isStatusNotFound(body) && namesObject(record(body?.details), kind, name);
}

function isStatusNotFound(body: Record<string, unknown> | undefined): boolean {
  return body?.kind === "Status" && body.reason === "NotFound";
}

function namesObject(details: Record<string, unknown> | undefined, kind: string, name: string) {
  return details?.kind === kind && details.name === name;
}

/** Step 1's verdict; `absent` = no pod with that uid, so the node decides; `terminal` = gone. */
function judgePod(answer: ApiAnswer, pod: PodRef): "exists" | "unknown" | "terminal" | "absent" {
  if (isNotFound(answer, "pods", pod.name)) {
    return "absent";
  }
  const found = answerBody(answer);
  const foundUid = fieldOf(found, "metadata", "uid");
  if (typeof foundUid !== "string") {
    return "unknown";
  }
  return foundUid === pod.uid ? judgePhase(fieldOf(found, "status", "phase")) : "absent";
}

function fieldOf(
  object: Record<string, unknown> | undefined,
  outer: string,
  inner: string,
): unknown {
  return record(object?.[outer])?.[inner];
}

function judgePhase(phase: unknown): "terminal" | "exists" {
  return typeof phase === "string" && TERMINAL_PHASES.has(phase) ? "terminal" : "exists";
}

function readyStatus(node: Record<string, unknown> | undefined): unknown {
  const conditions = record(node?.status)?.conditions;
  if (!Array.isArray(conditions)) {
    return undefined;
  }
  return conditions.map(record).find((condition) => condition?.type === "Ready")?.status;
}

/** Step 2's verdict: the holder's node Ready or gone ⇒ `gone`; anything else ⇒ `unknown`. */
function judgeNode(answer: ApiAnswer, node: string): DeathProof {
  if (isNotFound(answer, "nodes", node)) {
    return "gone";
  }
  return readyStatus(answerBody(answer)) === "True" ? "gone" : "unknown";
}

export type DeathProofOptions = { timeoutMs?: number; env?: NodeJS.ProcessEnv };

/** A JS caller (the atrium server) may hand in anything: a ref without name or uid proves nothing. */
function isNamedPod(pod: PodRef): boolean {
  return (
    typeof pod?.name === "string" &&
    pod.name !== "" &&
    typeof pod.uid === "string" &&
    pod.uid !== ""
  );
}

function proofDeadline(options: DeathProofOptions): AbortSignal {
  const timeoutMs = Math.min(DEATH_PROOF_TIMEOUT_MS, options.timeoutMs ?? DEATH_PROOF_TIMEOUT_MS);
  return AbortSignal.timeout(Math.max(0, timeoutMs));
}

function podPath(namespace: string, name: string): string {
  return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(name)}`;
}

/** The proof with its reason — what a break line records (C3.2 A-4: `pod-gone` | `pod-terminal`). */
export type DeathProofDetail =
  | { answer: "gone"; proof: "pod-gone" | "pod-terminal" }
  | { answer: "exists" | "unknown" };

/** C3.3. Configured from the process's in-cluster service account; at most two GETs. */
export async function proveDeath(
  pod: PodRef,
  options: DeathProofOptions = {},
): Promise<DeathProof> {
  return (await proveDeathDetailed(pod, options)).answer;
}

/** `proveDeath`, saying which branch of C3.3 proved a death. */
export async function proveDeathDetailed(
  pod: PodRef,
  options: DeathProofOptions = {},
): Promise<DeathProofDetail> {
  const config = apiConfig(options.env ?? process.env);
  const namespace = config && isNamedPod(pod) ? (pod.namespace ?? config.namespace) : undefined;
  if (!config || !namespace) {
    return { answer: "unknown" };
  }
  return await askApi(config, namespace, pod, proofDeadline(options));
}

async function askApi(
  config: ApiConfig,
  namespace: string,
  pod: PodRef,
  signal: AbortSignal,
): Promise<DeathProofDetail> {
  const podVerdict = judgePod(await apiGet(config, podPath(namespace, pod.name), signal), pod);
  if (podVerdict === "terminal") {
    return { answer: "gone", proof: "pod-terminal" };
  }
  if (podVerdict !== "absent") {
    return { answer: podVerdict };
  }
  if (!pod.node) {
    return { answer: "unknown" };
  }
  const nodePath = `/api/v1/nodes/${encodeURIComponent(pod.node)}`;
  const node = judgeNode(await apiGet(config, nodePath, signal), pod.node);
  return node === "gone" ? { answer: "gone", proof: "pod-gone" } : { answer: node };
}
