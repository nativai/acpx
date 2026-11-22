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
// C9 (A-12, A-40, A-41): only a tool marked `optional` in runtime-links.sh's LINKS table may be left out of
// `releases` — `pi-extensions`, `pi` and `claude-pty-acp`. Any other absent tool is a problem. This is the
// BROKER's copy of the set (broker.py `OPTIONAL_RELEASE_TOOLS`); acpx's own is `RELEASE_TOOLS_OPTIONAL`.
export const OPTIONAL_RELEASE_TOOLS: readonly string[] = ["pi-extensions", "pi", "claude-pty-acp"];

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
  /**
   * What the Job does AFTER a stream-ending final (`error timeout` / `error kube_api_error`): the Job continues
   * (broker.py "the Job continues"), so a later POST follows it — from the current phase — and sees these steps and
   * this final. Absent: the Job sits where it is.
   */
  afterTimeout?: BrokerThen;
  /**
   * How long a FOLLOWER waits before ITS OWN `error timeout` (the real `agent_wait`): its stream ends with that line
   * and the Job goes on. Absent: a follower waits for ever (until the Job ends, a DELETE, or the client closes).
   */
  agentWaitMs?: number;
  /** Answer the whole POST with this HTTP response instead of a stream (a 5xx, a hang is `hang`). */
  respond?: { status: number; body?: string; headers?: Record<string, string> };
}

export interface BrokerThen {
  steps?: BrokerStep[];
  final?: BrokerFinal;
  finalDelayMs?: number;
  hang?: boolean;
  afterTimeout?: BrokerThen;
}

export interface BrokerStatus {
  live?: number;
  cap?: number;
  reserve?: number;
  quota?: { used?: number; hard?: number };
  home?: { live?: number; cap?: number };
  pool?: { state: string };
}

