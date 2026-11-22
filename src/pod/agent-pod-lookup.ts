import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { POD_API_URL_ENV } from "./death-proof.js";
import { readServiceAccountFile, serviceAccountDir } from "./identity.js";
import type { AgentPodLookup } from "./routed-call.js";

/**
 * The session's agent pod, by key, from the Kubernetes API server (C3.3's source, C4's "asked only
 * when the API server shows no pod for the key"). One answer per call:
 *
 *   exists{ uid, ready, readyAtMs?, ip? }  a non-terminal pod of the key; `ready` = Running, the Ready
 *                                          condition True and not being deleted. `readyAtMs` is that
 *                                          condition's `lastTransitionTime` as the API server reports
 *                                          it (C2 amendment A-1); `ip` is `status.podIP`.
 *   absent                                 no non-terminal pod of the key
 *   unknown                                the API server did not answer, or answered something else
 *
 * ⚠️ ONE REMAINING DUPLICATE. The seam variable (`POD_API_URL_ENV`), the service-account directory and
 * its files come from A5's `death-proof.ts` / `identity.ts`. Its HTTP GET (`apiGet` / `apiConfig`) is
 * private there, so a small copy stays here until A5 exports it — then delete `apiGet` below and call
 * theirs: do not keep two clients.
 *
 * The pods are listed by the label `workbench.nativai.de/session-key=<key>` (C4): the Job's pod
 * name has a generated suffix, so the name cannot be derived from the key.
 */

const API_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TERMINAL_PHASES = new Set(["Succeeded", "Failed"]);

type ApiConfig = { base: URL; token: string; ca?: Buffer; namespace: string };

function ipHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function apiBase(env: NodeJS.ProcessEnv): URL | undefined {
  const override = env.NODE_TEST_CONTEXT ? env[POD_API_URL_ENV]?.trim() : undefined;
  if (override) {
    return new URL(override);
  }
  const host = env.KUBERNETES_SERVICE_HOST?.trim();
  const port = env.KUBERNETES_SERVICE_PORT?.trim();
  return host && port ? new URL(`https://${ipHost(host)}:${port}`) : undefined;
}

function apiConfig(env: NodeJS.ProcessEnv): ApiConfig | undefined {
  let base: URL | undefined;
  try {
    base = apiBase(env);
  } catch {
    return undefined;
  }
  const token = readServiceAccountFile("token", env);
  const namespace = readServiceAccountFile("namespace", env);
  if (!base || !token || !namespace) {
    return undefined;
  }
  let ca: Buffer | undefined;
  try {
    ca = readFileSync(path.join(serviceAccountDir(env), "ca.crt"));
  } catch {
    ca = undefined;
  }
  return { base, token, ca, namespace };
}

function apiGet(
  config: ApiConfig,
  pathAndQuery: string,
): Promise<{ status: number; body: unknown } | undefined> {
  return new Promise((resolve) => {
    const url = new URL(pathAndQuery, config.base);
    const client = url.protocol === "https:" ? https : http;
    const request = client.request(
      url,
      {
        method: "GET",
        headers: { authorization: `Bearer ${config.token}`, accept: "application/json" },
        ...(url.protocol === "https:" && config.ca ? { ca: config.ca } : {}),
        timeout: API_TIMEOUT_MS,
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
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            });
          } catch {
            resolve(undefined);
          }
        });
        response.on("error", () => resolve(undefined));
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(undefined);
    });
    request.on("error", () => resolve(undefined));
    request.end();
  });
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : undefined;

type PodFacts = {
  uid: string;
  ready: boolean;
  readyAtMs: number | undefined;
  ip: string | undefined;
  /** `runtime.nativai.de/releases`, parsed; undefined when absent or unreadable (A-43 (b)). */
  releases: Record<string, string> | undefined;
};

export const RELEASES_ANNOTATION = "runtime.nativai.de/releases";

/** The pod's releases annotation as `{tool: release}`; undefined for a missing, unparseable or non-string-valued one. */
function releasesOf(pod: Obj): Record<string, string> | undefined {
  const raw = obj(obj(pod.metadata)?.annotations)?.[RELEASES_ANNOTATION];
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    const parsed = obj(JSON.parse(raw));
    const entries = parsed ? Object.entries(parsed) : [];
    return parsed && entries.every(([, value]) => typeof value === "string")
      ? (parsed as Record<string, string>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readyCondition(status: Obj | undefined): Obj | undefined {
  const conditions = Array.isArray(status?.conditions) ? (status.conditions as unknown[]) : [];
  return conditions.map(obj).find((condition) => condition?.type === "Ready");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `Ready=True` on a Running pod that is not being deleted. */
function isReady(pod: Obj, status: Obj | undefined): boolean {
  const deleting = obj(pod.metadata)?.deletionTimestamp !== undefined;
  return status?.phase === "Running" && readyCondition(status)?.status === "True" && !deleting;
}

/** The Ready condition's `lastTransitionTime` in epoch ms, when it parses. */
function readyAt(status: Obj | undefined): number | undefined {
  const parsed = Date.parse(str(readyCondition(status)?.lastTransitionTime) ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isTerminal(status: Obj | undefined): boolean {
  return TERMINAL_PHASES.has(String(status?.phase));
}

function uidOf(pod: Obj | undefined): string | undefined {
  return str(obj(pod?.metadata)?.uid);
}

/** One pod object → its facts, or undefined for a terminal pod or one that is not a pod object. */
export function podFacts(item: unknown): PodFacts | undefined {
  const pod = obj(item);
  const status = obj(pod?.status);
  const uid = uidOf(pod);
  if (!pod || uid === undefined || isTerminal(status)) {
    return undefined;
  }
  const ready = isReady(pod, status);
  return {
    uid,
    ready,
    readyAtMs: ready ? readyAt(status) : undefined,
    ip: str(status?.podIP),
    releases: releasesOf(pod),
  };
}

/** Several non-terminal pods of one key (a terminating one beside its successor): a Ready one wins. */
export function choosePod(items: unknown[]): PodFacts | undefined {
  const facts = items.map(podFacts).filter((fact): fact is PodFacts => fact !== undefined);
  return facts.find((fact) => fact.ready) ?? facts[0];
}

const KEY_RE = /^([0-9a-f]{24}|util-pool|util-home)$/;

type LookupAnswer = Awaited<ReturnType<AgentPodLookup>>;

function answerOf(items: unknown[]): LookupAnswer {
  const chosen = choosePod(items);
  if (!chosen) {
    return { state: "absent" };
  }
  const { releases, ...rest } = chosen;
  return { state: "exists", ...rest, ...(releases ? { releases } : {}) };
}

/**
 * ⚠️ ANY failure is `unknown`, NEVER `absent` (C3.3; stream HoD): an API outage must not send a
 * prompt to the broker as if the pod were gone. Only a 200 whose `items` is a list can say `absent`.
 */
export function createAgentPodLookup(env: NodeJS.ProcessEnv = process.env): AgentPodLookup {
  return async (key) => {
    const config = apiConfig(env);
    if (!config || !KEY_RE.test(key)) {
      return { state: "unknown" };
    }
    const selector = encodeURIComponent(`workbench.nativai.de/session-key=${key}`);
    const answer = await apiGet(
      config,
      `/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods?labelSelector=${selector}`,
    );
    const items = obj(answer?.body)?.items;
    return answer?.status === 200 && Array.isArray(items) ? answerOf(items) : { state: "unknown" };
  };
}
