import fs from "node:fs/promises";
import path from "node:path";
import { releaseHarnessConfigDir } from "../../acp/harness-config-dir.js";
import {
  ConfigOptionQueuedWorkError,
  ConfigOptionTurnInFlightError,
  ModelTurnInFlightError,
  ProfileTurnInFlightError,
  SubscriptionTurnInFlightError,
} from "../../errors.js";
import { switchSessionAccount } from "../../runtime/engine/account-seam.js";
import { switchSessionSubscription } from "../../runtime/engine/subscription-switch.js";
import { applyDepthOutcomeToRecord } from "../../session/depth-application.js";
import {
  setCurrentModelId,
  setDesiredConfigOption,
  setDesiredModeId,
  setDesiredModelId,
  setDesiredModelSource,
} from "../../session/mode-preference.js";
import {
  assertLiveModelChangeRoutable,
  assertRecordModelSupported,
} from "../../session/model-application.js";
import { OUTPUT_STYLE_CONFIG_ID, outputStyleChangePending } from "../../session/output-style.js";
import {
  resolveSessionRecord,
  listSessions,
  writeSessionRecord,
  writeSessionRecordAtBoundaryWithLifecycle,
  writeSessionRecordWithLifecycle,
  isoNow,
} from "../../session/persistence.js";
import type {
  SessionRecord,
  SessionSetConfigOptionResult,
  SessionSetDepthResult,
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
  trySetDepthOnRunningOwner,
  trySetModelOnRunningOwner,
  trySetModeOnRunningOwner,
} from "../queue/ipc.js";
import { readQueueOwnerRecord } from "../queue/lease-store.js";
import { DEFAULT_CLOSE_DRAIN_TIMEOUT_MS } from "./contracts.js";
import type {
  SessionCancelOptions,
  SessionCancelResult,
  SessionSetAutoFailoverOptions,
  SessionSetAutoFailoverResult,
  SessionSetAutoSubscriptionOptions,
  SessionSetAutoSubscriptionResult,
  SessionSetConfigOptionOptions,
  SessionSetDepthOptions,
  SessionSetFableDegradeOptions,
  SessionSetFableDegradeResult,
  SessionSetModelOptions,
  SessionSetOutputStyleOptions,
  SessionSetOutputStyleResult,
  SessionSetModeOptions,
  SessionSetProfileOptions,
  SessionSetProfileResult,
  SessionSetSubscriptionOptions,
  SessionSetSubscriptionResult,
} from "./contracts.js";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetDepthDirect,
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
  // ⚠️ ORDER IS THE FIX. This refusal runs
  // BEFORE `trySetModelOnRunningOwner` / `runSessionSetModelDirect`, so a harness
  // whose model mechanism acpx cannot route never gets a value persisted it can
  // never apply — which is what made such a session unrecoverable, including
  // by setting the model back. Do not move it below the apply.
  assertLiveModelChangeRoutable(record);
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

/**
 * Live thinking-depth change on a `mode`-mechanism harness (brick a3c65f0f).
 *
 * ⚠️ Mechanism-gated by the CALLER (`handleSetConfigOption` dispatches here only
 * when the session's depth mechanism is `mode`) — this function never inspects the
 * harness itself, so a future mode-mechanism harness works without edits here.
 *
 * Owner-first, direct-connect fallback — the same shape as {@link setSessionMode}.
 * The PROJECTION runs at whichever seat holds the live advertisement (owner-side on
 * the IPC arm, connection-side on the direct arm); this function only persists the
 * outcome ({@link applyDepthOutcomeToRecord}) so both arms leave identical record
 * state. Deliberately NO owner recycle and NO turn-in-flight refusal: the change
 * rides `session/set_mode`, which the harness accepts mid-turn, and an owner
 * restart replays `desired_mode_id` (parity with the `set-mode` verb).
 */
