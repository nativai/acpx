import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpClient } from "./client.js";
import { formatErrorMessage, normalizeOutputError } from "./error-normalization.js";
import { checkpointPerfMetricsCapture } from "./perf-metrics-capture.js";
import { formatPerfMetric, measurePerf, setPerfGauge, startPerfTimer } from "./perf-metrics.js";
import { refreshQueueOwnerLease } from "./queue-lease-store.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  createSessionConversation,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
  trimConversationForRuntime,
} from "./session-conversation-model.js";
import { defaultSessionEventLog } from "./session-event-log.js";
import { SessionEventWriter } from "./session-events.js";
import { InterruptedError, withInterrupt, withTimeout } from "./session-runtime-helpers.js";
export { InterruptedError, TimeoutError } from "./session-runtime-helpers.js";
import {
  type QueueOwnerMessage,
  type QueueTask,
  QUEUE_CONNECT_RETRY_MS,
  SessionQueueOwner,
  isProcessAlive,
  releaseQueueOwnerLease,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
  tryCancelOnRunningOwner,
  trySetConfigOptionOnRunningOwner,
  trySetModeOnRunningOwner,
  trySubmitToRunningOwner,
  waitMs,
} from "./queue-ipc.js";
import {
  QueueOwnerTurnController,
  type QueueOwnerActiveSessionController,
} from "./queue-owner-turn-controller.js";
import { normalizeRuntimeSessionId } from "./runtime-session-id.js";
import { setDesiredModeId } from "./session-mode-preference.js";
import { connectAndLoadSession } from "./session-runtime/connect-load.js";
import { applyConversation, applyLifecycleSnapshotToRecord } from "./session-runtime/lifecycle.js";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetModeDirect,
} from "./session-runtime/prompt-runner.js";
import {
  queueOwnerRuntimeOptionsFromSend,
  spawnQueueOwnerProcess,
  type QueueOwnerRuntimeOptions,
} from "./session-runtime/queue-owner-process.js";
export type { QueueOwnerRuntimeOptions } from "./session-runtime/queue-owner-process.js";
import { promptToDisplayText, textPrompt } from "./prompt-content.js";
import {
  DEFAULT_HISTORY_LIMIT,
  absolutePath,
  findGitRepositoryRoot,
  findSession,
  findSessionByDirectoryWalk,
  isoNow,
  listSessions,
  listSessionsForAgent,
  normalizeName,
  resolveSessionRecord,
  writeSessionRecord,
} from "./session-persistence.js";
import {
  SESSION_RECORD_SCHEMA,
  type AcpJsonRpcMessage,
  type AuthPolicy,
  type McpServer,
  type NonInteractivePermissionPolicy,
  type OutputErrorEmissionPolicy,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
  type OutputFormatter,
  type PermissionMode,
  type PromptInput,
  type RunPromptResult,
  type SessionEnsureResult,
  type SessionRecord,
  type SessionSetConfigOptionResult,
  type SessionSetModeResult,
  type SessionSendOutcome,
  type SessionSendResult,
  type SubagentRef,
} from "./types.js";

function claudeSubagentDir(cwd: string, acpSessionId: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const cwdHash = cwd.replace(/\//g, "-");
  return path.join(configDir, "projects", cwdHash, acpSessionId, "subagents");
}

export const DEFAULT_QUEUE_OWNER_TTL_MS = 300_000;
const INTERRUPT_CANCEL_WAIT_MS = 2_500;
const QUEUE_OWNER_STARTUP_MAX_ATTEMPTS = 120;
const QUEUE_OWNER_HEARTBEAT_INTERVAL_MS = 5_000;

type TimedRunOptions = {
  timeoutMs?: number;
};

export type SessionAgentOptions = {
  model?: string;
  allowedTools?: string[];
  maxTurns?: number;
};

export type RunOnceOptions = {
  agentCommand: string;
  cwd: string;
  prompt: PromptInput;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  sessionOptions?: SessionAgentOptions;
} & TimedRunOptions;

export type SessionCreateOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  resumeSessionId?: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
  sessionOptions?: SessionAgentOptions;
} & TimedRunOptions;

export type SessionSendOptions = {
  sessionId: string;
  prompt: PromptInput;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  waitForCompletion?: boolean;
  ttlMs?: number;
  maxQueueDepth?: number;
} & TimedRunOptions;

export type SessionEnsureOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  resumeSessionId?: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
  walkBoundary?: string;
  sessionOptions?: SessionAgentOptions;
} & TimedRunOptions;

export type SessionCancelOptions = {
  sessionId: string;
  verbose?: boolean;
};

export type SessionCancelResult = {
  sessionId: string;
  cancelled: boolean;
};

export type SessionSetModeOptions = {
  sessionId: string;
  modeId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionSetConfigOptionOptions = {
  sessionId: string;
  configId: string;
  value: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  verbose?: boolean;
} & TimedRunOptions;

function toPromptResult(
  stopReason: RunPromptResult["stopReason"],
  sessionId: string,
  client: AcpClient,
): RunPromptResult {
  return {
    stopReason,
    sessionId,
    permissionStats: client.getPermissionStats(),
  };
}

type RunSessionPromptOptions = {
  sessionRecordId: string;
  prompt: PromptInput;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  onPromptActive?: () => Promise<void> | void;
  client?: AcpClient;
  // Called with a handler once the ACP prompt is in-flight; the handler
  // accepts a QueueTask and concurrently calls client.prompt() for it so the
  // agent sees the new message mid-turn via the Pushable queue.
  setMidTurnHandler?: (handler: ((task: QueueTask) => void) | undefined) => void;
};

type ActiveSessionController = QueueOwnerActiveSessionController;

class QueueTaskOutputFormatter implements OutputFormatter {
  private readonly requestId: string;
  private readonly send: (message: QueueOwnerMessage) => void;

  constructor(task: QueueTask) {
    this.requestId = task.requestId;
    this.send = task.send;
  }

  setContext(_context: { sessionId: string }): void {
    // queue formatter context is fixed by task request id
  }

  onAcpMessage(message: AcpJsonRpcMessage): void {
    this.send({
      type: "event",
      requestId: this.requestId,
      message,
    });
  }

  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    this.send({
      type: "error",
      requestId: this.requestId,
      code: params.code,
      detailCode: params.detailCode,
      origin: params.origin,
      message: params.message,
      retryable: params.retryable,
      acp: params.acp,
    });
  }

  flush(): void {
    // no-op for stream forwarding
  }
}

