import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  type NewSessionResponse,
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
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import { resolveBuiltInAgentLaunch } from "../agent-registry.js";
import { TimeoutError, withTimeout } from "../async-control.js";
import type { ProvisioningWarningBreadcrumb } from "../config/os-harness-provisioning.js";
import { applyBoxProviderEnv, formatBoxProviderEnvConflict } from "../config/providers.js";
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
import { ACTIVITY_NEUTRAL_EVENT_METHOD } from "../session/events.js";
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
import { enforcePermissionMode } from "../types.js";
import {
  buildClaudeAcpSessionCreateTimeoutMessage,
  buildClaudeCodeOptionsMeta,
  buildGeminiAcpStartupTimeoutMessage,
  buildPrimerSessionMeta,
  buildQoderAcpCommandArgs,
  composePrimerWithBrickContext,
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
  pointAdapterAtShim,
  startOpenRouterShimForSession,
  type AgentSessionContext,
  type EffectiveAccountMetadata,
} from "./auth-env.js";
import { resolveBrickContext } from "./brick-context.js";
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
import { extractAcpError, formatAcpErrorMessage } from "./error-shapes.js";
import {
  HARNESS_FACTS,
  harnessIdForAgentCommand,
  harnessProvisionsModelCatalogue,
} from "./harness-capabilities.js";
import {
  applyHarnessConfigDir,
  describePiExtensionSeedFailure,
  releaseHarnessConfigDir,
  reportHarnessConfigDir,
  type HarnessConfigDirPlan,
  type SeededPiExtension,
} from "./harness-config-dir.js";
import {
  avoidBidirectionalJsonRpcIdCollisions,
  isAcpMessageObject,
  isSessionUpdateNotification,
} from "./jsonrpc.js";
import {
  attachAttribution,
  type LastTurnProviderBreadcrumb,
  OpenRouterAttributionLog,
  piGenerationId,
  type TurnAttribution,
} from "./openrouter-attribution.js";
import { resolveTurnProvider } from "./openrouter-generation.js";
import type {
  RoutingPolicyWarning,
  RoutingPolicyWarningBreadcrumb,
} from "./openrouter-provider-policy.js";
import {
  openRouterBoxCredentialMissing,
  resolveOpenRouterBoxCredential,
  resolveOpenRouterRoute,
  type OpenRouterBoxCredential,
  type ProfileBypass,
} from "./openrouter-routing.js";
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
  /** Fix A (brick 92a994a0): the authoritative context-window size a prior run
   *  of this session learned, injected into the resume `_meta.claudeCode` so
   *  the restored adapter reports the correct window from its first
   *  post-resume usage_update instead of re-guessing 200k. */
  contextWindowSizeHint?: number;
  /** The model the hint was learned for. A resume can advertise one model and
   *  then replay the session's pinned model; tagging the restored window lets
   *  the adapter re-apply it (instead of the heuristic) when the model settles
   *  on this id, so the replay doesn't clobber a restored 1M back to 200k. */
  contextWindowSizeHintModel?: string;
};

type ResumeSessionOptions = {
  contextWindowSizeHint?: number;
  contextWindowSizeHintModel?: string;
};

function isPositiveFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

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
  /**
   * The ACP MODE advertisement. Additive (B3): Pi carries thinking depth on the
   * mode selector and advertises `configOptions: null` (I2 R8), so the mode
   * depth arm has nothing to project onto without it. Every other harness is
   * untouched — this field is simply the value the ACP response already carried
   * and acpx previously discarded.
   */
  modes?: SessionModeState;
};

export type SessionLoadResult = {
  agentSessionId?: string;
  configOptions?: SessionConfigOption[];
  models?: SessionModelState;
  /** See {@link SessionCreateResult.modes}. */
  modes?: SessionModeState;
};

export type SessionResumeResult = SessionLoadResult;

export type SessionForkResult = SessionLoadResult & {
  sessionId: string;
  // True when the Claude durable-fork id substitution ran: `sessionId` is then
  // the SDK-materialized durable transcript id, which the adapter has NOT
  // registered (only the random fork id from unstable_forkSession is). Callers
  // must not drive a config-op (e.g. set_model) on it at creation time — it
  // would fail to resolve; defer model application to the first open/resume.
  durableClaudeForkApplied?: boolean;
};

type ReconnectedSessionResponse = LoadSessionResponse | ResumeSessionResponse;

function toReconnectedSessionResult(
  response: ReconnectedSessionResponse | undefined,
): SessionLoadResult {
  return {
    agentSessionId: extractRuntimeSessionId(response?._meta),
    configOptions: response?.configOptions ?? undefined,
    models: response?.models ?? undefined,
    modes: response?.modes ?? undefined,
  };
}

function toCreateSessionResult(response: NewSessionResponse): SessionCreateResult {
  return {
    sessionId: response.sessionId,
    agentSessionId: extractRuntimeSessionId(response._meta),
    configOptions: response.configOptions ?? undefined,
    models: response.models ?? undefined,
    modes: response.modes ?? undefined,
  };
}

function toForkSessionResult(response: ForkSessionResponse): SessionForkResult {
  return {
    sessionId: response.sessionId,
    agentSessionId: extractRuntimeSessionId(response._meta),
    configOptions: response.configOptions ?? undefined,
    models: response.models ?? undefined,
    modes: response.modes ?? undefined,
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
  /**
   * The per-session harness config dir THIS spawn wrote (brick fa2e54ec).
   *
   * ⚠️ IT RIDES THE LIFECYCLE SNAPSHOT ON PURPOSE. The directory is per-SPAWN and
   * is rewritten at create AND at every resume, so a path recorded only at create
   * is STALE after the first resume — and it still EXISTS, so a reader resolves
   * the wrong directory instead of missing. That silent-wrong-answer is worse
   * than not finding it, and it is the same shape as the F-8 defect one level up.
   *
   * Every site that refreshes lifecycle state already runs at exactly the moments
   * the dir is rewritten, so carrying it here means a new spawn site cannot forget
   * it — as opposed to a hand-maintained list of call sites, which is the failure
   * mode that ate `depth_projection` in the clone allowlist.
   */
  harnessConfigDir?: string;
  /**
   * The BOX-store session directory THIS spawn handed pi (brick://cb214e48).
   *
   * Rides the lifecycle snapshot for the identical reason as the field above: it
   * is per-SPAWN, and every site that refreshes lifecycle state already runs at
   * exactly the moments it is rewritten — as opposed to a hand-maintained list of
   * call sites, which is the failure mode that ate `depth_projection`.
   */
  piSessionDir?: string;
  pid?: number;
  startedAt?: string;
  running: boolean;
  lastExit?: AgentExitInfo;
  provisioningWarning?: ProvisioningWarningBreadcrumb;
  /**
   * The box's OpenRouter routing settings file EXISTS and was REJECTED, so this
   * session runs with NO provider policy (brick 4c272cab / TE finding F-1).
   * Lands as `session_options.routing_policy_warning`, which is what lets the UI
   * say "policy file invalid" instead of showing a policy that is not in force.
   */
  routingPolicyWarning?: RoutingPolicyWarningBreadcrumb;
  /**
   * Who served this session's most recent OpenRouter turn (TE finding F-3).
   * Lands as `acpx.last_turn_provider`, the same field the usage_update path
   * writes — this is the leg that catches a line written after the last update.
   */
  lastTurnProvider?: LastTurnProviderBreadcrumb;
  /**
   * `true` once ANY turn of this session was served through the OpenRouter shim
   * (brick://a89c3cd4). Sticky in the client and sticky in the record: the write
   * leg only fires on a truthy value, so a post-teardown snapshot cannot reset
   * it. Lands as `session_options.served_via_shim`.
   */
  servedViaShim?: boolean;
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
    const message = parseAcpJsonMessageLine(trimmedLine);
    if (message) {
      controller.enqueue(message);
    }
  } catch (err) {
    console.error("Failed to parse JSON message:", trimmedLine, err);
  }
}

