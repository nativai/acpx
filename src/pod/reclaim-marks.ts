import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// brick 35d4e64b (acpx half of ef5934ba) — the pod's own marks, read INSIDE the owner's atomic release.
//
// An owner may be ended on demand (to make room for a held message) only if the pod's own idle loop
// (infra's `workbench-idle --agent`) would also call the pod idle. That loop's inputs are files in the
// pod, which this module reads — it never asks the loop and never runs a process:
//   * the status file `<status dir>/<key>.json`, key `browser.open` (an agent-browser daemon runs);
//   * the in-flight marks `<run dir>/inflight/<call_id>.<entry pid>` (one per routed command in flight).
// And it writes the one mark the loop reads back: `<run dir>/reclaim` (rule `reclaimed`).
//
// ⚠️ EVERYTHING IS SYNCHRONOUS ON PURPOSE. The caller holds the owner's own loop from the check to the
// exit; an `await` between a read here and the commit is a window in which a prompt could start a turn.
// ⚠️ A DOUBT IS A REFUSAL, NEVER IDLE: an unreadable or unparsable status file, a stale one, a missing
// run directory, a mark nobody can parse — all `unknown`. Releasing an owner for a pod that then does
// not end is a cold start for nothing; refusing costs atrium one try of the next candidate.
// ⚠️ ONLY the mark of the asking call (`call_id` == `ACPX_ROUTED_CALL_ID`) is ignored; any other mark, and any
// mark that holds no call_id, counts as a command in flight.
// ⚠️ NO `/proc` READ HERE (the process-table scan stays clean): a STALE in-flight mark (a dead call)
// therefore counts as live until the idle loop's own tick sweeps it (5 s) — the safe direction.

/** Names the reasons the pod is busy; the verb answers `refused(pod_busy:<reason>)`. */
export type PodBusyReason = "browser_open" | "call_in_flight" | "unknown";

export type PodMarksVerdict = { ok: true } | { ok: false; reason: PodBusyReason; detail: string };

export type PodMarksConfig = {
  /** `NV_AG_RUN_DIR`, default `/run/nv-agent`. */
  runDir: string;
  /** `NV_AG_STATUS_DIR`, default `/workspace/.workbench/agents`. */
  statusDir: string;
  /** `NV_AGENT_SESSION_KEY` — names the status file. Absent ⇒ the status file cannot be named ⇒ unknown. */
  sessionKey: string | undefined;
  /**
   * The asking call's `ACPX_ROUTED_CALL_ID`: the routed entry writes one mark per call with `call_id=<id>`
   * inside, and the mark of THIS release call is the call that asks, not work in the pod.
   */
  ownCallId: string | undefined;
  now: () => number;
};

/** The idle loop rewrites the status file at least every 60 s; five times that is a loop that is gone. */
export const STATUS_FILE_MAX_AGE_MS = 5 * 60_000;

const DEFAULT_RUN_DIR = "/run/nv-agent";
const DEFAULT_STATUS_DIR = "/workspace/.workbench/agents";
const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

export function podMarksConfigFromEnv(
  env: NodeJS.ProcessEnv,
  ownCallId: string | undefined,
): PodMarksConfig {
  return {
    runDir: env.NV_AG_RUN_DIR || DEFAULT_RUN_DIR,
    statusDir: env.NV_AG_STATUS_DIR || DEFAULT_STATUS_DIR,
    sessionKey: env.NV_AGENT_SESSION_KEY || undefined,
    ownCallId,
    now: Date.now,
  };
}

function unknown(detail: string): PodMarksVerdict {
  return { ok: false, reason: "unknown", detail };
}

/** Why a status record cannot be trusted as "the idle loop is running now", or undefined when it can. */
function statusRecordProblem(record: Record<string, unknown>, now: number): string | undefined {
  if (record.state !== "running") {
    return `says state=${String(record.state)}, not running`;
  }
  const updatedAt =
    typeof record.updatedAt === "string" ? Date.parse(record.updatedAt) : Number.NaN;
  if (!Number.isFinite(updatedAt) || now - updatedAt > STATUS_FILE_MAX_AGE_MS) {
    return "has no recent updatedAt: the idle loop may be gone";
  }
  return undefined;
}