export interface BrokerScript {
  /** Behaviour of the first Job created, of the second, … (consumed in order). */
  jobs?: BrokerBehavior[];
  /** Behaviour by key; wins over `jobs` and `default`. */
  keys?: Record<string, BrokerBehavior>;
  default?: BrokerBehavior;
  /** DELETE: delay before answering, and the status (default 200). */
  delete?: {
    delayMs?: number;
    status?: number;
    /**
     * For a 504 (the DELETE's wait ran out): how long AFTER the DELETE began the terminating pod really goes away
     * (default: with the DELETE's own delay; `null`: never). A POST that meets a terminating pod waits for it, up to
     * `goneWaitMs` (default 1000), then ends `error start_failed`.
     */
    goneAfterMs?: number | null;
    goneWaitMs?: number;
  };
  /**
   * The box's limits, as `GET /v1/agents` reports them AND as admission applies them (cap, reserve,
   * quota, home cap, pool state). Defaults: cap 100, reserve 1, home cap 0 (as the real broker), quota hard
   * = cap (a box WITH its quota patch — the real default hard 0 refuses every create as `quota`; script
   * `quota:{used:0,hard:0}` to see that), `live` and `used` derived from the live Jobs unless scripted.
   */
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
   * What the REAL broker refuses (`error invalid_request` / `error unsupported_contract`, no Job), in the real
   * broker's own words — e.g. `seat must be a label value`, `releases.pi-acp missing`, `body too large`; plus
   * `field_present:seat` for a utility request that sends a seat (the real broker ignores it). A well-formed
   * request has an empty list.
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
  /** The line the CREATOR's stream ends with while the Job goes on (`error timeout`, `error kube_api_error`). */
  creatorEnd: string | undefined;
  done: boolean;
  /** The pod ended or the final line was not `ready`: a later POST creates a NEW Job (new uid). */
  ended: boolean;
  deleted: boolean;
  /** pool | home — where this Job's pod runs (admission counts it). */
  target: string;
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

// The real broker's field rules (broker.py `parse_agent_body`, argocd ap/agent-pods 401c4558) — a request
// that breaks one is answered `error invalid_request` and creates nothing.
const AGENT_KEY_RE = /^([0-9a-f]{24}|util-pool|util-home)$/;
const LABEL_VALUE_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const RELEASE_NAME_RE = /^[A-Za-z0-9._+-]{1,128}$/;
const RELEASES_MAX = 4096;
const BODY_MAX = 65536;

type ParsedAgentBody =
  | { ok: true; body: Record<string, unknown>; problems: string[] }
  | { ok: false; line: string; reason: string };

function parseAgentBody(bodyText: string, key: string): ParsedAgentBody {
  const invalid = (reason: string): ParsedAgentBody => ({
    ok: false,
    line: "error invalid_request",
    reason,
  });
  if (Buffer.byteLength(bodyText, "utf8") > BODY_MAX) {
    return invalid("body too large");
  }
  let parsed: unknown = null;
  try {
    parsed = bodyText.length > 0 ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) {
    return invalid("body must be a JSON object");
  }
  const body = parsed;
  const contract = body.contract;
  if (typeof contract !== "number" || contract !== 1) {
    // Rule 1 of the contracts: a version this side does not know is refused by name, nothing started.
    return {
      ok: false,
      line: "error unsupported_contract",
      reason: `contract ${JSON.stringify(contract)}`,
    };
  }
  if (!AGENT_KEY_RE.test(key)) {
    return invalid("key must be 24 lower-case hex characters, util-pool or util-home");
  }
  const text: Record<string, string> = {};
  for (const name of ["sessionId", "seat", "harness", "placement", "class"]) {
    const value = body[name];
    if (typeof value !== "string") {
      // a utility pod has no session and no seat: both may be absent
      if (
        (name === "sessionId" || name === "seat") &&
        (value === undefined || value === null) &&
        body.harness === "utility"
      ) {
        text[name] = "";
        continue;
      }
      return invalid(`${name} must be a string`);
    }
    text[name] = value;
  }
  for (const name of ["sessionUrl", "sessionName", "brick"]) {
    if (body[name] !== undefined && body[name] !== null && typeof body[name] !== "string") {
      return invalid(`${name} must be a string`);
    }
  }
  if (!(HARNESSES as readonly string[]).includes(text.harness ?? "")) {
    return invalid("unknown harness");
  }
  if (!(PLACEMENTS as readonly string[]).includes(text.placement ?? "")) {
    return invalid("unknown placement");
  }
  if (!(CLASSES as readonly string[]).includes(text.class ?? "")) {
    return invalid("unknown class");
  }
  const problems: string[] = [];
  if (key.startsWith("util-")) {
    // a sent seat is ignored by the real broker (no seat label on a utility pod); the kit names it
    if (body.seat !== undefined && body.seat !== null) {
      problems.push("field_present:seat");
    }
    if (text.harness !== "utility" || text.sessionId !== "" || text.placement !== key.slice(5)) {
      return invalid("a utility key takes harness utility, no sessionId and its own placement");
    }
  } else {
    if (!LABEL_VALUE_RE.test(text.seat ?? "")) {
      return invalid("seat must be a label value");
    }
    if (text.harness === "utility" || !SESSION_ID_RE.test(text.sessionId ?? "")) {
      return invalid("sessionId missing or invalid");
    }
    if (sessionKey(text.sessionId ?? "") !== key) {
      return invalid("key is not sha256(sessionId)[:24]");
    }
  }
  const releases = body.releases;
  if (!isRecord(releases)) {
    return invalid("releases must be an object");
  }
  for (const tool of RELEASE_TOOLS) {
    if (OPTIONAL_RELEASE_TOOLS.includes(tool) && !(tool in releases)) {
      continue;
    }
    const value = releases[tool];
    if (typeof value !== "string" || value.length === 0) {
      return invalid(`releases.${tool} missing`);
    }
  }
  for (const [tool, name] of Object.entries(releases)) {
    if (typeof name !== "string" || !RELEASE_NAME_RE.test(name) || !RELEASE_NAME_RE.test(tool)) {
      return invalid(`releases.${tool.slice(0, 40)} is not a release directory name`);
    }
  }
  if (JSON.stringify(releases).length > RELEASES_MAX) {
    return invalid("releases too large");
  }
  return { ok: true, body, problems };
}

export class FakeBroker {
  readonly requests: BrokerRequestRecord[] = [];
  script: BrokerScript;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly jobs = new Map<string, Job>();
  /** Jobs being deleted (the scripted DELETE delay): the pod is terminating — still there, still addressable by uid. */
  private readonly terminating = new Map<string, { job: Job; done: Promise<void> }>();
  /** DELETEs of a key in progress / answered so far (the real broker's tombstone: `delete_begins`, `delete_ends`). */
  private readonly deleteActive = new Map<string, number>();
  private readonly deleteAnswered = new Map<string, number>();
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
    this.deleteActive.clear();
    this.deleteAnswered.clear();
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

