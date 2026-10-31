import fs from "node:fs";
import path from "node:path";

/**
 * The waiting dir (CONCEPTION e8abe1e8 §3.2.3, §5): automation sessions that wait for room, as
 * published by whoever holds them (atrium's capacity drainer). acpx only READS it: the count W is
 * taken off every agent slot figure (`readCapacity`, class `spawn`), so queued automation starts
 * before new agent fan-out, and `acpx capacity` lists the items.
 *
 * ── CONTRACT (acpx owns it; acpx-ui writes it; both test against
 *    `test/fixtures/capacity/waiting/atrium-example.json`, copied byte-identical) ──────────────────
 *
 *   Location  `<admission dir>/waiting/<writer>.json` — the admission dir is `ACPX_ADMISSION_DIR`,
 *             else `<passwd home>/.acpx/admission` (`ledger.ts`). One file per writer; acpx sums
 *             them all, so a sandbox rig's queue on the same control pod adds to production's
 *             instead of overwriting it.
 *   Write     mode 0600, temp file + rename. The temp name must NOT end in `.json` (only `*.json`
 *             is read). Rewritten on every change and at least every 60 s while non-empty; deleted
 *             when the list empties. Written by the executor only.
 *   Body      {
 *               "schema": 1,
 *               "writer": "<atrium instance id, else sha256(HOME)>",
 *               "writtenAt": "<ISO>",
 *               "reason": { "code", "live", "box", "at" },            // optional
 *               "items": [{
 *                 "key": "wakeup:<id>" | "trigger-run:<id>",
 *                 "kind": "wakeup" | "trigger-run",
 *                 "ref": "<id>",
 *                 "label": "<name>",
 *                 "harness": "claude" | "codex" | "pi",
 *                 "since": "<ISO>",
 *                 "brick": "<child brick id>"                          // optional
 *               }]
 *             }
 *
 *   Counted   only while `0 ≤ now − mtime < 5 min`: a stale file (its writer died) and one dated in
 *             the FUTURE (a clock step, a fixture) are both ignored — otherwise a dead atrium would
 *             hold every agent back forever.
 *   Tolerant  unknown keys (top level or per item) are ignored, never rejected. A file that is not
 *             JSON, has another `schema`, or no `items` array is ignored as a whole; an item without
 *             string `key`, `kind` and `ref` is skipped. Every one of these fails OPEN: W only ever
 *             gets smaller, never larger, from a bad file.
 *
 * Rows: "waiting:" in test/capacity-waiting.test.ts.
 */

export const WAITING_FRESH_MS = 5 * 60_000;

export type WaitingItem = {
  readonly key: string;
  readonly kind: string;
  readonly ref: string;
  readonly label: string;
  readonly harness: string;
  readonly since: string;
};

export type WaitingQueue = {
  readonly count: number;
  /** Every writer's items, oldest `since` first, then by key. */
  readonly items: readonly WaitingItem[];
};

export const NO_WAITING: WaitingQueue = { count: 0, items: [] };

export function waitingDirOf(admissionDir: string): string {
  return path.join(admissionDir, "waiting");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function itemOf(value: unknown): WaitingItem | undefined {
  if (!isObject(value) || !text(value.key) || !text(value.kind) || !text(value.ref)) {
    return undefined;
  }
  return {
    key: text(value.key),
    kind: text(value.kind),
    ref: text(value.ref),
    label: text(value.label),
    harness: text(value.harness),
    since: text(value.since),
  };
}

function isFresh(file: string, nowMs: number): boolean {
  try {
    const age = nowMs - fs.statSync(file).mtimeMs;
    return age >= 0 && age < WAITING_FRESH_MS;
  } catch {
    return false;
  }
}

function itemsOfFile(file: string): WaitingItem[] {
  let body: unknown;
  try {
    body = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!isObject(body) || body.schema !== 1 || !Array.isArray(body.items)) {
    return [];
  }
  return body.items.map(itemOf).filter((item): item is WaitingItem => item !== undefined);
}

function bySinceThenKey(a: WaitingItem, b: WaitingItem): number {
  if (a.since !== b.since) {
    return a.since < b.since ? -1 : 1;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Every fresh writer's items, summed. A missing or unreadable dir is an empty queue. */
export function readWaiting(admissionDir: string, now: Date = new Date()): WaitingQueue {
  const dir = waitingDirOf(admissionDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return NO_WAITING;
  }
  const items = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .filter((file) => isFresh(file, now.getTime()))
    .flatMap(itemsOfFile)
    .toSorted(bySinceThenKey);
  return { count: items.length, items };
}
