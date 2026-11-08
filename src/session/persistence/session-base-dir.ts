import os from "node:os";
import path from "node:path";

/**
 * The session store's directory. Its own module, with no other import, so the process-tree governor
 * (brick 5d7a23b6) can name it without loading `repository.ts`'s graph — which reaches
 * `node:child_process` (test/governor-import-graph.test.ts). `repository.ts` re-exports it.
 */
export function sessionBaseDir(): string {
  return path.join(process.env.ACPX_STATE_HOME || os.homedir(), ".acpx", "sessions");
}
