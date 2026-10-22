import { createHash } from "node:crypto";
import { InvalidArgumentError } from "commander";
import {
  assertForkAtIndexHonoured,
  resolveEffectiveForkIndex,
} from "../../acp/harness-capabilities.js";
import { getLoggedMessageCount } from "../../session/messages-log-bookkeeping.js";
import { messagesLogPath, readMessagesLogEntries } from "../../session/messages-log.js";
import { sessionBaseDir } from "../../session/persistence.js";
import type { SessionMessage, SessionRecord } from "../../types.js";

// brick 0dc53ac9 (conception 0d57058c D4) — `sessions copy --at-log-index <n>`.
//
// `--at-index k` addresses the HYDRATED WINDOW (`record.messages`, the last ≤200
// entries), which slides on every append and cannot reach an entry older than
// it. `--at-log-index n` addresses the source's FULL history instead: absolute
// positions counted from `messages_log.base_index`, over the log lines followed
// by the inline tail hydration has already de-duplicated. The copy inherits the
// window ENDING at n — the same ≤200-entry runtime window a full copy gets.

/** Same cap as `MAX_RUNTIME_MESSAGES` in `session/messages-log.ts`. */
const FORK_WINDOW_MESSAGES = 200;

export const FORK_CUT_MOVED = "FORK_CUT_MOVED";

/**
 * `--expect-entry` named an entry that is not at `n-1` any more. The message IS
 * the compact JSON line the conception specifies on stderr, so a caller can match
 * `"code":"FORK_CUT_MOVED"` in either stream; `detailCode` carries the same code
 * into the `--format json` error response.
 */
export class ForkCutMovedError extends Error {
  readonly detailCode = FORK_CUT_MOVED;
  /** Also written to stderr in `--format json` mode (see `emitRequestedError`). */
  readonly stderrLine: string;

  constructor(details: { atLogIndex: number; expected: string; found: string | null }) {
    super(
      JSON.stringify({
        code: FORK_CUT_MOVED,
        at_log_index: details.atLogIndex,
        expected: details.expected,
        found: details.found,
      }),
    );
    this.name = "ForkCutMovedError";
    this.stderrLine = this.message;
  }
}

export type LogIndexForkWindow = {
  /** The absolute position the copy ACTUALLY ends at (after a harness's snap). */
  logIndex: number;
  /** The absolute position that was asked for; equal to `logIndex` unless snapped. */
  requestedLogIndex: number;
  /** Entries `[max(base_index, logIndex-200), logIndex)` — what the copy inherits. */
  messages: SessionMessage[];
};

/**
 * The fingerprint `--expect-entry` is compared with: `user:<id>` for a User
 * entry, `agent:<sha1 of the raw line>` for an Agent entry. The raw line is the
 * log line's bytes as stored, or `JSON.stringify(entry)` for an inline-tail entry
 * — the exact bytes the log writer appends for it. A `"Resume"` marker has no
 * fingerprint, so no `--expect-entry` can match it.
 */
export function forkEntryFingerprint(entry: SessionMessage, rawLine: string): string | undefined {
  if (entry === "Resume") {
    return undefined;
  }
  if ("User" in entry) {
    return `user:${entry.User.id}`;
  }
  return `agent:${createHash("sha1").update(rawLine, "utf8").digest("hex")}`;
}

/**
 * The source's full history: every log line (up to the hydrated watermark), then
 * the inline tail hydration kept. `source` must be the record exactly as
 * `resolveSessionRecord` returned it — the logged-count bookkeeping that splits
 * its `messages` into "from the log" and "inline" lives on that object.
 */
async function readFullSourceHistory(source: SessionRecord): Promise<{
  baseIndex: number;
  messages: SessionMessage[];
  rawLines: string[];
}> {
  const inlineTail = source.messages.slice(getLoggedMessageCount(source));
  const log = source.messagesLog
    ? await readMessagesLogEntries(
        messagesLogPath(sessionBaseDir(), source.acpxRecordId),
        source.messagesLog.bytes,
      )
    : { messages: [], rawLines: [] };
  return {
    baseIndex: source.messagesLog?.base_index ?? 0,
    messages: [...log.messages, ...inlineTail],
    rawLines: [...log.rawLines, ...inlineTail.map((entry) => JSON.stringify(entry))],
  };
}

/**
 * Resolve `--at-log-index n [--expect-entry f]` against the source. Every refusal
 * happens here, before any record exists: the harness refusal, the range check
 * (`[base_index, total]`, the existing invalid-argument exit), and the entry guard.
 */
export async function resolveLogIndexForkWindow(params: {
  source: SessionRecord;
  agentCommand: string;
  atLogIndex: number;
  expectEntry: string | undefined;
}): Promise<LogIndexForkWindow> {
  const requested = params.atLogIndex;
  assertForkAtIndexHonoured(params.agentCommand, requested);
  const history = await readFullSourceHistory(params.source);
  const base = history.baseIndex;
  const total = base + history.messages.length;
  if (requested < base || requested > total) {
    throw new InvalidArgumentError(`--at-log-index out of range (${base}-${total})`);
  }

  if (params.expectEntry !== undefined) {
    const at = requested - 1 - base;
    const found =
      at >= 0 ? forkEntryFingerprint(history.messages[at], history.rawLines[at]) : undefined;
    if (found !== params.expectEntry) {
      throw new ForkCutMovedError({
        atLogIndex: requested,
        expected: params.expectEntry,
        found: found ?? null,
      });
    }
  }

  // Codex snaps to its turn granularity; its adapter counts turns from the
  // thread start, so the snap applies to the ABSOLUTE position.
  const logIndex = Math.max(base, resolveEffectiveForkIndex(params.agentCommand, requested));
  const end = logIndex - base;
  return {
    logIndex,
    requestedLogIndex: requested,
    messages: history.messages.slice(Math.max(0, end - FORK_WINDOW_MESSAGES), end),
  };
}
