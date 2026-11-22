// X1 test kit — the recorded atrium: a stub of atrium's port-3456 surface that records every call
// and can be "away" (CONTRACTS-r4.md C6).
//
// One file, Node standard library only, erasable TypeScript only — imported by acpx's tests
//   import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js"
// or run as a process by any repo
//   node recorded-atrium.ts --port 0 --script <file|inline json>
// (first stdout line: `{"fake":"atrium","host":"127.0.0.1","port":<n>}`).
//
// Routes: POST /api/acpx/call (C6.2) · POST /api/sessions/<id>/message · POST /api/seats/<id>/message
// · POST /api/agent-pods/<key>/ready|ended (C6.3). Everything else under /api/ is a 404.
//
// Modes (C6.1 — what a client in an agent pod meets):
//   normal   answers from the script;
//   away     the in-pod forwarder's answer: 503, `Retry-After: 5`, body {"error":"atrium-away"};
//   refused  the port refuses connections (the listener is closed; open connections are cut);
//   hang     accepts and never answers;
//   forbidden the caller gate's final 403 (C6.1: no client retries it) — the real CALLER_NOT_ALLOWED body, on every
//             route the gate guards (the hints are `public`: they are never refused).
// A script is a list of phases, each for a time (`forMs`) or a number of answered requests
// (`forRequests`), the last one for ever — "away for N seconds, then back" is
// `[{mode:"away", forMs:N}, {mode:"normal"}]`; "away for the first 3 attempts" is
// `[{mode:"away", forRequests:3}, {mode:"normal"}]`, which needs no clock at all and is how a
// test compresses the client's 600 s budget (the budget override itself lives in the client).

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

export type AtriumMode = "normal" | "away" | "refused" | "hang" | "forbidden";

export interface AtriumPhase {
  mode: AtriumMode;
  /** The phase ends this long after it began. */
  forMs?: number;
  /** The phase ends after this many requests were answered in it (not for `refused`: none arrive). */
  forRequests?: number;
}

/** What a scripted run of acpx answers (the pass-through wraps it: `{exit, stdout, stderr, delivery?}`), or a whole HTTP answer. */
export type CallAnswer =
  | { exit: number; stdout?: string; stderr?: string }
  | { status: number; body: unknown };

export interface CallRule {
  /** The argv acpx is RUN with (after atrium took a create's first message out) must start with this. Default: any. */
  argvPrefix?: string[];
  answer: CallAnswer;
  /** The rule serves this many runs, then is spent (default: for ever). */
  times?: number;
  /** Run the call (its effects are kept: the recorded first message) but cut the connection before answering. */
  loseAnswer?: boolean;
}

export interface AtriumScript {
  phases?: AtriumPhase[];
  /** Rules for the runs of `/api/acpx/call`, first matching unspent rule wins. Default answer: exit 0, empty. */
  calls?: CallRule[];
  /**
   * Answers of the two message routes: `answers` are used in order (one per message), then `default`
   * (itself default `"queued"`). `seats` maps a seat id to its holder's record id (the answer's `to` on the seat
   * route; default: a uuid derived from the seat) and `seatOf` a session id to the seat it holds (the session
   * route's `to_seat`; default: none).
   */
  messages?: {
    answers?: MessageAnswer[];
    default?: MessageAnswer;
    seats?: Record<string, string>;
    seatOf?: Record<string, string>;
    /** The recipient's name in a held sentence (the seat name, else the id's first 8 characters). */
    names?: Record<string, string>;
    /** The recipient's state — what the route refuses before it accepts; see `RecipientState`. */
    recipients?: Record<string, RecipientState>;
  };
  /** Answers of the hints; `redriven` is the number the ready hint reports (default 0). Default status 200. */
  hints?: { status?: number; body?: unknown; redriven?: number };
  /** The first message of a create is held for room: `delivery.held` (atrium's answer for a held first item). */
  firstMessageHold?: { reason: string; ahead?: number };
  /**
   * What acpx's answer to a create carries for atrium to queue besides the caller's message: a fork notice (a copy's),
   * a template's prompt (used when the caller gave no message). With either, `delivery` names the message, else the notice.
   */
  forkNotice?: string;
  templatePrompt?: string;
  /**
   * Who is calling, as atrium's gate classifies the peer: `local` (default) or `agent-pod`. With `agent-pod`,
   * `agentPod` names the pod: a session pod (`sessionKey`) may claim only the caller whose record id hashes to
   * that key; a `utility` pod claims no caller at all — else `403 {"error":"caller-mismatch"}`.
   */
  callerClass?: "local" | "agent-pod";
  /**
   * Atrium resolves the target of a record / owner-if-pod command against the control pod's session store and
   * REFUSES one it cannot (`400 class-not-passable`, `target-unresolved`). The kit's classifier runs in the
   * test's own process, so every target resolves to nothing there: this makes an unresolved target resolve to
   * the given record id instead (a session that exists on the control pod).
   */
  resolveTargetAs?: string;
  /**
   * The HOME (holding `.acpx`) of the control pod's session store, which atrium resolves a record target against. The
   * kit NEVER touches a store it was not given: without `stateHome` a target resolves to nothing (`target-unresolved`,
   * unless `resolveTargetAs`), and the test process's own HOME is never read or written. With it, a long-lived child
   * process resolves targets with acpx's own resolver and HOME = `stateHome` (every `ACPX_*` variable removed).
   */
  stateHome?: string;
  agentPod?: { sessionKey?: string; utility?: boolean };
}

/**
 * Atrium's message answer (acpx-ui `server/message-routes.ts` `messageAnswer`): EVERY accepted message is
 * **202** `{delivery_id, from, to, to_seat?, status:"queued"}` — `status` is always "queued". `"held"` /
 * `{held:{reason, ahead?}}`: the same, ALSO carrying `held:{since, reason, ahead}` and `message:<heldSentence>`
 * (reason default `pod_starting`, or `agent_cap`). `{status, body}` — any other answer, verbatim.
 */
export type MessageAnswer =
  | "queued"
  | "held"
  | { held: { reason: string; ahead?: number } }
  | { status: number; body: unknown };

/**
 * What a message route refuses before it accepts (message-routes.ts): `unknown` (404; on the seat route `not-a-seat`),
 * `not-a-seat` (404, seat route), `vacant` (409 SEAT_VACANT, seat route), `archived` (409 SESSION_ARCHIVED),
 * `template` (409), `closing` (409 SESSION_CLOSING), `closed` (409 SESSION_CLOSED unless the body says `reopen:true`).
 */
export type RecipientState =
  | "unknown"
  | "not-a-seat"
  | "vacant"
  | "archived"
  | "template"
  | "closing"
  | "closed";

/**
 * The names a create may inherit from its creator's environment (C6.2 `inherit`): a closed list kept in
 * acpx — `PASS_THROUGH_INHERIT` in src/pod/command-classes.ts. A COPY, on purpose: this file must run as a bare
 * Node process (`node recorded-atrium.ts`), where it cannot import acpx's `.js`-specifier sources. The
 * self-test `INHERIT_ALLOWED equals PASS_THROUGH_INHERIT` goes red if they drift.
 */
export const INHERIT_ALLOWED: readonly string[] = ["ACPX_SUBSCRIPTION", "ATRIUM_OS"];

