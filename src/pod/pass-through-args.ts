import fs from "node:fs";
import path from "node:path";
import { PASS_THROUGH_DEADLINE_MS, type UnknownAdvice } from "./call-home.js";
import { PASS_THROUGH_INHERIT, type CommandClass } from "./command-classes.js";

/**
 * The request a pass-through sends (CONTRACTS-r4 C6.2; brick 7eb9686f): acpx's arguments with every
 * file-valued argument made safe to cross pods, the closed `inherit` list, the caller's identity, and
 * — for a create — the ids that make a retry find what the first attempt made.
 *
 * ⚠️ KEEP THIS MODULE LIGHT (node builtins, `command-classes.ts`, a type from `call-home.ts`): it is
 * imported by `pass-through-branch.ts`, which `src/cli.ts` loads before acpx loads the world.
 *
 * ⚠️ NO `cwd` IS SENT (A-9). The server runs a passed-through command in its fixed session root; a
 * client that sent one would suggest a re-rooting nobody does. A file argument travels as bytes
 * (`stdin_b64`) or as an absolute path under a root the control pod shares. Held by
 * `test/pod-pass-through.test.ts` ("no cwd").
 */

/** C6.2: `stdin_b64` is at most 8 MiB. */
export const MAX_STDIN_BYTES = 8 * 1024 * 1024;

/** A request the client cannot build: nothing was sent. Printed as a usage refusal (exit 2). */
export class PassThroughUsageError extends Error {
  constructor(
    message: string,
    readonly reason: string = "pass_through_unbuildable",
  ) {
    super(message);
  }
}

/** Roots the control pod (and a handover's successor) can read a `--brief` under (ruling on checkpoint 1). */
export const BRIEF_SHARED_ROOTS: readonly string[] = Object.freeze(["/wisdom", "/workspace"]);
/** `--os` / `set-os` name an OS root "under /workspace/ or /opt/atrium-os/" (their own help). */
export const OS_SHARED_ROOTS: readonly string[] = Object.freeze(["/workspace", "/opt/atrium-os"]);

/**
 * How a file-valued argument crosses pods:
 *  - `stdin`: the caller's pod READS it; the argument becomes `-` and `stdin_b64` holds the bytes (C6.2);
 *  - `path`: the control pod (or the successor) reads it BY PATH. The path is made absolute against the
 *    caller's cwd (a relative one would resolve against the server's `/workspace`), its REAL path
 *    (symlinks followed) must lie under `roots`, and it is refused as `reason` otherwise — a pod-local
 *    path is a dead pointer (F-3).
 */
export type PathRule =
  | { carry: "stdin" }
  | {
      carry: "path";
      roots: readonly string[];
      reason: string;
      /** Values that are not paths (`--os default`). */
      skip?: (value: string) => boolean;
    };

const OS_RULE: PathRule = {
  carry: "path",
  roots: OS_SHARED_ROOTS,
  reason: "os_not_shared",
  skip: (value) => value === "" || value === "default",
};

/** File-valued VALUE flags, by flag. `--prompt-file -` already means "the caller's stdin". */
export const PATH_FLAG_RULES: Readonly<Record<string, PathRule>> = Object.freeze({
  "--prompt-file": { carry: "stdin" },
  "--brief": { carry: "path", roots: BRIEF_SHARED_ROOTS, reason: "brief_not_shared" },
  "--os": OS_RULE,
});

/**
 * File-valued OPERANDS, by command path and operand number (F-4): `sessions import <archive>` is a
 * file the caller's pod reads (A2's own tester plan expects it as `-` + stdin); `set-os <choice>` is an
 * OS root path. The discovery test in `test/pod-pass-through.test.ts` walks commander's registered
 * operands, so a NEW file-valued operand fails it until it is listed here or in its exemptions.
 */
export const PATH_OPERAND_RULES: Readonly<Record<string, Readonly<Record<number, PathRule>>>> =
  Object.freeze({
    "sessions import": { 0: { carry: "stdin" } },
    "sessions set-os": { 1: OS_RULE },
  });

const flagsWith = (carry: PathRule["carry"]): readonly string[] =>
  Object.freeze(
    Object.entries(PATH_FLAG_RULES)
      .filter(([, rule]) => rule.carry === carry)
      .map(([flag]) => flag),
  );

