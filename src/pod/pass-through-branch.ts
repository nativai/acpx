import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atriumRequest } from "./atrium-exchange.js";
import {
  callHome,
  callHomeAnswerTimeoutMs,
  callHomeUnknownFailure,
  atriumAwayFailure,
  doorRefusedFailure,
  emitCallHomeFailure,
  enterCallHomeMode,
  PASS_THROUGH_DEADLINE_MS,
  type CallHomeOutcome,
} from "./call-home.js";
import { PASS_THROUGH_INHERIT, type CommandClass, type OutputMode } from "./command-classes.js";
import {
  registerBranchHandler,
  type BranchContext,
  type PlacementDecision,
} from "./placement-step.js";

/**
 * A3 — the pass-through client and the message route, no direct path (CONTRACTS-r4 C6.1, C6.2, C7.2;
 * brick 7eb9686f). Registers A1's two branches `pass-through` and `message-route`.
 *
 * ⚠️ KEEP THIS MODULE LIGHT: `src/cli.ts` imports it before the placement step runs (node builtins,
 * `placement-step.ts`, `call-home.ts`, `atrium-exchange.ts`, `command-classes.ts`); the heavy CLI is
 * loaded only inside a handler.
 *
 * NOTHING TAKES A DIRECT PATH. Whatever atrium (or its absence) answers, neither branch ever falls
 * through to today's local code: a create, a box-wide store write or a command about another session
 * runs on the control pod or does not run; a prompt for another session reaches atrium's message
 * queue or fails after the 600 s call-home budget.
 *
 * ⚠️ NO `cwd` IS SENT (A-9). The server runs a passed-through command in its fixed session root; a
 * client that sent one would suggest a re-rooting nobody does. A file argument travels as bytes
 * (`stdin_b64`), or — a path the control pod reads itself — as an absolute path. Held by
 * `test/pod-pass-through.test.ts` ("sends no cwd").
 */

/** C6.2: `stdin_b64` is at most 8 MiB. */
export const MAX_STDIN_BYTES = 8 * 1024 * 1024;

/**
 * Value flags whose FILE the caller reads in its own pod and the pass-through carries as bytes: the
 * argument becomes `-` and `stdin_b64` holds the content (C6.2). `--prompt-file -` in the caller's
 * argv already means "the caller's stdin" and travels the same way.
 */
export const STDIN_FILE_FLAGS: readonly string[] = Object.freeze(["--prompt-file"]);

/**
 * Value flags whose path the SUCCESSOR or the control pod reads BY PATH: made absolute against the
 * caller's cwd (a relative path would otherwise resolve against the server's `/workspace`), never
 * turned into bytes. `handover --brief` is the case that decides it: the successor is sent a prompt
 * pointing at the brief's path (`sessions handover`), so the path must survive. A path outside the
 * shared roots does not exist on the control pod and fails there, loudly, as it would anywhere.
 */
export const ABSOLUTIZED_PATH_FLAGS: readonly string[] = Object.freeze(["--brief"]);

/**
 * Create paths that take `--record-id <uuid>`: the pass-through mints one when the caller gave none,
 * so a retry after a lost answer finds the record by its `created_by_call` (C6.2 "at most once").
 */
export const RECORD_ID_CREATE_PATHS: readonly string[] = Object.freeze([
  "sessions new",
  "sessions copy",
  "sessions import",
]);

/**
 * Create paths with NO `--record-id` today — named so the discovering test in
 * `test/pod-pass-through.test.ts` fails on a NEW create path nobody sorted into one list or the other.
 * `sessions handover` is the one: its successor is `new --from` inside the verb, and the verb has no
 * flag for the record id (a retry after an unknown answer can duplicate it — reported to the stream).
 */
export const NO_RECORD_ID_CREATE_PATHS: readonly string[] = Object.freeze(["sessions handover"]);

/** A request the client cannot build: nothing was sent. Printed as a usage refusal (exit 2). */
export class PassThroughUsageError extends Error {}

export type PassThroughInput = {
  argv: readonly string[];
  commandPath: string;
  commandClass: CommandClass;
  env: NodeJS.ProcessEnv;
  /** The caller's cwd — used ONLY to make `ABSOLUTIZED_PATH_FLAGS` absolute; never sent. */
  cwd: string;
  readFile: (file: string) => Buffer;
  readStdin: () => Buffer;
  mintId: () => string;
};

export type PassThroughCall = {
  callId: string;
  /** The record id this call creates under, when it is a create that takes one. */
  recordId: string | undefined;
  body: Record<string, unknown>;
};

type Rewritten = { argv: string[]; stdin: Buffer | undefined };

function flagMatch(
  token: string,
  flags: readonly string[],
): { flag: string; inline?: string } | undefined {
  for (const flag of flags) {
    if (token === flag) {
      return { flag };
    }
    if (token.startsWith(`${flag}=`)) {
      return { flag, inline: token.slice(flag.length + 1) };
    }
  }
  return undefined;
}

