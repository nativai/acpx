import type { AcpClient, SessionCreateResult, SessionForkResult } from "../../acp/client.js";
import { withTimeout } from "../../async-control.js";
import { readFullSourceHistory } from "../../cli/session/fork-at-log-index.js";
import { AcpxOperationalError } from "../../errors.js";
import {
  resolveSessionRecord,
  writeSessionRecordAtBoundaryNow,
} from "../../session/persistence.js";
import type { SessionMessage, SessionRecord } from "../../types.js";

/**
 * UMQ K7 (CONCEPTION §6.2) — what the first wake of a sleeping record takes from its template.
 * Held until the whole materialisation (fork, then model / effort / mode / config) has succeeded,
 * so a failure leaves the record exactly as `sessions new|copy --sleeping` wrote it.
 */
export type SleepingForkInherited = {
  template: SessionRecord;
  messages: SessionMessage[];
  forkAtMessageIndex: number;
};

export type SleepingTemplateFork = {
  forked: SessionCreateResult | SessionForkResult;
  inherited: SleepingForkInherited;
  /** A durable Claude fork: acpx materialised a transcript the adapter has not registered yet, so the
   *  forked id must be RESUMED before it can be driven (the same step a later `sessions copy` →
   *  first-prompt does across two processes). */
  durableClaudeFork: boolean;
};

export const SLEEPING_TEMPLATE_GONE = "the template this session was created to fork is gone";

/**
 * Fork the template of a sleeping copy, at the first wake: the template is read NOW, not at the
 * sleeping create, so a template re-baked in between gives the newer content (HoD Q9, no revision
 * pin). Always a copy-all (`sessions copy --sleeping` refuses a cut): the record inherits the
 * template's whole history and the adapter is not cut.
 */
export async function forkTemplateForSleepingSession(params: {
  client: AcpClient;
  record: SessionRecord;
  templateId: string;
  timeoutMs?: number;
}): Promise<SleepingTemplateFork> {
  const template = await loadTemplateOrExplain(params.templateId, params.record);
  if (template.acpx?.sleeping || template.acpSessionId === "") {
    throw new AcpxOperationalError(
      `Cannot fork template ${params.templateId} for ${params.record.acpxRecordId}: ` +
        `nothing to copy yet — it has never run`,
      { outputCode: "RUNTIME", origin: "runtime" },
    );
  }
  if (!params.client.supportsForkSession()) {
    throw new AcpxOperationalError(
      `Agent command "${params.record.agentCommand}" does not advertise sessionCapabilities.fork; ` +
        `cannot fork template ${template.acpxRecordId}`,
      { outputCode: "RUNTIME", origin: "runtime" },
    );
  }
  const messages = (await readFullSourceHistory(template)).messages;
  const forkAtMessageIndex = messages.length;
  const forked =
    forkAtMessageIndex === 0
      ? await withTimeout(params.client.createSession(params.record.cwd), params.timeoutMs)
      : await withTimeout(
          params.client.forkSession(template.acpSessionId, params.record.cwd, {
            atIndex: undefined,
            sourceMessages: template.messages,
            sourceCwd: template.cwd,
            suppressReplayUpdates: true,
          }),
          params.timeoutMs,
        );
  return {
    forked,
    inherited: { template, messages, forkAtMessageIndex },
    durableClaudeFork:
      "durableClaudeForkApplied" in forked && forked.durableClaudeForkApplied === true,
  };
}

async function loadTemplateOrExplain(
  templateId: string,
  record: SessionRecord,
): Promise<SessionRecord> {
  try {
    return await resolveSessionRecord(templateId);
  } catch (error) {
    throw new AcpxOperationalError(
      `${SLEEPING_TEMPLATE_GONE}: ${templateId} (session ${record.acpxRecordId}) — ` +
        (error instanceof Error ? error.message : String(error)),
      { outputCode: "NO_SESSION", origin: "runtime" },
    );
  }
}

/**
 * The last step of a successful first wake: the session is no longer sleeping. A forked record
 * takes the template's history (flushed through the boundary writer so the messages sidecar exists,
 * as `sessions copy` stores it) and keeps the template's `lastUsedAt` for traceability; both its
 * `template_source` metadata and its `forkedFromSessionId` were written by the sleeping create.
 */
export async function finishSleepingMaterialisation(
  record: SessionRecord,
  inherited: SleepingForkInherited | undefined,
): Promise<void> {
  if (!record.acpx?.sleeping) {
    return; // an ordinary connect: nothing to end
  }
  delete record.acpx.sleeping;
  if (inherited) {
    record.messages = structuredClone(inherited.messages);
    record.forkedAtMessageIndex = inherited.forkAtMessageIndex;
    record.forkedFromSessionId = inherited.template.acpxRecordId;
    record.metadata = {
      ...record.metadata,
      template_last_used_at: inherited.template.lastUsedAt,
    };
  }
  await writeSessionRecordAtBoundaryNow(record);
}