/** What atrium needs of acpx's `classifyCall` (the shape of its answer, read by `passability`). */
export interface CallClassification {
  kind: string;
  path?: string;
  class?: string;
  help?: boolean;
  targetSessionId?: string | null;
}
export type Classify = (argv: readonly string[]) => Promise<CallClassification>;

export type AtriumRoute =
  | "call"
  | "session_message"
  | "seat_message"
  | "hint_ready"
  | "hint_ended"
  | "unknown";

export interface AtriumRequestRecord {
  seq: number;
  atMs: number;
  method: string;
  path: string;
  route: AtriumRoute;
  /** The `<id>` of a message route, the `<key>` of a hint. */
  target: string | null;
  headers: Record<string, string>;
  bodyText: string;
  /** The body as atrium's `express.json` sees it: parsed only for `Content-Type: application/json`, else null. */
  body: Record<string, unknown> | null;
  /** The call's stdin_b64, decoded as utf-8; null when absent. */
  stdin: string | null;
  /** The argv acpx was RUN with (a create's first message taken out), null when nothing ran. */
  ranArgv: string[] | null;
  /** Departures from C6.2 / C6.3 that atrium itself does not refuse: `cwd_present`, a hint's shape. */
  problems: string[];
  mode: AtriumMode;
  /** What the fake did: answered | refused:<error> | replayed | lost_answer | away | forbidden | hang … */
  outcome: string;
  status: number | null;
  /** /api/acpx/call only. */
  callId: string | null;
  /** A create whose first message was already recorded under this call id (answered `delivery.replay:true`). */
  replayed: boolean;
}

/** atrium's actor, as `sameSender` compares it (server/deliveryIdOwnership.ts): an agent by seat, then session, then label. */
interface Actor {
  kind: "agent" | "unattributed";
  seat_id?: string;
  session_id?: string;
  label?: string;
}

interface RecordedItem {
  /** Who first sent under this wire id. */
  actor: Actor;
  text: string;
}

/** The actor of a message route: from `X-Source-Session` ONLY (a body `from` is not an identity); absent / anonymous = unattributed. */
function actorOfHeader(header: string | undefined): Actor {
  const value = (header ?? "").trim();
  if (value === "" || value === "anonymous") {
    return { kind: "unattributed" };
  }
  const seat = /[?&]seat=([^&#]+)/.exec(value)?.[1];
  const session = /[?&]session=([^&#]+)/.exec(value)?.[1];
  if (seat !== undefined || session !== undefined) {
    return {
      kind: "agent",
      ...(seat === undefined ? {} : { seat_id: decodeURIComponent(seat) }),
      ...(session === undefined ? {} : { session_id: decodeURIComponent(session) }),
    };
  }
  // a bare id: a record uuid is a session; anything else is a self-chosen label
  return UUID_RE.test(value)
    ? { kind: "agent", session_id: value.toLowerCase() }
    : { kind: "agent", label: value };
}

/** The actor of a pass-through call: the claimed caller's session and seat. */
function actorOfCaller(caller: { record_id: string; seat_url?: string }): Actor {
  const seat =
    caller.seat_url === undefined ? undefined : /[?&]seat=([^&#]+)/.exec(caller.seat_url)?.[1];
  return {
    kind: "agent",
    session_id: caller.record_id,
    ...(seat === undefined ? {} : { seat_id: decodeURIComponent(seat) }),
  };
}

/** `sameSender`: the same SEAT when both carry one (a successor keeps it), else the session, else the label; `unattributed` never matches. */
function sameActor(a: Actor, b: Actor): boolean {
  if (a.kind !== "agent" || b.kind !== "agent") {
    return false;
  }
  if (a.seat_id !== undefined && b.seat_id !== undefined) {
    return a.seat_id === b.seat_id;
  }
  if (a.session_id !== undefined || b.session_id !== undefined) {
    return a.session_id !== undefined && a.session_id === b.session_id;
  }
  if (a.seat_id !== undefined || b.seat_id !== undefined) {
    return false;
  }
  return a.label !== undefined && a.label === b.label;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const MAX_DEADLINE_MS = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "image",
  "resource",
  "resource_link",
  "audio",
]);
const DELIVERY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADMISSION_CLASSES: ReadonlySet<string> = new Set([
  "interactive",
  "delivery",
  "automation",
  "spawn",
]);

interface Refusal {
  status: number;
  body: Record<string, unknown>;
}

interface CallBody {
  callId: string;
  argv: string[];
  stdin: Buffer | null;
  caller: { session_url: string; record_id: string; seat_url?: string } | null;
  inherit: Record<string, string>;
}

const bad = (error: string, extra: Record<string, unknown> = {}): Refusal => ({
  status: 400,
  body: { error, ...extra },
});

/** acpx-ui `server/acpxCall/passThrough.ts` `parseCallBody` — the same checks in the same order. */
function parseCallBody(
  raw: unknown,
): { ok: true; body: CallBody } | { ok: false; refusal: Refusal } {
  const b: Record<string, unknown> = isRecord(raw) ? raw : {};
  const fail = (refusal: Refusal) => ({ ok: false as const, refusal });
  if (b.contract !== 1) {
    return fail(bad("unsupported-contract", { contract: b.contract ?? null }));
  }
  const callId = b.call_id;
  if (typeof callId !== "string" || !UUID_RE.test(callId)) {
    return fail(bad("bad-call-id"));
  }
  const argv = b.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) {
    return fail(bad("bad-argv"));
  }
  let stdin: Buffer | null = null;
  if (b.stdin_b64 !== undefined) {
    const encoded = b.stdin_b64;
    if (
      typeof encoded !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
      encoded.length % 4 !== 0
    ) {
      return fail(bad("bad-stdin"));
    }
    // the decoded size from the length, before decoding: an oversize body is refused without allocating it
    const decoded =
      (encoded.length / 4) * 3 - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
    if (decoded > MAX_STDIN_BYTES) {
      return fail({
        status: 413,
        body: { error: "stdin-too-large", limit_bytes: MAX_STDIN_BYTES },
      });
    }
    stdin = Buffer.from(encoded, "base64");
  }
  const rawCaller = b.caller ?? null;
  let caller: CallBody["caller"] = null;
  if (rawCaller !== null) {
    const c = rawCaller as Record<string, unknown>;
    const str = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";
    if (
      typeof rawCaller !== "object" ||
      !str(c.session_url) ||
      typeof c.record_id !== "string" ||
      !UUID_RE.test(c.record_id)
    ) {
      return fail(bad("bad-caller"));
    }
    for (const field of ["seat_url", "parent_session_url", "parent_seat_url"]) {
      if (c[field] !== undefined && !str(c[field])) {
        return fail(bad("bad-caller", { field }));
      }
    }
    caller = {
      session_url: c.session_url as string,
      record_id: c.record_id.toLowerCase(),
      ...(c.seat_url ? { seat_url: c.seat_url as string } : {}),
    };
  }
  const admission = b.admission_class;
  if (
    admission !== undefined &&
    (typeof admission !== "string" || !ADMISSION_CLASSES.has(admission))
  ) {
    return fail(bad("bad-admission-class"));
  }
  const rawInherit = b.inherit ?? {};
  if (typeof rawInherit !== "object" || rawInherit === null || Array.isArray(rawInherit)) {
    return fail(bad("bad-inherit"));
  }
  const inherit: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawInherit)) {
    if (typeof value !== "string") {
      return fail(bad("inherit-not-string", { name }));
    }
    inherit[name] = value;
  }
  const deadline = b.deadline_ms ?? MAX_DEADLINE_MS;
  if (
    typeof deadline !== "number" ||
    !Number.isInteger(deadline) ||
    deadline < 1 ||
    deadline > MAX_DEADLINE_MS
  ) {
    return fail(bad("bad-deadline", { max_ms: MAX_DEADLINE_MS }));
  }
  // `cwd` (A-9) is deliberately not read.
  return {
    ok: true,
    body: { callId: callId.toLowerCase(), argv, stdin, caller, inherit },
  };
}

/** `--flag value` and `--flag=value`: every occurrence with its index span; stops at `--` (passThrough.ts `findFlag`). */
function findFlag(
  argv: readonly string[],
  flag: string,
): Array<{ index: number; span: number; value: string | undefined }> {
  const out: Array<{ index: number; span: number; value: string | undefined }> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--") {
      break;
    }
    if (arg === flag) {
      out.push({ index, span: 2, value: argv[index + 1] });
    } else if (arg.startsWith(`${flag}=`)) {
      out.push({ index, span: 1, value: arg.slice(flag.length + 1) });
    }
  }
  return out;
}

