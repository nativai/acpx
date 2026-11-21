import { sweepOwnPodLocks } from "../session/persistence/identity-file-lock.js";
import { sessionBaseDir } from "../session/persistence/session-base-dir.js";
import { queueBaseDir } from "./queue/paths.js";

/**
 * `acpx __pod-lock-sweep [dir…]` — one pass of C3.2's "each pod removes the locks of its own dead
 * processes" over this state home's record locks and lease guards — plus any directories named
 * (where the session's stage locks live) — for the agent pod's idle loop (infra stream; every 5 s). JSON on stdout, exit 0; any failure exit 1 with the
 * reason on stderr. The control pod's janitor is the atrium server calling `sweepOwnPodLocks`.
 */
export async function runPodLockSweep(extraDirs: string[] = []): Promise<void> {
  try {
    const dirs = [sessionBaseDir(), queueBaseDir(), ...extraDirs];
    const result = await sweepOwnPodLocks({ dirs });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`[acpx] pod lock sweep failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
