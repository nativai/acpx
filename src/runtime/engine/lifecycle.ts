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
    // Persist whether the disconnect happened MID-TURN (a prompt was active) vs at
    // rest — the one signal that distinguishes a mid-turn death from a routine idle
    // TTL-reap, both of which otherwise serialize as connection_close/null/null.
    record.lastAgentUnexpectedDuringPrompt = snapshot.lastExit.unexpectedDuringPrompt;
    return;
  }

  record.lastAgentExitCode = undefined;
  record.lastAgentExitSignal = undefined;
  record.lastAgentExitAt = undefined;
  record.lastAgentDisconnectReason = undefined;
  record.lastAgentUnexpectedDuringPrompt = undefined;
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

// True only when a REAL model turn was ever produced — synthetic system
// breadcrumbs mirrored by acpx (the implicit-Fable→opus guard notice, tagged
// `Agent.synthetic:true`) are excluded (brick://de3645c6). This is the correct
// signal for the "nothing to lose" fallback-safety gate: a never-run session
// carrying only a cosmetic breadcrumb has no conversation to preserve, so a
// resume→resource-not-found on a genuinely-missing transcript is safe to heal
// via session/new — exactly as a freshly created session would. A session with
// any real Agent turn still fails loudly (silent continuity loss is forbidden).
export function sessionHasRealAgentTurn(
  recordOrConversation: Pick<SessionRecord, "messages"> | SessionConversation,
): boolean {
  return recordOrConversation.messages.some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "Agent" in message &&
      message.Agent.synthetic !== true,
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