/** The bytes a stdin-carried file argument stands for, read in the CALLER's pod; refused when unreadable or too big. */
function loadStdin(value: string, input: PassThroughInput): Buffer {
  const label = value === "-" ? "stdin" : value;
  let bytes: Buffer;
  try {
    bytes = value === "-" ? input.readStdin() : input.readFile(path.resolve(input.cwd, value));
  } catch (error) {
    throw new PassThroughUsageError(`could not read ${label}: ${(error as Error).message}`);
  }
  if (bytes.length > MAX_STDIN_BYTES) {
    throw new PassThroughUsageError(
      `${label} is ${bytes.length} bytes; the pass-through carries at most ${MAX_STDIN_BYTES}`,
    );
  }
  return bytes;
}

type FileFlagHit = { flag: string; inline?: string; carry: "stdin" | "path" };

function fileFlagOf(token: string): FileFlagHit | undefined {
  const stdin = flagMatch(token, STDIN_FILE_FLAGS);
  if (stdin) {
    return { ...stdin, carry: "stdin" };
  }
  const absolutized = flagMatch(token, ABSOLUTIZED_PATH_FLAGS);
  return absolutized ? { ...absolutized, carry: "path" } : undefined;
}

type RewriteState = { out: string[]; stdin: Buffer | undefined };

/** One recognised file flag with its value: stdin-carried (`-` + bytes) or made absolute. */
function rewriteFileFlag(
  hit: FileFlagHit,
  value: string,
  state: RewriteState,
  input: PassThroughInput,
): void {
  if (hit.carry === "path") {
    state.out.push(hit.flag, path.resolve(input.cwd, value));
    return;
  }
  if (state.stdin !== undefined) {
    throw new PassThroughUsageError(
      "more than one argument names a file the pass-through would carry as stdin; only one can travel",
    );
  }
  state.stdin = loadStdin(value, input);
  state.out.push(hit.flag, "-");
}

/** The argv split at a `--` terminator: file flags are looked for before it only. */
function splitAtTerminator(args: readonly string[]): { head: string[]; tail: string[] } {
  const end = args.indexOf("--");
  return end === -1
    ? { head: [...args], tail: [] }
    : { head: args.slice(0, end), tail: args.slice(end) };
}

function rewriteFileArguments(input: PassThroughInput): Rewritten {
  const state: RewriteState = { out: [], stdin: undefined };
  const { head, tail } = splitAtTerminator(input.argv);
  for (let i = 0; i < head.length; i += 1) {
    const token = head[i] ?? "";
    const hit = fileFlagOf(token);
    const value = hit?.inline ?? head[i + 1];
    if (hit === undefined || value === undefined) {
      state.out.push(token);
      continue;
    }
    i += hit.inline === undefined ? 1 : 0;
    rewriteFileFlag(hit, value, state, input);
  }
  return { argv: [...state.out, ...tail], stdin: state.stdin };
}

function hasRecordId(argv: readonly string[]): boolean {
  const end = argv.indexOf("--");
  return argv
    .slice(0, end === -1 ? undefined : end)
    .some((token) => token === "--record-id" || token.startsWith("--record-id="));
}

/** `--record-id <uuid>` goes before a `--` terminator, if there is one. */
function withRecordId(argv: string[], recordId: string): string[] {
  const end = argv.indexOf("--");
  const at = end === -1 ? argv.length : end;
  return [...argv.slice(0, at), "--record-id", recordId, ...argv.slice(at)];
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sessionOfUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    return nonEmpty(new URL(url).searchParams.get("session") ?? undefined);
  } catch {
    return undefined;
  }
}

