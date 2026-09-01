import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { AcpClient } from "../../acp/client.js";
import { formatErrorMessage } from "../../acp/error-normalization.js";
import { supportsMidTurnPromptInjection } from "../../acp/mid-turn-injection-support.js";
import { withTimeout } from "../../async-control.js";
import { SessionClosedError } from "../../errors.js";
import { checkpointPerfMetricsCapture } from "../../perf-metrics-capture.js";
import { incrementPerfCounter, setPerfGauge } from "../../perf-metrics.js";
import { promptToDisplayText } from "../../prompt-content.js";
import { bindRecordToDefaultAccount } from "../../runtime/engine/default-account-binding.js";
import { applyLifecycleSnapshotToRecord } from "../../runtime/engine/lifecycle.js";
import {
  mergeSessionOptions,
  sessionOptionsFromRecord,
} from "../../runtime/engine/session-options.js";
import { SessionEventWriter } from "../../session/events.js";
import { outputStyleChangePending } from "../../session/output-style.js";
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
import type { AcpJsonRpcMessage, SessionRecord, SessionSendOutcome } from "../../types.js";
import {
  appendDeliveryStreamEvent,
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
import { terminalizeAbsorbedDeliveriesOnOwnerExit } from "./absorbed-delivery-registry.js";
import { resolveAndEnsureAgentFolder } from "./agent-folder.js";
import { resolveExistingBrickPath } from "./brick-link.js";
import {
  DEFAULT_QUEUE_OWNER_TTL_MS,
  normalizeOwnerIdleReleaseMs,
  normalizeQueueOwnerTtlMs,
  type SessionSendOptions,
} from "./contracts.js";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetModelDirect,
  runSessionSetModeDirect,
  type ActiveSessionController,
} from "./prompt-runner.js";
import type {
  OwnerExitInfo,
  QueueOwnerRuntimeOptions,
  SpawnedQueueOwner,
} from "./queue-owner-process.js";
import {
  queueOwnerRuntimeOptionsFromSend,
  readQueueOwnerStartupFailureDetail,
  spawnQueueOwnerProcess,
} from "./queue-owner-process.js";
import { runQueuedTask } from "./runtime.js";

