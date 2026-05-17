import { AcpClient } from "../../acp/client.js";
import { formatErrorMessage } from "../../acp/error-normalization.js";
import { withTimeout } from "../../async-control.js";
import { checkpointPerfMetricsCapture } from "../../perf-metrics-capture.js";
import { setPerfGauge } from "../../perf-metrics.js";
import { promptToDisplayText } from "../../prompt-content.js";
import { applyLifecycleSnapshotToRecord } from "../../runtime/engine/lifecycle.js";
import {
  mergeSessionOptions,
  sessionOptionsFromRecord,
} from "../../runtime/engine/session-options.js";
import { SessionEventWriter } from "../../session/events.js";
import {
  absolutePath,
  resolveSessionRecord,
  writeSessionRecord,
} from "../../session/persistence.js";
import type { AcpJsonRpcMessage, SessionSendOutcome } from "../../types.js";
import {
  QUEUE_CONNECT_RETRY_MS,
  SessionQueueOwner,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
  trySubmitToRunningOwner,
  waitMs,
} from "../queue/ipc.js";
import { refreshQueueOwnerLease } from "../queue/lease-store.js";
import { QueueOwnerTurnController } from "../queue/owner-turn-controller.js";
import {
  DEFAULT_QUEUE_OWNER_TTL_MS,
  normalizeQueueOwnerTtlMs,
  type SessionSendOptions,
} from "./contracts.js";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetModelDirect,
  runSessionSetModeDirect,
  type ActiveSessionController,
} from "./prompt-runner.js";
import type { QueueOwnerRuntimeOptions } from "./queue-owner-process.js";
import { queueOwnerRuntimeOptionsFromSend, spawnQueueOwnerProcess } from "./queue-owner-process.js";
import { runQueuedTask } from "./runtime.js";

