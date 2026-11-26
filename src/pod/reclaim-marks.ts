import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// brick 35d4e64b (acpx half of ef5934ba) — the one mark an on-demand release writes: `<run dir>/reclaim`,
// which infra's idle-loop rule `reclaimed` reads (marker + owner gone + pod idle ⇒ end the pod at once,
// no 120 s linger). The pod's idleness itself is the predicate's (`./idle-predicate.ts`), not read here.

const DEFAULT_RUN_DIR = "/run/nv-agent";

/** `NV_AG_RUN_DIR`, default `/run/nv-agent` — the same knob the idle loop reads. */
export function podRunDir(env: NodeJS.ProcessEnv): string {
  return env.NV_AG_RUN_DIR || DEFAULT_RUN_DIR;
}

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
