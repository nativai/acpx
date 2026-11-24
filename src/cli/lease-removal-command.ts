import fs from "node:fs";
import path from "node:path";
import { lockHostPlace } from "../pod/identity.js";
import { getOwnProcessScope, parseLinuxStatStartTicks } from "../process-identity.js";
import { acpxStateRoot } from "../session/persistence/session-base-dir.js";
import type { OutputFormat } from "../types.js";
import { emitJsonResult } from "./output/json-output.js";
import {
  runLeaseRemoval,
  START_MARGIN_MS,
  type ControlPodStart,
  type LeaseRecord,
  type LeaseRemovalResult,
} from "./queue/lease-removal.js";

/**
 * `acpx sessions unparsable-leases [--apply]` — A-71 (brick 70921280). Loaded by a dynamic import from the
 * commander action, so cli.js gains no static chunk (`test/pod-command-classes.test.ts`, the 10-chunk bound).
 *
 * Exit: 0 for a census, and for an apply that removed or found absent every selected lease; 1 for an apply
 * that kept a selected lease (named in the output); 2 when refused before acting.
 */

const CLOCK_TICKS_PER_SECOND = 100;
/** The calibration bound: this process's own start, computed as PID 1's is, against the clock. */
const CALIBRATION_TOLERANCE_MS = 5_000;

type ProcFiles = { read: (file: string) => string };
const realProc: ProcFiles = { read: (file) => fs.readFileSync(file, "utf8") };

function startOf(pid: number, bootMs: number, proc: ProcFiles): number | undefined {
  const ticks = parseLinuxStatStartTicks(proc.read(`/proc/${pid}/stat`), pid);
  return ticks === undefined ? undefined : bootMs + (Number(ticks) / CLOCK_TICKS_PER_SECOND) * 1000;
}

type ClockReaders = { nowMs: () => number; uptimeS: () => number };
type StartReaders = { proc: ProcFiles; place: () => string } & Partial<ClockReaders>;

/** PID 1's and this process's start by /proc, or why they could not be read. */
function procStarts(proc: ProcFiles): { init: number; own: number } | string {
  const btime = /^btime (\d+)$/m.exec(proc.read("/proc/stat"));
  if (!btime) {
    return "btime not found in /proc/stat";
  }
  const bootMs = Number(btime[1]) * 1000;
  const init = startOf(1, bootMs, proc);
  const own = startOf(process.pid, bootMs, proc);
  return init === undefined || own === undefined ? "/proc/<pid>/stat not parsable" : { init, own };
}

/** A reason the own-pid-namespace /proc cannot stand for the control pod's, or undefined. */
function notControlPodReason(place: string): string | undefined {
  if (place !== "control") {
    return `not the control pod (this host is: ${place})`;
  }
  return process.platform !== "linux" || getOwnProcessScope() === undefined
    ? "own pid namespace not verified"
    : undefined;
}

/** This process's start by /proc against the clock's: a miss means the assumed tick rate or btime is wrong. */
function calibrationMiss(own: number, clock: Partial<ClockReaders>): number {
  const nowMs = (clock.nowMs ?? Date.now)();
  const uptimeS = (clock.uptimeS ?? (() => process.uptime()))();
  return Math.round(own - (nowMs - uptimeS * 1000));
}

function calibratedStart(
  starts: { init: number; own: number },
  clock: Partial<ClockReaders>,
): ControlPodStart {
  const miss = calibrationMiss(starts.own, clock);
  return Math.abs(miss) > CALIBRATION_TOLERANCE_MS
    ? {
        ms: undefined,
        reason: `calibration failed: own start by /proc is ${miss} ms from the clock's`,
      }
    : { ms: starts.init, source: "pid 1 start (btime + /proc/1/stat starttime)" };
}

/**
 * The start of the control pod's container: PID 1 of this pid namespace (btime + starttime ticks). The
 * writers of a lease are processes of that container; a lease older than PID 1 was written by a process that
 * no longer exists. FAIL CLOSED: anything but the control pod, an unreadable or implausible reading, is
 * `ms: undefined`, and nothing is removed. The calibration: this process's own start, computed the same
 * way, must agree with the clock — else the tick rate (100 Hz assumed) or btime is not what is assumed.
 */
export function readControlPodStart(options: Partial<StartReaders> = {}): ControlPodStart {
  const refused = notControlPodReason((options.place ?? lockHostPlace)());
  if (refused) {
    return { ms: undefined, reason: refused };
  }
  try {
    const starts = procStarts(options.proc ?? realProc);
    if (typeof starts === "string") {
      return { ms: undefined, reason: starts };
    }
    return calibratedStart(starts, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    return { ms: undefined, reason: `/proc unreadable: ${code}` };
  }
}

export function defaultRecordsFile(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return path.join(
    acpxStateRoot(),
    "maintenance",
    `unparsable-lease-removal-${stamp}-${process.pid}.ndjson`,
  );
}

function describe(record: LeaseRecord): string {
  const who =
    record.sessionId === null
      ? `key=${record.key} (no session record found)`
      : `${record.sessionId} key=${record.key}`;
  const fp = record.fingerprint;
  return [
    `${record.decision.toUpperCase()}\t${who}`,
    `state=${record.state}${record.location ? `/${record.location}` : ""}`,
    `bytes=${record.bytes}`,
    `mtime=${record.mtime}`,
    `parse=${record.parse}`,
    `fp=ino:${fp.ino},mtimeNs:${fp.mtimeNs},size:${fp.size},sha256:${fp.sha256}`,
    `reason=${record.reason}`,
  ].join("\t");
}

export function formatLeaseRemoval(result: LeaseRemovalResult): string {
  const lines = [
    `acpx sessions unparsable-leases — ${result.mode === "apply" ? "APPLY" : "DRY RUN (removes and writes nothing)"}`,
    `queues: ${result.queuesDir}`,
    `control pod start: ${result.controlPodStart ?? "UNKNOWN"} (${result.controlPodStartSource}); a lease is removed only if older than that by more than ${START_MARGIN_MS / 60_000} min; two reads ${result.readGapMs / 1000} s apart`,
    `leases: ${result.scanned.leases}; selected (unreadable, not JSON, or JSON that is not an object): ${result.scanned.selected}; not selected: ${result.scanned.notSelected}`,
    ...result.records.map(describe),
    `removed=${result.summary.removed} would-remove=${result.summary.wouldRemove} kept=${result.summary.kept} already-absent=${result.summary.alreadyAbsent}`,
  ];
  if (result.recordsFile) {
    lines.push(`records: ${result.recordsFile}`);
  }
  return lines.join("\n");
}

export async function handleUnparsableLeases(
  flags: { apply?: boolean; recordsFile?: string },
  format: OutputFormat,
): Promise<void> {
  const apply = flags.apply === true;
  const result = await runLeaseRemoval({
    apply,
    controlPodStart: () => readControlPodStart(),
    ...(apply ? { recordsFile: flags.recordsFile ?? defaultRecordsFile() } : {}),
  });
  if (!emitJsonResult(format, { action: "unparsable_leases", ...result })) {
    process.stdout.write(
      format === "quiet" ? `${result.scanned.selected}\n` : `${formatLeaseRemoval(result)}\n`,
    );
  }
  if (apply && result.summary.kept > 0) {
    process.exitCode = 1;
  }
}