type PreparedCreate =
  | { ok: true; argv: string[]; recordId: string; message: string | null; stdinUsed: boolean }
  | { ok: false; refusal: Refusal };

/** passThrough.ts `prepareCreate`: the checks of a create's flags, and the first message taken out in place. */
function prepareCreate(
  argv: readonly string[],
  stdin: Buffer | null,
  callId: string,
): PreparedCreate {
  const fail = (refusal: Refusal): PreparedCreate => ({ ok: false, refusal });
  const ids = findFlag(argv, "--record-id");
  const first = ids[0];
  if (ids.length !== 1 || first?.value === undefined || !UUID_RE.test(first.value)) {
    return fail(bad("record-id-required"));
  }
  const recordId = first.value.toLowerCase();
  // A-27: the client owns both flags; a `--created-by-call` that is not `call_id` is refused.
  if (findFlag(argv, "--created-by-call").some((f) => f.value?.toLowerCase() !== callId)) {
    return fail(bad("call-id-mismatch"));
  }
  const prompts = findFlag(argv, "--prompt");
  const promptFiles = findFlag(argv, "--prompt-file");
  if (prompts.length + promptFiles.length > 1) {
    return fail(bad("more-than-one-first-message"));
  }
  let message: string | null = null;
  let stdinUsed = false;
  const prompt = prompts[0];
  const promptFile = promptFiles[0];
  if (prompt !== undefined) {
    if (prompt.value === undefined) {
      return fail(bad("bad-argv", { flag: "--prompt" }));
    }
    message = prompt.value;
  } else if (promptFile !== undefined) {
    // the file lives in the caller's pod; the server never reads a caller's path
    if (promptFile.value !== "-") {
      return fail(bad("class-not-passable", { reason: "file-argument", flag: "--prompt-file" }));
    }
    if (stdin === null) {
      return fail(bad("stdin-required", { flag: "--prompt-file" }));
    }
    message = stdin.toString("utf8");
    stdinUsed = true;
  }
  const drop = new Set<number>();
  for (const f of [...prompts, ...promptFiles]) {
    for (let k = 0; k < f.span; k += 1) {
      drop.add(f.index + k);
    }
  }
  return {
    ok: true,
    argv: argv.filter((_, index) => !drop.has(index)),
    recordId,
    message,
    stdinUsed,
  };
}

/**
 * Fallback when acpx's class table cannot be loaded (a BARE process: `node recorded-atrium.ts`, where acpx's `.js`
 * specifiers do not resolve from source). The real door refuses EVERY call then — creates included
 * (`class-not-passable`, `table-unavailable`, passThrough.ts:539-545) — and so does the kit: a bare process answers the
 * pass-through only with its refusals. Use the in-process kit (or an injected `classify`) to see a call through.
 */
const fallbackClassify: Classify = async () => ({ kind: "table-unavailable", path: "" });

/** What the in-process kit loads of acpx: the class table's SYNCHRONOUS classifier (no store access). */
interface ClassTableModule {
  classifyArgv: (
    argv: readonly string[],
    options: { builtInAgents: readonly string[] },
  ) => {
    kind: string;
    path: string;
    class?: string;
    help?: boolean;
    target?: unknown;
  };
  builtInAgents: readonly string[];
}

let loadedTable: ClassTableModule | null | undefined;
async function loadClassTable(): Promise<ClassTableModule | null> {
  if (loadedTable === undefined) {
    try {
      // compiled, in acpx's suite: dist-test/src/pod/command-classes.js; from bare source it does not resolve
      const classes = (await import("../../src/pod/command-classes.js")) as Pick<
        ClassTableModule,
        "classifyArgv"
      >;
      const registry = (await import("../../src/agent-registry.js")) as {
        listBuiltInAgents: () => readonly string[];
      };
      loadedTable = {
        classifyArgv: classes.classifyArgv,
        builtInAgents: registry.listBuiltInAgents(),
      };
    } catch {
      loadedTable = null;
    }
  }
  return loadedTable;
}

/** acpx's `TARGET_CLASSES`: the classes whose passability depends on WHICH session the call is about. */
const TARGET_CLASSES: ReadonlySet<string> = new Set(["record", "owner-if-pod", "owner-ensure"]);

const RESOLVER_CHILD = `
const m = await import(process.argv[1]);
process.stdout.write("ready\\n");
let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    const { id, target } = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id, record: await m.resolveTargetRecordId(target) }) + "\\n");
  }
});
`;

/** commandClasses.ts `passability`. */
function passability(
  c: CallClassification,
  callerRecordId: string,
): { ok: true; class: string } | { ok: false; reason: string } {
  if (c.kind === "table-unavailable") {
    return { ok: false, reason: "table-unavailable" };
  }
  if (c.kind !== "classified") {
    return { ok: false, reason: "unclassified" };
  }
  if (c.help === true) {
    return { ok: false, reason: "help" };
  }
  if (c.class === "create" || c.class === "control-store") {
    return { ok: true, class: c.class };
  }
  if (c.class === "record" || c.class === "owner-if-pod") {
    if (c.targetSessionId === undefined || c.targetSessionId === null || c.targetSessionId === "") {
      return { ok: false, reason: "target-unresolved" };
    }
    if (c.targetSessionId === callerRecordId) {
      return { ok: false, reason: "own-session" };
    }
    return { ok: true, class: c.class };
  }
  return { ok: false, reason: "class" };
}

const SHARED_ROOTS = ["/workspace", "/wisdom", "/spaces", "/opt/atrium-os", "/home/node/.acpx"];

