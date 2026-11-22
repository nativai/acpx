// X1 test kit — the fake broker (CONTRACTS-r4.md C4, kind `agent`).
//
// One file, Node standard library only, erasable TypeScript only (no enums, namespaces or
// parameter properties) — so the SAME file is
//   · imported by acpx's own tests:      import { startFakeBroker } from "./pod-kit/fake-broker.js"
//   · run as a process by any repo:      node fake-broker.ts --port 0 --script <file|inline json>
//     (prints one JSON line on stdout, `{"fake":"broker","host":"127.0.0.1","port":<n>}`, once bound).
// See README.md beside it for the script shape and the record.
//
// What it speaks (C4): POST /v1/agents/<key> — streamed text/plain, one line per step, exactly one
// final line (ready … | refused … | error …); DELETE /v1/agents/<key>; GET /v1/agents.
// Everything else is the kit's own control surface under /_kit/ (record, script, reset).

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";

export const HARNESSES = ["claude", "pi", "codex", "claude-pty", "utility"] as const;
export const PLACEMENTS = ["pool", "home", "auto"] as const;
export const CLASSES = ["interactive", "spawn", "automation", "utility"] as const;
// C9: "every tool an agent pod links".
export const RELEASE_TOOLS = [
  "acpx",
  "acpx-ui",
  "claude-agent-acp",
  "codex-acp",
  "claude-pty-acp",
  "pi",
  "pi-acp",
  "pi-extensions",
] as const;
// C9 as ruled 2026-11-21: only a tool marked `optional` in runtime-links.sh's LINKS table may be
// left out of `releases` — today `pi-extensions`, and only it. Any other absent tool is a problem.
export const OPTIONAL_RELEASE_TOOLS: readonly string[] = ["pi-extensions"];

export type BrokerStep = string | { line: string; delayMs?: number };

export type BrokerFinal =
  | string // a raw final line, verbatim
  | { ready: { ip?: string; pod?: string; uid?: string; node?: string; placement?: string } }
  | {
      refused: {
        reason: "agent_cap" | "quota" | "home_full" | "too_big";
        live: number;
        cap: number;
      };
    }
  | { error: string };

export interface BrokerBehavior {
  /** Progress lines before the final line (`scheduling`, `scaling-up`, `pulling`, …). */
  steps?: BrokerStep[];
  /** The one final line. Default: `ready` with generated fields. */
  final?: BrokerFinal;
  /** Wait before the final line, ms. */
  finalDelayMs?: number;
  /** The stream never finishes: the steps are sent, then nothing, until DELETE or close. */
  hang?: boolean;
  /**
   * Cut the connection of an attached stream once `afterLines` lines went out on it. The Job goes
   * on (C4: "the caller may stop reading at any time; the Job continues"), so a later POST for the
   * same key follows it. `times` streams are cut (default 1); `beforeHeaders` resets the connection
   * instead of sending the 200 first.
   */
  drop?: { afterLines: number; times?: number; beforeHeaders?: boolean };
  /** Answer the whole POST with this HTTP response instead of a stream (a 5xx, a hang is `hang`). */
  respond?: { status: number; body?: string; headers?: Record<string, string> };
}

export interface BrokerStatus {
  live?: number;
  cap?: number;
  reserve?: number;
  quota?: { used: number; hard: number };
  home?: { live: number; cap: number };
  pool?: { state: string };
}

export interface BrokerScript {
  /** Behaviour of the first Job created, of the second, … (consumed in order). */
  jobs?: BrokerBehavior[];
  /** Behaviour by key; wins over `jobs` and `default`. */
  keys?: Record<string, BrokerBehavior>;
  default?: BrokerBehavior;
  /** DELETE: delay before answering, and the status (default 200). */
  delete?: { delayMs?: number; status?: number };
  /** GET /v1/agents; whatever is not scripted is derived from the live Jobs. */
  status?: BrokerStatus;
}

export interface BrokerRequestRecord {
  seq: number;
  atMs: number;
  method: string;
  path: string;
  /** The raw query string (DELETE carries `uid=<pod uid>`). */
  query: string;
  key: string | null;
  headers: Record<string, string>;
  bodyText: string;
  /** Parsed JSON body, or null when absent / not JSON. */
  body: Record<string, unknown> | null;
  /**
   * Departures from C4's request shape, by name — the fake never rejects for these (the contract
   * names no answer), a test asserts the list is empty: `invalid_json`, `contract_missing`,
   * `field_missing:<f>`, `field_invalid:<f>`, `releases_missing:<tool>` (a required tool; `pi-extensions` may be left out), `releases_invalid:<tool>`, `key_mismatch`.
   */
  problems: string[];
  /** The Job this request created or followed; null for a request that reached no Job. */
  jobSeq: number | null;
  joinedExistingJob: boolean;
  /** The lines written to this request's stream, in order. */
  linesSent: string[];
  outcome: string;
}

