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
//   hang     accepts and never answers.
// A script is a list of phases, each for a time (`forMs`) or a number of answered requests
// (`forRequests`), the last one for ever — "away for N seconds, then back" is
// `[{mode:"away", forMs:N}, {mode:"normal"}]`; "away for the first 3 attempts" is
// `[{mode:"away", forRequests:3}, {mode:"normal"}]`, which needs no clock at all and is how a
// test compresses the client's 600 s budget (the budget override itself lives in the client).

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";

export type AtriumMode = "normal" | "away" | "refused" | "hang";

export interface AtriumPhase {
  mode: AtriumMode;
  /** The phase ends this long after it began. */
  forMs?: number;
  /** The phase ends after this many requests were answered in it (not for `refused`: none arrive). */
  forRequests?: number;
}

/** What /api/acpx/call answers. */
export type CallAnswer =
  | { exit: number; stdout?: string; stderr?: string; delivery?: Record<string, unknown> }
  | { status: number; body: unknown };

export interface CallRule {
  /** The call's argv must start with this. Default: any call. */
  argvPrefix?: string[];
  answer: CallAnswer;
  /** The rule serves this many calls, then is spent (default: for ever). */
  times?: number;
  /** Run the call (record it, remember its answer) but cut the connection before answering. */
  loseAnswer?: boolean;
}

export interface AtriumScript {
  phases?: AtriumPhase[];
  /** Rules for /api/acpx/call, first matching unspent rule wins. Default answer: exit 0, empty. */
  calls?: CallRule[];
  /** Answer of the two message routes. Default 200 `{"delivery_id":<uuid>,"status":"queued"}`. */
  messages?: { status?: number; body?: unknown };
  /** Answer of the two hints. Default 200 `{"ok":true}`. */
  hints?: { status?: number; body?: unknown };
}

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
  body: Record<string, unknown> | null;
  /** The call's stdin_b64, decoded as utf-8; null when absent. */
  stdin: string | null;
  /** Departures from C6.2 / C6.3's request shapes, by name; the fake answers anyway. */
  problems: string[];
  mode: AtriumMode;
  /** What the fake did: answered | away | cut | replayed | lost_answer | hang … */
  outcome: string;
  status: number | null;
  /** /api/acpx/call only. */
  callId: string | null;
  replayed: boolean;
}

