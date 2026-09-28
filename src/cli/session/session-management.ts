import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  AcpClient,
  type SessionCreateResult,
  type SessionForkResult,
  type SessionLoadResult,
} from "../../acp/client.js";
import { formatErrorMessage } from "../../acp/error-normalization.js";
import {
  assertForkAtIndexHonoured,
  resolveEffectiveForkIndex,
} from "../../acp/harness-capabilities.js";
import { withInterrupt, withTimeout } from "../../async-control.js";
import { BrickOutbox } from "../../brick-outbox.js";
import { bindDefaultAccountToSessionOptionsAsync } from "../../runtime/engine/default-account-binding.js";
import { applyLifecycleSnapshotToRecord } from "../../runtime/engine/lifecycle.js";
import { persistSessionOptions } from "../../runtime/engine/session-options.js";
import {
  persistAndApplyRequestedEffort,
  persistRequestedOutputStyle,
} from "../../session/config-option-application.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import { createSessionConversation } from "../../session/conversation-model.js";
import { withDefaultModelForNewSession } from "../../session/default-model.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import {
  setCurrentModelId,
  setDesiredModelId,
  syncAdvertisedModelState,
} from "../../session/mode-preference.js";
import {
  advertisedAfterModelApply,
  applyRequestedModelIfAdvertised,
  type ModelApplyOutcome,
  modesAfterModelApply,
} from "../../session/model-application.js";
import {
  mirrorModelGuardToMessages,
  stampModelGuardBreadcrumb,
} from "../../session/model-guard.js";
import {
  availableOutputStyles,
  findAdvertisedOutputStyleOption,
  stampAppliedOutputStyle,
  withSupportedOutputStyleOnly,
} from "../../session/output-style.js";
import { persistSessionOwnerOptions } from "../../session/owner-options.js";
import {
  absolutePath,
  findClosedSessionsByDirectoryWalk,
  findGitRepositoryRoot,
  findSessionByDirectoryWalk,
  isoNow,
  mintSeatRowBestEffort,
  normalizeName,
  readSeatStore,
  resolveSessionRecord,
  seatFromStore,
  seatRowMissingMessage,
  sessionBaseDir,
  writeSessionRecord,
  writeSessionRecordAtBoundary,
} from "../../session/persistence.js";
import type { SessionIndexEntry } from "../../session/persistence/index.js";
import { normalizeRuntimeSessionId } from "../../session/runtime-session-id.js";
import type { SessionEnsureResult, SessionRecord } from "../../types.js";
import { resolveExistingBrickPath } from "./brick-link.js";
import { DEFAULT_QUEUE_OWNER_TTL_MS } from "./contracts.js";
import type {
  AgentOutputStyleListOptions,
  AgentOutputStyleListResult,
  SessionCreateOptions,
  SessionCreateWithClientResult,
  SessionEnsureOptions,
  SessionListOptions,
  SessionListResult,
} from "./contracts.js";
import { setSessionModel } from "./session-control.js";

// brick://5bac5564 Layer B belt inputs — the pin + its provenance from the create
// options, spread into applyRequestedModelIfAdvertised. Extracted so the resume /
// fork call sites stay under the lint complexity budget.
function modelApplyParamsFromOptions(options: SessionCreateOptions): {
  requestedModel: string | undefined;
  reasoningEffort: string | undefined;
  modelSource: string | undefined;
} {
  return {
    requestedModel: options.sessionOptions?.model,
    reasoningEffort: options.sessionOptions?.reasoningEffort,
    modelSource: options.sessionOptions?.modelSource,
  };
}

// brick://5bac5564 (RE-ENSURE-CLOBBER): a FLAGLESS re-ensure of an EXISTING session
// must NOT clobber its explicit pin. inheritedSpawnSessionOptions fills `model` with
// the INHERITED parent model on a flagless re-ensure, so applying it on the reuse
// branch would overwrite the child's real `--model` pin with the parent's (the
// general sonnet→opus / opus→fable clobber — the true M1). Return a model to apply
// ONLY when THIS invocation explicitly requested it (model_source === "explicit");
// never for an inherited / default / guard-forced value. Inheritance is a CREATE-time
// concept; a reuse keeps the existing pin verbatim.
function reuseExplicitModelToApply(options: SessionCreateOptions): string | undefined {
  if (options.sessionOptions?.modelSource !== "explicit") {
    return undefined;
  }
  return options.sessionOptions?.model;
}

// brick://5bac5564 Layer B: when the resolution-tier guard rewrote an implicit Fable,
// return the {blocked, forcedTo} pair for the loud breadcrumb + messages mirror. The
// pre-guard provenance of a guard-forced spawn/copy is deterministically "inherited"
// (the guard only fires when a Fable value arrived via inheritance; an explicit Fable
// is preserved and "default" never yields Fable) — stamped by the caller.
function spawnGuardForcedInfo(
  sessionOptions: SessionCreateOptions["sessionOptions"],
): { blocked: string; forcedTo: string } | undefined {
  if (sessionOptions?.modelSource !== "guard-forced") {
    return undefined;
  }
  const blocked = sessionOptions.modelGuardBlocked;
  const forcedTo = sessionOptions.model;
  return blocked && forcedTo ? { blocked, forcedTo } : undefined;
}

/**
 * The seat fields a NEWLY CREATED record carries (D11, brick b64dfbb3).
 *
 * Two shapes, and the difference between them is the whole of D11:
 *
 * - **no `--seat` (the default, unchanged):** mint a fresh seat, `holderOrdinal: 1`,
 *   `holderActive: true`. B1's behaviour byte for byte.
 * - **`--seat <ref>`:** join that seat **PREPARED BUT NOT ACTIVE** —
 *   `holderActive: false` and **NO `holderOrdinal` AT ALL**.
 *
 * ⚠️ THE ABSENT ORDINAL IS LOAD-BEARING, NOT AN OMISSION. The ordinal is drawn from
 * the seat's stored `next_ordinal` counter at ACTIVATION (§2.7 phase 2.4), inside the
 * one hold that also moves the pointer — so allocating one here would burn a number
 * for a holder that may never be activated, and Daniel's guarantee is that a number
 * is never RE-ISSUED. The activation heal relies on the absence directly: its branch
 * is *"`N` still lacks a `holderOrdinal` ⇒ allocate a fresh one"*, which is how a
 * crash between the counter write and the successor write is repaired. C2's
 * *absence is a value* makes a missing field persist as missing, so this survives
 * the round trip rather than being defaulted back to 1 by a reader.
 *
 * ⚠️ AND IT MUST NOT BE ACTIVE. Preparation is cheap and non-exclusive; ACTIVATION is
 * exclusive. Two *prepared* holders on one seat is a supported state — a succession
 * creates the successor while the predecessor is still active — and only `activate`
 * may set the flag.
 */
