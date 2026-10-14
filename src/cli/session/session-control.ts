import fs from "node:fs/promises";
import { releaseHarnessConfigDir } from "../../acp/harness-config-dir.js";
import {
  ConfigOptionQueuedWorkError,
  ConfigOptionTurnInFlightError,
  ModelTurnInFlightError,
  ProfileTurnInFlightError,
  SubscriptionTurnInFlightError,
} from "../../errors.js";
import {
  classifyRecordedIdentity,
  getOwnProcessScope,
  identityScope,
  observeProcessIncarnation,
  validRecordPidIdentity,
  type ProcessBirthIdentity,
} from "../../process-identity.js";
import { terminateVerifiedProcess, type VerifiedTerminateOutcome } from "../../process-signal.js";
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
  abandonPendingSessionIndexUpdates,
  flushPendingSessionIndexUpdates,
  resolveSessionRecord,
  listSessionIndexEntries,
  loadSessionRecordBodyFromIndexEntry,
  readRawRecordClosedState,
  sessionBaseDir,
  writeSessionRecord,
  writeSessionRecordAtBoundaryWithLifecycle,
  writeSessionRecordWithLifecycle,
  isoNow,
} from "../../session/persistence.js";
import type { RawRecordFieldState } from "../../session/persistence.js";
import type { SessionIndexEntry } from "../../session/persistence/index.js";
import type {
  SessionRecord,
  SessionSetConfigOptionResult,
  SessionSetDepthResult,
  SessionSetModelResult,
  SessionSetModeResult,
} from "../../types.js";
import {
  drainQueueOwnerForSession,
  type QueueDrainedDelivery,
  type QueueOwnerLiveness,
  type QueueOwnerRecoveryResult,
  readQueueOwnerLiveness,
  readQueueOwnerState,
  recoverQueueOwnerForSession,
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

/**
 * brick ae547131 §8.4 — "alive" covers a local live owner AND a foreign one (rows L1, F1, F2), and an
 * UNKNOWN liveness counts as alive: such an owner is asked over its socket whether a turn is active
 * (the shared-volume socket works across pods), and refused only if it says so. The old rule read a
 * foreign owner as dead, skipped both the refusal and the recycle, and left it serving the old value.
 */
function isOwnerPossiblyAlive(liveness: QueueOwnerLiveness): boolean {
  return liveness.ownerFound && liveness.alive !== false;
}

async function refuseTurnInFlightForLiveOwner(
  sessionId: string,
  makeTurnInFlightError: () => Error,
): Promise<boolean> {
  const liveness = await readQueueOwnerLiveness(sessionId);
  const alive = isOwnerPossiblyAlive(liveness);
  if (alive) {
    const active = await tryQueryActiveTurnOnRunningOwner(sessionId);
    if (active === true) {
      throw makeTurnInFlightError();
    }
  }
  return alive;
}

type OwnerRecycle = { ownerRestarted: boolean; ownerRestartSkipped?: string };

/**
 * Recycles a live owner after a setting changed — and reports what happened. `ownerRestarted:true`
 * ONLY when the owner was actually stopped; a foreign or unverifiable owner is not signalled
 * (`ownerRestartSkipped`), and the setting takes effect at that owner's next start.
 */
async function recycleLiveOwner(sessionId: string): Promise<OwnerRecycle> {
  const outcome = await terminateQueueOwnerForSession(sessionId);
  return outcome.stopped
    ? { ownerRestarted: true }
    : { ownerRestarted: false, ownerRestartSkipped: outcome.reason };
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
    ? await refuseTurnInFlightForRecycle(options.sessionId, () => new ModelTurnInFlightError())
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
    Object.assign(result, await recycleLiveOwner(options.sessionId));
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
        () => new ConfigOptionTurnInFlightError(options.configId),
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
    Object.assign(result, await recycleLiveOwner(options.sessionId));
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
  const ownerAlive = isOwnerPossiblyAlive(liveness);

  if (ownerAlive) {
    const active = await tryQueryActiveTurnOnRunningOwner(options.sessionId);
    if (active === true) {
      throw new SubscriptionTurnInFlightError();
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
  let recycled: OwnerRecycle = { ownerRestarted: false };
  if (ownerAlive) {
    recycled = await recycleLiveOwner(options.sessionId);
    if (options.verbose && recycled.ownerRestarted) {
      process.stderr.write(
        `[acpx] restarted queue owner for session ${options.sessionId} to bind subscription "${to}"\n`,
      );
    }
  }

  return { record, from, to, transcriptCopied, ...recycled };
}

// Move a session to a different credential PROFILE in place — the unified
// primitive behind SDK subscription moves (sub1↔sub2). Like
// setSessionSubscription, a profile is resolved from the record on every spawn
// (CLAUDE_CONFIG_DIR for subscriptions), so the durable move is the record edit +
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
  const ownerAlive = isOwnerPossiblyAlive(liveness);

  if (ownerAlive) {
    const active = await tryQueryActiveTurnOnRunningOwner(options.sessionId);
    if (active === true) {
      throw new ProfileTurnInFlightError();
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

  let recycled: OwnerRecycle = { ownerRestarted: false };
  if (ownerAlive) {
    recycled = await recycleLiveOwner(options.sessionId);
    if (options.verbose && recycled.ownerRestarted) {
      process.stderr.write(
        `[acpx] restarted queue owner for session ${options.sessionId} to bind profile "${toProfile}"\n`,
      );
    }
  }

  return { record, from: fromProfile, to: toProfile, transcriptCopied, ...recycled };
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
    () => new ConfigOptionTurnInFlightError("auto-failover"),
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
    Object.assign(result, await recycleLiveOwner(options.sessionId));
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
  const ownerAlive = isOwnerPossiblyAlive(liveness);

  // Refuse ONLY for queued-behind work — never for the active turn itself.
  if (ownerAlive && liveness.queueDepth > 0) {
    throw new ConfigOptionQueuedWorkError(OUTPUT_STYLE_CONFIG_ID);
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
    Object.assign(result, await recycleLiveOwner(options.sessionId));
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
    () => new ConfigOptionTurnInFlightError("auto-subscription"),
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
    Object.assign(result, await recycleLiveOwner(options.sessionId));
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
    () => new ConfigOptionTurnInFlightError("fable-degrade"),
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
    Object.assign(result, await recycleLiveOwner(options.sessionId));
  }
  return result;
}

/**
 * What the close did to the ADAPTER at `record.pid` (brick ae547131 §8.1). `signalled:false` with a
 * reason is the normal shape for every record without a provable identity — including every record
 * written before 0a — and is reported, never guessed.
 */
export type SessionCloseAdapterKill = {
  signalled: boolean;
  reason?: "no-pid" | "no-identity" | "foreign" | "gone" | "unverified" | "self-close";
};

const ADAPTER_KILL_GRACE_MS = 1_500;

/**
 * Signals `record.pid` ONLY when its `pid_identity` is valid for it and still `matching` — SIGTERM,
 * grace, re-verify, SIGKILL. 🛑 `isLikelyMatchingProcess` is DELETED, not bypassed (Q6): it matched
 * ANY process with a `node` argv entry and returned TRUE when /proc could not be read, so after a
 * container restart `sessions close` on an old record signalled whatever now held the pid number —
 * atrium, or another agent mid-turn. A record with no identity is never signalled (T32a); its adapter
 * died with its owner's process group, or exits on stdin EOF (CONCEPT R13).
 */
async function killRecordedAdapter(record: SessionRecord): Promise<SessionCloseAdapterKill> {
  if (record.pid == null) {
    return { signalled: false, reason: "no-pid" };
  }
  const identity = validRecordPidIdentity(record.pid, record.pidIdentity);
  const outcome = await terminateVerifiedProcess(record.pid, identity, ADAPTER_KILL_GRACE_MS);
  if (outcome.signalled) {
    return { signalled: true };
  }
  if (outcome.gone) {
    return { signalled: false, reason: "gone" };
  }
  return { signalled: false, reason: refusedAdapterReason(outcome.refused) };
}

function refusedAdapterReason(
  refused: VerifiedTerminateOutcome["refused"],
): NonNullable<SessionCloseAdapterKill["reason"]> {
  if (refused === "refused:no-identity") {
    return "no-identity";
  }
  return refused === "refused:foreign" ? "foreign" : "unverified";
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

// What the close actually verified on disk after writing — the record-derived
// fact a caller (above all the CLI printer, brick 1bfb95ed deliverable 4) must
// report, instead of inferring success from the write call's own exit status.
export type SessionCloseRecordState =
  | { status: "read"; closed: RawRecordFieldState; closedAt: RawRecordFieldState }
  | { status: "read_failed"; error: string };

export type SessionCloseResult = {
  record: SessionRecord;
  drain: SessionCloseDrainReport;
  recordClosedState: SessionCloseRecordState;
  /** The queue owner was stopped (or there was none). false ⇒ `ownerStopSkipped` says why (§8.4). */
  ownerStopped: boolean;
  ownerStopSkipped?: string;
  adapterKill: SessionCloseAdapterKill;
};

// Re-reads `<id>.json` immediately after the terminal write, converting a
// throw (missing file, invalid JSON) into its own distinct outcome rather than
// letting it propagate and mask a close that otherwise succeeded.
async function readBackRecordClosedState(acpxRecordId: string): Promise<SessionCloseRecordState> {
  try {
    const raw = await readRawRecordClosedState(acpxRecordId);
    return { status: "read", closed: raw.closed, closedAt: raw.closedAt };
  } catch (error) {
    return { status: "read_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

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
  const selfOwner = await detectSelfOwnedOwner(record.acpxRecordId);
  if (selfOwner !== undefined) {
    return await closeSelfOwnedSession(record, selfOwner, options);
  }

  // The owner generation this close drains and sends `close_session` to — the ONLY one it may
  // retire (port of openclaw/acpx 44a0a18e). A successor that started meanwhile is never signalled.
  const drainedOwner = (await readQueueOwnerRecord(record.acpxRecordId)) ?? null;

  // Step 0.5 — ask the owner to give up its custody honestly BEFORE anything
  // kills it. Until this existed, step 2 below actively killed the very process
  // that was mid-handoff of an accepted message, and the only record of that
  // message was a JavaScript array inside it.
  const drain = await drainCustodyBeforeClose(record.acpxRecordId, options);

  await tryCloseSessionOnRunningOwner({ sessionId: record.acpxRecordId }).catch(() => {
    // Preserve local close semantics even if best-effort ACP session shutdown fails.
  });
  const ownerStop = await terminateQueueOwnerForSession(record.acpxRecordId, drainedOwner);
  const adapterKill = await killRecordedAdapter(record);
  if (options.verbose && !adapterKill.signalled && adapterKill.reason !== "no-pid") {
    process.stderr.write(
      `[acpx] close: adapter pid ${record.pid} not signalled (${adapterKill.reason})\n`,
    );
  }

  record.pid = undefined;
  record.pidIdentity = undefined;
  record.closed = true;
  record.closedAt = isoNow();
  // Privileged write: this is a daemon-authorized close — bypass the
  // read-preserve-lifecycle step so `closed: true` actually lands on disk.
  // See writeSessionRecord doc comment in repository.ts for the ownership rules.
  await writeSessionRecordAtBoundaryWithLifecycle(record);
  const recordClosedState = await readBackRecordClosedState(record.acpxRecordId);

  releaseConfigDirOnTerminalClose(record);

  // The close landed either way (an owner refuses turns on a closed record); whether the owner was
  // actually stopped is reported, never assumed. Phase 1b stops a foreign owner via its launcher.
  return {
    record,
    drain,
    recordClosedState,
    ownerStopped: ownerStop.stopped,
    ...(ownerStop.stopped ? {} : { ownerStopSkipped: ownerStop.reason }),
    adapterKill,
  };
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
// afterwards), and terminate the own owner pid as the FINAL act. The best-effort
// ACP shutdown is SKIPPED in this arm: it targets the owner being terminated.
// The drain runs with a ZERO timeout only (brick e50e171d): the in-flight turn IS
// the close call itself, so it must not be waited for, but the owner must still
// be TOLD a close is on so it settles that turn's delivery. The adapter (`record.pid`) kill is skipped too: the
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

type SelfOwner = { pid: number; identity: ProcessBirthIdentity };

/** The identity a lease's owner may be signalled with — local scope only (§8.3), or undefined. */
function localLeaseIdentity(
  processIdentity: Record<string, string> | undefined,
): ProcessBirthIdentity | undefined {
  const recorded = classifyRecordedIdentity(processIdentity);
  if (recorded.kind === "birth") {
    return identityScope(recorded.birth) === "local" ? recorded.birth : undefined;
  }
  // A pre-0a lease (no scope) with start ticks: by §4.5 it was written in this container.
  const own = getOwnProcessScope();
  return recorded.kind === "legacy" && recorded.startTicks && own
    ? { kind: "linux-proc", ...own, startTicks: recorded.startTicks }
    : undefined;
}

/**
 * The session's owner when terminating it would terminate THIS process tree — a self-close — and it
 * is safe to signal. brick ae547131 §8.3: the owner must first be in this reader's scope and provably
 * the recorded process (`matching`); only then is the pid-number ancestry check meaningful. A pid
 * recorded in another pid namespace can collide with a number in our own ancestry.
 */
async function detectSelfOwnedOwner(sessionId: string): Promise<SelfOwner | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  const identity = owner ? localLeaseIdentity(owner.processIdentity) : undefined;
  if (!owner || !identity || observeProcessIncarnation(owner.pid, identity) !== "matching") {
    return undefined;
  }
  return (await isPidSelfOrAncestor(owner.pid)) ? { pid: owner.pid, identity } : undefined;
}

/**
 * The self arm's SECOND index attempt (brick 19ee17ab, CONCEPTION §3.2b-4). The
 * privileged write's index update may have DEFERRED (lock timeout) — and this
 * process will not reach `beforeExit`: the terminate below ends it together with
 * its owner's process group (the owner's SIGTERM handler kills the group it
 * leads, `queue-owner-runtime`), so a deferred `closed:true` would die pending.
 * So the bounded second attempt runs HERE, before the terminate; whatever is
 * still pending after it is dropped with the WARNING now, while stderr still
 * exists. With nothing pending this takes no lock and prints nothing.
 */
async function landOrDropIndexUpdatesBeforeSelfTerminate(): Promise<void> {
  await flushPendingSessionIndexUpdates(sessionBaseDir()).catch(() => {
    // not a lock timeout (those defer, they do not throw): reported just below
  });
  abandonPendingSessionIndexUpdates("before the self-close terminate");
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
  selfOwner: SelfOwner,
  options: CloseSessionOptions,
): Promise<SessionCloseResult> {
  const ownerPid = selfOwner.pid;
  record.pid = undefined;
  record.pidIdentity = undefined;
  record.closed = true;
  record.closedAt = isoNow();
  // Privileged write: same daemon-authorized close as the non-self path —
  // bypass the read-preserve-lifecycle step so `closed: true` lands on disk.
  await writeSessionRecordAtBoundaryWithLifecycle(record);
  const recordClosedState = await readBackRecordClosedState(record.acpxRecordId);
  await landOrDropIndexUpdatesBeforeSelfTerminate();

  // brick e50e171d — TELL the own owner a close is on, without waiting. Its SIGTERM sweep then writes `done /
  // delivered_at_close` for the turn this close cuts (accepted = delivered under a deliberate close), and its
  // custody ends `SESSION_CLOSED_UNDELIVERED` (resend-safe, sender told) instead of `QUEUE_OWNER_SHUTDOWN` → a
  // re-drive into a closed record. ⚠️ The timeout MUST stay 0: the turn this drain would wait for IS the turn
  // running this close, so any wait is a wait on ourselves (why the self arm skipped the drain before). With 0 the
  // owner reports `turnSettled:false` at once. After the privileged write, before the kill; best-effort like the
  // non-self barrier — an owner that cannot be asked leaves today's behaviour. `--no-drain` still opts out.
  const drain = await drainCustodyBeforeClose(record.acpxRecordId, {
    ...options,
    drainTimeoutMs: 0,
  });

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
  // Through the verified signal (§8.3): re-checked immediately before each signal.
  await terminateVerifiedProcess(ownerPid, selfOwner.identity, ADAPTER_KILL_GRACE_MS);

  return {
    record,
    drain,
    recordClosedState,
    ownerStopped: true,
    adapterKill: { signalled: false, reason: "self-close" },
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

  const reopenedAt = isoNow();
  record.closed = false;
  record.closedAt = undefined;
  // THE WARRANT (brick 1bfb95ed deliverable 3) — the ONE thing the record-write
  // seam's monotonicity guard accepts as authorization for this exact
  // transition: present, and newer than the `closedAt` just cleared above. Set
  // it here, not inside the guard, because this is the one place that knows
  // the transition is deliberate.
  record.reopenedAt = reopenedAt;
  record.lastUsedAt = reopenedAt;
  await writeSessionRecordWithLifecycle(record);

  return { record, reopened: true };
}

export type SessionOwnerStatusClassification =
  | "healthy"
  | "idle_no_owner"
  | "recoverable_owner"
  | "socket_unreachable"
  | "closed_ignored"
  /** brick ae547131: the owner lives in another pid namespace (judged by heartbeat + ping). */
  | "foreign_owner"
  /** In our scope but its identity cannot be proven — never signalled. */
  | "owner_unverified";

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

/**
 * The batch scans (`--all`, `--descendants-of`) are built from INDEX ENTRIES (brick ac0be75e).
 * They used to start from `listSessions()`, which hydrates the messages log of EVERY record in
 * the store, closed ones included, before any filter runs. That cost ~1.6 MB of heap per record
 * and OOMed on a 3,540-record store. A status needs four record fields, so the scan reads record
 * BODIES only, never their messages, and keeps nothing of a body past its own check.
 *
 * Which store is the authority — the same split as the old `listSessions()` scan, so the output
 * matches it byte for byte: MEMBERSHIP comes from the index, every FIELD (`closed`,
 * `parentSessionId`, `kind`, and the `lastUsedAt` order) from the record.
 * - `--all` reads the body of EVERY index entry, open or closed, and keeps `record.closed !== true`.
 *   ⚠️ DO NOT pre-filter on `entry.closed` to skip the closed bodies. It looks like the obvious
 *   saving and it is a silent miss: an entry still marked closed after its record was reopened
 *   (torn until that session's next index flush) is a live session, and this verb exists to find
 *   live owners. The torn-closed row in `test/owner-status-index-scan.test.ts` goes red if you do.
 *   An entry still marked open after its record closed is dropped, because the record says closed.
 * - `--descendants-of` walks the index's seat and parent fields, the graph acpx-ui's board draws
 *   from those entries, and reports every descendant, closed ones as `closed_ignored`.
 */
export async function readAllSessionOwnerStatuses(): Promise<SessionOwnerStatusBatch> {
  const sessions = await ownerStatusesForEntries(
    await listSessionIndexEntries(),
    (record) => record.closed !== true,
  );
  return ownerStatusBatch("all_open", undefined, sessions);
}

export async function readDescendantSessionOwnerStatuses(
  rootSessionId: string,
): Promise<SessionOwnerStatusBatch> {
  const root = await resolveSessionRecord(rootSessionId);
  const descendants = familyDescendantRecords(root.acpxRecordId, await listSessionIndexEntries());
  return ownerStatusBatch(
    "descendants",
    root.acpxRecordId,
    await ownerStatusesForEntries(descendants),
  );
}

/**
 * The cap on concurrent record reads and lease probes in a batch scan. Before it, `--all`
 * ran a `Promise.all` over every open session: 900+ concurrent file and socket reads.
 */
const OWNER_STATUS_SCAN_CONCURRENCY = 8;

/**
 * One status per entry whose record still loads and passes `keep`, newest record first. An entry
 * with an unreadable record is dropped, as `listSessions()` dropped it. A record `keep` rejects is
 * never probed. Only the status row outlives the iteration: each body is released after its own
 * check, so peak heap is bounded by the pool width, not by the store.
 */
async function ownerStatusesForEntries(
  entries: SessionIndexEntry[],
  keep: (record: SessionRecord) => boolean = () => true,
): Promise<SessionOwnerStatus[]> {
  const probed = await mapWithConcurrency(entries, OWNER_STATUS_SCAN_CONCURRENCY, async (entry) => {
    const record = await loadSessionRecordBodyFromIndexEntry(entry);
    return record && keep(record)
      ? { lastUsedAt: record.lastUsedAt, status: await readOwnerStatusForRecord(record) }
      : undefined;
  });
  return probed
    .filter((row) => row !== undefined)
    .toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .map((row) => row.status);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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

function childrenByParentSessionId<T extends GraphNode>(records: T[]): Map<string, T[]> {
  const childrenByParent = new Map<string, T[]>();
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
 * The three fields the parent-graph walk actually reads. Kept a STRUCTURAL type,
 * not `SessionRecord`, so `sessions set-parent` can walk INDEX ENTRIES — which it
 * already holds — instead of paying a full-store record hydrate for a scan
 * (brick 853d9f38). Deliberately narrow: widening it (or reaching for `any`) would
 * let a caller hand in something that only looks like a node.
 */
type GraphNode = { acpxRecordId: string; parentSessionId?: string; lastUsedAt: string };

/**
 * Transitive local descendants of `rootSessionId` in the `parentSessionId` graph,
 * newest-first. The `seen` set IS the cycle guard, which is why
 * `sessions set-parent` reuses this as its cycle check rather than walking again.
 *
 * Generic over the node shape: `SessionRecord` and `SessionIndexEntry` both satisfy
 * `GraphNode`, and the return type follows the input.
 */
export function descendantRecords<T extends GraphNode>(rootSessionId: string, records: T[]): T[] {
  const childrenByParent = childrenByParentSessionId(records);
  const descendants: T[] = [];
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

type FamilyNode = GraphNode & {
  seatId?: string;
  parentSeatId?: string;
  holderActive?: boolean;
  holderOrdinal?: number;
  closed?: boolean;
};

/**
 * Transitive local FAMILY descendants of `rootSessionId`, newest-first (brick 085c8dd6) — what
 * `sessions owner-status --descendants-of` scans. The parent-child relation is between SEATS: a child
 * belongs to its parent seat (its stored `parentSeatId`, else the seat of the record `parentSessionId`
 * names) and hangs under that seat's current holder (active, not closed), so after a handover the
 * successor's scan reaches every child its predecessors spawned, with no `set-parent`. A seat with
 * another holder is one node: its current holder takes the seat's place (the first holder link that
 * leaves the seat, current holder first, then by ordinal; a prepared holder never counts) and the other
 * holders are its history, nobody's child. A parent with no seat, or a seat with no current holder,
 * keeps `parentSessionId`. This is the rule acpx-ui reads on every surface (`shared/lineage.ts`
 * `resolveFamily`, list surface); `descendantRecords` above stays on the STORED edge because
 * `sessions set-parent` uses it to refuse a cycle in what it writes.
 */
export function familyDescendantRecords<T extends FamilyNode>(
  rootSessionId: string,
  records: T[],
): T[] {
  const seats = indexSeats(records);
  const childrenByParent = new Map<string, T[]>();
  for (const record of records) {
    const parent = familyParentOf(record, seats);
    if (parent) {
      childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), record]);
    }
  }
  return walkChildren(rootSessionId, childrenByParent);
}

type SeatIndex<T extends FamilyNode> = {
  byId: Map<string, T>;
  currentBySeat: Map<string, T>;
  holdersBySeat: Map<string, T[]>;
};

function indexSeats<T extends FamilyNode>(records: T[]): SeatIndex<T> {
  const seats: SeatIndex<T> = {
    byId: new Map(),
    currentBySeat: new Map(),
    holdersBySeat: new Map(),
  };
  for (const record of records) {
    seats.byId.set(record.acpxRecordId, record);
    if (!record.seatId) {
      continue;
    }
    seats.holdersBySeat.set(record.seatId, [
      ...(seats.holdersBySeat.get(record.seatId) ?? []),
      record,
    ]);
    if (isCurrentHolder(record) && !seats.currentBySeat.has(record.seatId)) {
      seats.currentBySeat.set(record.seatId, record);
    }
  }
  return seats;
}

function isCurrentHolder(record: FamilyNode): boolean {
  return record.holderActive === true && record.closed !== true;
}

function parentSeatOf<T extends FamilyNode>(record: T, seats: SeatIndex<T>): string | undefined {
  if (!record.parentSessionId) {
    return undefined;
  }
  return record.parentSeatId ?? seats.byId.get(record.parentSessionId)?.seatId;
}

// The stored edge, carried to its parent seat's current holder (never to the record itself).
function viaSeat<T extends FamilyNode>(record: T, seats: SeatIndex<T>): string | undefined {
  const seat = parentSeatOf(record, seats);
  const holder = seat ? seats.currentBySeat.get(seat) : undefined;
  return holder && holder !== record ? holder.acpxRecordId : record.parentSessionId;
}

function familyParentOf<T extends FamilyNode>(record: T, seats: SeatIndex<T>): string | undefined {
  const seat = record.seatId;
  const current = seat ? seats.currentBySeat.get(seat) : undefined;
  if (!seat || !current || (seats.holdersBySeat.get(seat) ?? []).length < 2) {
    return viaSeat(record, seats);
  }
  // A handed-over seat: the other holders are its history; the current holder takes its place.
  return current === record ? seatPlace(record, seat, seats) : undefined;
}

// The first holder link that leaves the seat: the current holder's, then by ordinal (highest first).
// A prepared holder (no ordinal) never counts, nor a link to a holder of the seat itself.
function seatPlace<T extends FamilyNode>(
  current: T,
  seat: string,
  seats: SeatIndex<T>,
): string | undefined {
  const holders = (seats.holdersBySeat.get(seat) ?? [])
    .filter((h) => h === current || typeof h.holderOrdinal === "number")
    .toSorted((a, b) => byCurrentThenOrdinal(a, b, current));
  const leaving = holders.find((h) => leavesSeat(h, seat, seats));
  return leaving ? viaSeat(leaving, seats) : undefined;
}

function byCurrentThenOrdinal(a: FamilyNode, b: FamilyNode, current: FamilyNode): number {
  if (a === current) {
    return -1;
  }
  if (b === current) {
    return 1;
  }
  return (b.holderOrdinal ?? 0) - (a.holderOrdinal ?? 0);
}

function leavesSeat<T extends FamilyNode>(holder: T, seat: string, seats: SeatIndex<T>): boolean {
  if (!holder.parentSessionId || parentSeatOf(holder, seats) === seat) {
    return false;
  }
  return seats.byId.get(holder.parentSessionId)?.seatId !== seat;
}

function walkChildren<T extends GraphNode>(
  rootSessionId: string,
  childrenByParent: Map<string, T[]>,
): T[] {
  const descendants: T[] = [];
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

/**
 * The owner probe for a record the caller ALREADY HOLDS.
 *
 * `readSessionOwnerStatus` above is this plus a `resolveSessionRecord` — so a caller
 * that has just loaded the record (`sessions set-parent`, which loads one per target)
 * must use this form, or it pays a second full record read and throws the result
 * away. That second read was ~half of `--children-of`'s per-child cost (brick
 * 853d9f38 §3.1).
 */
export async function readOwnerStatusForRecord(record: SessionRecord): Promise<SessionOwnerStatus> {
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
  if (state.state === "foreign_owner" || state.state === "owner_unverified") {
    return state.state;
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
