import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SessionKind } from "./classify.js";
import { writeFileAtomic } from "./classify.js";

/**
 * CONCEPTION 5d7a23b6 §6.4 — the record. One event shape, three sinks:
 *   - `~/.acpx/governor/events.ndjson` — AUTHORITATIVE, rotated at 10 MB;
 *   - ClickHouse `acpx_usage.process_governor_events_v1` — best effort, the OOM flight recorder's
 *     writer contract (fixed endpoint, user `acpx`, password file read into memory only, one retry
 *     on timeout/5xx/connection, HTTP 4xx = no retry);
 *   - one stdout line (→ the container log).
 *
 * 🛑 The event's keys ARE the table's columns (contract `contracts/process_governor_events_v1.sql`
 * in brick 5d7a23b6). The live server runs with `input_format_skip_unknown_fields = 1`: a missing or
 * misspelled key is SILENTLY skipped — HTTP 200, the column keeps its default — so NOTHING at runtime
 * tells you a key is wrong. The only guard is the test row "record: the ClickHouse row's keys are
 * exactly the contract's columns", which carries the contract's column list as a literal and fails on
 * a missing key and on an extra one. Value errors (timestamp form, UUID, non-number) are still 4xx.
 * Never argv, environment, cwd or paths in any field.
 */

export type GovernorAction =
  | "killed"
  | "would_kill"
  | "kill_incomplete"
  | "kill_failed_eperm"
  | "pressure_no_victim"
  | "r2_blind"
  | "ungoverned_burst"
  | "notify_dropped"
  | "peaks";

export type GovernorRule = "fork-storm" | "memory-emergency" | "";

export type GovernorEvent = {
  event_id: string;
  captured_at: string;
  box: string;
  mode: "enforce" | "observe";
  rule: GovernorRule;
  action: GovernorAction;
  session_kind: SessionKind | "";
  orphaned: boolean | null;
  session_id: string;
  seat_id: string;
  attribution: string;
  processes: number | null;
  threads: number | null;
  anon_bytes: number | null;
  comm_top: Array<[string, number]>;
  started_at: string | null;
  rounds: number | null;
  kill_ms: number | null;
  survivors: number | null;
  box_committed_bytes: number | null;
  box_limit_bytes: number | null;
  psi_full_avg10: number | null;
  notified: boolean;
  notify_status: string;
  test: boolean;
};

/** The contract's columns, in DDL order. */
export const EVENT_COLUMNS = [
  "event_id",
  "captured_at",
  "box",
  "mode",
  "rule",
  "action",
  "session_kind",
  "orphaned",
  "session_id",
  "seat_id",
  "attribution",
  "processes",
  "threads",
  "anon_bytes",
  "comm_top",
  "started_at",
  "rounds",
  "kill_ms",
  "survivors",
  "box_committed_bytes",
  "box_limit_bytes",
  "psi_full_avg10",
  "notified",
  "notify_status",
  "test",
] as const satisfies ReadonlyArray<keyof GovernorEvent>;

/**
 * ⚠️ DO NOT "fix" this to ISO 8601 (`…T…Z`). ClickHouse's `date_time_input_format` is `basic` and
 * refuses the `T` and the `Z` with Code 27 / HTTP 400 — the writer's no-retry class — so every row
 * would be dropped on its first attempt (the OOM flight recorder shipped exactly that bug). Both
 * columns are `DateTime64(3, 'UTC')`, so the space-separated UTC form carries no ambiguity.
 */
export function clickhouseTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** `clickhouseTime` back to epoch ms. */
export function parseClickhouseTime(value: string): number {
  return Date.parse(`${value.replace(" ", "T")}Z`);
}

export function emptyEvent(
  base: Pick<GovernorEvent, "box" | "mode" | "test" | "action">,
  nowMs: number,
): GovernorEvent {
  return {
    event_id: randomUUID(),
    captured_at: clickhouseTime(nowMs),
    rule: "",
    session_kind: "",
    orphaned: null,
    session_id: "",
    seat_id: "",
    attribution: "",
    processes: null,
    threads: null,
    anon_bytes: null,
    comm_top: [],
    started_at: null,
    rounds: null,
    kill_ms: null,
    survivors: null,
    box_committed_bytes: null,
    box_limit_bytes: null,
    psi_full_avg10: null,
    notified: false,
    notify_status: "",
    ...base,
  };
}

/** The ClickHouse row: exactly {@link EVENT_COLUMNS}, nothing else. */
export function clickhouseRow(event: GovernorEvent): Record<string, unknown> {
  return Object.fromEntries(EVENT_COLUMNS.map((column) => [column, event[column]]));
}