/** C6.2 `caller`: only what the caller's own environment names — nothing fabricated, nothing else travels. */
function callerOf(env: NodeJS.ProcessEnv): Record<string, string> {
  const sessionUrl = nonEmpty(env.ACPX_SESSION_URL);
  const entries: Array<[string, string | undefined]> = [
    ["session_url", sessionUrl],
    ["seat_url", nonEmpty(env.ACPX_SEAT_URL)],
    ["record_id", nonEmpty(env.ACPX_SESSION_RECORD_ID) ?? sessionOfUrl(sessionUrl)],
    ["parent_session_url", nonEmpty(env.ACPX_PARENT_SESSION_URL)],
    ["parent_seat_url", nonEmpty(env.ACPX_PARENT_SEAT_URL)],
  ];
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** C6.2 `inherit`: only names of acpx's closed list, only when the caller's environment has them. */
function inheritOf(env: NodeJS.ProcessEnv): Record<string, string> {
  const entries = PASS_THROUGH_INHERIT.flatMap((name) => {
    const value = nonEmpty(env[name]);
    return value === undefined ? [] : [[name, value] as const];
  });
  return Object.fromEntries(entries);
}

export function buildPassThroughCall(input: PassThroughInput): PassThroughCall {
  const { argv, stdin } = rewriteFileArguments(input);
  const callId = input.mintId();
  const mintsRecordId =
    input.commandClass === "create" &&
    RECORD_ID_CREATE_PATHS.includes(input.commandPath) &&
    !hasRecordId(argv);
  const recordId = mintsRecordId ? input.mintId() : undefined;
  const finalArgv = recordId === undefined ? argv : withRecordId(argv, recordId);
  return {
    callId,
    recordId,
    // ⚠️ NO `cwd` KEY (A-9). `test/pod-pass-through.test.ts` asserts the request has none.
    body: {
      contract: 1,
      call_id: callId,
      argv: finalArgv,
      ...(stdin === undefined ? {} : { stdin_b64: stdin.toString("base64") }),
      caller: callerOf(input.env),
      admission_class: "spawn",
      inherit: inheritOf(input.env),
      deadline_ms: PASS_THROUGH_DEADLINE_MS,
    },
  };
}

// ─── the marker: a routed command is never routed twice (A-8) ─────────────────────────────────

/** C2's per-call marker: set on every command the control pod's routed call runs in an agent pod. */
export const ROUTED_MARKER_ENV = "ACPX_ROUTED";

export function isRoutedCall(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ROUTED_MARKER_ENV] === "1";
}

/** `acpx: REFUSED reason=routed_twice` — exit 2: a command that was routed would be routed again. */
export const ROUTED_TWICE_REFUSAL = {
  exitCode: 2,
  lines: [
    "acpx: REFUSED reason=routed_twice",
    "This command arrived over the control pod's routed channel (ACPX_ROUTED=1) and would be routed again; it is refused rather than looped. Nothing was started.",
  ] as [string, string],
};

// ─── the handler ──────────────────────────────────────────────────────────────────────────────

export type PassThroughIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/** The server's origin: the ladder of `acpx-ui-internal-origin.ts`, loopback forwarder last (C6.1). */
async function atriumBase(env: NodeJS.ProcessEnv): Promise<string> {
  const { resolveAtriumLocalOrigin, readAcpxUiInternalOriginSources } =
    await import("../acp/acpx-ui-internal-origin.js");
  return resolveAtriumLocalOrigin(env, readAcpxUiInternalOriginSources());
}

type AnswerBody = {
  exit?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  error?: unknown;
  reason?: unknown;
};

function asBody(value: unknown): AnswerBody {
  return typeof value === "object" && value !== null ? (value as AnswerBody) : {};
}

/** Print what atrium answered, or the failure it amounts to; returns the exit code. */
function finishAnswered(
  outcome: Extract<CallHomeOutcome, { kind: "answered" }>,
  call: PassThroughCall,
  deps: { output: OutputMode; io: PassThroughIo; context: BranchContext },
): number {
  const body = asBody(outcome.body);
  if (outcome.status === 200 && typeof body.exit === "number") {
    deps.io.stdout(typeof body.stdout === "string" ? body.stdout : "");
    deps.io.stderr(typeof body.stderr === "string" ? body.stderr : "");
    return body.exit;
  }
  // A 4xx is a refusal by the door (a 400 class-not-passable, a 403 caller gate): FINAL, never
  // retried. Any other answer (a 500, a body that is not `{exit}`): the command may have run.
  const failure =
    outcome.status >= 400 && outcome.status < 500
      ? doorRefusedFailure(outcome.status, body.error, body.reason)
      : callHomeUnknownFailure("connection", call.callId, call.recordId);
  emitCallHomeFailure(failure, deps.output, deps.context.write, deps.context.writeStdout);
  return failure.exitCode;
}

