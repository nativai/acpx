import fs from "node:fs";
import path from "node:path";
import { acpxStateRoot } from "../session/persistence/session-base-dir.js";
import type { TargetSelector } from "./command-classes.js";
import { agentPodName } from "./placement.js";

/**
 * In an agent pod: is the command about THIS pod's session? (C1.1 places, F2 of the A1
 * verification.) Answered from files, read-only and SILENT — no index rebuild, no stderr — so the
 * placement decision comes first and its refusal token stays stderr line 1 (C7.2), and no agent pod
 * writes the box-wide index (K7 rule 1; A-8).
 *
 * ⚠️ WHAT "OWN" MEANS — and the pass-through (A3, `pass-through-branch.ts`) depends on it: "own" is
 * answered ONLY when ONE selector names the session by a form acpx's resolver accepts for that flag
 * and the record it reaches is this pod's. Everything else — "not own" — goes to the control pod,
 * where acpx's full resolver runs and refuses what it refuses. So "own" is never inexact:
 *   - several selectors (two different selector flags, a flag and the operand: `conflict`) → not own;
 *   - a URL carrying BOTH `?session=` and `?seat=` → not own;
 *   - a URL as the value of `--session-id` → not own (a URL is for `--session-url` and `--seat`);
 *   - `-s` and `--session` → not own, except `--session <id|url>` of the `people` commands, where it
 *     is the id flag (on every other command it is a session NAME, which acpx refuses);
 *   - a CLOSED seat (`closed_at` set) names no holder → not own.
 * R2-a of the A1 re-test named these 8 shapes; each is a negative row in `test/pod-own-target.test.ts`.
 *
 * The candidates for an exact selector: the value itself (a record id); `?session=` of a URL; a
 * seat's active holder (`seats.json`); and, through `index.json` if it can be read, the record whose
 * ACP id is the value or whose record or ACP id ends with it uniquely. A candidate counts only if
 * THIS pod is named for it (`ag-<key of the record id>`).
 */
export function ownTargetRecordId(
  target: TargetSelector | undefined,
  podName: string,
  sessionsDir: string = path.join(acpxStateRoot(), "sessions"),
  command: { path?: string; conflict?: boolean } = {},
): string | null {
  if (!target || command.conflict === true || !selectorIsExact(target, command.path)) {
    return null;
  }
  for (const id of candidates(target, sessionsDir)) {
    if (agentPodName(id) === podName) {
      return id;
    }
  }
  return null;
}

/** Per flag: is a value of THIS form one acpx's resolver accepts for it? (Unlisted flags: yes.) */
const EXACT_FORM_BY_FLAG: Readonly<
  Record<
    string,
    (url: { session?: string; seat?: string } | undefined, commandPath?: string) => boolean
  >
> = {
  "-s": () => false,
  "--session": (_url, commandPath) => commandPath?.startsWith("people ") === true,
  "--session-id": (url) => url === undefined,
};

/** The forms acpx's resolver accepts for this flag (see the docstring above). */
function selectorIsExact(target: TargetSelector, commandPath: string | undefined): boolean {
  const url = parseUrl(target.value.trim());
  if (url?.session !== undefined && url.seat !== undefined) {
    return false;
  }
  return target.via === "operand" || (EXACT_FORM_BY_FLAG[target.flag]?.(url, commandPath) ?? true);
}

function candidates(target: TargetSelector, sessionsDir: string): string[] {
  const value = target.value.trim();
  const url = parseUrl(value);
  const seat = seatOf(target, value, url);
  const direct = url ? url.session : value;
  return [
    ...(seat ? seatHolder(sessionsDir, seat) : []),
    ...(direct ? [direct, ...fromIndex(sessionsDir, direct)] : []),
  ];
}

/** `--seat <id|?seat= URL>`, or any URL carrying `?seat=`. */
function seatOf(
  target: TargetSelector,
  value: string,
  url: { session?: string; seat?: string } | undefined,
): string | undefined {
  const bySeatFlag = target.via === "flag" && target.flag === "--seat";
  return bySeatFlag ? (url?.seat ?? value) : url?.seat;
}

function parseUrl(value: string): { session?: string; seat?: string } | undefined {
  if (!/^https?:\/\//u.test(value)) {
    return undefined;
  }
  try {
    const params = new URL(value).searchParams;
    return {
      session: params.get("session")?.trim() || undefined,
      seat: params.get("seat")?.trim() || undefined,
    };
  } catch {
    return {};
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

type SeatRow = { active_holder_id?: unknown; closed_at?: unknown };

function readSeatRow(sessionsDir: string, seatId: string): SeatRow | undefined {
  const store = readJson(path.join(sessionsDir, "seats.json"));
  const row =
    store && typeof store === "object" ? (store as Record<string, unknown>)[seatId] : undefined;
  return row && typeof row === "object" ? (row as SeatRow) : undefined;
}

function seatHolder(sessionsDir: string, seatId: string): string[] {
  const seat = readSeatRow(sessionsDir, seatId);
  // A closed seat names no holder (R2-a): acpx's resolver refuses it, so it is never "own".
  const closed = typeof seat?.closed_at === "string" && seat.closed_at !== "";
  const holder = seat?.active_holder_id;
  return !closed && typeof holder === "string" && holder ? [holder] : [];
}

type IndexEntry = { acpxRecordId?: unknown; acpSessionId?: unknown };

function fromIndex(sessionsDir: string, value: string): string[] {
  const index = readJson(path.join(sessionsDir, "index.json")) as { entries?: unknown } | undefined;
  const entries = Array.isArray(index?.entries) ? (index.entries as IndexEntry[]) : [];
  const ids = (e: IndexEntry) =>
    [e.acpxRecordId, e.acpSessionId].filter((x): x is string => typeof x === "string" && x !== "");
  const exact = entries.filter((e) => e.acpSessionId === value);
  const bySuffix = entries.filter((e) => ids(e).some((id) => id.endsWith(value)));
  const hit = exact.length === 1 ? exact : bySuffix.length === 1 ? bySuffix : [];
  return hit.map((e) => e.acpxRecordId).filter((x): x is string => typeof x === "string");
}
