import { normalizeOutputError } from "../acp/error-normalization.js";
import { buildJsonRpcErrorResponse } from "../acp/jsonrpc-error.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../types.js";
import { SessionEventWriter } from "./events.js";
import { isoNow } from "./persistence.js";

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
