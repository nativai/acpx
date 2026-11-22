/**
 * acpx's session-index projection for the atrium server (block S5, acpx block A8) — loaded
 * IN-PROCESS the way atrium loads the lock module: `acpx __index-projection-module` prints this
 * file's URL, atrium imports it and checks INDEX_PROJECTION_API_VERSION. The agreed surface:
 * /wisdom/Bricks/88112988-93e2-4c36-a1a4-e1e5afe46d33/reports/EXPORT-projection.md — change it only
 * with both stream sub-HoDs, and raise the version.
 *
 * 🛑 NO SQLITE, NO HEAVY IMPORT, ANYWHERE IN THIS FILE'S GRAPH: atrium loads it on any path.
 * `test/index-projection-module.test.ts` walks the BUILT graph and loads it in a fresh process.
 */

import { toSessionIndexEntry, type SessionIndexEntry } from "./session/persistence/index.js";
import { parseSessionRecord } from "./session/persistence/parse.js";

export const INDEX_PROJECTION_API_VERSION = 1 as const;

export { type SessionIndexEntry } from "./session/persistence/index.js";
export { sessionIndexPath, readSessionIndex } from "./session/persistence/index.js";
export {
  projectRecordFilesIntoIndex,
  reconcileSessionIndexFromDisk,
} from "./session/persistence/index-update-queue.js";
export { isIndexLockTimeoutError as isIndexLockTimeout } from "./session/persistence/index-lock.js";

/**
 * The index entry for one record file's TEXT (`<id>.json` as read from disk), by acpx's own
 * projection — `undefined` when the text is not a record acpx parses. Pure: no file is read,
 * nothing is written. `fileName` is the record's file name (`<id>.json`), as the index stores it.
 */
export function projectRecordText(text: string, fileName: string): SessionIndexEntry | undefined {
  try {
    const parsed = parseSessionRecord(JSON.parse(text));
    return parsed ? toSessionIndexEntry(parsed, fileName) : undefined;
  } catch {
    return undefined;
  }
}
