import fs from "node:fs/promises";
import path from "node:path";
import type { SessionRecord } from "../../types.js";
import { withSessionIndexLock } from "./index-lock.js";
import {
  reconcileSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
  type SessionIndexEntry,
} from "./index.js";
import { parseSessionRecord } from "./parse.js";

/**
 * One file's contribution to an overlay: how to derive the field group from that
 * file's record.
 */
export type SessionIndexEntryOverlay = {
  /**
   * The field group to write, DERIVED FROM THE RECORD AS IT STANDS ON DISK AT
   * FLUSH TIME — never from a value the caller captured earlier. That is the whole
   * point of taking a function rather than an object: there is no snapshot in this
   * API for a concurrent writer to lose to.
   *
   * ⚠️ AN EXPLICIT `undefined` CLEARS THE FIELD, and that is load-bearing rather
   * than incidental: a group whose "absent" case must not leave a stale value
   * behind (a cross-box `parentSessionUrl` pointing at the wrong host) has to be
   * able to say so. `writeSessionIndex` stringifies, and `JSON.stringify` drops
   * undefined-valued keys — so the field leaves the index rather than persisting
   * as `null`. Do NOT build these objects with an "assign only defined values"
   * helper; it silently turns a clear into a keep.
   *
   * A group that is NOT derivable from the record (index-only state) may ignore
   * the argument and close over its own per-file value — the contract below is
   * unaffected, since it is about what the ENTRY is merged onto.
   */
  fields: (record: SessionRecord) => Partial<SessionIndexEntry>;
};

