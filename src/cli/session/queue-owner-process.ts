import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionAgentOptions } from "../../runtime/engine/session-options.js";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
} from "../../types.js";

export type QueueOwnerRuntimeOptions = {
  sessionId: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  ttlMs?: number;
  maxQueueDepth?: number;
  promptRetries?: number;
  sessionOptions?: SessionAgentOptions;
};

// How a spawned queue-owner process terminated, captured by the parent so a
// dead-on-arrival owner is diagnosable (W13-24-14). `signal` wins when the
// process was killed; otherwise `code` carries the exit status.
export type OwnerExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

// Handle over a spawned queue owner. `exit` flips from `undefined` to the
// captured exit the instant the (detached) child terminates while the parent is
// still watching — this is how `sendSession` detects an owner that died before
// it could create its lock + listen, so it can re-spawn instead of polling out
// the whole startup budget against a corpse.
export type SpawnedQueueOwner = {
  readonly exit: OwnerExitInfo | undefined;
  // Stop watching the child's exit/error. Idempotent; call once the owner is
  // confirmed up (or after the final spawn attempt) so the listener is released.
  dispose(): void;
};

type SessionSendLike = {
  sessionId: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  ttlMs?: number;
  maxQueueDepth?: number;
  promptRetries?: number;
  sessionOptions?: SessionAgentOptions;
};

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

const NODE_TEST_FLAGS = new Set([
  "--experimental-test-coverage",
  "--test",
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
]);

const NODE_TEST_FLAGS_WITH_VALUE = new Set([
  "--test-name-pattern",
  "--test-reporter",
  "--test-reporter-destination",
]);

const INSPECTOR_FLAGS_WITH_VALUE = new Set([
  "--inspect",
  "--inspect-brk",
  "--inspect-port",
  "--inspect-publish-uid",
  "--debug-port",
]);

const INSPECTOR_FLAG_PREFIXES = [
  "--inspect=",
  "--inspect-brk=",
  "--inspect-port=",
  "--inspect-publish-uid=",
  "--debug-port=",
];

type ExecArgvDecision = "keep" | "drop" | "drop-with-value";

function classifyExecArgv(value: string | undefined): ExecArgvDecision {
  if (value === undefined) {
    return "drop";
  }
  if (NODE_TEST_FLAGS_WITH_VALUE.has(value) || INSPECTOR_FLAGS_WITH_VALUE.has(value)) {
    return "drop-with-value";
  }
  return dropSingleExecArgv(value) ? "drop" : "keep";
}

function dropSingleExecArgv(value: string): boolean {
  return (
    NODE_TEST_FLAGS.has(value) ||
    value.startsWith("--test-") ||
    INSPECTOR_FLAG_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

export function sanitizeQueueOwnerExecArgv(
  execArgv: readonly string[] = process.execArgv,
): string[] {
  const sanitized: string[] = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const value = execArgv[index] ?? "";
    const decision = classifyExecArgv(value);
    if (decision === "drop") {
      continue;
    }
    if (decision === "drop-with-value") {
      index += 1;
      continue;
    }
    sanitized.push(value);
  }
  return sanitized;
}

export function buildQueueOwnerArgOverride(
  entryPath: string,
  execArgv: readonly string[] = process.execArgv,
): string | null {
  const sanitized = sanitizeQueueOwnerExecArgv(execArgv);
  if (sanitized.length === 0) {
    return null;
  }
  return JSON.stringify([...sanitized, entryPath, "__queue-owner"]);
}

export function resolveQueueOwnerSpawnArgs(argv: readonly string[] = process.argv): string[] {
  const override = process.env.ACPX_QUEUE_OWNER_ARGS;
  if (override) {
    const parsed = JSON.parse(override) as unknown;
    if (isNonEmptyStringArray(parsed)) {
      return [...parsed];
    }
    throw new Error("acpx self-spawn failed: invalid ACPX_QUEUE_OWNER_ARGS");
  }

  const entry = argv[1];
  if (!entry || entry.trim().length === 0) {
    throw new Error("acpx self-spawn failed: missing CLI entry path");
  }
  const resolvedEntry = realpathSync(entry);
  return [resolvedEntry, "__queue-owner"];
}

export function queueOwnerRuntimeOptionsFromSend(
  options: SessionSendLike,
): QueueOwnerRuntimeOptions {
  return {
    sessionId: options.sessionId,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    ttlMs: options.ttlMs,
    maxQueueDepth: options.maxQueueDepth,
    promptRetries: options.promptRetries,
    sessionOptions: options.sessionOptions,
  };
}

// Cap the per-session owner log so it can't grow unbounded across respawns.
const OWNER_LOG_MAX_BYTES = 1024 * 1024;

// Open the per-session queue-owner log (`~/.acpx/sessions/<id>.owner.log`) to
// capture the detached owner's stdout+stderr — which includes the ACP adapter's
// forwarded stderr (AcpClient writes the adapter's stderr to this process's
// stderr). Previously the owner spawned with stdio:"ignore" → /dev/null, so a
// mid-turn owner/adapter death left connection_close/null/null with NO crash
// output (the records-non-diagnostic weakness). Returns an fd, or null if logging
// can't be set up (never block the spawn on it).
function openQueueOwnerLogFd(sessionId: string): number | null {
  try {
    const dir = join(homedir(), ".acpx", "sessions");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `${sessionId}.owner.log`);
    let size = 0;
    try {
      size = statSync(logPath).size;
    } catch {
      // absent → size 0
    }
    // Truncate a bloated log ("w"), otherwise append ("a") to preserve recent
    // crash output across respawns.
    return openSync(logPath, size > OWNER_LOG_MAX_BYTES ? "w" : "a");
  } catch {
    return null;
  }
}

