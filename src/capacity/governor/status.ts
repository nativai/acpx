import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProcStat } from "../../process-tree-reap.js";

/**
 * The governor's liveness as other processes read it (`acpx governor status`, the `governor` object
 * of `acpx capacity`): the heartbeat file the daemon writes every scan, judged against /proc. Reading
 * it costs one small file — no events log scan on the admission path.
 */

export function governorDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.ACPX_STATE_HOME || os.homedir(), ".acpx", "governor");
}

export type LastKill = {
  readonly at: string;
  readonly rule: string;
  readonly processes: number;
  readonly sessionKind: string;
  readonly eventId: string;
};

export type GovernorHeartbeat = {
  readonly pid: number;
  readonly startTicks: string;
  readonly startedAt: string;
  readonly lastScanAt: string;
  readonly scanMs: number;
  readonly intervalMs: number;
  readonly mode: "enforce" | "observe";
  readonly configuredMode: "enforce" | "observe";
  readonly observeReason: string | null;
  readonly governTerminals: boolean;
  readonly test: boolean;
  readonly nice: number | null;
  readonly measured: boolean;
  readonly processes: number;
  readonly sessions: number;
  readonly governed: number;
  readonly killsLast24h: number;
  readonly lastKill: LastKill | null;
  readonly clickhouse: string;
};

/** The `governor` object of `acpx capacity --format json` (CONCEPTION 5d7a23b6 §6.4). */
export type GovernorLiveness = {
  readonly alive: boolean;
  readonly lastScanAt: string | null;
  readonly mode: "enforce" | "observe" | null;
  readonly killsLast24h: number | null;
  readonly lastKill: LastKill | null;
};

/** A heartbeat older than this is not alive (AC6: `lastScanAt` under 5 s old). */
export const HEARTBEAT_FRESH_MS = 5000;

export function readHeartbeat(dir: string): GovernorHeartbeat | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "heartbeat.json"), "utf8")) as unknown;
    const hb = parsed as GovernorHeartbeat;
    return parsed && typeof parsed === "object" && typeof hb.pid === "number" ? hb : undefined;
  } catch {
    return undefined;
  }
}

/** The heartbeat's writer is still the live process it names (pid + start ticks). */
export function heartbeatProcessAlive(hb: GovernorHeartbeat, procRoot = "/proc"): boolean {
  try {
    const entry = parseProcStat(fs.readFileSync(`${procRoot}/${hb.pid}/stat`, "utf8"));
    return entry?.pid === hb.pid && entry.startTicks === hb.startTicks && entry.state !== "Z";
  } catch {
    return false;
  }
}

export function readGovernorLiveness(
  dir: string,
  nowMs: number,
  procRoot = "/proc",
): GovernorLiveness {
  const hb = readHeartbeat(dir);
  if (!hb) {
    return { alive: false, lastScanAt: null, mode: null, killsLast24h: null, lastKill: null };
  }
  const fresh = nowMs - Date.parse(hb.lastScanAt) <= HEARTBEAT_FRESH_MS;
  return {
    alive: fresh && heartbeatProcessAlive(hb, procRoot),
    lastScanAt: hb.lastScanAt,
    mode: hb.mode,
    killsLast24h: hb.killsLast24h,
    lastKill: hb.lastKill,
  };
}

/** One text line for `acpx capacity`. */
export function governorLivenessLine(g: GovernorLiveness, nowMs: number): string {
  if (g.lastScanAt === null) {
    return "governor: not running (no heartbeat)";
  }
  const age = Math.max(0, Math.round((nowMs - Date.parse(g.lastScanAt)) / 1000));
  const state = g.alive ? `alive, ${g.mode}` : "NOT ALIVE";
  const kills = g.killsLast24h === null ? "" : ` · ${g.killsLast24h} kill(s) in 24 h`;
  return `governor: ${state} · last scan ${age} s ago${kills}`;
}