const DISCARD_OUTPUT_FORMATTER: OutputFormatter = {
  setContext(_context) {
    // no-op
  },
  onAcpMessage() {
    // no-op
  },
  onError() {
    // no-op
  },
  flush() {
    // no-op
  },
};

function jsonRpcIdKey(value: unknown): string | undefined {
  if (typeof value === "string") {
    return `s:${value}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `n:${value}`;
  }
  return undefined;
}

function extractJsonRpcRequestInfo(
  message: AcpJsonRpcMessage,
): { idKey: string; method: string } | undefined {
  const candidate = message as { method?: unknown; id?: unknown };
  if (typeof candidate.method !== "string") {
    return undefined;
  }
  const idKey = jsonRpcIdKey(candidate.id);
  if (!idKey) {
    return undefined;
  }
  return {
    idKey,
    method: candidate.method,
  };
}

function extractJsonRpcResponseInfo(
  message: AcpJsonRpcMessage,
): { idKey: string; hasError: boolean } | undefined {
  const candidate = message as { id?: unknown; error?: unknown; result?: unknown };
  const idKey = jsonRpcIdKey(candidate.id);
  if (!idKey) {
    return undefined;
  }
  const hasError = Object.hasOwn(candidate, "error");
  const hasResult = Object.hasOwn(candidate, "result");
  if (!hasError && !hasResult) {
    return undefined;
  }
  return {
    idKey,
    hasError,
  };
}

function filterRecoverableLoadFallbackOutput(messages: AcpJsonRpcMessage[]): AcpJsonRpcMessage[] {
  const requestMethodById = new Map<string, string>();
  const failedLoadRequestIds = new Set<string>();

  for (const message of messages) {
    const request = extractJsonRpcRequestInfo(message);
    if (request) {
      requestMethodById.set(request.idKey, request.method);
      continue;
    }

    const response = extractJsonRpcResponseInfo(message);
    if (!response || !response.hasError) {
      continue;
    }

    if (requestMethodById.get(response.idKey) === "session/load") {
      failedLoadRequestIds.add(response.idKey);
    }
  }

  if (failedLoadRequestIds.size === 0) {
    return messages;
  }

  return messages.filter((message) => {
    const request = extractJsonRpcRequestInfo(message);
    if (request && request.method === "session/load" && failedLoadRequestIds.has(request.idKey)) {
      return false;
    }

    const response = extractJsonRpcResponseInfo(message);
    if (response && failedLoadRequestIds.has(response.idKey)) {
      return false;
    }

    return true;
  });
}

export function normalizeQueueOwnerTtlMs(ttlMs: number | undefined): number {
  if (ttlMs == null) {
    return DEFAULT_QUEUE_OWNER_TTL_MS;
  }

  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    return DEFAULT_QUEUE_OWNER_TTL_MS;
  }

  // 0 means keep alive forever (no TTL)
  return Math.round(ttlMs);
}

async function runQueuedTask(
  sessionRecordId: string,
  task: QueueTask,
  options: {
    sharedClient?: AcpClient;
    verbose?: boolean;
    mcpServers?: McpServer[];
    nonInteractivePermissions?: NonInteractivePermissionPolicy;
    authCredentials?: Record<string, string>;
    authPolicy?: AuthPolicy;
    suppressSdkConsoleErrors?: boolean;
    onClientAvailable?: (controller: ActiveSessionController) => void;
    onClientClosed?: () => void;
    onPromptActive?: () => Promise<void> | void;
    setMidTurnHandler?: (handler: ((task: QueueTask) => void) | undefined) => void;
  },
): Promise<void> {
  const outputFormatter = task.waitForCompletion
    ? new QueueTaskOutputFormatter(task)
    : DISCARD_OUTPUT_FORMATTER;

  try {
    const result = await runSessionPrompt({
      sessionRecordId,
      mcpServers: options.mcpServers,
      prompt: task.prompt ?? textPrompt(task.message),
      permissionMode: task.permissionMode,
      nonInteractivePermissions:
        task.nonInteractivePermissions ?? options.nonInteractivePermissions,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      outputFormatter,
      timeoutMs: task.timeoutMs,
      suppressSdkConsoleErrors: task.suppressSdkConsoleErrors ?? options.suppressSdkConsoleErrors,
      verbose: options.verbose,
      onClientAvailable: options.onClientAvailable,
      onClientClosed: options.onClientClosed,
      onPromptActive: options.onPromptActive,
      client: options.sharedClient,
      setMidTurnHandler: options.setMidTurnHandler,
    });

    if (task.waitForCompletion) {
      task.send({
        type: "result",
        requestId: task.requestId,
        result,
      });
    }
  } catch (error) {
    const normalizedError = normalizeOutputError(error, {
      origin: "runtime",
      detailCode: "QUEUE_RUNTIME_PROMPT_FAILED",
    });
    const alreadyEmitted =
      (error as { outputAlreadyEmitted?: unknown }).outputAlreadyEmitted === true;
    if (task.waitForCompletion) {
      task.send({
        type: "error",
        requestId: task.requestId,
        code: normalizedError.code,
        detailCode: normalizedError.detailCode,
        origin: normalizedError.origin,
        message: normalizedError.message,
        retryable: normalizedError.retryable,
        acp: normalizedError.acp,
        outputAlreadyEmitted: alreadyEmitted,
      });
    }

    if (error instanceof InterruptedError) {
      throw error;
    }
  } finally {
    task.close();
  }
}

async function runSessionPrompt(options: RunSessionPromptOptions): Promise<SessionSendResult> {
  const stopTotalTimer = startPerfTimer("runtime.prompt.total");
  const output = options.outputFormatter;
  const record = await measurePerf("session.resolve_prompt_record", async () => {
    return await resolveSessionRecord(options.sessionRecordId);
  });
  const conversation = cloneSessionConversation(record);
  let acpxState = cloneSessionAcpxState(record.acpx);
  recordPromptSubmission(conversation, options.prompt, isoNow());

  output.setContext({
    sessionId: record.acpxRecordId,
  });

  const eventWriter = await measurePerf("session.events.open", async () => {
    return await SessionEventWriter.open(record);
  });
  const pendingMessages: AcpJsonRpcMessage[] = [];
  const pendingConnectOutputMessages: AcpJsonRpcMessage[] = [];
  let bufferingConnectOutput = true;
  let sawAcpMessage = false;
  let eventWriterClosed = false;

  // Subagent tracking: map from agent_id (e.g. "poet-a@haiku-demo") to ACPX record id
  const subagentIdToAcpxRecordId = new Map<string, string>();
  // Subagent event writers: map from ACPX record id to event writer
  const subagentEventWriters = new Map<string, SessionEventWriter>();

  const getOrOpenSubagentEventWriter = async (
    childAcpxRecordId: string,
  ): Promise<SessionEventWriter | undefined> => {
    const existing = subagentEventWriters.get(childAcpxRecordId);
    if (existing) {
      return existing;
    }
    try {
      const childRecord = await resolveSessionRecord(childAcpxRecordId);
      const writer = await SessionEventWriter.open(childRecord);
      subagentEventWriters.set(childAcpxRecordId, writer);
      return writer;
    } catch {
      return undefined;
    }
  };

  const closeAllSubagentEventWriters = async (): Promise<void> => {
    for (const [id, writer] of subagentEventWriters) {
      try {
        await writer.close({ checkpoint: true });
      } catch {
        // best effort
      }
      subagentEventWriters.delete(id);
    }
  };

  // Flush pending messages to the stream file every 500ms so external readers
  // (e.g. UI tools) can observe progress in real-time rather than only at turn end.
  const streamFlushInterval = setInterval(() => {
    void flushPendingMessages(false).catch(() => {});
  }, 500);

  const closeEventWriter = async (checkpoint: boolean): Promise<void> => {
    if (eventWriterClosed) {
      return;
    }
    eventWriterClosed = true;
    await closeAllSubagentEventWriters();
    await eventWriter.close({ checkpoint });
  };

  const flushPendingMessages = async (checkpoint = false): Promise<void> => {
    if (pendingMessages.length === 0) {
      return;
    }

    const batch = pendingMessages.splice(0, pendingMessages.length);
    await measurePerf("session.events.flush_pending", async () => {
      await eventWriter.appendMessages(batch, { checkpoint });
    });
  };

  // Extract claudeCode metadata from a raw ACP message (session/update notification)
  const extractClaudeCodeMeta = (
    message: AcpJsonRpcMessage,
  ): Record<string, unknown> | undefined => {
    const msg = message as Record<string, unknown>;
    if (msg.method !== "session/update") {
      return undefined;
    }
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params) {
      return undefined;
    }
    // Check notification-level _meta first (for subagentId routing)
    const notifMeta = params._meta as Record<string, unknown> | undefined;
    if (notifMeta?.claudeCode) {
      return notifMeta.claudeCode as Record<string, unknown>;
    }
    // Check update-level _meta (for teammate_spawned status)
    const update = params.update as Record<string, unknown> | undefined;
    if (!update) {
      return undefined;
    }
    const updateMeta = update._meta as Record<string, unknown> | undefined;
    return updateMeta?.claudeCode as Record<string, unknown> | undefined;
  };

  const ownClient = options.client == null;
  const client =
    options.client ??
    new AcpClient({
      agentCommand: record.agentCommand,
      cwd: absolutePath(record.cwd),
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode,
      nonInteractivePermissions: options.nonInteractivePermissions,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
      verbose: options.verbose,
    });
  client.updateRuntimeOptions({
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
  });
  client.setEventHandlers({
    onAcpMessage: (_direction, message) => {
      sawAcpMessage = true;
      pendingMessages.push(message);
      // Route messages with subagentId to the child stream as well
      const claudeCodeMeta = extractClaudeCodeMeta(message);
      if (claudeCodeMeta) {
        const subagentId = claudeCodeMeta.subagentId;
        if (typeof subagentId === "string") {
          const childAcpxRecordId = subagentIdToAcpxRecordId.get(subagentId);
          if (childAcpxRecordId) {
            void getOrOpenSubagentEventWriter(childAcpxRecordId).then((writer) => {
              if (writer) {
                void writer.appendMessage(message).catch(() => {});
              }
            });
          }
        }
      }
    },
    onAcpOutputMessage: (_direction, message) => {
      if (bufferingConnectOutput) {
        pendingConnectOutputMessages.push(message);
        return;
      }
      output.onAcpMessage(message);
    },
    onSessionUpdate: (notification) => {
      acpxState = recordConversationSessionUpdate(conversation, acpxState, notification);
      trimConversationForRuntime(conversation);

      // Detect teammate_spawned events to create subagent session records
      const update = notification.update as Record<string, unknown>;
      if (update.sessionUpdate === "tool_call_update" || update.sessionUpdate === "tool_call") {
        const updateMeta = update._meta as Record<string, unknown> | null | undefined;
        const claudeCodeMeta = updateMeta?.claudeCode as Record<string, unknown> | undefined;
        if (claudeCodeMeta?.status === "teammate_spawned") {
          const agentId = claudeCodeMeta.subagentId;
          const subagentName = claudeCodeMeta.subagentName ?? claudeCodeMeta.subagentId;
          const color = claudeCodeMeta.subagentColor;
          if (typeof agentId === "string") {
            const spawnedAt = isoNow();
            const childAcpxRecordId = crypto.randomUUID();
            const childAcpSessionId = `subagent-${childAcpxRecordId}`;
            const childName =
              typeof subagentName === "string" ? subagentName.split("@")[0] : undefined;
            const childRecord: SessionRecord = {
              schema: SESSION_RECORD_SCHEMA,
              acpxRecordId: childAcpxRecordId,
              acpSessionId: childAcpSessionId,
              agentCommand: "",
              cwd: record.cwd,
              name: childName,
              createdAt: spawnedAt,
              lastUsedAt: spawnedAt,
              lastSeq: 0,
              eventLog: defaultSessionEventLog(childAcpxRecordId),
              closed: false,
              messages: [],
              updated_at: spawnedAt,
              cumulative_token_usage: {},
              request_token_usage: {},
              kind: "subagent",
              parentSessionId: record.acpxRecordId,
            };
            subagentIdToAcpxRecordId.set(agentId, childAcpxRecordId);

            const subagentRef: SubagentRef = {
              acpxRecordId: childAcpxRecordId,
              name: childName ?? agentId,
              color: typeof color === "string" ? color : undefined,
              spawnedAt,
              claudeJsonlPath: claudeSubagentDir(record.cwd, record.acpSessionId),
            };

            void (async () => {
              try {
                await writeSessionRecord(childRecord);
                // Update parent record with new subagent ref
                const parentRecord = eventWriter.getRecord();
                parentRecord.subagents = [...(parentRecord.subagents ?? []), subagentRef];
                await writeSessionRecord(parentRecord);
              } catch {
                // best effort — don't fail the main prompt
              }
            })();
          }
        }
      }
    },
    onClientOperation: (operation) => {
      acpxState = recordConversationClientOperation(conversation, acpxState, operation);
      trimConversationForRuntime(conversation);
    },
  });
  let activeSessionIdForControl = record.acpSessionId;
  let notifiedClientAvailable = false;
  const activeController: ActiveSessionController = {
    hasActivePrompt: () => client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
    setSessionMode: async (modeId: string) => {
      await client.setSessionMode(activeSessionIdForControl, modeId);
    },
    setSessionConfigOption: async (configId: string, value: string) => {
      return await client.setSessionConfigOption(activeSessionIdForControl, configId, value);
    },
  };

  try {
    return await withInterrupt(
      async () => {
        const connectStartedAt = Date.now();
        const {
          sessionId: activeSessionId,
          resumed,
          loadError,
        } = await measurePerf("runtime.connect_and_load", async () => {
          try {
            return await connectAndLoadSession({
              client,
              record,
              timeoutMs: options.timeoutMs,
              verbose: options.verbose,
              activeController,
              onClientAvailable: (controller) => {
                options.onClientAvailable?.(controller);
                notifiedClientAvailable = true;
              },
              onConnectedRecord: (connectedRecord) => {
                connectedRecord.lastPromptAt = isoNow();
              },
              onSessionIdResolved: (sessionId) => {
                activeSessionIdForControl = sessionId;
              },
            });
          } catch (error) {
            bufferingConnectOutput = false;
            for (const message of pendingConnectOutputMessages) {
              output.onAcpMessage(message);
            }
            pendingConnectOutputMessages.length = 0;
            throw error;
          }
        });
        bufferingConnectOutput = false;
        const connectOutputMessages =
          loadError == null
            ? pendingConnectOutputMessages
            : filterRecoverableLoadFallbackOutput(pendingConnectOutputMessages);
        for (const message of connectOutputMessages) {
          output.onAcpMessage(message);
        }
        pendingConnectOutputMessages.length = 0;
        if (options.verbose) {
          process.stderr.write(
            `[acpx] ${formatPerfMetric("prompt.connect_and_load", Date.now() - connectStartedAt)}\n`,
          );
        }

        output.setContext({
          sessionId: record.acpxRecordId,
        });
        await flushPendingMessages(false);

        let response;
        try {
          const promptStartedAt = Date.now();
          const promptPromise = client.prompt(activeSessionId, options.prompt);
          if (options.onPromptActive) {
            try {
              await options.onPromptActive();
            } catch (error) {
              if (options.verbose) {
                process.stderr.write(
                  "[acpx] onPromptActive hook failed: " + formatErrorMessage(error) + "\n",
                );
              }
            }
          }

          // Register the mid-turn concurrent injection handler now that the ACP
          // prompt is in-flight. Any task injected here calls client.prompt()
          // concurrently so the agent sees the new message via its Pushable queue
          // mid-turn rather than waiting for the current turn to end.
          //
          // We track each injected promise so we can await all of them after the
          // first turn finishes. This prevents the main loop from picking up the
          // next sequential task while an injected prompt is still in-flight —
          // which would cause a second concurrent client.prompt() call that would
          // cut the injected turn short before it produces any output.
          const injectedPromises: Promise<void>[] = [];
          options.setMidTurnHandler?.((injectedTask: QueueTask) => {
            const injectedPromise = (async () => {
              try {
                const injectedResponse = await client.prompt(
                  activeSessionId,
                  injectedTask.prompt ?? textPrompt(injectedTask.message),
                );
                if (injectedTask.waitForCompletion) {
                  injectedTask.send({
                    type: "result",
                    requestId: injectedTask.requestId,
                    result: toPromptResult(
                      injectedResponse.stopReason,
                      record.acpxRecordId,
                      client,
                    ),
                  });
                }
              } catch (injectedError) {
                if (injectedTask.waitForCompletion) {
                  const normalized = normalizeOutputError(injectedError, {
                    origin: "runtime",
                    detailCode: "MID_TURN_PROMPT_FAILED",
                  });
                  injectedTask.send({
                    type: "error",
                    requestId: injectedTask.requestId,
                    code: normalized.code,
                    detailCode: normalized.detailCode,
                    origin: normalized.origin,
                    message: normalized.message,
                    retryable: normalized.retryable,
                  });
                }
              } finally {
                injectedTask.close();
              }
            })();
            injectedPromises.push(injectedPromise);
          });

          response = await measurePerf("runtime.prompt.agent_turn", async () => {
            return await withTimeout(promptPromise, options.timeoutMs);
          });

          // First turn is done — clear the mid-turn handler so no new concurrent
          // calls are made while we are writing the result and closing the writer.
          options.setMidTurnHandler?.(undefined);

          // Await all in-flight injected prompts before returning so the main
          // loop does not start the next sequential task while the injected
          // client.prompt() is still running. A second concurrent call would
          // push the next sequential message into the injected turn's context,
          // causing it to end early with no visible output.
          if (injectedPromises.length > 0) {
            await Promise.allSettled(injectedPromises);
            await flushPendingMessages(false);
          }
          if (options.verbose) {
            process.stderr.write(
              `[acpx] ${formatPerfMetric("prompt.agent_turn", Date.now() - promptStartedAt)}\n`,
            );
          }
        } catch (error) {
          options.setMidTurnHandler?.(undefined);
          const snapshot = client.getAgentLifecycleSnapshot();
          applyLifecycleSnapshotToRecord(record, snapshot);
          if (snapshot.lastExit?.unexpectedDuringPrompt && options.verbose) {
            process.stderr.write(
              "[acpx] agent disconnected during prompt (" +
                snapshot.lastExit.reason +
                ", exit=" +
                snapshot.lastExit.exitCode +
                ", signal=" +
                (snapshot.lastExit.signal ?? "none") +
                ")\n",
            );
          }

          const normalizedError = normalizeOutputError(error, {
            origin: "runtime",
          });

          await flushPendingMessages(false).catch(() => {
            // best effort while bubbling prompt failure
          });

          output.flush();

          record.lastUsedAt = isoNow();
          applyConversation(record, conversation);
          record.acpx = acpxState;

          const propagated = error instanceof Error ? error : new Error(formatErrorMessage(error));
          (propagated as { outputAlreadyEmitted?: boolean }).outputAlreadyEmitted = sawAcpMessage;
          (propagated as { normalizedOutputError?: unknown }).normalizedOutputError =
            normalizedError;
          throw propagated;
        }

        await flushPendingMessages(false);
        output.flush();

        const now = isoNow();
        record.lastUsedAt = now;
        record.closed = false;
        record.closedAt = undefined;
        record.protocolVersion = client.initializeResult?.protocolVersion;
        record.agentCapabilities = client.initializeResult?.agentCapabilities;
        applyConversation(record, conversation);
        record.acpx = acpxState;
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        stopTotalTimer();

        return {
          ...toPromptResult(response.stopReason, record.acpxRecordId, client),
          record,
          resumed,
          loadError,
        };
      },
      async () => {
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.lastUsedAt = isoNow();
        applyConversation(record, conversation);
        record.acpx = acpxState;
        await flushPendingMessages(false).catch(() => {
          // best effort while process is being interrupted
        });
        if (ownClient) {
          await client.close();
        }
      },
    );
  } finally {
    if (options.verbose) {
      process.stderr.write(`[acpx] ${formatPerfMetric("prompt.total", stopTotalTimer())}\n`);
    } else {
      stopTotalTimer();
    }
    if (notifiedClientAvailable) {
      options.onClientClosed?.();
    }
    client.clearEventHandlers();
    if (ownClient) {
      await client.close();
    }
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    applyConversation(record, conversation);
    record.acpx = acpxState;
    clearInterval(streamFlushInterval);
    await flushPendingMessages(false).catch(() => {
      // best effort on close
    });
    await closeEventWriter(true).catch(() => {
      // best effort on close
    });
  }
}

export async function runOnce(options: RunOnceOptions): Promise<RunPromptResult> {
  const output = options.outputFormatter;
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    onAcpOutputMessage: (_direction, message) => output.onAcpMessage(message),
    sessionOptions: options.sessionOptions,
  });

  try {
    return await withInterrupt(
      async () => {
        await measurePerf("runtime.exec.start", async () => {
          await withTimeout(client.start(), options.timeoutMs);
        });
        const createdSession = await measurePerf("runtime.exec.create_session", async () => {
          return await withTimeout(
            client.createSession(absolutePath(options.cwd)),
            options.timeoutMs,
          );
        });
        const sessionId = createdSession.sessionId;

        output.setContext({
          sessionId,
        });

        const response = await measurePerf("runtime.exec.prompt", async () => {
          return await withTimeout(client.prompt(sessionId, options.prompt), options.timeoutMs);
        });
        output.flush();
        return toPromptResult(response.stopReason, sessionId, client);
      },
      async () => {
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
        await client.close();
      },
    );
  } finally {
    await client.close();
  }
}

export async function createSession(options: SessionCreateOptions): Promise<SessionRecord> {
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    verbose: options.verbose,
    sessionOptions: options.sessionOptions,
  });

  try {
    return await withInterrupt(
      async () => {
        const cwd = absolutePath(options.cwd);
        await measurePerf("runtime.session_create.start", async () => {
          await withTimeout(client.start(), options.timeoutMs);
        });
        let sessionId: string;
        let agentSessionId: string | undefined;

        if (options.resumeSessionId) {
          if (!client.supportsLoadSession()) {
            throw new Error(
              `Agent command "${options.agentCommand}" does not support session/load; cannot resume session ${options.resumeSessionId}`,
            );
          }

          try {
            const loadedSession = await withTimeout(
              client.loadSession(options.resumeSessionId, cwd),
              options.timeoutMs,
            );
            sessionId = options.resumeSessionId;
            agentSessionId = normalizeRuntimeSessionId(loadedSession.agentSessionId);
          } catch (error) {
            throw new Error(
              `Failed to resume ACP session ${options.resumeSessionId}: ${formatErrorMessage(error)}`,
              {
                cause: error,
              },
            );
          }
        } else {
          const createdSession = await measurePerf(
            "runtime.session_create.create_session",
            async () => await withTimeout(client.createSession(cwd), options.timeoutMs),
          );
          sessionId = createdSession.sessionId;
          agentSessionId = normalizeRuntimeSessionId(createdSession.agentSessionId);
        }
        const lifecycle = client.getAgentLifecycleSnapshot();

        const now = isoNow();
        const record: SessionRecord = {
          schema: SESSION_RECORD_SCHEMA,
          acpxRecordId: sessionId,
          acpSessionId: sessionId,
          agentSessionId,
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
          pid: lifecycle.pid,
          agentStartedAt: lifecycle.startedAt,
          protocolVersion: client.initializeResult?.protocolVersion,
          agentCapabilities: client.initializeResult?.agentCapabilities,
          ...createSessionConversation(now),
          acpx: {},
        };

        await writeSessionRecord(record);
        return record;
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
    cwd,
    name: options.name,
    boundary: walkBoundary,
  });
  if (existing) {
    return {
      record: existing,
      created: false,
    };
  }

  const record = await createSession({
    agentCommand: options.agentCommand,
    cwd,
    name: options.name,
    resumeSessionId: options.resumeSessionId,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    sessionOptions: options.sessionOptions,
  });

  return {
    record,
    created: true,
  };
}

async function submitToRunningOwner(
  options: SessionSendOptions,
  waitForCompletion: boolean,
): Promise<SessionSendOutcome | undefined> {
  return await trySubmitToRunningOwner({
    sessionId: options.sessionId,
    message: promptToDisplayText(options.prompt),
    prompt: options.prompt,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    outputFormatter: options.outputFormatter,
    errorEmissionPolicy: options.errorEmissionPolicy,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    waitForCompletion,
    verbose: options.verbose,
  });
}

export async function runSessionQueueOwner(options: QueueOwnerRuntimeOptions): Promise<void> {
  const lease = await tryAcquireQueueOwnerLease(options.sessionId);
  if (!lease) {
    return;
  }

  const sessionRecord = await resolveSessionRecord(options.sessionId);
  let owner: SessionQueueOwner | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let idleDrain: { stop: () => Promise<void> } | undefined;
  const sharedClient = new AcpClient({
    agentCommand: sessionRecord.agentCommand,
    cwd: absolutePath(sessionRecord.cwd),
    mcpServers: options.mcpServers,
    permissionMode: "approve-reads",
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
  });
  const ttlMs = normalizeQueueOwnerTtlMs(options.ttlMs);
  const maxQueueDepth = Math.max(1, Math.round(options.maxQueueDepth ?? 16));
  const taskPollTimeoutMs = ttlMs === 0 ? undefined : ttlMs;
  const initialTaskPollTimeoutMs =
    taskPollTimeoutMs == null ? undefined : Math.max(taskPollTimeoutMs, 1_000);
  const turnController = new QueueOwnerTurnController({
    withTimeout: async (run, timeoutMs) => await withTimeout(run(), timeoutMs),
    setSessionModeFallback: async (modeId: string, timeoutMs?: number) => {
      await runSessionSetModeDirect({
        sessionRecordId: options.sessionId,
        modeId,
        mcpServers: options.mcpServers,
        nonInteractivePermissions: options.nonInteractivePermissions,
        authCredentials: options.authCredentials,
        authPolicy: options.authPolicy,
        timeoutMs,
        verbose: options.verbose,
      });
    },
    setSessionConfigOptionFallback: async (configId: string, value: string, timeoutMs?: number) => {
      const result = await runSessionSetConfigOptionDirect({
        sessionRecordId: options.sessionId,
        configId,
        value,
        mcpServers: options.mcpServers,
        nonInteractivePermissions: options.nonInteractivePermissions,
        authCredentials: options.authCredentials,
        authPolicy: options.authPolicy,
        timeoutMs,
        verbose: options.verbose,
      });
      return result.response;
    },
  });

  const applyPendingCancel = async (): Promise<boolean> => {
    return await turnController.applyPendingCancel();
  };

  const scheduleApplyPendingCancel = (): void => {
    void applyPendingCancel().catch((error) => {
      if (options.verbose) {
        process.stderr.write(
          `[acpx] failed to apply deferred cancel: ${formatErrorMessage(error)}\n`,
        );
      }
    });
  };

  const setActiveController = (controller: ActiveSessionController) => {
    turnController.setActiveController(controller);
    scheduleApplyPendingCancel();
  };

  const clearActiveController = () => {
    turnController.clearActiveController();
  };

  const runPromptTurn = async <T>(run: () => Promise<T>): Promise<T> => {
    turnController.beginTurn();
    try {
      return await run();
    } finally {
      turnController.endTurn();
    }
  };

  try {
    owner = await SessionQueueOwner.start(
      lease,
      {
        cancelPrompt: async () => {
          const accepted = await turnController.requestCancel();
          if (!accepted) {
            return false;
          }
          await applyPendingCancel();
          return true;
        },
        setSessionMode: async (modeId: string, timeoutMs?: number) => {
          await turnController.setSessionMode(modeId, timeoutMs);
        },
        setSessionConfigOption: async (configId: string, value: string, timeoutMs?: number) => {
          return await turnController.setSessionConfigOption(configId, value, timeoutMs);
        },
      },
      {
        maxQueueDepth,
        onQueueDepthChanged: (queueDepth) => {
          setPerfGauge("queue.owner.depth", queueDepth);
          void refreshQueueOwnerLease(lease, { queueDepth }).catch(() => {
            // best effort heartbeat refresh while owner is live
          });
        },
      },
    );

    if (options.verbose) {
      process.stderr.write(
        `[acpx] queue owner ready for session ${options.sessionId} (ttlMs=${ttlMs}, maxQueueDepth=${maxQueueDepth})\n`,
      );
    }
    await refreshQueueOwnerLease(lease, { queueDepth: owner.queueDepth() }).catch(() => {
      // best effort initial heartbeat
    });
    heartbeatTimer = setInterval(() => {
      void refreshQueueOwnerLease(lease, { queueDepth: owner?.queueDepth() ?? 0 }).catch(() => {
        // best effort heartbeat
      });
    }, QUEUE_OWNER_HEARTBEAT_INTERVAL_MS);

    // Mid-turn injection:
    // Tasks that arrive while a prompt turn is active bypass the normal queue
    // and are injected concurrently via client.prompt() so the agent sees the
    // new message through its Pushable queue mid-turn.
    //
    // Two-phase design:
    //   1. "Capture" phase — from the moment a task starts executing until
    //      client.prompt() is in-flight, incoming tasks land in midTurnBuffer.
    //   2. "Active" phase — once activeMidTurnHandler is registered (after
    //      client.prompt() is called), the buffer is drained into it
    //      immediately and all subsequent tasks are injected directly.
    let activeMidTurnHandler: ((task: QueueTask) => void) | undefined;
    const midTurnBuffer: QueueTask[] = [];
    let midTurnCaptureActive = false;

    owner.setMidTurnHandler((task: QueueTask): boolean => {
      if (activeMidTurnHandler) {
        activeMidTurnHandler(task);
        return true;
      }
      if (midTurnCaptureActive) {
        // Buffer the task until the concurrent handler is ready.
        midTurnBuffer.push(task);
        return true;
      }
      // Not in a turn — let the task queue normally.
      return false;
    });

    const runTaskOptions = {
      sharedClient,
      verbose: options.verbose,
      mcpServers: options.mcpServers,
      nonInteractivePermissions: options.nonInteractivePermissions,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
      onClientAvailable: setActiveController,
      onClientClosed: clearActiveController,
      onPromptActive: async () => {
        turnController.markPromptActive();
        await applyPendingCancel();
      },
      setMidTurnHandler: (handler: ((task: QueueTask) => void) | undefined) => {
        activeMidTurnHandler = handler;
        if (handler) {
          // Drain any tasks that arrived during the capture phase.
          for (const buffered of midTurnBuffer.splice(0)) {
            handler(buffered);
          }
        }
      },
    };

    // Idle stream drain: captures inter-turn teammate activity (session/update
    // notifications sent by the adapter's background reader between prompts).
    const startIdleStreamDrain = async (): Promise<{ stop: () => Promise<void> }> => {
      let active = true;
      const pendingIdle: AcpJsonRpcMessage[] = [];
      const pendingSubagent = new Map<string, AcpJsonRpcMessage[]>();
      const subagentWriters = new Map<string, SessionEventWriter>();

      const idleRecord = await resolveSessionRecord(options.sessionId);
      const idleWriter = await SessionEventWriter.open(idleRecord);

      // Build name → childAcpxRecordId from the parent's subagents array.
      // This is populated after each prompt turn (teammate_spawned writes the child record).
      const subagentNameToRecordId = new Map<string, string>();
      for (const ref of idleRecord.subagents ?? []) {
        subagentNameToRecordId.set(ref.name, ref.acpxRecordId);
      }

      const getOrOpenChildWriter = async (
        childAcpxRecordId: string,
      ): Promise<SessionEventWriter | undefined> => {
        if (subagentWriters.has(childAcpxRecordId)) {return subagentWriters.get(childAcpxRecordId);}
        try {
          const childRecord = await resolveSessionRecord(childAcpxRecordId);
          const writer = await SessionEventWriter.open(childRecord);
          subagentWriters.set(childAcpxRecordId, writer);
          return writer;
        } catch {
          return undefined;
        }
      };

      const flushIdlePending = async () => {
        if (pendingIdle.length > 0) {
          const batch = pendingIdle.splice(0);
          await idleWriter.appendMessages(batch, { checkpoint: false }).catch(() => {});
        }
        for (const [childId, pending] of pendingSubagent) {
          if (pending.length === 0) {continue;}
          const batch = pending.splice(0);
          const writer = subagentWriters.get(childId);
          if (writer) {await writer.appendMessages(batch, { checkpoint: false }).catch(() => {});}
        }
      };

      const flushTimer = setInterval(() => {
        if (active) {
          void flushIdlePending().catch(() => {});
        }
      }, 500);

      // Lazily resolve agentName → childAcpxRecordId, refreshing from disk if not found.
      // Handles the race where child records are written after drain starts.
      const resolveChildRecordId = async (agentName: string): Promise<string | undefined> => {
        const cached = subagentNameToRecordId.get(agentName);
        if (cached) {return cached;}
        try {
          const refreshed = await resolveSessionRecord(options.sessionId);
          for (const ref of refreshed.subagents ?? []) {
            subagentNameToRecordId.set(ref.name, ref.acpxRecordId);
          }
        } catch {
          // best effort
        }
        return subagentNameToRecordId.get(agentName);
      };

      sharedClient.setEventHandlers({
        onAcpMessage: (_dir, message) => {
          if (!active) {return;}
          pendingIdle.push(message);

          // Route to subagent child stream when subagentId is present
          const msg = message as Record<string, unknown>;
          if (msg.method === "session/update") {
            const params = msg.params as Record<string, unknown> | undefined;
            const notifMeta = params?._meta as Record<string, unknown> | undefined;
            const claudeCode = notifMeta?.claudeCode as Record<string, unknown> | undefined;
            const subagentId = claudeCode?.subagentId;
            if (typeof subagentId === "string") {
              const agentName = subagentId.split("@")[0];
              void (async () => {
                const childAcpxRecordId = await resolveChildRecordId(agentName);
                if (!childAcpxRecordId || !active) {return;}
                if (!pendingSubagent.has(childAcpxRecordId)) {
                  pendingSubagent.set(childAcpxRecordId, []);
                  void getOrOpenChildWriter(childAcpxRecordId).catch(() => {});
                }
                pendingSubagent.get(childAcpxRecordId)!.push(message);
              })();
            }
          }
        },
      });

      return {
        stop: async () => {
          if (!active) {
            return;
          }
          active = false;
          clearInterval(flushTimer);
          sharedClient.clearEventHandlers();
          await flushIdlePending();
          await idleWriter.close({ checkpoint: true }).catch(() => {});
          for (const writer of subagentWriters.values()) {
            await writer.close({ checkpoint: true }).catch(() => {});
          }
        },
      };
    };
    idleDrain = await startIdleStreamDrain();

    let isFirstTask = true;
    while (true) {
      const pollTimeoutMs = isFirstTask ? initialTaskPollTimeoutMs : taskPollTimeoutMs;
      const task = await owner.nextTask(pollTimeoutMs);
      if (!task) {
        break;
      }
      isFirstTask = false;

      // Stop idle drain before the prompt registers its own handlers
      await idleDrain.stop();

      midTurnCaptureActive = true;
      try {
        await runPromptTurn(async () => {
          try {
            await runQueuedTask(options.sessionId, task, runTaskOptions);
          } finally {
            checkpointPerfMetricsCapture();
          }
        });
      } finally {
        midTurnCaptureActive = false;
        activeMidTurnHandler = undefined;
        // Any buffered tasks that were never injected (e.g. handler never
        // became active) go back to the normal queue.
        for (const leftover of midTurnBuffer.splice(0)) {
          owner.requeue(leftover);
        }
        // Restart idle drain to capture teammate activity until next prompt
        idleDrain = await startIdleStreamDrain();
      }
    }

    await idleDrain.stop();
    owner.clearMidTurnHandler();
  } finally {
    await idleDrain?.stop().catch(() => {});
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    turnController.beginClosing();
    if (owner) {
      await owner.close();
    }
    await sharedClient.close().catch(() => {
      // best effort while queue owner is shutting down
    });
    try {
      const record = await resolveSessionRecord(options.sessionId);
      applyLifecycleSnapshotToRecord(record, sharedClient.getAgentLifecycleSnapshot());
      await writeSessionRecord(record);
    } catch {
      // best effort — session may already be cleaned up
    }
    await releaseQueueOwnerLease(lease);

    if (options.verbose) {
      process.stderr.write(`[acpx] queue owner stopped for session ${options.sessionId}\n`);
    }
  }
}

export async function sendSession(options: SessionSendOptions): Promise<SessionSendOutcome> {
  const waitForCompletion = options.waitForCompletion !== false;

  const queuedToOwner = await submitToRunningOwner(options, waitForCompletion);
  if (queuedToOwner) {
    return queuedToOwner;
  }

  spawnQueueOwnerProcess(queueOwnerRuntimeOptionsFromSend(options));

  for (let attempt = 0; attempt < QUEUE_OWNER_STARTUP_MAX_ATTEMPTS; attempt += 1) {
    const queued = await submitToRunningOwner(options, waitForCompletion);
    if (queued) {
      return queued;
    }
    await waitMs(QUEUE_CONNECT_RETRY_MS);
  }

  throw new Error(`Session queue owner failed to start for session ${options.sessionId}`);
}

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
      await writeSessionRecord(record);
    }
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
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
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
    // If /proc is unavailable, fall back to PID liveness checks only.
    return true;
  }
}

export async function closeSession(sessionId: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(sessionId);
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
  await writeSessionRecord(record);

  return record;
}

export {
  DEFAULT_HISTORY_LIMIT,
  findGitRepositoryRoot,
  findSession,
  findSessionByDirectoryWalk,
  isProcessAlive,
  listSessions,
  listSessionsForAgent,
};
