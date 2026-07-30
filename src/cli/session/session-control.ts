import fs from "node:fs/promises";
import path from "node:path";
import {
  ConfigOptionTurnInFlightError,
  ModelTurnInFlightError,
  ProfileTurnInFlightError,
  SubscriptionTurnInFlightError,
} from "../../errors.js";
import { switchSessionAccount } from "../../runtime/engine/account-seam.js";
import { switchSessionSubscription } from "../../runtime/engine/subscription-switch.js";
import {
  setCurrentModelId,
  setDesiredConfigOption,
  setDesiredModeId,
  setDesiredModelId,
  setDesiredModelSource,
} from "../../session/mode-preference.js";
import { assertRecordModelSupported } from "../../session/model-application.js";
import {
  resolveSessionRecord,
  listSessions,
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
  drainQueueOwnerForSession,
  isProcessAlive,
  type QueueDrainedDelivery,
  type QueueOwnerLiveness,
  type QueueOwnerRecoveryResult,
  readQueueOwnerLiveness,
  readQueueOwnerState,
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
import { DEFAULT_CLOSE_DRAIN_TIMEOUT_MS } from "./contracts.js";
import type {
  SessionCancelOptions,
  SessionCancelResult,
  SessionSetAutoFailoverOptions,
  SessionSetAutoFailoverResult,
  SessionSetAutoSubscriptionOptions,
  SessionSetAutoSubscriptionResult,
  SessionSetConfigOptionOptions,
  SessionSetFableDegradeOptions,
  SessionSetFableDegradeResult,
  SessionSetModelOptions,
  SessionSetModeOptions,
  SessionSetProfileOptions,
  SessionSetProfileResult,
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

// CLI-verb recycle pre-check (the warm-revert fix). The deployed warm bug: the
// queue owner binds sessionContext.reasoningEffort / the model at spawn and
// re-asserts it every turn, reverting a live IPC set on the next warm turn (W12-19
// only fixed the cold replay). The remedy mirrors `setSessionProfile`: refuse if a
// turn is in flight, then (after the normal validated apply) terminate a live
// owner so the next prompt cold-resumes WITH context (same CLAUDE_CONFIG_DIR → the
// in-place transcript is reused — no transcript port) and replays the new value
// (reconnect.ts), which then sticks. Unlike `set profile`, the normal apply is
// KEPT (not dropped): it validates the value at set time (an invalid model is
// ACP-rejected) and preserves the cold-respawn replay flow; the apply on a live
// owner is simply mooted by the terminate that follows. Returns whether a live
// owner exists, so the caller terminates it after the apply. A no-op when cold.
async function refuseTurnInFlightForRecycle(
  sessionId: string,
  makeTurnInFlightError: () => Error,
): Promise<boolean> {
  return await refuseTurnInFlightForLiveOwner(sessionId, makeTurnInFlightError);
}

async function refuseTurnInFlightForLiveOwner(
  sessionId: string,
  makeTurnInFlightError: () => Error,
): Promise<boolean> {
  const liveness = await readQueueOwnerLiveness(sessionId);
  if (liveness.alive) {
    const active = await tryQueryActiveTurnOnRunningOwner(sessionId);
    if (active === true) {
      throw makeTurnInFlightError();
    }
  }
  return liveness.alive;
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

  // CLI-verb path: refuse if a turn is in flight, then recycle the owner after the
  // apply below. Internal/replay callers leave recycleOwner off (multi-caller
  // guard) — they already cold-reconnect and must not recycle.
  const ownerToRecycle = options.recycleOwner
    ? await refuseTurnInFlightForRecycle(
        options.sessionId,
        () => new ModelTurnInFlightError(options.sessionName),
      )
    : false;

  let result: SessionSetModelResult;
  const submittedToOwner = await trySetModelOnRunningOwner(
    options.sessionId,
    options.modelId,
    options.timeoutMs,
    options.verbose,
  );
  if (submittedToOwner) {
    setDesiredModelId(record, options.modelId);
    setCurrentModelId(record, options.modelId);
    // brick://5bac5564 R5: a `set model` is an explicit acpx-level request →
    // provenance "explicit" (so a deliberate `set model fable` is never guarded,
    // and a later flagless re-ensure won't clobber this pin).
    setDesiredModelSource(record, "explicit");
    await writeSessionRecord(record);
    result = { record, resumed: false };
  } else {
    result = await runSessionSetModelDirect({
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

  if (ownerToRecycle) {
    await terminateQueueOwnerForSession(options.sessionId);
    result.ownerRestarted = true;
    if (options.verbose) {
      process.stderr.write(
        `[acpx] restarted queue owner for session ${options.sessionId} to bind model "${options.modelId}"\n`,
      );
    }
  }

  return result;
}

export async function setSessionConfigOption(
  options: SessionSetConfigOptionOptions,
): Promise<SessionSetConfigOptionResult> {
  // CLI-verb path: refuse if a turn is in flight, then recycle the owner after the
  // apply below (setDesiredConfigOption also syncs session_options.effort, which
  // the fresh owner reads into sessionContext). Internal/replay callers leave
  // recycleOwner off (multi-caller guard) — they already cold-reconnect.
  const ownerToRecycle = options.recycleOwner
    ? await refuseTurnInFlightForRecycle(
        options.sessionId,
        () => new ConfigOptionTurnInFlightError(options.configId, options.sessionName),
      )
    : false;

  let result: SessionSetConfigOptionResult;
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
    result = { record, response: ownerResponse, resumed: false };
  } else {
    result = await runSessionSetConfigOptionDirect({
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

  if (ownerToRecycle) {
    await terminateQueueOwnerForSession(options.sessionId);
    result.ownerRestarted = true;
    if (options.verbose) {
      process.stderr.write(
        `[acpx] restarted queue owner for session ${options.sessionId} to bind config option "${options.configId}"\n`,
      );
    }
  }

  return result;
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
  const ownerAlive = liveness.alive;

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

// Move a session to a different credential PROFILE in place — the unified
// primitive behind both SDK subscription moves (sub1↔sub2) and claude-pty bridge
// moves (bridge1↔bridge2). Like setSessionSubscription, a profile is resolved
// from the record on every spawn (CLAUDE_CONFIG_DIR for subscriptions, the
// bridge's HOME for claude-home), so the durable move is the record edit +
// transcript port (switchSessionAccount); binding it requires a respawn:
//   COLD (no live owner) → record edit only; the next spawn resolves the new dir.
//   LIVE (queue owner holds a client on the old credential) → after the record
//     edit, terminate the owner so the next prompt cold-spawns on the new
//     credential (resuming the ported transcript). Refuse if a turn is in flight.
// The caller (handleSetProfile) guards the credential-class constraint before
// invoking this; switchSessionAccount with reason "manual" does not assert it.
export async function setSessionProfile(
  options: SessionSetProfileOptions,
): Promise<SessionSetProfileResult> {
  const liveness = await readQueueOwnerLiveness(options.sessionId);
  const ownerAlive = liveness.alive;

  if (ownerAlive) {
    const active = await tryQueryActiveTurnOnRunningOwner(options.sessionId);
    if (active === true) {
      throw new ProfileTurnInFlightError(options.sessionName);
    }
  }

  const record = await resolveSessionRecord(options.sessionId);
  const { fromProfile, toProfile, transcriptCopied } = await switchSessionAccount(
    record,
    options.profileId,
    "manual",
    options.loadOpts,
  );
  await writeSessionRecord(record);

  let ownerRestarted = false;
  if (ownerAlive) {
    await terminateQueueOwnerForSession(options.sessionId);
    ownerRestarted = true;
    if (options.verbose) {
      process.stderr.write(
        `[acpx] restarted queue owner for session ${options.sessionId} to bind profile "${toProfile}"\n`,
      );
    }
  }

  return { record, from: fromProfile, to: toProfile, transcriptCopied, ownerRestarted };
}

// brick://f1f0b3ea — recycle a live idle owner after the write, mirroring the rest
// of the setter family (setSessionModel/ConfigOption/Subscription/Profile). Without
// it, a warm owner survives the `set` and re-persists its stale spawn-time snapshot
// on the next turn, clobbering the change back (independent staging TE, brick://a97a383f
// defect #1; deterministic warm-owner repro verification/repro-warm-owner-clobber.sh).
// refuseTurnInFlightForLiveOwner returns whether a live owner exists → recycle it.
// Unconditional recycle is safe: this setter is called ONLY from the CLI-verb handler
// handleSetAutoFailover (never an internal/replay path) — guarded by T5.1e.
export async function setSessionAutoFailover(
  options: SessionSetAutoFailoverOptions,
): Promise<SessionSetAutoFailoverResult> {
  const ownerAlive = await refuseTurnInFlightForLiveOwner(
    options.sessionId,
    () => new ConfigOptionTurnInFlightError("auto-failover", options.sessionName),
  );

  const record = await resolveSessionRecord(options.sessionId);
  const acpx: NonNullable<SessionRecord["acpx"]> = { ...record.acpx };
  acpx.session_options = {
    ...acpx.session_options,
    auto_failover: options.autoFailover,
  };
  record.acpx = acpx;
  await writeSessionRecord(record);

  const result: SessionSetAutoFailoverResult = { record, autoFailover: options.autoFailover };
  if (ownerAlive) {
    await terminateQueueOwnerForSession(options.sessionId);
    result.ownerRestarted = true;
  }
  return result;
}

// brick://4d517be2 — set the per-session autonomous-selection disable knob (mirror
// setSessionAutoFailover). brick://f1f0b3ea — recycles the live idle owner (see above).
export async function setSessionAutoSubscription(
  options: SessionSetAutoSubscriptionOptions,
): Promise<SessionSetAutoSubscriptionResult> {
  const ownerAlive = await refuseTurnInFlightForLiveOwner(
    options.sessionId,
    () => new ConfigOptionTurnInFlightError("auto-subscription", options.sessionName),
  );

  const record = await resolveSessionRecord(options.sessionId);
  const acpx: NonNullable<SessionRecord["acpx"]> = { ...record.acpx };
  acpx.session_options = {
    ...acpx.session_options,
    auto_subscription: options.autoSubscription,
  };
  record.acpx = acpx;
  await writeSessionRecord(record);

  const result: SessionSetAutoSubscriptionResult = {
    record,
    autoSubscription: options.autoSubscription,
  };
  if (ownerAlive) {
    await terminateQueueOwnerForSession(options.sessionId);
    result.ownerRestarted = true;
  }
  return result;
}

// brick://4d517be2 — set the per-session fable→opus degrade opt-in (mirror
// setSessionAutoFailover). brick://f1f0b3ea — recycles the live idle owner for
// family-consistency (same stale-snapshot class; not yet field-reported).
export async function setSessionFableDegrade(
  options: SessionSetFableDegradeOptions,
): Promise<SessionSetFableDegradeResult> {
  const ownerAlive = await refuseTurnInFlightForLiveOwner(
    options.sessionId,
    () => new ConfigOptionTurnInFlightError("fable-degrade", options.sessionName),
  );

  const record = await resolveSessionRecord(options.sessionId);
  const acpx: NonNullable<SessionRecord["acpx"]> = { ...record.acpx };
  acpx.session_options = {
    ...acpx.session_options,
    fable_degrade_ok: options.fableDegradeOk,
  };
  record.acpx = acpx;
  await writeSessionRecord(record);

  const result: SessionSetFableDegradeResult = { record, fableDegradeOk: options.fableDegradeOk };
  if (ownerAlive) {
    await terminateQueueOwnerForSession(options.sessionId);
    result.ownerRestarted = true;
  }
  return result;
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

export type CloseSessionOptions = {
  // Default true. `--no-drain` is the explicit escape hatch back to the old
  // destroy-on-close behaviour.
  drain?: boolean;
  drainTimeoutMs?: number;
  verbose?: boolean;
};

// What the close learned about the custody it was about to destroy.
//
// `attempted:true, reachedOwner:false` is the honest shape for an owner that was
// already gone, unreachable, or still running pre-drain code. The caller has to
// be able to tell "nothing was in flight" from "we could not ask" — collapsing
// those two into one is how the fallback ended up guessing for six weeks.
export type SessionCloseDrainReport = {
  attempted: boolean;
  reachedOwner: boolean;
  turnSettled?: boolean;
  activeTurnAtEntry?: boolean;
  undelivered: QueueDrainedDelivery[];
};

export type SessionCloseResult = {
  record: SessionRecord;
  drain: SessionCloseDrainReport;
};

// D1 step 0.5 — THE BARRIER. Best-effort exactly like step 1
// (`tryCloseSessionOnRunningOwner`): a drain that cannot happen never blocks a
// close, because an orchestrator that cannot close a worker is a worse failure
// than a lost FYI. What changes is that the loss is no longer SILENT.
async function drainCustodyBeforeClose(
  sessionId: string,
  options: CloseSessionOptions,
): Promise<SessionCloseDrainReport> {
  if (options.drain === false) {
    return { attempted: false, reachedOwner: false, undelivered: [] };
  }

  const report = await drainQueueOwnerForSession({
    sessionId,
    reason: "session-close",
    timeoutMs: options.drainTimeoutMs ?? DEFAULT_CLOSE_DRAIN_TIMEOUT_MS,
    verbose: options.verbose,
  }).catch(() => undefined);

  if (!report) {
    return { attempted: true, reachedOwner: false, undelivered: [] };
  }
  return {
    attempted: true,
    reachedOwner: true,
    turnSettled: report.turnSettled,
    activeTurnAtEntry: report.activeTurnAtEntry,
    undelivered: report.undelivered,
  };
}

export async function closeSession(
  sessionId: string,
  options: CloseSessionOptions = {},
): Promise<SessionCloseResult> {
  const record = await resolveSessionRecord(sessionId);

  // Step 0.5 — ask the owner to give up its custody honestly BEFORE anything
  // kills it. Until this existed, step 2 below actively killed the very process
  // that was mid-handoff of an accepted message, and the only record of that
  // message was a JavaScript array inside it.
  const drain = await drainCustodyBeforeClose(record.acpxRecordId, options);

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

  return { record, drain };
}

export type SessionOwnerStatusClassification =
  | "healthy"
  | "idle_no_owner"
  | "recoverable_owner"
  | "socket_unreachable"
  | "closed_ignored";

export type SessionOwnerStatus = QueueOwnerLiveness & {
  parentSessionId?: string;
  kind?: SessionRecord["kind"];
  closed: boolean;
  ignored: boolean;
  classification: SessionOwnerStatusClassification;
};

export type SessionOwnerStatusBatch = {
  scope: "all_open" | "descendants";
  rootSessionId?: string;
  count: number;
  recoverableCount: number;
  ignoredCount: number;
  sessions: SessionOwnerStatus[];
};

// Read-only owner-liveness probe for a session. Resolves the caller-supplied id
// (acpx record id, ACP session id, or unique suffix — same as `prompt -s`) to its
// record, then reads the queue lease keyed by `record.acpxRecordId`. Never reaps.
export async function readSessionOwnerStatus(sessionId: string): Promise<SessionOwnerStatus> {
  const record = await resolveSessionRecord(sessionId);
  return await readOwnerStatusForRecord(record);
}

export async function readAllSessionOwnerStatuses(): Promise<SessionOwnerStatusBatch> {
  const records = (await listSessions()).filter((record) => record.closed !== true);
  const sessions = await Promise.all(
    records.map(async (record) => await readOwnerStatusForRecord(record)),
  );
  return ownerStatusBatch("all_open", undefined, sessions);
}

export async function readDescendantSessionOwnerStatuses(
  rootSessionId: string,
): Promise<SessionOwnerStatusBatch> {
  const root = await resolveSessionRecord(rootSessionId);
  const descendants = descendantRecords(root.acpxRecordId, await listSessions());
  const sessions = await Promise.all(
    descendants.map(async (record) => await readOwnerStatusForRecord(record)),
  );
  return ownerStatusBatch("descendants", root.acpxRecordId, sessions);
}

function ownerStatusBatch(
  scope: SessionOwnerStatusBatch["scope"],
  rootSessionId: string | undefined,
  sessions: SessionOwnerStatus[],
): SessionOwnerStatusBatch {
  return {
    scope,
    ...(rootSessionId ? { rootSessionId } : {}),
    count: sessions.length,
    recoverableCount: sessions.filter((status) => status.recoverable).length,
    ignoredCount: sessions.filter((status) => status.ignored).length,
    sessions,
  };
}

function childrenByParentSessionId(records: SessionRecord[]): Map<string, SessionRecord[]> {
  const childrenByParent = new Map<string, SessionRecord[]>();
  for (const record of records) {
    if (!record.parentSessionId) {
      continue;
    }
    childrenByParent.set(record.parentSessionId, [
      ...(childrenByParent.get(record.parentSessionId) ?? []),
      record,
    ]);
  }
  return childrenByParent;
}

function descendantRecords(rootSessionId: string, records: SessionRecord[]): SessionRecord[] {
  const childrenByParent = childrenByParentSessionId(records);
  const descendants: SessionRecord[] = [];
  const queue = [...(childrenByParent.get(rootSessionId) ?? [])];
  const seen = new Set<string>([rootSessionId]);
  while (queue.length > 0) {
    const record = queue.shift();
    if (!record || seen.has(record.acpxRecordId)) {
      continue;
    }
    seen.add(record.acpxRecordId);
    descendants.push(record);
    queue.push(...(childrenByParent.get(record.acpxRecordId) ?? []));
  }
  return descendants.toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

async function readOwnerStatusForRecord(record: SessionRecord): Promise<SessionOwnerStatus> {
  const state = await readQueueOwnerState(record.acpxRecordId);
  const closed = record.closed === true;
  return {
    ...state,
    ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
    ...(record.kind ? { kind: record.kind } : {}),
    closed,
    ignored: closed,
    classification: classifySessionOwnerStatus(state, closed),
    recoverable: closed ? false : state.recoverable,
  };
}

function classifySessionOwnerStatus(
  state: QueueOwnerLiveness,
  closed: boolean,
): SessionOwnerStatusClassification {
  if (closed) {
    return "closed_ignored";
  }
  if (state.state === "no_owner") {
    return "idle_no_owner";
  }
  if (state.recoverable) {
    return "recoverable_owner";
  }
  if (state.state === "socket_unreachable") {
    return "socket_unreachable";
  }
  return "healthy";
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
