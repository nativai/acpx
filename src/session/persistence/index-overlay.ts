import { withSessionIndexLock } from "./index-lock.js";
import { reconcileSessionIndex, writeSessionIndex, type SessionIndexEntry } from "./index.js";

/**
 * One file's contribution to an overlay: the fields to change, and the entry to
 * insert if the index turns out not to have a row for that file at all.
 */
export type SessionIndexEntryOverlay = {
  /**
   * The field group to write onto the entry as it stands on disk.
   *
   * ⚠️ AN EXPLICIT `undefined` CLEARS THE FIELD, and that is load-bearing rather
   * than incidental: a group whose "absent" case must not leave a stale value
   * behind (a cross-box `parentSessionUrl` pointing at the wrong host) has to be
   * able to say so. `writeSessionIndex` stringifies, and `JSON.stringify` drops
   * undefined-valued keys — so the field leaves the index rather than persisting
   * as `null`. Do NOT build these objects with an "assign only defined values"
   * helper; it silently turns a clear into a keep.
   */
  fields: Partial<SessionIndexEntry>;
  /**
   * The entry to insert when the reconcile returns no row for this file — a
   * record the index has not caught up with yet. Without it the update is
   * silently dropped for exactly the files that need it most. Build it from the
   * record you just wrote (`toSessionIndexEntry(record, file)`).
   */
  fallback: SessionIndexEntry;
};

/**
 * Apply a field group to many index entries in ONE locked index write.
 *
 * ## The contract — what a caller may rely on
 *
 * 1. **Entries are read FRESH FROM DISK inside the lock.** This never replays a
 *    snapshot taken when the caller's records were written. Whatever the entries
 *    hold at flush time is the base.
 * 2. **It runs under the session index lock** (`withSessionIndexLock`), and the
 *    read, the merge and the write all happen inside it. The write itself is
 *    `writeSessionIndex`'s temp-file + atomic rename, so a crash leaves the old
 *    or the new index, never a partial one.
 * 3. **It bypasses the pending-entry queue entirely** — nothing is enqueued, so
 *    no later `flushPendingSessionIndexUpdates` (owner exit, `beforeExit`, or any
 *    same-process index read's read-your-writes) can write a stale snapshot
 *    behind the caller's back.
 * 4. **A CONCURRENT CLOSE SURVIVES IT.** A session that closes — or is renamed,
 *    favourited, or otherwise edited in any field outside `fields` — while the
 *    overlay is in flight keeps that change. Only the named fields are written;
 *    every other field of every entry is whatever disk says at flush time. This
 *    is the guarantee the helper exists for: the obvious alternative shape,
 *    replacing whole entries from a snapshot, reverts `closed` to `false` for a
 *    child that closes mid-batch — and being closed, that child receives no
 *    further record write, so *nothing ever heals it*. Reproduced with a control
 *    (brick 2f6f9951 §4.3: snapshot shape `closed:false` on a `closed:true`
 *    record; overlay shape `closed:true`), and pinned by a regression test with a
 *    mutation probe.
 * 5. **One call is one lock and one index write**, for any number of files — so a
 *    caller may write N records and then bring the index level once, atomically,
 *    without holding the lock across the record writes.
 *
 * ## What it does NOT do
 *
 * - It does not write records. Order stays record-first, index-second: a caller
 *   that crashes between the two leaves children torn `record=NEW, index=OLD`,
 *   which is the self-healing direction the `set-parent` heal branch repairs on a
 *   re-run. Widening the gap widens the torn SET, never its kind.
 * - It does not bound how long you wait to flush. `INDEX_LOCK_STALE_MS` is 5 s
 *   and applies to the lock this takes, not to the caller's batch — so never hold
 *   this lock across the record-write loop, and keep the batch short enough that
 *   the record/index disagreement stays inside the ≤5 s the throttled scalar path
 *   already tolerates.
 * - It does not refresh the entry's OTHER fields from the record. That is the
 *   point of (4); a caller whose write changes fields outside its group must
 *   include them in `fields` or write the entry the ordinary way.
 *
 * A file present in `overlays` but absent from the store's file list at flush
 * time is dropped, never resurrected — it was pruned by another process while the
 * batch ran, and an index row for a vanished record is worse than a missing one.
 */
export async function overlaySessionIndexEntries(
  sessionDir: string,
  overlays: ReadonlyMap<string, SessionIndexEntryOverlay>,
): Promise<void> {
  if (overlays.size === 0) {
    return;
  }
  await withSessionIndexLock(sessionDir, async () => {
    const { index } = await reconcileSessionIndex(sessionDir);
    const overlaid = new Set<string>();
    const entries = index.entries.map((entry) => {
      const overlay = overlays.get(entry.file);
      if (!overlay) {
        return entry;
      }
      overlaid.add(entry.file);
      return { ...entry, ...overlay.fields };
    });
    const diskFiles = new Set(index.files);
    for (const [file, overlay] of overlays) {
      if (!overlaid.has(file) && diskFiles.has(file)) {
        entries.push(overlay.fallback);
      }
    }
    await writeSessionIndex(sessionDir, { files: index.files, entries });
  });
}
