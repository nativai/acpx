import type { AgentLifecycleSnapshot } from "../../acp/client.js";
import { copyLoggedMessageCount } from "../../session/messages-log-bookkeeping.js";
import { normalizeRuntimeSessionId } from "../../session/runtime-session-id.js";
import type { SessionConversation, SessionRecord } from "../../types.js";

export function applyLifecycleSnapshotToRecord(
  record: SessionRecord,
  snapshot: AgentLifecycleSnapshot | undefined,
): void {
  if (!snapshot) {
    return;
  }

  record.pid = snapshot.running ? snapshot.pid : undefined;
  record.agentStartedAt = snapshot.startedAt;
  if (snapshot.provisioningWarning) {
    const acpx = record.acpx ?? {};
    const sessionOptions = { ...acpx.session_options };
    sessionOptions.provisioning_warning = { ...snapshot.provisioningWarning };
    record.acpx = { ...acpx, session_options: sessionOptions };
  }

  if (snapshot.lastExit) {
    record.lastAgentExitCode = snapshot.lastExit.exitCode;
    record.lastAgentExitSignal = snapshot.lastExit.signal;
    record.lastAgentExitAt = snapshot.lastExit.exitedAt;
    record.lastAgentDisconnectReason = snapshot.lastExit.reason;
    return;
  }

  record.lastAgentExitCode = undefined;
  record.lastAgentExitSignal = undefined;
  record.lastAgentExitAt = undefined;
  record.lastAgentDisconnectReason = undefined;
}

export function reconcileAgentSessionId(
  record: SessionRecord,
  agentSessionId: string | undefined,
): void {
  const normalized = normalizeRuntimeSessionId(agentSessionId);
  if (!normalized) {
    return;
  }

  record.agentSessionId = normalized;
}

export function sessionHasAgentMessages(
  recordOrConversation: Pick<SessionRecord, "messages"> | SessionConversation,
): boolean {
  return recordOrConversation.messages.some(
    (message) => typeof message === "object" && message !== null && "Agent" in message,
  );
}

export function applyConversation(record: SessionRecord, conversation: SessionConversation): void {
  record.title = conversation.title;
  record.updated_at = conversation.updated_at;
  record.messages = conversation.messages;
  copyLoggedMessageCount(conversation, record);
  record.cumulative_token_usage = conversation.cumulative_token_usage;
  record.request_token_usage = conversation.request_token_usage;
}
