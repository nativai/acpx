import path from "node:path";
import { AcpxOperationalError } from "../errors.js";
import { lockHostPlace } from "./identity.js";
import { canonicalHome, resolvedPath } from "./placement.js";

/**
 * C1.2 A-8 / C7.2 — writers of box-wide files fail closed in an agent pod (block A8, brick 88112988).
 * `acpx: REFUSED reason=pod_foreign_write file=<index|seat-store|registry|ledger>`, exit 2 (a
 * `USAGE` output code), thrown BEFORE the writer's first byte. The classes already keep every command
 * away from these files (an agent pod passes `create` and `control-store` through); this guard is for
 * the path nobody classified, and `test/pod-foreign-write-guard.test.ts` proves no classified
 * command that runs locally in an agent pod reaches it.
 *
 * ⚠️ THE GUARDED OPERATION LIVES ONLY IN THE WRITERS THAT CALL `assertBoxWideWriteAllowed` — one call
 * per writer, the first statement, and the test lists the writers by DISCOVERY (it scans `src/` for the
 * guard's call sites and for the write primitives named below, and fails on a file that writes a
 * box-wide file without one).
 *
 * Which pod: the lock and lease writer's rule (A-25, A-28) — the place file or an `ag-…` kernel
 * hostname — and only for a file UNDER THE BOX'S STATE HOME. A suite or a rig that points acpx at a
 * state home of its own behaves as today (A-26), as does the control pod.
 */

export type BoxWideFile = "index" | "seat-store" | "registry" | "ledger";

export const POD_FOREIGN_WRITE_REASON = "pod_foreign_write";

export class PodForeignWriteError extends AcpxOperationalError {
  constructor(readonly file: BoxWideFile) {
    super(
      `acpx: REFUSED reason=${POD_FOREIGN_WRITE_REASON} file=${file} — this is an agent pod; ` +
        `box-wide files are written on the control pod only (C1.2). Nothing was written.`,
      { outputCode: "USAGE", detailCode: POD_FOREIGN_WRITE_REASON, origin: "cli" },
    );
  }
}

/** Is `target` a file of the box's state home, seen from an agent pod? */
export function isBoxWideFileInAgentPod(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (lockHostPlace(env) !== "agent-pod") {
    return false;
  }
  const root = resolvedPath(path.join(canonicalHome(env), ".acpx"));
  const resolved = resolvedPath(target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

/** Throws `PodForeignWriteError` when a writer of `file` at `target` is reached in an agent pod. */
export function assertBoxWideWriteAllowed(
  file: BoxWideFile,
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isBoxWideFileInAgentPod(target, env)) {
    throw new PodForeignWriteError(file);
  }
}
