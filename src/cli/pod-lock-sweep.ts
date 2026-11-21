import { sweepOwnPodLocks } from "../session/persistence/identity-file-lock.js";
import { sessionBaseDir } from "../session/persistence/session-base-dir.js";
import { queueBaseDir } from "./queue/paths.js";

/**
 * `acpx __pod-lock-sweep` — one pass of C3.2's "each pod removes the locks of its own dead
 * processes" over this state home's record locks and lease guards, for the agent pod's idle loop
 * (infra stream; it calls this every 5 s). JSON on stdout, exit 0; any failure exit 1 with the
 * reason on stderr. The control pod's janitor is the atrium server calling `sweepOwnPodLocks`.
 */
export async function runPodLockSweep(): Promise<void> {
  try {
    const result = await sweepOwnPodLocks({ dirs: [sessionBaseDir(), queueBaseDir()] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`[acpx] pod lock sweep failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