// Parse an NDJSON line and only surface object-shaped ACP frames. Non-object
// JSON values (primitives, arrays) from adapter stdout are dropped before
// dispatch so a stray diagnostic line can't crash the SDK message path.
// Intent adopted from upstream de042d1 (fix(acp): ignore non-object inbound frames).
export function parseAcpJsonMessageLine(line: string): AnyMessage | undefined {
  const message: unknown = JSON.parse(line);
  return isAcpMessageObject(message) ? message : undefined;
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

/**
 * The picker route's log line: the credential's ORIGIN, never its value, and the
 * profile whose credential is being bypassed.
 *
 * ⚠️ THE BYPASSED PROFILE IS NAMED ON PURPOSE. On the UI path a profile is ALWAYS
 * present — acpx-ui sends none and acpx applies the box default — so this route
 * routinely runs with a `[claude/subscription]` profile selected whose credential
 * it does not use, because that credential cannot serve an OpenRouter model.
 * Correct, but it must not be SILENT: an operator reading the log has to be able
 * to see that the profile they picked is not the thing paying.
 */
/** The picker route's three inputs off the session context. Split out only to keep
 *  `startPickerShim` under the complexity budget. */
/**
 * Blank-safe trim. **Exported because it is the guard BOTH shim routes now share**
 * — `??` does not catch `""`, and an empty `acpxRecordId` is the normal case at
 * create, which is how `/tmp/or-` (an unnamespaced, shared `CLAUDE_CONFIG_DIR`)
 * came to exist on this box.
 */
export function trimmedOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The id that namespaces a shim's `CLAUDE_CONFIG_DIR` (`/tmp/or-<id>`), for BOTH
 * routes — the legacy profile route passes the profile id as its fallback, the
 * picker route a fresh uuid.
 *
 * ⚠️ IT IS A NAMED FUNCTION, NOT AN INLINE EXPRESSION, SO A TEST CAN BIND THE
 * THING THE CALL SITE ACTUALLY USES. The first version of this fix asserted the
 * generic `trimmedOrUndefined` helper instead, and a mutation probe proved that
 * vacuous: reverting the legacy call site to `?? profileId` — the original defect
 * — left the whole test file GREEN, because the helper was still correct and the
 * test never touched the call site. True and unattached.
 *
 * ⚠️ STATED RESIDUAL: a mutation that stops CALLING this function altogether is
 * still not caught by a unit test — that needs a spawn. What is caught is every
 * mutation of the rule itself, which is where the `??`-does-not-catch-`""` defect
 * actually lived.
 */
export function shimConfigDirSessionId(
  ctx: AgentSessionContext | undefined,
  fallback: string,
): string {
  return trimmedOrUndefined(ctx?.acpxRecordId) ?? fallback;
}

function pickerShimContext(ctx: AgentSessionContext | undefined): {
  sessionId: string;
  effort: string | undefined;
} {
  return {
    sessionId: shimConfigDirSessionId(ctx, randomUUID()),
    effort: trimmedOrUndefined(ctx?.reasoningEffort),
  };
}

/**
 * The picker route's log line — and, when a profile was bypassed, WHY.
 *
 * ⚠️ THE REASON COMES FROM THE ROUTE, NEVER FROM A SECOND LOOK AT THE REGISTRY
 * (brick 069fdebe). `resolveOpenRouterRoute` is where the profile question is
 * actually answered; re-deriving it here would stand a second reading of the same
 * fact beside the decision, free to disagree with it — and the line would then
 * describe a check that did not happen, which is the failure it is meant to make
 * visible. This renders what the decision recorded, and nothing else. That is
 * also why the bypassed profile id no longer comes off the session context: one
 * fact, one origin.
 */
function describePickerRoute(
  routeModel: string,
  credential: OpenRouterBoxCredential,
  profileBypass: ProfileBypass | undefined,
): string {
  const base =
    `openrouter picker route: serving "${routeModel}" through the shim on the box credential ` +
    `(${credential.envName} from ${credential.origin})`;
  if (!profileBypass) {
    return base;
  }
  return `${base}; ${describeProfileBypass(profileBypass)}`;
}

/**
 * ⚠️ THE TWO UNEVALUABLE REASONS SAY "was NOT evaluated" IN WORDS. What an
 * operator needs afterwards is not *"the profile was not used"* — the line
 * already said that, identically, in all three cases — but whether the
 * second-OpenRouter-account guard actually RAN. These are the states where it
 * did not, and nothing downstream can recover the difference later.
 */
function describeProfileBypass(profileBypass: ProfileBypass): string {
  const unused = "its credential is NOT used for this session";
  if (profileBypass.reason === "not-an-openrouter-account") {
    return `profile "${profileBypass.profileId}" is not an OpenRouter account, so ${unused}`;
  }
  // The two unevaluable reasons share their wording on purpose: what an operator
  // must be able to tell apart is EVALUATED from NOT EVALUATED, and the cause
  // clause then says which of the two it was.
  const cause =
    profileBypass.reason === "registry-holds-no-profiles"
      ? "the profile registry holds no profiles at all (absent, empty or unreadable)"
      : "the profile registry could not be read";
  return (
    `profile "${profileBypass.profileId}" was NOT evaluated — ${cause}, so the ` +
    `second-OpenRouter-account guard did not run; ${unused}`
  );
}

export class AcpClient {
  private options: AcpClientOptions;
  private connection?: ClientSideConnection;
  private agent?: ChildProcessByStdio<Writable, Readable, Readable>;
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
  /**
   * ⚠️ **ASSIGN ONLY THROUGH {@link AcpClient.setShimHandle}** (brick://a89c3cd4).
   * Every assignment must also record that this session was shim-served, and
   * there is more than one shim-start site — the picker route and, far less
   * obviously, `applyProfileAuth` for an `openrouter`-authMode profile.
   * Recording at the call sites instead of at the assignment is how a
   * picker-only implementation gets written that looks complete:
   * `openRouterRouteModelId` below is exactly that, and its own comment says so.
   */
  private shimHandle?: ShimHandle;
  /**
   * STICKY: `true` from the first shim this client starts, and never reset. It
   * records what SERVED THE TURNS, not what is running now — so clearing
   * `shimHandle` at teardown must not clear this, because the consumer (the
   * cold-resume transcript gate) reads it precisely after teardown.
   * Surfaced via {@link AgentLifecycleSnapshot.servedViaShim} →
   * `session_options.served_via_shim`.
   */
  private servedViaShim = false;
  /**
   * A cursor over the running shim's attribution log (brick 4c272cab §8), or
   * undefined when this session is not shim-served. Created beside the handle,
   * in the one assignment path, so a third shim-start site inherits it.
   */
  private attributionLog?: OpenRouterAttributionLog;
  /**
   * The most recent attribution this client has SEEN, kept beside the cursor
   * (TE finding F-3). The cursor CONSUMES, so whichever reader takes a line must
   * not be the only one that can act on it: a `status` call would otherwise eat
   * the line and drop it on the floor. Every read refreshes this; the record
   * write reports from it.
   */
  private lastTurnAttribution?: TurnAttribution;
  /**
   * The OpenRouter slug the PICKER route's shim is serving, or undefined. Paired
   * with `shimHandle`'s lifetime: set when that shim starts, cleared when it
   * stops, so `outOfBandModelId` can never outlive the process that makes it true.
   */
  private openRouterRouteModelId?: string;
  private agentStartedAt?: string;
  private lastAgentExit?: AgentExitInfo;
  private lastKnownPid?: number;
  private latestProvisioningWarning?: ProvisioningWarningBreadcrumb;
  /**
   * The box settings file was rejected on THIS session's most recent spawn
   * (brick 4c272cab / TE F-1). Refreshed at every shim start, so repairing the
   * file and respawning stops re-writing the breadcrumb.
   */
  private latestRoutingPolicyWarning?: RoutingPolicyWarning;
  /**
   * The per-session harness config dir this client created, so `close()` can
   * remove it (brick 433f6bf8). Undefined for every harness that gets none.
   *
   * The dir is ALSO swept by `sessions prune` — close is not guaranteed to run
   * (owner death, pod eviction, `kill -9`; this programme saw two owner deaths in
   * one afternoon), so remove-on-close alone would still leak.
   */
  private harnessConfigDir?: string;
  /** The BOX-store session directory this spawn handed pi (brick://cb214e48).
   *  Reported through the lifecycle snapshot onto `acpx.pi_session_dir`. */
  private piSessionDir?: string;
  /** This client's claim on the shared config dir — released at close so the
   *  directory survives until the session's TERMINAL close (brick 4a6fdda0). */
  private harnessConfigHolderId?: string;
  /** The pi extensions this spawn copied in, source→target, so a `session/new`
   *  that names one can be traced back to the box file (brick 074a1bd9). */
  private seededPiExtensions?: SeededPiExtension[];
  /**
   * The most recent config-option advertisement this client has seen — from
   * `session/new`, `session/load`, `session/resume`, or a
   * `session/set_config_option` response.
   *
   * ⚠️ It exists so {@link setSessionModel} can DISPATCH without every caller
   * having to carry the advertisement to it. Four call sites reached the wire
   * directly (F-10), and asking each of them to thread an extra argument is the
   * hand-maintained-list failure mode that produced F-9 in the first place.
   */
  private latestConfigOptions?: SessionConfigOption[];
  /**
   * How many `config_option_update` NOTIFICATIONS this connection has seen.
   *
   * ⚠️ A COUNTER, not a flag, and that is the whole point: it lets
   * {@link setSessionModel} tell "the adapter re-advertised BECAUSE OF MY CALL"
   * from "a stale advertisement is sitting in `latestConfigOptions`". Reading
   * the field alone would hand back the `session/new` snapshot as if it were the
   * post-model re-read — the exact staleness this exists to end.
   */
  private configOptionUpdateCount = 0;
  /**
   * Set when this adapter answered `-32601 Method not found` for
   * `session/set_model` — a durable capability fact, not a transient failure.
   */
  private modelSetMethodUnsupported = false;
  private lastEffectiveAccountMetadata?: EffectiveAccountMetadata;
  /**
   * The environment THIS session's agent process was spawned with — the exact
   * `buildAgentSpawnOptions().env`, captured in `start()` after `applyProfileEnv`.
   * The OS primer is rendered against it (`buildPrimerSessionMeta`) so an
   * `if_env=` guard in agents.md sees the CHILD's environment, not the acpx
   * process's own (== the SPAWNER's). Deliberately the whole env object rather
   * than a copied subset: a var added to the child env, or a new guard added to
   * agents.md, then reaches the primer with no change here.
   */
  private agentSpawnEnv?: NodeJS.ProcessEnv;
  private readonly promptPermissionFailures = new Map<string, PermissionPromptUnavailableError>();
  private readonly pendingConnectionRequests = new Set<PendingConnectionRequest>();

  constructor(options: AcpClientOptions) {
    this.options = {
      ...options,
      cwd: asAbsoluteCwd(options.cwd),
      authPolicy: options.authPolicy ?? "skip",
      // ⚠️ THE POLICY SOURCE (brick a4369a7e). `this.options.permissionMode` is
      // written HERE and in `updateRuntimeOptions`, and nowhere else — so a
      // reducing mode is never STORED, and every read of the field yields the
      // enforced value: the filesystem and terminal surfaces constructed just
      // below, `refreshRuntimePermissionPolicy`'s fan-out, the permission
      // resolver, and any surface added later. See `enforcePermissionMode` in
      // src/types.ts for why this is a property rather than a list of consumers.
      permissionMode: enforcePermissionMode(options.permissionMode),
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
      harnessConfigDir: this.harnessConfigDir,
      piSessionDir: this.piSessionDir,
      // `undefined` rather than `false` when unset: the write leg is truthy-gated
      // (like provisioningWarning), so a literal `false` here would be
      // indistinguishable from "not shim-served" while still being a value acpx
      // never observed. Absent means "cannot say"; it must not become `false`.
      servedViaShim: this.servedViaShim ? true : undefined,
      // Stamped at read, not at spawn: `at` is when the record learned it, and
      // the warning object itself is re-derived on every spawn.
      routingPolicyWarning: this.latestRoutingPolicyWarning
        ? { ...this.latestRoutingPolicyWarning, at: new Date().toISOString() }
        : undefined,
      // TE F-3, the belt: this snapshot is built when the record is WRITTEN, i.e.
      // after the turn, so re-reading here catches a line that landed after the
      // last usage_update. Reported from the memo rather than from this read
      // alone, so a snapshot taken by anything else cannot consume it and lose it.
      lastTurnProvider: this.readLastTurnProvider(),
    };
  }

  /** The latest attribution, refreshed first, stamped when the record learns it. */
  private readLastTurnProvider(): LastTurnProviderBreadcrumb | undefined {
    this.refreshAttribution();
    return this.lastTurnAttribution
      ? { ...this.lastTurnAttribution, at: new Date().toISOString() }
      : undefined;
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
      // The second — and last — write of this field. Same enforcement as the
      // constructor; a live `updateRuntimeOptions` cannot reduce what a spawn
      // could not.
      this.options.permissionMode = enforcePermissionMode(options.permissionMode);
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
    this.agentSpawnEnv = launch.spawnOptions.env;
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
    // Box-scoped provider credentials (~/.acpx/providers.json) — adapter-agnostic,
    // and a strict fallback: it never overwrites a variable that is already set.
    // Deliberately BEFORE applyProfileEnv for predictable ordering; the two do not
    // collide (see applyBoxProviderEnv's contract — on Claude the key is inert).
    //
    // ⚠️ THE WARNING IS NOT DEDUPED, ON PURPOSE. It fires per spawn, per diverging
    // variable. A once-per-process warning is indistinguishable from a check that
    // stopped running — and the reader who needs it is looking at THIS spawn's
    // stderr, not at the first spawn of a long-lived queue owner (brick c788eca0).
    applyBoxProviderEnv(spawnOptions.env, {
      onConflict: (conflict) => {
        process.stderr.write(`[acpx] warning: ${formatBoxProviderEnvConflict(conflict)}\n`);
      },
    });
    await this.applyProfileEnv(spawnOptions.env);
    // B3: the per-session harness config dir — primer + model pin + catalogue
    // fragment, one directory (CONCEPTION §5.3). GATED PER HARNESS off the
    // descriptor's `primerChannel === "config-file"`, so only pi receives it and
    // claude / claude-pty / codex adapter environments are untouched. Applied
    // unconditionally here it would be a real behaviour change to three
    // harnesses this program requires to stay identical.
    //
    // ⚠️ This is the ADAPTER boundary, one level downstream of the rig shim's
    // capture — RS-01 cannot observe it in either direction. RS-13 is its evidence.
    await this.applyHarnessConfigDirEnv(spawnOptions.env);
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
   * Write the per-session harness config dir and point the adapter at it.
   *
   * The primer is resolved with the SPAWN env (not `process.env`) for the same
   * reason `resolveSessionPrimer` makes that argument required: the primer script
   * reads the session's own environment, and passing the wrong one silently
   * renders somebody else's context.
   *
   * ⚠️ Ordering: this runs AFTER `applyBoxProviderEnv` and `applyProfileEnv`, so
   * the primer script sees the fully-built child environment — including the
   * provider credential — exactly as the adapter will.
   *
   * ⚠️ THE BRICK BLOCK BELONGS HERE TOO, AND ITS ABSENCE IS SILENT (brick
   * 968519c3). This leg is the ONLY primer path pi has, so a block folded in on
   * the stream leg alone never reaches it. It shipped that
   * way: `ACPX_BRICK` was set in the adapter env and `agents.md` rendered in
   * full, so every surface that could have shown the gap looked healthy while
   * the primer TEXT carried no brick at all — leaving a brick-linked agent to
   * invent its own frame, which is indistinguishable from a read one in its
   * output. Composed through `composePrimerWithBrickContext`, the SAME function
   * the stream leg uses, so the two channels cannot drift.
   */
  private async applyHarnessConfigDirEnv(env: NodeJS.ProcessEnv): Promise<void> {
    if (!this.wantsHarnessConfigDir()) {
      return; // the gate, checked before any work is done
    }
    const plan = applyHarnessConfigDir({
      env,
      agentCommand: this.options.agentCommand,
      sessionId: this.resolveConfigDirId(),
      cwd: this.options.cwd,
      primer: composePrimerWithBrickContext(
        await resolveSessionPrimer(env),
        await this.resolveBrickContext(),
      ),
      model: this.options.sessionOptions?.model,
      // ⚠️ PROVISIONING IS ON FOR PI, AND THAT `on` IS ITS OWN MEASUREMENT — NOT
      // AN ANSWER GENERALISABLE TO THE NEXT HARNESS.
      //
      // pi (brick ef5999ca): `models-store.json` merges BY ID with pi's catalogue
      // — same id replaces, new id appends — and `writePiModelsStore` copies the
      // box's own catalogue forward before upserting, so a slug pi already knows
      // keeps its real metadata rather than being overwritten with guesses.
      //
      // A second harness means a different config format and a separate question;
      // answering pi's does not answer it — which is why the list below is keyed
      // by HARNESS and not by `arbitraryModelSupport`.
      //
      // ⚠️ THIS ASKS THE CONSTANT, NOT A LITERAL — DO NOT "SIMPLIFY" IT BACK TO
      // `=== "pi"` (brick cba6fa92). It shipped as that literal, and the effect
      // was that the two halves of "pi is provisioned" could disagree: the
      // DECLARED list (`ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR`, which the
      // picker's arbitrary-slug band derives from) was pinned, while the SHIPPED
      // routing here was not reached by any test — so adding a harness to the
      // list changed what acpx OFFERS and nothing about what it WRITES. The
      // guard therefore belongs where the value is written; the array's own
      // comment carries it, and this call is what makes that true.
      ...(harnessProvisionsModelCatalogue(harnessIdForAgentCommand(this.options.agentCommand))
        ? { provisionModelId: this.options.sessionOptions?.model }
        : {}),
    });
    this.adoptHarnessConfigDirPlan(plan);
    reportHarnessConfigDir(plan, this.options.verbose);
  }

  /**
   * Take this spawn's per-spawn config-dir state off the plan, in ONE place.
   *
   * Extracted from {@link applyHarnessConfigDirEnv} because every field here is an
   * optional read, so each one costs a branch against that method's complexity
   * budget — adding the fourth broke the build. Keeping the set together also
   * means a future field lands beside its siblings instead of somewhere the next
   * spawn path forgets to copy it.
   */
  private adoptHarnessConfigDirPlan(plan: HarnessConfigDirPlan | undefined): void {
    this.harnessConfigDir = plan?.dir;
    this.piSessionDir = plan?.sessionDir;
    this.harnessConfigHolderId = plan?.holderId;
    this.seededPiExtensions = plan?.piExtensions;
  }

  /**
   * The identity that namespaces this spawn's config dir (F-8, brick 161294ce).
   *
   * ⚠️ THERE IS NO CONSTANT FALLBACK, DELIBERATELY. This shipped as
   * `acpxRecordId?.trim() || "session"`, and on the real `sessions new` path the
   * record id is EMPTY at adapter-spawn time — `creationSessionContext` sets
   * `acpxRecordId: ""` and says why: the CLI record id IS the adapter's own
   * `session/new` id (`session-management.ts:163,207`), so it cannot exist before
   * the spawn that produces it. The literal therefore fired on EVERY create, and
   * two distinct sessions shared one `/tmp/acpx-<harness>-session`.
   *
   * ⚠️ PER-SPAWN UNIQUENESS IS THE CORRECT GRANULARITY, not a workaround for the
   * missing id. The config dir is read by exactly ONE adapter PROCESS for that
   * process's lifetime; a resumed session is a NEW process whose dir is written
   * fresh before it starts. So each spawn reads the dir written for it, which is
   * what the measured create-dir != resume-dir failure was really about.
   *
   * The record id is preferred when present purely so repeated spawns of the same
   * session reuse one directory instead of accumulating one per resume.
   */
  /**
   * The config dir this spawn wrote, so the record can carry it to acpx-ui.
   * Undefined for every harness that gets none.
   */
  get harnessConfigDirPath(): string | undefined {
    return this.harnessConfigDir;
  }

  /**
   * Whether this adapter has proven it does not implement `session/set_model`.
   * The caller persists it so the next process does not have to fail to find out.
   */
  get modelSetMethodIsUnsupported(): boolean {
    return this.modelSetMethodUnsupported;
  }

  /**
   * LEARN the capability from a failed `session/set_model` (F-12). A
   * `-32601 Method not found` says the adapter has no such handler — it will not
   * become true later for the same binary, so it is recorded rather than retried.
   * Extracted so `setSessionModel` stays inside the complexity budget.
   */
  private learnModelSetCapabilityFrom(error: unknown): void {
    if (extractAcpError(error)?.code === -32601) {
      this.modelSetMethodUnsupported = true;
    }
  }

  private resolveConfigDirId(): string {
    return this.options.sessionContext?.acpxRecordId?.trim() || randomUUID();
  }

  /**
   * THE PER-HARNESS GATE, asked BEFORE any work is done — notably before
   * `resolveSessionPrimer`, which spawns a process. Rendering a primer for an
   * agent that will never be handed one is wasted work on every claude and codex
   * spawn, and `applyHarnessConfigDir` re-checks the same cell anyway.
   */
  private wantsHarnessConfigDir(): boolean {
    const harness = harnessIdForAgentCommand(this.options.agentCommand);
    return harness !== undefined && HARNESS_FACTS[harness].primerChannel === "config-file";
  }

  /**
   * Apply the async portion of OpenRouter auth to the spawn env in place.
   *
   * TWO ROUTES, AND THE MODEL CHOOSES (brick 007eaac8 — Daniel's founding item 6):
   *
   *   - a session carrying an openrouter PROFILE takes the LEGACY route: the
   *     profile's model on the profile's own account, byte for byte as before;
   *   - a session whose picked MODEL is an OpenRouter slug takes the PICKER route:
   *     that slug, on the BOX key in `~/.acpx/providers.json`, with no profile
   *     involved at all — which is what makes "any OpenRouter model" true for
   *     claude without pre-registering one profile per model;
   *   - naming BOTH is refused loudly, because they are two accounts with two
   *     budgets and there is no defensible silent winner.
   *
   * For subscription / neither: no-op. On a RECONNECT (`shimHandle` already set)
   * both routes reinject the running shim's port identically — the shim process,
   * and therefore the served model, survives the reconnect.
   */
  private async applyProfileEnv(env: NodeJS.ProcessEnv): Promise<void> {
    if (this.shimHandle) {
      this.reinjectRunningShim(env);
      return;
    }
    // ⚠️ THE DECISION IS `resolveOpenRouterRoute`'s, NOT THIS METHOD'S — it is a
    // pure function precisely so the ORDER the three questions are asked in can
    // be tested without spawning an adapter. This method only EXECUTES the answer.
    const route = await resolveOpenRouterRoute({
      agentCommand: this.options.agentCommand,
      model: this.options.sessionOptions?.model,
      profileId: this.options.sessionContext?.profileId,
    });
    if (route.kind === "profile") {
      await this.startProfileShim(env, route.profileId);
      return;
    }
    if (route.kind === "picker") {
      await this.startPickerShim(env, route.model, route.profileBypass);
    }
  }

  /**
   * Reconnect: point the adapter back at the shim process that is still running.
   *
   * ⚠️ THROUGH `pointAdapterAtShim`, NOT A SECOND COPY OF THE THREE LINES. This
   * method used to carry its own `ANTHROPIC_AUTH_TOKEN = " "`, so the blank-token
   * defect had TWO homes and repairing the spawn one alone would have left every
   * RESUMED OpenRouter session — legacy profile and picker route alike — still
   * refusing locally with `Not logged in`, while a fresh create looked fixed.
   */
  private reinjectRunningShim(env: NodeJS.ProcessEnv): void {
    if (!this.shimHandle) {
      return;
    }
    pointAdapterAtShim(env, this.shimHandle.port);
  }

  /**
   * The PICKER route: the shim serves the picked OpenRouter slug on the BOX key.
   *
   * ⚠️ THE MODEL IS RECORDED AS SERVED OUT OF BAND (`openRouterRouteModelId`), and
   * that is half the routing, not bookkeeping. `session_options.model` now holds
   * an OpenRouter slug that claude-agent-acp does not advertise; without the
   * suppression that flag drives, `applyRequestedModelIfAdvertised` would push
   * the slug through `session/set_model` and `assertRequestedModelSupported`
   * would throw — so wiring the shim alone would make EVERY picker-route create
   * fail. Declaration, shim and suppression are one change for that reason.
   */
  private async startPickerShim(
    env: NodeJS.ProcessEnv,
    routeModel: string,
    profileBypass: ProfileBypass | undefined,
  ): Promise<void> {
    const credential = resolveOpenRouterBoxCredential();
    if (!credential) {
      throw openRouterBoxCredentialMissing(routeModel);
    }
    const ctx = pickerShimContext(this.options.sessionContext);
    this.setShimHandle(
      await startOpenRouterShimForSession(
        env,
        ctx.sessionId,
        credential.key,
        routeModel,
        ctx.effort,
      ),
    );
    this.openRouterRouteModelId = routeModel;
    this.log(describePickerRoute(routeModel, credential, profileBypass));
  }

  /**
   * The model this session is served by OUT OF BAND — the OpenRouter slug the
   * shim rewrites every outbound request to — or `undefined` when acpx is not
   * serving this session's model that way.
   *
   * ⚠️ SET ONLY FOR THE PICKER ROUTE, DELIBERATELY. The legacy profile route also
   * serves its model out of band, and today a `--model` on such a session is
   * silently ignored by the shim — a real wart, filed separately (2026-09-06).
   * Widening this flag to cover it would change behaviour on a path this brick is
   * required to leave byte-identical, so it is reported rather than fixed here.
   */
  get outOfBandModelId(): string | undefined {
    return this.openRouterRouteModelId;
  }

  /** First-spawn path: create the OR shim and inject its port into the env. */
  private async startProfileShim(env: NodeJS.ProcessEnv, profileId: string): Promise<void> {
    const ctx = this.options.sessionContext;
    // ⚠️ `trimmedOrUndefined`, NOT `??` — AN EMPTY RECORD ID IS THE NORMAL CASE
    // HERE, AND `??` DOES NOT CATCH IT. `creationSessionContext` sets
    // `acpxRecordId: ""` on the real `sessions new` path (the CLI record id IS the
    // adapter's own `session/new` id, so it cannot exist before the spawn that
    // produces it). `??` falls back only on null/undefined, so `""` flowed
    // through to `join(tmpdir(), "or-" + "")` = **`/tmp/or-`** — one
    // `CLAUDE_CONFIG_DIR` shared by every blank-id session, which is exactly the
    // per-session isolation this directory exists to provide.
    //
    // Reachable on today's build, not an old artefact: `/tmp/or-` exists on this
    // box carrying `firstStartVersion: "2.1.257"` and a `firstStartTime` 340 ms
    // BEFORE the record it belongs to, with a `sessions/` mtime hours later —
    // consistent with reuse by a second blank-id invocation (found by
    // hp-pi-secondturn, brick b9d9d48b).
    //
    // The picker route already guarded this (`pickerShimContext`); the legacy
    // route did not. Same guard, both routes — the third instance today of one
    // route being fixed and its twin left behind.
    //
    // ⚠️ RESIDUAL, deliberately not changed here: the fallback is still
    // `profileId`, so two sessions on the SAME profile still share a directory.
    // That is pre-existing legacy-route behaviour and changing it would alter a
    // path this branch is required to leave otherwise untouched; the picker route
    // uses `randomUUID()` for genuine per-spawn uniqueness.
    const sessionId = shimConfigDirSessionId(ctx, profileId);
    const reasoningEffort = ctx?.reasoningEffort ?? null;
    this.setShimHandle(
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
      )) ?? undefined,
    );
  }

  /**
   * THE ONLY assignment path for {@link shimHandle} (brick://a89c3cd4).
   *
   * A shim can be started from two places — the picker route and
   * `applyProfileAuth` for an `openrouter`-authMode profile — and a fix that
   * recorded the fact at the sites rather than here would look complete while
   * missing one. That is not hypothetical: `outOfBandModelId`'s own comment
   * records the identical asymmetry (*"SET ONLY FOR THE PICKER ROUTE,
   * DELIBERATELY. The legacy profile route also serves its model out of band"*),
   * filed 2026-09-06 and still open. Routing every assignment through here makes
   * a third shim-start site inherit the fact instead of forgetting it.
   *
   * ⚠️ The recorded fact is STICKY and this is deliberate: a handle of
   * `undefined` (teardown, idle reap) clears the live handle and leaves
   * `servedViaShim` alone. The consumer reads it AFTER teardown, so clearing it
   * there would report `false` at exactly the moment the truth is needed.
   *
   * ⚠️ `ACPX_EFFECTIVE_AUTH_MODE` is not a substitute — it is absent on the
   * picker route (measured).
   */
  private setShimHandle(handle: ShimHandle | undefined): void {
    this.shimHandle = handle;
    if (handle !== undefined) {
      this.servedViaShim = true;
      // ⚠️ NOT sticky, unlike `servedViaShim`: the cursor belongs to THIS shim's
      // log. A new shim (respawn, reconnect after teardown) starts a new file,
      // and carrying the old cursor's offset into it would skip its first
      // responses — attribution would then be silently missing for exactly the
      // turns after a restart.
      this.attributionLog = handle.attributionLogPath
        ? new OpenRouterAttributionLog(handle.attributionLogPath)
        : undefined;
      // Same single-assignment-path argument as `servedViaShim` above: a third
      // shim-start site inherits this instead of forgetting it.
      this.latestRoutingPolicyWarning = handle.routingPolicyWarning;
    }
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
        // Generic ext-notification sink. The SDK's `Client.extNotification` is
        // optional; with no handler the SDK answers every `_claude/*` ext
        // notification (e.g. `_claude/sessionStatus`, `_claude/sdkMessage`) with
        // `-32601 Method not found` + log noise. Accept all silently — these
        // markers are already tapped into the stream via the wire-message path
        // and treated activity-neutral, so nothing here needs to react.
        extNotification: async (method: string, _params: Record<string, unknown>) => {
          if (method === ACTIVITY_NEUTRAL_EVENT_METHOD) {
            // Seam for future phase surfacing (DEFERRED to the separate feature
            // task `surface-turn-phase-indicator`): params.phase carries the
            // turn_no_activity / compaction / long-turn marker. Intentionally
            // NOT wired through here — recognising the method is enough to keep
            // this a clean extension point.
          }
          // All other ext notifications: accept and ignore.
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
      throw this.explainPiExtensionSeedFailure(error);
    }

    this.loadedSessionId = result.sessionId;

    const created = toCreateSessionResult(result);
    this.rememberConfigOptions(created.configOptions);
    return created;
  }

  /**
   * A `session/new` failure that names a pi extension acpx seeded gets the one
   * thing the adapter cannot know: that acpx put that file there, which box file
   * it came from, and the switch that stops it (brick 074a1bd9).
   *
   * ⚠️ WRAPPED WITH `cause`, NOT REPLACED. `extractAcpError` walks `error` / `acp`
   * / `cause`, so every downstream classification — the ACP code, `data.details`,
   * resource-not-found and auth detection — still resolves through the wrapper.
   * Building a fresh error WITHOUT the cause link would strip the payload and turn
   * a diagnosis into a regression.
   *
   * Anything not naming a seeded extension is returned UNTOUCHED: this must be
   * invisible on every other failure.
   */
  private explainPiExtensionSeedFailure(error: unknown): unknown {
    const base = formatAcpErrorMessage(error);
    const hint = describePiExtensionSeedFailure(base, this.seededPiExtensions);
    if (!hint) {
      return error;
    }
    return new Error(`${base}\n\n[acpx] ${hint}`, { cause: error });
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
    if (
      channel === "system-prompt" &&
      typeof optionsMeta?.systemPrompt === "string" &&
      optionsMeta.systemPrompt.length > 0
    ) {
      return undefined;
    }
    const primer = await this.resolvePrimerForSpawnEnv();
    const brickContext = await this.resolveBrickContext();
    return buildPrimerSessionMeta(channel, primer, optionsMeta?.systemPrompt, brickContext);
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
    const optionsMeta = buildClaudeCodeOptionsMeta(this.options.sessionOptions);
    if (typeof optionsMeta?.systemPrompt === "string" && optionsMeta.systemPrompt.length > 0) {
      return undefined;
    }
    const primer = await this.resolvePrimerForSpawnEnv();
    const brickContext = await this.resolveBrickContext();
    return buildPrimerSessionMeta(channel, primer, optionsMeta?.systemPrompt, brickContext);
  }

  /**
   * Render the OS primer in THIS session's agent environment. Unreachable with
   * `agentSpawnEnv` unset in production — every session op goes through
   * `getConnection()`, which throws unless `start()` (the only writer of that
   * field) has run — so the miss is REPORTED, never repaired by falling back to
   * acpx's own env. That fallback is exactly the defect this plumbing fixes, and
   * its failure mode is silent by construction: the agent is simply never told.
   * Skipping the primer instead leaves a warning behind and keeps session
   * creation fail-open, same as any other primer failure.
   */
  private async resolvePrimerForSpawnEnv(): Promise<string | undefined> {
    if (!this.agentSpawnEnv) {
      process.stderr.write(
        "[acpx] session primer skipped: agent spawn environment unavailable (agent not started); continuing unprimed\n",
      );
      return undefined;
    }
    return await resolveSessionPrimer(this.agentSpawnEnv);
  }

  private async resolveBrickContext(): Promise<string | undefined> {
    const brick = this.options.sessionContext?.brick?.trim();
    if (!brick) {
      return undefined;
    }
    // Render the brick block from the child's OWN id, not the queue-owner's ambient
    // $ACPX_SESSION_URL (the spawner's). Omitting the flag when we have no own id (the
    // transient creation spawn, acpxRecordId="") falls back to env — harmless, serves no turn.
    const sessionId = this.options.sessionContext?.acpxRecordId?.trim() || undefined;
    return await resolveBrickContext(brick, { sessionId });
  }

  private buildHomeSelectorMeta(): Record<string, unknown> | undefined {
    return buildClaudeHomeSelectorMeta(this.options.sessionContext?.profileId);
  }

  /**
   * Fix A (brick 92a994a0): fold an authoritative context-window hint into a
   * resume `_meta` fragment as `claudeCode.contextWindowSizeHint`, so the
   * restored adapter seeds the correct window instead of re-guessing. Deep-
   * merges into any existing `claudeCode` object (rather than clobbering it)
   * and is a no-op for a missing / non-positive hint.
   */
  /**
   * brick://874fee67 — fold the session's output style into a RESUME/LOAD `_meta`
   * fragment as `claudeCode.outputStyle`, deep-merging into any existing
   * `claudeCode` object rather than clobbering it (same shape as the
   * context-window hint below).
   *
   * This is what makes a live style change real. A resume rebuilds the system
   * prompt with the new style WHILE PRESERVING THE CONVERSATION (measured, with
   * a negative control: a resume without the style has no stylistic effect, so
   * the effect comes from the style and not from the resume). Omit it here and a
   * recycled owner faithfully resumes with the OLD style, which reads as "the
   * change did nothing".
   */
  private mergeOutputStyleMeta(
    meta: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    const outputStyle = this.options.sessionOptions?.outputStyle;
    if (typeof outputStyle !== "string" || outputStyle.trim().length === 0) {
      return meta;
    }
    const base = meta ?? {};
    const existingClaudeCode =
      typeof base.claudeCode === "object" && base.claudeCode !== null
        ? (base.claudeCode as Record<string, unknown>)
        : {};
    return {
      ...base,
      claudeCode: { ...existingClaudeCode, outputStyle },
    };
  }

  private mergeContextWindowHint(
    meta: Record<string, unknown> | undefined,
    hint: number | undefined,
    hintModel: string | undefined,
  ): Record<string, unknown> | undefined {
    if (!isPositiveFiniteNumber(hint)) {
      return meta;
    }
    const base = meta ?? {};
    const existingClaudeCode =
      typeof base.claudeCode === "object" && base.claudeCode !== null
        ? (base.claudeCode as Record<string, unknown>)
        : {};
    const modelField =
      typeof hintModel === "string" && hintModel.length > 0
        ? { contextWindowSizeHintModel: hintModel }
        : {};
    return {
      ...base,
      claudeCode: { ...existingClaudeCode, contextWindowSizeHint: hint, ...modelField },
    };
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
      const loadMeta =
        this.mergeOutputStyleMeta(
          this.mergeContextWindowHint(
            { ...homeSelectorMeta, ...primerMeta },
            options.contextWindowSizeHint,
            options.contextWindowSizeHintModel,
          ),
        ) ?? {};
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

  async resumeSession(
    sessionId: string,
    cwd = this.options.cwd,
    options: ResumeSessionOptions = {},
  ): Promise<SessionResumeResult> {
    const connection = this.getConnection();
    const sessionCwd = await resolveAgentSessionCwd(cwd, this.options.agentCommand);
    // Re-supply the primer on cold resume for the system-prompt channels
    // (CONCEPTION §4.5.2): a regenerated system prompt is dropped on rebuild
    // unless re-sent. Idempotent; codex returns undefined (restored from thread).
    const primerMeta = await this.buildResumePrimerMeta();
    const resumeMeta = this.mergeOutputStyleMeta(
      this.mergeContextWindowHint(
        primerMeta,
        options.contextWindowSizeHint,
        options.contextWindowSizeHintModel,
      ),
    );
    const response = await this.runConnectionRequest(() =>
      connection.resumeSession({
        sessionId,
        cwd: sessionCwd,
        mcpServers: this.options.mcpServers ?? [],
        ...(resumeMeta && Object.keys(resumeMeta).length > 0 ? { _meta: resumeMeta } : {}),
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
    result.durableClaudeForkApplied = true;
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
        // brick://4d6cb66d — atIndex is a WINDOW index into the record's capped
        // runtime message list; hand the window length down so the transcript
        // resolver can remap it onto the transcript tail instead of counting
        // from the session start (long sessions cut ~5x too early otherwise).
        recordMessageTotal: sourceMessages?.length,
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
      const response = await this.runConnectionRequest(() =>
        connection.setSessionConfigOption({
          sessionId,
          configId,
          value,
        }),
      );
      this.rememberConfigOptions(response.configOptions ?? undefined);
      return response;
    } catch (error) {
      throw maybeWrapSessionControlError(
        "session/set_config_option",
        error,
        `for "${configId}"="${value}"`,
      );
    }
  }

  /**
   * Set the session's model.
   *
   * ⚠️ THIS IS THE ONE BOUNDARY THAT TURNS "set the model" INTO A WIRE CALL, AND
   * IT MUST STAY THAT WAY (F-10). F-9 routed the create, replay and prompt-time
   * paths and left FOUR call sites reaching this method directly — the CLI verb's
   * live-owner path among them — so a mechanism the callers had to know about was
   * a hand-maintained list, and a hand-maintained list survives its own violation.
   * Any future per-mechanism dispatch belongs HERE, never re-inlined into callers.
   */
  async setSessionModel(
    sessionId: string,
    modelId: string,
  ): Promise<{ refreshedConfigOptions?: SessionConfigOption[] }> {
    const connection = this.getConnection();
    const updatesBefore = this.configOptionUpdateCount;
    try {
      await this.runConnectionRequest(() =>
        connection.unstable_setSessionModel({
          sessionId,
          modelId,
        }),
      );
      // The adapter answered — whatever it did before, it implements the method
      // NOW. Learning must run in BOTH directions or a restored capability stays
      // invisible (see setModelSetMethodUnsupported).
      this.modelSetMethodUnsupported = false;
      // ⚠️ ONLY WHEN THE COUNTER MOVED. An adapter that re-advertises nothing
      // must yield `undefined` — meaning "this mechanism had nothing to re-read",
      // which `advertisedAfterModelApply` translates into keeping the `session/new`
      // snapshot. Returning `latestConfigOptions` unconditionally would relabel
      // that snapshot as a post-model re-read on every adapter that does not push.
      return this.configOptionUpdateCount > updatesBefore
        ? { refreshedConfigOptions: this.latestConfigOptions }
        : {};
    } catch (error) {
      // ⚠️ LEARN THE CAPABILITY (F-12). `-32601 Method not found` says the adapter
      // has no such handler — it will not become true later for the same binary,
      // so it is recorded rather than retried. This is what lets a harness whose
      // DECLARED mechanism its deployed adapter does not implement correct itself
      // without anyone editing a table or citing a version.
      this.learnModelSetCapabilityFrom(error);
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

  /**
   * Record an advertisement so {@link setSessionModel} can dispatch on it.
   * An EMPTY or absent list is ignored rather than stored: an adapter that
   * answers without options has not told us it has none, and forgetting a good
   * advertisement would turn a routable set into a spurious refusal.
   */
  private rememberConfigOptions(options: SessionConfigOption[] | undefined): void {
    if (options && options.length > 0) {
      this.latestConfigOptions = options;
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

    // Remove this spawn's harness config dir (brick 433f6bf8). Best-effort and
    // deliberately BEFORE the agent teardown below, which can throw — a leaked
    // directory must not depend on a clean shutdown of the adapter.
    //
    // ⚠️ THIS ALONE IS NOT THE FIX. Close is not guaranteed to run at all —
    // owner death, pod eviction, `kill -9` — so `sessions prune` also sweeps
    // orphans. Remove-on-close is the fast path, not the guarantee.
    //
    // ⚠️ AND IT RELEASES A CLAIM RATHER THAN DELETING (brick 4a6fdda0). Two
    // clients of one session compute the SAME directory — `resolveConfigDirId()`
    // returns the record id when present, so repeated spawns reuse one directory
    // — and an unconditional `rmSync` here deleted the primer and model pin out
    // from under the client still serving a turn. The directory goes only on the
    // session's TERMINAL close.
    releaseHarnessConfigDir(this.harnessConfigDir, this.harnessConfigHolderId);
    this.harnessConfigDir = undefined;
    this.piSessionDir = undefined;
    this.harnessConfigHolderId = undefined;

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
    // Through the setter like every other assignment — and note it deliberately
    // does NOT clear `servedViaShim`: the turns this shim served stay served.
    this.setShimHandle(undefined);
    this.openRouterRouteModelId = undefined;
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
    // ⚠️ READ THE ADVERTISEMENT OFF THE NOTIFICATION, SYNCHRONOUSLY, BEFORE THE
    // QUEUE. `session/set_model` returns `{}` — the re-advertisement arrives as a
    // PUSHED `config_option_update` written to the same stream just ahead of that
    // response, so it is already parsed by the time `setSessionModel` resolves.
    // Deferring it onto `sessionUpdateChain` (which the handler below awaits, but
    // whose body runs in a later microtask) would make the capture race the very
    // return that consumes it.
    // ⚠️ OPTIONAL CHAIN, NOT COSMETIC. This is the single sink for EVERY
    // notification, and a throw here escapes into the connection's read loop
    // rather than into any caller. `update` is required by the schema and absent
    // in practice only from a malformed frame — which is exactly when refusing to
    // dereference matters. (Caught by `client.test.ts`, which sends one.)
    if (notification.update?.sessionUpdate === "config_option_update") {
      this.configOptionUpdateCount += 1;
      this.rememberConfigOptions(notification.update.configOptions ?? undefined);
    }
    if (notification.update?.sessionUpdate === "usage_update") {
      this.decorateWithAttribution(notification.update);
    }
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

  /**
   * Attach WHO SERVED the message this usage update reports (brick 4c272cab §8).
   *
   * Done HERE because this class owns the shim handle, and therefore the one log
   * that belongs to this session — the conversation model, which persists the
   * unit, has neither a session id nor a path and would otherwise need a
   * process-wide pointer that could cross-attribute two sessions in one process.
   *
   * ⚠️ ONE READ PER USAGE UPDATE, AND IT CONSUMES. `takeLatest` returns only
   * responses not yet handed out, so a usage update with no new response leaves
   * the block absent — which the ingest records as `null`. Re-reading the tail
   * instead would attribute a STALE response to it: a wrong answer indis-
   * tinguishable from a right one.
   */
  private decorateWithAttribution(update: SessionNotification["update"]): void {
    const attribution = this.turnAttributionFor(update);
    if (!attribution) {
      return;
    }
    attachAttribution(update, attribution);
    this.scheduleAttributionResolve(attribution);
  }

  /**
   * The attribution for this usage update, from whichever harness path can
   * observe one (brick 77054e85).
   *
   * ⚠️ **THE SHIM LOG WINS, AND THE ORDER IS NOT ARBITRARY.** Its `provider_name`
   * is read off the response itself — the answer, already in hand — while pi's
   * `responseId` is only a handle that costs a round trip and up to ~21 s to turn
   * into one. Asking pi first would pay for a lookup on a path that already knows.
   *
   * ⚠️ AND `refreshAttribution()` CONSUMES, SO IT MUST STAY ON EVERY USAGE
   * UPDATE, NOT BEHIND THE pi CHECK. It advances the log cursor; skipping a call
   * would leave an unconsumed line to be handed to a LATER update that it does
   * not describe.
   */
  private turnAttributionFor(update: SessionNotification["update"]): TurnAttribution | undefined {
    const fromShim = this.refreshAttribution();
    if (fromShim) {
      return fromShim;
    }
    const responseId = piGenerationId(update);
    return responseId
      ? { provider_name: null, native_finish_reason: null, response_id: responseId }
      : undefined;
  }

  /**
   * Start the lazy `/api/v1/generation` lookup, off the turn path.
   *
   * 🛑 **DELIBERATELY NOT AWAITED.** The lookup runs for up to ~21 s because the
   * generation record is not minted until ~10 s after the completion (measured —
   * `openrouter-generation.ts`). Awaiting it here would put that entire window on
   * the turn, which is the one cost this feature is not allowed to have.
   *
   * Only fires where there is something to resolve and nothing already resolved:
   * a Claude-shim turn normally arrives with `provider_name` filled in and makes
   * no request at all.
   */
  private scheduleAttributionResolve(attribution: TurnAttribution): void {
    if (attribution.provider_name !== null || !attribution.response_id) {
      return;
    }
    // A transient creation spawn carries `acpxRecordId: ""` and serves no turn,
    // so there is no record to write — the same guard the brick-context read uses.
    const sessionId = this.options.sessionContext?.acpxRecordId?.trim();
    if (!sessionId) {
      return;
    }
    void resolveTurnProvider({ sessionId, responseId: attribution.response_id }).catch(() => {
      // Enrichment: it may never cost a turn, and the turn is over regardless.
    });
  }

  /**
   * Take any new attribution line and remember it. Returns only what was NEW.
   *
   * ⚠️ THE MEMO IS WHAT MAKES A LATE LINE SURVIVABLE (TE finding F-3). The shim
   * now writes the moment the provider is readable, so the usage_update path
   * normally has it — but a line that still arrives late is picked up by the next
   * read (the lifecycle snapshot, built when the record is written) instead of
   * being lost because the one reader that could have used it had already run.
   */
  private refreshAttribution(): TurnAttribution | undefined {
    const latest = this.attributionLog?.takeLatest();
    if (latest) {
      this.lastTurnAttribution = latest;
    }
    return latest;
  }

  private async waitForSessionUpdateDrain(idleMs: number, timeoutMs: number): Promise<void> {
    const normalizedIdleMs = Math.max(0, idleMs);
    const normalizedTimeoutMs = Math.max(normalizedIdleMs, timeoutMs);
    // The budget bounds how long we WAIT, never whether we LOOK. `deadline` is an
    // absolute instant computed here and re-read below, so any delay in between
    // spends it before the first completeness check runs — and for a 0ms budget
    // (the callers that pass `replayDrainTimeoutMs: 0`) a single clock tick is
    // enough. Testing it at the TOP of the loop therefore made the loop body
    // conditional on the scheduler: on a loaded box this threw
    // "…after 0ms" having polled nothing, in ~1ms. Check first, then decide
    // whether there is budget left to wait for another pass.
    const deadline = Date.now() + normalizedTimeoutMs;
    let lastObserved = this.observedSessionUpdates;
    let idleSince = Date.now();

    for (;;) {
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

      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for session replay drain after ${normalizedTimeoutMs}ms`,
        );
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, DRAIN_POLL_INTERVAL_MS);
      });
    }
  }

  async waitForSessionUpdatesIdle(options?: {
    idleMs?: number;
    timeoutMs?: number;
  }): Promise<void> {
    await this.waitForSessionUpdateDrain(options?.idleMs ?? 0, options?.timeoutMs ?? 0);
  }
}