/** A handover's `--brief` is read on the control pod: absolute, under a shared root (passThrough.ts `handoverBriefShared`). */
function handoverBriefShared(argv: readonly string[]): boolean {
  for (const f of findFlag(argv, "--brief")) {
    if (f.value === undefined) {
      continue;
    }
    if (
      !f.value.startsWith("/") ||
      !SHARED_ROOTS.some((root) => f.value === root || f.value?.startsWith(`${root}/`) === true)
    ) {
      return false;
    }
  }
  return true;
}

/** acpx's `createRequestFingerprint`: the create's argv (the one acpx is run with) — any other request differs. */
function requestFingerprint(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}

function replayMismatchText(recordId: string): string {
  return `CREATE_REPLAY_MISMATCH: record ${recordId} was created by this call id with a different first message; a replay must be the identical request, so nothing was queued and the first answer is not returned for it`;
}

/** acpx's error answer: text on stderr, or with `--format json` a JSON-RPC error on STDOUT and stderr empty. */
function jsonAwareError(
  exit: number,
  message: string,
  acpxCode: "RUNTIME" | "USAGE",
  json: boolean,
  detailCode?: string,
): { exit: number; stdout: string; stderr: string } {
  if (!json) {
    return { exit, stdout: "", stderr: `${message}\n` };
  }
  const rpc = {
    jsonrpc: "2.0",
    id: null,
    error: {
      code: acpxCode === "USAGE" ? -32602 : -32603,
      message,
      data: {
        acpxCode,
        ...(detailCode === undefined ? {} : { detailCode }),
        origin: "cli",
        sessionId: "unknown",
      },
    },
  };
  return { exit, stdout: `${JSON.stringify(rpc)}\n`, stderr: "" };
}

function uuidFromText(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** RFC 4122 v5 UUID (automatedStarts.ts `uuid5`): a replay derives the same id. */
function uuid5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name).digest();
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The fork notice's wire id: `forkNoticeItemId({openingId: call_id})` = uuid5(call_id, "fork-notice"). */
function forkNoticeId(callId: string): string {
  return uuid5(callId, "fork-notice");
}

function sessionKeyOfRecord(recordId: string): string {
  return createHash("sha256").update(recordId).digest("hex").slice(0, 24);
}

/** capacityHold.ts `heldSentence` (the two reasons a pod hold has; any other reads as "no room"). */
function heldSentence(
  reason: string,
  deliveryId: string,
  recipient: string,
  ahead: number,
): string {
  const place = ahead <= 0 ? "next in line" : `${String(ahead)} ahead`;
  if (reason === "paused") {
    return `Held (delivery ${deliveryId}): a person paused ${recipient}'s queue; the message is stored and is delivered when the pause ends. Nothing more to do — it is not a failure.`;
  }
  if (reason === "held-by-policy") {
    return `Held (delivery ${deliveryId}): ${recipient} is being held deliberately; the message is stored and is delivered when the hold ends. Nothing more to do — it is not a failure.`;
  }
  if (reason === "pod_starting") {
    return `Starting (delivery ${deliveryId}): ${recipient}'s agent is starting; the message is stored and is delivered as soon as it is ready. Nothing more to do — it is not a failure.`;
  }
  if (reason === "agent_cap") {
    return `Queued for room (delivery ${deliveryId}): ${recipient} has no running agent and the box cannot start another agent now (${place}). The message is stored, survives restarts, and is delivered when an agent ends, together with everything else waiting for ${recipient}. Nothing more to do — it is not a failure.`;
  }
  return `Queued for room (delivery ${deliveryId}): ${recipient} has no running agent and the box has no room to start one now (${place}). The message is stored, survives restarts, and is delivered when room frees, together with everything else waiting for ${recipient}. Nothing more to do — it is not a failure.`;
}