export function buildQueueOwnerSpawnOptions(
  payload: string,
  logFd: number | null = null,
): {
  detached: true;
  stdio: "ignore" | ["ignore", number, number];
  env: NodeJS.ProcessEnv;
  windowsHide: true;
} {
  return {
    detached: true,
    // stdin ignored; stdout+stderr → the per-session owner log when available
    // (so an owner/adapter crash is diagnosable), else the prior "ignore".
    stdio: logFd !== null ? ["ignore", logFd, logFd] : "ignore",
    env: {
      ...process.env,
      ACPX_QUEUE_OWNER_PAYLOAD: payload,
      // Signal to the in-owner client that its stderr is the per-session owner log,
      // so it may emit diagnostic disconnect/exit lines there. Set ONLY when the log
      // fd actually opened — elsewhere (e.g. a --json-strict CLI, which must keep
      // stderr to JSON-RPC only) it is absent and those lines stay suppressed.
      ...(logFd !== null ? { ACPX_OWNER_LOG: "1" } : {}),
    },
    windowsHide: true,
  };
}

export function spawnQueueOwnerProcess(options: QueueOwnerRuntimeOptions): SpawnedQueueOwner {
  const payload = JSON.stringify(options);
  const logFd = openQueueOwnerLogFd(options.sessionId);
  const child = spawn(
    process.execPath,
    resolveQueueOwnerSpawnArgs(),
    buildQueueOwnerSpawnOptions(payload, logFd),
  );
  if (logFd !== null) {
    // The detached child inherited its own copy of the fd; release the parent's.
    try {
      closeSync(logFd);
    } catch {
      // already closed
    }
  }

  // Watch for a premature exit. The child is detached + unref()'d (it must
  // outlive us on a healthy start), but we keep a listener so `sendSession` can
  // see a dead-on-arrival owner and re-spawn. unref() means a lingering listener
  // never keeps THIS process alive past its own work, and on a healthy start the
  // listener simply never fires (the owner runs until idle-recycle).
  let exit: OwnerExitInfo | undefined;
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exit = { code, signal };
  };
  const onError = (): void => {
    // spawn/runtime error before an exit was reported — still treat the owner as
    // failed-to-start so the caller re-spawns rather than waiting on a ghost.
    if (exit === undefined) {
      exit = { code: null, signal: null };
    }
  };
  child.once("exit", onExit);
  child.once("error", onError);
  child.unref();

  return {
    get exit() {
      return exit;
    },
    dispose() {
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    },
  };
}

// Cap how much of the tail of the owner log we scan for a failure reason.
const OWNER_LOG_TAIL_SCAN_BYTES = 8 * 1024;
// Cap the surfaced reason so a runaway line can't bloat the thrown error.
const OWNER_LOG_REASON_MAX_CHARS = 300;

// Best-effort: recover the human-readable reason a queue owner died on startup
// from the tail of its per-session owner log (`~/.acpx/sessions/<id>.owner.log`,
// where `handleQueueOwnerCommand` writes `[acpx] queue owner failed: <reason>`).
// Turns a bare "exit code 1" into the actual cause (e.g. the EISDIR that blocked
// the lock) so the next occurrence is diagnosable rather than inferred
// (W13-24-14 / RCA §3.5 observability gap). Returns undefined when nothing
// useful is on disk — the owner may die before writing, so callers MUST keep the
// exit code as the reliable primary signal. Mirrors `openQueueOwnerLogFd`'s bare
// homedir() path (the log is intentionally not state-home-isolated).
export function readQueueOwnerStartupFailureDetail(sessionId: string): string | undefined {
  let fd: number | null = null;
  try {
    const logPath = join(homedir(), ".acpx", "sessions", `${sessionId}.owner.log`);
    const size = statSync(logPath).size;
    if (size === 0) {
      return undefined;
    }
    const start = Math.max(0, size - OWNER_LOG_TAIL_SCAN_BYTES);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(logPath, "r");
    readSync(fd, buffer, 0, length, start);
    const lines = buffer
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return undefined;
    }
    // Prefer the most recent explicit owner-failure line; fall back to the last
    // line written (still the freshest crash output across re-spawns).
    const failureLine = [...lines]
      .toReversed()
      .find((line) => line.includes("queue owner failed:"));
    const chosen = failureLine ?? lines[lines.length - 1];
    return chosen.slice(0, OWNER_LOG_REASON_MAX_CHARS);
  } catch {
    return undefined;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}
