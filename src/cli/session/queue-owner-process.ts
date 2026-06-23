import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, realpathSync, statSync } from "node:fs";
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

export function spawnQueueOwnerProcess(options: QueueOwnerRuntimeOptions): void {
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
  child.unref();
}
