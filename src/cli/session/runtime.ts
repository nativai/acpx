import os from "node:os";
import path from "node:path";
import { AcpClient } from "../../acp/client.js";
import {
  formatErrorMessage,
  isRetryablePromptError,
  normalizeOutputError,
} from "../../acp/error-normalization.js";
import { InterruptedError, withInterrupt, withTimeout } from "../../async-control.js";
import { tailClaudeSubagentJsonl } from "../../claude-jsonl.js";
import { SessionClosedError } from "../../errors.js";
export { InterruptedError, TimeoutError } from "../../async-control.js";
import { formatPerfMetric, measurePerf, startPerfTimer } from "../../perf-metrics.js";
import { textPrompt } from "../../prompt-content.js";
import {
  applyConversation,
  applyLifecycleSnapshotToRecord,
} from "../../runtime/engine/lifecycle.js";
import { runPromptTurn } from "../../runtime/engine/prompt-turn.js";
import { connectAndLoadSession } from "../../runtime/engine/reconnect.js";
import { sessionOptionsFromRecord } from "../../runtime/engine/session-options.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
  trimConversationForRuntime,
} from "../../session/conversation-model.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import { SessionEventWriter } from "../../session/events.js";
import {
  absolutePath,
  isoNow,
  resolveSessionRecord,
  writeSessionRecord,
} from "../../session/persistence.js";
import {
  SESSION_RECORD_SCHEMA,
  type AcpJsonRpcMessage,
  type AcpMessageDirection,
  type AuthPolicy,
  type ClientOperation,
  type McpServer,
  type NonInteractivePermissionPolicy,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
  type OutputFormatter,
  type PermissionMode,
  type PromptInput,
  type RunPromptResult,
  type SessionNotification,
  SessionRecord,
  SessionResumePolicy,
  SessionSendResult,
  SubagentRef,
} from "../../types.js";
import { type QueueOwnerMessage, type QueueTask, waitMs } from "../queue/ipc.js";
import { type QueueOwnerActiveSessionController } from "../queue/owner-turn-controller.js";
import type { RunOnceOptions, SessionSendOptions } from "./contracts.js";

function claudeSubagentDir(cwd: string, acpSessionId: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const cwdHash = cwd.replace(/\//g, "-");
  return path.join(configDir, "projects", cwdHash, acpSessionId, "subagents");
}

const INTERRUPT_CANCEL_WAIT_MS = 2_500;

type RunSessionPromptOptions = {
  sessionRecordId: string;
  prompt: PromptInput;
  resumePolicy?: SessionResumePolicy;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  outputFormatter: OutputFormatter;
  onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  promptRetries?: number;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  onPromptActive?: () => Promise<void> | void;
  client?: AcpClient;
};

type ActiveSessionController = QueueOwnerActiveSessionController;

class QueueTaskOutputFormatter implements OutputFormatter {
  private readonly requestId: string;
  private readonly send: (message: QueueOwnerMessage) => void;

  constructor(task: QueueTask) {
    this.requestId = task.requestId;
    this.send = task.send;
  }

  setContext(_context: { sessionId: string }): void {}

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

  flush(): void {}
}

const DISCARD_OUTPUT_FORMATTER: OutputFormatter = {
  setContext() {},
  onAcpMessage() {},
  onError() {},
  flush() {},
};

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

async function applyRequestedModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  models: import("../../acp/client.js").SessionCreateResult["models"];
  timeoutMs?: number;
}): Promise<boolean> {
  const requestedModel =
    typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
  if (!requestedModel || !params.models) {
    return false;
  }
  if (params.models.currentModelId === requestedModel) {
    return true;
  }

  await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel),
    params.timeoutMs,
  );
  return true;
}

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

function emitPromptRetryNotice(params: {
  error: unknown;
  delayMs: number;
  attempt: number;
  maxRetries: number;
  suppressSdkConsoleErrors?: boolean;
}): void {
  if (params.suppressSdkConsoleErrors) {
    return;
  }

  process.stderr.write(
    `[acpx] prompt failed (${formatErrorMessage(params.error)}), retrying in ${params.delayMs}ms ` +
      `(attempt ${params.attempt}/${params.maxRetries})\n`,
  );
}