export const STDIN_FILE_FLAGS: readonly string[] = flagsWith("stdin");
export const ABSOLUTIZED_PATH_FLAGS: readonly string[] = flagsWith("path");

/**
 * Create paths that take `--record-id <uuid>` and `--created-by-call <uuid>`: the pass-through always
 * forwards both on the first attempt (minted unless the caller gave them), so a retry after a lost
 * answer is an IDENTICAL request that A2's replay path answers with the first answer (F-1).
 */
export const RECORD_ID_CREATE_PATHS: readonly string[] = Object.freeze([
  "sessions new",
  "sessions copy",
  "sessions import",
]);

/**
 * Create paths with NO `--record-id` today. `sessions handover` is the one: its successor is
 * `new --from` inside the verb, and the verb has no flag for the record id (brick 4bc23c1e), so a lost
 * handover answer is not retry-safe — the unknown line says so instead of advising a repeat.
 */
export const NO_RECORD_ID_CREATE_PATHS: readonly string[] = Object.freeze(["sessions handover"]);

// ─── real paths ───────────────────────────────────────────────────────────────────────────────

/**
 * The real path of `file`, symlinks followed, even when `file` does not exist yet: its deepest EXISTING
 * ancestor is resolved and the rest appended (the A1 placement code's own `resolvedPath` rule).
 */