  private finalLine(job: Job, key: string, final: BrokerFinal | undefined): string {
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
    // the placement the Job was actually routed to (an `auto` request routed home says home)
    const placement = given.placement ?? job.target;
    const ip = given.ip ?? `10.244.${String(job.seq % 250)}.10`;
    const pod = given.pod ?? `ag-${key}`;
    const uid = job.uid;
    const node = given.node ?? "node-a";
    return `ready ip=${ip} pod=${pod} uid=${uid} node=${node} placement=${placement}`;
  }

  private async runJob(job: Job): Promise<void> {
    let spec: BrokerThen & { steps?: BrokerStep[] } = job.behavior;
    for (;;) {
      for (const step of spec.steps ?? []) {
        const line = typeof step === "string" ? step : step.line;
        const delayMs = typeof step === "string" ? 0 : (step.delayMs ?? 0);
        await this.sleep(job, delayMs);
        if (job.deleted) {
          return;
        }
        job.lines.push(line);
        this.notify(job);
      }
      if (spec.hang === true) {
        return;
      }
      await this.sleep(job, spec.finalDelayMs ?? 0);
      if (job.deleted) {
        return;
      }
      const line = this.finalLine(job, job.key, spec.final);
      if (line === "error timeout" || line === "error kube_api_error") {
        // These end THE STREAM, not the Job (broker.py: "the Job continues"): the creator's stream ends with the
        // line, the Job keeps its slot and its uid, and a later POST follows it — from the current phase, with its
        // own wait — and may see it ready (`then`).
        job.creatorEnd = line;
        this.notify(job);
        if (spec.afterTimeout === undefined) {
          return;
        }
        spec = spec.afterTimeout;
        continue;
      }
      job.lines.push(line);
      job.done = true;
      // A final that is not `ready` leaves no pod behind: the next POST of the key is a new request —
      // admission is evaluated again and a Job with a new uid is created (never a replay of this line).
      job.ended = !line.startsWith("ready ");
      this.notify(job);
      return;
    }
  }

  /**
   * The pod of `key` ends by itself (an idle exit, a failure): a stream still following it ends
   * `error start_failed`, and the next POST creates a NEW Job with a new uid (the real broker deletes
   * the ended Job and re-creates). Returns false when the key has no Job.
   */
  endPod(key: string): boolean {
    const job = this.jobs.get(key);
    if (job === undefined) {
      return false;
    }
    if (!job.done) {
      for (const timer of job.timers) {
        clearTimeout(timer);
      }
      job.timers.clear();
      job.lines.push("error start_failed");
      job.done = true;
    }
    job.ended = true;
    this.notify(job);
    return true;
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
    // the follower snapshot is taken once the body is read, as broker.py's `AgentEnsure.__init__` does
    const arrivedAnswered = new Map(this.deleteAnswered);
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
      // `uid or None` (broker.py do_DELETE): an EMPTY uid is no uid — it deletes the key's Job unconditionally.
      const uid = url.searchParams.get("uid");
      await this.handleDelete(key, uid === null || uid === "" ? null : uid, record, response);
      return;
    }
    if (key !== null && KEY_PATTERN.test(key) && method === "POST") {
      await this.handlePost(key, record, request, response, arrivedAnswered.get(key) ?? 0);
      return;
    }
    const knownPath = path === "/v1/agents" || key !== null;
    record.outcome = knownPath ? "method_not_allowed" : "not_found";
    this.sendJson(response, knownPath ? 405 : 404, {
      error: knownPath ? "method_not_allowed" : "not_found",
    });
  }