/**
 * Apply a field group to many index entries in ONE locked index write.
 *
 * ## The contract — what a caller may rely on
 *
 * 1. **Entries AND records are read FRESH FROM DISK inside the lock.** Nothing here
 *    replays a snapshot taken when the caller wrote its records: the entries are
 *    the base, and `fields` is handed the record as it stands at flush time. **So a
 *    concurrent AUTHORITATIVE write to a field INSIDE the group is not clobbered —
 *    it is adopted**, because the record is the authority and the index follows the
 *    record. (An earlier version of this helper took a pre-computed object and did
 *    lose that race: a `--session-id` re-parent, or acpx-ui's parent PATCH, landing
 *    mid-batch was overwritten by the batch's older value, which then made the
 *    child invisible to a re-run — a silent orphan. brick 2f6f9951, TE finding §5.)
 *
 *    🛑 **THE PROPERTY THAT MAKES THIS SOUND, NAMED: what is written is projected
 *    from a POST-PRESERVE RECORD.** `preserveParentLinkageForPersist`
 *    (`repository.ts`) guarantees that the parent group reaching `<id>.json` is
 *    either a fresh disk read (ordinary writer) or an authoritative writer's
 *    intended value — and the per-child index path relies on exactly that, since it
 *    projects its entry from the in-memory record *after* that step. This helper
 *    does not RECONSTRUCT that state, it reads **the persisted bytes themselves**,
 *    which are that step's output from whichever write landed last — so it carries
 *    the guarantee by construction, and carries it fresher than the per-child path
 *    does. Both legs of that round trip are field-by-field (`serialize.ts` writes
 *    the four, `parse.ts` reads the four); a field dropped from either would
 *    already break the index rebuild, which derives entries from records the same
 *    way. **A caller must therefore never hand this helper a value it captured
 *    earlier — the whole guarantee lives in reading late.**
 * 2. **It runs under the session index lock** (`withSessionIndexLock`), and the
 *    entry read, the record reads, the merge and the write all happen inside it.
 *    The write itself is `writeSessionIndex`'s temp-file + atomic rename, so a
 *    crash leaves the old or the new index, never a partial one.
 * 3. **It bypasses the pending-entry queue entirely** — nothing is enqueued, so no
 *    later `flushPendingSessionIndexUpdates` (owner exit, `beforeExit`, or any
 *    same-process index read's read-your-writes) can write a stale snapshot behind
 *    the caller's back.
 * 4. **A CONCURRENT CLOSE SURVIVES IT.** A session that closes — or is renamed,
 *    favourited, or otherwise edited in any field outside the group — while the
 *    overlay is in flight keeps that change. Only the named fields are written;
 *    every other field of every entry is whatever disk says at flush time. This is
 *    the guarantee the helper exists for: the obvious alternative shape, replacing
 *    whole entries, reverts `closed` to `false` for a child that closes mid-batch —
 *    and being closed, that child receives no further record write, so *nothing
 *    ever heals it*. Reproduced with a control (brick 2f6f9951 §4.3), and pinned by
 *    a regression test with a mutation probe.
 * 5. **One call is one lock and one index write**, for any number of files — so a
 *    caller may write N records and then bring the index level once, atomically,
 *    without holding the lock across the record writes.
 * 6. **A record that is gone or unreadable at flush time gets NO index row.** Not a
 *    rule this code has to remember: the group is derived from the record, so with
 *    no record there is nothing to derive and nothing is written. An index row for
 *    a vanished record is worse than a missing one.
 *
 * ## What it does NOT do
 *
 * - It does not write records. Order stays record-first, index-second: a caller
 *   that crashes between the two leaves children torn `record=NEW, index=OLD`,
 *   which is the self-healing direction the `set-parent` heal branch repairs on a
 *   re-run. **For a CRASH — and only for a crash — widening the gap widens the torn
 *   SET, never its kind** (measured: a SIGKILL mid-batch left every affected child
 *   in the heal branch, and one re-run repaired all of them). ⚠️ That sentence used
 *   to be written without the qualifier and it was FALSE for a CONCURRENT WRITE:
 *   when this helper replayed an add-time snapshot, a concurrent authoritative
 *   re-parent produced a tear of a DIFFERENT kind — the index naming a parent that
 *   is neither the old nor the current one — which the heal branch does NOT repair
 *   on a re-run of the same command. Contract 1 is what removes that case; do not
 *   re-generalise the claim.
 * - It does not refresh the entry's OTHER fields from the record. That is the point
 *   of (4); a caller whose write changes fields outside its group must include them
 *   in `fields` or write the entry the ordinary way.
 * - **It does not bound how long you hold this lock — the CALLER's batch size
 *   does.** One record read per file happens inside the lock (measured on the live
 *   store, 400 real records: median 0.68 ms, p90 3.1 ms, p99 8.7 ms, worst 14.5 ms
 *   at 630 KB; store sizes median 5 KB / p99 174 KB / max 1.4 MB). The threshold
 *   that matters is NOT the 5 s stale takeover — it is `INDEX_LOCK_MAX_WAIT_MS`
 *   (2 s), after which a waiting writer **proceeds unlocked**, which is precisely
 *   the racing read-modify-write this lock exists to prevent. Keep the locked
 *   section under ~1 s. See `INDEX_FLUSH_CHUNK` in `session-reparent.ts` for a
 *   worked bound.
 *
 * > **Why holding it longer cannot DEADLOCK** (`index-lock.ts`, read before this
 * > was written): acquisition waits at most ~2 s and then proceeds without the
 * > lock — it never blocks indefinitely — and a nested acquisition in the same
 * > process is detected through `AsyncLocalStorage` and runs the callback directly
 * > under the held lock. The reads below are plain `fs.readFile` + parse: no
 * > outbox, no queue flush, no second lock of any kind. The cost of holding too
 * > long is a concurrent writer degrading to unlocked, never a wedge.
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
    const diskFiles = new Set(index.files);
    // Read every overlaid record ONCE, here, inside the lock — contract 1. A file
    // the reconcile no longer lists was pruned while the batch ran; it is skipped
    // before the read rather than after, so a vanished record costs nothing.
    const records = new Map<string, SessionRecord>();
    for (const file of overlays.keys()) {
      if (!diskFiles.has(file)) {
        continue;
      }
      const record = await readRecordForOverlay(sessionDir, file);
      if (record) {
        records.set(file, record);
      }
    }

    const overlaid = new Set<string>();
    const entries = index.entries.map((entry) => {
      const overlay = overlays.get(entry.file);
      const record = records.get(entry.file);
      if (!overlay || !record) {
        return entry;
      }
      overlaid.add(entry.file);
      return { ...entry, ...overlay.fields(record) };
    });
    // A moved file the index has no row for yet still needs one, or the update is
    // silently dropped for exactly the files that need it most. Built from the same
    // fresh record, so it cannot disagree with the overlay above.
    for (const [file, overlay] of overlays) {
      const record = records.get(file);
      if (record && !overlaid.has(file)) {
        entries.push({ ...toSessionIndexEntry(record, file), ...overlay.fields(record) });
      }
    }
    await writeSessionIndex(sessionDir, { files: index.files, entries });
  });
}

/**
 * The record behind one index row, read the same way the index rebuild reads it
 * (`readIndexEntryFromDisk`): no message hydration, no outbox, no lock — every
 * field an index entry can carry is already in `<id>.json`.
 *
 * ⚠️ NOT `resolveSessionRecord`. This runs INSIDE the index lock, and that
 * function's miss path calls `loadSessionIndexEntries`, which flushes the pending
 * queue and re-enters the lock. In-process that is re-entrant rather than fatal
 * (`index-lock.ts`), but it would drag a queue flush into the middle of our own
 * read-modify-write — a write we did not ask for, under our lock.
 */
async function readRecordForOverlay(
  sessionDir: string,
  file: string,
): Promise<SessionRecord | undefined> {
  try {
    const payload = await fs.readFile(path.join(sessionDir, file), "utf8");
    return parseSessionRecord(JSON.parse(payload)) ?? undefined;
  } catch {
    // corrupt, or vanished between the readdir and this read — contract 6
    return undefined;
  }
}