function validateHint(kind: "ready" | "ended", body: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const pod = body.pod;
  if (kind === "ready") {
    if (body.contract !== 1) {
      problems.push("contract");
    }
    if (!isRecord(pod) || !isString(pod.name) || !isString(pod.uid) || !isString(pod.node)) {
      problems.push("pod");
    }
    if (body.placement !== "pool" && body.placement !== "home") {
      problems.push("placement");
    }
    if (!isRecord(body.releases)) {
      problems.push("releases");
    }
  } else {
    if (!isRecord(pod) || !isString(pod.uid)) {
      problems.push("pod");
    }
    // C6.3: an open set (`idle`, `closed`, `stale-release`, `deadline`, `term`, `unused`, …): any non-empty string.
    if (!isString(body.reason)) {
      problems.push("reason");
    }
  }
  return problems;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export class RecordedAtrium {
  readonly requests: AtriumRequestRecord[] = [];
  private script: AtriumScript;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly startedAt = Date.now();
  /** The first-message items recorded under a call id (atrium's delivery store): what makes a repeat a replay. */
  private readonly items = new Map<string, RecordedItem>();
  private readonly classifyOverride: Classify | undefined;
  /** record id -> the `--created-by-call` of the create that made it (acpx's own record store, as far as atrium sees it). */
  private readonly createdRecords = new Map<string, { call: string; fingerprint: string }>();
  private resolver: ChildProcess | null = null;
  private resolverReady: Promise<void> | null = null;
  private readonly resolverPending = new Map<number, (record: string | null) => void>();
  private resolverSeq = 0;
  private readonly rulesLeft = new Map<CallRule, number>();
  private phases: AtriumPhase[] = [{ mode: "normal" }];
  private messagesAnswered = 0;
  private phaseIndex = 0;
  private answeredInPhase = 0;
  private phaseTimer: NodeJS.Timeout | undefined;
  private listening = false;
  private boundPort = 0;
  private hostName = "127.0.0.1";

  constructor(script: AtriumScript = {}, classify?: Classify) {
    this.script = script;
    this.classifyOverride = classify;
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end(JSON.stringify({ error: "fake_atrium_bug", detail: String(error) }));
      });
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<number> {
    this.hostName = host;
    // Warm what the first call would otherwise pay inside its answer time — a client with a 600 ms answer bound
    // reads a kit delay as "unknown": the class table, and (only with a `stateHome`) the resolver child.
    if (this.classifyOverride === undefined) {
      await loadClassTable();
      if (this.script.stateHome !== undefined) {
        await this.startResolver(this.script.stateHome);
      }
    }
    await this.bind(port);
    this.boundPort = (this.server.address() as AddressInfo).port;
    this.applyScript(this.script);
    return this.boundPort;
  }

  get port(): number {
    return this.boundPort;
  }

  get url(): string {
    return `http://${this.hostName}:${String(this.boundPort)}`;
  }

  /** The mode in force now. */
  get mode(): AtriumMode {
    return this.phases[this.phaseIndex]?.mode ?? "normal";
  }

  async close(): Promise<void> {
    clearTimeout(this.phaseTimer);
    this.resolver?.kill("SIGTERM");
    this.resolver = null;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    if (this.listening) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.listening = false;
    }
  }

  /** New script (phases restart at its first); the record stays. */
  setScript(script: AtriumScript): void {
    this.script = script;
    this.applyScript(script);
  }

  /** Switch mode now. With `forMs`, back to normal after that long; without, until changed. */
  setMode(mode: AtriumMode, forMs?: number): void {
    this.setPhases(forMs === undefined ? [{ mode }] : [{ mode, forMs }, { mode: "normal" }]);
  }

  reset(): void {
    this.requests.length = 0;
    this.items.clear();
    this.createdRecords.clear();
    this.messagesAnswered = 0;
  }

  requestsFor(route: AtriumRoute): AtriumRequestRecord[] {
    return this.requests.filter((entry) => entry.route === route);
  }

  /** The resolver child: acpx's own `resolveTargetRecordId`, with HOME = the store the test gave the kit. */
  private startResolver(stateHome: string): Promise<void> {
    if (this.resolverReady !== null) {
      return this.resolverReady;
    }
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.startsWith("ACPX_") && name !== "NODE_TEST_CONTEXT") {
        env[name] = value;
      }
    }
    env.HOME = stateHome;
    const target = pathToFileURL(
      fileURLToPath(new URL("../../src/pod/target-resolver.js", import.meta.url)),
    ).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", RESOLVER_CHILD, target], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.resolver = child;
    let buffer = "";
    this.resolverReady = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => {
        for (const settle of this.resolverPending.values()) {
          settle(null);
        }
        this.resolverPending.clear();
        reject(new Error("the resolver child exited"));
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (line === "ready") {
            resolve();
            continue;
          }
          const answer = JSON.parse(line) as { id: number; record: string | null };
          this.resolverPending.get(answer.id)?.(answer.record);
          this.resolverPending.delete(answer.id);
        }
      });
    });
    this.resolverReady.catch(() => undefined);
    return this.resolverReady;
  }

  private async resolveTarget(target: unknown): Promise<string | null> {
    const home = this.script.stateHome;
    if (home === undefined || target === undefined) {
      return null; // no store was given: nothing is read, nothing is written
    }
    try {
      await this.startResolver(home);
    } catch {
      return null;
    }
    const id = (this.resolverSeq += 1);
    return await new Promise<string | null>((resolve) => {
      this.resolverPending.set(id, resolve);
      this.resolver?.stdin?.write(`${JSON.stringify({ id, target })}\n`);
    });
  }

  /** acpx's class table as atrium uses it (`classifyCall`), minus any access to a store the test did not give. */
  private async classifyFor(argv: string[]): Promise<CallClassification> {
    if (this.classifyOverride !== undefined) {
      return await this.classifyOverride(argv);
    }
    const table = await loadClassTable();
    if (table === null) {
      return await fallbackClassify(argv);
    }
    const c = table.classifyArgv(argv, { builtInAgents: table.builtInAgents });
    if (c.kind !== "classified") {
      return { kind: c.kind, path: c.path };
    }
    const base: CallClassification = {
      kind: c.kind,
      path: c.path,
      ...(c.class === undefined ? {} : { class: c.class }),
      help: c.help === true,
    };
    if (c.class === undefined || !TARGET_CLASSES.has(c.class)) {
      return base;
    }
    const resolved = await this.resolveTarget(c.target);
    return { ...base, targetSessionId: resolved };
  }

  private applyScript(script: AtriumScript): void {
    this.rulesLeft.clear();
    this.messagesAnswered = 0;
    for (const rule of script.calls ?? []) {
      if (rule.times !== undefined) {
        this.rulesLeft.set(rule, rule.times);
      }
    }
    this.setPhases(script.phases ?? [{ mode: "normal" }]);
  }

  private bind(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, this.hostName, () => {
        this.server.off("error", reject);
        this.listening = true;
        resolve();
      });
    });
  }

  private setPhases(phases: AtriumPhase[]): void {
    this.phases = phases;
    this.enterPhase(0);
  }

  private enterPhase(index: number): void {
    clearTimeout(this.phaseTimer);
    this.phaseIndex = Math.min(index, this.phases.length - 1);
    this.answeredInPhase = 0;
    const phase = this.phases[this.phaseIndex];
    if (phase === undefined) {
      return;
    }
    if (phase.mode === "refused") {
      if (this.listening) {
        this.listening = false;
        for (const socket of this.sockets) {
          socket.destroy();
        }
        this.server.close();
      }
    } else if (!this.listening) {
      this.bind(this.boundPort).catch(() => undefined);
    }
    if (phase.forMs !== undefined && this.phaseIndex < this.phases.length - 1) {
      this.phaseTimer = setTimeout(() => this.enterPhase(this.phaseIndex + 1), phase.forMs);
    }
  }

  private afterAnswer(): void {
    this.answeredInPhase += 1;
    const phase = this.phases[this.phaseIndex];
    if (
      phase?.forRequests !== undefined &&
      this.answeredInPhase >= phase.forRequests &&
      this.phaseIndex < this.phases.length - 1
    ) {
      this.enterPhase(this.phaseIndex + 1);
    }
  }

  private sendJson(
    response: ServerResponse,
    record: AtriumRequestRecord,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    record.status = status;
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://fake-atrium.invalid").pathname;
    const record: AtriumRequestRecord = {
      seq: this.requests.length + 1,
      atMs: Date.now() - this.startedAt,
      method,
      path,
      route: "unknown",
      target: null,
      headers: {},
      bodyText: "",
      body: null,
      stdin: null,
      ranArgv: null,
      problems: [],
      mode: this.mode,
      outcome: "pending",
      status: null,
      callId: null,
      replayed: false,
    };
    for (const [name, value] of Object.entries(request.headers)) {
      record.headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
    }
    record.bodyText = await readBody(request);
    // `express.json()` (the global parser): only `Content-Type: application/json` is parsed, anything else
    // leaves `req.body = {}`; a malformed JSON body is the framework's own 400.
    let malformed = false;
    if (
      path.startsWith("/_kit/") ||
      /^application\/json\b/i.test(record.headers["content-type"] ?? "")
    ) {
      try {
        const parsed: unknown = JSON.parse(record.bodyText);
        record.body = isRecord(parsed) ? parsed : {};
      } catch {
        malformed = record.bodyText.trim().length > 0;
        record.body = null;
      }
    }
    this.requests.push(record);

    if (path.startsWith("/_kit/")) {
      this.handleControl(method, path, record, response);
      return;
    }
    this.classify(method, path, record);
    if (record.mode === "hang") {
      record.outcome = "hang";
      this.afterAnswer();
      return;
    }
    // the in-pod forwarder answers before atrium is asked; atrium's gate guards every route but the public hints
    if (record.mode === "away") {
      record.outcome = "away";
      this.sendJson(
        response,
        record,
        503,
        { error: "atrium-away" },
        { "retry-after": "5", connection: "close" },
      );
      this.afterAnswer();
      return;
    }
    // callerGate `isAllowed`: `public` (the hints) AND `messaging` (both message routes) are open to every caller —
    // only the control route (the pass-through) is ever refused
    if (record.mode === "forbidden" && record.route === "call") {
      record.outcome = "forbidden";
      this.sendJson(response, record, 403, {
        error:
          "This route is not available to this caller. Run the command on the target box itself (ssh-remote), or use the UI.",
        code: "CALLER_NOT_ALLOWED",
        caller_class: "remote",
        route_class: "control",
      });
      this.afterAnswer();
      return;
    }
    if (malformed) {
      record.outcome = "bad_json";
      record.status = 400;
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end("<!DOCTYPE html><html><body><pre>Bad Request</pre></body></html>");
      this.afterAnswer();
      return;
    }
    await this.route(record, request, response);
    this.afterAnswer();
  }

  /** Which route this is — known before the mode decides the answer, so an away call is still a "call". */
  private classify(method: string, path: string, record: AtriumRequestRecord): void {
    if (method !== "POST") {
      return;
    }
    const message = /^\/api\/(sessions|seats)\/([^/]+)\/message$/.exec(path);
    const hint = /^\/api\/agent-pods\/([^/]+)\/(ready|ended)$/.exec(path);
    if (path === "/api/acpx/call") {
      record.route = "call";
      const callId = record.body?.call_id;
      record.callId = typeof callId === "string" ? callId : null;
    } else if (message !== null) {
      record.route = message[1] === "sessions" ? "session_message" : "seat_message";
      record.target = message[2] ?? null;
    } else if (hint !== null) {
      record.route = hint[2] === "ready" ? "hint_ready" : "hint_ended";
      record.target = hint[1] ?? null;
    }
  }

  private async route(
    record: AtriumRequestRecord,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (record.route === "call") {
      await this.handleCall(record, request, response);
    } else if (record.route === "session_message" || record.route === "seat_message") {
      this.handleMessage(record, response);
    } else if (record.route === "hint_ready" || record.route === "hint_ended") {
      this.handleHint(record, response);
    } else {
      record.outcome = "not_found";
      this.sendJson(response, record, 404, { error: "not-found" });
    }
  }

  private handleHint(record: AtriumRequestRecord, response: ServerResponse): void {
    const kind = record.route === "hint_ready" ? "ready" : "ended";
    const key = record.target ?? "";
    if (!/^[0-9a-f]{24}$/.test(key)) {
      record.outcome = "refused:bad-key";
      this.sendJson(response, record, 400, {
        error: "bad-key",
        expected: "24 lower-case hex characters (the session key, C2)",
      });
      return;
    }
    const body = record.body ?? {};
    // Contract rule 1: a version this side does not know is refused by name; an ABSENT contract is not.
    if (kind === "ready" && body.contract !== undefined && body.contract !== 1) {
      record.outcome = "refused:unsupported-contract";
      this.sendJson(response, record, 400, {
        error: "unsupported-contract",
        contract: body.contract,
      });
      return;
    }
    // what a client should have sent (atrium trusts it for nothing but a re-drive): kit-level, not a refusal
    record.problems = record.body === null ? ["body"] : validateHint(kind, record.body);
    record.outcome = "answered";
    const answer = this.script.hints ?? {};
    this.sendJson(
      response,
      record,
      answer.status ?? 200,
      answer.body ??
        (kind === "ready" ? { ok: true, redriven: answer.redriven ?? 0 } : { ok: true }),
    );
  }

  /** `POST /api/sessions/:id/message` and `/api/seats/:seat/message` (message-routes.ts). */
  private handleMessage(record: AtriumRequestRecord, response: ServerResponse): void {
    const messages = this.script.messages ?? {};
    const body = record.body ?? {};
    const refuse = (error: string, extra: Record<string, unknown> = {}): void => {
      record.outcome = `refused:${typeof extra.code === "string" ? extra.code : error}`;
      this.sendJson(response, record, 400, { error, ...extra });
    };
    // parseMessageBody: `content` blocks, `text`, `delivery_id` a lowercase UUID, `task_options`
    let blocks: Array<Record<string, unknown>> = [];
    if (body.content !== undefined && body.content !== null) {
      if (!Array.isArray(body.content) || body.content.length === 0) {
        refuse("content must be a non-empty array of ACP content blocks", { code: "bad-content" });
        return;
      }
      for (const block of body.content as unknown[]) {
        const b = block as Record<string, unknown>;
        if (!isRecord(block) || typeof b.type !== "string" || !CONTENT_TYPES.has(b.type)) {
          refuse("content blocks must be text, image, resource, resource_link or audio", {
            code: "bad-content",
          });
          return;
        }
        if (b.type === "text" && typeof b.text !== "string") {
          refuse("a text block needs a string text", { code: "bad-content" });
          return;
        }
        if (b.type === "image" && (typeof b.mimeType !== "string" || typeof b.data !== "string")) {
          // the wording of validatePromptImages is atrium's; the kit names the same fault
          refuse("an image block needs a mimeType and base64 data", { code: "bad-content" });
          return;
        }
      }
      blocks = body.content as Array<Record<string, unknown>>;
    }
    const blockText = blocks
      .filter((block) => block.type === "text")
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("\n")
      .trim();
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text && !blockText && !blocks.some((block) => block.type === "image")) {
      refuse("text is required");
      return;
    }
    let deliveryId: string = randomUUID();
    let chosenId = false;
    if (body.delivery_id !== undefined && body.delivery_id !== null) {
      if (typeof body.delivery_id !== "string" || !DELIVERY_ID_RE.test(body.delivery_id)) {
        refuse("delivery_id must be a lowercase UUID", { code: "bad-delivery-id" });
        return;
      }
      deliveryId = body.delivery_id;
      chosenId = true;
    }
    if (body.task_options !== undefined && body.task_options !== null) {
      if (typeof body.task_options !== "object" || Array.isArray(body.task_options)) {
        refuse("task_options must be an object", { code: "bad-task-options" });
        return;
      }
      if (Buffer.byteLength(JSON.stringify(body.task_options), "utf8") > 16 * 1024) {
        refuse("task_options is larger than 16384 bytes", { code: "task-options-too-large" });
        return;
      }
    }
    const target = record.target ?? "";
    // resolveSource: body.from, else X-Source-Session, else "anonymous"
    const bodyFrom = typeof body.from === "string" ? body.from.trim() : "";
    const headerFrom = (record.headers["x-source-session"] ?? "").trim();
    const from = bodyFrom || headerFrom || "anonymous";
    // what the route refuses about the RECIPIENT, in its order (message-routes.ts)
    const isSeatRoute = record.route === "seat_message";
    const state = messages.recipients?.[target];
    const stop = (status: number, answerBody: Record<string, unknown>, outcome: string): void => {
      record.outcome = `refused:${outcome}`;
      this.sendJson(response, record, status, answerBody);
    };
    if (isSeatRoute && (state === "not-a-seat" || state === "unknown")) {
      stop(
        404,
        { error: `${target} is not a seat id known to this box`, code: "not-a-seat" },
        "not-a-seat",
      );
      return;
    }
    if (isSeatRoute && state === "vacant") {
      stop(
        409,
        {
          error: `Seat ${target} has no current holder. A holder was retired by succession and no successor has been activated — this is not a closed session and cannot be reopened; a new holder must be started and switched onto the seat before it can receive delivery.`,
          code: "SEAT_VACANT",
          seatId: target,
        },
        "SEAT_VACANT",
      );
      return;
    }
    if (!isSeatRoute && state === "unknown") {
      stop(404, { error: "no session or seat with this id" }, "unknown-session");
      return;
    }
    if (state === "archived") {
      stop(
        409,
        {
          error: `Session is archived (cold storage) and cannot be written to. It is intact and readable — archiving only moves files, it never deletes. To write to it, restore it first: run \`acpx sessions restore ${target}\`, or press ❄ Restore in the session header. Restoring does not reopen the session or start an agent.`,
          code: "SESSION_ARCHIVED",
          archived: true,
          sessionId: target,
        },
        "SESSION_ARCHIVED",
      );
      return;
    }
    if (state === "template") {
      stop(
        409,
        { error: "Template sessions are read-only", code: "template-session-read-only" },
        "template-session-read-only",
      );
      return;
    }
    // R4: a caller-chosen id must be free, or this sender's own
    if (chosenId) {
      const owner = this.items.get(deliveryId);
      if (
        owner !== undefined &&
        !sameActor(owner.actor, actorOfHeader(record.headers["x-source-session"]))
      ) {
        stop(
          409,
          {
            error: `delivery id ${deliveryId} already belongs to a message of another sender; nothing was delivered`,
            code: "delivery-id-conflict",
            delivery_id: deliveryId,
          },
          "delivery-id-conflict",
        );
        return;
      }
    }
    if (state === "closing") {
      stop(
        409,
        {
          code: "SESSION_CLOSING",
          error: "This session is still closing. Wait for Close to finish, then reopen it.",
        },
        "SESSION_CLOSING",
      );
      return;
    }
    if (state === "closed" && body.reopen !== true) {
      stop(
        409,
        {
          error:
            'Session is closed and was not reopened. Closed sessions no longer auto-reopen on delivery. To deliver anyway, resend with reopen (send-message.sh --reopen, or POST body {"reopen": true}); or reopen the session first (UI Reopen button, or PATCH /api/sessions/:id/closed {"closed": false}).',
          code: "SESSION_CLOSED",
          closed: true,
        },
        "SESSION_CLOSED",
      );
      return;
    }
    const answer: MessageAnswer =
      messages.answers?.[this.messagesAnswered] ?? messages.default ?? "queued";
    this.messagesAnswered += 1;
    if (typeof answer === "object" && "status" in answer) {
      record.outcome = "answered";
      this.sendJson(response, record, answer.status, answer.body);
      return;
    }
    const seats = record.route === "seat_message";
    const toSeat = seats ? target : messages.seatOf?.[target];
    const to = seats ? (messages.seats?.[target] ?? uuidFromText(`holder:${target}`)) : target;
    const held =
      answer === "queued"
        ? undefined
        : answer === "held"
          ? { reason: "pod_starting", ahead: 0 }
          : { reason: answer.held.reason, ahead: answer.held.ahead ?? 0 };
    if (chosenId) {
      this.items.set(deliveryId, {
        actor: actorOfHeader(record.headers["x-source-session"]),
        text,
      });
    }
    record.outcome = held === undefined ? "answered" : "held";
    this.sendJson(response, record, 202, {
      delivery_id: deliveryId,
      from,
      to,
      ...(toSeat ? { to_seat: toSeat } : {}),
      status: "queued",
      ...(held === undefined
        ? {}
        : {
            held: { since: new Date().toISOString(), ...held },
            message: heldSentence(
              held.reason,
              deliveryId,
              messages.names?.[target] ?? target.slice(0, 8),
              held.ahead,
            ),
          }),
    });
  }

  private async handleCall(
    record: AtriumRequestRecord,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const refuse = (refusal: Refusal): void => {
      const error =
        typeof refusal.body.error === "string" ? refusal.body.error : String(refusal.status);
      record.outcome = `refused:${error}`;
      this.sendJson(response, record, refusal.status, refusal.body);
    };
    if (record.body !== null && record.body.cwd !== undefined) {
      // A-9: atrium ignores a cwd; the kit names it so a client that sends one is visible to the test.
      record.problems.push("cwd_present");
    }
    const parsed = parseCallBody(record.body);
    if (!parsed.ok) {
      refuse(parsed.refusal);
      return;
    }
    const body = parsed.body;
    record.callId = body.callId;
    if (body.stdin !== null) {
      record.stdin = body.stdin.toString("utf8");
    }
    // The caller is checked against the calling pod (C6.2, atrium S2); a `local` caller is only a claim.
    const callerClass = this.script.callerClass ?? "local";
    if (callerClass === "agent-pod") {
      const pod = this.script.agentPod ?? {};
      const matches =
        pod.utility === true
          ? body.caller === null
          : body.caller !== null && pod.sessionKey === sessionKeyOfRecord(body.caller.record_id);
      if (!matches) {
        refuse({ status: 403, body: { error: "caller-mismatch" } });
        return;
      }
    }
    if (body.caller === null && callerClass !== "agent-pod") {
      refuse(bad("bad-caller"));
      return;
    }
    // C6.2 `inherit`: acpx's closed list, nothing else
    for (const name of Object.keys(body.inherit)) {
      if (!INHERIT_ALLOWED.includes(name)) {
        refuse(bad("inherit-not-allowed", { name }));
        return;
      }
    }
    const classified = await this.classifyFor(body.argv);
    if (
      this.script.resolveTargetAs !== undefined &&
      (classified.class === "record" || classified.class === "owner-if-pod") &&
      (classified.targetSessionId === undefined || classified.targetSessionId === null)
    ) {
      classified.targetSessionId = this.script.resolveTargetAs;
    }
    const verdict = passability(classified, body.caller?.record_id ?? "");
    if (!verdict.ok) {
      refuse(bad("class-not-passable", { reason: verdict.reason }));
      return;
    }
    const path = classified.path ?? "";
    const isCreate = verdict.class === "create" && path !== "sessions handover";
    if (isCreate && body.caller === null) {
      refuse(bad("class-not-passable", { reason: "no-caller" }));
      return;
    }
    if (path === "sessions handover" && !handoverBriefShared(body.argv)) {
      refuse(bad("class-not-passable", { reason: "file-argument" }));
      return;
    }
    // At most once, the server's half: the first items' wire ids are the message's `call_id` and the fork notice's
    // `uuid5(call_id, "fork-notice")`. Recorded for THIS caller => a replay (acpx is run again, nothing new queued);
    // either recorded for ANOTHER sender => refused, nothing runs (passThrough.ts, R4).
    const ids = { message: body.callId, notice: forkNoticeId(body.callId) };
    const recordedIds: string[] = [];
    if (body.caller !== null) {
      for (const id of [ids.message, ids.notice]) {
        const item = this.items.get(id);
        if (item === undefined) {
          continue;
        }
        if (!sameActor(item.actor, actorOfCaller(body.caller))) {
          record.outcome = "refused:delivery-id-conflict";
          this.sendJson(response, record, 409, { error: "delivery-id-conflict", delivery_id: id });
          return;
        }
        recordedIds.push(id);
      }
    }
    const replayed = recordedIds.length > 0;
    let argv = body.argv;
    let stdinForRun: Buffer | null = body.stdin;
    let create: { recordId: string; message: string | null } | null = null;
    if (isCreate) {
      const prepared = prepareCreate(argv, stdinForRun, body.callId);
      if (!prepared.ok) {
        refuse(prepared.refusal);
        return;
      }
      argv = prepared.argv;
      if (prepared.stdinUsed) {
        stdinForRun = null;
      }
      create = { recordId: prepared.recordId, message: prepared.message };
      // A replay is the SAME request, first message included: another message is atrium's own refusal, in
      // acpx's shape (exit 2), before acpx is asked. A message when none was recorded is a different request too.
      if (replayed && prepared.message !== null && prepared.message.trim() !== "") {
        const stored = recordedIds.includes(ids.message) ? this.items.get(ids.message) : undefined;
        if (stored === undefined || stored.text !== prepared.message) {
          record.outcome = "refused:create-replay-mismatch";
          const json = findFlag(body.argv, "--format").some((f) => f.value === "json");
          this.sendJson(response, record, 200, {
            ...jsonAwareError(
              2,
              replayMismatchText(prepared.recordId),
              "USAGE",
              json,
              "CREATE_REPLAY_MISMATCH",
            ),
            error: "create-replay-mismatch",
          });
          return;
        }
      }
    }
    record.ranArgv = argv;
    // acpx's own at-most-once (A-20): a create's record id that already exists is answered from the record only for the
    // SAME call id (`--created-by-call`); without that flag — or with another call id — acpx refuses the existing id.
    let run: CallAnswer | undefined;
    let rule: CallRule | undefined;
    if (create !== null) {
      const existing = this.createdRecords.get(create.recordId);
      const flagged = findFlag(argv, "--created-by-call")[0]?.value?.toLowerCase();
      const json = findFlag(body.argv, "--format").some((f) => f.value === "json");
      if (existing !== undefined && flagged !== existing.call) {
        run = jsonAwareError(
          1,
          "record-id destination already exists; refusing to create another ACP session",
          "RUNTIME",
          json,
        );
      } else if (existing !== undefined && existing.fingerprint !== requestFingerprint(argv)) {
        // acpx's `assertSameRequest` (A-20, M-2): the same ids with ANOTHER request — another name, reordered flags —
        // is `CREATE_REPLAY_MISMATCH`, exit 2, nothing written
        run = jsonAwareError(
          2,
          replayMismatchText(create.recordId),
          "USAGE",
          json,
          "CREATE_REPLAY_MISMATCH",
        );
      }
    }
    if (run === undefined) {
      // acpx is RUN — for a replay too, and for everything that is not a create: nothing else is replayed.
      rule = (this.script.calls ?? []).find((candidate) => {
        const prefix = candidate.argvPrefix ?? [];
        const left = this.rulesLeft.get(candidate);
        return (
          (left === undefined || left > 0) && prefix.every((part, index) => argv[index] === part)
        );
      });
      if (rule !== undefined && this.rulesLeft.has(rule)) {
        this.rulesLeft.set(rule, (this.rulesLeft.get(rule) ?? 1) - 1);
      }
      run = rule?.answer ?? { exit: 0, stdout: "", stderr: "" };
    }
    // a scripted whole HTTP answer replaces the run's wrapper
    if ("status" in run) {
      record.outcome = "answered";
      this.sendJson(response, record, run.status, run.body);
      return;
    }
    const answer: Record<string, unknown> = {
      exit: run.exit,
      stdout: run.stdout ?? "",
      stderr: run.stderr ?? "",
    };
    if (create !== null && run.exit === 0) {
      if (!this.createdRecords.has(create.recordId)) {
        this.createdRecords.set(create.recordId, {
          call: findFlag(argv, "--created-by-call")[0]?.value?.toLowerCase() ?? "",
          fingerprint: requestFingerprint(argv),
        });
      }
    }
    // `delivery` only for a create that succeeded (passThrough.ts: `if (create && result.exit === 0)`): the caller's
    // message, else a template's prompt; the fork notice first when the script has one (an acpx answer carries it).
    if (create !== null && run.exit === 0 && body.caller !== null) {
      const message =
        create.message !== null && create.message.trim() !== ""
          ? create.message
          : (this.script.templatePrompt ?? null);
      const notice = this.script.forkNotice ?? null;
      if (replayed) {
        answer.delivery = {
          delivery_id: recordedIds.includes(ids.message) ? ids.message : ids.notice,
          to: create.recordId,
          status: "queued",
          replay: true,
        };
      } else if (message !== null || notice !== null) {
        const sender = actorOfCaller(body.caller);
        if (notice !== null) {
          this.items.set(ids.notice, { actor: sender, text: notice });
        }
        if (message !== null) {
          this.items.set(ids.message, { actor: sender, text: message });
        }
        const hold = this.script.firstMessageHold;
        answer.delivery = {
          delivery_id: message !== null ? ids.message : ids.notice,
          to: create.recordId,
          status: "queued",
          ...(hold === undefined
            ? {}
            : {
                held: {
                  since: new Date().toISOString(),
                  reason: hold.reason,
                  ahead: hold.ahead ?? 0,
                },
              }),
        };
      }
    }
    record.replayed = replayed && answer.delivery !== undefined;
    if (rule?.loseAnswer === true) {
      record.outcome = "lost_answer";
      request.socket.destroy();
      return;
    }
    record.outcome = record.replayed ? "replayed" : "answered";
    this.sendJson(response, record, 200, answer);
  }

  private handleControl(
    method: string,
    path: string,
    record: AtriumRequestRecord,
    response: ServerResponse,
  ): void {
    record.outcome = "kit";
    if (method === "GET" && path === "/_kit/record") {
      this.sendJson(response, record, 200, {
        requests: this.requests.filter((entry) => !entry.path.startsWith("/_kit/")),
      });
    } else if (method === "POST" && path === "/_kit/script") {
      this.setScript((record.body ?? {}) as AtriumScript);
      this.sendJson(response, record, 200, { ok: true });
    } else if (method === "POST" && path === "/_kit/mode") {
      const body = (record.body ?? {}) as { mode?: AtriumMode; forMs?: number };
      this.sendJson(response, record, 200, { ok: true });
      this.setMode(body.mode ?? "normal", body.forMs);
    } else if (method === "POST" && path === "/_kit/reset") {
      this.reset();
      this.sendJson(response, record, 200, { ok: true });
    } else {
      this.sendJson(response, record, 404, { error: "not-found" });
    }
  }
}

