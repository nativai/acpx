import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GovernorConstants } from "../constants.js";
import type { GovProc } from "./classify.js";
import { writeFileAtomic } from "./classify.js";

/**
 * CONCEPTION 5d7a23b6 §6.2–6.3 — telling. Nothing silent:
 *   - IN-BAND: before the sweep, one line appended to the session leader's own stderr
 *     (`/proc/<leader>/fd/2`, write-only, append, non-blocking), so the reason lands in the same tool
 *     result as the `Killed` — without it the natural next move is to retry the same command. When the
 *     leader is dead (a storm backgrounded by an ordinary tool call), to the OLDEST surviving member's
 *     fd 2, else its fd 1 (§19 D2): a background task's capture file, or the tool's pipe while Claude
 *     still reads it; /dev/null swallows it, which is accepted;
 *   - OUT OF BAND: a message to the owner's seat through atrium (the worktree reaper's mechanism,
 *     F12), deduped per (session, rule) per 10 min, with an outbox while atrium is down.
 * Comm names and numbers only: never argv, environment, cwd or paths.
 */

export const DEFAULT_ATRIUM_URL = "http://127.0.0.1:3456";
const FROM = "process-governor";
const POST_TIMEOUT_MS = 5000;

export type KillFacts = {
  readonly rule: "fork-storm" | "memory-emergency";
  readonly processes: number;
  readonly limit: number;
  readonly anonBytes?: number;
  readonly committedBytes?: number;
  readonly limitBytes?: number;
  readonly commTop: ReadonlyArray<readonly [string, number]>;
  readonly eventId: string;
  /** The command's start (the remembered leader's start ticks), when known. */
  readonly startedAt?: string;
  /** When the start is unknown (first seen without a leader): when the governor first saw it. */
  readonly firstSeenAt?: string;
  readonly orphaned: boolean;
  /** A terminal's second sweep within 60 s: the interactive shell was ended too (§5.1). */
  readonly shellEnded?: boolean;
};

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
const classes = (commTop: KillFacts["commTop"]): string =>
  commTop.map(([comm, n]) => `${comm}×${n}`).join(" ");

const REMEDY_STORM =
  "A command that forks without bound — a recursive function, a `&` loop, a fork bomb (for example " +
  "tr(){ … | tr …; }, a function that calls the command it shadows) — never stops by itself; heavy or " +
  "parallel work belongs in workbench-exec.";
const REMEDY_MEMORY = "Heavy work belongs in workbench-exec, not on the control pod.";

function ruleSummary(facts: KillFacts): string {
  if (facts.rule === "fork-storm") {
    return `rule=fork-storm processes=${facts.processes} limit=${facts.limit}`;
  }
  const box =
    facts.committedBytes !== undefined && facts.limitBytes !== undefined
      ? ` box=${gib(facts.committedBytes)}/${gib(facts.limitBytes)}`
      : "";
  return `rule=memory-emergency processes=${facts.processes} memory=${gib(facts.anonBytes ?? 0)}${box}`;
}

/** §6.2: the one line appended to the killed command's own stderr. */
export function inBandLine(facts: KillFacts): string {
  const remedy = facts.rule === "fork-storm" ? REMEDY_STORM : REMEDY_MEMORY;
  const untouched = facts.shellEnded
    ? "Your shell was ended too: this terminal ran away twice within 60 s."
    : "Nothing else in your session was touched.";
  return (
    `process-governor: KILLED this command (${ruleSummary(facts)}; ${classes(facts.commTop)}). ` +
    `${untouched} ${remedy} ` +
    `Event ${facts.eventId} in ~/.acpx/governor/events.ndjson.\n`
  );
}

function appendTo(file: string, line: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NONBLOCK);
    fs.writeSync(fd, line);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Append the line to `target`'s fd 2, else its fd 1 — `target` is the leader, or, with the leader
 * dead, the oldest surviving member (§19 D2). Same uid and `bash` is dumpable, so the open is
 * permitted. Best effort, never retried, written once. The target is re-checked by start ticks first:
 * a recycled pid must never receive it.
 */
export function writeInBand(
  procRoot: string,
  target: GovProc,
  line: string,
  stillAlive: (proc: GovProc) => boolean,
): "fd2" | "fd1" | "failed" | "gone" {
  if (!stillAlive(target)) {
    return "gone";
  }
  if (appendTo(`${procRoot}/${target.pid}/fd/2`, line)) {
    return "fd2";
  }
  return appendTo(`${procRoot}/${target.pid}/fd/1`, line) ? "fd1" : "failed";
}

/** §6.3: the seat message. */
export function seatMessageText(facts: KillFacts, repeats = 0): string {
  const lines = [
    `process-governor KILLED a runaway command in this session (${ruleSummary(facts)}; ${classes(facts.commTop)}).`,
  ];
  if (facts.startedAt) {
    lines.push(`The command started at ${facts.startedAt} UTC — match it to your own tool call.`);
  } else if (facts.firstSeenAt) {
    lines.push(
      `It was first seen at ${facts.firstSeenAt} UTC (its own start is unknown) — match it to your own tool call.`,
    );
  }
  if (facts.orphaned) {
    lines.push(
      "It was ORPHANED: its tool call had already ended or been stopped — a stopped background task can leave a running remainder.",
    );
  }
  if (repeats > 0) {
    lines.push(
      `The same rule killed ${repeats} more command(s) of this session in the last 10 minutes.`,
    );
  }
  lines.push(
    "Untouched: your session, its other commands and its context are intact.",
    `Instead: ${facts.rule === "fork-storm" ? REMEDY_STORM : REMEDY_MEMORY}`,
    `Record: \`acpx governor status\` (event ${facts.eventId}).`,
  );
  return lines.join("\n");
}