function seatFieldsForCreate(
  joinSeatId: string | undefined,
): Pick<SessionRecord, "seatId" | "holderOrdinal" | "holderActive"> {
  if (joinSeatId === undefined) {
    return { seatId: crypto.randomUUID(), holderOrdinal: 1, holderActive: true };
  }
  return { seatId: joinSeatId, holderActive: false };
}

/**
 * 🛑 `--seat` ON A FORK OR COPY IS REFUSED LOUDLY — never ignored, never honoured.
 *
 * Daniel, 2026-09-22 (topic 1, binding): **every fork mints a new seat, no
 * exceptions** — including byways and template spawns. A fork is a divergent copy of
 * a transcript; letting it join an existing seat would make two sessions with
 * different histories claim the same identity, which is the mis-seating D11's whole
 * asymmetry exists to prevent.
 *
 * ⚠️ **CURRENTLY UNREACHABLE THROUGH THE CLI, BY CONSTRUCTION — AND KEPT DELIBERATELY**
 * (finding F4). `seatId` reaches the create options only from the `sessions new` builder
 * and `forkFromSessionId` only from the `copy` builder — two separate object literals —
 * so nothing sets both today, and what actually refuses `sessions copy --seat` is
 * commander rejecting an unregistered option. This guard is defence-in-depth for the
 * in-process/library path.
 *
 * 🛑 **REGISTERING `--seat` ON `copy` IS DELIBERATELY NOT DONE, AND THE REASON IS FAILURE
 * MODES RATHER THAN MESSAGE QUALITY.** Today the refusal is STRUCTURAL: the parser does
 * not know the flag on that verb, so `copy --seat` cannot reach any code — **a
 * parser-level barrier cannot regress silently.** Register it and the barrier becomes a
 * RUNTIME CHECK, and if that check ever regresses, `copy --seat X` **silently joins a
 * seat** — violating Daniel's binding ruling that every fork mints a new seat, and
 * reproducing exactly the defect the restored G2/path-2 row exists to catch. A better
 * message is worth having; it is not worth that price.
 *
 * ⇒ **SEQUENCED, NOT REJECTED.** Now that this guard is actually tested (below), the UX
 * improvement becomes a *safe* follow-up with a real test behind it, rather than a swap
 * that promotes an untested path to load-bearing. A later block's to take, with the AP13
 * row updated in the same change.
 *
 * 🛑 IT IS TESTED DIRECTLY, because it has to be: no CLI invocation can reach it, and the
 * AP13 row that looks like its test is actually asserting the flag registration.
 * `seat-creation-paths.test.ts` carries both — one row pinned to commander's
 * unknown-option wording so the protection cannot change hands silently, and one driving
 * this function through `createSession` with both fields set.
 *
 * ⚠️ WHY A THROW AND NOT A SILENT IGNORE. The mint seam is shared between the normal
 * and fork/copy paths, so the tempting `seatId ?? randomUUID()` would honour the flag
 * on a fork; the tempting "fix" is to drop the flag on that path instead. **Both are
 * wrong in the same way**: the operator asked for something the system will not do,
 * and neither variant tells them. A silently-ignored flag leaves them believing the
 * session joined a seat it did not, which is a wrong belief about identity — exactly
 * the class that never surfaces as an error.
 */
function refuseSeatJoinOnForkPath(options: SessionCreateOptions): void {
  if (options.seatId === undefined || options.forkFromSessionId === undefined) {
    return;
  }
  throw new Error(
    `--seat cannot be combined with a fork or copy: every fork mints a NEW seat, no ` +
      `exceptions (Daniel, 2026-09-22). Requested seat ${JSON.stringify(options.seatId)} ` +
      `for a session forked from ${JSON.stringify(options.forkFromSessionId)}. A forked ` +
      `session is a divergent copy of a transcript; if you want a holder in that seat, ` +
      `create one with \`sessions new --seat\` instead of copying an existing session.`,
  );
}

/**
 * The remaining `--seat` refusals, all BEFORE any write (D11).
 *
 * 🛑 **THE SEAT MUST ALREADY EXIST — JOINING NEVER MINTS ONE AS A SIDE EFFECT.** That
 * is the refusal that matters most here: a typo'd seat id which silently created the
 * seat it named would produce a seat nobody meant, holding a session that believes it
 * belongs there, and nothing downstream could tell — a mis-seated session is a wrong
 * identity that every later block inherits, with no signature to detect and no re-run
 * that repairs it. `seatFromStore` distinguishes the three states for us: a
 * `MalformedSeatRowError` propagates as itself, because "present but unreadable" must
 * never be reported as "no such seat" — a caller told the latter goes on to create one.
 *
 * ⚠️ NOT CHECKED HERE, AND STATED RATHER THAN QUIETLY SKIPPED: B1 ruling 4's *all
 * holders of a seat share one kind*. Checking it needs an enumeration of the seat's
 * existing holders — a scan for `seatId === s` over the index — and the seat record
 * deliberately carries no holder list (the field set is closed at seven). That scan is
 * the one the seat store exists to remove from hot paths, and the protocol confines it
 * to the heal path. It is also unreachable today: the only two kinds are `session` and
 * the `subagent` shadow record, and `runtime.ts`'s subagent path is never CLI-driven,
 * so no `--seat` can reach it. ⇒ deferred deliberately, with the cost named; it wants
 * a ruling on where the holder enumeration is allowed to live, not a scan added here
 * on my own judgement.
 */
