import {
  AcpClient,
  type SessionCreateResult,
  type SessionForkResult,
  type SessionLoadResult,
} from "../../acp/client.js";
import { formatErrorMessage } from "../../acp/error-normalization.js";
import { withInterrupt, withTimeout } from "../../async-control.js";
import { applyLifecycleSnapshotToRecord } from "../../runtime/engine/lifecycle.js";
import { persistSessionOptions } from "../../runtime/engine/session-options.js";
import { persistAndApplyRequestedEffort } from "../../session/config-option-application.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import { createSessionConversation } from "../../session/conversation-model.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import { setCurrentModelId, syncAdvertisedModelState } from "../../session/mode-preference.js";
import { applyRequestedModelIfAdvertised } from "../../session/model-application.js";
import { persistSessionOwnerOptions } from "../../session/owner-options.js";
import {
  absolutePath,
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
import { DEFAULT_QUEUE_OWNER_TTL_MS } from "./contracts.js";
import type {
  SessionCreateOptions,
  SessionCreateWithClientResult,
  SessionEnsureOptions,
  SessionListOptions,
  SessionListResult,
} from "./contracts.js";
import { setSessionModel } from "./session-control.js";

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
  let requestedModelApplied = false;
  let forkContext:
    | {
        sourceRecord: SessionRecord;
        forkAtMessageIndex: number;
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
    requestedModelApplied = resumed.requestedModelApplied;
  } else if (options.forkFromSessionId) {
    const forked = await forkSessionRecordWithClient(client, options, cwd);
    sessionId = forked.sessionId;
    acpSessionId = forked.acpSessionId;
    agentSessionId = forked.agentSessionId;
    sessionResult = forked.sessionResult;
    sessionModels = forked.sessionModels;
    requestedModelApplied = forked.requestedModelApplied;
    forkContext = forked.forkContext;
  } else {
    const createdSession = await withTimeout(client.createSession(cwd), options.timeoutMs);
    sessionId = createdSession.sessionId;
    acpSessionId = sessionId;
    agentSessionId = normalizeRuntimeSessionId(createdSession.agentSessionId);
    sessionResult = createdSession;
    sessionModels = createdSession.models;
    requestedModelApplied = await applyRequestedModelIfAdvertised({
      client,
      sessionId,
      requestedModel: options.sessionOptions?.model,
      models: sessionModels,
      agentCommand: options.agentCommand,
      timeoutMs: options.timeoutMs,
    });
  }

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
          forkedAtMessageIndex: forkContext.forkAtMessageIndex,
        }
      : {}),
    ...(options.parentSessionId
      ? { kind: "session" as const, parentSessionId: options.parentSessionId }
      : {}),
    ...(options.metadata && Object.keys(options.metadata).length > 0
      ? { metadata: { ...options.metadata } }
      : {}),
  };

  applyLifecycleSnapshotToRecord(record, lifecycle);
  persistSessionOptions(record, options.sessionOptions);
  persistSessionOwnerOptions(record, options);
  applyConfigOptionsToRecord(record, sessionResult);
  await persistAndApplyRequestedEffort({
    client,
    sessionId,
    record,
    reasoningEffort: options.sessionOptions?.reasoningEffort,
    advertised: sessionResult.configOptions,
    modelId: options.sessionOptions?.model,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
  syncAdvertisedModelState(record, sessionModels);
  if (requestedModelApplied) {
    setCurrentModelId(record, options.sessionOptions?.model);
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
  if (forkContext) {
    await writeSessionRecordAtBoundary(record);
  } else {
    await writeSessionRecord(record);
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
  requestedModelApplied: boolean;
};

type ForkedSessionState = CreatedSessionState & {
  forkContext: {
    sourceRecord: SessionRecord;
    forkAtMessageIndex: number;
    messages: SessionRecord["messages"];
  };
};

type ForkSourceContext = {
  sourceRecord: SessionRecord;
  forkAtMessageIndex: number;
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
      requestedModelApplied: await applyRequestedModelIfAdvertised({
        client,
        sessionId: options.resumeSessionId,
        requestedModel: options.sessionOptions?.model,
        models: sessionModels,
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

  const forkAtMessageIndex = options.forkAtMessageIndex ?? sourceRecord.messages.length;
  if (forkAtMessageIndex < 0 || forkAtMessageIndex > sourceRecord.messages.length) {
    throw new Error(`--at-index out of range (0-${sourceRecord.messages.length})`);
  }

  return { sourceRecord, forkAtMessageIndex };
}

async function forkSessionRecordWithClient(
  client: AcpClient,
  options: SessionCreateOptions,
  cwd: string,
): Promise<ForkedSessionState> {
  const { sourceRecord, forkAtMessageIndex } = await resolveForkSourceContext(options);

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
    return {
      sessionId: forkedSession.sessionId,
      acpSessionId: forkedSession.sessionId,
      agentSessionId,
      sessionResult: forkedSession,
      sessionModels,
      requestedModelApplied: await applyRequestedModelIfAdvertised({
        client,
        sessionId: forkedSession.sessionId,
        requestedModel: options.sessionOptions?.model,
        models: sessionModels,
        agentCommand: options.agentCommand,
        timeoutMs: options.timeoutMs,
      }),
      forkContext: {
        sourceRecord,
        forkAtMessageIndex,
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
  return {
    acpxRecordId: "",
    parentSessionId: options.parentSessionId ?? null,
    // FW-19: the full parent URL (real host) only needs to reach the bridge at
    // session/new — the bridge persists it across reloads. Later (recover/keepwarm)
    // spawns derive the URL from parentSessionId against the local base URL
    // (correct same-box; the bridge has the cross-box URL persisted already).
    parentSessionUrl: options.parentSessionUrl ?? null,
    taskFolder: options.metadata?.task_folder ?? null,
    agentFolder: null,
    subscriptionId: options.sessionOptions?.subscription ?? null,
    profileId: options.sessionOptions?.profile ?? null,
  };
}

export async function createSessionWithClient(
  options: SessionCreateOptions,
): Promise<SessionCreateWithClientResult> {
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
    sessionOptions: options.sessionOptions,
    // The CREATION spawn must resolve CLAUDE_CONFIG_DIR from the chosen
    // subscription, exactly like the prompt/recover/keepwarm spawns do
    // (connected-session.ts / runtime.ts). Without this the first turn ignores
    // `--subscription` and falls through to the registry default. The record
    // does not exist yet, so the id is sourced from sessionOptions; the other
    // sessionContext fields are best-effort (each is guarded independently in
    // buildAgentEnvironment, so a null acpxRecordId only skips ACPX_SESSION_URL
    // on this one spawn — it is set on the next spawn from the persisted record).
    sessionContext: creationSessionContext(options),
  });

  try {
    const record = await withInterrupt(
      async () => await createSessionRecordWithClient(client, options),
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
    const requestedModel = options.sessionOptions?.model;
    if (requestedModel) {
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

  return {
    record,
    created: true,
  };
}

export { DEFAULT_QUEUE_OWNER_TTL_MS };
