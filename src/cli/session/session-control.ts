import fs from "node:fs/promises";
import path from "node:path";
import { SubscriptionTurnInFlightError } from "../../errors.js";
import { switchSessionSubscription } from "../../runtime/engine/subscription-switch.js";
import {
  setCurrentModelId,
  setDesiredConfigOption,
  setDesiredModeId,
  setDesiredModelId,
} from "../../session/mode-preference.js";
import { assertRecordModelSupported } from "../../session/model-application.js";
import {
  resolveSessionRecord,
  writeSessionRecord,
  writeSessionRecordAtBoundaryWithLifecycle,
  isoNow,
} from "../../session/persistence.js";
import type {
  SessionRecord,
  SessionSetConfigOptionResult,
  SessionSetModelResult,
  SessionSetModeResult,
} from "../../types.js";
import {
  isProcessAlive,
  type QueueOwnerRecoveryResult,
  readQueueOwnerLiveness,
  recoverQueueOwnerForSession,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryCancelOnRunningOwner,
  tryCloseSessionOnRunningOwner,
  tryQueryActiveTurnOnRunningOwner,
  trySetConfigOptionOnRunningOwner,
  trySetModelOnRunningOwner,
  trySetModeOnRunningOwner,
} from "../queue/ipc.js";
import type {
  SessionCancelOptions,
  SessionCancelResult,
  SessionSetConfigOptionOptions,
  SessionSetModelOptions,
  SessionSetModeOptions,
  SessionSetSubscriptionOptions,
  SessionSetSubscriptionResult,
} from "./contracts.js";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetModelDirect,
  runSessionSetModeDirect,
} from "./prompt-runner.js";

export async function cancelSessionPrompt(
  options: SessionCancelOptions,
): Promise<SessionCancelResult> {
  const cancelled = await tryCancelOnRunningOwner(options);
  return {
    sessionId: options.sessionId,
    cancelled: cancelled === true,
  };
}

