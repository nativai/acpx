import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Block A11 / A-67: a temp name carries a RANDOM part. Two pods can run the same pid against one shared
 * store, so a name built from the pid (or the pid and a millisecond) alone can collide: the second
 * writer truncates the first's temp file and the rename publishes a torn one. The name keeps the
 * target's directory (the rename stays a same-directory rename) and never ends in `.json` (A-13: every
 * `.json` in a sessions directory is read as a session record).
 *
 * `test/pod-temp-names.test.ts` scans `src/` for a temp name built from `process.pid` without a random
 * part in the same expression and fails on one.
 */
export function uniqueTempPath(target: string): string {
  return `${target}.${process.pid}.${randomUUID()}.tmp`;
}

/** Write `body` to a unique temp name beside `target`, then rename it over `target`; no temp is left behind on a failure. */
export function writeFileReplacingSync(
  target: string,
  body: string,
  options: { mode?: number } = {},
): void {
  const temp = uniqueTempPath(target);
  try {
    writeFileSync(temp, body, {
      encoding: "utf8",
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
