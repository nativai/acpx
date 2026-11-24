import { assertPersistedKeyPolicy } from "../../persisted-key-policy.js";
import type { SessionMessage, SessionRecord, SubagentRef } from "../../types.js";
import { SESSION_RECORD_SCHEMA, UNKNOWN_TOP_LEVEL_FIELDS } from "../../types.js";
import { getLoggedMessageCount } from "../messages-log-bookkeeping.js";
import { normalizeRuntimeSessionId } from "../runtime-session-id.js";
import { KNOWN_TOP_LEVEL_KEYS } from "./parse.js";
import { seatFieldsToPersistedRecord } from "./seat-fields.js";

function serializeSubagentRef(ref: SubagentRef): Record<string, unknown> {
  return {
    acpx_record_id: ref.acpxRecordId,
    name: ref.name,
    color: ref.color,
    spawned_at: ref.spawnedAt,
    claude_jsonl_path: ref.claudeJsonlPath,
  };
}

export type SerializeSessionRecordForDiskOptions = {
  messages?: "inline" | "split-tail";
  /**
   * The inline entries to publish, decided by the writer under the record's lock (C3.5 (i)): its own
   * unfinished entries plus every other writer's inline entry as it stands on disk. Replaces the
   * `messages` choice above; the writer's own in-memory window is then never what lands.
   */
  inlineMessages?: readonly SessionMessage[] | undefined;
  /**
   * The unknown top-level keys to write (A-65, C3.5 (iv)), decided by the writer under the record's lock:
   * the keys of the record as it stands on disk, over any the in-memory copy carried. Replaces the carrier
   * on the record (`UNKNOWN_TOP_LEVEL_FIELDS`), which stays the source for a writer that reads no disk.
   */
  unknownTopLevelFields?: Readonly<Record<string, unknown>> | undefined;
};

/**
 * ⚠️ THIS THROWS ON A NON-SNAKE_CASE PERSISTED KEY, AND THE ASSERT LIVES HERE
 * ON PURPOSE (brick://48aca560).
 *
 * It used to sit in the two CALLERS — `repository.ts` and `file-session-store.ts`
 * — which meant the production write path was checked and every test fixture
 * was not: the test helpers serialize and `fs.writeFile` themselves. So a record
 * shape that could never be persisted in production round-tripped happily
 * through the suite. `test/session-persistence.test.ts`'s
 * "preserves … provisioning_warning breadcrumb" was green for three months
 * against a breadcrumb that was, in production, unwritable.
 *
 * Putting it here makes the coverage structural rather than a list of call
 * sites to remember: producing the persisted shape AT ALL is what is checked,
 * so a new writer — test or production — cannot be added without it.
 */
/**
 * C1.3 / TE R2-F2 — a DAMAGED `acpx.sleeping` plan is kept in memory as an unusable view that carries the
 * raw value (`unreadable.raw`, `create-plan.ts`); what reaches the disk is that RAW value, never the view,
 * so no write — a refused wake's included — changes or erases a plan a person may need to diagnose.
 */
function acpxForDisk(acpx: SessionRecord["acpx"]): SessionRecord["acpx"] | Record<string, unknown> {
  const unreadable = acpx?.sleeping?.unreadable;
  return unreadable === undefined ? acpx : { ...acpx, sleeping: unreadable.raw };
}

/** The inline entries and the log pointer a record is written with (split form, or all inline). */
function persistedMessages(
  record: SessionRecord,
  options: SerializeSessionRecordForDiskOptions,
): { messages: readonly SessionMessage[]; messagesLog: SessionRecord["messagesLog"] } {
  const useSplitTail = options.messages === "split-tail" && record.messagesLog !== undefined;
  const messages =
    options.inlineMessages ??
    (useSplitTail ? record.messages.slice(getLoggedMessageCount(record)) : record.messages);
  const split = useSplitTail || (options.inlineMessages !== undefined && record.messagesLog);
  return { messages, messagesLog: split ? record.messagesLog : undefined };
}

