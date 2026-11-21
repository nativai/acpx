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
 * `unknown` is ALIVE everywhere. It never throws. The exact requests and the decision table are
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

type ApiConfig = { base: URL; token: string; ca?: Buffer; namespace?: string };
type ApiAnswer = { status: number; body: unknown } | undefined;

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

function apiConfig(env: NodeJS.ProcessEnv): ApiConfig | undefined {
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

/** One GET; undefined on ANY transport failure (refused, reset, TLS, abort, oversized body). */
function apiGet(config: ApiConfig, apiPath: string, signal: AbortSignal): Promise<ApiAnswer> {
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
          if (size > MAX_RESPONSE_BYTES) {
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

/** Step 1's verdict; `absent` = no pod with that uid, so the node decides. */
function judgePod(answer: ApiAnswer, uid: string): DeathProof | "absent" {
  if (answer?.status === 404) {
    return "absent";
  }
  const pod = answerBody(answer);
  const podUid = fieldOf(pod, "metadata", "uid");
  if (typeof podUid !== "string") {
    return "unknown";
  }
  return podUid === uid ? judgePhase(fieldOf(pod, "status", "phase")) : "absent";
}

function fieldOf(
  object: Record<string, unknown> | undefined,
  outer: string,
  inner: string,
): unknown {
  return record(object?.[outer])?.[inner];
}

function judgePhase(phase: unknown): DeathProof {
  return typeof phase === "string" && TERMINAL_PHASES.has(phase) ? "gone" : "exists";
}

function readyStatus(node: Record<string, unknown> | undefined): unknown {
  const conditions = record(node?.status)?.conditions;
  if (!Array.isArray(conditions)) {
    return undefined;
  }
  return conditions.map(record).find((condition) => condition?.type === "Ready")?.status;
}

/** Step 2's verdict: the holder's node Ready or gone ⇒ `gone`; anything else ⇒ `unknown`. */
function judgeNode(answer: ApiAnswer): DeathProof {
  if (answer?.status === 404) {
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

/** C3.3. Configured from the process's in-cluster service account; at most two GETs. */
export async function proveDeath(
  pod: PodRef,
  options: DeathProofOptions = {},
): Promise<DeathProof> {
  const config = apiConfig(options.env ?? process.env);
  const namespace = config && isNamedPod(pod) ? (pod.namespace ?? config.namespace) : undefined;
  if (!config || !namespace) {
    return "unknown";
  }
  return await askApi(config, namespace, pod, proofDeadline(options));
}

async function askApi(
  config: ApiConfig,
  namespace: string,
  pod: PodRef,
  signal: AbortSignal,
): Promise<DeathProof> {
  const podVerdict = judgePod(await apiGet(config, podPath(namespace, pod.name), signal), pod.uid);
  if (podVerdict !== "absent") {
    return podVerdict;
  }
  if (!pod.node) {
    return "unknown";
  }
  const nodePath = `/api/v1/nodes/${encodeURIComponent(pod.node)}`;
  return judgeNode(await apiGet(config, nodePath, signal));
}
