import { lstatSync, readdirSync, rmSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readQueueOwnerState } from "../cli/queue/lease-store.js";
import { queueLockFilePath } from "../cli/queue/paths.js";
import { AcpxOperationalError } from "../errors.js";
import { lockHostPlace } from "../pod/identity.js";
import { acpxStateRoot } from "./persistence/session-base-dir.js";

/**
 * The scratch reaper (block A8, TE finding F7; CONCEPTION r4 K7 "the scratch directory survives the pod",
 * decided by the head of development 2026-11-21 "on the shared volume, with the reaper"; TEST-PLAN AC-9.3).
 *
 * `<state home>/session-tmp/acpx-<id>` is removed at the session's close; this removes what a close never
 * reached (a crashed owner, a pod that died, a close that failed): an entry UNTOUCHED for 14 days — no file
 * or directory beneath it newer — whose session has NO LIVE OWNER.
 *
 * ⚠️ WHAT KEEPS AN ENTRY (every one a committed negative case, `test/scratch-reaper.test.ts`):
 *  - a young entry (anything under it modified inside the window);
 *  - a session whose owner is alive, or whose owner cannot be told from here (`alive: null` — a foreign
 *    pod's lease the reader cannot judge): "unknown" is alive, never removed on a guess;
 *  - anything that is not a real directory named `acpx-<one path segment>` (a symlink is never followed;
 *    a stray file is left);
 *  - a tree too large to measure inside the cap — it is kept, not guessed old.
 *
 * ⚠️ CONTROL POD ONLY. In an agent pod it throws `control_pod_only` and removes nothing: the reaper
 * judges every session's owner and deletes on the shared volume, which only the control pod may do.
 * The caller is the control pod's janitor (`acpx __scratch-reap`).
 */

export const SCRATCH_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MEASURE_CAP = 50_000;
const ENTRY = /^acpx-([\w.-]+)$/u;

export type ScratchOwnerState = "gone" | "live" | "unknown";

export type ScratchReapResult = {
  removed: string[];
  keptLiveOwner: string[];
  keptYoung: string[];
  skipped: string[];
};

class ScratchReaperRefusedError extends AcpxOperationalError {
  constructor() {
    super(
      "acpx: REFUSED reason=control_pod_only — the scratch reaper judges every session's owner and " +
        "removes on the shared volume: it runs on the control pod only. Nothing was removed.",
      { outputCode: "USAGE", detailCode: "control_pod_only", origin: "cli" },
    );
  }
}

/** The newest mtime anywhere under `dir` (itself included), or `undefined` when the tree is too large to measure. */
function newestMtimeMs(dir: string): number | undefined {
  let newest = 0;
  let seen = 0;
  const stack = [dir];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    const stat = lstatSync(current);
    newest = Math.max(newest, stat.mtimeMs);
    seen += 1;
    if (seen > MEASURE_CAP) {
      return undefined;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of readdirSync(current)) {
        stack.push(path.join(current, name));
      }
    }
  }
  return newest;
}

/**
 * ⚠️ ONLY A MISSING LEASE (ENOENT) MEANS "GONE" (TE finding F8). A lease file that EXISTS but cannot be
 * read (EACCES, any I/O error) or parsed (garbage, a torn write) names an owner this reader cannot judge:
 * `readLeaseFile` maps those to "unparsable", which the lease store's other callers rightly read as "no
 * usable owner" — and which would read here as "no owner", deleting a live session's scratch. So the
 * reaper looks at the file itself first; everything but ENOENT is `unknown`, and unknown is kept.
 * (`readLeaseFile`'s own answer is untouched.)
 */
async function ownerStateOf(sessionId: string): Promise<ScratchOwnerState> {
  try {
    try {
      await fs.readFile(queueLockFilePath(sessionId), "utf8");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unknown";
    }
    // The file exists and reads. A lease the store cannot parse is "not found" to it — here: unknown.
    const liveness = await readQueueOwnerState(sessionId);
    if (!liveness.ownerFound) {
      return "unknown";
    }
    return liveness.alive === false ? "gone" : liveness.alive === true ? "live" : "unknown";
  } catch {
    return "unknown";
  }
}

type Verdict = "remove" | "keep-young" | "keep-owner" | "skip";

/** The session id of a real `acpx-<id>` directory under `root`; "skip" for anything else; undefined if it vanished. */
function realEntryId(root: string, name: string): { id: string } | "skip" | undefined {
  const sessionId = ENTRY.exec(name)?.[1];
  if (sessionId === undefined || sessionId === "." || sessionId === "..") {
    return "skip";
  }
  try {
    const stat = lstatSync(path.join(root, name));
    return stat.isDirectory() && !stat.isSymbolicLink() ? { id: sessionId } : "skip";
  } catch {
    return undefined;
  }
}

/** What the reaper does with one `session-tmp` entry — every keep reason is its own verdict. */
async function judgeEntry(
  root: string,
  name: string,
  window: { nowMs: number; maxAgeMs: number },
  judge: (sessionId: string) => Promise<ScratchOwnerState>,
): Promise<Verdict | undefined> {
  const entry = realEntryId(root, name);
  if (entry === undefined || entry === "skip") {
    return entry;
  }
  const newest = newestMtimeMs(path.join(root, name));
  if (newest === undefined || window.nowMs - newest < window.maxAgeMs) {
    return "keep-young";
  }
  return (await judge(entry.id)) === "gone" ? "remove" : "keep-owner";
}

function removeEntry(root: string, name: string): boolean {
  try {
    rmSync(path.join(root, name), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const BUCKET = {
  "keep-young": "keptYoung",
  "keep-owner": "keptLiveOwner",
  skip: "skipped",
} as const;

export async function reapSessionScratch(
  options: {
    maxAgeMs?: number;
    nowMs?: number;
    env?: NodeJS.ProcessEnv;
    /** Test seam: the owner's state per session id (default: the lease, judged as everywhere else). */
    ownerState?: (sessionId: string) => Promise<ScratchOwnerState>;
  } = {},
): Promise<ScratchReapResult> {
  const env = options.env ?? process.env;
  if (lockHostPlace(env) === "agent-pod") {
    throw new ScratchReaperRefusedError();
  }
  const root = path.join(acpxStateRoot(env), "session-tmp");
  const result: ScratchReapResult = { removed: [], keptLiveOwner: [], keptYoung: [], skipped: [] };
  const window = windowOf(options);
  for (const name of listEntries(root)) {
    const verdict = await judgeEntry(root, name, window, options.ownerState ?? ownerStateOf);
    if (verdict !== undefined) {
      result[bucketOf(verdict, root, name)].push(name);
    }
  }
  return result;
}

function windowOf(options: { maxAgeMs?: number; nowMs?: number }): {
  nowMs: number;
  maxAgeMs: number;
} {
  return { nowMs: options.nowMs ?? Date.now(), maxAgeMs: options.maxAgeMs ?? SCRATCH_MAX_AGE_MS };
}

function bucketOf(verdict: Verdict, root: string, name: string): keyof ScratchReapResult {
  if (verdict !== "remove") {
    return BUCKET[verdict];
  }
  return removeEntry(root, name) ? "removed" : "skipped";
}

function listEntries(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}