export function realPathOf(
  file: string,
  realpath: (p: string) => string = fs.realpathSync,
): string {
  const rest: string[] = [];
  let current = file;
  for (;;) {
    try {
      return path.join(realpath(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return file;
      }
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function under(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}/`);
}

/** Is the REAL path of `absolute` under one of `roots` (or under a root's own real path)? */
export function underSharedRoot(
  absolute: string,
  roots: readonly string[],
  realpath: (p: string) => string = fs.realpathSync,
): boolean {
  const real = realPathOf(absolute, realpath);
  return roots.some((root) => under(real, root) || under(real, realPathOf(root, realpath)));
}

// ─── the argument rewrite ─────────────────────────────────────────────────────────────────────

export type PassThroughInput = {
  argv: readonly string[];
  commandPath: string;
  commandClass: CommandClass;
  /** Where the command's operands sit in `argv` (the classifier's `operandIndexes`). */
  operandIndexes?: readonly number[];
  env: NodeJS.ProcessEnv;
  /** The caller's cwd — used ONLY to make a path absolute; never sent. */
  cwd: string;
  readFile: (file: string) => Buffer;
  readStdin: () => Buffer;
  realpath?: (file: string) => string;
  mintId: () => string;
};

export type PassThroughCall = {
  callId: string;
  /** The record id this call creates under, when it is a create that takes one. */
  recordId: string | undefined;
  /** What a caller may do after `CALL_HOME outcome=unknown` for THIS command (F-1, F-1b). */
  advice: UnknownAdvice;
  body: Record<string, unknown>;
};

type RewriteState = { stdin: Buffer | undefined; stdinFromCaller: boolean };

function matchFlag(
  token: string,
  flags: Readonly<Record<string, PathRule>>,
): { flag: string; inline?: string; rule: PathRule } | undefined {
  for (const [flag, rule] of Object.entries(flags)) {
    if (token === flag) {
      return { flag, rule };
    }
    if (token.startsWith(`${flag}=`)) {
      return { flag, inline: token.slice(flag.length + 1), rule };
    }
  }
  return undefined;
}

/** The bytes a stdin-carried file argument stands for, read in the CALLER's pod. */
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

/** One file-valued argument's replacement value. */
function carry(
  rule: PathRule,
  label: string,
  value: string,
  state: RewriteState,
  input: PassThroughInput,
): string {
  if (rule.carry === "stdin") {
    if (state.stdin !== undefined) {
      throw new PassThroughUsageError(
        "more than one argument names a file the pass-through would carry as stdin; only one can travel",
      );
    }
    state.stdin = loadStdin(value, input);
    state.stdinFromCaller = value === "-";
    return "-";
  }
  if (rule.skip?.(value)) {
    return value;
  }
  const absolute = path.resolve(input.cwd, value);
  if (!underSharedRoot(absolute, rule.roots, input.realpath)) {
    throw new PassThroughUsageError(
      `${label} ${absolute} does not resolve under ${rule.roots.join(" or ")} (symlinks followed), so the control pod cannot read it`,
      rule.reason,
    );
  }
  return absolute;
}

/** The argv split at a `--` terminator: file flags are looked for before it only. */
function terminatorIndex(args: readonly string[]): number {
  const end = args.indexOf("--");
  return end === -1 ? args.length : end;
}

/** The operand rules that apply to THIS command, by the operand's index in the argv. */
function operandRulesAt(input: PassThroughInput): Map<number, { rule: PathRule; n: number }> {
  const rules = PATH_OPERAND_RULES[input.commandPath] ?? {};
  return new Map(
    (input.operandIndexes ?? []).flatMap((at, n) => {
      const rule = rules[n];
      return rule === undefined ? [] : [[at, { rule, n }] as const];
    }),
  );
}

type Rewrite = { tokens: string[]; consumed: number };

/** A flag token with its value (`--f v` or `--f=v`) → its replacement tokens, else undefined. */
function rewriteFlag(input: PassThroughInput, state: RewriteState, i: number): Rewrite | undefined {
  const hit = matchFlag(input.argv[i] ?? "", PATH_FLAG_RULES);
  const value = hit?.inline ?? input.argv[i + 1];
  if (hit === undefined || value === undefined) {
    return undefined;
  }
  const replaced = carry(hit.rule, hit.flag, value, state, input);
  return hit.inline === undefined
    ? { tokens: [hit.flag, replaced], consumed: 1 }
    : { tokens: [`${hit.flag}=${replaced}`], consumed: 0 };
}

/** What argv token `i` becomes, and how many further tokens (a flag's value) it consumed. */
function rewriteToken(
  input: PassThroughInput,
  state: RewriteState,
  i: number,
  ctx: { flagsEnd: number; operands: ReturnType<typeof operandRulesAt> },
): Rewrite {
  const token = input.argv[i] ?? "";
  const operand = ctx.operands.get(i);
  if (operand) {
    const label = `operand ${operand.n + 1}`;
    return { tokens: [carry(operand.rule, label, token, state, input)], consumed: 0 };
  }
  return (
    (i < ctx.flagsEnd ? rewriteFlag(input, state, i) : undefined) ?? {
      tokens: [token],
      consumed: 0,
    }
  );
}

export function rewriteFileArguments(input: PassThroughInput): {
  argv: string[];
  stdin: Buffer | undefined;
  stdinFromCaller: boolean;
} {
  const state: RewriteState = { stdin: undefined, stdinFromCaller: false };
  const ctx = { flagsEnd: terminatorIndex(input.argv), operands: operandRulesAt(input) };
  const out: string[] = [];
  for (let i = 0; i < input.argv.length; i += 1) {
    const step = rewriteToken(input, state, i, ctx);
    out.push(...step.tokens);
    i += step.consumed;
  }
  return { argv: out, ...state };
}

// ─── create ids ───────────────────────────────────────────────────────────────────────────────

/** The value of `--flag v` / `--flag=v` before a `--` terminator; the LAST one wins (as commander). */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  let found: string | undefined;
  const end = terminatorIndex(argv);
  for (let i = 0; i < end; i += 1) {
    const token = argv[i] ?? "";
    if (token === flag) {
      found = argv[i + 1];
    } else if (token.startsWith(`${flag}=`)) {
      found = token.slice(flag.length + 1);
    }
  }
  return found;
}

/** `tokens` go BEFORE a `--` terminator, else at the end. The one place that decides it. */
export function insertFlags(argv: readonly string[], tokens: readonly string[]): string[] {
  const at = terminatorIndex(argv);
  return [...argv.slice(0, at), ...tokens, ...argv.slice(at)];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type CreateIds = { recordId: string; callId: string; additions: string[] };

/**
 * A create's ids (F-1): the caller's `--record-id` / `--created-by-call` are kept as given; a missing
 * one is minted. The wire carries BOTH, and the `call_id` of the request IS the created-by call, so
 * a repeat that names them is the same request, byte for byte, and A2's replay answers with the first
 * record. `additions` are the tokens this function put in (to print an identical retry).
 */
function createIds(argv: readonly string[], mintId: () => string): CreateIds {
  const given = {
    record: flagValue(argv, "--record-id"),
    call: flagValue(argv, "--created-by-call"),
  };
  const recordId = given.record ?? mintId();
  const callId = given.call ?? mintId();
  return {
    recordId,
    callId,
    additions: [
      ...(given.record === undefined ? ["--record-id", recordId] : []),
      ...(given.call === undefined ? ["--created-by-call", callId] : []),
    ],
  };
}

// ─── the retry command, and what to do when it cannot be one ────────────────────────────────────

function shellQuote(token: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;
}

/** The caller's own command line with the ids this attempt added: an identical request (F-1). */
export function retryCommand(original: readonly string[], additions: readonly string[]): string {
  return ["acpx", ...insertFlags(original, additions)].map(shellQuote).join(" ");
}

/** `acpx box refresh`'s runtime-status record (the verb's own default; `box-command.ts` imports it). */
export const BOX_RUNTIME_STATUS_FILE = "/data/runtime/runtime-status.v1";

/**
 * F-1b: retry advice only where the control pod DE-DUPLICATES (a create under its ids). Any other
 * command may run twice, so the line says it is unknown whether it ran and how to find out.
 */
export function checkAdvice(commandPath: string, env: NodeJS.ProcessEnv): UnknownAdvice {
  if (commandPath === "box refresh") {
    return {
      kind: "check",
      how: `see whether the release ran: read the newest log in the box-refresh folder of your state home (the verb printed its path), and the runtime-status record ${env.NV_RUNTIME_STATUS_FILE ?? BOX_RUNTIME_STATUS_FILE}; a second \`acpx box refresh\` is refused while one runs (exit 75) but starts another release once it has ended.`,
    };
  }
  if (commandPath === "sessions handover") {
    return {
      kind: "check",
      how: "see whether the successor exists: `acpx seats show --seat <your seat url>` names the seat's active holder; handover has no record id yet, so a repeat could create a second successor.",
    };
  }
  return {
    kind: "check",
    how: "look at the state the command changes (for example `acpx seats show` or `acpx sessions show --session-id <id>`) before repeating it; a repeat is not de-duplicated and may apply twice.",
  };
}

// ─── the request ──────────────────────────────────────────────────────────────────────────────

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

/** What a caller may do after `CALL_HOME outcome=unknown`: an identical retry for a create, else a check. */
function adviceFor(
  input: PassThroughInput,
  ids: CreateIds | undefined,
  stdinFromCaller: boolean,
): UnknownAdvice {
  if (ids === undefined) {
    return checkAdvice(input.commandPath, input.env);
  }
  const stdinNote = stdinFromCaller ? " (it reads stdin: give it the same input)" : "";
  return {
    kind: "retry",
    command: `${retryCommand(input.argv, ids.additions)}${stdinNote}`,
    recordId: ids.recordId,
  };
}

export function buildPassThroughCall(input: PassThroughInput): PassThroughCall {
  const rewritten = rewriteFileArguments(input);
  const dedupes =
    input.commandClass === "create" && RECORD_ID_CREATE_PATHS.includes(input.commandPath);
  const ids = dedupes ? createIds(rewritten.argv, input.mintId) : undefined;
  const callId = ids && UUID.test(ids.callId) ? ids.callId : input.mintId();
  return {
    callId,
    recordId: ids?.recordId,
    advice: adviceFor(input, ids, rewritten.stdinFromCaller),
    // ⚠️ NO `cwd` KEY (A-9). `test/pod-pass-through.test.ts` asserts the request has none.
    body: {
      contract: 1,
      call_id: callId,
      argv: ids ? insertFlags(rewritten.argv, ids.additions) : rewritten.argv,
      ...(rewritten.stdin === undefined ? {} : { stdin_b64: rewritten.stdin.toString("base64") }),
      caller: callerOf(input.env),
      admission_class: "spawn",
      inherit: inheritOf(input.env),
      deadline_ms: PASS_THROUGH_DEADLINE_MS,
    },
  };
}
