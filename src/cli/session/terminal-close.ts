import { releaseHarnessConfigDir } from "../../acp/harness-config-dir.js";
import {
  isoNow,
  readRawRecordClosedState,
  writeSessionRecordAtBoundaryWithLifecycle,
} from "../../session/persistence.js";
import type { RawRecordFieldState } from "../../session/persistence.js";
import type { SessionRecord } from "../../types.js";

// The two steps of a terminal close that every close arm shares: the CLI's non-self close and
// self-close (`session-control.ts`), and the queue owner's own close at the end of a turn
// (brick 9d34a178, `queue-owner-runtime.ts`). One copy, so the three cannot drift apart.

// What the close actually verified on disk after writing — the record-derived
// fact a caller (above all the CLI printer, brick 1bfb95ed deliverable 4) must
// report, instead of inferring success from the write call's own exit status.
export type SessionCloseRecordState =
  | { status: "read"; closed: RawRecordFieldState; closedAt: RawRecordFieldState }
  | { status: "read_failed"; error: string };

// Re-reads `<id>.json` immediately after the terminal write, converting a
// throw (missing file, invalid JSON) into its own distinct outcome rather than
// letting it propagate and mask a close that otherwise succeeded.
export async function readBackRecordClosedState(
  acpxRecordId: string,
): Promise<SessionCloseRecordState> {
  try {
    const raw = await readRawRecordClosedState(acpxRecordId);
    return { status: "read", closed: raw.closed, closedAt: raw.closedAt };
  } catch (error) {
    return { status: "read_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The terminal record write: `closed: true`, `closed_at`, the adapter pid cleared. Privileged write —
 * a daemon-authorized close bypasses the read-preserve-lifecycle step so `closed: true` actually lands
 * on disk (see writeSessionRecord's doc comment in repository.ts for the ownership rules). Nothing can
 * un-close the record afterwards: every ordinary write read-preserves `closed` from disk.
 */
export async function writeTerminalCloseRecord(
  record: SessionRecord,
): Promise<SessionCloseRecordState> {
  record.pid = undefined;
  record.pidIdentity = undefined;
  record.closed = true;
  record.closedAt = isoNow();
  await writeSessionRecordAtBoundaryWithLifecycle(record);
  return await readBackRecordClosedState(record.acpxRecordId);
}

/**
 * THE TERMINAL CLOSE IS WHERE THE CONFIG DIR GOES (brick 433f6bf8).
 *
 * ## Why here and not in `AcpClient.close()`, which already releases
 *
 * `AcpClient.close()` releases too, and that is the fast path — but it needs a
 * LIVE CLIENT. The sessions that leak are exactly the ones with no client left:
 * an owner released for idleness, `kill -9`, a pod eviction. **Measured on the
 * deployed build 2026-09-08: eight `/tmp/acpx-pi-<id>` dirs, ~320 KB each, every
 * record `closed:true` carrying the right `harness_config_dir`, and EVERY holder
 * pid dead** — eight instances of "the client that would have released it was
 * already gone". They had survived ~16 h and more than two sweep intervals.
 *
 * The terminal close is the one place that cannot be skipped by that: `closeSession`
 * is the canonical terminal close, acpx-ui delegates to the verb that calls it, and
 * `markSessionAsTemplate` — the second authorized writer of `closed` — calls it too;
 * the queue owner's own close at the end of a turn (brick 9d34a178) calls this after
 * its client is closed. Releasing here therefore covers every close path there is.
 *
 * ## ⚠️ IT RELEASES, IT DOES NOT DELETE — and the ordering is what makes that work
 *
 * Every caller runs this only once the holder it knows of is gone: the non-self close
 * after `terminateQueueOwnerForSession` WAITED for the owner to exit, the owner after
 * its own client released its holder. `dropStaleHolders` drops a dead holder
 * deterministically. A second client that is still ALIVE keeps its holder, the
 * directory is RETAINED, and the orphan sweep collects it later — which is the
 * 4a6fdda0 invariant (one session, two clients, one directory) preserved rather than
 * re-litigated. This can therefore never delete a directory out from under a live turn.
 *
 * ## ⚠️ BEST-EFFORT, AND NEVER FATAL TO A CLOSE
 *
 * A close that failed because the tidy-up threw would be strictly worse than a
 * directory that survives to the sweep. The sweep remains the guarantee; this is
 * the deterministic fast path.
 *
 * ⚠️ Consequence worth knowing: acpx-ui's "Show injected primer" reads this
 * directory for its `exact:true` config-dir source, so a closed pi session loses
 * that source at close rather than at the next sweep. That is a move of an
 * existing loss, not a new one — the sweep already removes these on a
 * `closedRecord` verdict — and the modal has a documented fallback.
 */
export function releaseConfigDirOnTerminalClose(record: SessionRecord): void {
  const dir = record.acpx?.harness_config_dir;
  if (dir === undefined) {
    return;
  }
  try {
    releaseHarnessConfigDir(dir, undefined);
  } catch {
    // Best-effort by design — see above. The orphan sweep is the guarantee.
  }
}
