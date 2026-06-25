import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
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
  ownerOptionsToInput,
  persistSessionOwnerOptions,
  resolveSessionOwnerOptions,
} from "../../session/owner-options.js";
import {
  absolutePath,
  flushPendingSessionIndexUpdates,
  resolveSessionRecord,
  writeSessionRecordAtBoundary,
} from "../../session/persistence.js";
import type { AcpJsonRpcMessage, SessionSendOutcome } from "../../types.js";
import {
  QUEUE_CONNECT_RETRY_MS,
  type QueueTask,
  SessionQueueOwner,
  releaseQueueOwnerLease,
  hasLiveProcessGroup,
  tryAcquireQueueOwnerLease,
  trySubmitToRunningOwner,
  type QueueOwnerLease,
  signalProcessGroup,
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

// Path-1 deploy-staleness signal (W13-24-10). The default deployed-SHA record on
// every dev-server; `refresh.sh` rewrites `.acpx.sha` here on every deploy.
const DEFAULT_DEPLOY_VERSION_FILE = "/workspace/.runtime/info.json";

// Primary signal: the dev-server deploy record's `.acpx.sha` (path from
// `ACPX_DEPLOY_VERSION_FILE`, else the default above). refresh.sh rewrites it.
function readDeployRecordSha(): string | undefined {
  const infoPath = process.env.ACPX_DEPLOY_VERSION_FILE || DEFAULT_DEPLOY_VERSION_FILE;
  try {
    const parsed = JSON.parse(fs.readFileSync(infoPath, "utf8")) as { acpx?: { sha?: unknown } };
    const sha = parsed?.acpx?.sha;
    return typeof sha === "string" && sha.length > 0 ? sha : undefined;
  } catch {
    // Absent / unparseable / no `.acpx.sha`.
    return undefined;
  }
}

// Fallback signal: a content hash of the acpx CLI entry point on disk
// ("has my own code-on-disk changed since I started?").
function readEntryPointHash(): string | undefined {
  const entryPoint = process.argv[1];
  if (typeof entryPoint !== "string" || entryPoint.length === 0) {
    return undefined;
  }
  try {
    return createHash("sha1").update(fs.readFileSync(entryPoint)).digest("hex");
  } catch {
    return undefined;
  }
}

// Resolve a build token identifying the code generation the owner is running.
// Used purely to detect a deploy-staleness recycle — NEVER a liveness signal.
// Safe default (North Star): if NEITHER signal resolves (e.g. acpx is not on a
// dev-server), return `undefined` so the owner never staleness-recycles and stays
// warm forever. Errs toward never tearing down a live owner.
function readDeployedBuildToken(): string | undefined {
  const sha = readDeployRecordSha();
  if (sha !== undefined) {
    return `info:${sha}`;
  }
  const hash = readEntryPointHash();
  return hash !== undefined ? `entry:${hash}` : undefined;
}

async function submitToRunningOwner(
  options: SessionSendOptions,
  waitForCompletion: boolean,
): Promise<SessionSendOutcome | undefined> {
  return await trySubmitToRunningOwner({
    sessionId: options.sessionId,
    messageId: options.messageId,
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

// eslint-disable-next-line complexity -- mirrors the sessionContext shape from runtime.ts / connected-session.ts; the ?. chains are load-bearing and cannot be simplified further without losing null safety
function sessionContextFromRecord(record: Awaited<ReturnType<typeof resolveSessionRecord>>) {
  return {
    acpxRecordId: record.acpxRecordId,
    sessionName: record.name ?? null,
    parentSessionId: record.parentSessionId ?? null,
    taskFolder: record.metadata?.task_folder ?? null,
    agentFolder: resolveAndEnsureAgentFolder(record),
    subscriptionId: record.acpx?.session_options?.subscription ?? null,
    profileId: record.acpx?.session_options?.profile ?? null,
  };
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
    sessionContext: sessionContextFromRecord(sessionRecord),
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

function readLinuxProcessGroupId(): number | undefined {
  try {
    const stat = fs.readFileSync("/proc/self/stat", "utf8");
    const commandEndIndex = stat.lastIndexOf(")");
    if (commandEndIndex < 0) {
      return undefined;
    }
    const fieldsAfterCommand = stat
      .slice(commandEndIndex + 2)
      .trim()
      .split(/\s+/);
    const processGroupId = Number.parseInt(fieldsAfterCommand[2] ?? "", 10);
    return Number.isInteger(processGroupId) && processGroupId > 0 ? processGroupId : undefined;
  } catch {
    return undefined;
  }
}

function readProcessGroupIdFromPs(): number | undefined {
  try {
    const output = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const processGroupId = Number.parseInt(output.trim(), 10);
    return Number.isInteger(processGroupId) && processGroupId > 0 ? processGroupId : undefined;
  } catch {
    return undefined;
  }
}

function ownerIsGroupLeader(): boolean {
  if (process.platform === "win32") {
    return false;
  }
  return (readLinuxProcessGroupId() ?? readProcessGroupIdFromPs()) === process.pid;
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
  // The exit snapshot's index update may be in the coalesced scalar class —
  // drain it so the index reflects the final owner state (W2.3 / D6).
  await flushPendingSessionIndexUpdates().catch(() => {
    // best effort while queue owner is shutting down
  });
  await releaseQueueOwnerLease(params.lease);
  if (params.verbose) {
    process.stderr.write(`[acpx] queue owner stopped for session ${params.sessionId}\n`);
  }
  // Final orphan backstop: adapter descendants share this owner's process group.
  // The leader guard prevents sweeping an embedding parent's unrelated group.
  if (ownerIsGroupLeader() && hasLiveProcessGroup(process.pid)) {
    signalProcessGroup(process.pid, "SIGKILL");
  }
}

async function writeQueueOwnerLifecycleSnapshot(
  sessionId: string,
  sharedClient: AcpClient,
): Promise<void> {
  try {
    const record = await resolveSessionRecord(sessionId);
    applyLifecycleSnapshotToRecord(record, sharedClient.getAgentLifecycleSnapshot());
    await writeSessionRecordAtBoundary(record);
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
  // Set when a turn auto-failed-over to a new subscription. The shared client is
  // pinned to the OLD CLAUDE_CONFIG_DIR for the owner's lifetime, so we recycle
  // the owner (exit the loop, release the lease) after the current turn; the
  // next prompt cold-spawns a fresh owner on the new dir.
  let recycleOwnerAfterTask = false;
  // Wall-clock of the most recent inter-turn idle-drain activity (background
  // session/update relay of teammate/sub-agent work). 0 = no activity since
  // spawn. Stamped in the idle-drain onAcpMessage handler; read by the idle
  // loop's quiescence gate so a continuously-relaying owner is NEVER recycled.
  let lastIdleDrainActivityAt = 0;
  const sharedClient = createQueueOwnerSharedClient(options, sessionRecord);
  const ttlMs = normalizeQueueOwnerTtlMs(options.ttlMs);
  const maxQueueDepth = Math.max(1, Math.round(options.maxQueueDepth ?? 16));
  const defaultTaskPollTimeoutMs: number | undefined = ttlMs === 0 ? undefined : ttlMs;
  const initialTaskPollTimeoutMs =
    defaultTaskPollTimeoutMs == null ? undefined : Math.max(defaultTaskPollTimeoutMs, 1_000);
  const turnController = createQueueOwnerTurnController(options);

  // Deploy-staleness signal (Path 1, W13-24-10). Capture the owner's build token
  // at spawn; re-read it at each idle check. A difference means a deploy happened
  // while this owner was alive (it is running OUTDATED code) — the ONLY condition
  // under which a quiet, current-code owner may be recycled. Never a liveness check.
  const ownerBuildToken = readDeployedBuildToken();
  const deployedBuildDiffersFromOwner = async (): Promise<boolean> => {
    // Safe default (North Star): no resolvable signal at spawn OR now → never
    // recycle, stay warm. We only recycle on a positive build difference.
    if (ownerBuildToken === undefined) {
      return false;
    }
    const current = readDeployedBuildToken();
    if (current === undefined) {
      return false;
    }
    return current !== ownerBuildToken;
  };

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
        queryActiveTurn: () => turnController.hasActiveTurn(),
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
          // Stamp inter-turn activity so the idle loop's quiescence gate keeps a
          // quietly-relaying owner warm (never recycles it mid background work).
          lastIdleDrainActivityAt = Date.now();
          pendingIdle.push(message);

          const msg = message as Record<string, unknown>;
          if (msg.method === "session/update") {
            const params = msg.params as Record<string, unknown> | undefined;
            const notifMeta = params?._meta as Record<string, unknown> | undefined;
            const notifClaudeCode = notifMeta?.claudeCode as Record<string, unknown> | undefined;
            const update = params?.update as Record<string, unknown> | undefined;
            const updateMeta = update?._meta as Record<string, unknown> | undefined;
            const updateClaudeCode = updateMeta?.claudeCode as Record<string, unknown> | undefined;

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
      const pollTimeoutMs = isFirstTask ? initialTaskPollTimeoutMs : defaultTaskPollTimeoutMs;
      const task = await owner.nextTask(pollTimeoutMs);
      if (!task) {
        // A full idle window elapsed; subsequent waits use the steady cadence.
        isFirstTask = false;
        // No new prompt arrived within the idle-check window. Per the North Star
        // we do NOT reap a live owner for being quiet — the idle window is a
        // deploy-staleness CHECK, never a liveness reap. Recycle ONLY when ALL of:
        //   1. TTL is not disabled (`--ttl 0` means never-recycle).
        //   2. No turn is active — the reliable local turn state, NEVER `inFlight`.
        //   3. Quiescent — no inter-turn idle-drain activity within one check
        //      cadence, so we never tear down an owner relaying background work.
        //   4. The deployed build differs from the owner's — it is running
        //      OUTDATED code (a deploy happened). A current-code owner re-arms
        //      and stays warm forever.
        // When ttl 0, `nextTask` never times out (no task ⇒ keeps waiting), so
        // this branch is unreachable; the `ttlMs !== 0` guard is belt-and-suspenders.
        const quiescenceWindowMs = pollTimeoutMs ?? 0;
        const safeToRecycle =
          ttlMs !== 0 &&
          !turnController.hasActiveTurn() &&
          Date.now() - lastIdleDrainActivityAt >= quiescenceWindowMs &&
          (await deployedBuildDiffersFromOwner());
        if (safeToRecycle) {
          // Graceful deploy-staleness recycle via the existing clean close path
          // (finally → closeQueueOwnerRuntime). The next prompt cold-respawns on
          // current code, resuming WITH context. No new kill primitive.
          break;
        }
        // Current code / busy / active / relaying background work → re-arm, stay warm.
        continue;
      }
      isFirstTask = false;

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
              onFailoverSwitched: (newProfileId: string) => {
                recycleOwnerAfterTask = true;
                if (options.verbose) {
                  process.stderr.write(
                    `[acpx] account failover applied (→ ${newProfileId}); recycling queue owner for session ${options.sessionId} after this turn\n`,
                  );
                }
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

      // A failover this turn pinned the shared client to a now-stale transcript
      // anchor. Exit so the next prompt cold-spawns a fresh owner on the new
      // profile/account.
      if (recycleOwnerAfterTask) {
        break;
      }
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
  const effectiveOptions = await resolveAndPersistSendOwnerOptions(options);

  const queuedToOwner = await submitToRunningOwner(effectiveOptions, waitForCompletion);
  if (queuedToOwner) {
    return queuedToOwner;
  }

  spawnQueueOwnerProcess(queueOwnerRuntimeOptionsFromSend(effectiveOptions));

  for (let attempt = 0; attempt < QUEUE_OWNER_STARTUP_MAX_ATTEMPTS; attempt += 1) {
    const queued = await submitToRunningOwner(effectiveOptions, waitForCompletion);
    if (queued) {
      return queued;
    }
    await waitMs(QUEUE_CONNECT_RETRY_MS);
  }

  throw new Error(`Session queue owner failed to start for session ${options.sessionId}`);
}

async function resolveAndPersistSendOwnerOptions(
  options: SessionSendOptions,
): Promise<SessionSendOptions> {
  const record = await resolveSessionRecord(options.sessionId);
  const ownerOptions = resolveSessionOwnerOptions(record, options, {
    permissionModeExplicit: options.permissionModeExplicit,
  });
  persistSessionOwnerOptions(record, ownerOptionsToInput(ownerOptions));
  await writeSessionRecordAtBoundary(record);
  return {
    ...options,
    permissionMode: ownerOptions.permission_mode,
    nonInteractivePermissions: ownerOptions.non_interactive_permissions,
    authPolicy: ownerOptions.auth_policy,
    terminal: ownerOptions.terminal,
  };
}

export type { QueueOwnerRuntimeOptions };
export { DEFAULT_QUEUE_OWNER_TTL_MS };