// Overall connect-poll budget for a cold-respawn owner startup (× 50 ms ≈ 6 s).
// Shared across all re-spawn attempts so the worst-case latency stays at the
// historical ~6 s bound rather than ballooning to a multiple of it.
const QUEUE_OWNER_STARTUP_MAX_ATTEMPTS = 120;
// Bounded re-spawns within that budget. A transient single-owner startup failure
// (owner dies before lock+listen) must self-heal within ONE message; a persistent
// one must still fail fast (W13-24-14 / RCA §3.5). One spawn + up to two re-spawns.
const QUEUE_OWNER_MAX_SPAWN_ATTEMPTS = 3;
const QUEUE_OWNER_HEARTBEAT_INTERVAL_MS = 5_000;
// The submit transport retries a missing Unix socket for ~2s before surfacing
// QUEUE_NOT_ACCEPTING_REQUESTS. Check comfortably inside that pre-write budget
// so an idle owner can restore its listener without replaying the prompt.
const QUEUE_OWNER_SOCKET_CONTINUITY_INTERVAL_MS = 500;

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
  const brick = record.metadata?.brick?.trim() || null;
  const brickPath = brick ? resolveExistingBrickPath(brick) : null;
  return {
    acpxRecordId: record.acpxRecordId,
    sessionName: record.name ?? null,
    parentSessionId: record.parentSessionId ?? null,
    parentSessionUrl: record.parentSessionUrl ?? null,
    taskFolder: record.metadata?.task_folder ?? null,
    brick,
    brickPath,
    agentFolder: resolveAndEnsureAgentFolder(record, brickPath),
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
  socketContinuityTimer: NodeJS.Timeout | undefined;
  turnController: QueueOwnerTurnController;
  sharedClient: AcpClient;
  sessionId: string;
  verbose?: boolean;
}): Promise<void> {
  if (params.heartbeatTimer) {
    clearInterval(params.heartbeatTimer);
  }
  if (params.socketContinuityTimer) {
    clearInterval(params.socketContinuityTimer);
  }
  params.turnController.beginClosing();
  // 493729fc F3: absorbed injected deliveries (codex steers folded into the
  // active turn) whose containing turn never settled would otherwise die with
  // this owner as accepted-forever. Sweep them to an outcome-unknown terminal
  // BEFORE tearing down the client — the flag flip inside is synchronous, so a
  // settle path racing the teardown can't double-write. The content may have
  // reached the model, so the terminal must lead to a manual resend decision,
  // never an auto-resend.
  const absorbedTerminals = terminalizeAbsorbedDeliveriesOnOwnerExit(params.sessionId);
  if (absorbedTerminals > 0) {
    process.stderr.write(
      `[acpx] queue owner exit wrote ${absorbedTerminals} ABSORBED_TURN_NEVER_ENDED terminal(s) for session ${params.sessionId}\n`,
    );
  }
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

// The catchable signals an external kill actually uses. `terminateProcess` sends
// SIGTERM, waits PROCESS_EXIT_GRACE_MS = 1_500, then SIGKILL — which is
// uncatchable by design and remains the irreducible residual (DESIGN §12 E6).
const QUEUE_OWNER_FATAL_SIGNALS = ["SIGTERM", "SIGINT"] as const;
// Conventional 128 + signum, so a supervisor still reads the death as signalled.
const FATAL_SIGNAL_EXIT_CODES: Record<string, number> = { SIGTERM: 143, SIGINT: 130 };

/**
 * D1 / A6 (brick://53437107) — the SIGTERM/SIGINT custody sweep. The single
 * riskiest change in this design, and the highest-value one.
 *
 * Until now the acpx tree had NO SIGTERM handler at all, so `sessions close`,
 * `forceRestartQueueOwner`, a pod SIGTERM or an operator all killed the owner
 * outright and `owner.close()` — the code that already writes honest terminals —
 * never ran. Everything the owner still held was destroyed in silence. That is
 * class B: 1–4 inter-agent messages lost per day, fleet-wide, for six weeks.
 * This handler covers EVERY external kill, not just the drain verb we added.
 *
 * Three constraints, all load-bearing (risk R1):
 *   - SYNCHRONOUS writes. An async `appendFile` does not flush before
 *     `process.exit()`, so the terminals would be lost exactly when they matter
 *     most. Everything below writes through the sync sibling.
 *   - BOUNDED. PROCESS_EXIT_GRACE_MS = 1_500 ms is the whole window before
 *     SIGKILL. Local sync appends only — no awaits, nothing that can block. A
 *     hang here would mean the owner no longer dies on SIGTERM, i.e. we would
 *     have made process teardown worse fleet-wide.
 *   - RE-ENTRANT. A second signal during the handler exits immediately rather
 *     than queueing behind the first.
 *
 * It also performs the orphan process-group reap that `closeQueueOwnerRuntime`
 * does as its own final act. Before this, an externally-killed owner stranded
 * its adapter descendants: the reap ran only on the graceful path, and only if
 * that path won a race against the 1.5 s SIGKILL. Relocating the same guarded
 * sweep here makes it deterministic on every signal path — on a shared box,
 * stranded adapters are how load reaches 40+.
 */
export function installQueueOwnerFatalSignalHandlers(params: {
  sessionId: string;
  owner: SessionQueueOwner;
}): () => void {
  let handling = false;
  // Resolved ONCE, here, not inside the signal path: `ownerIsGroupLeader()`
  // reads /proc and, if that fails, shells out to `ps` — and the handler must do
  // no I/O that can block inside the grace window. A process's group does not
  // change after start, so the answer is stable for this owner's lifetime.
  const isGroupLeader = ownerIsGroupLeader();

  const onFatalSignal = (signal: NodeJS.Signals): void => {
    const exitCode = FATAL_SIGNAL_EXIT_CODES[signal] ?? 143;
    if (handling) {
      process.exit(exitCode);
    }
    handling = true;

    // THE ORDER BELOW IS LOAD-BEARING, NOT INCIDENTAL. The custody sweep must
    // COMPLETE before the process-group reap, because when this owner leads the
    // group that reap SIGKILLs *this process too*: nothing after it runs, and
    // SIGKILL is uncatchable, so no exit hook can rescue a pending write. That
    // is also why every write in the sweep is synchronous. Anything moved below
    // the reap becomes dead code silently.
    try {
      const undelivered = params.owner.terminalizeCustodyOnSignal();
      const absorbed = terminalizeAbsorbedDeliveriesOnOwnerExit(params.sessionId);
      if (undelivered > 0 || absorbed > 0) {
        process.stderr.write(
          `[acpx] queue owner for session ${params.sessionId} took ${signal} while holding custody; ` +
            `wrote ${undelivered} undelivered + ${absorbed} absorbed terminal(s)\n`,
        );
      }
    } catch {
      // Never throw from a signal handler: a lost terminal is bad, a teardown
      // that wedges until SIGKILL is worse.
    }

    // Adapter descendants share this owner's process group. The leader guard is
    // what stops an owner embedded in someone else's group from sweeping a group
    // it does not own — the same guard the graceful path carries.
    if (isGroupLeader && hasLiveProcessGroup(process.pid)) {
      signalProcessGroup(process.pid, "SIGKILL");
    }

    // Reached only when this owner does not lead a live group. R1 is absolute:
    // the owner always dies.
    process.exit(exitCode);
  };

  for (const signal of QUEUE_OWNER_FATAL_SIGNALS) {
    process.on(signal, onFatalSignal);
  }
  return () => {
    for (const signal of QUEUE_OWNER_FATAL_SIGNALS) {
      process.off(signal, onFatalSignal);
    }
  };
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

// Parse an integer-millisecond env var. Empty/absent → undefined so the
// normalizer applies its default; this guards against `Number("") === 0`
// silently disabling a feature on an unset-but-present env var.
function parseEnvMs(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") {
    return undefined;
  }
  return Number(raw);
}

// W13-24-14 Phase 2 — the idle-owner release reasons. Two INDEPENDENT triggers,
// OR'd, that share one safety gate (see decideIdleOwnerRelease):
//   - "deploy-staleness": the owner is running OUTDATED code (W13-24-10 Path 1).
//   - "idle-memory":      the owner is provably idle past the memory timeout.
//   - "output-style-change": the record's DESIRED output style no longer matches
//     the style this owner's live query was BUILT with (brick://874fee67). The
//     style is only honoured through the adapter's creation settings, so the only
//     way to adopt a new one is to let this owner go and have the next prompt
//     cold-spawn a fresh one that resumes with it.
export type IdleOwnerReleaseReason = "output-style-change" | "deploy-staleness" | "idle-memory";

export type IdleOwnerReleaseDecision =
  | { release: false }
  | { release: true; reason: IdleOwnerReleaseReason };

export type DecideIdleOwnerReleaseInput = {
  ttlMs: number;
  hasActiveTurn: boolean;
  now: number;
  lastIdleDrainActivityAt: number;
  lastTaskCompletedAt: number;
  quiescenceWindowMs: number;
  idleReleaseMs: number;
  // Lazy so the deploy-file read happens ONLY after the safety gate already holds
  // (preserves the W13-24-10 short-circuit cost-ordering). Pure helper otherwise.
  deployDiffers: () => boolean | Promise<boolean>;
  // brick://874fee67 — lazy for the same reason (it re-reads the session record).
  // Without this input an owner that is idle and simply never receives another
  // prompt holds the stale style indefinitely, and the user's change appears to
  // have done nothing. Path (A), the turn boundary, cannot cover that case.
  outputStyleDiffers: () => boolean | Promise<boolean>;
};

// THE LOAD-BEARING DECISION (W13-24-14 Phase 2). Pure (modulo the deployDiffers
// thunk) so the North-Star gate is unit-testable without a live owner, mirroring
// how the queue module factors isRecoverableQueueOwnerState / classifyQueueOwnerState.
//
// Separation of concerns — state it once, here, so no future edit blurs it:
//   * The SHARED GATE (`idleAndQuiescent`) decides WHETHER a maybe-active owner is
//     protected. It is the North-Star invariant and is evaluated ONCE so a future
//     edit cannot relax it for one release reason while keeping it for the other.
//   * The accumulated-idle CLOCK (`idleReleaseMs`) decides only WHEN an owner that
//     has ALREADY passed the gate is released. It can NEVER release an active owner
//     — a clock bug can at worst over-release a genuinely-idle owner (benign:
//     cold-respawn recovers WITH context).
export async function decideIdleOwnerRelease(
  input: DecideIdleOwnerReleaseInput,
): Promise<IdleOwnerReleaseDecision> {
  // SHARED safety gate — BOTH reasons require provably-idle + quiescent:
  //   - ttlMs !== 0    : `--ttl 0` is the master never-recycle opt-out
  //                      (belt-and-suspenders; nextTask(undefined) never times out,
  //                      so the idle branch is structurally unreachable at ttl 0).
  //   - !hasActiveTurn : the reliable local turn signal (starting/active or a live
  //                      prompt) — NEVER inFlight / heartbeat age. A long 15-20 min
  //                      tool call keeps the turn active → the owner is never idle.
  //   - quiescent      : no inter-turn idle-drain relay within the check cadence,
  //                      so an owner relaying background work is never torn down.
  const idleAndQuiescent =
    input.ttlMs !== 0 &&
    !input.hasActiveTurn &&
    input.now - input.lastIdleDrainActivityAt >= input.quiescenceWindowMs;
  if (!idleAndQuiescent) {
    return { release: false };
  }

  // brick://874fee67: ordered FIRST, ahead of deploy-staleness, by the same
  // principle the comment below states — the more specific and more user-visible
  // reason wins the label. A pending style change is something a human just asked
  // for and is watching for. Evaluated only now, after the gate already holds, so
  // the record re-read costs nothing on the common busy path.
  //
  // ⚠️ Sits BEHIND the shared gate deliberately: this must never release an owner
  // with an active turn. Recycling mid-turn is the one thing the whole
  // accept-anytime contract exists to avoid.
  if (await input.outputStyleDiffers()) {
    return { release: true, reason: "output-style-change" };
  }

  // Deploy-staleness checked second: an owner that is BOTH outdated AND long-idle is
  // reported under the more specific, more actionable reason. The deploy check (a
  // file read) is evaluated only now — after the gate already holds.
  if (await input.deployDiffers()) {
    return { release: true, reason: "deploy-staleness" };
  }

  // idle-memory: provably idle past the timeout. The accumulated-idle clock is
  // now - max(lastTaskCompletedAt, lastIdleDrainActivityAt): ANY activity — a
  // completed turn or a relay message — resets it, so only genuine silence
  // accumulates. idleReleaseMs <= 0 disables ONLY this path (deploy recycle survives).
  if (
    input.idleReleaseMs > 0 &&
    input.now - Math.max(input.lastTaskCompletedAt, input.lastIdleDrainActivityAt) >=
      input.idleReleaseMs
  ) {
    return { release: true, reason: "idle-memory" };
  }

  return { release: false };
}

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
export async function runSessionQueueOwner(options: QueueOwnerRuntimeOptions): Promise<void> {
  const lease = await tryAcquireQueueOwnerLease(options.sessionId);
  if (!lease) {
    return;
  }

  const sessionRecord = await resolveSessionRecord(options.sessionId);
  if (bindRecordToDefaultAccount(sessionRecord)) {
    await writeSessionRecordAtBoundary(sessionRecord);
  }

  // #2 Fail-loud identity assertion: the record we're about to serve MUST be the
  // one whose id matches what the queue-owner was asked for. A mismatch means the
  // spawned adapter would get the wrong ACPX_SESSION_URL and serve turns under a
  // stale/parent identity — refuse the turn rather than silently misroute.
  // This is a no-op on the healthy path (every current code path) since
  // resolveSessionRecord(id) returns the record with that id.
  if (sessionRecord.acpxRecordId !== options.sessionId) {
    process.stderr.write(
      `[acpx] IDENTITY MISMATCH — queue owner for session ${options.sessionId} resolved a record ` +
        `with acpxRecordId=${sessionRecord.acpxRecordId}; refusing to serve (would misattribute turns). ` +
        `This indicates a corrupted or misnamed session record file.\n`,
    );
    return;
  }

  // Mid-turn prompt injection (concurrent client.prompt() into an in-flight
  // turn) relies on adapter-specific support for accepting a new prompt while
  // another turn is active. Claude ACP and Codex ACP support that contract;
  // adapters without known support keep the owner's mid-turn handler unset so
  // new prompts land in the normal pending queue.
  const midTurnInjectionSupported = supportsMidTurnPromptInjection(sessionRecord.agentCommand);
  let owner: SessionQueueOwner | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let socketContinuityTimer: NodeJS.Timeout | undefined;
  let socketContinuityCheck: Promise<void> | undefined;
  let idleDrain: { stop: () => Promise<void> } | undefined;
  let removeFatalSignalHandlers: (() => void) | undefined;
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
  // W13-24-14 Phase 2 — authoritative "owner went idle" stamp for the
  // accumulated-idle clock. Baselined at spawn (so a freshly-spawned owner that
  // never gets a task still has a well-defined clock), re-stamped at each turn
  // completion. Combined via Math.max with lastIdleDrainActivityAt so ANY activity
  // — a completed turn OR a relay message — resets the clock. This governs only
  // WHEN an already-idle owner is released; WHETHER an active owner is protected is
  // the hasActiveTurn()+quiescence gate (see decideIdleOwnerRelease).
  let lastTaskCompletedAt = Date.now();
  const sharedClient = createQueueOwnerSharedClient(options, sessionRecord);
  const ttlMs = normalizeQueueOwnerTtlMs(options.ttlMs);
  // W13-24-14 Phase 2 — memory-release idle timeout (ms), read from env at owner
  // start (reaches the owner via ...process.env, like ACPX_DEPLOY_VERSION_FILE).
  // 0 disables ONLY the memory-release path (deploy-staleness recycle survives);
  // invalid/negative/unset → the 30-min default.
  const idleReleaseMs = normalizeOwnerIdleReleaseMs(
    parseEnvMs(process.env.ACPX_OWNER_IDLE_RELEASE_MS),
  );
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

  // brick://874fee67 — the ONE predicate, evaluated against a FRESHLY READ
  // record (re-reading inside the owner loop is established practice here; see
  // closeActiveBackendSession above). Reading `sessionRecord` from the owner's
  // own memory would defeat the entire design: that snapshot is exactly the
  // stale view a style change written from outside this process must beat.
  //
  // Fail CLOSED on a read error — an unreadable record is not evidence of a
  // pending change, and releasing the owner on a transient fs error would turn
  // every such blip into a recycle. The turn boundary and the idle loop both
  // re-evaluate, so a missed check costs at most one turn of latency.
  const outputStyleChangeIsPending = async (): Promise<boolean> => {
    try {
      return outputStyleChangePending(await resolveSessionRecord(options.sessionId));
    } catch {
      return false;
    }
  };

  const repairOwnerSocketIfQuiescent = async (): Promise<void> => {
    const currentOwner = owner;
    const canRepair = () => !turnController.hasActiveTurn() && currentOwner?.queueDepth() === 0;
    if (!currentOwner || !canRepair()) {
      return;
    }

    const repaired = await currentOwner.repairSocketIfMissing(canRepair);
    if (!repaired) {
      return;
    }

    await refreshQueueOwnerLease(lease, { queueDepth: currentOwner.queueDepth() }).catch(() => {
      // Listener repair succeeded; a heartbeat write failure must not tear it down.
    });
    incrementPerfCounter("queue.owner.socket_repaired");
    process.stderr.write(
      `[acpx] queue owner restored missing socket for session ${options.sessionId}\n`,
    );
  };

  const scheduleSocketContinuityCheck = (): void => {
    if (socketContinuityCheck) {
      return;
    }
    socketContinuityCheck = repairOwnerSocketIfQuiescent()
      .catch((error) => {
        if (options.verbose) {
          process.stderr.write(
            `[acpx] queue owner socket continuity check failed: ${formatErrorMessage(error)}\n`,
          );
        }
      })
      .finally(() => {
        socketContinuityCheck = undefined;
      });
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
    socketContinuityTimer = setInterval(
      scheduleSocketContinuityCheck,
      QUEUE_OWNER_SOCKET_CONTINUITY_INTERVAL_MS,
    );
    socketContinuityTimer.unref();

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

    // D1 (brick://53437107) — custody lives in TWO places, so the drain and the
    // signal handler must walk both (corollary C-1). The owner holds `pending`;
    // the capture buffer lives here, so hand the owner an accessor that takes it.
    owner.setMidTurnCustodySource(() => midTurnBuffer.splice(0));
    removeFatalSignalHandlers = installQueueOwnerFatalSignalHandlers({
      sessionId: options.sessionId,
      owner,
    });

    if (midTurnInjectionSupported) {
      owner.setMidTurnHandler((task: QueueTask): boolean => {
        if (activeMidTurnHandler) {
          activeMidTurnHandler(task);
          return true;
        }
        if (midTurnCaptureActive) {
          midTurnBuffer.push(task);
          // C4 (G3): make the capture-window wait visible. Without this the task
          // sat between `acpx/received` and acceptance with no delivery event for
          // up to a full drain cycle (RCA §3). Additive: deployed acpx-ui's
          // parseDeliveryEvent whitelists phases and ignores unknown ones.
          appendDeliveryStreamEvent(options.sessionId, task, "queued");
          return true;
        }
        // Not in a turn — let the task land in the normal pending queue.
        return false;
      });
    }

    let isFirstTask = true;
    while (true) {
      const pollTimeoutMs = isFirstTask ? initialTaskPollTimeoutMs : defaultTaskPollTimeoutMs;
      let task = await owner.nextTask(pollTimeoutMs);
      if (!task) {
        // A full idle window elapsed; subsequent waits use the steady cadence.
        isFirstTask = false;
        // No new prompt arrived within the idle-check window. Per the North Star
        // we do NOT reap a live owner for being quiet. Two INDEPENDENT release
        // reasons share ONE safety gate (see decideIdleOwnerRelease):
        //   - deploy-staleness: running OUTDATED code (W13-24-10 Path 1).
        //   - idle-memory:      provably idle past the memory timeout (Phase 2),
        //                       released to free ~287 MB; the next prompt
        //                       cold-respawns WITH context (reliable post Phase 1).
        // The shared gate (ttl!==0 && !hasActiveTurn && quiescent) governs WHETHER
        // a maybe-active owner is protected; the accumulated-idle clock governs
        // only WHEN an already-idle owner is released — it can never release an
        // active owner. When ttl 0, `nextTask` never times out, so this branch is
        // structurally unreachable (the ttl!==0 term is belt-and-suspenders).
        const quiescenceWindowMs = pollTimeoutMs ?? 0;
        const decision = await decideIdleOwnerRelease({
          ttlMs,
          hasActiveTurn: turnController.hasActiveTurn(),
          now: Date.now(),
          lastIdleDrainActivityAt,
          lastTaskCompletedAt,
          quiescenceWindowMs,
          idleReleaseMs,
          // Lazy: the deploy-file read happens only after the gate already holds,
          // preserving the W13-24-10 short-circuit cost-ordering.
          deployDiffers: deployedBuildDiffersFromOwner,
          outputStyleDiffers: outputStyleChangeIsPending,
        });
        if (!decision.release) {
          // Current code & within the idle window, OR busy / active / relaying
          // background work → re-arm, stay warm.
          continue;
        }
        // P2d (brick c85d7737 §6) — defense-in-depth final poll before releasing.
        // `decideIdleOwnerRelease` is async (it may read the deploy-diff file), so a
        // task can be submitted into this owner's IPC queue in the TOCTOU window
        // between the idle-check `nextTask` above and this release decision — and be
        // enqueued into a dying owner. One last NON-BLOCKING `nextTask(0)` closes that
        // window: if a task raced the decision, process it instead of releasing. This
        // is owner-internal and NOT lease-gated; the executor's P2b re-drive remains
        // the authoritative wake — this poll just spares the common case a cold
        // respawn (TOCTOU at the process boundary is not perfectly avoidable here).
        const lateTask = await owner.nextTask(0);
        if (!lateTask) {
          // Diagnosable, NON-verbose-gated → owner.log (the RCA's "make the owner
          // lifecycle diagnosable" recommendation; the TE asserts this line + its
          // reason=). Safe to emit unconditionally: the owner's stderr is its own
          // owner.log fd, never a --json-strict client's JSON-RPC stream.
          process.stderr.write(
            `[acpx] queue owner releasing session ${options.sessionId} (reason=${decision.reason}); next prompt cold-respawns with context\n`,
          );
          incrementPerfCounter(
            decision.reason === "deploy-staleness"
              ? "queue.owner.deploy_recycled"
              : "queue.owner.idle_released",
          );
          // Flush the counter to ACPX_PERF_METRICS_FILE NOW (the secondary signal):
          // the graceful close self-SIGKILLs the owner's process group (the
          // W13-24-10 orphan backstop in closeQueueOwnerRuntime), which preempts
          // the process 'exit' perf flush — so a checkpoint here is what makes the
          // counter observable, the same call the turn-completion path uses.
          checkpointPerfMetricsCapture();
          // Graceful close via the existing clean path (finally →
          // closeQueueOwnerRuntime). The next prompt cold-respawns, resuming WITH
          // context. No new kill primitive.
          break;
        }
        // A task raced the release decision — process it instead of releasing.
        process.stderr.write(
          `[acpx] queue owner deferring idle release for session ${options.sessionId}; a task arrived in the release window (P2d final-poll)\n`,
        );
        task = lateTask;
        // fall through to the task-processing path below (do NOT release/continue).
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
                    `[acpx] account switch applied (→ ${newProfileId}); recycling queue owner for session ${options.sessionId} after this turn\n`,
                  );
                }
              },
              onLockBlocked: () => {
                recycleOwnerAfterTask = true;
                if (options.verbose) {
                  process.stderr.write(
                    `[acpx] subscription lock blocked session ${options.sessionId}; recycling queue owner after this task\n`,
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
        // go back to the normal pending queue — C4 (G3): order-preserving so the
        // oldest is not starved (the old per-item requeue reversed the batch),
        // and each stays visible as `queued` until it is accepted.
        const leftovers = midTurnBuffer.splice(0);
        if (leftovers.length > 0) {
          owner.requeueAll(leftovers);
          for (const leftover of leftovers) {
            appendDeliveryStreamEvent(options.sessionId, leftover, "queued");
          }
        }
      }
      // If the advertised pathname disappeared during a turn, restore it only
      // after the authoritative local turn state is idle and no queued work
      // remains. This never cancels, kills, or replays active work.
      await repairOwnerSocketIfQuiescent().catch((error) => {
        if (options.verbose) {
          process.stderr.write(
            `[acpx] queue owner socket continuity check failed: ${formatErrorMessage(error)}\n`,
          );
        }
      });
      // Restart idle drain to capture teammate activity until next prompt
      idleDrain = await startIdleStreamDrain();
      // W13-24-14 Phase 2 — the owner just became idle: (re)start the
      // accumulated-idle clock. Stamped at turn END (never turn start) so the
      // clock measures idle duration — a 25-min turn leaves it at ~0 when it ends.
      lastTaskCompletedAt = Date.now();

      // A failover this turn pinned the shared client to a now-stale transcript
      // anchor. Exit so the next prompt cold-spawns a fresh owner on the new
      // profile/account.
      //
      // brick://874fee67 path (A), the PRIMARY one: the same exit, for a style
      // change that arrived from OUTSIDE this process while the turn was running.
      // Note the deliberate asymmetry with `recycleOwnerAfterTask` beside it —
      // that flag is set by callbacks firing INSIDE the turn, in-process, so a
      // boolean carries it safely. A style change is written by the CLI or
      // acpx-ui, so a boolean would have to be delivered over IPC, and a lost
      // message would leave the record holding the new style while this owner
      // keeps serving the old one: the change silently forgotten, looking exactly
      // like success. Re-reading the record instead has no such path.
      if (recycleOwnerAfterTask || (await outputStyleChangeIsPending())) {
        break;
      }
    }

    await idleDrain.stop();
    if (midTurnInjectionSupported) {
      owner.clearMidTurnHandler();
    }
  } finally {
    removeFatalSignalHandlers?.();
    await idleDrain?.stop().catch(() => {});
    await closeQueueOwnerRuntime({
      lease,
      owner,
      heartbeatTimer,
      socketContinuityTimer,
      turnController,
      sharedClient,
      sessionId: options.sessionId,
      verbose: options.verbose,
    });
  }
}

// Injection seam for the cold-respawn startup loop. Production binds the real
// primitives (the defaults below); the queue-owner tests substitute deterministic
// fakes so the bounded re-spawn / fail-fast / exit-reason behaviour is exercised
// without real owner processes. The real spawn + exit-detection primitive is
// proven separately (queue-owner-process tests) and end-to-end by the
// reproduce-first selftest, so faking it here is not "mocking the spawn path"
// for the proof — it isolates the orchestration. (W13-24-14.)
export type SendSessionRuntimeDeps = {
  submitToRunningOwner: (
    options: SessionSendOptions,
    waitForCompletion: boolean,
  ) => Promise<SessionSendOutcome | undefined>;
  spawnQueueOwnerProcess: (options: QueueOwnerRuntimeOptions) => SpawnedQueueOwner;
  waitMs: (ms: number) => Promise<void>;
  readStartupFailureDetail: (sessionId: string) => string | undefined;
  maxPollAttempts: number;
  maxSpawnAttempts: number;
};

const defaultSendSessionRuntimeDeps: SendSessionRuntimeDeps = {
  submitToRunningOwner,
  spawnQueueOwnerProcess,
  waitMs,
  readStartupFailureDetail: readQueueOwnerStartupFailureDetail,
  maxPollAttempts: QUEUE_OWNER_STARTUP_MAX_ATTEMPTS,
  maxSpawnAttempts: QUEUE_OWNER_MAX_SPAWN_ATTEMPTS,
};

function describeOwnerExit(exit: OwnerExitInfo): string {
  if (exit.signal !== null) {
    return `killed by signal ${exit.signal}`;
  }
  if (exit.code !== null) {
    return `exit code ${exit.code}`;
  }
  return "exit reason unavailable";
}

function logQueueOwnerStartupRespawn(params: {
  sessionId: string;
  exit: OwnerExitInfo;
  nextAttempt: number;
  maxSpawnAttempts: number;
  verbose?: boolean;
}): void {
  if (!params.verbose) {
    return;
  }
  process.stderr.write(
    `[acpx] queue owner for session ${params.sessionId} died on startup ` +
      `(${describeOwnerExit(params.exit)}); re-spawning ` +
      `(attempt ${params.nextAttempt}/${params.maxSpawnAttempts})\n`,
  );
}

function formatOwnerStartFailure(
  sessionId: string,
  exit: OwnerExitInfo | undefined,
  spawnsUsed: number,
  detail: string | undefined,
): string {
  const base = `Session queue owner failed to start for session ${sessionId}`;
  if (!exit) {
    // No owner exit was observed within the budget — the owner is alive but never
    // became submittable (hung start). A re-spawn would only defer on its lease,
    // so there is nothing diagnostic to add beyond the spawn count.
    return `${base} after ${spawnsUsed} spawn attempt(s)`;
  }
  const reasonSuffix = detail ? `: ${detail}` : "";
  return (
    `${base} after ${spawnsUsed} spawn attempt(s) ` +
    `(owner process died on startup: ${describeOwnerExit(exit)}${reasonSuffix})`
  );
}

// Cold-respawn startup: spawn a queue owner and wait for it to become
// submittable, re-spawning a fresh owner (bounded) whenever the spawned one dies
// before it can create its lock + listen. This is the W13-24-14 fix: a transient
// single-owner startup hiccup self-heals within ONE message instead of surfacing
// "failed to start", while a persistent failure still fails fast and now carries
// the owner's exit code/reason. Extracted from `sendSession` so the orchestration
// is unit-testable via `deps` without real owner processes.
export async function spawnAndAwaitQueueOwner(
  effectiveOptions: SessionSendOptions,
  deps: SendSessionRuntimeDeps = defaultSendSessionRuntimeDeps,
): Promise<SessionSendOutcome> {
  const waitForCompletion = effectiveOptions.waitForCompletion !== false;
  const sessionId = effectiveOptions.sessionId;
  const runtimeOptions = queueOwnerRuntimeOptionsFromSend(effectiveOptions);

  let spawned = deps.spawnQueueOwnerProcess(runtimeOptions);
  let spawnsUsed = 1;
  let lastExit: OwnerExitInfo | undefined;
  try {
    for (let attempt = 0; attempt < deps.maxPollAttempts; attempt += 1) {
      const queued = await deps.submitToRunningOwner(effectiveOptions, waitForCompletion);
      if (queued) {
        return queued;
      }

      const exit = spawned.exit;
      if (exit) {
        // The spawned owner died before becoming submittable. Re-spawn a fresh
        // one (within the shared poll budget) so a transient hiccup self-heals;
        // once the bounded attempts are spent, fail fast rather than polling a
        // corpse for the remaining budget.
        lastExit = exit;
        if (spawnsUsed >= deps.maxSpawnAttempts) {
          break;
        }
        spawned.dispose();
        logQueueOwnerStartupRespawn({
          sessionId,
          exit,
          nextAttempt: spawnsUsed + 1,
          maxSpawnAttempts: deps.maxSpawnAttempts,
          verbose: effectiveOptions.verbose,
        });
        spawned = deps.spawnQueueOwnerProcess(runtimeOptions);
        spawnsUsed += 1;
        continue;
      }

      await deps.waitMs(QUEUE_CONNECT_RETRY_MS);
    }
  } finally {
    spawned.dispose();
  }

  // Surface the owner's death reason (RCA §3.5 observability gap): the exit
  // code/signal is the reliable signal, enriched best-effort with the failure
  // line the dead owner left in its owner.log.
  const detail = lastExit ? deps.readStartupFailureDetail(sessionId) : undefined;
  throw new Error(formatOwnerStartFailure(sessionId, lastExit, spawnsUsed, detail));
}

// B3 (RCA b2ca4bd0 §B.6) — the true silent drop, refused at the enqueue boundary.
//
// `--no-wait` resolves the instant the owner ACKs, so NO asynchronous terminal
// can ever reach this caller: by the time `runSessionPrompt` refuses a closed
// record, the CLI process has already printed `[queued]` and exited 0. The
// honest failure therefore has to happen HERE, before the ack — a synchronous
// refusal, identical in both wait modes. (Measured before the fix: rc=0 and
// `[queued] <id>` for a closed target, with no message, no delivery record, no
// `last_error`, nothing in `.messages.ndjson`, and no replay after reopen.)
//
// It also stops a pointless cold spawn. A closed session has no live owner — the
// close killed it — so `submitToRunningOwner` misses and `spawnAndAwaitQueueOwner`
// used to start a whole owner process purely to have it refuse the task.
//
// SCOPED TO PROMPTS WITH NO messageId, and that scope is a cross-repo contract,
// not a shortcut. acpx-ui always spawns `prompt --no-wait --message-id <id>`,
// and such a task already gets an honest owner-side terminal
// (SESSION_CLOSED_UNDELIVERED, which acpx-ui's `senderNotify` classifies as a
// definitive give-up and reports to the sender). Refusing those here would swap
// a terminal acpx-ui understands for a non-zero exit it does not — a change that
// belongs in acpx-ui, not in a unilateral acpx commit. A bare CLI prompt has no
// delivery lifecycle at all, which is exactly why it vanished without trace.
//
// ADDITIVE, NEVER A REPLACEMENT. `runSessionPrompt`'s refusal stays, so this
// check being wrong cannot open a new silent-drop path — only fail to close one.
// The window between this read and the owner's pull is real and is not claimed
// to be closed; it is the residual race, and
// `terminalizeDeliveryRefusedByClosedRecord` is what makes it leave a trace. The
// two directions are asymmetric and this fails in the cheap one: refusing a
// session reopened since the read costs one loud, retryable error, while
// accepting one closed since the read falls through to the owner refusal.
function assertRecordOpenForCliPrompt(record: SessionRecord, options: SessionSendOptions): void {
  if (options.messageId !== undefined || !record.closed) {
    return;
  }
  throw new SessionClosedError(record.acpxRecordId, record.name ?? undefined);
}

export async function sendSession(options: SessionSendOptions): Promise<SessionSendOutcome> {
  const waitForCompletion = options.waitForCompletion !== false;
  // Resolved once, and checked BEFORE the owner-option persist below writes the
  // record twice — a refused prompt must not mutate the session it was refused by.
  const record = await resolveSessionRecord(options.sessionId);
  assertRecordOpenForCliPrompt(record, options);
  const effectiveOptions = await persistSendOwnerOptions(record, options);

  const queuedToOwner = await submitToRunningOwner(effectiveOptions, waitForCompletion);
  if (queuedToOwner) {
    return queuedToOwner;
  }

  return await spawnAndAwaitQueueOwner(effectiveOptions);
}

// Split from its former `resolveAndPersistSendOwnerOptions` shape so `sendSession`
// can hold the resolved record and run the closed-record refusal above BEFORE any
// of these writes happen. One read, not two.
async function persistSendOwnerOptions(
  record: SessionRecord,
  options: SessionSendOptions,
): Promise<SessionSendOptions> {
  if (bindRecordToDefaultAccount(record)) {
    await writeSessionRecordAtBoundary(record);
  }
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
