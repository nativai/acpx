import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type AuthMethod,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type ForkSessionResponse,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type LoadSessionResponse,
  type PromptResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type ResumeSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SetSessionConfigOptionResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
  type SessionConfigOption,
  type SessionModelState,
} from "@agentclientprotocol/sdk";
import { resolveBuiltInAgentLaunch } from "../agent-registry.js";
import { TimeoutError, withTimeout } from "../async-control.js";
import type { ProvisioningWarningBreadcrumb } from "../config/os-harness-provisioning.js";
import {
  AgentDisconnectedError,
  AgentSpawnError,
  AgentStartupError,
  AuthPolicyError,
  ClaudeAcpSessionCreateTimeoutError,
  GeminiAcpStartupTimeoutError,
  PermissionDeniedError,
  PermissionPromptUnavailableError,
  UnsupportedPromptContentError,
} from "../errors.js";
import { FileSystemHandlers } from "../filesystem.js";
import {
  classifyPermissionDecision,
  decisionToResponse,
  inferToolKind,
  resolvePermissionRequestWithDetails,
} from "../permissions.js";
import { getUnsupportedPromptContentMessage, textPrompt } from "../prompt-content.js";
import { extractRuntimeSessionId } from "../session/runtime-session-id.js";
import { buildSpawnCommandOptions } from "../spawn-command-options.js";
import type {
  AcpClientOptions,
  AgentProgress,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PermissionStats,
  PromptInput,
  SessionMessage,
} from "../types.js";
import {
  buildClaudeAcpSessionCreateTimeoutMessage,
  buildClaudeCodeOptionsMeta,
  buildGeminiAcpStartupTimeoutMessage,
  buildPrimerSessionMeta,
  buildQoderAcpCommandArgs,
  ensureCopilotAcpSupport,
  isClaudeAcpCommand,
  isCopilotAcpCommand,
  isGeminiAcpCommand,
  isQoderAcpCommand,
  resolveAgentCloseAfterStdinEndMs,
  resolveClaudeAcpSessionCreateTimeoutMs,
  resolveClaudeCodeExecutable,
  resolveGeminiAcpStartupTimeoutMs,
  resolveGeminiCommandArgs,
  resolvePrimerChannel,
  shouldIgnoreNonJsonAgentOutputLine,
} from "./agent-command.js";
import {
  applyProfileAuth,
  buildAgentSpawnOptions,
  buildClaudeHomeSelectorMeta,
  buildClaudeParentSessionMeta,
  effectiveAccountMetadataFromEnv,
  readEnvCredential,
  resolveConfiguredAuthCredential,
  type EffectiveAccountMetadata,
} from "./auth-env.js";
import {
  materializeClaudeForkSession,
  resolveClaudeUuidForAcpxIndex,
} from "./claude-fork-index.js";
import {
  asAbsoluteCwd,
  isoNow,
  isChildProcessRunning,
  requireAgentStdio,
  resolveAgentSessionCwd,
  splitCommandLine,
  waitForChildExit,
  waitForSpawn,
} from "./client-process.js";
import { isCodexAcpCommand } from "./codex-compat.js";
import { extractAcpError } from "./error-shapes.js";
import { avoidBidirectionalJsonRpcIdCollisions, isSessionUpdateNotification } from "./jsonrpc.js";
import type { ShimHandle } from "./openrouter-shim.js";
import {
  formatSessionControlAcpSummary,
  maybeWrapSessionControlError,
} from "./session-control-errors.js";
import { resolveSessionPrimer } from "./session-primer.js";
import { TerminalManager } from "./terminal-manager.js";

export { buildSpawnCommandOptions };
export {
  buildAgentSpawnOptions,
  buildQoderAcpCommandArgs,
  resolveAgentCloseAfterStdinEndMs,
  shouldIgnoreNonJsonAgentOutputLine,
};

const REPLAY_IDLE_MS = 80;
const REPLAY_DRAIN_TIMEOUT_MS = 5_000;
const DRAIN_POLL_INTERVAL_MS = 20;
const AGENT_CLOSE_TERM_GRACE_MS = 1_500;
const AGENT_CLOSE_KILL_GRACE_MS = 1_000;
const STARTUP_STDERR_MAX_CHARS = 8_192;

type LoadSessionOptions = {
  suppressReplayUpdates?: boolean;
  replayIdleMs?: number;
  replayDrainTimeoutMs?: number;
};

type ForkSessionOptions = LoadSessionOptions & {
  atIndex?: number;
  sourceCwd?: string;
  /**
   * The source session's messages_log entries, threaded in so the fork
   * resolver can read durable byway-fork provenance (`messages[atIndex-1]
   * .claudeUuid`) on the PTY-bridge path (A5).
   */
  sourceMessages?: readonly SessionMessage[];
};

type ForkRequestContext = {
  meta?: Record<string, unknown>;
  claudeFork: boolean;
  sourceCwd: string;
  claudeResumeSessionAt?: string;
};

/** The durable byway-fork provenance uuid a messages_log entry carries, if any. */
function forkEntryClaudeUuid(entry: SessionMessage | undefined): string | undefined {
  if (!entry || entry === "Resume") {
    return undefined;
  }
  if ("User" in entry) {
    return entry.User.claudeUuid;
  }
  if ("Agent" in entry) {
    return entry.Agent.claudeUuid;
  }
  return undefined;
}

/**
 * Resolve the fork `_meta` for the PTY-bridge path (A5). When the entry being
 * forked at (`messages[atIndex-1]`) carries durable provenance, send it via the
 * EXISTING direct-uuid path (`claudeCode.options.resumeSessionAt`) — immune to
 * mid-turn steers and any messages_log/transcript divergence. Otherwise fall
 * back to the LEGACY index (`acpx.forkAtMessageIndex`), which the bridge
 * resolves with its reconstructed-index model for pre-provenance sessions.
 */
export function resolvePtyForkMeta(
  sourceMessages: readonly SessionMessage[] | undefined,
  atIndex: number,
): Record<string, unknown> {
  const claudeUuid = forkEntryClaudeUuid(sourceMessages?.[atIndex - 1]);
  if (claudeUuid) {
    return { claudeCode: { options: { resumeSessionAt: claudeUuid } } };
  }
  return { acpx: { forkAtMessageIndex: atIndex } };
}

export type AcpPromptOptions = {
  messageId?: string;
};

function buildPromptRequest(
  sessionId: string,
  prompt: PromptInput,
  options: AcpPromptOptions | undefined,
) {
  return {
    sessionId,
    prompt,
    ...(options?.messageId !== undefined ? { messageId: options.messageId } : {}),
  };
}

export type SessionCreateResult = {
  sessionId: string;
  agentSessionId?: string;
  configOptions?: SessionConfigOption[];
  models?: SessionModelState;
};

export type SessionLoadResult = {
  agentSessionId?: string;
  configOptions?: SessionConfigOption[];
  models?: SessionModelState;
};

export type SessionResumeResult = SessionLoadResult;

export type SessionForkResult = SessionLoadResult & {
  sessionId: string;
};

type ReconnectedSessionResponse = LoadSessionResponse | ResumeSessionResponse;

function toReconnectedSessionResult(
  response: ReconnectedSessionResponse | undefined,
): SessionLoadResult {
  return {
    agentSessionId: extractRuntimeSessionId(response?._meta),
    configOptions: response?.configOptions ?? undefined,
    models: response?.models ?? undefined,
  };
}

function toForkSessionResult(response: ForkSessionResponse): SessionForkResult {
  return {
    sessionId: response.sessionId,
    agentSessionId: extractRuntimeSessionId(response._meta),
    configOptions: response.configOptions ?? undefined,
    models: response.models ?? undefined,
  };
}

