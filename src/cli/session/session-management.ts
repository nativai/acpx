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
  normalizeName,
  resolveSessionRecord,
  writeSessionRecord,
  writeSessionRecordAtBoundary,
} from "../../session/persistence.js";
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
  modelSource: string | undefined;
} {
  return {
    requestedModel: options.sessionOptions?.model,
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

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
async function createSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
): Promise<SessionRecord> {
  const cwd = absolutePath(options.cwd);
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
      modelSource: effectiveSessionOptions?.modelSource,
      models: sessionModels,
      advertisedConfigOptions: createdSession.configOptions,
      agentCommand: options.agentCommand,
      timeoutMs: options.timeoutMs,
    });
  }
  const requestedModelApplied = modelApply.applied;
  // ⚠️ THE POST-MODEL RE-READ (CONCEPTION §5.2). Everything below that asks
  // "what does this session advertise?" must ask it of the advertisement that
  // exists AFTER the model was applied, never of the `session/new` snapshot.
  //
  // OpenCode advertises the `effort` option ONLY when the currently-selected
  // model reasons, and at `session/new` with the default model it is ABSENT
  // (I1 R8). Read the snapshot and `--reasoning-effort` silently never fires —
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
  const record: SessionRecord = {
    schema: "acpx.session.v1",
    acpxRecordId: sessionId,
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
    eventLog: defaultSessionEventLog(sessionId),
    closed: false,
    closedAt: undefined,
    pid: lifecycle.running ? lifecycle.pid : undefined,
    agentStartedAt: lifecycle.startedAt,
    protocolVersion: client.initializeResult?.protocolVersion,
    agentCapabilities: client.initializeResult?.agentCapabilities,
    ...conversation,
    acpx: desiredConfigOptions ? { desired_config_options: desiredConfigOptions } : {},
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
        }
      : {}),
    ...(options.metadata && Object.keys(options.metadata).length > 0
      ? { metadata: { ...options.metadata } }
      : {}),
  };

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
    modes: sessionResult.modes,
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
    taskFolder: options.metadata?.task_folder ?? null,
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

  const nearest = closedMatches[0];
  return {
    record,
    created: true,
    ...(nearest
      ? {
          createdBecauseClosed: {
            count: closedMatches.length,
            nearestRecordId: nearest.acpxRecordId,
            ...(nearest.name === undefined ? {} : { nearestName: nearest.name }),
          },
        }
      : {}),
  };
}

export { DEFAULT_QUEUE_OWNER_TTL_MS };