// ---------------------------------------------------------------------------
// Box identity — CONFIGURATION, never derivation; fails closed (the recorder's rule)
// ---------------------------------------------------------------------------

/**
 * The label every fixture/test row carries, so no production query (`WHERE box = '<real FQDN>'`)
 * can select it. Agreed with the infra lane's contract (§16; CONCEPTION §18 C2).
 */
export const FIXTURE_BOX = "fixture.invalid";

const BOX_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;

export type BoxIdentity = { box: string; reason?: undefined } | { box: undefined; reason: string };

/**
 * `OOM_CLICKHOUSE_BOX`, else `NATIVAI_BOX_FQDN`, validated. A wrong label is unrepairable (all five
 * boxes write one table, `box` the only discriminator), so unset or malformed ⇒ NO ClickHouse rows.
 * In test mode every row carries {@link FIXTURE_BOX}: a workbench inherits the caller's
 * `NATIVAI_BOX_FQDN`, so a test row would otherwise be filed under the real box (§18 C2).
 */
export function resolveBoxIdentity(env: NodeJS.ProcessEnv, testMode: boolean): BoxIdentity {
  if (testMode) {
    return { box: FIXTURE_BOX };
  }
  const value = env.OOM_CLICKHOUSE_BOX || env.NATIVAI_BOX_FQDN || "";
  const reason = boxRefusal(value);
  return reason ? { box: undefined, reason } : { box: value };
}

function boxRefusal(value: string): string | undefined {
  if (!value) {
    return "box_identity_unset";
  }
  if (value === FIXTURE_BOX) {
    return "box_identity_reserved";
  }
  const valid = value.length <= 253 && BOX_PATTERN.test(value) && value.includes(".");
  return valid ? undefined : "box_identity_invalid";
}

// ---------------------------------------------------------------------------
// ClickHouse writer
// ---------------------------------------------------------------------------

export const CLICKHOUSE_ENDPOINT = "http://acpx-clickhouse.acpx-analytics.svc.cluster.local:8123";
export const CLICKHOUSE_PASSWORD_FILE = "/run/secrets/acpx-clickhouse/password";
const CLICKHOUSE_USER = "acpx";
const INSERT_QUERY =
  "/?database=acpx_usage&query=INSERT%20INTO%20process_governor_events_v1%20FORMAT%20JSONEachRow" +
  "&async_insert=1&wait_for_async_insert=1";
const CLICKHOUSE_TIMEOUT_MS = 2000;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

type InsertOutcome =
  | "ok"
  | "clickhouse_4xx"
  | "clickhouse_5xx"
  | "clickhouse_timeout"
  | "clickhouse_connection";

export type ClickHouseConfig =
  | { enabled: true; endpoint: string; password: string; fetchImpl: FetchLike; capture?: boolean }
  | { enabled: false; reason: string };

/**
 * TEST MODE ONLY, and only where the credential is absent (a workbench has no
 * `/run/secrets/acpx-clickhouse`): instead of POSTing, append each exact JSONEachRow body — the same
 * bytes the writer would send — to a local file. A tester then parses those rows against the live
 * server's read-only `format()` from a control pod. The real INSERT is first exercised on staging.
 */
export function captureFetch(file: string): FetchLike {
  return async (_url, init) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, init.body);
    return { status: 200 };
  };
}

type WriterOptions = {
  env: NodeJS.ProcessEnv;
  testMode: boolean;
  /** False for a governor that is not the supervised production instance: local events only. */
  allowed: boolean;
  box: BoxIdentity;
  fetchImpl: FetchLike;
  /** Test mode without the credential: where to capture the rows ({@link captureFetch}). */
  captureFile?: string;
};

/**
 * The writer's configuration. The endpoint is FIXED; a test may point it at `http://127.0.0.1:<port>`
 * only with `ACPX_GOVERNOR_TEST=1`. The password is read once into memory — never argv, env or disk.
 */
export function clickHouseConfig(options: WriterOptions): ClickHouseConfig {
  const refusal = writerRefusal(options);
  if (refusal !== undefined) {
    return { enabled: false, reason: refusal };
  }
  const env = options.env;
  const password = readPassword(
    env.ACPX_GOVERNOR_CLICKHOUSE_PASSWORD_FILE || CLICKHOUSE_PASSWORD_FILE,
  );
  if (!password) {
    return options.testMode && options.captureFile
      ? {
          enabled: true,
          endpoint: "capture",
          password: "",
          fetchImpl: captureFetch(options.captureFile),
          capture: true,
        }
      : { enabled: false, reason: "clickhouse_password_unreadable" };
  }
  const endpoint = env.ACPX_GOVERNOR_CLICKHOUSE_URL || CLICKHOUSE_ENDPOINT;
  return { enabled: true, endpoint, password, fetchImpl: options.fetchImpl };
}

