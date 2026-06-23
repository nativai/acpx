import type { SessionRecord, SubagentRef } from "../../types.js";
import { SESSION_RECORD_SCHEMA } from "../../types.js";
import { getLoggedMessageCount } from "../messages-log-bookkeeping.js";
import { normalizeRuntimeSessionId } from "../runtime-session-id.js";

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
};

export function serializeSessionRecordForDisk(
  record: SessionRecord,
  options: SerializeSessionRecordForDiskOptions = {},
): Record<string, unknown> {
  const canonical: SessionRecord = {
    ...record,
    schema: SESSION_RECORD_SCHEMA,
  };
  const useSplitTail = options.messages === "split-tail" && canonical.messagesLog !== undefined;
  const messages = useSplitTail
    ? canonical.messages.slice(getLoggedMessageCount(record))
    : canonical.messages;

  return {
    schema: canonical.schema,
    acpx_record_id: canonical.acpxRecordId,
    acp_session_id: canonical.acpSessionId,
    agent_session_id: normalizeRuntimeSessionId(canonical.agentSessionId),
    agent_name: canonical.agentName,
    agent_command: canonical.agentCommand,
    cwd: canonical.cwd,
    name: canonical.name,
    created_at: canonical.createdAt,
    last_used_at: canonical.lastUsedAt,
    last_seq: canonical.lastSeq,
    last_request_id: canonical.lastRequestId,
    event_log: canonical.eventLog,
    closed: canonical.closed,
    closed_at: canonical.closedAt,
    favorite: canonical.favorite,
    favorited_at: canonical.favoritedAt,
    pid: canonical.pid,
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
    ...(useSplitTail ? { messages_log: canonical.messagesLog } : {}),
    updated_at: canonical.updated_at,
    cumulative_token_usage: canonical.cumulative_token_usage,
    request_token_usage: canonical.request_token_usage,
    acpx: canonical.acpx,
    kind: canonical.kind,
    parent_session_id: canonical.parentSessionId,
    forked_from_session_id: canonical.forkedFromSessionId,
    forked_at_message_index: canonical.forkedAtMessageIndex,
    subagents: canonical.subagents?.map(serializeSubagentRef),
    metadata: canonical.metadata,
    template: canonical.template,
    imported_from: canonical.importedFrom
      ? {
          record_id: canonical.importedFrom.recordId,
          cwd_original: canonical.importedFrom.cwdOriginal,
          exported_by: canonical.importedFrom.exportedBy,
          exported_at: canonical.importedFrom.exportedAt,
        }
      : undefined,
  };
}