export async function runQueuedTask(
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
    promptRetries?: number;
    onClientAvailable?: (controller: ActiveSessionController) => void;
    onClientClosed?: () => void;
    onPromptActive?: () => Promise<void> | void;
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
      resumePolicy: task.resumePolicy,
      nonInteractivePermissions:
        task.nonInteractivePermissions ?? options.nonInteractivePermissions,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      outputFormatter,
      timeoutMs: task.timeoutMs,
      suppressSdkConsoleErrors: task.suppressSdkConsoleErrors ?? options.suppressSdkConsoleErrors,
      verbose: options.verbose,
      promptRetries: options.promptRetries,
      onClientAvailable: options.onClientAvailable,
      onClientClosed: options.onClientClosed,
      onPromptActive: options.onPromptActive,
      client: options.sharedClient,
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

  // Fail-loud on send-to-closed. `closed` is user intent (UI-authored); once
  // set, prompts are rejected until the user explicitly reopens the session
  // (via `PATCH /api/sessions/:id/closed {closed:false}` in the UI, or the
  // corresponding CLI surface). See DESIGN.md §4 "reopen question" for why
  // we don't auto-reopen on a successful turn.
  if (record.closed) {
    throw new SessionClosedError(record.acpxRecordId, record.name ?? undefined);
  }

  const conversation = cloneSessionConversation(record);
  let acpxState = cloneSessionAcpxState(record.acpx);
  const promptMessageId = recordPromptSubmission(conversation, options.prompt, isoNow());

  output.setContext({
    sessionId: record.acpxRecordId,
  });

  const eventWriter = await measurePerf("session.events.open", async () => {
    return await SessionEventWriter.open(record);
  });
  const pendingMessages: AcpJsonRpcMessage[] = [];
  const pendingConnectOutputMessages: AcpJsonRpcMessage[] = [];
  let bufferingConnectOutput = true;
  let promptTurnActive = false;
  let promptTurnHadSideEffects = false;
  let sawAcpMessage = false;
  let eventWriterClosed = false;

  // Subagent tracking: map from agent_id (e.g. "poet-a@haiku-demo") to ACPX record id
  const subagentIdToAcpxRecordId = new Map<string, string>();
  // Subagent in-memory records: populated immediately on teammate_spawned, before disk write completes
  const subagentRecordsById = new Map<string, SessionRecord>();
  // Subagent event writers: map from ACPX record id to event writer
  const subagentEventWriters = new Map<string, SessionEventWriter>();
  // Subagent JSONL tailers: map from ACPX record id to stop function
  const subagentTailers = new Map<string, { stop: () => Promise<void> }>();

  const getOrOpenSubagentEventWriter = async (
    childAcpxRecordId: string,
  ): Promise<SessionEventWriter | undefined> => {
    const existing = subagentEventWriters.get(childAcpxRecordId);
    if (existing) {
      return existing;
    }
    try {
      // Prefer in-memory record to avoid race condition where disk write has not completed yet
      const childRecord =
        subagentRecordsById.get(childAcpxRecordId) ??
        (await resolveSessionRecord(childAcpxRecordId));
      const writer = await SessionEventWriter.open(childRecord);
      subagentEventWriters.set(childAcpxRecordId, writer);
      return writer;
    } catch {
      return undefined;
    }
  };

  const stopAllSubagentTailers = async (): Promise<void> => {
    const stops = [...subagentTailers.values()].map((t) => t.stop().catch(() => {}));
    await Promise.all(stops);
    subagentTailers.clear();
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
  // We also checkpoint the session record to disk periodically — syncing the
  // in-memory conversation onto the record — so that if the daemon is killed
  // mid-turn, the reconciled `messages` array on disk is at most ~500ms stale
  // rather than lost entirely (see fix-reconciliation-messages).
  const periodicCheckpoint = async (): Promise<void> => {
    try {
      await flushPendingMessages(false);
    } catch {
      // best effort
    }
    try {
      applyConversation(record, conversation);
      record.acpx = acpxState;
      await eventWriter.checkpoint();
    } catch {
      // best effort
    }
  };
  const streamFlushInterval = setInterval(() => {
    void periodicCheckpoint();
  }, 500);

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

  const closeEventWriter = async (checkpoint: boolean): Promise<void> => {
    if (eventWriterClosed) {
      return;
    }
    eventWriterClosed = true;
    await stopAllSubagentTailers();
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
      sessionOptions: sessionOptionsFromRecord(record),
    });
  client.updateRuntimeOptions({
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
  });
  client.setEventHandlers({
    onAcpMessage: (direction, message) => {
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
            // On task completion/failure/stop: drain the tailer and persist final messages
            const status = claudeCodeMeta.status;
            if (
              status === "task_completed" ||
              status === "task_failed" ||
              status === "task_stopped"
            ) {
              const tailer = subagentTailers.get(childAcpxRecordId);
              if (tailer) {
                subagentTailers.delete(childAcpxRecordId);
                void tailer.stop().then(() => {
                  const childRecord = subagentRecordsById.get(childAcpxRecordId);
                  if (childRecord) {
                    childRecord.lastUsedAt = isoNow();
                    void writeSessionRecord(childRecord).catch(() => {});
                  }
                });
              }
            }
          }
        }
      }
      options.onAcpMessage?.(direction, message);
    },
    onAcpOutputMessage: (_direction, message) => {
      if (bufferingConnectOutput) {
        pendingConnectOutputMessages.push(message);
        return;
      }
      output.onAcpMessage(message);
    },
    onSessionUpdate: (notification) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
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
            subagentRecordsById.set(childAcpxRecordId, childRecord);

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
                const parentRecord = eventWriter.getRecord();
                parentRecord.subagents = [...(parentRecord.subagents ?? []), subagentRef];
                // Sync the in-memory conversation onto the parent record before
                // persisting. Without this the subagent-spawn checkpoint writes
                // the record with stale/empty `messages`, which — if the daemon
                // later dies before the end-of-turn flush — leaves the session
                // JSON with subagent refs, last_seq set, but messages=[].
                applyConversation(parentRecord, conversation);
                parentRecord.acpx = acpxState;
                await writeSessionRecord(parentRecord);
              } catch {
                // best effort
              }
            })();

            // Start tailing the subagent JSONL file in real-time
            const rawAgentId = agentId.split("@")[0];
            const jsonlDir = claudeSubagentDir(record.cwd, record.acpSessionId);
            const tailer = tailClaudeSubagentJsonl(jsonlDir, rawAgentId, (newMessages) => {
              childRecord.messages.push(...newMessages);
              childRecord.lastUsedAt = isoNow();
              void getOrOpenSubagentEventWriter(childAcpxRecordId).then((writer) => {
                if (!writer) {
                  return;
                }
                for (const msg of newMessages) {
                  void writer
                    .appendMessage({
                      jsonrpc: "2.0",
                      method: "session/update",
                      params: {
                        sessionId: record.acpSessionId,
                        update: {
                          _meta: {
                            claudeCode: {
                              toolName: "Agent",
                              status: "subagent_message",
                              subagentId: agentId,
                              subagentName: childName ?? agentId,
                            },
                          },
                          sessionUpdate: "tool_call_update",
                          toolCallId: childAcpxRecordId,
                          message: msg,
                        },
                      },
                    })
                    .catch(() => {});
                }
              });
              void writeSessionRecord(childRecord).catch(() => {});
            });
            subagentTailers.set(childAcpxRecordId, tailer);
          }
        }
      }

      options.onSessionUpdate?.(notification);
    },
    onClientOperation: (operation) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      acpxState = recordConversationClientOperation(conversation, acpxState, operation);
      trimConversationForRuntime(conversation);
      options.onClientOperation?.(operation);
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
    setSessionModel: async (modelId: string) => {
      await client.setSessionModel(activeSessionIdForControl, modelId);
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
              resumePolicy: options.resumePolicy,
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

        const maxRetries = options.promptRetries ?? 0;
        let response;
        promptTurnActive = true;
        for (let attempt = 0; ; attempt++) {
          try {
            const promptStartedAt = Date.now();
            response = await measurePerf("runtime.prompt.agent_turn", async () => {
              return await runPromptTurn({
                client,
                sessionId: activeSessionId,
                prompt: options.prompt,
                timeoutMs: options.timeoutMs,
                conversation,
                promptMessageId,
                onPromptStarted:
                  attempt === 0 && options.onPromptActive
                    ? async () => {
                        try {
                          await options.onPromptActive?.();
                        } catch (error) {
                          if (options.verbose) {
                            process.stderr.write(
                              "[acpx] onPromptActive hook failed: " +
                                formatErrorMessage(error) +
                                "\n",
                            );
                          }
                        }
                      }
                    : undefined,
              });
            });
            if (options.verbose) {
              process.stderr.write(
                `[acpx] ${formatPerfMetric("prompt.agent_turn", Date.now() - promptStartedAt)}\n`,
              );
            }
            break;
          } catch (error) {
            const snapshot = client.getAgentLifecycleSnapshot();
            const agentCrashed = snapshot.lastExit?.unexpectedDuringPrompt === true;

            if (
              attempt < maxRetries &&
              !agentCrashed &&
              !promptTurnHadSideEffects &&
              isRetryablePromptError(error)
            ) {
              const delayMs = Math.min(1_000 * 2 ** attempt, 10_000);
              emitPromptRetryNotice({
                error,
                delayMs,
                attempt: attempt + 1,
                maxRetries,
                suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
              });
              await waitMs(delayMs);
              if (!promptTurnHadSideEffects) {
                continue;
              }
            }

            promptTurnActive = false;
            applyLifecycleSnapshotToRecord(record, snapshot);
            const lastExit = snapshot.lastExit;
            if (lastExit?.unexpectedDuringPrompt && options.verbose) {
              process.stderr.write(
                "[acpx] agent disconnected during prompt (" +
                  lastExit.reason +
                  ", exit=" +
                  lastExit.exitCode +
                  ", signal=" +
                  (lastExit.signal ?? "none") +
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

            const propagated =
              error instanceof Error ? error : new Error(formatErrorMessage(error));
            (propagated as { outputAlreadyEmitted?: boolean }).outputAlreadyEmitted = sawAcpMessage;
            (propagated as { normalizedOutputError?: unknown }).normalizedOutputError =
              normalizedError;
            throw propagated;
          }
        }
        promptTurnActive = false;

        await flushPendingMessages(false);
        output.flush();

        const now = isoNow();
        record.lastUsedAt = now;
        // NOTE: We intentionally do NOT touch `record.closed` / `record.closedAt` here.
        // Under the session-lifecycle-state ownership model (see
        // src/session/persistence/repository.ts docs + DESIGN.md), `closed` is
        // UI-authored user intent. Silently re-opening a closed session on any
        // successful turn violates that intent. The `runSessionPrompt` entry
        // point already refuses to run against a closed record (throws
        // SessionClosedError), so reaching this point means the session was
        // open when the turn started and should remain open — which is the
        // default already on disk. If a future lifecycle change needs to be
        // written here, route it through writeSessionRecordWithLifecycle.
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
  let promptTurnActive = false;
  let promptTurnHadSideEffects = false;
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
    onAcpMessage: options.onAcpMessage,
    onAcpOutputMessage: (_direction, message) => output.onAcpMessage(message),
    onSessionUpdate: (notification) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      options.onSessionUpdate?.(notification);
    },
    onClientOperation: (operation) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      options.onClientOperation?.(operation);
    },
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
        await applyRequestedModelIfAdvertised({
          client,
          sessionId,
          requestedModel: options.sessionOptions?.model,
          models: createdSession.models,
          timeoutMs: options.timeoutMs,
        });

        output.setContext({
          sessionId,
        });

        const maxRetries = options.promptRetries ?? 0;
        let response;
        promptTurnActive = true;
        for (let attempt = 0; ; attempt++) {
          try {
            response = await measurePerf("runtime.exec.prompt", async () => {
              return await withTimeout(client.prompt(sessionId, options.prompt), options.timeoutMs);
            });
            break;
          } catch (error) {
            if (
              attempt < maxRetries &&
              !promptTurnHadSideEffects &&
              isRetryablePromptError(error)
            ) {
              const delayMs = Math.min(1_000 * 2 ** attempt, 10_000);
              emitPromptRetryNotice({
                error,
                delayMs,
                attempt: attempt + 1,
                maxRetries,
                suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
              });
              await waitMs(delayMs);
              if (!promptTurnHadSideEffects) {
                continue;
              }
            }
            promptTurnActive = false;
            throw error;
          }
        }
        promptTurnActive = false;
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

export async function sendSessionDirect(options: SessionSendOptions): Promise<SessionSendResult> {
  return await runSessionPrompt({
    sessionRecordId: options.sessionId,
    prompt: options.prompt,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    resumePolicy: options.resumePolicy,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    outputFormatter: options.outputFormatter,
    onAcpMessage: options.onAcpMessage,
    onSessionUpdate: options.onSessionUpdate,
    onClientOperation: options.onClientOperation,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    client: options.client,
  });
}