export type PassThroughRun = {
  decision: PlacementDecision & { kind: "branch" };
  context: BranchContext;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  io?: PassThroughIo;
  /** Test seams: the origin and the exchange. */
  origin?: string;
  send?: typeof atriumRequest;
  readStdin?: () => Buffer;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const defaultIo: PassThroughIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

/** A guard's refusal lines, in the placement step's wire format: both lines in text mode, line 1 otherwise. */
function refuseLines(
  decision: PlacementDecision & { kind: "branch" },
  context: BranchContext,
  lines: readonly [string, string],
  exitCode: number,
): number {
  for (const line of decision.output === "text" ? lines : [lines[0]]) {
    context.write(line);
  }
  return exitCode;
}

/** The request, or the refusal number when it cannot be built (nothing was sent). */
function buildCallOrRefuse(run: PassThroughRun, env: NodeJS.ProcessEnv): PassThroughCall | number {
  const { decision, context } = run;
  const classification = decision.classification;
  if (classification.kind !== "classified") {
    // Unreachable by the decision's own types; fail closed.
    return refuseLines(
      decision,
      context,
      ROUTED_TWICE_REFUSAL.lines,
      ROUTED_TWICE_REFUSAL.exitCode,
    );
  }
  try {
    return buildPassThroughCall({
      argv: context.argv,
      commandPath: classification.path,
      commandClass: classification.class,
      env,
      cwd: run.cwd ?? process.cwd(),
      readFile: (file) => fs.readFileSync(file),
      readStdin: run.readStdin ?? (() => fs.readFileSync(0)),
      mintId: randomUUID,
    });
  } catch (error) {
    if (!(error instanceof PassThroughUsageError)) {
      throw error;
    }
    return refuseLines(
      decision,
      context,
      [
        "acpx: REFUSED reason=pass_through_unbuildable nothing_started=true protocol=1",
        `${error.message}; nothing was started.`,
      ],
      2,
    );
  }
}

/** Post the call through the call-home loop. */
async function sendCall(
  run: PassThroughRun,
  env: NodeJS.ProcessEnv,
  call: PassThroughCall,
): Promise<CallHomeOutcome> {
  const url = `${run.origin ?? (await atriumBase(env))}/api/acpx/call`;
  const send = run.send ?? atriumRequest;
  return await callHome({
    send: () =>
      send({
        method: "POST",
        url,
        headers: { "x-source-session": nonEmpty(env.ACPX_SESSION_URL) ?? "anonymous" },
        body: call.body,
        env,
        answerTimeoutMs: callHomeAnswerTimeoutMs(PASS_THROUGH_DEADLINE_MS, env),
      }),
    env,
    ...(run.now ? { now: run.now } : {}),
    ...(run.sleep ? { sleep: run.sleep } : {}),
  });
}

export async function runPassThrough(run: PassThroughRun): Promise<number> {
  const env = run.env ?? process.env;
  const { decision, context } = run;
  if (isRoutedCall(env)) {
    return refuseLines(
      decision,
      context,
      ROUTED_TWICE_REFUSAL.lines,
      ROUTED_TWICE_REFUSAL.exitCode,
    );
  }
  const call = buildCallOrRefuse(run, env);
  if (typeof call === "number") {
    return call;
  }
  const outcome = await sendCall(run, env, call);
  if (outcome.kind === "answered") {
    return finishAnswered(outcome, call, {
      output: decision.output,
      io: run.io ?? defaultIo,
      context,
    });
  }
  const failure =
    outcome.kind === "away"
      ? atriumAwayFailure(outcome.waitedMs)
      : callHomeUnknownFailure(outcome.reason, call.callId, call.recordId);
  emitCallHomeFailure(failure, decision.output, context.write, context.writeStdout);
  return failure.exitCode;
}

registerBranchHandler("pass-through", async (decision, context) => {
  return await runPassThrough({ decision, context });
});

/**
 * `message-route`: a prompt for another session. acpx loads its world as usual and the prompt path
 * goes to atrium's message routes in call-home mode (`src/cli/prompt-routing.ts`,
 * `routed-prompt.ts`): the budget, no `atrium.json`, no direct fallback.
 */
const NOT_ROUTABLE_PROMPT_OPTIONS = ["--batch-file", "--message-id"] as const;

registerBranchHandler("message-route", async (decision, context) => {
  const refuseWith = (lines: readonly [string, string], exitCode: number): number =>
    refuseLines(decision, context, lines, exitCode);
  if (isRoutedCall()) {
    return refuseWith(ROUTED_TWICE_REFUSAL.lines, ROUTED_TWICE_REFUSAL.exitCode);
  }
  // atrium's own delivery spawns (`--message-id`, `--batch-file`) run in the RECIPIENT's pod, over the
  // routed channel; one reaching another pod's message route is a misroute, not a caller's prompt.
  const option = NOT_ROUTABLE_PROMPT_OPTIONS.find((flag) =>
    context.argv.some((token) => token === flag || token.startsWith(`${flag}=`)),
  );
  if (option !== undefined) {
    return refuseWith(
      [
        `acpx: REFUSED reason=prompt_option_not_routable nothing_started=true protocol=1 option=${option}`,
        `${option} belongs to atrium's own delivery and cannot be sent from an agent pod to another session; nothing was started.`,
      ],
      2,
    );
  }
  enterCallHomeMode();
  const { realpathSync } = await import("node:fs");
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
  if (entry) {
    const { buildQueueOwnerArgOverride } = await import("../cli/session/queue-owner-process.js");
    const queueOwnerArgOverride = buildQueueOwnerArgOverride(entry);
    if (queueOwnerArgOverride) {
      process.env.ACPX_QUEUE_OWNER_ARGS ??= queueOwnerArgOverride;
    }
  }
  const { main } = await import("../cli-core.js");
  await main(process.argv);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
});