interface StoredCall {
  answer: CallAnswer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const MAX_DEADLINE_MS = 60_000;
const ENDED_REASONS = new Set(["idle", "closed", "stale-release", "deadline", "term"]);

function validateCall(body: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (body.contract !== 1) {
    problems.push("contract");
  }
  if (!isString(body.call_id)) {
    problems.push("call_id");
  }
  if (!Array.isArray(body.argv) || !body.argv.every((entry) => typeof entry === "string")) {
    problems.push("argv");
  }
  if (body.stdin_b64 !== undefined) {
    if (typeof body.stdin_b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.stdin_b64)) {
      problems.push("stdin_b64");
    } else if (Buffer.from(body.stdin_b64, "base64").length > MAX_STDIN_BYTES) {
      problems.push("stdin_b64_too_large");
    }
  }
  if (!isString(body.cwd)) {
    problems.push("cwd");
  }
  const caller = body.caller;
  if (!isRecord(caller)) {
    problems.push("caller");
  } else {
    for (const field of ["session_url", "seat_url", "record_id"]) {
      if (!isString(caller[field])) {
        problems.push(`caller.${field}`);
      }
    }
    for (const field of ["parent_session_url", "parent_seat_url"]) {
      if (caller[field] !== undefined && !isString(caller[field])) {
        problems.push(`caller.${field}`);
      }
    }
  }
  if (!isString(body.admission_class)) {
    problems.push("admission_class");
  }
  if (
    typeof body.deadline_ms !== "number" ||
    !(body.deadline_ms > 0) ||
    body.deadline_ms > MAX_DEADLINE_MS
  ) {
    problems.push("deadline_ms");
  }
  return problems;
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
    if (typeof body.reason !== "string" || !ENDED_REASONS.has(body.reason)) {
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
  private readonly callAnswers = new Map<string, StoredCall>();
  private readonly rulesLeft = new Map<CallRule, number>();
  private phases: AtriumPhase[] = [{ mode: "normal" }];
  private phaseIndex = 0;
  private answeredInPhase = 0;
  private phaseTimer: NodeJS.Timeout | undefined;
  private listening = false;
  private boundPort = 0;
  private hostName = "127.0.0.1";

  constructor(script: AtriumScript = {}) {
    this.script = script;
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
    this.callAnswers.clear();
  }

  requestsFor(route: AtriumRoute): AtriumRequestRecord[] {
    return this.requests.filter((entry) => entry.route === route);
  }

  private applyScript(script: AtriumScript): void {
    this.rulesLeft.clear();
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
    try {
      const parsed: unknown = JSON.parse(record.bodyText);
      record.body = isRecord(parsed) ? parsed : null;
    } catch {
      record.body = null;
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
    if (record.mode === "away") {
      record.outcome = "away";
      this.sendJson(response, record, 503, { error: "atrium-away" }, { "retry-after": "5" });
      this.afterAnswer();
      return;
    }
    this.route(record, request, response);
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

  private route(
    record: AtriumRequestRecord,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (record.route === "call") {
      this.handleCall(record, request, response);
    } else if (record.route === "session_message" || record.route === "seat_message") {
      record.outcome = "answered";
      const answer = this.script.messages ?? {};
      this.sendJson(
        response,
        record,
        answer.status ?? 200,
        answer.body ?? { delivery_id: randomUUID(), status: "queued" },
      );
    } else if (record.route === "hint_ready" || record.route === "hint_ended") {
      record.problems =
        record.body === null
          ? ["body"]
          : validateHint(record.route === "hint_ready" ? "ready" : "ended", record.body);
      record.outcome = "answered";
      const answer = this.script.hints ?? {};
      this.sendJson(response, record, answer.status ?? 200, answer.body ?? { ok: true });
    } else {
      record.outcome = "not_found";
      this.sendJson(response, record, 404, { error: "not-found" });
    }
  }

  private handleCall(
    record: AtriumRequestRecord,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const body = record.body;
    if (body === null) {
      record.problems = ["body"];
      record.outcome = "answered";
      this.sendJson(response, record, 400, { error: "bad-request" });
      return;
    }
    record.problems = validateCall(body);
    if (typeof body.stdin_b64 === "string" && !record.problems.includes("stdin_b64")) {
      record.stdin = Buffer.from(body.stdin_b64, "base64").toString("utf8");
    }
    const callId = typeof body.call_id === "string" ? body.call_id : null;
    record.callId = callId;
    // C6.2 "at most once": the same call_id finds what the first one made and returns it.
    const stored = callId === null ? undefined : this.callAnswers.get(callId);
    if (stored !== undefined) {
      record.replayed = true;
      record.outcome = "replayed";
      this.answerCall(response, record, stored.answer);
      return;
    }
    const argv = Array.isArray(body.argv) ? (body.argv as unknown[]) : [];
    const rule = (this.script.calls ?? []).find((candidate) => {
      const prefix = candidate.argvPrefix ?? [];
      const left = this.rulesLeft.get(candidate);
      return (
        (left === undefined || left > 0) && prefix.every((part, index) => argv[index] === part)
      );
    });
    const answer: CallAnswer = rule?.answer ?? { exit: 0, stdout: "", stderr: "" };
    if (rule !== undefined && this.rulesLeft.has(rule)) {
      this.rulesLeft.set(rule, (this.rulesLeft.get(rule) ?? 1) - 1);
    }
    if (callId !== null) {
      this.callAnswers.set(callId, { answer });
    }
    if (rule?.loseAnswer === true) {
      record.outcome = "lost_answer";
      request.socket.destroy();
      return;
    }
    record.outcome = "answered";
    this.answerCall(response, record, answer);
  }

  private answerCall(
    response: ServerResponse,
    record: AtriumRequestRecord,
    answer: CallAnswer,
  ): void {
    if ("status" in answer) {
      this.sendJson(response, record, answer.status, answer.body);
      return;
    }
    const { exit, stdout, stderr, delivery } = answer;
    this.sendJson(response, record, 200, {
      exit,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      ...(delivery === undefined ? {} : { delivery }),
    });
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
  options: { port?: number; host?: string } = {},
): Promise<RecordedAtrium> {
  const atrium = new RecordedAtrium(script);
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