export async function setSessionDepth(
  options: SessionSetDepthOptions,
): Promise<SessionSetDepthResult> {
  const ownerProjection = await trySetDepthOnRunningOwner(
    options.sessionId,
    options.requested,
    options.timeoutMs,
    options.verbose,
  );
  if (ownerProjection) {
    const record = await resolveSessionRecord(options.sessionId);
    applyDepthOutcomeToRecord(record, ownerProjection);
    await writeSessionRecord(record);
    return {
      record,
      projection: ownerProjection,
      resumed: false,
    };
  }

  return await runSessionSetDepthDirect({
    sessionRecordId: options.sessionId,
    requested: options.requested,
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

/**
 * brick://874fee67 — set the per-session Claude Code output style.
 *
 * ⚠️ THIS SETTER DELIBERATELY BREAKS THE FAMILY PATTERN, in one direction only:
 * **it does not refuse while a turn is in flight.** Every sibling above throws
 * `ConfigOptionTurnInFlightError` there. Here the write is ACCEPTED at any time
 * and only the RECYCLE is deferred:
 *
 *   validate → persist → idle?          → recycle now
 *                      → turn in flight → PENDING; the owner recycles itself at
 *                                         the turn boundary (or on its idle check)
 *
 * Why accepting mid-turn is safe here when it would not be for a live-applied
 * option: the forbidden state this feature is designed around is *the live
 * harness config moved while the system prompt is stale*. This setter never
 * moves the live harness config at all — it writes OUR record, and the next
 * query build reads it. `applyFlagSettings` is never called for output style
 * anywhere in the codebase. So the forbidden state is unreachable by
 * construction rather than by discipline, and the only window is an honest
 * `pending` bounded by the current turn. Turns routinely run for minutes; the
 * style is consumed only when the next query is built.
 *
 * ⚠️ THE QUEUED-BEHIND REFUSAL STAYS. It is a DIFFERENT hazard: an owner recycle
 * discards the owner's IN-MEMORY prompt queue (acpx has no persisted prompt
 * queue — the owner's whole on-disk footprint is a `.lock` and a `.sock`), so a
 * prompt already handed to the owner and waiting behind the active turn can be
 * dropped. The active turn is protected by deferring the recycle; work queued
 * behind it is not. Refusing converts a silent prompt-drop into a visible
 * "try again when idle". This exposure is pre-existing and shared with `set
 * effort` / `subscription` / `profile` / `auto-failover` — tracked as
 * https://acpx.devbox.nativai.de/?brick=47efa4ee; fixing it for the whole family
 * is out of scope here.
 *
 * A second change while one is pending is LAST-WRITE-WINS, with no conflict
 * logic, because `pending` is a comparison of two values and not a queue of
 * intents: set B then C → the recycle builds with C. And setting the style back
 * to what is already applied makes `pending` false again, so no recycle fires at
 * all — which is correct, and is the behaviour an intent-queue implementation
 * gets wrong.
 */
export async function setSessionOutputStyle(
  options: SessionSetOutputStyleOptions,
): Promise<SessionSetOutputStyleResult> {
  const liveness = await readQueueOwnerLiveness(options.sessionId);
  const ownerAlive = liveness.alive;

  // Refuse ONLY for queued-behind work — never for the active turn itself.
  if (ownerAlive && liveness.queueDepth > 0) {
    throw new ConfigOptionQueuedWorkError(OUTPUT_STYLE_CONFIG_ID, options.sessionName);
  }

  const turnActive = ownerAlive
    ? (await tryQueryActiveTurnOnRunningOwner(options.sessionId)) === true
    : false;

  const record = await resolveSessionRecord(options.sessionId);
  const acpx: NonNullable<SessionRecord["acpx"]> = { ...record.acpx };
  acpx.session_options = {
    ...acpx.session_options,
    output_style: options.outputStyle,
  };
  record.acpx = acpx;
  // Keep the live layer in step with the durable one, exactly as the generic
  // `set` path does — a reconnect replays `desired_config_options`.
  setDesiredConfigOption(record, OUTPUT_STYLE_CONFIG_ID, options.outputStyle);
  await writeSessionRecord(record);

  const result: SessionSetOutputStyleResult = { record, outputStyle: options.outputStyle };

  // Nothing to bind: the record already matched what the live query was built
  // with. Recycling here would be a pointless restart — this is the change-back
  // case (applied=A, set B, set A again), and performing a recycle anyway is the
  // tell of an intent-queue implementation.
  if (!outputStyleChangePending(record)) {
    return result;
  }

  if (turnActive) {
    // ACCEPTED, not applied. The owner discovers the mismatch itself at its turn
    // boundary — we send it nothing, precisely so nothing can be lost in transit.
    result.pending = true;
    return result;
  }

  if (ownerAlive) {
    // Path (C): idle owner, recycle now so the very next prompt cold-spawns and
    // resumes with the new style. Which of the three paths runs is an
    // optimisation; THAT ONE OF THEM RUNS IS NOT.
    //
    // ⚠️ THE RECYCLE IS LOAD-BEARING — do not "optimise" it away on the grounds
    // that the adapter process is already right there (design brick://4d16ab8b;
    // landmine found by the U1 adapter lane). The adapter's `getOrCreateSession`
    // short-circuits on a session fingerprint and returns an ALREADY-LIVE session
    // UNTOUCHED, so a `session/load` carrying a changed style into a still-running
    // adapter process DOES NOTHING — silently. Killing the owner first is what
    // guarantees the load always hits a fresh adapter; the recycle is not merely
    // the mechanism by which the style takes effect, it is what makes the load
    // path work at all.
    //
    // A shortcut here would fail in the worst available way: the record would show
    // the new style AND the harness config readback would agree, and only the
    // model's actual behaviour would disagree — the one signal no automated test
    // reads by default. `test/output-style-no-live-apply.test.ts` pins the
    // structural half of this.
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

  // Self-close detection FIRST — it decides which of the two arms runs.
  const selfOwnerPid = await detectSelfOwnedOwnerPid(record.acpxRecordId);
  if (selfOwnerPid !== undefined) {
    return await closeSelfOwnedSession(record, selfOwnerPid, options);
  }

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

  releaseConfigDirOnTerminalClose(record);

  return { record, drain };
}

// ---------------------------------------------------------------------------
// brick://f4f1fa54 — SELF-CLOSE. A session may be closed BY ITSELF: the agent
// running inside the session executes `acpx sessions close <own id>` (or an
// equivalent UI-driven request), so the CLI process performing the close is a
// DESCENDANT of the very queue owner the close must terminate (owner → ACP
// adapter → agent → this CLI). The non-self sequence above — drain, ACP
// shutdown, terminate the owner (waits for its exit), and only THEN write
// `closed: true` — kills the caller's own process tree mid-close, and whether
// the terminal write ever lands is a race the close loses exactly when it
// matters. Observed live: a session that self-closed stayed `closed:false`.
//
// The self arm therefore INVERTS the order: persist the terminal record FIRST
// (privileged write, same as the non-self path — nothing can un-close it
// afterwards), and terminate the own owner pid as the FINAL act. The drain and
// the best-effort ACP shutdown are SKIPPED in this arm: both target the owner
// being terminated, and the in-flight turn IS the close call itself — there is
// nothing honest to drain. The adapter (`record.pid`) kill is skipped too: the
// adapter sits on the doomed owner→caller path and taking it down kills the
// caller before it can return. The config-dir release is skipped as well — with
// the owner still ALIVE at that point, `dropStaleHolders` would retain the
// directory anyway (see the 433f6bf8 block above); the orphan sweep remains the
// guarantee, and it collects the dir once the owner is gone. The lease/socket
// tidy-up is likewise left to the next cold spawn: a dead-owner lease is the
// `recoverable` state, auto-cleaned on the next submit (North Star invariant —
// cleanup never signals), so no work is skipped that would not be redone.
// ---------------------------------------------------------------------------

// Bounded walk so a corrupt /proc entry can never spin the close. Deeper than
// any real owner→adapter→agent→CLI chain, with headroom for containers.
const MAX_SELF_ANCESTOR_WALK_DEPTH = 64;

// Field 4 of /proc/<pid>/stat is the parent pid. `comm` (field 2) may contain
// spaces and parens, so parse everything after the LAST `)` — same convention
// as parseLinuxProcStatStartTime in lease-store.ts.
function parseLinuxProcStatParentPid(payload: string): number | undefined {
  const endCommandIndex = payload.lastIndexOf(")");
  if (endCommandIndex < 0) {
    return undefined;
  }
  const fieldsFromState = payload
    .slice(endCommandIndex + 1)
    .trim()
    .split(/\s+/);
  const parentPid = Number(fieldsFromState[1]);
  return Number.isInteger(parentPid) && parentPid > 0 ? parentPid : undefined;
}

/**
 * The PPid chain above `startPid` (default: this process), innermost first.
 * /proc-based, so Linux-only — the fleet's deployment target — and bounded by
 * {@link MAX_SELF_ANCESTOR_WALK_DEPTH}. Stops before pid 1: an ancestry claim
 * against init proves nothing (every containerized process descends from it).
 * Exported for tests, which prove the walk against REAL spawned processes.
 */
export async function readSelfAncestorPids(startPid: number = process.pid): Promise<number[]> {
  const ancestors: number[] = [];
  if (process.platform !== "linux") {
    return ancestors;
  }
  let current = startPid;
  for (let depth = 0; depth < MAX_SELF_ANCESTOR_WALK_DEPTH; depth += 1) {
    let parentPid: number | undefined;
    try {
      parentPid = parseLinuxProcStatParentPid(await fs.readFile(`/proc/${current}/stat`, "utf8"));
    } catch {
      return ancestors;
    }
    if (parentPid === undefined || parentPid <= 1) {
      return ancestors;
    }
    ancestors.push(parentPid);
    current = parentPid;
  }
  return ancestors;
}

/**
 * True when `pid` is this process itself or one of its ancestors — the
 * self-close signal that the session's queue owner would be terminating the
 * caller's own process tree. The direct-parent check is cross-platform
 * (`process.ppid`); deeper ancestry needs the /proc walk. A stale lease whose
 * pid was REUSED cannot reach a self-close verdict through this alone: the
 * caller additionally requires the lease's process identity to still match
 * (see {@link detectSelfOwnedOwnerPid}), mirroring `canSignalQueueOwner`.
 */
export async function isPidSelfOrAncestor(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (pid === process.pid || pid === process.ppid) {
    return true;
  }
  return (await readSelfAncestorPids()).includes(pid);
}

/**
 * The session's owner pid when terminating it would terminate THIS process
 * tree — i.e. a self-close — and the pid is safe to signal (alive, lease
 * identity still matching). The identity guard mirrors `canSignalQueueOwner`
 * in lease-store.ts: a dead owner has nothing to terminate, and a pid-reused
 * lease must never cause this process to signal an unrelated process that
 * happens to sit in its ancestry.
 */
async function detectSelfOwnedOwnerPid(sessionId: string): Promise<number | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (owner?.pid === undefined || !(await isPidSelfOrAncestor(owner.pid))) {
    return undefined;
  }
  const ownerState = await readQueueOwnerState(sessionId);
  if (!ownerState.pidAlive || ownerState.processIdentityMatched === false) {
    return undefined;
  }
  return owner.pid;
}

/**
 * The SELF-CLOSE arm (brick://f4f1fa54): the session being closed owns the
 * process tree this CLI is running in, so the terminal record is written FIRST
 * and the own owner pid is terminated as the FINAL act. See the block above
 * {@link closeSession} for why each non-self step is skipped here.
 *
 * The ordering IS the fix: a process killed after the privileged write cannot
 * un-close the record, so even a caller that dies mid-return leaves a
 * `closed: true` session behind — the observed failure (self-close declared,
 * record stayed open) becomes structurally impossible.
 */
async function closeSelfOwnedSession(
  record: SessionRecord,
  ownerPid: number,
  options: CloseSessionOptions,
): Promise<SessionCloseResult> {
  record.pid = undefined;
  record.closed = true;
  record.closedAt = isoNow();
  // Privileged write: same daemon-authorized close as the non-self path —
  // bypass the read-preserve-lifecycle step so `closed: true` lands on disk.
  await writeSessionRecordAtBoundaryWithLifecycle(record);

  if (options.verbose) {
    process.stderr.write(
      `[acpx] self-close: terminal record persisted; terminating own owner pid ${ownerPid}\n`,
    );
  }
  // THE FINAL ACT. Single-pid terminate (SIGTERM → grace → SIGKILL), mirroring
  // terminateQueueOwnerForSession's kill of a confirmed owner — but the wait
  // here is best-effort by construction: the caller may be torn down as part of
  // the owner's shutdown cascade before the wait resolves, and the record is
  // already on disk. No process-group sweep: the caller itself is a group
  // member, and sweeping would be self-destruction beyond the close's mandate.
  await terminateProcess(ownerPid);

  return {
    record,
    drain: { attempted: false, reachedOwner: false, undelivered: [] },
  };
}

/**
 * THE TERMINAL CLOSE IS WHERE THE CONFIG DIR GOES (brick 433f6bf8).
 *
 * ## Why here and not in `AcpClient.close()`, which already releases
 *
 * `AcpClient.close()` releases too, and that is the fast path — but it needs a
 * LIVE CLIENT. The sessions that leak are exactly the ones with no client left:
 * an owner released for idleness, `kill -9`, a pod eviction. **Measured on the
 * deployed build 2026-09-08: eight `/tmp/acpx-pi-<id>` dirs, ~320 KB each, every
 * record `closed:true` carrying the right `harness_config_dir`, and EVERY holder
 * pid dead** — eight instances of "the client that would have released it was
 * already gone". They had survived ~16 h and more than two sweep intervals.
 *
 * `closeSession` is the one place that cannot be skipped by that: it is the
 * canonical terminal close, acpx-ui delegates to the verb that calls it, and
 * `markSessionAsTemplate` — the second authorized writer of `closed` — calls it
 * too. Releasing here therefore covers every close path there is.
 *
 * ## ⚠️ IT RELEASES, IT DOES NOT DELETE — and the ordering is what makes that work
 *
 * `terminateQueueOwnerForSession` above WAITS for the owner to exit (SIGTERM,
 * grace, SIGKILL, grace), so by this line the owner's holder pid is genuinely
 * dead and `dropStaleHolders` drops it deterministically. A second client that is
 * still ALIVE keeps its holder, the directory is RETAINED, and the orphan sweep
 * collects it later — which is the 4a6fdda0 invariant (one session, two clients,
 * one directory) preserved rather than re-litigated. This can therefore never
 * delete a directory out from under a live turn.
 *
 * ## ⚠️ BEST-EFFORT, AND NEVER FATAL TO A CLOSE
 *
 * A close that failed because the tidy-up threw would be strictly worse than a
 * directory that survives to the sweep. The sweep remains the guarantee; this is
 * the deterministic fast path.
 *
 * ⚠️ Consequence worth knowing: acpx-ui's "Show injected primer" reads this
 * directory for its `exact:true` config-dir source, so a closed pi session loses
 * that source at close rather than at the next sweep. That is a move of an
 * existing loss, not a new one — the sweep already removes these on a
 * `closedRecord` verdict — and the modal has a documented fallback.
 */
function releaseConfigDirOnTerminalClose(record: SessionRecord): void {
  const dir = record.acpx?.harness_config_dir;
  if (dir === undefined) {
    return;
  }
  try {
    releaseHarnessConfigDir(dir, undefined);
  } catch {
    // Best-effort by design — see above. The orphan sweep is the guarantee.
  }
}

export type SessionReopenResult = {
  record: SessionRecord;
  /** false ⇒ the session was already open and nothing was written (idempotent). */
  reopened: boolean;
};

/**
 * brick://16712ece — the CLI-reachable inverse of {@link closeSession}.
 *
 * Until this existed, a closed session had NO acpx verb that revived it:
 * `sessions recover` returns `{"ownerFound":false,"state":"no_owner"}` at rc=0
 * and leaves `closed` true (it force-restarts a WEDGED owner, which is a
 * different problem), and `sessions ensure` creates a fresh empty session
 * instead — so the only route was acpx-ui's Reopen button or `send-message.sh
 * --reopen`, i.e. nothing an operator sitting at the CLI that PRINTED the
 * refusal could run. {@link SessionClosedError} now names this verb; the CLI and
 * its own error text have to keep agreeing, which is what
 * test/session-closed-recovery.test.ts pins.
 *
 * Deliberately narrow — it flips the lifecycle bits and nothing else:
 * - No owner is spawned. A reopened session cold-respawns on its next prompt,
 *   exactly as an idle-reclaimed one does.
 * - **Subagents are NOT cascaded open.** `closeSession` closes them because a
 *   close is an operational teardown of live processes; reopening one session is
 *   not a request to write N other records the operator never named. Pinned by
 *   "reopen does not cascade to subagents" in the test file above.
 *
 * Uses the privileged lifecycle write for the same reason `closeSession` does:
 * the ordinary daemon write READ-PRESERVES `closed`/`closed_at` from disk (see
 * `writeSessionRecord`'s doc comment), so a plain write here would report
 * success and leave the record closed.
 */
export async function reopenSession(sessionId: string): Promise<SessionReopenResult> {
  const record = await resolveSessionRecord(sessionId);
  if (record.closed !== true) {
    return { record, reopened: false };
  }

  record.closed = false;
  record.closedAt = undefined;
  record.lastUsedAt = isoNow();
  await writeSessionRecordWithLifecycle(record);

  return { record, reopened: true };
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

/**
 * Transitive local descendants of `rootSessionId` in the `parentSessionId` graph,
 * newest-first. The `seen` set IS the cycle guard, which is why
 * `sessions set-parent` reuses this as its cycle check rather than walking again.
 */
export function descendantRecords(
  rootSessionId: string,
  records: SessionRecord[],
): SessionRecord[] {
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