export type MessageTarget = { readonly kind: "seat" | "session"; readonly id: string };

export type NotifyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

/** `sent` · `deduped` · `outbox` · `session_closed` · `no_target`. */
export type NotifyStatus = "sent" | "deduped" | "outbox" | "session_closed" | "no_target";

type OutboxItem = {
  id: string;
  target: MessageTarget;
  text: string;
  firstMs: number;
  attempts: number;
};

type DedupeWindow = {
  startMs: number;
  repeats: number;
  target: MessageTarget;
  facts: KillFacts;
};

const SAFE_ID = /^[A-Za-z0-9._-]+$/u;

export function messageUrl(atriumUrl: string, target: MessageTarget): string {
  const base = atriumUrl.replace(/\/+$/u, "");
  return `${base}/api/${target.kind === "seat" ? "seats" : "sessions"}/${encodeURIComponent(target.id)}/message`;
}

export class Notifier {
  private readonly windows = new Map<string, DedupeWindow>();
  private lastOutboxRetryMs = 0;

  constructor(
    private readonly options: {
      readonly atriumUrl: string;
      readonly outboxDir: string;
      readonly fetchImpl: NotifyFetch;
      readonly constants: GovernorConstants;
      readonly log: (line: string) => void;
    },
  ) {}

  /** One POST. `sent`, `session_closed` (409 SESSION_CLOSED, final) or `failed`. */
  private async post(
    target: MessageTarget,
    text: string,
  ): Promise<"sent" | "session_closed" | "failed"> {
    try {
      const response = await this.options.fetchImpl(messageUrl(this.options.atriumUrl, target), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Source-Session": FROM },
        body: JSON.stringify({ text, from: FROM }),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (response.status >= 200 && response.status < 300) {
        return "sent";
      }
      if (response.status === 409) {
        const body = await response.text().catch(() => "");
        if (body.includes("SESSION_CLOSED")) {
          return "session_closed";
        }
      }
      return "failed";
    } catch {
      return "failed";
    }
  }

  private toOutbox(target: MessageTarget, text: string, nowMs: number): void {
    const item: OutboxItem = { id: randomUUID(), target, text, firstMs: nowMs, attempts: 1 };
    writeFileAtomic(path.join(this.options.outboxDir, `${item.id}.json`), JSON.stringify(item));
  }

  private async deliver(target: MessageTarget, text: string, nowMs: number): Promise<NotifyStatus> {
    const result = await this.post(target, text);
    if (result === "failed") {
      this.toOutbox(target, text, nowMs);
      return "outbox";
    }
    return result;
  }

  /**
   * A kill's message. The first per (key, rule) in a window is sent now; repeats inside the window
   * only count, and one summary goes out when the window closes ({@link tick}).
   */
  async notify(
    key: string,
    target: MessageTarget | undefined,
    facts: KillFacts,
    nowMs: number,
  ): Promise<NotifyStatus> {
    if (!target || !SAFE_ID.test(target.id)) {
      return "no_target";
    }
    const windowKey = `${key}\0${facts.rule}`;
    const open = this.windows.get(windowKey);
    if (open && nowMs - open.startMs < this.options.constants.messageDedupeMs) {
      open.repeats += 1;
      open.facts = facts;
      return "deduped";
    }
    this.windows.set(windowKey, { startMs: nowMs, repeats: 0, target, facts });
    return this.deliver(target, seatMessageText(facts), nowMs);
  }

  private async flushWindows(nowMs: number): Promise<void> {
    for (const [key, window] of this.windows) {
      if (nowMs - window.startMs < this.options.constants.messageDedupeMs) {
        continue;
      }
      this.windows.delete(key);
      if (window.repeats > 0) {
        await this.deliver(window.target, seatMessageText(window.facts, window.repeats), nowMs);
      }
    }
  }

  private readOutbox(): Array<{ file: string; item: OutboxItem }> {
    let names: string[];
    try {
      names = fs.readdirSync(this.options.outboxDir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const items: Array<{ file: string; item: OutboxItem }> = [];
    for (const name of names) {
      const file = path.join(this.options.outboxDir, name);
      try {
        items.push({ file, item: JSON.parse(fs.readFileSync(file, "utf8")) as OutboxItem });
      } catch {
        fs.rmSync(file, { force: true });
      }
    }
    return items;
  }

  /**
   * Retry the outbox every `outboxRetryMs` for `outboxTtlMs`, then drop with an event (returned).
   * A 409 SESSION_CLOSED is final: the session is gone.
   */
  private async retryOutbox(nowMs: number): Promise<OutboxItem[]> {
    if (nowMs - this.lastOutboxRetryMs < this.options.constants.outboxRetryMs) {
      return [];
    }
    this.lastOutboxRetryMs = nowMs;
    const dropped: OutboxItem[] = [];
    for (const { file, item } of this.readOutbox()) {
      if (nowMs - item.firstMs >= this.options.constants.outboxTtlMs) {
        fs.rmSync(file, { force: true });
        dropped.push(item);
        continue;
      }
      const result = await this.post(item.target, item.text);
      if (result === "failed") {
        writeFileAtomic(file, JSON.stringify({ ...item, attempts: item.attempts + 1 }));
      } else {
        fs.rmSync(file, { force: true });
        this.options.log(`process-governor outbox ${item.id} ${result}`);
      }
    }
    return dropped;
  }

  /** Close expired dedupe windows and retry the outbox. Returns messages dropped after 1 h. */
  async tick(nowMs: number): Promise<number> {
    await this.flushWindows(nowMs);
    return (await this.retryOutbox(nowMs)).length;
  }
}
