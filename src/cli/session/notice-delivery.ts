import {
  readAcpxUiInternalOriginSources,
  resolveAcpxUiInternalOrigin,
} from "../../acp/acpx-ui-internal-origin.js";

/**
 * Delivering the ⟦SEAT-ACTIVATION⟧ notice to the successor (brick c85c42bf, HOD-R46 (b)).
 *
 * 🛑 THE PUBLIC acpx-ui BASE URL IS NOT THE ORIGIN HERE, whatever the brick's Fix paragraph
 * says: that host is mTLS-protected, so an in-cluster POST to it is refused before it reaches
 * the route. The same-box CLUSTER-INTERNAL service is — the one the `acpx` skill's
 * `send-message.sh` maps to, and every session `activate` can name lives on this box's store,
 * so this box's acpx-ui is always the right one.
 *
 * The origin ladder lives in `src/acp/acpx-ui-internal-origin.ts`, shared with the Codex
 * quota admission (brick cfcfa0de). Here, its "nothing" rung means no delivery.
 */
export const NOTICE_DELIVERY_TIMEOUT_MS = 10_000;
const FALLBACK_FROM = "acpx:sessions-activate";

export type ActivationNoticeDelivery =
  | { delivered: true; deliveryId?: string }
  | { delivered: false; reason: string };

export const resolveNoticeDeliveryOrigin = resolveAcpxUiInternalOrigin;

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
  const origin = resolveNoticeDeliveryOrigin(env, readAcpxUiInternalOriginSources());
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
