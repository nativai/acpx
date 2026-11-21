import os from "node:os";
import path from "node:path";

/**
 * The session store's directory. Its own module, with no other import, so the process-tree governor
 * (brick 5d7a23b6) can name it without loading `repository.ts`'s graph — which reaches
 * `node:child_process` (test/governor-import-graph.test.ts). `repository.ts` re-exports it.
 */
export function sessionBaseDir(): string {
  return path.join(acpxStateRoot(), "sessions");
}

/**
 * The `.acpx` directory acpx's state lives in: `$ACPX_STATE_HOME/.acpx`, else `~/.acpx`. Exactly
 * `ACPX_STATE_HOME || os.homedir()` — an empty value is ignored, a whitespace-only one is a (relative)
 * path, as every store resolver has always read it. ⚠️ The pod-mode predicate CALLS this
 * (`src/pod/placement.ts`, C1.1 A-5: it judges the state home acpx will actually use), so the two
 * agree by construction; do not re-derive it there. Held by `test/pod-placement.test.ts`.
 */
export function acpxStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string {
  return path.join(env.ACPX_STATE_HOME || homedir, ".acpx");
}