export async function startRecordedAtrium(
  script: AtriumScript = {},
  options: { port?: number; host?: string; classify?: Classify } = {},
): Promise<RecordedAtrium> {
  const atrium = new RecordedAtrium(script, options.classify);
  await atrium.listen(options.port ?? 0, options.host ?? "127.0.0.1");
  return atrium;
}

function parseArgs(argv: string[]): { port: number; host: string; script: AtriumScript } {
  let port = 0;
  let host = "127.0.0.1";
  let script: AtriumScript = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--port" && value !== undefined) {
      port = Number(value);
      index += 1;
    } else if (arg === "--host" && value !== undefined) {
      host = value;
      index += 1;
    } else if (arg === "--script" && value !== undefined) {
      const text = value.trimStart().startsWith("{") ? value : readFileSync(value, "utf8");
      script = JSON.parse(text) as AtriumScript;
      index += 1;
    } else {
      throw new Error(`recorded-atrium: unknown argument ${arg ?? "<none>"}`);
    }
  }
  return { port, host, script };
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  const { port, host, script } = parseArgs(process.argv.slice(2));
  const atrium = await startRecordedAtrium(script, { port, host });
  process.stdout.write(
    `${JSON.stringify({ fake: "atrium", host, port: atrium.port, id: randomUUID() })}\n`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void atrium.close().finally(() => process.exit(0));
    });
  }
}