interface Job {
  seq: number;
  key: string;
  /** The uid of this Job's pod — what `ready` announces, and what DELETE ?uid= is checked against. */
  uid: string;
  behavior: BrokerBehavior;
  lines: string[];
  done: boolean;
  deleted: boolean;
  dropsLeft: number;
  timers: Set<NodeJS.Timeout>;
  wake: Set<() => void>;
  request: Record<string, unknown> | null;
}

const KEY_PATTERN = /^[A-Za-z0-9-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

function uuidFrom(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A request body built to C4, and the key it goes under — for tests that talk to the broker. */
export function wellFormedAgentRequest(
  sessionId: string,
  overrides: Record<string, unknown> = {},
): { key: string; body: Record<string, unknown> } {
  const releases: Record<string, string> = {};
  for (const tool of RELEASE_TOOLS) {
    releases[tool] = `${tool}-r1`;
  }
  return {
    key: sessionKey(sessionId),
    body: {
      contract: 1,
      sessionId,
      seat: "seat-0001",
      harness: "claude",
      placement: "auto",
      class: "interactive",
      releases,
      sessionUrl: `https://atrium.invalid/?session=${sessionId}`,
      sessionName: "kit-session",
      brick: "",
      ...overrides,
    },
  };
}

/** A utility request (`ag-util-pool` / `ag-util-home`): no seat, no sessionId; the key is `util-<placement>`. */
export function wellFormedUtilityRequest(
  placement: "pool" | "home",
  overrides: Record<string, unknown> = {},
): { key: string; body: Record<string, unknown> } {
  const releases: Record<string, string> = {};
  for (const tool of RELEASE_TOOLS) {
    releases[tool] = `${tool}-r1`;
  }
  return {
    key: `util-${placement}`,
    body: { contract: 1, harness: "utility", placement, class: "utility", releases, ...overrides },
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function validateRequest(body: Record<string, unknown>, key: string): string[] {
  const problems: string[] = [];
  const stringField = (name: string): string | null => {
    const value = body[name];
    if (value === undefined) {
      problems.push(`field_missing:${name}`);
      return null;
    }
    if (typeof value !== "string" || value.length === 0) {
      problems.push(`field_invalid:${name}`);
      return null;
    }
    return value;
  };
  const harness = stringField("harness");
  // C4: a utility request (harness `utility`) carries no `seat` and no `sessionId` — their absence is
  // right and their PRESENCE is the problem; every other harness must carry both.
  let sessionId: string | null = null;
  if (harness === "utility") {
    for (const name of ["seat", "sessionId"]) {
      if (body[name] !== undefined) {
        problems.push(`field_present:${name}`);
      }
    }
  } else {
    sessionId = stringField("sessionId");
    stringField("seat");
  }
  const placement = stringField("placement");
  const klass = stringField("class");
  if (harness !== null && !(HARNESSES as readonly string[]).includes(harness)) {
    problems.push("field_invalid:harness");
  }
  if (placement !== null && !(PLACEMENTS as readonly string[]).includes(placement)) {
    problems.push("field_invalid:placement");
  }
  if (klass !== null && !(CLASSES as readonly string[]).includes(klass)) {
    problems.push("field_invalid:class");
  }
  for (const optional of ["sessionUrl", "sessionName", "brick"]) {
    if (body[optional] !== undefined && typeof body[optional] !== "string") {
      problems.push(`field_invalid:${optional}`);
    }
  }
  const releases = body.releases;
  if (releases === undefined) {
    problems.push("field_missing:releases");
  } else if (!isRecord(releases)) {
    problems.push("field_invalid:releases");
  } else {
    for (const tool of RELEASE_TOOLS) {
      const value = releases[tool];
      if (value === undefined) {
        if (!OPTIONAL_RELEASE_TOOLS.includes(tool)) {
          problems.push(`releases_missing:${tool}`);
        }
      } else if (typeof value !== "string" || value.length === 0) {
        problems.push(`releases_invalid:${tool}`);
      }
    }
  }
  // C2: <key> = SHA-256 of the session id in hex, first 24 characters. A utility pod's key is its own.
  if (sessionId !== null && sessionKey(sessionId) !== key) {
    problems.push("key_mismatch");
  }
  return problems;
}

export class FakeBroker {
  readonly requests: BrokerRequestRecord[] = [];
  script: BrokerScript;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly jobs = new Map<string, Job>();
  /** Jobs being deleted (the scripted DELETE delay): the pod is terminating — still there, still addressable by uid. */
  private readonly terminating = new Map<string, { job: Job; done: Promise<void> }>();
  private readonly startedAt = Date.now();
  private jobCounter = 0;
  private nextScripted = 0;
  private hostName = "127.0.0.1";

  constructor(script: BrokerScript = {}) {
    this.script = script;
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        response.end(JSON.stringify({ error: "fake_broker_bug", detail: String(error) }));
      });
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<number> {
    this.hostName = host;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, resolve);
    });
    return (this.server.address() as AddressInfo).port;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `http://${this.hostName}:${String(this.port)}`;
  }

  /** Stops answering: open streams are cut, the port refuses connections afterwards. */
  async close(): Promise<void> {
    for (const job of this.jobs.values()) {
      this.cancelJob(job);
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** New script for later requests; the Jobs already running keep theirs. */
  setScript(script: BrokerScript): void {
    this.script = script;
    this.nextScripted = 0;
  }

  /** Forget requests and Jobs (cancels their timers); the script stays. */
  reset(): void {
    for (const job of this.jobs.values()) {
      this.cancelJob(job);
    }
    this.jobs.clear();
    this.terminating.clear();
    this.requests.length = 0;
    this.jobCounter = 0;
    this.nextScripted = 0;
  }

  requestsFor(method: string, key?: string): BrokerRequestRecord[] {
    return this.requests.filter(
      (entry) => entry.method === method && (key === undefined || entry.key === key),
    );
  }

  private behaviorFor(key: string): BrokerBehavior {
    const byKey = this.script.keys?.[key];
    if (byKey !== undefined) {
      return byKey;
    }
    const queue = this.script.jobs ?? [];
    if (this.nextScripted < queue.length) {
      const next = queue[this.nextScripted];
      this.nextScripted += 1;
      if (next !== undefined) {
        return next;
      }
    }
    return this.script.default ?? {};
  }

  private podUidFor(behavior: BrokerBehavior, key: string, seq: number): string {
    const final = behavior.final;
    if (typeof final === "string") {
      return /\buid=(\S+)/.exec(final)?.[1] ?? uuidFrom(`${key}:${String(seq)}`);
    }
    if (final !== undefined && "ready" in final && final.ready.uid !== undefined) {
      return final.ready.uid;
    }
    return uuidFrom(`${key}:${String(seq)}`);
  }

  private cancelJob(job: Job): void {
    job.deleted = true;
    for (const timer of job.timers) {
      clearTimeout(timer);
    }
    job.timers.clear();
    this.notify(job);
  }

  private notify(job: Job): void {
    for (const wake of Array.from(job.wake)) {
      wake();
    }
  }

  private sleep(job: Job, ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        job.timers.delete(timer);
        resolve();
      }, ms);
      job.timers.add(timer);
    });
  }

  private finalLine(job: Job, key: string): string {
    const final = job.behavior.final;
    if (typeof final === "string") {
      return final;
    }
    if (final !== undefined && "refused" in final) {
      const { reason, live, cap } = final.refused;
      return `refused reason=${reason} live=${String(live)} cap=${String(cap)}`;
    }
    if (final !== undefined && "error" in final) {
      return `error ${final.error}`;
    }
    const given = final?.ready ?? {};
    const asked = job.request?.placement;
    const placement = given.placement ?? (asked === "home" ? "home" : "pool");
    const ip = given.ip ?? `10.244.${String(job.seq % 250)}.10`;
    const pod = given.pod ?? `ag-${key}`;
    const uid = job.uid;
    const node = given.node ?? "node-a";
    return `ready ip=${ip} pod=${pod} uid=${uid} node=${node} placement=${placement}`;
  }

  private async runJob(job: Job): Promise<void> {
    for (const step of job.behavior.steps ?? []) {
      const line = typeof step === "string" ? step : step.line;
      const delayMs = typeof step === "string" ? 0 : (step.delayMs ?? 0);
      await this.sleep(job, delayMs);
      if (job.deleted) {
        return;
      }
      job.lines.push(line);
      this.notify(job);
    }
    if (job.behavior.hang === true) {
      return;
    }
    await this.sleep(job, job.behavior.finalDelayMs ?? 0);
    if (job.deleted) {
      return;
    }
    job.lines.push(this.finalLine(job, job.key));
    job.done = true;
    this.notify(job);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://fake-broker.invalid");
    const path = url.pathname;
    if (path.startsWith("/_kit/")) {
      await this.handleControl(method, path, request, response);
      return;
    }
    const bodyText = await readBody(request);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name] = Array.isArray(value) ? value.join(", ") : (value ?? "");
    }
    const agentMatch = /^\/v1\/agents\/([^/]+)$/.exec(path);
    const key = agentMatch?.[1] ?? null;
    const record: BrokerRequestRecord = {
      seq: this.requests.length + 1,
      atMs: Date.now() - this.startedAt,
      method,
      path,
      query: url.search.slice(1),
      key,
      headers,
      bodyText,
      body: null,
      problems: [],
      jobSeq: null,
      joinedExistingJob: false,
      linesSent: [],
      outcome: "pending",
    };
    this.requests.push(record);

    if (path === "/v1/agents" && method === "GET") {
      record.outcome = "status";
      this.sendJson(response, 200, this.statusBody());
      return;
    }
    if (key !== null && KEY_PATTERN.test(key) && method === "DELETE") {
      await this.handleDelete(key, url.searchParams.get("uid"), record, response);
      return;
    }
    if (key !== null && KEY_PATTERN.test(key) && method === "POST") {
      await this.handlePost(key, record, request, response);
      return;
    }
    const knownPath = path === "/v1/agents" || key !== null;
    record.outcome = knownPath ? "method_not_allowed" : "not_found";
    this.sendJson(response, knownPath ? 405 : 404, {
      error: knownPath ? "method_not_allowed" : "not_found",
    });
  }

  private statusBody(): Record<string, unknown> {
    const scripted = this.script.status ?? {};
    const live = [...this.jobs.values()].filter((job) => !job.deleted);
    const cap = scripted.cap ?? 100;
    const homeLive = live.filter((job) => job.request?.placement === "home").length;
    return {
      live: scripted.live ?? live.length,
      cap,
      reserve: scripted.reserve ?? 1,
      quota: scripted.quota ?? { used: scripted.live ?? live.length, hard: cap },
      home: scripted.home ?? { live: homeLive, cap: 10 },
      pool: scripted.pool ?? { state: "ready" },
    };
  }

  private sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  }

  private async handleDelete(
    key: string,
    uid: string | null,
    record: BrokerRequestRecord,
    response: ServerResponse,
  ): Promise<void> {
    const live = this.jobs.get(key);
    const dying = this.terminating.get(key);
    const target = live ?? dying?.job;
    record.jobSeq = target?.seq ?? null;
    const answer = (outcome: string, body: string): void => {
      record.outcome = outcome;
      response.writeHead(this.script.delete?.status ?? 200, { "content-type": "text/plain" });
      response.end(body);
    };
    if (target === undefined) {
      // No pod of the key — with or without a uid — is a plain empty 200.
      answer("deleted_nothing", "");
      return;
    }
    if (uid !== null && uid !== target.uid) {
      // A wrong uid deletes nothing and says so in the one line C4 defines, still HTTP 200.
      answer("uid_mismatch", "refused reason=uid_mismatch\n");
      return;
    }
    if (live !== undefined) {
      this.jobs.delete(key);
      this.cancelJob(live);
      // The broker "answers when no pod of the key remains" — the fake answers after the scripted delay;
      // until then the pod is terminating: still there, and a DELETE with its uid still matches.
      const done = new Promise<void>((resolve) =>
        setTimeout(resolve, this.script.delete?.delayMs ?? 0),
      );
      this.terminating.set(key, { job: live, done });
      await done;
      if (this.terminating.get(key)?.job === live) {
        this.terminating.delete(key);
      }
      answer("deleted", "");
      return;
    }
    await dying?.done;
    answer("deleted_terminating", "");
  }

  private async handlePost(
    key: string,
    record: BrokerRequestRecord,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(record.bodyText);
      body = isRecord(parsed) ? parsed : null;
    } catch {
      body = null;
    }
    record.body = body;
    const stream = (): void => {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });
    };
    const finishWith = (line: string, outcome: string): void => {
      stream();
      record.linesSent.push(line);
      record.outcome = outcome;
      response.end(`${line}\n`);
    };
    if (body === null) {
      record.problems.push("invalid_json");
      finishWith("error invalid_request", "error_invalid_request");
      return;
    }
    if (body.contract === undefined) {
      record.problems.push("contract_missing");
    }
    if (body.contract !== 1) {
      // Rule 1 of the contracts: a side that meets a version it does not know refuses with a named
      // reason and starts nothing. No Job is created.
      finishWith("error unsupported_contract", "error_unsupported_contract");
      return;
    }
    record.problems.push(...validateRequest(body, key));

    // C4 "never created while another pod of the key is still terminating": a POST that arrives during
    // a DELETE's termination waits for it, then creates a fresh Job as usual.
    await this.terminating.get(key)?.done;
    let job = this.jobs.get(key);
    if (job === undefined) {
      const behavior = this.behaviorFor(key);
      if (behavior.respond !== undefined) {
        const { status, body: answer, headers } = behavior.respond;
        record.outcome = `respond_${String(status)}`;
        response.writeHead(status, headers ?? { "content-type": "text/plain" });
        response.end(answer ?? "");
        return;
      }
      this.jobCounter += 1;
      job = {
        seq: this.jobCounter,
        key,
        uid: this.podUidFor(behavior, key, this.jobCounter),
        behavior,
        lines: [],
        done: false,
        deleted: false,
        dropsLeft: behavior.drop?.times ?? 1,
        timers: new Set(),
        wake: new Set(),
        request: body,
      };
      this.jobs.set(key, job);
      this.runJob(job).catch(() => undefined);
    } else {
      record.joinedExistingJob = true;
    }
    record.jobSeq = job.seq;
    await this.streamJob(job, record, request, response, stream);
  }

  private async streamJob(
    job: Job,
    record: BrokerRequestRecord,
    request: IncomingMessage,
    response: ServerResponse,
    openStream: () => void,
  ): Promise<void> {
    const drop = job.behavior.drop;
    let wantDrop = drop !== undefined && job.dropsLeft > 0;
    if (wantDrop && drop?.beforeHeaders === true) {
      job.dropsLeft -= 1;
      record.outcome = "dropped_before_headers";
      request.socket.destroy();
      return;
    }
    openStream();
    response.flushHeaders();
    const gone = { value: false };
    response.on("close", () => {
      gone.value = true;
      this.notify(job);
    });
    let sent = 0;
    const dropNow = (): boolean => {
      if (wantDrop && drop !== undefined && sent >= drop.afterLines) {
        wantDrop = false;
        job.dropsLeft -= 1;
        record.outcome = "dropped";
        request.socket.destroy();
        return true;
      }
      return false;
    };
    if (dropNow()) {
      return;
    }
    while (!gone.value) {
      while (sent < job.lines.length) {
        const line = job.lines[sent] ?? "";
        sent += 1;
        record.linesSent.push(line);
        response.write(`${line}\n`);
        if (dropNow()) {
          return;
        }
      }
      if (job.done) {
        record.outcome = "final";
        response.end();
        return;
      }
      if (job.deleted) {
        // C4 (BR1): the pod this POST was following was deleted by a concurrent DELETE — the final
        // line is `error deleted`, and the Job is never re-created for a POST that was following it.
        const line = "error deleted";
        record.linesSent.push(line);
        record.outcome = "job_deleted";
        response.end(`${line}\n`);
        return;
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          job.wake.delete(wake);
          response.off("close", wake);
          resolve();
        };
        job.wake.add(wake);
        response.once("close", wake);
      });
    }
    record.outcome =
      job.behavior.hang === true && !job.done ? "client_closed_while_hung" : "client_closed";
  }

  private async handleControl(
    method: string,
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const text = await readBody(request);
    if (method === "GET" && path === "/_kit/record") {
      this.sendJson(response, 200, { requests: this.requests });
      return;
    }
    if (method === "POST" && path === "/_kit/script") {
      this.setScript(JSON.parse(text) as BrokerScript);
      this.sendJson(response, 200, { ok: true });
      return;
    }
    if (method === "POST" && path === "/_kit/reset") {
      this.reset();
      this.sendJson(response, 200, { ok: true });
      return;
    }
    this.sendJson(response, 404, { error: "not_found" });
  }
}

export async function startFakeBroker(
  script: BrokerScript = {},
  options: { port?: number; host?: string } = {},
): Promise<FakeBroker> {
  const broker = new FakeBroker(script);
  await broker.listen(options.port ?? 0, options.host ?? "127.0.0.1");
  return broker;
}

function parseArgs(argv: string[]): { port: number; host: string; script: BrokerScript } {
  let port = 0;
  let host = "127.0.0.1";
  let script: BrokerScript = {};
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
      script = JSON.parse(text) as BrokerScript;
      index += 1;
    } else {
      throw new Error(`fake-broker: unknown argument ${arg ?? "<none>"}`);
    }
  }
  return { port, host, script };
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  const { port, host, script } = parseArgs(process.argv.slice(2));
  const broker = await startFakeBroker(script, { port, host });
  process.stdout.write(
    `${JSON.stringify({ fake: "broker", host, port: broker.port, id: randomUUID() })}\n`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void broker.close().finally(() => process.exit(0));
    });
  }
}
