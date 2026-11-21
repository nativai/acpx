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
 * ⚠️ IT ONLY EVER ANSWERS "OWN" ON EXACT EVIDENCE, and that is the safe direction: "not own" sends
 * the command to the control pod (pass-through / message route), where acpx's full resolver runs.
 * The candidates for a selector: the value itself (a record id); `?session=` of a URL; a seat's
 * active holder (`seats.json`); and, through `index.json` if it can be read, the record whose ACP
 * id is the value or whose record or ACP id ends with it uniquely. A candidate counts only if THIS
 * pod is named for it (`ag-<key of the record id>`).
 */
export function ownTargetRecordId(
  target: TargetSelector | undefined,
  podName: string,
  sessionsDir: string = path.join(acpxStateRoot(), "sessions"),
): string | null {
  if (!target) {
    return null;
  }
  for (const id of candidates(target, sessionsDir)) {
    if (agentPodName(id) === podName) {
      return id;
    }
  }
  return null;
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

function seatHolder(sessionsDir: string, seatId: string): string[] {
  const store = readJson(path.join(sessionsDir, "seats.json"));
  const row =
    store && typeof store === "object" ? (store as Record<string, unknown>)[seatId] : undefined;
  const holder =
    row && typeof row === "object"
      ? (row as { active_holder_id?: unknown }).active_holder_id
      : undefined;
  return typeof holder === "string" && holder ? [holder] : [];
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
