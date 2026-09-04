import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A `/proc` census, with the populations printed so an empty answer can never be
 * mistaken for a clean one (brick cc9a5f25).
 *
 * ⚠️ WHY NOT `isProcessAlive` (`src/process-liveness.ts`). That is
 * `process.kill(pid, 0)` — a per-pid question with **no population**. It cannot
 * distinguish "I checked and it is dead" from "I could not check", and the
 * caller here is about to DELETE something on the strength of the answer. This
 * module answers the same question in a form where "I could not check" is
 * visible: `scanned === 0` means NOT MEASURED, never "nothing is running".
 *
 * ⚠️ TWO POPULATIONS, NOT ONE, and they fail independently. Enumerating
 * `/proc/[0-9]*` needs no privilege; reading `/proc/<pid>/environ` needs to own
 * the process. So a scan can see every pid on the box and read the environment
 * of none of them — and the environment is what carries the config-dir paths. A
 * single counter would report that as a healthy scan with nothing referenced,
 * which is precisely the reading that deletes a live session's primer.
 */
export interface LiveProcessScan {
  /** PIDs enumerated. ⚠️ 0 means NOT MEASURED — never "nothing is running". */
  scanned: number;
  /** PIDs whose `environ` could actually be READ. ⚠️ 0 with `scanned > 0` means
   *  the environment leg is NOT MEASURED, even though the pid leg is. */
  environRead: number;
  pids: ReadonlySet<number>;
  /** Config-dir paths named by a live process's environment. */
  referencedDirs: ReadonlySet<string>;
  /**
   * Session ids appearing in a live process's COMMAND LINE — the queue-owner leg.
   *
   * ⚠️ THE PID LEG ALONE IS NOT ENOUGH TO CALL A SESSION OWNERLESS. A record's
   * `pid` is its AGENT process, and acpx also runs a per-session queue owner. An
   * agent that exited leaves `pid` dead while the owner is still alive holding
   * custody, so closing on the pid check alone would terminate a session that is
   * very much in use. Command lines are world-readable, so this leg survives the
   * privilege limit that blocks `environ`.
   */
  referencedSessionIds: ReadonlySet<string>;
}

/**
 * Env vars through which acpx points a child at a per-session config dir. A dir
 * named by any of these, in any live process, is IN USE.
 *
 * Kept beside the scan rather than imported from `harness-config-dir.ts` would
 * be the wrong way round — this list must match what that module SETS, so it is
 * asserted against it in the tests rather than duplicated by hope.
 */
export const CONFIG_DIR_ENV_NAMES = [
  "XDG_CONFIG_HOME",
  "OPENCODE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
] as const;

/** Census of live processes and the config dirs they reference. */
export function scanLiveProcesses(procRoot = "/proc"): LiveProcessScan {
  const pids = new Set<number>();
  const referencedDirs = new Set<string>();
  const referencedSessionIds = new Set<string>();
  let environRead = 0;

  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return { scanned: 0, environRead: 0, pids, referencedDirs, referencedSessionIds };
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }
    pids.add(Number(entry));
    // The cmdline leg first, because it needs no privilege and is the one that
    // keeps a live queue owner from being mistaken for an abandoned session.
    for (const id of readSessionIdsFromCmdline(procRoot, entry)) {
      referencedSessionIds.add(id);
    }
    const dirs = readConfigDirsFromEnviron(procRoot, entry);
    if (dirs === undefined) {
      // Not ours to read, or the process exited between readdir and open. Both
      // are ordinary; neither is evidence that nothing references a directory.
      continue;
    }
    environRead += 1;
    for (const dir of dirs) {
      referencedDirs.add(dir);
    }
  }

  return { scanned: pids.size, environRead, pids, referencedDirs, referencedSessionIds };
}

/** Session ids on one process's command line. Empty on any read failure. */
function readSessionIdsFromCmdline(procRoot: string, pid: string): string[] {
  try {
    const cmdline = readFileSync(join(procRoot, pid, "cmdline"), "utf8");
    return (cmdline.match(UUID_LIKE) ?? []).map((id) => id.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Config-dir paths in one process's environment, or **undefined when the
 * environment could not be read at all** — which is NOT the same as "this
 * process references nothing", and is why the caller counts it separately.
 */
function readConfigDirsFromEnviron(procRoot: string, pid: string): string[] | undefined {
  let environ: string;
  try {
    environ = readFileSync(join(procRoot, pid, "environ"), "utf8");
  } catch {
    return undefined;
  }
  const dirs: string[] = [];
  for (const pair of environ.split("\0")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && (CONFIG_DIR_ENV_NAMES as readonly string[]).includes(pair.slice(0, eq))) {
      dirs.push(pair.slice(eq + 1));
    }
  }
  return dirs;
}

/** Any acpx id shape that can name a session on a command line. */
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Whether ANY live process still points at this session — pid leg OR command-line
 * leg. Both are needed: see {@link LiveProcessScan.referencedSessionIds}.
 */
export function sessionOwnedByLiveProcess(
  scan: LiveProcessScan,
  session: { pid?: number; acpxRecordId?: string; acpSessionId?: string },
): boolean {
  if (pidObservedLive(scan, session.pid)) {
    return true;
  }
  return [session.acpxRecordId, session.acpSessionId].some(
    (id) =>
      typeof id === "string" && id.length > 0 && scan.referencedSessionIds.has(id.toLowerCase()),
  );
}

/** Whether `pid` was OBSERVED live. Never call without checking `scanned` first. */
export function pidObservedLive(scan: LiveProcessScan, pid: number | undefined): boolean {
  return typeof pid === "number" && pid > 0 && scan.pids.has(pid);
}

/**
 * Whether the scan is trustworthy enough to DELETE on. Both legs must have a
 * population, because a removal decision reads both.
 */
export function scanIsMeasured(scan: LiveProcessScan | undefined): scan is LiveProcessScan {
  return scan !== undefined && scan.scanned > 0 && scan.environRead > 0;
}
