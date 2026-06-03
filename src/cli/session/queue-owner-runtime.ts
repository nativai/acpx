import { AcpClient } from "../../acp/client.js";
import { formatErrorMessage } from "../../acp/error-normalization.js";
import { supportsMidTurnPromptInjection } from "../../acp/mid-turn-injection-support.js";
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
  type QueueTask,
  SessionQueueOwner,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
  trySubmitToRunningOwner,
  type QueueOwnerLease,
  waitMs,
} from "../queue/ipc.js";
import { refreshQueueOwnerLease } from "../queue/lease-store.js";
import { QueueOwnerTurnController } from "../queue/owner-turn-controller.js";
import { resolveAndEnsureAgentFolder } from "./agent-folder.js";
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
    ttlMs: options.keepWarmTtlMs,
  });
}

function createQueueOwnerSharedClient(
  options: QueueOwnerRuntimeOptions,
  sessionRecord: Awaited<ReturnType<typeof resolveSessionRecord>>,
): AcpClient {
  return new AcpClient({
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
    sessionContext: {
      acpxRecordId: sessionRecord.acpxRecordId,
      parentSessionId: sessionRecord.parentSessionId ?? null,
      taskFolder: sessionRecord.metadata?.task_folder ?? null,
      agentFolder: resolveAndEnsureAgentFolder(sessionRecord),
      subscriptionId: sessionRecord.acpx?.session_options?.subscription ?? null,
    },
    sessionOptions: mergeSessionOptions(
      options.sessionOptions,
      sessionOptionsFromRecord(sessionRecord),
    ),
  });
}