function writerRefusal(options: WriterOptions): string | undefined {
  if (!options.allowed) {
    return "clickhouse_not_supervised";
  }
  if (options.box.reason !== undefined) {
    return options.box.reason;
  }
  const endpoint = options.env.ACPX_GOVERNOR_CLICKHOUSE_URL || undefined;
  const passwordFile = options.env.ACPX_GOVERNOR_CLICKHOUSE_PASSWORD_FILE || undefined;
  return overridesAllowed(endpoint, passwordFile, options.testMode)
    ? undefined
    : "clickhouse_config_invalid";
}

/** Overrides only in test mode, and the endpoint only a loopback port (the recorder's rule). */
function overridesAllowed(
  endpoint: string | undefined,
  passwordFile: string | undefined,
  testMode: boolean,
): boolean {
  if (endpoint === undefined && passwordFile === undefined) {
    return true;
  }
  return (
    testMode && (endpoint === undefined || /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(endpoint))
  );
}

function readPassword(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").replace(/[\r\n]/gu, "") || undefined;
  } catch {
    return undefined;
  }
}

function insertOutcome(status: number): InsertOutcome {
  if (status >= 200 && status < 300) {
    return "ok";
  }
  return status >= 400 && status < 500 ? "clickhouse_4xx" : "clickhouse_5xx";
}

function failureOutcome(error: unknown): InsertOutcome {
  const name = (error as { name?: unknown } | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError"
    ? "clickhouse_timeout"
    : "clickhouse_connection";
}

export class ClickHouseWriter {
  private queue: Array<Record<string, unknown>> = [];
  private sending = false;
  lastStatus = "idle";

  constructor(
    private readonly config: ClickHouseConfig,
    private readonly log: (line: string) => void,
  ) {
    if (!config.enabled) {
      this.lastStatus = config.reason;
      log(`process-governor clickhouse writer disabled: ${config.reason}`);
    }
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  enqueue(row: Record<string, unknown>): void {
    if (this.config.enabled) {
      this.queue.push(row);
    }
  }

  private async attempt(body: string): Promise<InsertOutcome> {
    if (!this.config.enabled) {
      return "clickhouse_connection";
    }
    const auth = Buffer.from(`${CLICKHOUSE_USER}:${this.config.password}`).toString("base64");
    try {
      const response = await this.config.fetchImpl(`${this.config.endpoint}${INSERT_QUERY}`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-ndjson" },
        body,
        signal: AbortSignal.timeout(CLICKHOUSE_TIMEOUT_MS),
      });
      return insertOutcome(response.status);
    } catch (error) {
      return failureOutcome(error);
    }
  }

  private get capturing(): boolean {
    return this.config.enabled && this.config.capture === true;
  }

  /** One retry on timeout, 5xx or a connection failure; HTTP 4xx is never retried (the recorder's rule). */
  private async attemptWithRetry(body: string): Promise<InsertOutcome> {
    const first = await this.attempt(body);
    return first === "ok" || first === "clickhouse_4xx" ? first : this.attempt(body);
  }

  /** Send everything queued, one POST. Returns the outcome (`ok` when nothing was queued). */
  async flush(): Promise<string> {
    if (this.sending || this.queue.length === 0) {
      return "ok";
    }
    this.sending = true;
    const rows = this.queue;
    this.queue = [];
    const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    try {
      const outcome = await this.attemptWithRetry(body);
      this.lastStatus = outcome === "ok" && this.capturing ? "captured" : outcome;
      if (outcome !== "ok") {
        this.log(`process-governor clickhouse writer ${outcome}: ${rows.length} row(s) dropped`);
      }
      return outcome;
    } finally {
      this.sending = false;
    }
  }
}

// ---------------------------------------------------------------------------
// events.ndjson + stdout
// ---------------------------------------------------------------------------

export function appendEventFile(file: string, event: GovernorEvent, rotateBytes: number): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      // first event
    }
    if (size >= rotateBytes) {
      fs.renameSync(file, `${file}.1`);
    }
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch {
    // The stdout line and the ClickHouse row still carry it.
  }
}