export function serializeSessionRecordForDisk(
  record: SessionRecord,
  options: SerializeSessionRecordForDiskOptions = {},
): Record<string, unknown> {
  const canonical: SessionRecord = {
    ...record,
    schema: SESSION_RECORD_SCHEMA,
  };
  const { messages, messagesLog } = persistedMessages(canonical, options);

  const persisted: Record<string, unknown> = {
    schema: canonical.schema,
    acpx_record_id: canonical.acpxRecordId,
    acp_session_id: canonical.acpSessionId,
    agent_session_id: normalizeRuntimeSessionId(canonical.agentSessionId),
    agent_name: canonical.agentName,
    agent_command: canonical.agentCommand,
    cwd: canonical.cwd,
    created_at: canonical.createdAt,
    last_used_at: canonical.lastUsedAt,
    last_seq: canonical.lastSeq,
    last_request_id: canonical.lastRequestId,
    event_log: canonical.eventLog,
    closed: canonical.closed,
    closed_at: canonical.closedAt,
    reopened_at: canonical.reopenedAt,
    favorite: canonical.favorite,
    favorited_at: canonical.favoritedAt,
    pid: canonical.pid,
    pid_identity: canonical.pidIdentity,
    agent_started_at: canonical.agentStartedAt,
    last_prompt_at: canonical.lastPromptAt,
    last_agent_exit_code: canonical.lastAgentExitCode,
    last_agent_exit_signal: canonical.lastAgentExitSignal,
    last_agent_exit_at: canonical.lastAgentExitAt,
    last_agent_disconnect_reason: canonical.lastAgentDisconnectReason,
    last_agent_unexpected_during_prompt: canonical.lastAgentUnexpectedDuringPrompt,
    protocol_version: canonical.protocolVersion,
    agent_capabilities: canonical.agentCapabilities,
    title: canonical.title,
    messages,
    ...(messagesLog === undefined ? {} : { messages_log: messagesLog }),
    updated_at: canonical.updated_at,
    cumulative_token_usage: canonical.cumulative_token_usage,
    request_token_usage: canonical.request_token_usage,
    acpx: acpxForDisk(canonical.acpx),
    kind: canonical.kind,
    parent_session_id: canonical.parentSessionId,
    parent_session_url: canonical.parentSessionUrl,
    parent_set_at: canonical.parentSetAt,
    spawned_by_session_id: canonical.spawnedBySessionId,
    forked_from_session_id: canonical.forkedFromSessionId,
    forked_at_message_index: canonical.forkedAtMessageIndex,
    forked_at_message_index_requested: canonical.forkedAtMessageIndexRequested,
    subagents: canonical.subagents?.map(serializeSubagentRef),
    metadata: canonical.metadata,
    template: canonical.template,
    ...seatFieldsToPersistedRecord(canonical),
    imported_from: canonical.importedFrom
      ? {
          record_id: canonical.importedFrom.recordId,
          cwd_original: canonical.importedFrom.cwdOriginal,
          exported_by: canonical.importedFrom.exportedBy,
          exported_at: canonical.importedFrom.exportedAt,
        }
      : undefined,
  };

  // The key policy checks the keys THIS release writes, and only those: a carried key is a newer release's
  // and is never a reason to refuse the write (A-65), whatever its spelling.
  assertPersistedKeyPolicy(persisted);
  return withUnknownTopLevelFields(
    persisted,
    options.unknownTopLevelFields ?? canonical[UNKNOWN_TOP_LEVEL_FIELDS],
  );
}

/**
 * Appends the carried keys after the known ones. A carried key this release writes itself is skipped — the
 * known value wins, including a known field that is deliberately `undefined` (cleared) — so a stale carrier
 * can never bring a cleared field back. The check is against `persisted`'s own keys (an `undefined` value
 * is still a key there, until `JSON.stringify`), not against a second list.
 */
function withUnknownTopLevelFields(
  persisted: Record<string, unknown>,
  carried: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (carried === undefined) {
    return persisted;
  }
  for (const [key, value] of Object.entries(carried)) {
    if (KNOWN_TOP_LEVEL_KEYS.has(key) || Object.hasOwn(persisted, key)) {
      continue;
    }
    Object.defineProperty(persisted, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return persisted;
}
