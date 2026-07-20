import { normalizeOutputError } from "../acp/error-normalization.js";
import { buildJsonRpcErrorResponse } from "../acp/jsonrpc-error.js";
import { classifyFailover } from "../runtime/engine/failover.js";
import type {
  AcpJsonRpcMessage,
  SessionMessage,
  SessionRecord,
  SessionTerminalError,
} from "../types.js";
import { SessionEventWriter } from "./events.js";
import { isoNow, writeSessionRecordAtBoundary } from "./persistence.js";

// Persist a terminal turn error to the session's `.stream.ndjson` as a top-level
// JSON-RPC error response. acpx-ui derives `ApiSession.lastError` from the stream
// tail (server/streamTail.ts): a line with no `method` and an `error` object is
// classified as the turn-end error, with `code = error.data.detailCode` and
// `message = error.message`. The CLI ALSO emits this same error on stdout (the
// json-formatter's `onError`), but stdout is not what acpx-ui reads — so an
// acpx-synthesized terminal error (e.g. AllSubscriptionsExhaustedError, which is
// never an ACP message and so never reaches the stream via the onAcpMessage tap)
// must be written to the stream explicitly, or its `detailCode` never reaches the
// UI and the "all subscriptions exhausted" banner (keyed on
// lastError.code === 'all-subscriptions-exhausted') never renders.
//
// The line is built with the SAME builder + normalization the CLI stdout path
// uses (buildJsonRpcErrorResponse over normalizeOutputError), so the persisted
// shape is byte-identical to the stdout one — `error.data.detailCode` carries the
// cross-repo contract string. Best-effort: a failure to persist must not mask the
// original turn error, which still propagates on the CLI output layer.
export async function persistTerminalTurnError(
  record: SessionRecord,
  error: unknown,
): Promise<void> {
  const normalized = normalizeOutputError(error, { origin: "runtime" });
  const message: AcpJsonRpcMessage = buildJsonRpcErrorResponse({
    outputCode: normalized.code,
    detailCode: normalized.detailCode,
    origin: normalized.origin,
    message: normalized.message,
    retryable: normalized.retryable,
    acp: normalized.acp,
    effectiveAccount: normalized.effectiveAccount,
    sessionId: record.acpxRecordId,
    timestamp: isoNow(),
  }) as AcpJsonRpcMessage;

  const writer = await SessionEventWriter.open(record);
  try {
    await writer.appendMessage(message, { checkpoint: false });
  } finally {
    await writer.close({ checkpoint: false });
  }
}

// Resolve the machine-readable `detailCode` for a terminal turn error. Prefer the
// normalized cross-repo detailCode — the acpx-synthesized classes (exhaustion →
// `all-subscriptions-exhausted`, auth-gated → `auth-gated`) carry it, and it's the
// exact string acpx-ui keys its banners on. When normalization yields NONE — the
// case for a RAW adapter error that only carries `data.errorKind` and no top-level
// `detailCode` (a single-sub turn-ending rate_limit is the canonical example) —
// fall back to the failover classifier's verdict (`rate_limit` / `billing` /
// `auth_failed` / `auth_gated`). Without this fallback the mirror would emit the
// human "⚠ turn failed:" line with an EMPTY `terminal_error.detail_code`, leaving
// a spawner unable to classify a real rate_limit programmatically. The normalized
// value wins when present, so the acpx-error-class paths are unchanged; the
// classifier only fills the gap.
function resolveTerminalDetailCode(error: unknown): string | undefined {
  const normalized = normalizeOutputError(error, { origin: "runtime" }).detailCode;
  if (typeof normalized === "string" && normalized.trim().length > 0) {
    return normalized;
  }
  return classifyFailover(error) ?? undefined;
}

// Class-agnostic terminal-turn-error predicate. TRUE for any error that resolves
// to a machine-readable detailCode — via `normalizeOutputError` OR the failover
// classifier (see `resolveTerminalDetailCode`). The routing gate for the
// messages.ndjson mirror: it deliberately does NOT name error classes, so future
// terminal error kinds (e.g. w-fableshare's forthcoming FableShareExhaustedError
// / detailCode 'fable-share-exhausted') flow through with zero further changes at
// the call sites. Errors with neither a detailCode nor a failover verdict
// (ordinary/uncaught turn failures, interrupts) return false and are not mirrored.
export function isTerminalTurnError(error: unknown): boolean {
  return resolveTerminalDetailCode(error) !== undefined;
}

// Build the agent-visible synthetic `SessionMessage` that mirrors a terminal turn
// error into the conversation log. CLASS-AGNOSTIC: the error is run through the
// SAME `normalizeOutputError` the stream/stdout paths use, and a machine-readable
// `detail_code` (normalized, or classifier-derived for raw adapter errors),
// `message`/`code` are carried structurally in `Agent.terminal_error` (snake_case,
// so a spawner can classify programmatically) plus a human-readable
// "⚠ turn failed: <message>" `Text` block. No per-error-class branching.
export function buildTerminalTurnErrorMessage(error: unknown): SessionMessage {
  const normalized = normalizeOutputError(error, { origin: "runtime" });
  const detailCode = resolveTerminalDetailCode(error);
  const terminalError: SessionTerminalError = {
    message: normalized.message,
    ...(detailCode ? { detail_code: detailCode } : {}),
    ...(normalized.code ? { output_code: normalized.code } : {}),
    ...(normalized.origin ? { origin: normalized.origin } : {}),
    ...(normalized.retryable !== undefined ? { retryable: normalized.retryable } : {}),
  };
  return {
    Agent: {
      content: [{ Text: `⚠ turn failed: ${normalized.message}` }],
      tool_results: {},
      terminal_error: terminalError,
    },
  };
}

// Mirror a terminal turn error into the session's `.messages.ndjson` (the
// conversation log spawner agents + the record's `messages` read) as an
// agent-visible synthetic Agent entry, so a child that dies on a terminal error
// AND its spawner are TOLD — not only via `.stream.ndjson` (human/UI-only, never
// surfaced in messages.ndjson). Additive to `persistTerminalTurnError`'s stream
// write; uses the SAME boundary-append path a normal finalized turn uses
// (`writeSessionRecordAtBoundary` honours the messages-log watermark, appending
// exactly this new entry). The caller must pass a freshly-resolved record so the
// watermark reflects on-disk state. Best-effort: a persistence failure here must
// NOT mask the original turn error (caller guards with `.catch`).
//
// VERIFIED-SAFE (see FIX-A spec §Safety): `messages.ndjson` / `record.messages`
// is acpx's display/API mirror and is NEVER replayed to the adapter (resume uses
// `resumeSessionAt:<claudeUuid>`), so this cannot pollute Claude's transcript.
export async function mirrorTerminalTurnErrorToMessages(
  record: SessionRecord,
  error: unknown,
): Promise<void> {
  record.messages.push(buildTerminalTurnErrorMessage(error));
  await writeSessionRecordAtBoundary(record);
}