/** One stdout line per event — `kubectl logs` during an incident. */
export function eventLogLine(event: GovernorEvent, sid?: number): string {
  const fields: Array<[string, unknown]> = [
    ["rule", event.rule],
    ["mode", event.mode],
    ["kind", event.session_kind],
    ["sid", sid],
    ["processes", event.processes],
    ["anon_mib", event.anon_bytes === null ? null : Math.round(event.anon_bytes / 1048576)],
    ["comm", event.comm_top.map(([c, n]) => `${c}x${n}`).join(",")],
    ["session", event.session_id],
    ["attribution", event.attribution],
    ["orphaned", event.orphaned],
    ["rounds", event.rounds],
    ["kill_ms", event.kill_ms],
    ["survivors", event.survivors],
    ["notify", event.notify_status],
    ["test", event.test || null],
    ["event", event.event_id],
  ];
  const parts = fields
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([name, value]) => `${name}=${String(value)}`);
  return [`process-governor ${event.captured_at}Z ${event.action}`, ...parts].join(" ");
}

// ---------------------------------------------------------------------------
// peaks — the day's largest session per kind (§6.4, AC7; CONCEPTION §18 C1)
// ---------------------------------------------------------------------------

export type KindPeak = {
  /** Max processes of any one session of this kind today, and that session's details. */
  processes: number;
  threads: number;
  commTop: Array<[string, number]>;
  sessionId: string;
  seatId: string;
  attribution: string;
  /** Max Σ RssAnon+VmPTE of any one session of this kind today — independent of `processes`. */
  anonBytes: number;
  killed: boolean;
};

export type PeaksDay = {
  day: string;
  kinds: Partial<Record<SessionKind, KindPeak>>;
  /** The day's rows were appended to events.ndjson. */
  recorded: boolean;
  /** …and accepted by ClickHouse (or ClickHouse is disabled). */
  delivered: boolean;
};

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A deterministic UUID per (box, day, kind): a re-sent peaks row replaces the earlier one. */
export function peaksEventId(box: string, day: string, kind: string): string {
  const hex = createHash("sha256").update(`peaks\0${box}\0${day}\0${kind}`).digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The rows for one finished day: one per kind seen, or one empty-kind zero row when nothing governed
 * was seen, so a missing row always means a real gap. `captured_at` is 00:00:00.000 of that day: the
 * table is partitioned by day, and a re-send only replaces a row inside the same partition.
 */
export function peaksEvents(
  day: PeaksDay,
  base: Pick<GovernorEvent, "box" | "mode" | "test">,
): GovernorEvent[] {
  const midnight = Date.parse(`${day.day}T00:00:00.000Z`);
  const kinds = Object.entries(day.kinds) as Array<[SessionKind, KindPeak]>;
  const rows: Array<[SessionKind | "", KindPeak | undefined]> =
    kinds.length > 0 ? kinds : [["", undefined]];
  return rows.map(([kind, peak]) => peaksEvent(day.day, base, midnight, kind, peak ?? ZERO_PEAK));
}

const ZERO_PEAK: KindPeak = {
  processes: 0,
  threads: 0,
  commTop: [],
  sessionId: "",
  seatId: "",
  attribution: "",
  anonBytes: 0,
  killed: false,
};

function peaksEvent(
  day: string,
  base: Pick<GovernorEvent, "box" | "mode" | "test">,
  midnight: number,
  kind: SessionKind | "",
  peak: KindPeak,
): GovernorEvent {
  const event = emptyEvent({ ...base, action: "peaks" }, midnight);
  event.event_id = peaksEventId(base.box, day, kind);
  event.session_kind = kind;
  event.processes = peak.processes;
  event.threads = peak.threads;
  event.anon_bytes = peak.anonBytes;
  event.comm_top = peak.commTop;
  event.session_id = peak.sessionId;
  event.seat_id = peak.seatId;
  event.attribution = peak.attribution;
  event.notify_status = peak.killed ? "killed" : "";
  return event;
}

export function loadPeaksDay(file: string, day: string): PeaksDay {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PeaksDay;
    if (parsed && parsed.day === day && typeof parsed.kinds === "object") {
      return parsed;
    }
  } catch {
    // a new day
  }
  return { day, kinds: {}, recorded: false, delivered: false };
}

export function savePeaksDay(dir: string, peaks: PeaksDay): void {
  writeFileAtomic(path.join(dir, `${peaks.day}.json`), `${JSON.stringify(peaks)}\n`);
}

/** Unfinished past days on disk (recorded or delivered still false), oldest first. */
export function pendingPeaksDays(dir: string, today: string): PeaksDay[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/u.test(name) && name.slice(0, 10) < today)
    .toSorted()
    .map((name) => loadPeaksDay(path.join(dir, name), name.slice(0, 10)))
    .filter((day) => !day.recorded || !day.delivered);
}
