import { readFileSync } from "node:fs";
import {
  parseNamespaceFromResolvConf,
  SERVICE_ACCOUNT_NAMESPACE_FILE,
} from "../../acp/auth-env.js";

/**
 * Delivering the ⟦SEAT-ACTIVATION⟧ notice to the successor (brick c85c42bf, HOD-R46 (b)).
 *
 * 🛑 THE PUBLIC acpx-ui BASE URL IS NOT THE ORIGIN HERE, whatever the brick's Fix paragraph
 * says: that host is mTLS-protected, so an in-cluster POST to it is refused before it reaches
 * the route. The same-box CLUSTER-INTERNAL service is — the one the `acpx` skill's
 * `send-message.sh` maps to, and every session `activate` can name lives on this box's store,
 * so this box's acpx-ui is always the right one.
 *
 * Origin ladder (first hit wins):
 *   1. `ACPX_UI_INTERNAL_URL`, when SET — authoritative even when EMPTY (empty = "no origin",
 *      which is how a row asks for the no-base-URL arm without falling through to the box).
 *      The suite bootstrap (`test/box-env-scrub.ts`) points it at a dead port so no test can
 *      reach the box's real acpx-ui by accident.
 *   2. `http://dev-server.<this box's namespace>.svc.cluster.local:3456`.
 *   3. nothing.
 */
export const NOTICE_DELIVERY_TIMEOUT_MS = 10_000;
const INTERNAL_ACPX_UI_PORT = 3456;
const INTERNAL_ACPX_UI_SERVICE = "dev-server";
const FALLBACK_FROM = "acpx:sessions-activate";

export type ActivationNoticeDelivery =
  | { delivered: true; deliveryId?: string }
  | { delivered: false; reason: string };

export function resolveNoticeDeliveryOrigin(
  env: NodeJS.ProcessEnv,
  sources: { namespaceFile?: string; resolvConf?: string },
): string | undefined {
  if (env.ACPX_UI_INTERNAL_URL !== undefined) {
    const explicit = env.ACPX_UI_INTERNAL_URL.trim().replace(/\/+$/, "");
    return explicit.length > 0 ? explicit : undefined;
  }
  const fromFile = sources.namespaceFile?.trim();
  const namespace =
    fromFile && fromFile.length > 0
      ? fromFile
      : sources.resolvConf
        ? parseNamespaceFromResolvConf(sources.resolvConf)
        : undefined;
  return namespace
    ? `http://${INTERNAL_ACPX_UI_SERVICE}.${namespace}.svc.cluster.local:${INTERNAL_ACPX_UI_PORT}`
    : undefined;
}

function readOrUndefined(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** The activator's own session id (`?session=<id>` of `ACPX_SESSION_URL`), else the verb's tag. */
export function noticeSender(env: NodeJS.ProcessEnv): string {
  const raw = env.ACPX_SESSION_URL?.trim();
  if (!raw) {
    return FALLBACK_FROM;
  }
  try {
    return new URL(raw).searchParams.get("session") || FALLBACK_FROM;
  } catch {
    return FALLBACK_FROM;
  }
}

function deliveryIdFrom(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { delivery_id?: unknown; deliveryId?: unknown };
    const id = parsed.delivery_id ?? parsed.deliveryId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** undici wraps the socket error: `fetch failed` is the message, `ECONNREFUSED` the cause. */
function unreachableDetail(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
  return `${error.message}${cause}`;
}

function failureReason(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `timed out after ${timeoutMs / 1000}s waiting for acpx-ui`;
  }
  return `acpx-ui unreachable: ${unreachableDetail(error)}`;
}

async function postNotice(
  origin: string,
  params: { successorId: string; notice: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ActivationNoticeDelivery> {
  const { env } = params;
  const response = await fetch(
    `${origin}/api/sessions/${encodeURIComponent(params.successorId)}/message`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.ACPX_SESSION_URL ? { "x-source-session": env.ACPX_SESSION_URL } : {}),
      },
      body: JSON.stringify({ text: params.notice, from: noticeSender(env) }),
      signal: AbortSignal.timeout(params.timeoutMs),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    return {
      delivered: false,
      reason: `acpx-ui answered HTTP ${response.status}: ${body.slice(0, 200)}`,
    };
  }
  const deliveryId = deliveryIdFrom(body);
  return deliveryId ? { delivered: true, deliveryId } : { delivered: true };
}

/** Never throws: every failure is a `{delivered:false, reason}` the caller prints. */
export async function deliverActivationNotice(params: {
  successorId: string;
  notice: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<ActivationNoticeDelivery> {
  const env = params.env ?? process.env;
  const timeoutMs = params.timeoutMs ?? NOTICE_DELIVERY_TIMEOUT_MS;
  const origin = resolveNoticeDeliveryOrigin(env, {
    namespaceFile: readOrUndefined(SERVICE_ACCOUNT_NAMESPACE_FILE),
    resolvConf: readOrUndefined("/etc/resolv.conf"),
  });
  if (!origin) {
    return { delivered: false, reason: "no acpx-ui base URL resolved for this box" };
  }
  try {
    return await postNotice(origin, {
      successorId: params.successorId,
      notice: params.notice,
      env,
      timeoutMs,
    });
  } catch (error) {
    return { delivered: false, reason: failureReason(error, timeoutMs) };
  }
}