const QUEUE_OWNER_STARTUP_MAX_ATTEMPTS = 120;
const QUEUE_OWNER_HEARTBEAT_INTERVAL_MS = 5_000;

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
    permissionPolicy: options.permissionPolicy,
    outputFormatter: options.outputFormatter,
    errorEmissionPolicy: options.errorEmissionPolicy,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    promptRetries: options.promptRetries,
    waitForCompletion,
    verbose: options.verbose,
    sessionOptions: options.sessionOptions,
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
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    sessionOptions: mergeSessionOptions(
      options.sessionOptions,
      sessionOptionsFromRecord(sessionRecord),
    ),
  });
  const ttlMs = normalizeQueueOwnerTtlMs(options.ttlMs);
  const maxQueueDepth = Math.max(1, Math.round(options.maxQueueDepth ?? 16));
  let taskPollTimeoutMs: number | undefined = ttlMs === 0 ? undefined : ttlMs;
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
        terminal: options.terminal,
        timeoutMs,
        verbose: options.verbose,
      });
    },
    setSessionModelFallback: async (modelId: string, timeoutMs?: number) => {
      await runSessionSetModelDirect({
        sessionRecordId: options.sessionId,
        modelId,
        mcpServers: options.mcpServers,
        nonInteractivePermissions: options.nonInteractivePermissions,
        authCredentials: options.authCredentials,
        authPolicy: options.authPolicy,
        terminal: options.terminal,
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
        terminal: options.terminal,
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

  const closeActiveBackendSession = async (timeoutMs?: number): Promise<boolean> => {
    const latestRecord = await resolveSessionRecord(options.sessionId);
    if (!sharedClient.supportsCloseSession()) {
      return false;
    }
    await withTimeout(sharedClient.closeSession(latestRecord.acpSessionId), timeoutMs);
    return true;
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
        closeSession: async (timeoutMs?: number) => await closeActiveBackendSession(timeoutMs),
        setSessionMode: async (modeId: string, timeoutMs?: number) => {
          await turnController.setSessionMode(modeId, timeoutMs);
        },
        setSessionModel: async (modelId: string, timeoutMs?: number) => {
          await turnController.setSessionModel(modelId, timeoutMs);
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

    // Idle stream drain: captures inter-turn teammate activity (session/update
    // notifications sent by the adapter background reader between prompts).
    const startIdleStreamDrain = async (): Promise<{ stop: () => Promise<void> }> => {
      let active = true;
      const pendingIdle: AcpJsonRpcMessage[] = [];
      const pendingSubagent = new Map<string, AcpJsonRpcMessage[]>();
      const subagentWriters = new Map<string, SessionEventWriter>();

      const idleRecord = await resolveSessionRecord(options.sessionId);
      const idleWriter = await SessionEventWriter.open(idleRecord);

      const subagentNameToRecordId = new Map<string, string>();
      for (const ref of idleRecord.subagents ?? []) {
        subagentNameToRecordId.set(ref.name, ref.acpxRecordId);
      }

      const getOrOpenChildWriter = async (
        childAcpxRecordId: string,
      ): Promise<SessionEventWriter | undefined> => {
        if (subagentWriters.has(childAcpxRecordId)) {
          return subagentWriters.get(childAcpxRecordId);
        }
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
          if (pending.length === 0) {
            continue;
          }
          const batch = pending.splice(0);
          const writer = subagentWriters.get(childId);
          if (writer) {
            await writer.appendMessages(batch, { checkpoint: false }).catch(() => {});
          }
        }
      };

      const flushTimer = setInterval(() => {
        if (active) {
          void flushIdlePending().catch(() => {});
        }
      }, 500);

      const resolveChildRecordId = async (agentName: string): Promise<string | undefined> => {
        const cached = subagentNameToRecordId.get(agentName);
        if (cached) {
          return cached;
        }
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
          if (!active) {
            return;
          }
          pendingIdle.push(message);

          const msg = message as Record<string, unknown>;
          if (msg.method === "session/update") {
            const params = msg.params as Record<string, unknown> | undefined;
            const notifMeta = params?._meta as Record<string, unknown> | undefined;
            const notifClaudeCode = notifMeta?.claudeCode as Record<string, unknown> | undefined;
            const update = params?.update as Record<string, unknown> | undefined;
            const updateMeta = update?._meta as Record<string, unknown> | undefined;
            const updateClaudeCode = updateMeta?.claudeCode as Record<string, unknown> | undefined;

            // Disable idle TTL when the adapter signals a scheduled wakeup was
            // created — keeps the process tree alive until the cron fires.
            if (updateClaudeCode?.hasScheduledWakeup === true) {
              taskPollTimeoutMs = undefined;
              if (options.verbose) {
                process.stderr.write(
                  `[acpx] scheduled wakeup detected — disabling idle TTL for session ${options.sessionId}\n`,
                );
              }
            }

            const subagentId = notifClaudeCode?.subagentId ?? updateClaudeCode?.subagentId;
            const subagentName = notifClaudeCode?.subagentName ?? updateClaudeCode?.subagentName;
            if (typeof subagentId === "string" || typeof subagentName === "string") {
              const agentName =
                typeof subagentName === "string"
                  ? subagentName.split("@")[0]
                  : (subagentId as string).split("@")[0];
              void (async () => {
                const childAcpxRecordId = await resolveChildRecordId(agentName);
                if (!childAcpxRecordId || !active) {
                  return;
                }
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

      await runPromptTurn(async () => {
        try {
          await runQueuedTask(options.sessionId, task, {
            sharedClient,
            verbose: options.verbose,
            mcpServers: options.mcpServers,
            nonInteractivePermissions: options.nonInteractivePermissions,
            authCredentials: options.authCredentials,
            authPolicy: options.authPolicy,
            suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
            promptRetries: task.promptRetries ?? 0,
            sessionOptions: options.sessionOptions,
            onClientAvailable: setActiveController,
            onClientClosed: clearActiveController,
            onPromptActive: async () => {
              turnController.markPromptActive();
              await applyPendingCancel();
            },
            onAcpMessage: (_dir, message) => {
              // Detect hasScheduledWakeup during a prompt turn (same logic as
              // the idle drain handler) to disable TTL even if the scheduling
              // tool fires mid-turn.
              const msg = message as Record<string, unknown>;
              if (msg.method === "session/update") {
                const params = msg.params as Record<string, unknown> | undefined;
                const update = params?.update as Record<string, unknown> | undefined;
                const updateMeta = update?._meta as Record<string, unknown> | undefined;
                const updateClaudeCode = updateMeta?.claudeCode as
                  | Record<string, unknown>
                  | undefined;
                if (updateClaudeCode?.hasScheduledWakeup === true) {
                  taskPollTimeoutMs = undefined;
                  if (options.verbose) {
                    process.stderr.write(
                      `[acpx] scheduled wakeup detected — disabling idle TTL for session ${options.sessionId}\n`,
                    );
                  }
                }
              }
            },
          });
        } finally {
          checkpointPerfMetricsCapture();
        }
      });
      // Restart idle drain to capture teammate activity until next prompt
      idleDrain = await startIdleStreamDrain();
    }

    await idleDrain.stop();
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

export type { QueueOwnerRuntimeOptions };
export { DEFAULT_QUEUE_OWNER_TTL_MS };