export async function setSessionMode(
  options: SessionSetModeOptions,
): Promise<SessionSetModeResult> {
  const submittedToOwner = await trySetModeOnRunningOwner(
    options.sessionId,
    options.modeId,
    options.timeoutMs,
    options.verbose,
  );
  if (submittedToOwner) {
    const record = await resolveSessionRecord(options.sessionId);
    setDesiredModeId(record, options.modeId);
    await writeSessionRecord(record);
    return {
      record,
      resumed: false,
    };
  }

  return await runSessionSetModeDirect({
    sessionRecordId: options.sessionId,
    modeId: options.modeId,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

export async function setSessionModel(
  options: SessionSetModelOptions,
): Promise<SessionSetModelResult> {
  const record = await resolveSessionRecord(options.sessionId);
  assertRecordModelSupported({
    record,
    requestedModel: options.modelId,
    context: "apply",
  });

  const submittedToOwner = await trySetModelOnRunningOwner(
    options.sessionId,
    options.modelId,
    options.timeoutMs,
    options.verbose,
  );
  if (submittedToOwner) {
    setDesiredModelId(record, options.modelId);
    setCurrentModelId(record, options.modelId);
    await writeSessionRecord(record);
    return {
      record,
      resumed: false,
    };
  }

  return await runSessionSetModelDirect({
    sessionRecordId: options.sessionId,
    modelId: options.modelId,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

export async function setSessionConfigOption(
  options: SessionSetConfigOptionOptions,
): Promise<SessionSetConfigOptionResult> {
  const ownerResponse = await trySetConfigOptionOnRunningOwner(
    options.sessionId,
    options.configId,
    options.value,
    options.timeoutMs,
    options.verbose,
  );
  if (ownerResponse) {
    const record = await resolveSessionRecord(options.sessionId);
    if (options.configId === "mode") {
      setDesiredModeId(record, options.value);
    } else {
      setDesiredConfigOption(record, options.configId, options.value);
    }
    await writeSessionRecord(record);
    return {
      record,
      response: ownerResponse,
      resumed: false,
    };
  }

  return await runSessionSetConfigOptionDirect({
    sessionRecordId: options.sessionId,
    configId: options.configId,
    value: options.value,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
}

// Change a session's active Claude subscription in place. Unlike set-mode/model
// (ACP config ops), a subscription is CLAUDE_CONFIG_DIR, re-resolved from the
// record on every spawn — so the durable switch is the record edit + transcript
// copy (switchSessionSubscription). Binding it requires a respawn:
//   COLD (no live owner) → record edit only; the next spawn resolves the new dir.
//   LIVE (queue owner holds a client on the old dir) → after the record edit,
//     terminate the owner so the next prompt cold-spawns a fresh owner on the new
//     dir (resuming the ported transcript). Refuse if a turn is in flight.
export async function setSessionSubscription(
  options: SessionSetSubscriptionOptions,
): Promise<SessionSetSubscriptionResult> {
  const liveness = await readQueueOwnerLiveness(options.sessionId);
  const ownerAlive = liveness?.alive === true;

  if (ownerAlive) {
    const active = await tryQueryActiveTurnOnRunningOwner(options.sessionId);
    if (active === true) {
      throw new SubscriptionTurnInFlightError(options.sessionName);
    }
  }

  const record = await resolveSessionRecord(options.sessionId);
  const { from, to, transcriptCopied } = await switchSessionSubscription({
    record,
    targetSubId: options.subscriptionId,
    reason: "manual",
    loadOpts: options.loadOpts,
  });
  await writeSessionRecord(record);

  // Bind on a live session by recycling the owner; the next prompt re-resolves
  // CLAUDE_CONFIG_DIR from the updated record. The ported transcript means the
  // fresh client resumes WITH context.
  let ownerRestarted = false;
  if (ownerAlive) {
    await terminateQueueOwnerForSession(options.sessionId);
    ownerRestarted = true;
    if (options.verbose) {
      process.stderr.write(
        `[acpx] restarted queue owner for session ${options.sessionId} to bind subscription "${to}"\n`,
      );
    }
  }

  return { record, from, to, transcriptCopied, ownerRestarted };
}

function firstAgentCommandToken(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }
  const token = trimmed.split(/\s+/, 1)[0];
  return token.length > 0 ? token : undefined;
}

async function isLikelyMatchingProcess(pid: number, agentCommand: string): Promise<boolean> {
  const expectedToken = firstAgentCommandToken(agentCommand);
  if (!expectedToken) {
    return false;
  }

  const procCmdline = `/proc/${pid}/cmdline`;
  try {
    const payload = await fs.readFile(procCmdline, "utf8");
    const argv = payload
      .split("\u0000")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (argv.length === 0) {
      return false;
    }

    const executableBase = path.basename(argv[0]);
    const expectedBase = path.basename(expectedToken);
    return (
      executableBase === expectedBase || argv.some((entry) => path.basename(entry) === expectedBase)
    );
  } catch {
    return true;
  }
}

export async function closeSession(sessionId: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(sessionId);
  await tryCloseSessionOnRunningOwner({ sessionId: record.acpxRecordId }).catch(() => {
    // Preserve local close semantics even if best-effort ACP session shutdown fails.
  });
  await terminateQueueOwnerForSession(record.acpxRecordId);

  if (
    record.pid != null &&
    isProcessAlive(record.pid) &&
    (await isLikelyMatchingProcess(record.pid, record.agentCommand))
  ) {
    await terminateProcess(record.pid);
  }

  record.pid = undefined;
  record.closed = true;
  record.closedAt = isoNow();
  // Privileged write: this is a daemon-authorized close — bypass the
  // read-preserve-lifecycle step so `closed: true` actually lands on disk.
  // See writeSessionRecord doc comment in repository.ts for the ownership rules.
  await writeSessionRecordAtBoundaryWithLifecycle(record);

  return record;
}

export type SessionOwnerStatus = {
  /** Resolved acpx record id (the id the queue lease is keyed by). */
  sessionId: string;
  ownerFound: boolean;
  pid: number | null;
  alive: boolean;
  stale: boolean;
  heartbeatAt: string | null;
};

// Read-only owner-liveness probe for a session. Resolves the caller-supplied id
// (acpx record id, ACP session id, or unique suffix — same as `prompt -s`) to its
// record, then reads the queue lease keyed by `record.acpxRecordId`. Never reaps.
export async function readSessionOwnerStatus(sessionId: string): Promise<SessionOwnerStatus> {
  const record = await resolveSessionRecord(sessionId);
  const liveness = await readQueueOwnerLiveness(record.acpxRecordId);
  if (!liveness) {
    return {
      sessionId: record.acpxRecordId,
      ownerFound: false,
      pid: null,
      alive: false,
      stale: false,
      heartbeatAt: null,
    };
  }
  return {
    sessionId: record.acpxRecordId,
    ownerFound: true,
    pid: liveness.pid,
    alive: liveness.alive,
    stale: liveness.stale,
    heartbeatAt: liveness.heartbeatAt,
  };
}

// Force-restart (un-wedge) a session's queue owner. Resolves the caller-supplied
// id the same way `prompt -s`/close do, then force-kills the owner process GROUP
// keyed by `record.acpxRecordId` and clears its lease. Idempotent: a session with
// no live owner succeeds. The next prompt cold-spawns a fresh owner. Redelivery of
// the in-flight prompt is the caller's job (acpx-ui), not this command's.
export async function recoverSession(sessionId: string): Promise<QueueOwnerRecoveryResult> {
  const record = await resolveSessionRecord(sessionId);
  return await recoverQueueOwnerForSession(record.acpxRecordId);
}
