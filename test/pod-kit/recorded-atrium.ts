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

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";

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
  };
  /** Answers of the hints; `redriven` is the number the ready hint reports (default 0). Default status 200. */
  hints?: { status?: number; body?: unknown; redriven?: number };
  /** The first message of a create is held for room: `delivery.held` (atrium's answer for a held first item). */
  firstMessageHold?: { reason: string; ahead?: number };
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
 * The names a create may inherit from its creator's environment (C6.2 `inherit`): a closed list kept in
 * acpx — `PASS_THROUGH_INHERIT` in src/pod/command-classes.ts. A COPY, on purpose: this file must run as a bare
 * Node process (`node recorded-atrium.ts`), where it cannot import acpx's `.js`-specifier sources. The
 * self-test `INHERIT_ALLOWED equals PASS_THROUGH_INHERIT` goes red if they drift.
 */
export const INHERIT_ALLOWED: readonly string[] = ["ACPX_SUBSCRIPTION", "ATRIUM_OS"];

/**
 * Atrium decides what is a create from acpx's CLASS TABLE (`verdict.class === "create"` and not `sessions
 * handover`, passThrough.ts:563). The kit loads that table's `classifyCall` when it can (compiled, in-process:
 * `dist-test/src/pod/command-classes.js`) and otherwise — bare `node recorded-atrium.ts` — falls back to this copy
 * of the create paths. The self-test compares the copy with the class table.
 */
export const CREATE_PATHS: readonly string[] = [
  "sessions new",
  "sessions copy",
  "sessions import",
  "sessions handover",
];

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

interface RecordedItem {
  /** The sender the item was recorded for (the caller's record id). */
  sender: string;
  text: string;
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

/** Fallback when acpx's class table cannot be loaded (bare process): the create paths, else control-store. */
const fallbackClassify: Classify = async (argv) => {
  // acpx's classifier reads a leading `acpx` as an agent name and classifies what follows
  const rest = argv[0] === "acpx" ? argv.slice(1) : argv;
  const words = rest.filter((word) => !word.startsWith("-"));
  const path = `${words[0] ?? ""} ${words[1] ?? ""}`.trim();
  if (words.length === 0) {
    return { kind: "unclassified", path };
  }
  return {
    kind: "classified",
    path,
    class: CREATE_PATHS.includes(path) ? "create" : "control-store",
    help: rest.includes("--help") || rest.includes("-h"),
  };
};

let loadedClassify: Classify | null | undefined;
async function defaultClassify(): Promise<Classify> {
  if (loadedClassify === undefined) {
    try {
      // compiled, in acpx's suite: dist-test/src/pod/command-classes.js; from bare source it does not resolve
      const module = (await import("../../src/pod/command-classes.js")) as {
        classifyCall: Classify;
      };
      loadedClassify = module.classifyCall;
    } catch {
      loadedClassify = null;
    }
  }
  return loadedClassify ?? fallbackClassify;
}

/** commandClasses.ts `passability`. */
function passability(
  c: CallClassification,
  callerRecordId: string,
): { ok: true; class: string } | { ok: false; reason: string } {
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

function uuidFromText(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
    // Warm the class table: its first use loads acpx's resolver and session store, which would otherwise be paid
    // inside the first call's answer time — a client with a 600 ms answer bound then reads a kit delay as "unknown".
    if (this.classifyOverride === undefined) {
      await (
        await defaultClassify()
      )(["sessions", "set-os", "warm-up", "x"]).catch(() => undefined);
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
    this.messagesAnswered = 0;
  }

  requestsFor(route: AtriumRoute): AtriumRequestRecord[] {
    return this.requests.filter((entry) => entry.route === route);
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
    const isHint = record.route === "hint_ready" || record.route === "hint_ended";
    if (record.mode === "forbidden" && !isHint) {
      record.outcome = "forbidden";
      this.sendJson(response, record, 403, {
        error:
          "This route is not available to this caller. Run the command on the target box itself (ssh-remote), or use the UI.",
        code: "CALLER_NOT_ALLOWED",
        caller_class: "remote",
        route_class: record.route === "call" ? "control" : "messaging",
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
    // CONTRACTS §5.1 / parseMessageBody: `text` (or content blocks), `delivery_id` a lowercase UUID
    const blocks = Array.isArray(body.content)
      ? (body.content as Array<Record<string, unknown>>)
      : [];
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
    if (body.delivery_id !== undefined && body.delivery_id !== null) {
      if (typeof body.delivery_id !== "string" || !DELIVERY_ID_RE.test(body.delivery_id)) {
        refuse("delivery_id must be a lowercase UUID", { code: "bad-delivery-id" });
        return;
      }
      deliveryId = body.delivery_id;
    }
    const target = record.target ?? "";
    // resolveSource: body.from, else X-Source-Session, else "anonymous"
    const bodyFrom = typeof body.from === "string" ? body.from.trim() : "";
    const headerFrom = (record.headers["x-source-session"] ?? "").trim();
    const from = bodyFrom || headerFrom || "anonymous";
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
            message: heldSentence(held.reason, deliveryId, target.slice(0, 8), held.ahead),
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
    const classified = await (this.classifyOverride ?? (await defaultClassify()))(body.argv);
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
    // At most once, the server's half: `call_id` is the first message's wire id. Recorded for THIS caller =>
    // a replay (acpx is run again, nothing new queued); recorded for another sender => refused, nothing runs.
    const recorded = this.items.get(body.callId);
    if (
      body.caller !== null &&
      recorded !== undefined &&
      recorded.sender !== body.caller.record_id
    ) {
      record.outcome = "refused:delivery-id-conflict";
      this.sendJson(response, record, 409, {
        error: "delivery-id-conflict",
        delivery_id: body.callId,
      });
      return;
    }
    const replayed = recorded !== undefined;
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
      // acpx's shape (exit 2), before acpx is asked.
      if (replayed && prepared.message !== null && prepared.message.trim() !== "") {
        if (recorded.text !== prepared.message) {
          record.outcome = "refused:create-replay-mismatch";
          this.sendJson(response, record, 200, {
            exit: 2,
            stdout: "",
            stderr: `CREATE_REPLAY_MISMATCH: record ${prepared.recordId} was created by this call id with a different first message; a replay must be the same request.\n`,
            error: "create-replay-mismatch",
          });
          return;
        }
      }
    }
    record.ranArgv = argv;
    // acpx is RUN — for a replay too, and for everything that is not a create: nothing else is replayed.
    const rule = (this.script.calls ?? []).find((candidate) => {
      const prefix = candidate.argvPrefix ?? [];
      const left = this.rulesLeft.get(candidate);
      return (
        (left === undefined || left > 0) && prefix.every((part, index) => argv[index] === part)
      );
    });
    if (rule !== undefined && this.rulesLeft.has(rule)) {
      this.rulesLeft.set(rule, (this.rulesLeft.get(rule) ?? 1) - 1);
    }
    const run: CallAnswer = rule?.answer ?? { exit: 0, stdout: "", stderr: "" };
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
    const message = create?.message ?? null;
    if (create !== null && run.exit === 0 && body.caller !== null) {
      const hasMessage = message !== null && message.trim() !== "";
      if (replayed) {
        answer.delivery = {
          delivery_id: body.callId,
          to: create.recordId,
          status: "queued",
          replay: true,
        };
      } else if (hasMessage) {
        this.items.set(body.callId, { sender: body.caller.record_id, text: message });
        const hold = this.script.firstMessageHold;
        answer.delivery = {
          delivery_id: body.callId,
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