async function refuseUnjoinableSeat(joinSeatId: string | undefined): Promise<void> {
  if (joinSeatId === undefined) {
    return;
  }
  const store = await readSeatStore(sessionBaseDir());
  const seat = seatFromStore(store, joinSeatId);
  if (!seat) {
    // AP17 — THE REFUSAL DIAGNOSES. The shared message names the cause and the remedy,
    // because the overwhelmingly likely reason a real seat id has no row is that the seat
    // PREDATES the store (B10's backfill population), and a bare "not found" makes that
    // look like a bug in our code rather than a migration that has not run.
    throw new Error(
      `${seatRowMissingMessage(joinSeatId)} ` +
        `Joining NEVER creates a seat as a side effect — a mistyped id that minted the seat ` +
        `it named would leave a session sitting in a seat nobody meant, and nothing ` +
        `downstream can tell that apart from a session in the right one. Omit --seat to mint ` +
        `a fresh seat for this session.`,
    );
  }
  if (seat.closedAt !== null && seat.closedAt !== undefined) {
    throw new Error(
      `seat ${JSON.stringify(joinSeatId)} was closed at ${seat.closedAt} — the office is ` +
        `abolished and takes no further holders. This is not the same as the seat being ` +
        `vacant: a vacant seat (no active holder) still accepts one.`,
    );
  }
}

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
async function createSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
): Promise<SessionRecord> {
  const cwd = absolutePath(options.cwd);
  // BEFORE ANY WRITE, AND BEFORE THE AGENT IS EVEN STARTED (D11). A refusal that
  // fired after `client.start()` would leave a spawned adapter behind for a request
  // that was never going to be honoured.
  refuseSeatJoinOnForkPath(options);
  await refuseUnjoinableSeat(options.seatId);
  if (options.recordId) {
    const outbox = new BrickOutbox();
    try {
      if (outbox.readRecord(options.recordId)) {
        throw new Error(
          "record-id destination already exists; refusing to create another ACP session",
        );
      }
    } finally {
      outbox.close();
    }
  }
  await withTimeout(client.start(), options.timeoutMs);
  let sessionId: string;
  let acpSessionId: string;
  let agentSessionId: string | undefined;
  let sessionResult: SessionCreateResult | SessionLoadResult | SessionForkResult;
  let sessionModels: SessionCreateResult["models"];
  let modelApply: ModelApplyOutcome = { applied: false };
  let deferForkModel: string | undefined;
  let effectiveSessionOptions = options.sessionOptions;
  let forkContext:
    | {
        sourceRecord: SessionRecord;
        forkAtMessageIndex: number;
        requestedForkAtMessageIndex?: number;
        messages: SessionRecord["messages"];
      }
    | undefined;

  if (options.resumeSessionId) {
    const resumed = await resumeSessionRecordWithClient(client, options, cwd);
    sessionId = resumed.sessionId;
    acpSessionId = resumed.acpSessionId;
    agentSessionId = resumed.agentSessionId;
    sessionResult = resumed.sessionResult;
    sessionModels = resumed.sessionModels;
    modelApply = resumed.modelApply;
  } else if (options.forkFromSessionId) {
    const forked = await forkSessionRecordWithClient(client, options, cwd);
    sessionId = forked.sessionId;
    acpSessionId = forked.acpSessionId;
    agentSessionId = forked.agentSessionId;
    sessionResult = forked.sessionResult;
    sessionModels = forked.sessionModels;
    modelApply = forked.modelApply;
    deferForkModel = forked.deferForkModel;
    forkContext = forked.forkContext;
  } else {
    effectiveSessionOptions = withDefaultModelForNewSession(
      options.agentCommand,
      options.sessionOptions,
    );
    const createdSession = await withTimeout(client.createSession(cwd), options.timeoutMs);
    sessionId = createdSession.sessionId;
    acpSessionId = sessionId;
    agentSessionId = normalizeRuntimeSessionId(createdSession.agentSessionId);
    sessionResult = createdSession;
    sessionModels = createdSession.models;
    modelApply = await applyRequestedModelIfAdvertised({
      client,
      sessionId,
      requestedModel: effectiveSessionOptions?.model,
      reasoningEffort: effectiveSessionOptions?.reasoningEffort,
      modelSource: effectiveSessionOptions?.modelSource,
      models: sessionModels,
      advertisedConfigOptions: createdSession.configOptions,
      agentCommand: options.agentCommand,
      timeoutMs: options.timeoutMs,
    });
  }
  if (modelApply.effectiveModelId !== undefined && effectiveSessionOptions !== undefined) {
    effectiveSessionOptions = { ...effectiveSessionOptions, model: modelApply.effectiveModelId };
  }
  const requestedModelApplied = modelApply.applied;
  // ⚠️ THE POST-MODEL RE-READ (CONCEPTION §5.2). Everything below that asks
  // "what does this session advertise?" must ask it of the advertisement that
  // exists AFTER the model was applied, never of the `session/new` snapshot.
  //
  // A per-model ladder advertises the `effort` option ONLY when the
  // currently-selected model reasons, so at `session/new` under a non-reasoning
  // default it is ABSENT. Read the snapshot and `--reasoning-effort` silently never fires —
  // and, because `session/set_config_option` answers with a refreshed
  // advertisement, the corrected reading costs no extra round-trip.
  //
  // ⚠️ DO NOT "simplify" this to `modelApply.refreshedConfigOptions` alone. A
  // `set-model` harness returns nothing to re-read, so `undefined` there means
  // "keep the snapshot", not "nothing is advertised" — collapsing the two would
  // delete claude's and claude-pty's working depth path. Test:
  // `test/model-application.test.ts` → "a set-model harness keeps the
  // session/new advertisement".
  const advertisedAfterModel = advertisedAfterModelApply(modelApply, sessionResult.configOptions);

  const lifecycle = client.getAgentLifecycleSnapshot();
  const now = isoNow();
  const conversation = createSessionConversation(now);
  const desiredConfigOptions = cloneDesiredConfigOptions(options.desiredConfigOptions);
  if (forkContext) {
    conversation.messages = structuredClone(forkContext.messages);
  }
  // Hoisted out of the record literal so the SEAT ID is in hand before either write —
  // D13a needs the row written first, and it cannot name its holder without both ids.
  const seatFields = seatFieldsForCreate(options.seatId);
  const record: SessionRecord = {
    schema: "acpx.session.v1",
    acpxRecordId: options.recordId ?? sessionId,
    acpSessionId,
    agentSessionId,
    agentName: options.agentName,
    agentCommand: options.agentCommand,
    cwd,
    name: normalizeName(options.name),
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    lastRequestId: undefined,
    eventLog: defaultSessionEventLog(options.recordId ?? sessionId),
    closed: false,
    closedAt: undefined,
    pid: lifecycle.running ? lifecycle.pid : undefined,
    agentStartedAt: lifecycle.startedAt,
    protocolVersion: client.initializeResult?.protocolVersion,
    agentCapabilities: client.initializeResult?.agentCapabilities,
    ...conversation,
    acpx: desiredConfigOptions ? { desired_config_options: desiredConfigOptions } : {},
    // SEATS (brick 5ad22d5d, D-B1-6/D-B1-7; join added by B2/D11, brick b64dfbb3).
    // This literal is the SHARED seam for BOTH the normal-create path AND the
    // fork/copy path (forkContext is set above when options.forkFromSessionId was
    // given) — which is what lets one edit cover seat-creation paths 1 and 2.
    //
    // 🛑 AND THAT SHARED SEAM IS EXACTLY THE TRAP D11 WARNS ABOUT. The naive
    // version of the join — `seatId: options.seatId ?? crypto.randomUUID()` — reads
    // like the obvious edit and would let `sessions copy --seat X` (and a fork)
    // SILENTLY JOIN a seat, violating Daniel's topic-1 ruling that every fork mints
    // a new seat, NO EXCEPTIONS (2026-09-22). `refuseSeatJoinOnForkPath` above has
    // already thrown for that combination, so by here the join is known legitimate:
    // a silently-ignored flag and a silently-honoured one are both worse than an
    // error, and this is the line where the difference is decided.
    //
    // A fork therefore still NEVER inherits the source's seat — it mints, exactly as
    // before. The default is unchanged byte for byte when `--seat` is absent.
    ...seatFields,
    ...(forkContext
      ? {
          kind: "session" as const,
          forkedFromSessionId: forkContext.sourceRecord.acpxRecordId,
          // EFFECTIVE, not requested — see resolveForkSourceContext.
          forkedAtMessageIndex: forkContext.forkAtMessageIndex,
          ...(forkContext.requestedForkAtMessageIndex === undefined
            ? {}
            : { forkedAtMessageIndexRequested: forkContext.requestedForkAtMessageIndex }),
        }
      : {}),
    ...(options.parentSessionId
      ? {
          kind: "session" as const,
          parentSessionId: options.parentSessionId,
          // Persist the parent's FULL url when we were given one. Without this the
          // record keeps only the bare uuid, and a CROSS-BOX parent becomes
          // unidentifiable the moment the spawn ends: the id resolves against
          // whichever box happens to read it. (brick://c6e3618b)
          ...(options.parentSessionUrl?.trim()
            ? { parentSessionUrl: options.parentSessionUrl.trim() }
            : {}),
          // Mirrors parentSessionUrl immediately above, for the seat sibling
          // (C3/D-B1-9): captured once at creation from the parent record then
          // in hand (same-box only — see ResolvedParentSession.seatId in
          // command-handlers.ts), used to compose ACPX_PARENT_SEAT_URL on
          // every subsequent spawn of THIS record.
          ...(options.parentSeatId?.trim() ? { parentSeatId: options.parentSeatId.trim() } : {}),
        }
      : {}),
    ...(options.metadata && Object.keys(options.metadata).length > 0
      ? { metadata: { ...options.metadata } }
      : {}),
  };

  if (record.metadata?.spawn_key) {
    record.metadata.spawn_state = "pending";
  }

  // NOTE: the config-dir channel (brick fa2e54ec) is written by
  // applyLifecycleSnapshotToRecord itself, from the snapshot — deliberately NOT
  // by a second call here. It must be refreshed at EVERY spawn, and routing it
  // through the snapshot means a new spawn site cannot forget it.
  applyLifecycleSnapshotToRecord(record, lifecycle);
  // brick://874fee67 F3 — strip a style this agent does not support BEFORE the
  // first write. Every later write (persist, validate, stamp) reads this same
  // filtered value, so the "no write on an unsupported agent" rule cannot be
  // missed by one site while another honours it. All three creation branches
  // above (new / copy-fork / resume) funnel through here.
  effectiveSessionOptions = withSupportedOutputStyleOnly(
    effectiveSessionOptions,
    advertisedAfterModel,
  );
  persistSessionOptions(record, effectiveSessionOptions);
  persistSessionOwnerOptions(record, options);
  // Capture the POST-MODEL advertisement, not the `session/new` one: the record's
  // `acpx.config_options` is what `resolveHarnessCapabilities` narrows the
  // declared descriptor with, so storing the stale snapshot would show the depth
  // control as unavailable on a session that had just been pinned to a reasoning
  // model — the exact confusion the re-read exists to remove.
  applyConfigOptionsToRecord(record, { configOptions: advertisedAfterModel });
  await persistAndApplyRequestedEffort({
    client,
    sessionId,
    record,
    reasoningEffort: effectiveSessionOptions?.reasoningEffort,
    advertised: advertisedAfterModel,
    // POST-model, for exactly the reason stated three lines above about config
    // options — and this is the field where getting it wrong was measurable:
    // for a `mode`-mechanism harness the ACP mode advertisement IS the depth
    // ladder and pi's is per model, so `sessionResult.modes` projected every
    // request onto pi's DEFAULT model's ladder. See `modesAfterModelApply`.
    modes: modesAfterModelApply(sessionResult.modes, advertisedAfterModel),
    agentCommand: options.agentCommand,
    modelId: effectiveSessionOptions?.model,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
  // brick://874fee67: validate + persist the requested style. NOTE there is no
  // apply step and that is deliberate (R-6 #1) — the style already reached the
  // adapter in the creation `_meta`, which is what the query was BUILT with, so
  // it is in force from turn 1. This is the advertised-gated validation + write.
  persistRequestedOutputStyle({
    record,
    outputStyle: effectiveSessionOptions?.outputStyle,
    advertised: advertisedAfterModel,
    agentLabel: options.agentName ?? options.agentCommand,
  });
  // brick://874fee67 turn-boundary spec §3: stamp what the query we just built
  // was handed — AFTER the create/resume/fork succeeded, and UNCONDITIONALLY
  // (including for the default). Skip it and `outputStyleChangePending` reads a
  // brand-new unstyled session as already-pending, recycling its owner on the
  // first turn for nothing.
  stampAppliedOutputStyle(record, effectiveSessionOptions?.outputStyle);
  syncAdvertisedModelState(record, sessionModels);
  if (requestedModelApplied) {
    setCurrentModelId(record, effectiveSessionOptions?.model);
  }
  // Durable Claude fork: the creation-time set_model was skipped (the durable id
  // is not adapter-registered yet). Persist the inherited source model onto the
  // record so the UI shows it immediately (current_model_id) and the open-time
  // replay applies it on the first proper resume (desired via session_options.model,
  // read by getDesiredModelId). Runs after syncAdvertisedModelState so it is not
  // clobbered by the advertised default. Fork brick 29efbe0c.
  if (deferForkModel) {
    setDesiredModelId(record, deferForkModel);
    setCurrentModelId(record, deferForkModel);
  }

  // A fork inherits the source's (truncated) conversation in
  // `conversation.messages`. acpx-ui renders a session's conversation from the
  // messages-log sidecar (`<id>.messages.ndjson`, pointed at by `messages_log`)
  // — its record/fork-prepend fallback runs through hydrateSessionMessages, and
  // a normal session always carries that sidecar. A plain checkpoint write
  // leaves `messages_log` undefined and never writes the sidecar, so the fork
  // is stored differently from every other session (inline-only) and the UI
  // shows an empty page. Flush the inherited messages through the boundary
  // writer so the fork's `messages_log` is populated (count == forkAtMessageIndex,
  // matching the truncated Claude resume transcript) and the sidecar exists —
  // making the fork store identically to its parent. FW-10 fork UI-empty fix.
  const guardForced = spawnGuardForcedInfo(effectiveSessionOptions);
  if (guardForced) {
    stampModelGuardBreadcrumb(record, { ...guardForced, source: "inherited", at: now });
    if (options.verbose) {
      process.stderr.write(
        `[acpx] model-guard session=${record.acpxRecordId} implicit Fable "${guardForced.blocked}" blocked → forced ${guardForced.forcedTo}\n`,
      );
    }
  }

  // 🛑 D13a — THE SEAT ROW GOES FIRST, AND THE ORDER IS NOT A PREFERENCE.
  // Record-first leaves, on a crash, a session carrying a seatId with NO ROW: a fully
  // working session that can never be succeeded, discovered only when someone first
  // tries to hand over — silent and permanent. Row-first leaves an orphan row nobody
  // references: inert, ~290 bytes, and enumerable from the store — though NOT yet
  // visible in any verb, since `acpx seats list` is D12's and is not built. Only one of those two
  // torn states is loud, so only one ordering is allowed.
  // ⚠️ Do NOT move this below the record write for tidiness, and do not fold it into the
  // record write's own lock even though the index lock is re-entrant and would allow it.
  // Only the FRESH-MINT path mints: `--seat` joined an existing row, and joining must
  // never mint one (D13).
  if (options.seatId === undefined && seatFields.seatId !== undefined) {
    // 🛑 BEST-EFFORT AND LOUD (ratification item 8) — A STORE FAILURE MUST NOT FAIL THE
    // SPAWN. Fail-closed here would be a bootstrap trap: every recovery path on these
    // boxes runs through creating an agent session, so a corrupt store that stops
    // `sessions new` stops its own repair. The `seat_id` STAYS on the record — it is what
    // makes the session repairable by the backfill and what keeps its children's
    // `parent_seat_id` chain from being orphaned.
    const minted = await mintSeatRowBestEffort(sessionBaseDir(), {
      seatId: seatFields.seatId,
      holderId: record.acpxRecordId,
      name: record.name,
      createdAt: now,
    });
    if (!minted.minted) {
      process.stderr.write(`${minted.diagnostic}\n`);
    }
  }
  if (forkContext) {
    await writeSessionRecordAtBoundary(record);
  } else {
    await writeSessionRecord(record);
  }
  if (guardForced) {
    // Best-effort mirror (pushes the warning message + boundary-writes the sidecar)
    // — a write failure must never fail the spawn.
    await mirrorModelGuardToMessages(record, guardForced).catch(() => {});
  }
  return record;
}

function cloneDesiredConfigOptions(
  desiredConfigOptions: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!desiredConfigOptions || Object.keys(desiredConfigOptions).length === 0) {
    return undefined;
  }
  return { ...desiredConfigOptions };
}

type CreatedSessionState = {
  sessionId: string;
  acpSessionId: string;
  agentSessionId: string | undefined;
  sessionResult: SessionCreateResult | SessionLoadResult | SessionForkResult;
  sessionModels: SessionCreateResult["models"];
  modelApply: ModelApplyOutcome;
};

type ForkedSessionState = CreatedSessionState & {
  // Set when the eager creation-time set_model was skipped for a durable Claude
  // fork; the source model to persist onto the record for open-time replay.
  deferForkModel?: string;
  forkContext: {
    sourceRecord: SessionRecord;
    forkAtMessageIndex: number;
    requestedForkAtMessageIndex?: number;
    messages: SessionRecord["messages"];
  };
};

type ForkSourceContext = {
  sourceRecord: SessionRecord;
  /** The index the fork ACTUALLY lands on — what the record persists. */
  forkAtMessageIndex: number;
  /** The index that was ASKED for, present only when it differs from the above. */
  requestedForkAtMessageIndex?: number;
};

async function resumeSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
  cwd: string,
): Promise<CreatedSessionState> {
  if (!options.resumeSessionId) {
    throw new Error("resumeSessionId is required");
  }
  const resumeMethod = client.supportsResumeSession()
    ? "session/resume"
    : client.supportsLoadSession()
      ? "session/load"
      : undefined;
  if (!resumeMethod) {
    throw new Error(
      `Agent command "${options.agentCommand}" does not support session/resume or session/load; cannot resume session ${options.resumeSessionId}`,
    );
  }

  try {
    const resumedSession = await withTimeout(
      resumeMethod === "session/resume"
        ? client.resumeSession(options.resumeSessionId, cwd)
        : client.loadSession(options.resumeSessionId, cwd),
      options.timeoutMs,
    );
    const sessionModels = resumedSession.models;
    return {
      sessionId: options.resumeSessionId,
      acpSessionId: options.resumeSessionId,
      agentSessionId: normalizeRuntimeSessionId(resumedSession.agentSessionId),
      sessionResult: resumedSession,
      sessionModels,
      modelApply: await applyRequestedModelIfAdvertised({
        client,
        sessionId: options.resumeSessionId,
        ...modelApplyParamsFromOptions(options),
        models: sessionModels,
        advertisedConfigOptions: resumedSession.configOptions,
        agentCommand: options.agentCommand,
        timeoutMs: options.timeoutMs,
      }),
    };
  } catch (error) {
    throw new Error(
      `Failed to resume ACP session ${options.resumeSessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

async function resolveForkSourceContext(options: SessionCreateOptions): Promise<ForkSourceContext> {
  if (!options.forkFromSessionId) {
    throw new Error("forkFromSessionId is required");
  }

  const sourceRecord = await resolveSessionRecord(options.forkFromSessionId);
  if (sourceRecord.kind === "subagent") {
    throw new Error("Cannot copy a subagent session");
  }

  // THE CHOKE POINT both the CLI verb and acpx-ui's create route reach, which is
  // why the refusal lives here rather than only in the handler: a truncating fork
  // a harness will not perform is refused before any record exists.
  assertForkAtIndexHonoured(options.agentCommand, options.forkAtMessageIndex);

  const requested = options.forkAtMessageIndex ?? sourceRecord.messages.length;
  if (requested < 0 || requested > sourceRecord.messages.length) {
    throw new Error(`--at-index out of range (0-${sourceRecord.messages.length})`);
  }

  // ⚠️ THE RECORD CARRIES THE EFFECTIVE INDEX, NOT THE REQUESTED ONE, and this
  // is a CORRECTION of shipped behaviour, not a new field's default. Before B0.2
  // this function returned the request and `session-management` persisted it as
  // `forkedAtMessageIndex` — so on codex, whose rollback is TURN-granular
  // (2 acpx messages = 1 turn, rounding down), an ODD index already produced a
  // record asserting a truncation the adapter did not perform. The lie shipped;
  // it is not being introduced. Correcting the field every consumer ALREADY
  // reads fixes the display everywhere at once, which is why `requested` is the
  // new field rather than `effective`.
  //
  // It also truncates the cloned message list at the same boundary
  // (`messages.slice(0, forkAtMessageIndex)` in the caller), so the record's own
  // message COUNT agrees with the index it reports — the ground truth
  // `G1-FRK-01` checks the record against.
  const forkAtMessageIndex =
    options.forkAtMessageIndex === undefined
      ? requested
      : resolveEffectiveForkIndex(options.agentCommand, requested);

  return {
    sourceRecord,
    forkAtMessageIndex,
    // Populated ONLY on a mismatch, so the common case stays byte-identical to
    // baseline and the field's mere presence means "these two differ".
    ...(forkAtMessageIndex === requested ? {} : { requestedForkAtMessageIndex: requested }),
  };
}

// Decide how a fork's model gets applied. Durable Claude forks return an
// SDK-materialized transcript id the adapter has never registered (only the
// random fork id from unstable_forkSession is). Driving `set_model` on it at
// creation aborts the whole copy ("Session not found"). So for those we skip the
// eager apply and defer the source model onto the record, letting the open-time
// replay path (getDesiredModelId → replayDesiredModel) apply it on the first
// proper resume — when the durable id IS registered. Every other fork (codex/pty,
// or a Claude fork where no durable substitution ran) keeps the eager apply: its
// returned id is already registered. Fork brick 29efbe0c.
async function resolveForkModelApplication(
  client: AcpClient,
  options: SessionCreateOptions,
  forkedSession: SessionCreateResult | SessionForkResult,
  sessionModels: SessionCreateResult["models"],
): Promise<{ modelApply: ModelApplyOutcome; deferForkModel: string | undefined }> {
  // Only forkSession (forkAtMessageIndex > 0) can carry the marker; the
  // createSession branch (index 0) is a fresh empty session.
  const durableClaudeForkApplied =
    "durableClaudeForkApplied" in forkedSession && forkedSession.durableClaudeForkApplied === true;
  if (durableClaudeForkApplied) {
    // `sessionOptions.model` is the canonical model acpx already resolved for the
    // copy (via copySessionOptionsWithOverride); the record setters normalize it,
    // and it is the value the open-time replay + adapter model resolution agree on.
    return { modelApply: { applied: false }, deferForkModel: options.sessionOptions?.model };
  }
  return {
    modelApply: await applyRequestedModelIfAdvertised({
      client,
      sessionId: forkedSession.sessionId,
      ...modelApplyParamsFromOptions(options),
      models: sessionModels,
      advertisedConfigOptions: forkedSession.configOptions,
      agentCommand: options.agentCommand,
      timeoutMs: options.timeoutMs,
    }),
    deferForkModel: undefined,
  };
}

async function forkSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
  cwd: string,
): Promise<ForkedSessionState> {
  const { sourceRecord, forkAtMessageIndex, requestedForkAtMessageIndex } =
    await resolveForkSourceContext(options);

  if (!client.supportsForkSession()) {
    throw new Error(
      `Agent command "${options.agentCommand}" does not advertise sessionCapabilities.fork; cannot copy session ${sourceRecord.acpxRecordId}`,
    );
  }

  try {
    const forkedSession =
      forkAtMessageIndex === 0
        ? await withTimeout(client.createSession(cwd), options.timeoutMs)
        : await withTimeout(
            client.forkSession(sourceRecord.acpSessionId, cwd, {
              atIndex: options.forkAtMessageIndex,
              sourceCwd: sourceRecord.cwd,
              sourceMessages: sourceRecord.messages,
              suppressReplayUpdates: true,
            }),
            options.timeoutMs,
          );
    const sessionModels = forkedSession.models;
    const agentSessionId = normalizeRuntimeSessionId(forkedSession.agentSessionId);
    const { modelApply, deferForkModel } = await resolveForkModelApplication(
      client,
      options,
      forkedSession,
      sessionModels,
    );
    return {
      sessionId: forkedSession.sessionId,
      acpSessionId: forkedSession.sessionId,
      agentSessionId,
      sessionResult: forkedSession,
      sessionModels,
      modelApply,
      deferForkModel,
      forkContext: {
        sourceRecord,
        forkAtMessageIndex,
        ...(requestedForkAtMessageIndex === undefined ? {} : { requestedForkAtMessageIndex }),
        // Truncated at the EFFECTIVE boundary, so the record's own message count
        // agrees with the index it reports (row `G1-FRK-01`).
        messages: sourceRecord.messages.slice(0, forkAtMessageIndex),
      },
    };
  } catch (error) {
    throw new Error(
      `Failed to copy ACP session ${sourceRecord.acpSessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

// Build the best-effort sessionContext for the first (creation) spawn. The ?? null chains mirror
// the sessionContext shape in queue-owner-runtime.ts / connected-session.ts (trivial field-mapping).
// eslint-disable-next-line complexity -- ?? null field-mapping; cannot simplify without losing null safety
function creationSessionContext(options: SessionCreateOptions) {
  const brick = options.metadata?.brick?.trim() || null;
  const brickPath = brick ? resolveExistingBrickPath(brick) : null;
  return {
    acpxRecordId: "",
    sessionName: normalizeName(options.name) ?? null,
    parentSessionId: options.parentSessionId ?? null,
    // The full parent URL (real host) reaches the bridge at session/new AND becomes
    // ACPX_PARENT_SESSION_URL for this spawn. It is also persisted onto the record
    // (brick://c6e3618b), so later recover/keepwarm spawns reload the real host
    // instead of re-deriving one against the LOCAL base URL — which silently
    // re-hosts a cross-box parent onto this box. (FW-19)
    parentSessionUrl: options.parentSessionUrl ?? null,
    // SEATS (C3/D-B1-9). This session's OWN seatId is deliberately NOT set
    // here: it does not exist yet at this point (minted inside
    // createSessionRecordWithClient's record literal, which runs AFTER this
    // context is built) — same reasoning as acpxRecordId:"" above; it is set
    // from the persisted record on the NEXT spawn. The PARENT's seat id is
    // already resolvable at this point (same-box parent, resolved before
    // createSession was called — see ResolvedParentSession.seatId in
    // command-handlers.ts), so it is available even on this transient spawn,
    // mirroring parentSessionUrl immediately above.
    parentSeatId: options.parentSeatId ?? null,
    brick,
    brickPath,
    agentFolder: null,
    subscriptionId: options.sessionOptions?.subscription ?? null,
    profileId: options.sessionOptions?.profile ?? null,
  };
}

export async function createSessionWithClient(
  options: SessionCreateOptions,
): Promise<SessionCreateWithClientResult> {
  const effectiveOptions: SessionCreateOptions = {
    ...options,
    sessionOptions: await bindDefaultAccountToSessionOptionsAsync(
      options.sessionOptions,
      options.agentCommand,
    ),
  };
  const client = new AcpClient({
    agentCommand: effectiveOptions.agentCommand,
    cwd: absolutePath(effectiveOptions.cwd),
    mcpServers: effectiveOptions.mcpServers,
    permissionMode: effectiveOptions.permissionMode,
    nonInteractivePermissions: effectiveOptions.nonInteractivePermissions,
    permissionPolicy: effectiveOptions.permissionPolicy,
    authCredentials: effectiveOptions.authCredentials,
    authPolicy: effectiveOptions.authPolicy,
    terminal: effectiveOptions.terminal,
    verbose: effectiveOptions.verbose,
    sessionOptions: effectiveOptions.sessionOptions,
    // The CREATION spawn must resolve CLAUDE_CONFIG_DIR from the chosen
    // subscription, exactly like the prompt/recover/keepwarm spawns do
    // (connected-session.ts / runtime.ts). Without this the first turn ignores
    // `--subscription` and falls through to the registry default. The record
    // does not exist yet, so the id is sourced from sessionOptions; the other
    // sessionContext fields are best-effort (each is guarded independently in
    // buildAgentEnvironment, so a null acpxRecordId only skips ACPX_SESSION_URL
    // on this one spawn — it is set on the next spawn from the persisted record).
    sessionContext: creationSessionContext(effectiveOptions),
  });

  try {
    const record = await withInterrupt(
      async () => await createSessionRecordWithClient(client, effectiveOptions),
      async () => {
        await client.close();
      },
    );

    return {
      record,
      client,
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}

/**
 * brick://874fee67 §4.2 #40 — enumerate the output styles an agent offers.
 *
 * Exists for acpx-ui's CREATE dialog, which must offer a style before any
 * session exists. Two paths, both cheap:
 *
 * - **With a session id** — read the record's own advertised `config_options`.
 *   No process spawned at all.
 * - **Without one** — open a transient ACP session, read what the adapter
 *   advertises from the `initialize` handshake, and close. **No prompt is ever
 *   sent**: the handshake carries `available_output_styles` before any turn, so
 *   this costs no tokens and needs no auth. It also returns CUSTOM and house
 *   styles, which no filesystem scan could produce for the built-ins — which is
 *   why this asks the harness rather than reading `output-styles/` directories.
 *
 * ⚠️ NO RECORD IS WRITTEN on the transient path. The session is opened purely to
 * read the advertisement and is closed in a `finally`.
 */
export async function listAgentOutputStyles(
  options: AgentOutputStyleListOptions,
): Promise<AgentOutputStyleListResult> {
  if (options.sessionId) {
    const record = await resolveSessionRecord(options.sessionId);
    return outputStyleListFromAdvertised(record.acpx?.config_options);
  }

  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    // Read-only probe: no prompt is ever sent, so the most restrictive policy is
    // correct — nothing can ask for a permission on this session.
    permissionMode: "deny-all",
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    verbose: options.verbose,
  });
  try {
    await withTimeout(client.start(), options.timeoutMs);
    const created = await withTimeout(
      client.createSession(absolutePath(options.cwd)),
      options.timeoutMs,
    );
    return outputStyleListFromAdvertised(created.configOptions);
  } finally {
    await client.close().catch(() => {
      // Enumeration is read-only; a close failure must not mask the answer.
    });
  }
}

function outputStyleListFromAdvertised(
  advertised: SessionConfigOption[] | undefined,
): AgentOutputStyleListResult {
  const option = findAdvertisedOutputStyleOption(advertised);
  if (!option) {
    // Not advertised = genuinely unsupported by this agent (codex lands here with
    // no special-casing). Distinct from "advertised but we know no values".
    return { supported: false, current: undefined, available: [] };
  }
  return {
    supported: true,
    current: typeof option.currentValue === "string" ? option.currentValue : undefined,
    available: availableOutputStyles(advertised),
  };
}

export async function createSession(options: SessionCreateOptions): Promise<SessionRecord> {
  const { record, client } = await createSessionWithClient(options);
  try {
    return record;
  } finally {
    await client.close();
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    await writeSessionRecord(record);
  }
}

export async function listAgentSessions(options: SessionListOptions): Promise<SessionListResult> {
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    verbose: options.verbose,
  });

  try {
    return await withInterrupt(
      async () => {
        await withTimeout(client.start(), options.timeoutMs);
        if (!client.supportsListSessions()) {
          return undefined;
        }

        const cwd = options.filterCwd ? absolutePath(options.filterCwd) : undefined;
        const response = await withTimeout(
          client.listSessions({
            ...(cwd ? { cwd } : {}),
            ...(options.cursor ? { cursor: options.cursor } : {}),
          }),
          options.timeoutMs,
        );

        return {
          _meta: response._meta,
          source: "agent",
          sessions: response.sessions,
          cursor: options.cursor,
          cwd,
          nextCursor: response.nextCursor,
        };
      },
      async () => {
        await client.close();
      },
    );
  } finally {
    await client.close();
  }
}

// brick://16712ece — `closedMatches` is the walk's newest-first list of CLOSED
// same-scope entries it could not see. Returns the `SessionEnsureResult` slice
// to spread, or `undefined` when there was nothing to report, so the caller
// spreads unconditionally and `createdBecauseClosed` is ABSENT (not `undefined`)
// on the ordinary path.
function describeClosedMatches(
  closedMatches: readonly SessionIndexEntry[],
): Pick<SessionEnsureResult, "createdBecauseClosed"> | undefined {
  const nearest = closedMatches[0];
  if (!nearest) {
    return undefined;
  }
  return {
    createdBecauseClosed: {
      count: closedMatches.length,
      nearestRecordId: nearest.acpxRecordId,
      ...(nearest.name === undefined ? {} : { nearestName: nearest.name }),
    },
  };
}

export async function ensureSession(options: SessionEnsureOptions): Promise<SessionEnsureResult> {
  const cwd = absolutePath(options.cwd);
  const gitRoot = findGitRepositoryRoot(cwd);
  const walkBoundary = options.walkBoundary ?? gitRoot ?? cwd;
  const existing = await findSessionByDirectoryWalk({
    agentCommand: options.agentCommand,
    agentName: options.agentName,
    cwd,
    name: options.name,
    boundary: walkBoundary,
  });
  if (existing) {
    let working = existing;
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      working = {
        ...existing,
        metadata: { ...existing.metadata, ...options.metadata },
      };
      await writeSessionRecord(working);
    }
    const requestedModel = reuseExplicitModelToApply(options);
    if (requestedModel) {
      // Internal ensure path — must NOT recycle the owner (the recycle flag is
      // left off). This runs as part of session ensure/spawn, which already
      // cold-reconnects; recycling here would thrash owners on ordinary prompts.
      // Owner-recycle is a CLI-verb-only behavior, set by the set-model and
      // set-effort handlers.
      const result = await setSessionModel({
        sessionId: working.acpxRecordId,
        modelId: requestedModel,
        mcpServers: options.mcpServers,
        nonInteractivePermissions: options.nonInteractivePermissions,
        authCredentials: options.authCredentials,
        authPolicy: options.authPolicy,
        terminal: options.terminal,
        timeoutMs: options.timeoutMs,
        verbose: options.verbose,
      });
      return { record: result.record, created: false };
    }
    return {
      record: working,
      created: false,
    };
  }

  // brick://16712ece — the walk above filters CLOSED entries out, so a closed
  // same-scope session is invisible here and we are about to create a fresh one
  // over the top of it. Probe for what it could not see BEFORE creating, so the
  // caller can say so; creating first would let the new record's own entry
  // muddy the answer.
  const closedMatches = await findClosedSessionsByDirectoryWalk({
    agentCommand: options.agentCommand,
    agentName: options.agentName,
    cwd,
    name: options.name,
    boundary: walkBoundary,
  });

  const record = await createSession({
    agentCommand: options.agentCommand,
    agentName: options.agentName,
    cwd,
    name: options.name,
    resumeSessionId: options.resumeSessionId,
    parentSessionId: options.parentSessionId,
    parentSessionUrl: options.parentSessionUrl,
    parentSeatId: options.parentSeatId,
    metadata: options.metadata,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    sessionOptions: options.sessionOptions,
  });

  return {
    record,
    created: true,
    ...describeClosedMatches(closedMatches),
  };
}

export { DEFAULT_QUEUE_OWNER_TTL_MS };