function createQueueOwnerTurnController(
  options: QueueOwnerRuntimeOptions,
): QueueOwnerTurnController {
  return new QueueOwnerTurnController({
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
}

function logDeferredCancelFailure(error: unknown, verbose?: boolean): void {
  if (!verbose) {
    return;
  }
  process.stderr.write(`[acpx] failed to apply deferred cancel: ${formatErrorMessage(error)}\n`);
}

function logQueueOwnerReady(params: {
  sessionId: string;
  ttlMs: number;
  maxQueueDepth: number;
  verbose?: boolean;
}): void {
  if (!params.verbose) {
    return;
  }
  process.stderr.write(
    `[acpx] queue owner ready for session ${params.sessionId} (ttlMs=${params.ttlMs}, maxQueueDepth=${params.maxQueueDepth})\n`,
  );
}

async function closeQueueOwnerRuntime(params: {
  lease: QueueOwnerLease;
  owner: SessionQueueOwner | undefined;
  heartbeatTimer: NodeJS.Timeout | undefined;
  turnController: QueueOwnerTurnController;
  sharedClient: AcpClient;
  sessionId: string;
  verbose?: boolean;
}): Promise<void> {
  if (params.heartbeatTimer) {
    clearInterval(params.heartbeatTimer);
  }
  params.turnController.beginClosing();
  await params.owner?.close();
  await params.sharedClient.close().catch(() => {
    // best effort while queue owner is shutting down
  });
  await writeQueueOwnerLifecycleSnapshot(params.sessionId, params.sharedClient);
  await releaseQueueOwnerLease(params.lease);
  if (params.verbose) {
    process.stderr.write(`[acpx] queue owner stopped for session ${params.sessionId}\n`);
  }
}

async function writeQueueOwnerLifecycleSnapshot(
  sessionId: string,
  sharedClient: AcpClient,
): Promise<void> {
  try {
    const record = await resolveSessionRecord(sessionId);
    applyLifecycleSnapshotToRecord(record, sharedClient.getAgentLifecycleSnapshot());
    await writeSessionRecord(record);
  } catch {
    // best effort - session may already be cleaned up
  }
}

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
export async function runSessionQueueOwner(options: QueueOwnerRuntimeOptions): Promise<void> {
  const lease = await tryAcquireQueueOwnerLease(options.sessionId);
  if (!lease) {
    return;
  }

  const sessionRecord = await resolveSessionRecord(options.sessionId);
  // Mid-turn prompt injection (concurrent client.prompt() into an in-flight
  // turn) relies on adapter-specific support for accepting a new prompt while
  // another turn is active. Claude ACP and Codex ACP support that contract;
  // adapters without known support keep the owner's mid-turn handler unset so
  // new prompts land in the normal pending queue.
  const midTurnInjectionSupported = supportsMidTurnPromptInjection(sessionRecord.agentCommand);
  let owner: SessionQueueOwner | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let idleDrain: { stop: () => Promise<void> } | undefined;
  const sharedClient = createQueueOwnerSharedClient(options, sessionRecord);
  const ttlMs = normalizeQueueOwnerTtlMs(options.ttlMs);
  const maxQueueDepth = Math.max(1, Math.round(options.maxQueueDepth ?? 16));
  // Mutable: a keep-warm prompt (task.ttlMs) can extend/disable the idle TTL of
  // this already-running owner (see the per-turn apply below).
  let defaultTaskPollTimeoutMs: number | undefined = ttlMs === 0 ? undefined : ttlMs;
  let taskPollTimeoutMs: number | undefined = defaultTaskPollTimeoutMs;
  const initialTaskPollTimeoutMs =
    taskPollTimeoutMs == null ? undefined : Math.max(taskPollTimeoutMs, 1_000);
  const turnController = createQueueOwnerTurnController(options);

  const applyPendingCancel = async (): Promise<boolean> => {
    return await turnController.applyPendingCancel();
  };

  const scheduleApplyPendingCancel = (): void => {
    void applyPendingCancel().catch((error) => {
      logDeferredCancelFailure(error, options.verbose);
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

    logQueueOwnerReady({
      sessionId: options.sessionId,
      ttlMs,
      maxQueueDepth,
      verbose: options.verbose,
    });
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
        // eslint-disable-next-line complexity -- fork integration handler; intentionally over budget, refactor would risk verified merge semantics
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

    // Mid-turn injection: tasks that arrive while a prompt turn is active
    // bypass the normal pending queue and are injected concurrently via
    // client.prompt() so the agent sees the new message through its
    // Pushable input mid-turn.
    //
    // Two-phase design:
    //   1. "Capture" — from when the queue-owner pulls a task until the
    //      runtime's mid-turn handler is registered (client.prompt() is
    //      in-flight), incoming tasks land in midTurnBuffer.
    //   2. "Active" — once activeMidTurnHandler is set, the buffer is
    //      drained into it immediately and subsequent tasks are routed
    //      straight in.
    let activeMidTurnHandler: ((injectedTask: QueueTask) => void) | undefined;
    const midTurnBuffer: QueueTask[] = [];
    let midTurnCaptureActive = false;

    if (midTurnInjectionSupported) {
      owner.setMidTurnHandler((task: QueueTask): boolean => {
        if (activeMidTurnHandler) {
          activeMidTurnHandler(task);
          return true;
        }
        if (midTurnCaptureActive) {
          midTurnBuffer.push(task);
          return true;
        }
        // Not in a turn — let the task land in the normal pending queue.
        return false;
      });
    }

    let isFirstTask = true;
    while (true) {
      const pollTimeoutMs = isFirstTask ? initialTaskPollTimeoutMs : taskPollTimeoutMs;
      const task = await owner.nextTask(pollTimeoutMs);
      if (!task) {
        break;
      }
      isFirstTask = false;

      // Keep-warm-while-engaged: a prompt may carry an idle-TTL override (e.g.
      // acpx-ui passing --keep-warm / --ttl for a session engaged from the UI).
      // Adopt it as this owner's new idle TTL so the session you're actively
      // using doesn't idle-die into a catastrophic cold resume. Reuses the same
      // dynamic-TTL lever as the scheduled-wakeup hook below. Persisting it into
      // defaultTaskPollTimeoutMs makes it stick across subsequent idle waits.
      if (task.ttlMs != null) {
        defaultTaskPollTimeoutMs = task.ttlMs === 0 ? undefined : task.ttlMs;
        if (options.verbose) {
          process.stderr.write(
            `[acpx] keep-warm: idle TTL set to ${
              defaultTaskPollTimeoutMs ?? "disabled"
            } for session ${options.sessionId}\n`,
          );
        }
      }

      // Reset the idle poll timeout each turn. A previous turn's scheduling
      // tool may have set taskPollTimeoutMs to undefined via the
      // hasScheduledWakeup signal; the adapter never sends a corresponding
      // "wakeup fired" notification, so without this reset the idle TTL stays
      // disabled forever (immortal queue-owner). If this turn schedules
      // another wakeup, the onAcpMessage handler below will set it back to
      // undefined for the duration of that wakeup window.
      taskPollTimeoutMs = defaultTaskPollTimeoutMs;

      // Stop idle drain before the prompt registers its own handlers
      await idleDrain.stop();

      midTurnCaptureActive = midTurnInjectionSupported;
      try {
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
              setMidTurnHandler: midTurnInjectionSupported
                ? (handler) => {
                    activeMidTurnHandler = handler;
                    if (handler) {
                      // Drain anything that arrived during the capture phase.
                      for (const buffered of midTurnBuffer.splice(0)) {
                        handler(buffered);
                      }
                    }
                  }
                : undefined,
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
      } finally {
        midTurnCaptureActive = false;
        activeMidTurnHandler = undefined;
        // Any buffered tasks that were never injected (e.g. the handler was
        // never registered because the turn failed before client.prompt())
        // go back to the normal pending queue.
        for (const leftover of midTurnBuffer.splice(0)) {
          owner.requeue(leftover);
        }
      }
      // Restart idle drain to capture teammate activity until next prompt
      idleDrain = await startIdleStreamDrain();
    }

    await idleDrain.stop();
    if (midTurnInjectionSupported) {
      owner.clearMidTurnHandler();
    }
  } finally {
    await idleDrain?.stop().catch(() => {});
    await closeQueueOwnerRuntime({
      lease,
      owner,
      heartbeatTimer,
      turnController,
      sharedClient,
      sessionId: options.sessionId,
      verbose: options.verbose,
    });
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
