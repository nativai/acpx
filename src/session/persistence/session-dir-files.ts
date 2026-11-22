/**
 * THE REGISTRY OF FILES IN `SESSIONS_DIR` THAT ARE NOT SESSION RECORDS.
 *
 * `~/.acpx/sessions/` is not a directory of session records. It also holds the stores
 * acpx keeps beside them, and every enumerator of that directory has to know which is
 * which. This module is the one place that knows; every such site imports from here.
 *
 * ## 🔑 WHY THIS MODULE EXISTS RATHER THAN ONE MORE NAME IN EACH FILTER
 *
 * The codebase already contains both patterns, and comparing them gives the rule:
 *
 * - **SAFE, because they ALLOW-LIST by positive shape match** — `repository.ts`'s
 *   `isSessionStreamFile` (matches `${safeId}.stream.*`) and `indexStreamFilesBySafeId`
 *   (keys on `STREAM_FILE_INFIX`). A new file in the directory cannot enter either,
 *   because it does not match the shape they are looking FOR.
 * - **BROKEN, because they DENY-LIST by name** — `listSessionRecordFiles` excluded
 *   `index.json` and nothing else, so `seats.json` was enumerated as a session record
 *   the day the seat store landed.
 *
 * ⇒ **A deny-list over a directory breaks EVERY time a file is added**, and `seats.json`
 * is simply the first new file in that directory in years. So the fix is not to add one
 * more name to each filter — that leaves the next file to break them again, in exactly
 * the same way, with the same silence. **Prefer an allow-list; where a deny-list is
 * genuinely the right shape, it imports this registry rather than spelling a name.**
 *
 * ## Why a miss is silent, which is what makes it worth a module
 *
 * A store file that slips through is treated as a session record whose id is its stem
 * (`seats.json` → id `seats`). Nothing throws: the parse fails, a downstream guard drops
 * it, and the only trace is wasted work — or, at the two sites that write what they
 * enumerated, a wrong value persisted. The known consequences, measured:
 *
 * - `listSessionRecordFiles` → the store lands in the index's `files` array and
 *   `readIndexEntryFromDisk` tries to parse it as a record: a permanent
 *   files-vs-entries mismatch that makes the reconciler work on every pass.
 * - `archive/retention.ts`'s hot-dir scan → the store enters as *unclaimed* and reaches
 *   the ORPHAN path. It escapes archiving today only because `INGEST_ORPHAN_ID_SHAPE`
 *   rejects the stem `seats` for not looking like a minted id — the same incidental
 *   protection `RESERVED_ID_PARTS`'s own header says must not be relied on. `seats` is
 *   named there explicitly for that reason; this registry is the other half.
 *
 * ⚠️ Kept byte-identical to acpx-ui's `server/sessionStoreFiles.ts`. The two repos are
 * separate deployables with no shared import — the same hand-kept duplication
 * `index-lock.ts` already carries for the lock protocol, and for the same reason.
 * **Change one, change both.**
 */

/** The session-index projection acpx maintains beside the records. */
export const SESSION_INDEX_FILE = "index.json";

/** The seat store — the authority for which holder sits in which seat (brick b64dfbb3).
 * It lives INSIDE `SESSIONS_DIR` deliberately: acpx-ui's `fs.watch` covers that
 * directory and not `~/.acpx/`, so a store one level up would not be watched at all. */
export const SEAT_STORE_FILE = "seats.json";

/**
 * True when `filename` is a file acpx keeps in `SESSIONS_DIR` that is NOT a session
 * record — so an enumerator must skip it rather than derive an id from its stem.
 *
 * Takes a BARE FILENAME, never a path: every call site already holds a `readdir` entry,
 * and accepting a path would invite `path.basename` guesses at half of them.
 *
 * ⚠️ NOT a general "is this a session record" test — it answers only the question its
 * name asks. Callers keep their own additional rules (`.tmp` writers, messages-log
 * sidecars, `.stream.ndjson`), because those differ per site and several are suffix
 * rules rather than names. Folding them in here would produce one predicate that is
 * subtly wrong at every site instead of right at all of them.
 */
export function isNonSessionRecordFile(filename: string): boolean {
  return filename === SESSION_INDEX_FILE || filename === SEAT_STORE_FILE;
}

/**
 * acpx-ui's delivery store's files, which share the sessions directory and ALL end in `.json`:
 * `<id>.delivery.json` (390 on devbox) and its legacy siblings `<id>.queue.json`, `<id>.inflight.json`
 * (`ACTIVE_SIDECAR_SUFFIXES` in acpx-ui `server/delivery-store.ts` — keep in step). Archive identity reads
 * the same list for its `active-delivery-sidecar` blocker, so there is one list here.
 */
export const DELIVERY_SIDECAR_SUFFIXES: readonly string[] = [
  ".delivery.json",
  ".queue.json",
  ".inflight.json",
];

/**
 * ⚠️ THE ONE ANSWER TO "IS THIS NAME A SESSION RECORD FILE?" (brick 99bf1c0d, atrium O8-1): `<id>.json` — a
 * non-empty id, no path separator — that is neither one of acpx's own stores ({@link isNonSessionRecordFile})
 * nor a delivery sidecar ({@link DELIVERY_SIDECAR_SUFFIXES}).
 *
 * Why not "ends with `.json`": the directory also holds `<id>.delivery.json` (390 on devbox) and its
 * siblings. They end in `.json` too, so every `endsWith(".json")` enumerator counted them as session records:
 * phantom members of the index's `files` (the whole index rewritten whenever one appears or goes — "drift"),
 * a false `parse` error each in the seat backfill, and a full read of each as a record candidate. Had one
 * ever held record-shaped JSON it would have become a phantom session `<id>.delivery`.
 *
 * Why not "uuid-shaped" (the brief's first wording): ids are opaque. devbox carries real `ses_…` records
 * (opencode) and the archive a slug id; a uuid test would silently drop them from the index.
 * Why not "no dot in the id" (the first cut): ids may contain dots — `pruneSessions` has rows for an id with
 * `.stream.` in it — and a dot-free rule would drop such a record.
 *
 * ⚠️ So this IS a deny-list over the one known family, which `session-dir-files.ts`'s own header calls the
 * fragile shape. KNOWN LIMIT: a NEW sidecar family named `<id>.<x>.json` would be counted again until its
 * suffix joins {@link DELIVERY_SIDECAR_SUFFIXES}. What keeps that cheap: `test/session-record-file-name.test.ts`
 * scans `src/` and fails on any `.json` filter that does not go through here, so the fix is this one list.
 * Takes a BARE FILENAME, like {@link isNonSessionRecordFile}.
 */
export function isSessionRecordFileName(filename: string): boolean {
  return (
    filename.endsWith(".json") &&
    filename.length > ".json".length &&
    !/[\\/]/u.test(filename) &&
    !isNonSessionRecordFile(filename) &&
    !DELIVERY_SIDECAR_SUFFIXES.some((suffix) => filename.endsWith(suffix))
  );
}
