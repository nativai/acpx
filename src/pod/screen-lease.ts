import fs from "node:fs";
import path from "node:path";
import { podTestHome } from "./identity.js";

/**
 * C12.1 (A-30, block A12) — the screen lease: what `acpx __screen-lease` reads and writes in the
 * session's own pod. The verb answers four states; it writes ONE pod-local file (the lease) and never
 * the snapshot — the bridge (claude-pty-acp) writes that, only while the lease it reads here is live.
 *
 * ⚠️ The file shapes are the contract's, byte for byte, because the bridge is a second implementation
 * in another repo that reads the lease and writes the presence file: C12.1 "Two pod-local files".
 */

export const SCREEN_DIR = "/run/acpx/screen";
export const LEASE_FILE_NAME = "lease";
export const PRESENCE_PREFIX = "terminal.";
export const SCREEN_LEASE_MIN_TTL_S = 5;
export const SCREEN_LEASE_MAX_TTL_S = 120;
export const SCREEN_LEASE_DEFAULT_TTL_S = 30;

/** The pod-local directory (beside the owner's socket directory); the test seam moves it like `q/`. */
export function screenDir(env: NodeJS.ProcessEnv = process.env): string {
  const seam = podTestHome(env);
  return seam ? path.join(seam, "run", "acpx", "screen") : SCREEN_DIR;
}

/** Clamp a lease's life to 5–120 s (an outside value is clamped, never refused). */
export function clampTtlS(ttlS: number): number {
  return Math.min(SCREEN_LEASE_MAX_TTL_S, Math.max(SCREEN_LEASE_MIN_TTL_S, ttlS));
}

/**
 * The bridge's own id form guards the presence file's NAME: the ACP session id comes from a record
 * and becomes a path segment, so only a plain token may. Anything else names no terminal.
 */
const ACP_ID_FORM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function presenceFilePath(acpSessionId: string, env: NodeJS.ProcessEnv = process.env) {
  return ACP_ID_FORM.test(acpSessionId)
    ? path.join(screenDir(env), `${PRESENCE_PREFIX}${acpSessionId}`)
    : undefined;
}

/** Field 22 of `/proc/<pid>/stat` (starttime, clock ticks), read past the last `)` of the command name. */
export function procStartTime(pid: number, procDir = "/proc"): string | undefined {
  try {
    const stat = fs.readFileSync(path.join(procDir, String(pid), "stat"), "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // After "pid (comm) " the fields start at field 3 (state), so field 22 is index 19.
    const value = rest[19];
    return value === undefined || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

export type TerminalPresence = {
  pid: number;
  pidStart: string;
  startedAt: string;
};

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parsePresence(text: string, acpSessionId: string): TerminalPresence | undefined {
  const body = parseJsonObject(text);
  const { pid, pid_start: start, started_at: startedAt } = body;
  const shapeOk = body.v === 1 && body.acp_session_id === acpSessionId;
  const startOk = typeof start === "number" || typeof start === "string";
  if (!shapeOk || !startOk || !isPid(pid) || typeof startedAt !== "string") {
    return undefined;
  }
  return { pid, pidStart: String(start), startedAt };
}

/**
 * The presence of a LIVE terminal of this ACP session: the file exists, names this session, and its
 * pid lives with the recorded start time. ⚠️ A REUSED PID IS NOT ALIVE: the pid answering to another
 * start time is another process. A file that cannot be read, parsed or checked means no terminal.
 */
export function liveTerminal(
  acpSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  procDir = "/proc",
): TerminalPresence | undefined {
  const file = presenceFilePath(acpSessionId, env);
  if (file === undefined) {
    return undefined;
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const presence = parsePresence(text, acpSessionId);
  if (presence === undefined) {
    return undefined;
  }
  return procStartTime(presence.pid, procDir) === presence.pidStart ? presence : undefined;
}

/** The lease, by temp name in the same directory and then a rename: a reader never sees half of it. */
export function writeLease(
  lease: { recordId: string; acpSessionId: string; untilMs: number },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = screenDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, LEASE_FILE_NAME);
  const temp = path.join(dir, `${LEASE_FILE_NAME}.tmp-${process.pid}`);
  const body = {
    v: 1,
    record_id: lease.recordId,
    acp_session_id: lease.acpSessionId,
    until: lease.untilMs,
  };
  fs.writeFileSync(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

export type ScreenLeaseAnswer =
  | { v: 1; state: "no_pod" }
  | { v: 1; state: "not_terminal" }
  | { v: 1; state: "no_terminal" }
  | { v: 1; state: "leased"; until: number; run_started_at: string };

const CLAUDE_PTY_ACP_COMMAND = /(?:^|[\s/])claude-pty-acp(?:@|[\s/]|$)/;
const ACP_SERVER_TRANSCRIPT_COMMAND = /(?:^|[\s/])acp-server-transcript(?:@|[\s/.]|$)/;

/**
 * Is this record's harness the terminal harness `claude-pty`? The same test atrium's route applies
 * (`shared/agentType.ts` `extractAgentType`): the repo name or the script name. ⚠️ `acpAdapterKind`
 * does not know this harness, so it cannot answer here. A real record's command is
 * `node /opt/claude-pty-acp/dist/index.js`; `test/pod-screen-lease.test.ts` holds a sampled one.
 */
export function isClaudePtyCommand(agentCommand: string): boolean {
  const command = agentCommand.trim();
  return CLAUDE_PTY_ACP_COMMAND.test(command) || ACP_SERVER_TRANSCRIPT_COMMAND.test(command);
}

export type ScreenLeaseInput = {
  recordId: string;
  acpSessionId: string;
  agentCommand: string;
  ttlS: number;
  /** `own-pod`: the lease is written here; `control`: no pod to answer (answered from the record). */
  place: "own-pod" | "control";
  now: number;
  env?: NodeJS.ProcessEnv;
  procDir?: string;
};

/**
 * The four answers (C12.1). Order matters: the harness first — "anywhere" — then the place. It
 * writes the lease only on `leased`. It never asks the broker and never talks to the owner.
 */
export function answerScreenLease(input: ScreenLeaseInput): ScreenLeaseAnswer {
  if (!isClaudePtyCommand(input.agentCommand)) {
    return { v: 1, state: "not_terminal" };
  }
  if (input.place === "control") {
    return { v: 1, state: "no_pod" };
  }
  const env = input.env ?? process.env;
  const terminal = liveTerminal(input.acpSessionId, env, input.procDir);
  if (terminal === undefined) {
    return { v: 1, state: "no_terminal" };
  }
  const until = input.now + clampTtlS(input.ttlS) * 1000;
  writeLease({ recordId: input.recordId, acpSessionId: input.acpSessionId, untilMs: until }, env);
  return { v: 1, state: "leased", until, run_started_at: terminal.startedAt };
}