function mergeRecordValues(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = merged[key];
    if (isPlainRecord(existing) && isPlainRecord(value)) {
      merged[key] = mergeRecordValues(existing, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deep-merge two optional records; undefined operands drop out. */
function mergeOptionalRecords(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return mergeRecordValues(left, right);
}

type AgentDisconnectReason = "process_exit" | "process_close" | "pipe_close" | "connection_close";

type PendingConnectionRequest = {
  settled: boolean;
  reject: (error: unknown) => void;
};

type AuthSelection = {
  methodId: string;
  credential: string;
  source: "env" | "config";
};

type AgentLaunchPlan = {
  spawnCommand: string;
  args: string[];
  resolvedBuiltInLaunch: ReturnType<typeof resolveBuiltInAgentLaunch>;
  geminiAcp: boolean;
  copilotAcp: boolean;
  claudeAcp: boolean;
  spawnOptions: ReturnType<typeof buildAgentSpawnOptions>;
};

type StartupFailureWatcher = {
  promise: Promise<never>;
  dispose: () => void;
};

type SessionUpdateSuppressionState = {
  suppressSessionUpdates: boolean;
  suppressReplaySessionUpdateMessages: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNestedNumber(value: unknown, path: readonly string[]): number | undefined {
  let cursor = value;
  for (const segment of path) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return readFiniteNumber(cursor);
}

function maxFiniteNumber(values: readonly (number | undefined)[]): number | undefined {
  const numbers = values.filter((value): value is number => value !== undefined);
  return numbers.length > 0 ? Math.max(...numbers) : undefined;
}

export type AgentExitInfo = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  exitedAt: string;
  reason: AgentDisconnectReason;
  unexpectedDuringPrompt: boolean;
};

export type AgentLifecycleSnapshot = {
  pid?: number;
  startedAt?: string;
  running: boolean;
  lastExit?: AgentExitInfo;
  provisioningWarning?: ProvisioningWarningBreadcrumb;
};

type ConsoleErrorMethod = typeof console.error;

function childProcessIsRunning(
  agent: ChildProcessByStdio<Writable, Readable, Readable> | undefined,
): boolean {
  if (!agent) {
    return false;
  }
  return agent.exitCode == null && agent.signalCode == null && !agent.killed;
}

function cancelledPermissionResponse(): RequestPermissionResponse {
  return {
    outcome: {
      outcome: "cancelled",
    },
  };
}

function shouldSuppressSdkConsoleError(args: unknown[]): boolean {
  if (args.length === 0) {
    return false;
  }
  return typeof args[0] === "string" && args[0] === "Error handling request";
}

function installSdkConsoleErrorSuppression(): () => void {
  const originalConsoleError: ConsoleErrorMethod = console.error;
  console.error = (...args: unknown[]) => {
    if (shouldSuppressSdkConsoleError(args)) {
      return;
    }
    originalConsoleError(...args);
  };
  return () => {
    console.error = originalConsoleError;
  };
}

function enqueueNdJsonLine(
  agentCommand: string,
  line: string,
  controller: ReadableStreamDefaultController<AnyMessage>,
): void {
  const trimmedLine = line.trim();
  if (!trimmedLine || shouldIgnoreNonJsonAgentOutputLine(agentCommand, trimmedLine)) {
    return;
  }
  try {
    const message = JSON.parse(trimmedLine) as AnyMessage;
    controller.enqueue(message);
  } catch (err) {
    console.error("Failed to parse JSON message:", trimmedLine, err);
  }
}

function enqueueNdJsonLines(
  agentCommand: string,
  lines: string[],
  controller: ReadableStreamDefaultController<AnyMessage>,
): void {
  for (const line of lines) {
    enqueueNdJsonLine(agentCommand, line, controller);
  }
}

function createNdJsonMessageStream(
  agentCommand: string,
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): {
  readable: ReadableStream<AnyMessage>;
  writable: WritableStream<AnyMessage>;
} {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      let content = "";
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (!value) {
            continue;
          }
          content += textDecoder.decode(value, { stream: true });
          const lines = content.split("\n");
          content = lines.pop() || "";
          enqueueNdJsonLines(agentCommand, lines, controller);
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const content = JSON.stringify(message) + "\n";
      const writer = output.getWriter();
      try {
        await writer.write(textEncoder.encode(content));
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}

export class AcpClient {
  private options: AcpClientOptions;
  private connection?: ClientSideConnection;
  private agent?: ChildProcessByStdio<Writable, Readable, Readable>;
  // The most recently spawned agent child, retained for exit-settling. Unlike
  // `agent` (nulled by close()/reset on disconnect), this survives so a post-turn
  // settleAgentExit can still read the dead child's real exitCode/signalCode after a
  // mid-turn death. Replaced on the next spawn; only read when a disconnect is
  // pending an enrich.
  private lastSpawnedChild?: ChildProcessByStdio<Writable, Readable, Readable>;
  private initResult?: InitializeResponse;
  private loadedSessionId?: string;
  private eventHandlers: Pick<
    AcpClientOptions,
    | "onAcpMessage"
    | "onAcpOutputMessage"
    | "onSessionUpdate"
    | "onClientOperation"
    | "onPermissionEscalation"
  >;
  private readonly permissionStats: PermissionStats = {
    requested: 0,
    approved: 0,
    denied: 0,
    cancelled: 0,
  };
  private readonly filesystem: FileSystemHandlers;
  private readonly terminalManager: TerminalManager;
  private sessionUpdateChain: Promise<void> = Promise.resolve();
  private observedSessionUpdates = 0;
  private processedSessionUpdates = 0;
  private suppressSessionUpdates = false;
  private suppressReplaySessionUpdateMessages = false;
  private activePrompt?: {
    sessionId: string;
    promise: Promise<PromptResponse>;
  };
  private readonly cancellingSessionIds = new Set<string>();
  private readonly permissionAbortControllers = new Map<string, AbortController>();
  private closing = false;
  private shimHandle?: ShimHandle;
  private agentStartedAt?: string;
  private lastAgentExit?: AgentExitInfo;
  private lastKnownPid?: number;
  private latestProvisioningWarning?: ProvisioningWarningBreadcrumb;
  private lastEffectiveAccountMetadata?: EffectiveAccountMetadata;
  private readonly promptPermissionFailures = new Map<string, PermissionPromptUnavailableError>();
  private readonly pendingConnectionRequests = new Set<PendingConnectionRequest>();

  constructor(options: AcpClientOptions) {
    this.options = {
      ...options,
      cwd: asAbsoluteCwd(options.cwd),
      authPolicy: options.authPolicy ?? "skip",
    };
    this.eventHandlers = {
      onAcpMessage: this.options.onAcpMessage,
      onAcpOutputMessage: this.options.onAcpOutputMessage,
      onSessionUpdate: this.options.onSessionUpdate,
      onClientOperation: this.options.onClientOperation,
      onPermissionEscalation: this.options.onPermissionEscalation,
    };

    this.filesystem = new FileSystemHandlers({
      cwd: this.options.cwd,
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      onOperation: (operation) => {
        this.eventHandlers.onClientOperation?.(operation);
      },
    });
    this.terminalManager = new TerminalManager({
      cwd: this.options.cwd,
      permissionMode: this.options.permissionMode,
      nonInteractivePermissions: this.options.nonInteractivePermissions,
      onOperation: (operation) => {
        this.eventHandlers.onClientOperation?.(operation);
      },
    });
  }

  get initializeResult(): InitializeResponse | undefined {
    return this.initResult;
  }

  getAgentPid(): number | undefined {
    return this.agent?.pid ?? this.lastKnownPid;
  }

  getPermissionStats(): PermissionStats {
    return { ...this.permissionStats };
  }

  getEffectiveAccountMetadata(): EffectiveAccountMetadata | undefined {
    return this.lastEffectiveAccountMetadata ? { ...this.lastEffectiveAccountMetadata } : undefined;
  }

  getAgentLifecycleSnapshot(): AgentLifecycleSnapshot {
    const pid = this.agent?.pid ?? this.lastKnownPid;
    const running = childProcessIsRunning(this.agent);
    return {
      pid,
      startedAt: this.agentStartedAt,
      running,
      lastExit: this.lastAgentExit ? { ...this.lastAgentExit } : undefined,
      provisioningWarning: this.latestProvisioningWarning
        ? { ...this.latestProvisioningWarning }
        : undefined,
    };
  }

  /**
   * (b) Make a mid-turn disconnect's REAL OS exit code/signal land on the latched
   * null/null BEFORE the caller reads the lifecycle snapshot to persist it.
   * `connection_close` fires on stdout EOF, which Node delivers BEFORE the child
   * `exit` event carrying the signal — and in the queue-owner flow the client is
   * POOLED (not closed) after the turn, so the exit is otherwise never awaited.
   * Waits (bounded) for the child to be reaped if it is still running, then folds
   * its real exit code/signal in DIRECTLY — NOT via the `exit`/`close` event handler,
   * which may already be queued behind us: the child can be reaped (exitCode/
   * signalCode set) while its handler has not run yet, so relying on the handler
   * would let the enrich land AFTER this persist and leave the record null/null.
   * No-op when there is nothing to settle (no disconnect, or already enriched).
   * Safe-degrade: if the child never exits within `boundMs`, both stay null and we
   * persist null/null as before — the path NEVER hangs.
   */
  async settleAgentExit(boundMs: number): Promise<void> {
    const pending = this.lastAgentExit;
    if (!pending || pending.exitCode !== null || pending.signal !== null) {
      return;
    }
    // Use lastSpawnedChild, NOT `agent`: by the time the turn finalizes after a
    // mid-turn death, `agent` may already be nulled (close()/reset), whereas the
    // dead child object still carries its real exitCode/signalCode.
    const child = this.lastSpawnedChild;
    if (!child) {
      return;
    }
    if (isChildProcessRunning(child)) {
      await waitForChildExit(child, boundMs);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      this.enrichLastAgentExit(child.exitCode, child.signalCode);
    }
  }

  supportsLoadSession(): boolean {
    return Boolean(this.initResult?.agentCapabilities?.loadSession);
  }

  supportsResumeSession(): boolean {
    return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.resume);
  }

  supportsForkSession(): boolean {
    return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.fork);
  }

  supportsCloseSession(): boolean {
    return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.close);
  }

  supportsListSessions(): boolean {
    return Boolean(this.initResult?.agentCapabilities?.sessionCapabilities?.list);
  }

  setEventHandlers(
    handlers: Pick<
      AcpClientOptions,
      | "onAcpMessage"
      | "onAcpOutputMessage"
      | "onSessionUpdate"
      | "onClientOperation"
      | "onPermissionEscalation"
    >,
  ): void {
    this.eventHandlers = { ...handlers };
  }

  clearEventHandlers(): void {
    this.eventHandlers = {};
  }

  updateRuntimeOptions(options: {
    permissionMode?: PermissionMode;
    nonInteractivePermissions?: NonInteractivePermissionPolicy;
    permissionPolicy?: AcpClientOptions["permissionPolicy"];
    terminal?: boolean;
    suppressSdkConsoleErrors?: boolean;
    verbose?: boolean;
  }): void {
    const shouldRefreshPermissionPolicy =
      options.permissionMode !== undefined || options.nonInteractivePermissions !== undefined;
    if (options.permissionMode) {
      this.options.permissionMode = options.permissionMode;
    }
    if (options.nonInteractivePermissions !== undefined) {
      this.options.nonInteractivePermissions = options.nonInteractivePermissions;
    }
    if (Object.prototype.hasOwnProperty.call(options, "permissionPolicy")) {
      this.options.permissionPolicy = options.permissionPolicy;
    }
    if (options.terminal !== undefined) {
      this.options.terminal = options.terminal;
    }
    this.refreshRuntimePermissionPolicy(shouldRefreshPermissionPolicy);
    if (options.suppressSdkConsoleErrors !== undefined) {
      this.options.suppressSdkConsoleErrors = options.suppressSdkConsoleErrors;
    }
    if (options.verbose !== undefined) {
      this.options.verbose = options.verbose;
    }
  }

  private refreshRuntimePermissionPolicy(enabled: boolean): void {
    if (!enabled) {
      return;
    }
    this.filesystem.updatePermissionPolicy(
      this.options.permissionMode,
      this.options.nonInteractivePermissions,
    );
    this.terminalManager.updatePermissionPolicy(
      this.options.permissionMode,
      this.options.nonInteractivePermissions,
    );
  }

  hasReusableSession(sessionId: string): boolean {
    return (
      this.connection != null &&
      this.agent != null &&
      isChildProcessRunning(this.agent) &&
      this.loadedSessionId === sessionId
    );
  }

  hasActivePrompt(sessionId?: string): boolean {
    if (!this.activePrompt) {
      return false;
    }
    if (sessionId == null) {
      return true;
    }
    return this.activePrompt.sessionId === sessionId;
  }

  async start(): Promise<void> {
    if (this.connection && this.agent && isChildProcessRunning(this.agent)) {
      return;
    }
    if (this.connection || this.agent) {
      await this.close();
    }

    const launch = await this.resolveAgentLaunchPlan();
    this.logAgentLaunch(launch);
    await this.ensureLaunchSupport(launch);
    this.lastEffectiveAccountMetadata = effectiveAccountMetadataFromEnv(launch.spawnOptions.env);
    const child = await this.spawnAgentProcess(launch);
    this.closing = false;
    this.agentStartedAt = isoNow();
    this.lastAgentExit = undefined;
    this.lastKnownPid = child.pid ?? undefined;
    this.attachAgentLifecycleObservers(child);
    const startupStderr: string[] = [];

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.captureStartupStderr(startupStderr, chunk);
      if (!this.options.verbose) {
        return;
      }
      process.stderr.write(chunk);
    });

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = this.createTappedStream(
      createNdJsonMessageStream(this.options.agentCommand, input, output),
    );

    const connection = this.createConnection(stream);
    connection.signal.addEventListener(
      "abort",
      () => {
        this.recordAgentExit("connection_close", child.exitCode ?? null, child.signalCode ?? null);
      },
      { once: true },
    );
    const startupFailure = this.createStartupFailureWatcher(child, startupStderr);

    await this.initializeAgentConnection({
      child,
      connection,
      startupFailure,
      startupStderr,
      launch,
    });
  }

  private async resolveAgentLaunchPlan(): Promise<AgentLaunchPlan> {
    const configuredCommand = splitCommandLine(this.options.agentCommand);
    const resolvedBuiltInLaunch = resolveBuiltInAgentLaunch(this.options.agentCommand);
    const spawnCommand = resolvedBuiltInLaunch?.command ?? configuredCommand.command;
    let args = resolvedBuiltInLaunch?.args ?? configuredCommand.args;
    args = await resolveGeminiCommandArgs(spawnCommand, args);
    if (isQoderAcpCommand(spawnCommand, args)) {
      args = buildQoderAcpCommandArgs(args, this.options);
    }
    const spawnOptions = buildAgentSpawnOptions(
      this.options.cwd,
      this.options.authCredentials,
      this.options.sessionContext,
      undefined,
      this.options.agentCommand,
      (warning) => {
        this.latestProvisioningWarning = warning;
      },
    );
    await this.applyProfileEnv(spawnOptions.env);
    return {
      spawnCommand,
      args,
      resolvedBuiltInLaunch,
      geminiAcp: isGeminiAcpCommand(spawnCommand, args),
      copilotAcp: isCopilotAcpCommand(spawnCommand, args),
      claudeAcp: isClaudeAcpCommand(spawnCommand, args),
      spawnOptions,
    };
  }

  /**
   * Apply the async portion of profile-based auth to the spawn env in place.
   * For authMode=openrouter: starts the shim (first spawn) or reinjects the
   * running shim's port (reconnect). For subscription / no profile: no-op.
   */
  private async applyProfileEnv(env: NodeJS.ProcessEnv): Promise<void> {
    const profileId = this.options.sessionContext?.profileId?.trim();
    if (!profileId) {
      return;
    }
    if (!this.shimHandle) {
      await this.startProfileShim(env, profileId);
    } else {
      env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${this.shimHandle.port}`;
      env.ANTHROPIC_AUTH_TOKEN = " ";
      delete env.ANTHROPIC_CUSTOM_HEADERS;
    }
  }

  /** First-spawn path: create the OR shim and inject its port into the env. */
  private async startProfileShim(env: NodeJS.ProcessEnv, profileId: string): Promise<void> {
    const ctx = this.options.sessionContext;
    const sessionId = ctx?.acpxRecordId ?? profileId;
    const reasoningEffort = ctx?.reasoningEffort ?? null;
    this.shimHandle =
      (await applyProfileAuth(
        env,
        profileId,
        sessionId,
        reasoningEffort,
        undefined,
        this.options.agentCommand,
        (warning) => {
          this.latestProvisioningWarning = warning;
        },
      )) ?? undefined;
  }

  private logAgentLaunch(plan: AgentLaunchPlan): void {
    const launch = plan.resolvedBuiltInLaunch;
    if (launch?.source === "installed") {
      this.log(
        `spawning installed built-in agent ${launch.packageName}${launch.packageVersion ? `@${launch.packageVersion}` : ""} via ${plan.spawnCommand} ${plan.args.join(" ")}`,
      );
      return;
    }
    if (launch?.source === "package-exec") {
      this.log(
        `spawning built-in agent ${launch.packageName}@${launch.packageRange} via current Node package exec bridge ${plan.spawnCommand} ${plan.args.join(" ")}`,
      );
      return;
    }
    this.log(`spawning agent: ${plan.spawnCommand} ${plan.args.join(" ")}`);
  }

  private async ensureLaunchSupport(plan: AgentLaunchPlan): Promise<void> {
    if (plan.copilotAcp) {
      await ensureCopilotAcpSupport(plan.spawnCommand);
    }
    if (!plan.claudeAcp) {
      return;
    }
    const claudeExe = resolveClaudeCodeExecutable(process.platform, plan.spawnOptions.env);
    if (claudeExe) {
      plan.spawnOptions.env.CLAUDE_CODE_EXECUTABLE = claudeExe;
      this.log(`resolved system Claude Code executable: ${claudeExe}`);
    }
  }

  private async spawnAgentProcess(
    plan: AgentLaunchPlan,
  ): Promise<ChildProcessByStdio<Writable, Readable, Readable>> {
    const spawnedChild = spawn(
      plan.spawnCommand,
      plan.args,
      buildSpawnCommandOptions(plan.spawnCommand, plan.spawnOptions),
    ) as ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      await waitForSpawn(spawnedChild);
    } catch (error) {
      throw new AgentSpawnError(this.options.agentCommand, error);
    }
    return requireAgentStdio(spawnedChild);
  }

  private createConnection(stream: {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  }): ClientSideConnection {
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          await this.handleSessionUpdate(params);
        },
        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          return this.handlePermissionRequest(params);
        },
        readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
          return this.handleReadTextFile(params);
        },
        writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
          return this.handleWriteTextFile(params);
        },
        createTerminal: async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
          return this.handleCreateTerminal(params);
        },
        terminalOutput: async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
          return this.handleTerminalOutput(params);
        },
        waitForTerminalExit: async (
          params: WaitForTerminalExitRequest,
        ): Promise<WaitForTerminalExitResponse> => {
          return this.handleWaitForTerminalExit(params);
        },
        killTerminal: async (params: KillTerminalRequest): Promise<KillTerminalResponse> => {
          return this.handleKillTerminal(params);
        },
        releaseTerminal: async (
          params: ReleaseTerminalRequest,
        ): Promise<ReleaseTerminalResponse> => {
          return this.handleReleaseTerminal(params);
        },
      }),
      stream,
    );
    // The ACP SDK starts client request ids at 0. Some bidirectional ACP
    // adapters also issue client-bound requests from 0; using a disjoint range
    // avoids same-id overlap between e.g. session/prompt and request_permission.
    avoidBidirectionalJsonRpcIdCollisions(connection);
    return connection;
  }

  private async initializeAgentConnection(params: {
    child: ChildProcessByStdio<Writable, Readable, Readable>;
    connection: ClientSideConnection;
    startupFailure: StartupFailureWatcher;
    startupStderr: string[];
    launch: AgentLaunchPlan;
  }): Promise<void> {
    try {
      const initResult = await Promise.race([
        this.initializeProtocolConnection(params.connection, params.launch.geminiAcp),
        params.startupFailure.promise,
      ]);
      params.startupFailure.dispose();
      this.connection = params.connection;
      this.agent = params.child;
      this.lastSpawnedChild = params.child;
      this.initResult = initResult;
      this.log(`initialized protocol version ${initResult.protocolVersion}`);
    } catch (error) {
      await this.handleInitializeFailure(params, error);
    }
  }

  private async initializeProtocolConnection(
    connection: ClientSideConnection,
    geminiAcp: boolean,
  ): Promise<InitializeResponse> {
    const initializePromise = connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: this.options.terminal !== false,
      },
      clientInfo: {
        name: "acpx",
        version: "0.1.0",
      },
    });
    const initialized = geminiAcp
      ? await withTimeout(initializePromise, resolveGeminiAcpStartupTimeoutMs())
      : await initializePromise;
    await this.authenticateIfRequired(connection, initialized.authMethods ?? []);
    return initialized;
  }

  private async handleInitializeFailure(
    params: {
      child: ChildProcessByStdio<Writable, Readable, Readable>;
      startupFailure: StartupFailureWatcher;
      startupStderr: string[];
      launch: AgentLaunchPlan;
    },
    error: unknown,
  ): Promise<never> {
    params.startupFailure.dispose();
    const normalizedError = await this.normalizeInitializeError(
      error,
      params.child,
      params.startupStderr,
    );
    try {
      params.child.kill();
    } catch {
      // best effort
    }
    if (params.launch.geminiAcp && error instanceof TimeoutError) {
      throw new GeminiAcpStartupTimeoutError(
        await buildGeminiAcpStartupTimeoutMessage(params.launch.spawnCommand),
        {
          cause: error,
          retryable: true,
        },
      );
    }
    throw normalizedError;
  }

  private createTappedStream(base: {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  }): {
    readable: ReadableStream<AnyMessage>;
    writable: WritableStream<AnyMessage>;
  } {
    const onAcpMessage = () => this.eventHandlers.onAcpMessage;
    const onAcpOutputMessage = () => this.eventHandlers.onAcpOutputMessage;

    const shouldSuppressInboundReplaySessionUpdate = (message: AnyMessage): boolean => {
      return this.suppressReplaySessionUpdateMessages && isSessionUpdateNotification(message);
    };

    const readable = new ReadableStream<AnyMessage>({
      async start(controller) {
        const reader = base.readable.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            if (!value) {
              continue;
            }
            if (!shouldSuppressInboundReplaySessionUpdate(value)) {
              onAcpOutputMessage()?.("inbound", value);
              onAcpMessage()?.("inbound", value);
            }
            controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
          controller.close();
        }
      },
    });

    const writable = new WritableStream<AnyMessage>({
      async write(message) {
        onAcpOutputMessage()?.("outbound", message);
        onAcpMessage()?.("outbound", message);
        const writer = base.writable.getWriter();
        try {
          await writer.write(message);
        } finally {
          writer.releaseLock();
        }
      },
    });

    return { readable, writable };
  }

  async createSession(cwd = this.options.cwd): Promise<SessionCreateResult> {
    const connection = this.getConnection();
    const { command, args } = splitCommandLine(this.options.agentCommand);
    const claudeAcp = isClaudeAcpCommand(command, args);
    const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);

    const newSessionMeta = await this.buildNewSessionMeta();

    let result: Awaited<ReturnType<typeof connection.newSession>>;
    try {
      const createPromise = this.runConnectionRequest(() =>
        connection.newSession({
          cwd: sessionCwd,
          mcpServers: this.options.mcpServers ?? [],
          _meta: newSessionMeta,
        }),
      );
      result = claudeAcp
        ? await withTimeout(createPromise, resolveClaudeAcpSessionCreateTimeoutMs())
        : await createPromise;
    } catch (error) {
      if (claudeAcp && error instanceof TimeoutError) {
        throw new ClaudeAcpSessionCreateTimeoutError(buildClaudeAcpSessionCreateTimeoutMessage(), {
          cause: error,
          retryable: true,
        });
      }
      throw error;
    }

    this.loadedSessionId = result.sessionId;

    return {
      sessionId: result.sessionId,
      agentSessionId: extractRuntimeSessionId(result._meta),
      configOptions: result.configOptions ?? undefined,
      models: result.models ?? undefined,
    };
  }

  /**
   * session/new `_meta`: the claudeCode options fragment plus — for a
   * claude-home profile session — the bridge HOME selector
   * (independent-claude-acp/home). Recomputed per call, so EVERY spawn path
   * that lands in createSession (create / recover-fresh / keepwarm) carries
   * the selector: a missing selector does not error bridge-side, it silently
   * runs under the box-default HOME (wrong credentials).
   */
  private async buildNewSessionMeta(): Promise<Record<string, unknown> | undefined> {
    const optionsMeta = buildClaudeCodeOptionsMeta(this.options.sessionOptions);
    const homeSelectorMeta = this.buildHomeSelectorMeta();
    // FW-18/FW-19: the claude-pty bridge learns its per-session parent from the
    // session/new `_meta` (not the spawn process env — one bridge serves many
    // sessions). Carry the parent URL here so the child claude gets
    // ACPX_PARENT_SESSION_URL and can message its parent back.
    const parentMeta = buildClaudeParentSessionMeta(
      this.options.sessionContext,
      this.options.agentCommand,
    );
    // OS primer (CONCEPTION §4.5.1): resolve `session-context.sh`, route by
    // agent type, and fold in any human `--append-system-prompt`. Merged LAST so
    // the primer fragment owns `systemPrompt` / `codex.developerInstructions`.
    const primerMeta = await this.buildPrimerSessionMeta(optionsMeta);
    const merged = { ...optionsMeta, ...homeSelectorMeta, ...parentMeta, ...primerMeta };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  /**
   * The OS-primer `_meta` fragment for this agent's channel (CONCEPTION §4.4),
   * or undefined when the agent type is unknown / the primer is unavailable
   * (fail-open). `optionsMeta.systemPrompt` carries any human `--system-prompt`
   * / `--append-system-prompt` so the composer can compose (never clobber) it.
   */
  private async buildPrimerSessionMeta(
    optionsMeta: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    const channel = resolvePrimerChannel(this.options.agentCommand);
    if (channel === "none") {
      return undefined;
    }
    const primer = await resolveSessionPrimer();
    if (primer === undefined) {
      return undefined;
    }
    return buildPrimerSessionMeta(channel, primer, optionsMeta?.systemPrompt);
  }

  /**
   * Resume/reconnect re-supply (CONCEPTION §4.5.2, gotcha D): for the
   * SYSTEM-PROMPT channels only, re-attach the primer `_meta.systemPrompt` so a
   * cold rebuild (adapter restarted) regenerates it. Idempotent — a system
   * prompt is regenerated each launch, never stored in conversation history. For
   * CODEX this returns undefined: the developer item is already in the restored
   * thread history, so re-sending would duplicate it.
   */
  private async buildResumePrimerMeta(): Promise<Record<string, unknown> | undefined> {
    const channel = resolvePrimerChannel(this.options.agentCommand);
    if (channel !== "system-prompt") {
      return undefined;
    }
    const primer = await resolveSessionPrimer();
    if (primer === undefined) {
      return undefined;
    }
    const optionsMeta = buildClaudeCodeOptionsMeta(this.options.sessionOptions);
    return buildPrimerSessionMeta(channel, primer, optionsMeta?.systemPrompt);
  }

  private buildHomeSelectorMeta(): Record<string, unknown> | undefined {
    return buildClaudeHomeSelectorMeta(this.options.sessionContext?.profileId);
  }

  async loadSession(sessionId: string, cwd = this.options.cwd): Promise<SessionLoadResult> {
    this.getConnection();
    return await this.loadSessionWithOptions(sessionId, cwd, {});
  }

  async loadSessionWithOptions(
    sessionId: string,
    cwd = this.options.cwd,
    options: LoadSessionOptions = {},
  ): Promise<SessionLoadResult> {
    const connection = this.getConnection();
    const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
    const previousSuppression = this.applySessionUpdateSuppression(
      Boolean(options.suppressReplayUpdates),
    );

    let response: LoadSessionResponse | undefined;

    try {
      // For claude-home sessions, carry the HOME selector on session/load too:
      // when the bridge advertises loadSession (feat/session-load), the loaded
      // session must re-bind to the same home — and a missing selector falls
      // back silently to the box-default HOME, not an error.
      const homeSelectorMeta = this.buildHomeSelectorMeta();
      // Re-supply the primer on cold load for the system-prompt channels
      // (CONCEPTION §4.5.2) so a restarted adapter regenerates it; codex returns
      // undefined here (its developer item is already in restored history).
      const primerMeta = await this.buildResumePrimerMeta();
      const loadMeta = { ...homeSelectorMeta, ...primerMeta };
      response = await this.runConnectionRequest(() =>
        connection.loadSession({
          sessionId,
          cwd: sessionCwd,
          mcpServers: this.options.mcpServers ?? [],
          ...(Object.keys(loadMeta).length > 0 ? { _meta: loadMeta } : {}),
        }),
      );

      await this.waitForSessionUpdateDrain(
        options.replayIdleMs ?? REPLAY_IDLE_MS,
        options.replayDrainTimeoutMs ?? REPLAY_DRAIN_TIMEOUT_MS,
      );
    } finally {
      this.restoreSessionUpdateSuppression(previousSuppression);
    }

    this.loadedSessionId = sessionId;

    return toReconnectedSessionResult(response);
  }

  async resumeSession(sessionId: string, cwd = this.options.cwd): Promise<SessionResumeResult> {
    const connection = this.getConnection();
    const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
    // Re-supply the primer on cold resume for the system-prompt channels
    // (CONCEPTION §4.5.2): a regenerated system prompt is dropped on rebuild
    // unless re-sent. Idempotent; codex returns undefined (restored from thread).
    const primerMeta = await this.buildResumePrimerMeta();
    const response = await this.runConnectionRequest(() =>
      connection.resumeSession({
        sessionId,
        cwd: sessionCwd,
        mcpServers: this.options.mcpServers ?? [],
        ...(primerMeta ? { _meta: primerMeta } : {}),
      }),
    );

    this.loadedSessionId = sessionId;

    return toReconnectedSessionResult(response);
  }

  async forkSession(
    sourceAcpSessionId: string,
    cwd = this.options.cwd,
    options: ForkSessionOptions = {},
  ): Promise<SessionForkResult> {
    const connection = this.getConnection();
    const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
    const sourceCwd = await resolveAgentSessionCwd(
      options.sourceCwd ?? cwd,
      this.options.agentCommand,
    );
    const forkContext = await this.buildForkRequestContext(
      sourceAcpSessionId,
      sourceCwd,
      options.atIndex,
      options.sourceMessages,
    );
    const requestMeta = await this.buildForkRequestMeta(forkContext);
    const requestCwd = this.resolveForkRequestCwd(forkContext, sessionCwd);
    const previousSuppression = this.applySessionUpdateSuppression(
      Boolean(options.suppressReplayUpdates),
    );

    let response: ForkSessionResponse | undefined;

    try {
      response = await this.runConnectionRequest(() =>
        connection.unstable_forkSession({
          sessionId: sourceAcpSessionId,
          cwd: requestCwd,
          mcpServers: this.options.mcpServers ?? [],
          ...(requestMeta ? { _meta: requestMeta } : {}),
        }),
      );

      await this.waitForSessionUpdateDrain(
        options.replayIdleMs ?? REPLAY_IDLE_MS,
        options.replayDrainTimeoutMs ?? REPLAY_DRAIN_TIMEOUT_MS,
      );
    } finally {
      this.restoreSessionUpdateSuppression(previousSuppression);
    }

    if (!response) {
      throw new Error("session/fork returned no response");
    }
    const result = toForkSessionResult(response);
    await this.applyDurableClaudeForkSessionId(result, forkContext, sourceAcpSessionId, sessionCwd);

    this.loadedSessionId = result.sessionId;

    return result;
  }

  private resolveForkRequestCwd(forkContext: ForkRequestContext, sessionCwd: string): string {
    // Claude's ACP fork path resolves the source transcript relative to the
    // request cwd. Cross-cwd copies therefore ask ACP to fork from the source cwd;
    // the SDK materializer below writes the durable copy into the destination cwd.
    if (
      forkContext.claudeFork &&
      path.resolve(forkContext.sourceCwd) !== path.resolve(sessionCwd)
    ) {
      return forkContext.sourceCwd;
    }
    return sessionCwd;
  }

  private async buildForkRequestMeta(
    forkContext: ForkRequestContext,
  ): Promise<Record<string, unknown> | undefined> {
    const optionsMeta = forkContext.claudeFork
      ? buildClaudeCodeOptionsMeta(this.options.sessionOptions)
      : undefined;
    // A forked Claude session rebuilds its system prompt fresh, so carry the
    // primer through for the system-prompt channels too (CONCEPTION §4.5.3).
    // codex forks inherit the developer item via threadFork's copied history.
    const primerMeta = await this.buildResumePrimerMeta();
    const baseMeta = mergeOptionalRecords(optionsMeta, primerMeta);
    if (!forkContext.meta) {
      return baseMeta;
    }
    if (!baseMeta) {
      return forkContext.meta;
    }
    return mergeRecordValues(baseMeta, forkContext.meta);
  }

  /**
   * The subscription selection the Claude copy path must resolve its
   * CLAUDE_CONFIG_DIR from. `--subscription`/`--profile` are unified into
   * `sessionOptions.profile` (see `sessionOptionsFromGlobalFlags`); legacy
   * records may still carry `.subscription`. The adapter spawn resolves its
   * config dir from this same selection (via `sessionContext.profileId`), so
   * `materializeClaudeForkSession` and the at-index UUID lookup must use it too
   * — otherwise they fall back to the registry default and write/read the
   * durable fork transcript in a different config dir than the adapter, making
   * the post-fork `set_model`/recall fail on a non-default-subscription fork
   * (FW-15).
   */
  private claudeCopySubscriptionSelection(): string | undefined {
    return this.options.sessionOptions?.profile ?? this.options.sessionOptions?.subscription;
  }

  private async applyDurableClaudeForkSessionId(
    result: SessionForkResult,
    forkContext: ForkRequestContext,
    sourceAcpSessionId: string,
    cwd: string,
  ): Promise<void> {
    if (!forkContext.claudeFork) {
      return;
    }

    const durableClaudeSessionId = await materializeClaudeForkSession({
      agentCommand: this.options.agentCommand,
      cwd,
      sourceCwd: forkContext.sourceCwd,
      sourceAcpSessionId,
      subscriptionId: this.claudeCopySubscriptionSelection(),
      upToMessageId: forkContext.claudeResumeSessionAt,
    });
    if (!durableClaudeSessionId) {
      return;
    }

    result.sessionId = durableClaudeSessionId;
    result.agentSessionId = durableClaudeSessionId;
  }

  private async buildForkRequestContext(
    sourceAcpSessionId: string,
    cwd: string,
    atIndex: number | undefined,
    sourceMessages: readonly SessionMessage[] | undefined,
  ): Promise<ForkRequestContext> {
    const { command, args } = splitCommandLine(this.options.agentCommand);

    if (atIndex === undefined) {
      return { claudeFork: isClaudeAcpCommand(command, args), sourceCwd: cwd };
    }

    if (isClaudeAcpCommand(command, args)) {
      const uuid = await resolveClaudeUuidForAcpxIndex({
        cwd,
        acpSessionId: sourceAcpSessionId,
        forkAtIndex: atIndex,
        subscriptionId: this.claudeCopySubscriptionSelection(),
      });
      if (!uuid) {
        throw new Error(
          `Cannot copy Claude session at --at-index ${atIndex}: no Claude transcript UUID could be resolved for that acpx message index`,
        );
      }
      return {
        claudeFork: true,
        sourceCwd: cwd,
        claudeResumeSessionAt: uuid,
        meta: { claudeCode: { options: { resumeSessionAt: uuid } } },
      };
    }

    // PTY-bridge path (not isClaudeAcpCommand): prefer durable provenance, fall
    // back to the legacy messages_log index for pre-provenance sessions (A5).
    return {
      claudeFork: false,
      sourceCwd: cwd,
      meta: resolvePtyForkMeta(sourceMessages, atIndex),
    };
  }

  private applySessionUpdateSuppression(enabled: boolean): SessionUpdateSuppressionState {
    const previous = {
      suppressSessionUpdates: this.suppressSessionUpdates,
      suppressReplaySessionUpdateMessages: this.suppressReplaySessionUpdateMessages,
    };
    this.suppressSessionUpdates = previous.suppressSessionUpdates || enabled;
    this.suppressReplaySessionUpdateMessages =
      previous.suppressReplaySessionUpdateMessages || enabled;
    return previous;
  }

  private restoreSessionUpdateSuppression(previous: SessionUpdateSuppressionState): void {
    this.suppressSessionUpdates = previous.suppressSessionUpdates;
    this.suppressReplaySessionUpdateMessages = previous.suppressReplaySessionUpdateMessages;
  }

  async prompt(
    sessionId: string,
    prompt: PromptInput | string,
    options?: AcpPromptOptions,
  ): Promise<PromptResponse> {
    const connection = this.getConnection();
    const normalizedPrompt = this.normalizePromptForAgent(prompt);
    const restoreConsoleError = this.options.suppressSdkConsoleErrors
      ? installSdkConsoleErrorSuppression()
      : undefined;

    let promptPromise: Promise<PromptResponse>;
    try {
      promptPromise = this.runConnectionRequest(() =>
        connection.prompt({
          ...buildPromptRequest(sessionId, normalizedPrompt, options),
        }),
      );
    } catch (error) {
      restoreConsoleError?.();
      throw error;
    }

    this.activePrompt = {
      sessionId,
      promise: promptPromise,
    };

    try {
      const response = await promptPromise;
      this.throwPromptPermissionFailureIfPresent(sessionId);
      await this.emitCodexFinalProgressUpdate(sessionId, response);
      return response;
    } catch (error) {
      this.throwPromptPermissionFailureIfPresent(sessionId);
      throw error;
    } finally {
      restoreConsoleError?.();
      if (this.activePrompt?.promise === promptPromise) {
        this.activePrompt = undefined;
      }
      this.cancellingSessionIds.delete(sessionId);
      this.abortAndDropPermissionSignal(sessionId);
      this.promptPermissionFailures.delete(sessionId);
    }
  }

  private normalizePromptForAgent(prompt: PromptInput | string): PromptInput {
    const normalizedPrompt = typeof prompt === "string" ? textPrompt(prompt) : prompt;
    const unsupportedPromptContent = getUnsupportedPromptContentMessage(
      normalizedPrompt,
      this.initResult?.agentCapabilities,
    );
    if (unsupportedPromptContent) {
      throw new UnsupportedPromptContentError(unsupportedPromptContent);
    }
    return normalizedPrompt;
  }

  private returnPromptResponseOrPermissionFailure(
    sessionId: string,
    response: PromptResponse,
  ): PromptResponse {
    this.throwPromptPermissionFailureIfPresent(sessionId);
    return response;
  }

  private throwPromptPermissionFailureIfPresent(sessionId: string): void {
    const permissionFailure = this.consumePromptPermissionFailure(sessionId);
    if (permissionFailure) {
      throw permissionFailure;
    }
  }

  private isCodexBackend(): boolean {
    const command = splitCommandLine(this.options.agentCommand);
    return isCodexAcpCommand(command.command, command.args);
  }

  private readCodexFinalReasoningTokens(response: PromptResponse): number | undefined {
    const rawResponse = response as unknown;
    return maxFiniteNumber([
      readNestedNumber(rawResponse, ["thoughtTokens"]),
      readNestedNumber(rawResponse, ["usage", "thoughtTokens"]),
      readNestedNumber(rawResponse, ["usage", "reasoningOutputTokens"]),
      readNestedNumber(rawResponse, ["_meta", "quota", "token_count", "reasoningOutputTokens"]),
      readNestedNumber(rawResponse, [
        "usage",
        "_meta",
        "quota",
        "token_count",
        "reasoningOutputTokens",
      ]),
    ]);
  }

  private async emitCodexFinalProgressUpdate(
    sessionId: string,
    response: PromptResponse,
  ): Promise<void> {
    if (!this.isCodexBackend()) {
      return;
    }
    const reasoning = this.readCodexFinalReasoningTokens(response);
    if (reasoning === undefined) {
      return;
    }
    const progress: AgentProgress = {
      phase: "thinking",
      tokens: { reasoning },
      final: true,
      source: "codex",
    };
    const notification: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: "agent_progress_update",
        progress,
      } as unknown as SessionNotification["update"],
    };
    const message: AnyMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: notification,
    };
    this.eventHandlers.onAcpOutputMessage?.("inbound", message);
    this.eventHandlers.onAcpMessage?.("inbound", message);
    await this.handleSessionUpdate(notification);
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    const connection = this.getConnection();
    try {
      await this.runConnectionRequest(() =>
        connection.setSessionMode({
          sessionId,
          modeId,
        }),
      );
    } catch (error) {
      throw maybeWrapSessionControlError("session/set_mode", error, `for mode "${modeId}"`);
    }
  }

  async setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<SetSessionConfigOptionResponse> {
    const connection = this.getConnection();
    try {
      return await this.runConnectionRequest(() =>
        connection.setSessionConfigOption({
          sessionId,
          configId,
          value,
        }),
      );
    } catch (error) {
      throw maybeWrapSessionControlError(
        "session/set_config_option",
        error,
        `for "${configId}"="${value}"`,
      );
    }
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    const connection = this.getConnection();
    try {
      await this.runConnectionRequest(() =>
        connection.unstable_setSessionModel({
          sessionId,
          modelId,
        }),
      );
    } catch (error) {
      const wrapped = maybeWrapSessionControlError(
        "session/set_model",
        error,
        `for model "${modelId}"`,
      );
      if (wrapped !== error) {
        throw wrapped;
      }
      const acp = extractAcpError(error);
      const summary = acp
        ? formatSessionControlAcpSummary(acp)
        : error instanceof Error
          ? error.message
          : String(error);
      if (error instanceof Error) {
        throw new Error(`Failed session/set_model for model "${modelId}": ${summary}`, {
          cause: error,
        });
      }
      throw new Error(`Failed session/set_model for model "${modelId}": ${summary}`, {
        cause: error,
      });
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const connection = this.getConnection();
    this.cancellingSessionIds.add(sessionId);
    this.abortAndDropPermissionSignal(sessionId);
    await this.runConnectionRequest(() =>
      connection.cancel({
        sessionId,
      }),
    );
  }

  async closeSession(sessionId: string): Promise<void> {
    const connection = this.getConnection();
    await this.runConnectionRequest(() =>
      connection.closeSession({
        sessionId,
      }),
    );
    if (this.loadedSessionId === sessionId) {
      this.loadedSessionId = undefined;
    }
  }

  async listSessions(params: ListSessionsRequest = {}): Promise<ListSessionsResponse> {
    const connection = this.getConnection();
    return await this.runConnectionRequest(() => connection.listSessions(params));
  }

  async requestCancelActivePrompt(): Promise<boolean> {
    const active = this.activePrompt;
    if (!active) {
      return false;
    }
    await this.cancel(active.sessionId);
    return true;
  }

  async cancelActivePrompt(waitMs = 2_500): Promise<PromptResponse | undefined> {
    const active = this.activePrompt;
    if (!active) {
      return undefined;
    }

    try {
      await this.cancel(active.sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send session/cancel: ${message}`);
    }

    if (waitMs <= 0) {
      return undefined;
    }

    let timer: NodeJS.Timeout | number | undefined;
    const timeoutPromise = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });

    try {
      return await Promise.race([
        active.promise.then(
          (response) => response,
          () => undefined,
        ),
        timeoutPromise,
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async close(): Promise<void> {
    this.closing = true;

    await this.terminalManager.shutdown();

    const agent = this.agent;
    if (agent) {
      await this.terminateAgentProcess(agent);
    }
    if (this.pendingConnectionRequests.size > 0) {
      this.rejectPendingConnectionRequests(
        this.lastAgentExit
          ? new AgentDisconnectedError(
              this.lastAgentExit.reason,
              this.lastAgentExit.exitCode,
              this.lastAgentExit.signal,
              {
                outputAlreadyEmitted: Boolean(this.activePrompt),
              },
            )
          : new AgentDisconnectedError("connection_close", null, null, {
              outputAlreadyEmitted: Boolean(this.activePrompt),
            }),
      );
    }

    this.sessionUpdateChain = Promise.resolve();
    this.observedSessionUpdates = 0;
    this.processedSessionUpdates = 0;
    this.suppressSessionUpdates = false;
    this.suppressReplaySessionUpdateMessages = false;
    this.activePrompt = undefined;
    this.cancellingSessionIds.clear();
    for (const controller of this.permissionAbortControllers.values()) {
      controller.abort();
    }
    this.permissionAbortControllers.clear();
    this.promptPermissionFailures.clear();
    this.loadedSessionId = undefined;
    this.initResult = undefined;
    this.connection = undefined;
    this.agent = undefined;
    this.shimHandle?.stop();
    this.shimHandle = undefined;
  }

  private async terminateAgentProcess(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
  ): Promise<void> {
    const stdinCloseGraceMs = resolveAgentCloseAfterStdinEndMs(this.options.agentCommand);
    this.endAgentStdin(child);
    let exited = await waitForChildExit(child, stdinCloseGraceMs);
    exited = await this.killAgentIfRunning(child, exited, "SIGTERM", AGENT_CLOSE_TERM_GRACE_MS);
    if (!exited) {
      this.log(`agent did not exit after ${AGENT_CLOSE_TERM_GRACE_MS}ms; forcing SIGKILL`);
      exited = await this.killAgentIfRunning(child, exited, "SIGKILL", AGENT_CLOSE_KILL_GRACE_MS);
    }

    // Ensure stdio handles don't keep this process alive after close() returns.
    this.detachAgentHandles(child, !exited);
  }

  private endAgentStdin(child: ChildProcessByStdio<Writable, Readable, Readable>): void {
    // Closing stdin is the most graceful shutdown signal for stdio-based ACP agents.
    if (child.stdin.destroyed) {
      return;
    }
    try {
      child.stdin.end();
    } catch {
      // best effort
    }
  }

  private async killAgentIfRunning(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
    alreadyExited: boolean,
    signal: NodeJS.Signals,
    waitMs: number,
  ): Promise<boolean> {
    if (alreadyExited || !isChildProcessRunning(child)) {
      return alreadyExited;
    }
    try {
      child.kill(signal);
    } catch {
      // best effort
    }
    return await waitForChildExit(child, waitMs);
  }

  private detachAgentHandles(agent: ChildProcess, unref: boolean): void {
    const stdin = agent.stdin;
    const stdout = agent.stdout;
    const stderr = agent.stderr;

    stdin?.destroy();
    stdout?.destroy();
    stderr?.destroy();

    if (unref) {
      try {
        agent.unref();
      } catch {
        // best effort
      }
    }
  }

  private getConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error("ACP client not started");
    }
    return this.connection;
  }

  private log(message: string): void {
    if (!this.options.verbose) {
      return;
    }
    process.stderr.write(`[acpx] ${message}\n`);
  }

  // Unconditional (NOT verbose-gated) owner-log line. The queue-owner now routes
  // its stdout+stderr to `<id>.owner.log`, so an agent disconnect/exit leaves a
  // diagnostic trail even when the adapter itself is SILENT on stderr and the
  // death is a signal (e.g. SIGKILL) that writes nothing. Best-effort: never let
  // logging break exit handling.
  private logOwnerEvent(message: string): void {
    // Only when this process is a queue-owner whose stderr is redirected to the
    // per-session owner log (ACPX_OWNER_LOG=1, set at spawn iff the log fd opened).
    // Elsewhere — notably a --json-strict CLI that must emit JSON-RPC on stderr only
    // — stay silent so we never pollute the stream.
    if (process.env.ACPX_OWNER_LOG !== "1") {
      return;
    }
    try {
      process.stderr.write(`[acpx] ${message}\n`);
    } catch {
      // best effort
    }
  }

  private captureStartupStderr(target: string[], chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length === 0) {
      return;
    }
    target.push(text);
    const overflow = target.join("").length - STARTUP_STDERR_MAX_CHARS;
    if (overflow <= 0) {
      return;
    }
    const joined = target.join("");
    target.splice(0, target.length, joined.slice(-STARTUP_STDERR_MAX_CHARS));
  }

  private summarizeStartupStderr(target: string[]): string | undefined {
    const joined = target.join("").trim();
    if (!joined) {
      return undefined;
    }
    const collapsed = joined.replace(/\s+/gu, " ").trim();
    return collapsed.slice(0, STARTUP_STDERR_MAX_CHARS);
  }

  private createStartupFailureWatcher(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
    startupStderr: string[],
  ): StartupFailureWatcher {
    let settled = false;
    let rejectPromise: (error: unknown) => void;

    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
    };

    const finish = (error?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        rejectPromise(error);
      }
    };

    const createError = (params?: {
      cause?: unknown;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    }) =>
      new AgentStartupError({
        agentCommand: this.options.agentCommand,
        exitCode: params?.exitCode ?? child.exitCode ?? null,
        signal: params?.signal ?? child.signalCode ?? null,
        stderrSummary: this.summarizeStartupStderr(startupStderr),
        cause: params?.cause,
      });

    const onError = (error: Error) => {
      finish(createError({ cause: error }));
    };

    const onExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      finish(createError({ exitCode, signal }));
    };

    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      finish(createError({ exitCode, signal }));
    };

    const promise = new Promise<never>((_resolve, reject) => {
      rejectPromise = reject;
      child.once("error", onError);
      child.once("exit", onExit);
      child.once("close", onClose);
    });

    return {
      promise,
      dispose: () => finish(),
    };
  }

  private async normalizeInitializeError(
    error: unknown,
    child: ChildProcessByStdio<Writable, Readable, Readable>,
    startupStderr: string[],
  ): Promise<unknown> {
    if (error instanceof AgentStartupError) {
      return error;
    }

    const connectionClosedDuringInitialize =
      error instanceof Error && /acp connection closed/i.test(error.message);
    await waitForChildExit(child, 100);
    const childExited = child.exitCode !== null || child.signalCode !== null;
    if (!connectionClosedDuringInitialize && !childExited) {
      return error;
    }

    return new AgentStartupError({
      agentCommand: this.options.agentCommand,
      exitCode: child.exitCode ?? null,
      signal: child.signalCode ?? null,
      stderrSummary: this.summarizeStartupStderr(startupStderr),
      cause: error,
    });
  }

  private selectAuthMethod(methods: AuthMethod[]): AuthSelection | undefined {
    for (const method of methods) {
      const envCredential = readEnvCredential(method.id);
      if (envCredential) {
        return {
          methodId: method.id,
          credential: envCredential,
          source: "env",
        };
      }

      const configCredential = resolveConfiguredAuthCredential(
        method.id,
        this.options.authCredentials,
      );
      if (typeof configCredential === "string" && configCredential.trim().length > 0) {
        return {
          methodId: method.id,
          credential: configCredential,
          source: "config",
        };
      }
    }

    return undefined;
  }

  private async authenticateIfRequired(
    connection: ClientSideConnection,
    methods: AuthMethod[],
  ): Promise<void> {
    if (methods.length === 0) {
      return;
    }

    const selected = this.selectAuthMethod(methods);
    if (!selected) {
      if (this.options.authPolicy === "fail") {
        throw new AuthPolicyError(
          `agent advertised auth methods [${methods.map((m) => m.id).join(", ")}] but no matching credentials found`,
        );
      }

      this.log(
        `agent advertised auth methods [${methods.map((m) => m.id).join(", ")}] but no matching credentials found — skipping (agent may handle auth internally)`,
      );
      return;
    }

    await connection.authenticate({
      methodId: selected.methodId,
    });

    this.log(`authenticated with method ${selected.methodId} (${selected.source})`);
  }

  private async handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (this.cancellingSessionIds.has(params.sessionId)) {
      return cancelledPermissionResponse();
    }

    const hostResponse = await this.tryHandlePermissionRequestWithHost(params);
    if (hostResponse) {
      return hostResponse;
    }

    const { response, recorded } = await this.resolvePermissionRequestFromMode(params);
    if (!recorded) {
      const decision = classifyPermissionDecision(params, response);
      this.recordPermissionDecision(decision);
    }

    return response;
  }

  private async tryHandlePermissionRequestWithHost(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse | undefined> {
    if (!this.options.onPermissionRequest) {
      return undefined;
    }
    const signal = this.cancellationSignalForSession(params.sessionId);
    try {
      const decision = await this.options.onPermissionRequest(
        {
          sessionId: params.sessionId,
          raw: params,
          inferredKind: inferToolKind(params),
        },
        { signal },
      );
      return this.hostPermissionDecisionResponse(params, signal, decision);
    } catch (error) {
      return this.hostPermissionErrorResponse(params, signal, error);
    }
  }

  private hostPermissionDecisionResponse(
    params: RequestPermissionRequest,
    signal: AbortSignal,
    decision: Parameters<typeof decisionToResponse>[1] | undefined,
  ): RequestPermissionResponse | undefined {
    if (signal.aborted || this.cancellingSessionIds.has(params.sessionId)) {
      this.recordPermissionDecision("cancelled");
      return cancelledPermissionResponse();
    }
    if (!decision) {
      return undefined;
    }
    const response = decisionToResponse(params, decision);
    this.recordPermissionDecision(classifyPermissionDecision(params, response));
    return response;
  }

  private hostPermissionErrorResponse(
    params: RequestPermissionRequest,
    signal: AbortSignal,
    error: unknown,
  ): RequestPermissionResponse | undefined {
    if (signal.aborted || this.cancellingSessionIds.has(params.sessionId)) {
      this.recordPermissionDecision("cancelled");
      return cancelledPermissionResponse();
    }
    // Fall through to the mode-based resolver so a host UI error
    // doesn't take down the turn.
    this.log(
      `onPermissionRequest threw, falling through to mode-based resolver: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }

  private async resolvePermissionRequestFromMode(
    params: RequestPermissionRequest,
  ): Promise<{ response: RequestPermissionResponse; recorded: boolean }> {
    try {
      const result = await resolvePermissionRequestWithDetails(
        params,
        this.options.permissionMode,
        this.options.nonInteractivePermissions ?? "deny",
        this.options.permissionPolicy,
      );
      this.emitPermissionEscalation(result.escalation);
      return { response: result.response, recorded: false };
    } catch (error) {
      return this.handleModePermissionError(params.sessionId, error);
    }
  }

  private emitPermissionEscalation(
    escalation: Parameters<NonNullable<AcpClientOptions["onPermissionEscalation"]>>[0] | undefined,
  ): void {
    if (escalation) {
      this.eventHandlers.onPermissionEscalation?.(escalation);
    }
  }

  private handleModePermissionError(
    sessionId: string,
    error: unknown,
  ): { response: RequestPermissionResponse; recorded: boolean } {
    if (!(error instanceof PermissionPromptUnavailableError)) {
      throw error;
    }
    this.notePromptPermissionFailure(sessionId, error);
    this.recordPermissionDecision("cancelled");
    return { response: cancelledPermissionResponse(), recorded: true };
  }

  private attachAgentLifecycleObservers(
    child: ChildProcessByStdio<Writable, Readable, Readable>,
  ): void {
    child.once("exit", (exitCode, signal) => {
      this.recordAgentExit("process_exit", exitCode, signal);
    });

    child.once("close", (exitCode, signal) => {
      this.recordAgentExit("process_close", exitCode, signal);
    });

    child.stdout.once("close", () => {
      this.recordAgentExit("pipe_close", child.exitCode ?? null, child.signalCode ?? null);
    });
  }

  private recordAgentExit(
    reason: AgentDisconnectReason,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.lastAgentExit) {
      this.enrichLastAgentExit(exitCode, signal);
      return;
    }

    const unexpectedDuringPrompt = !this.closing && Boolean(this.activePrompt);
    this.lastAgentExit = {
      exitCode,
      signal,
      exitedAt: isoNow(),
      reason,
      unexpectedDuringPrompt,
    };
    // (a) Always leave a disconnect line in the owner log (was /dev/null before) —
    // diagnostic even for a SILENT SIGKILL (a null code/signal renders as "null").
    this.logOwnerEvent(
      `agent disconnect: reason=${reason} code=${exitCode} signal=${signal} unexpectedDuringPrompt=${unexpectedDuringPrompt} pid=${this.lastKnownPid ?? "?"}`,
    );
    this.rejectPendingConnectionRequests(
      new AgentDisconnectedError(reason, exitCode, signal, {
        outputAlreadyEmitted: Boolean(this.activePrompt),
      }),
    );
  }

  // First-write-wins for the disconnect REASON, but enrich a missing code/signal
  // ONCE. The first observer is usually `connection_close`/`pipe_close` (stdout
  // EOF, before Node delivers the child `exit`) → null/null, so the record was the
  // non-diagnostic connection_close/null/null. A later `process_exit`/
  // `process_close` carries the REAL OS code/signal; fold it in (reason preserved)
  // so the record can tell e.g. a SIGKILL from a clean exit, and leave it in the
  // owner log. NOTE: in the queue-owner flow the death is often PERSISTED before
  // this enrich lands (see the awaited-exit settle on the persist path).
  private enrichLastAgentExit(exitCode: number | null, signal: NodeJS.Signals | null): void {
    const prev = this.lastAgentExit;
    if (!prev || prev.exitCode !== null || prev.signal !== null) {
      return;
    }
    if (exitCode === null && signal === null) {
      return;
    }
    this.lastAgentExit = { ...prev, exitCode, signal };
    this.logOwnerEvent(
      `agent exit observed: reason=${prev.reason} code=${exitCode} signal=${signal} unexpectedDuringPrompt=${prev.unexpectedDuringPrompt}`,
    );
  }

  private notePromptPermissionFailure(
    sessionId: string,
    error: PermissionPromptUnavailableError,
  ): void {
    if (!this.promptPermissionFailures.has(sessionId)) {
      this.promptPermissionFailures.set(sessionId, error);
    }
  }

  private consumePromptPermissionFailure(
    sessionId: string,
  ): PermissionPromptUnavailableError | undefined {
    const error = this.promptPermissionFailures.get(sessionId);
    if (error) {
      this.promptPermissionFailures.delete(sessionId);
    }
    return error;
  }

  private async runConnectionRequest<T>(run: () => Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const pending: PendingConnectionRequest = {
        settled: false,
        reject,
      };

      const finish = (cb: () => void) => {
        if (pending.settled) {
          return;
        }
        pending.settled = true;
        this.pendingConnectionRequests.delete(pending);
        cb();
      };

      this.pendingConnectionRequests.add(pending);
      void Promise.resolve()
        .then(run)
        .then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
    });
  }

  private rejectPendingConnectionRequests(error: unknown): void {
    for (const pending of this.pendingConnectionRequests) {
      if (pending.settled) {
        this.pendingConnectionRequests.delete(pending);
        continue;
      }
      pending.settled = true;
      this.pendingConnectionRequests.delete(pending);
      pending.reject(error);
    }
  }

  private async handleReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    try {
      return await this.filesystem.readTextFile(params);
    } catch (error) {
      this.recordPermissionError(params.sessionId, error);
      throw error;
    }
  }

  private async handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    try {
      return await this.filesystem.writeTextFile(params);
    } catch (error) {
      this.recordPermissionError(params.sessionId, error);
      throw error;
    }
  }

  private async handleCreateTerminal(
    params: CreateTerminalRequest,
  ): Promise<CreateTerminalResponse> {
    try {
      return await this.terminalManager.createTerminal(params);
    } catch (error) {
      this.recordPermissionError(params.sessionId, error);
      throw error;
    }
  }

  private async handleTerminalOutput(
    params: TerminalOutputRequest,
  ): Promise<TerminalOutputResponse> {
    return await this.terminalManager.terminalOutput(params);
  }

  private async handleWaitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    return await this.terminalManager.waitForTerminalExit(params);
  }

  private async handleKillTerminal(params: KillTerminalRequest): Promise<KillTerminalResponse> {
    return await this.terminalManager.killTerminal(params);
  }

  private async handleReleaseTerminal(
    params: ReleaseTerminalRequest,
  ): Promise<ReleaseTerminalResponse> {
    return await this.terminalManager.releaseTerminal(params);
  }

  private cancellationSignalForSession(sessionId: string): AbortSignal {
    let controller = this.permissionAbortControllers.get(sessionId);
    if (!controller) {
      controller = new AbortController();
      this.permissionAbortControllers.set(sessionId, controller);
    }
    return controller.signal;
  }

  private abortAndDropPermissionSignal(sessionId: string): void {
    const controller = this.permissionAbortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.permissionAbortControllers.delete(sessionId);
    }
  }

  private recordPermissionDecision(decision: "approved" | "denied" | "cancelled"): void {
    this.permissionStats.requested += 1;
    if (decision === "approved") {
      this.permissionStats.approved += 1;
      return;
    }
    if (decision === "denied") {
      this.permissionStats.denied += 1;
      return;
    }
    this.permissionStats.cancelled += 1;
  }

  private recordPermissionError(sessionId: string, error: unknown): void {
    if (error instanceof PermissionPromptUnavailableError) {
      this.notePromptPermissionFailure(sessionId, error);
      this.recordPermissionDecision("cancelled");
      return;
    }
    if (error instanceof PermissionDeniedError) {
      this.recordPermissionDecision("denied");
    }
  }

  private async handleSessionUpdate(notification: SessionNotification): Promise<void> {
    const sequence = ++this.observedSessionUpdates;
    this.sessionUpdateChain = this.sessionUpdateChain.then(async () => {
      try {
        if (!this.suppressSessionUpdates) {
          this.eventHandlers.onSessionUpdate?.(notification);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`session update handler failed: ${message}`);
      } finally {
        this.processedSessionUpdates = sequence;
      }
    });

    await this.sessionUpdateChain;
  }

  private async waitForSessionUpdateDrain(idleMs: number, timeoutMs: number): Promise<void> {
    const normalizedIdleMs = Math.max(0, idleMs);
    const normalizedTimeoutMs = Math.max(normalizedIdleMs, timeoutMs);
    const deadline = Date.now() + normalizedTimeoutMs;
    let lastObserved = this.observedSessionUpdates;
    let idleSince = Date.now();

    while (Date.now() <= deadline) {
      const observed = this.observedSessionUpdates;
      if (observed !== lastObserved) {
        lastObserved = observed;
        idleSince = Date.now();
      }

      if (
        this.processedSessionUpdates === this.observedSessionUpdates &&
        Date.now() - idleSince >= normalizedIdleMs
      ) {
        await this.sessionUpdateChain;
        if (this.processedSessionUpdates === this.observedSessionUpdates) {
          return;
        }
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, DRAIN_POLL_INTERVAL_MS);
      });
    }

    throw new Error(`Timed out waiting for session replay drain after ${normalizedTimeoutMs}ms`);
  }

  async waitForSessionUpdatesIdle(options?: {
    idleMs?: number;
    timeoutMs?: number;
  }): Promise<void> {
    await this.waitForSessionUpdateDrain(options?.idleMs ?? 0, options?.timeoutMs ?? 0);
  }
}