  /** The limits in force (script `status`, else the defaults named at `BrokerScript.status`). */
  private limits(excludeKey?: string): {
    live: number;
    cap: number;
    reserve: number;
    quota: { used: number; hard: number };
    home: { live: number; cap: number };
    pool: { state: string };
  } {
    const scripted = this.script.status ?? {};
    const occupying = [...this.jobs.values(), ...[...this.terminating.values()].map((t) => t.job)]
      .filter((job) => !job.ended && job.key !== excludeKey)
      .filter((job, index, all) => all.indexOf(job) === index);
    const live = scripted.live ?? occupying.length;
    const cap = scripted.cap ?? 100;
    return {
      live,
      cap,
      reserve: scripted.reserve ?? 1,
      quota: { used: scripted.quota?.used ?? live, hard: scripted.quota?.hard ?? cap },
      home: {
        live: scripted.home?.live ?? occupying.filter((job) => job.target === "home").length,
        cap: scripted.home?.cap ?? 0,
      },
      pool: scripted.pool ?? { state: "ready" },
    };
  }

  private statusBody(): Record<string, unknown> {
    return { ...this.limits() };
  }

  /** broker.py `admission_refusal`: the cap and the reserve, then the box quota, then the home cap. */
  private admissionRefusal(klass: string, target: string): string | null {
    const cap = this.limits();
    if (cap.live >= cap.cap || (klass !== "interactive" && cap.live >= cap.cap - cap.reserve)) {
      return "agent_cap";
    }
    if (cap.quota.used >= cap.quota.hard) {
      return "quota";
    }
    if (target === "home" && cap.home.live >= cap.home.cap) {
      return "home_full";
    }
    return null;
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
      // the scripted failure is the answer of a DELETE that RAN; a refusal or "nothing there" is always 200
      const ran =
        outcome === "deleted" || outcome === "deleted_terminating" || outcome === "delete_failed";
      const status = ran ? (this.script.delete?.status ?? 200) : 200;
      // the real broker's failure bodies: 504 after the delete wait, 502 when the kube API failed
      const failure =
        status === 504 ? "error timeout\n" : status === 502 ? "error kube_api_error\n" : null;
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(failure !== null && status !== 200 ? failure : body);
    };
    if (uid !== null && target === undefined) {
      // With a uid: no pod of the key at all is a plain empty 200 — nothing to delete.
      answer("deleted_nothing", "");
      return;
    }
    if (uid !== null && target !== undefined && uid !== target.uid) {
      // A wrong uid deletes nothing and says so in the one line C4 defines, still HTTP 200.
      answer("uid_mismatch", "refused reason=uid_mismatch\n");
      return;
    }
    // From here the DELETE's mark is up (broker.py `delete_begins`): every POST of the key that is running
    // — and every one that starts before the answer — ends `error deleted`.
    this.deleteActive.set(key, (this.deleteActive.get(key) ?? 0) + 1);
    try {
      const failing = (this.script.delete?.status ?? 200) !== 200;
      if (live !== undefined && failing && this.script.delete?.status === 504) {
        // broker.py issues `delete_job` (Foreground) BEFORE its wait, and only the WAIT times out: the Job carries a
        // deletionTimestamp, the terminating pod still counts toward the cap, and the next POST waits for it to go
        // (then creates a NEW Job with a NEW uid) or ends `start_failed` — it never follows the old pod as ready.
        this.jobs.delete(key);
        this.cancelJob(live);
        const delay = this.script.delete?.delayMs ?? 0;
        const goneAfter = this.script.delete?.goneAfterMs;
        const done = new Promise<void>((resolve) => {
          if (goneAfter !== null) {
            setTimeout(resolve, Math.max(delay, delay + (goneAfter ?? 0)));
          }
        });
        this.terminating.set(key, { job: live, done });
        void done.then(() => {
          if (this.terminating.get(key)?.job === live) {
            this.terminating.delete(key);
          }
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        answer("delete_failed", "");
        return;
      }
      if (live !== undefined && failing) {
        // 502: the kube API failed — it may have deleted nothing: the pod is still there and the next POST follows it
        await new Promise<void>((resolve) => setTimeout(resolve, this.script.delete?.delayMs ?? 0));
        answer("delete_failed", "");
        return;
      }
      if (live !== undefined) {
        this.jobs.delete(key);
        this.cancelJob(live);
        // The broker "answers when no pod of the key remains" — the fake answers after the scripted delay;
        // until then the pod is terminating: still there, still occupying a slot, a uid still matches.
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
      answer(dying === undefined ? "deleted_nothing" : "deleted_terminating", "");
    } finally {
      this.deleteActive.set(key, Math.max(0, (this.deleteActive.get(key) ?? 1) - 1));
      this.deleteAnswered.set(key, (this.deleteAnswered.get(key) ?? 0) + 1);
    }
  }

  /** broker.py `tombstoned`: a DELETE of the key runs, or one answered after this POST began. */
  private tombstoned(key: string, answeredAtStart: number): boolean {
    return (
      (this.deleteActive.get(key) ?? 0) > 0 || (this.deleteAnswered.get(key) ?? 0) > answeredAtStart
    );
  }

  private async handlePost(
    key: string,
    record: BrokerRequestRecord,
    request: IncomingMessage,
    response: ServerResponse,
    answeredAtStart: number,
  ): Promise<void> {
    try {
      const parsedJson: unknown = JSON.parse(record.bodyText);
      record.body = isRecord(parsedJson) ? parsedJson : null;
    } catch {
      record.body = null;
    }
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
    const parsed = parseAgentBody(record.bodyText, key);
    if (!parsed.ok) {
      record.problems.push(parsed.reason);
      finishWith(parsed.line, parsed.line.replace(" ", "_"));
      return;
    }
    record.problems.push(...parsed.problems);
    const body = parsed.body;

    // broker.py `honour_delete`: a DELETE of the key runs, or answered after this POST began — end now.
    if (this.tombstoned(key, answeredAtStart)) {
      finishWith("error deleted", "error_deleted");
      return;
    }
    let job = this.jobs.get(key);
    // An ended Job (its final line was not `ready`, or its pod ended by itself) is not followed: the old one is
    // dropped and a new request is admitted afresh — a new Job, a new uid.
    if (job !== undefined && job.ended) {
      this.jobs.delete(key);
      job = undefined;
    }
    let follower = true;
    if (job === undefined) {
      follower = false;
      // "never created while another pod of the key is terminating" (K4): wait for it to go, bounded; a pod that
      // does not go ends the request `start_failed` (broker.py ensure_job / wait_gone)
      const dying = this.terminating.get(key);
      if (dying !== undefined) {
        const waitMs = this.script.delete?.goneWaitMs ?? 1000;
        await Promise.race([
          dying.done,
          new Promise<void>((resolve) => setTimeout(resolve, waitMs)),
        ]);
        if (this.terminating.get(key) === dying) {
          finishWith("error start_failed", "error_start_failed");
          return;
        }
        if (this.tombstoned(key, answeredAtStart)) {
          finishWith("error deleted", "error_deleted");
          return;
        }
      }
      const klass = body.class as string;
      const asked = body.placement as string;
      const target =
        asked === "auto" ? (this.limits().pool.state === "ready" ? "pool" : "home") : asked;
      const refusal = this.admissionRefusal(klass, target);
      if (refusal !== null) {
        const cap = this.limits();
        // No Job is created: the next POST is evaluated again.
        finishWith(
          `refused reason=${refusal} live=${String(cap.live)} cap=${String(cap.cap)}`,
          "refused",
        );
        return;
      }
      if (asked === "pool" && this.limits().pool.state !== "ready") {
        // an explicit pool request when the pool template is not usable: broker.py create() -> template_rejected
        finishWith("error template_rejected", "error_template_rejected");
        return;
      }
      const behavior = this.behaviorFor(key);
      if (behavior.respond !== undefined) {
        const { status, body: answer, headers } = behavior.respond;
        record.outcome = `respond_${String(status)}`;
        response.writeHead(status, headers ?? { "content-type": "text/plain" });
        response.end(answer ?? "");
        return;
      }
      this.jobCounter += 1;
      const scriptedFinal = behavior.final;
      const scriptedPlacement =
        scriptedFinal !== undefined && typeof scriptedFinal === "object" && "ready" in scriptedFinal
          ? scriptedFinal.ready.placement
          : undefined;
      job = {
        seq: this.jobCounter,
        key,
        uid: this.podUidFor(behavior, key, this.jobCounter),
        behavior,
        lines: [],
        creatorEnd: undefined,
        done: false,
        ended: false,
        deleted: false,
        // a scripted `ready placement=…` is where the pod is: occupancy and the line must agree
        target:
          scriptedPlacement === "home" || scriptedPlacement === "pool" ? scriptedPlacement : target,
        dropsLeft: behavior.drop?.times ?? 1,
        timers: new Set(),
        wake: new Set(),
        request: body,
      };
      this.jobs.set(key, job);
      this.runJob(job).catch(() => undefined);
    }
    record.joinedExistingJob = follower;
    record.jobSeq = job.seq;
    await this.streamJob(job, record, request, response, stream, follower, answeredAtStart);
  }

  private async streamJob(
    job: Job,
    record: BrokerRequestRecord,
    request: IncomingMessage,
    response: ServerResponse,
    openStream: () => void,
    follower: boolean,
    answeredAtStart: number,
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
    const waitExpired = { value: false };
    const waitMs = job.behavior.agentWaitMs;
    const waitTimer =
      follower && waitMs !== undefined
        ? setTimeout(() => {
            waitExpired.value = true;
            this.notify(job);
          }, waitMs)
        : undefined;
    response.once("close", () => clearTimeout(waitTimer));
    // A follower starts a fresh tracker at the Job's CURRENT phase (broker.py `follow`): it is told where the
    // pod is now — the last step, or the final line — never the history; a step it already sent is not repeated.
    let sent = follower ? Math.max(0, job.lines.length - 1) : 0;
    let lastStep: string | null = null;
    const dropNow = (): boolean => {
      if (wantDrop && drop !== undefined && record.linesSent.length >= drop.afterLines) {
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
        const isFinal = job.done && sent === job.lines.length - 1;
        sent += 1;
        if (!isFinal && line === lastStep) {
          continue;
        }
        lastStep = isFinal ? null : line;
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
      if (!follower && job.creatorEnd !== undefined) {
        record.linesSent.push(job.creatorEnd);
        record.outcome = "final";
        response.end(`${job.creatorEnd}\n`);
        return;
      }
      if (follower && waitExpired.value) {
        // the follower's OWN timeout: its stream ends, the Job continues
        record.linesSent.push("error timeout");
        record.outcome = "final";
        response.end("error timeout\n");
        return;
      }
      if (job.deleted || this.tombstoned(job.key, answeredAtStart)) {
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
    if (method === "POST" && path === "/_kit/end-pod") {
      const key = (JSON.parse(text) as { key: string }).key;
      this.sendJson(response, 200, { ok: this.endPod(key) });
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