/** The fields of the status file the release reads, after every one of them has been checked. */
function checkStatusDocument(
  doc: unknown,
  file: string,
  now: number,
): { browserOpen: boolean } | PodMarksVerdict {
  if (typeof doc !== "object" || doc === null) {
    return unknown(`status file ${file} is not an object`);
  }
  const record = doc as Record<string, unknown>;
  const problem = statusRecordProblem(record, now);
  if (problem) {
    return unknown(`status file ${file} ${problem}`);
  }
  const browser = record.browser as Record<string, unknown> | null | undefined;
  if (typeof browser !== "object" || browser === null || typeof browser.open !== "boolean") {
    return unknown(`status file ${file}: browser.open is missing or not a boolean`);
  }
  return { browserOpen: browser.open };
}

function readStatusBrowserOpen(config: PodMarksConfig): { browserOpen: boolean } | PodMarksVerdict {
  const key = config.sessionKey;
  if (key === undefined || !SESSION_KEY_PATTERN.test(key)) {
    return unknown("NV_AGENT_SESSION_KEY is missing or not a key: the status file cannot be named");
  }
  const file = path.join(config.statusDir, `${key}.json`);
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return unknown(`status file ${file} unreadable: ${(error as Error).message}`);
  }
  return checkStatusDocument(doc, file, config.now());
}

/** The `call_id=` an in-flight mark holds (written by the routed entry), or undefined when it has none. */
function markCallId(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = /^call_id=(.+)$/.exec(line.trim());
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** How many commands are in flight apart from the asking call — or the refusal that says it cannot be told. */
function countCallsInFlight(config: PodMarksConfig): number | PodMarksVerdict {
  const inflightDir = path.join(config.runDir, "inflight");
  let names: string[];
  try {
    names = fs.readdirSync(inflightDir);
  } catch (error) {
    return unknown(`in-flight directory ${inflightDir} unreadable: ${(error as Error).message}`);
  }
  let calls = 0;
  for (const name of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(inflightDir, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue; // the call ended between the listing and the read
      }
      return unknown(`in-flight mark ${name} unreadable: ${(error as Error).message}`);
    }
    if (config.ownCallId !== undefined && markCallId(text) === config.ownCallId) {
      continue; // the call that asks for this release
    }
    calls += 1;
  }
  return calls;
}

/**
 * Would the pod's idle loop call this pod idle, apart from the owner and the call that asks? Refusals,
 * in this order: unknown (a mark that cannot be read), browser_open, call_in_flight.
 */
export function readPodIdleMarks(config: PodMarksConfig): PodMarksVerdict {
  const status = readStatusBrowserOpen(config);
  if ("ok" in status) {
    return status;
  }
  const calls = countCallsInFlight(config);
  if (typeof calls === "object") {
    return calls;
  }
  if (status.browserOpen) {
    return {
      ok: false,
      reason: "browser_open",
      detail: "an agent-browser daemon runs in this pod",
    };
  }
  if (calls > 0) {
    return {
      ok: false,
      reason: "call_in_flight",
      detail: `${calls} routed command(s) in flight in this pod`,
    };
  }
  return { ok: true };
}

/** `<run dir>/reclaim` — the flag infra's rule `reclaimed` reads (owner gone + marker + idle ⇒ end at once). */
export function reclaimMarkPath(runDir: string): string {
  return path.join(runDir, "reclaim");
}

/**
 * Writes the mark atomically (temp in the same directory, then rename). Throws when it cannot: the
 * caller refuses the release (`unknown`) and leaves the owner untouched.
 */
export function writeReclaimMark(
  runDir: string,
  fields: { sessionId: string; at: number; ownerPid: number; heldTarget?: string },
): void {
  const target = reclaimMarkPath(runDir);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const body =
    `session=${fields.sessionId}\n` +
    `at=${new Date(fields.at).toISOString()}\n` +
    `owner_pid=${fields.ownerPid}\n` +
    `reason=reclaim\n` +
    (fields.heldTarget ? `held_target=${fields.heldTarget}\n` : "");
  try {
    fs.writeFileSync(temp, body, { mode: 0o644, flag: "wx" });
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // nothing was written, or it is gone already
    }
    throw error;
  }
}

/**
 * A cold-started owner removes a reclaim mark an earlier owner of this pod left (the pod did not end,
 * so the reclaim was moot): the mark means "this owner's predecessor was released to free the pod".
 */
export function clearReclaimMark(runDir: string): void {
  try {
    fs.unlinkSync(reclaimMarkPath(runDir));
  } catch {
    // absent, or not ours to remove: the idle loop's rule needs the owner gone anyway
  }
}
