import type { AcpClient, SessionCreateResult, SessionForkResult } from "../../acp/client.js";
import { assertPiForkSourceComplete } from "../../acp/harness-config-dir.js";
import { withTimeout } from "../../async-control.js";
import {
  readFullSourceHistory,
  resolveLogIndexForkWindow,
} from "../../cli/session/fork-at-log-index.js";
import { effectiveCreateCwd } from "../../config/session-root.js";
import { AcpxOperationalError } from "../../errors.js";
import {
  CreatePlanError,
  decodeHarnessAnchor,
  FORK_ANCHOR_MISSING,
  FORK_ANCHOR_UNSUPPORTED,
  FORK_SOURCE_GONE,
  forkSourceSleepingError,
  type SleepingForkCut,
} from "../../pod/create-plan.js";
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
  if (forkAtMessageIndex > 0) {
    assertPiForkSourceComplete(template); // P1 (ruling row (c)), before the adapter forks
  }
  // The first wake is the moment this session is created, so its cwd goes through the session-root
  // helper like every other create site. The sleeping create already rooted `record.cwd`, so on an
  // unchanged box this is the same path (the record is left untouched, so a failed wake stays
  // as the sleeping create wrote it, except the event-stream counters: see `connectAndLoadSession`).
  const cwd = effectiveCreateCwd(params.record.cwd);
  const forked =
    forkAtMessageIndex === 0
      ? await withTimeout(params.client.createSession(cwd), params.timeoutMs)
      : await withTimeout(
          params.client.forkSession(template.acpSessionId, cwd, {
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

/**
 * C1.3 — the first wake of a record created as a fork AT A CUT (or a by-the-way): the record already
 * holds the inherited messages (copied at create), so only the HARNESS is cut here.
 *
 * - **Anchored** (`harness_anchor`, Claude): the file-level fork at the anchor, then a resume of the
 *   durable id — never the adapter's fork (see `AcpClient.materializeClaudeCutFork`). The anchor is
 *   the check (amendment A-15): `expect_entry` is NOT re-read, because the source's last inherited
 *   entry may legitimately have grown since create (a by-the-way taken mid-turn) while the anchor
 *   still names exactly what the copy inherited.
 * - **Unanchored** (Pi, Codex): `expect_entry` is re-checked against the source on disk
 *   (`FORK_CUT_MOVED` when it moved), then the adapter forks at the absolute index.
 *
 * Every refusal is named and leaves the record sleeping, unchanged except the event-stream counters `last_seq`, `last_request_id`, `last_used_at` and `event_log.last_write_at` (the caller restores it).
 */
export async function forkCutForSleepingSession(params: {
  client: AcpClient;
  record: SessionRecord;
  sourceId: string;
  cut: SleepingForkCut;
  timeoutMs?: number;
}): Promise<{ forked: SessionForkResult; durableClaudeFork: boolean }> {
  const source = await loadCutSource(params.sourceId, params.record);
  const cwd = effectiveCreateCwd(params.record.cwd);
  if (params.cut.harness_anchor !== undefined) {
    const anchor = decodeHarnessAnchor(params.cut.harness_anchor);
    if (anchor.kind !== "claude-uuid" || !params.client.supportsClaudeFileFork()) {
      throw new CreatePlanError(
        FORK_ANCHOR_UNSUPPORTED,
        `anchor kind ${anchor.kind} cannot be executed by agent "${params.record.agentCommand}"`,
      );
    }
    const durableId = await withTimeout(
      materializeAnchoredFork(params.client, source, cwd, anchor.value),
      params.timeoutMs,
    );
    return { forked: { sessionId: durableId, agentSessionId: durableId }, durableClaudeFork: true };
  }
  if (!params.client.supportsForkSession()) {
    throw new AcpxOperationalError(
      `Agent command "${params.record.agentCommand}" does not advertise sessionCapabilities.fork; ` +
        `cannot fork ${source.acpxRecordId}`,
      { outputCode: "RUNTIME", origin: "runtime" },
    );
  }
  const window = await resolveLogIndexForkWindow({
    source,
    agentCommand: params.record.agentCommand,
    atLogIndex: params.cut.log_index ?? params.cut.message_index,
    expectEntry: params.cut.expect_entry,
  });
  assertPiForkSourceComplete(source); // P1 (ruling row (c)), before the adapter forks
  const forked = await withTimeout(
    params.client.forkSession(source.acpSessionId, cwd, {
      atIndex: window.logIndex,
      logIndexHistory: window.history,
      sourceMessages: window.messages,
      sourceCwd: source.cwd,
      suppressReplayUpdates: true,
    }),
    params.timeoutMs,
  );
  return {
    forked,
    durableClaudeFork:
      "durableClaudeForkApplied" in forked && forked.durableClaudeForkApplied === true,
  };
}

async function materializeAnchoredFork(
  client: AcpClient,
  source: SessionRecord,
  cwd: string,
  uuid: string,
): Promise<string> {
  let durableId: string | undefined;
  try {
    durableId = await client.materializeClaudeCutFork(source.acpSessionId, cwd, {
      sourceCwd: source.cwd,
      upToMessageId: uuid,
    });
  } catch (error) {
    throw new CreatePlanError(
      FORK_ANCHOR_MISSING,
      `the fork point ${uuid} could not be found in the conversation of ${source.acpxRecordId}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!durableId) {
    throw new CreatePlanError(
      FORK_ANCHOR_MISSING,
      `the Claude SDK that forks at ${uuid} could not be loaded for ${source.acpxRecordId}`,
    );
  }
  return durableId;
}

/** The cut's source, or a named refusal: gone (`FORK_SOURCE_GONE`), or it has never run. */
async function loadCutSource(sourceId: string, record: SessionRecord): Promise<SessionRecord> {
  let source: SessionRecord;
  try {
    source = await resolveSessionRecord(sourceId);
  } catch (error) {
    throw new CreatePlanError(
      FORK_SOURCE_GONE,
      `the session ${record.acpxRecordId} was cut from is gone: ${sourceId} — ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  if (source.acpx?.sleeping || source.acpSessionId === "") {
    throw forkSourceSleepingError(sourceId);
  }
  return source;
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
