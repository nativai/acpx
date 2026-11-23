import { releaseHarnessConfigDir } from "../../acp/harness-config-dir.js";
import { removeSessionTmpDir } from "../../acp/session-tmp-dir.js";
import {
  isoNow,
  readRawRecordClosedState,
  resolveSessionRecord,
  writeSessionRecordAtBoundaryWithLifecycle,
} from "../../session/persistence.js";
import type { MessageWriteMode, RawRecordFieldState } from "../../session/persistence.js";
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
  messageWrite?: MessageWriteMode,
): Promise<SessionCloseRecordState> {
  record.pid = undefined;
  record.pidIdentity = undefined;
  record.closed = true;
  record.closedAt = isoNow();
  await writeSessionRecordAtBoundaryWithLifecycle(record, { messageWrite });
  return await readBackRecordClosedState(record.acpxRecordId);
}

/**
 * C3.5 (ii), A-60 — THE TERMINAL WRITE OF A CLOSE OF ANOTHER SESSION, after the stop. `closeSession`
 * reads the record at its start, to know which owner generation to drain and stop; it then waits for
 * the turn, `close_session` and the stop, and the owner writes its turn's output meanwhile. Writing
 * that early read back is what replaced a mid-turn session's final reply with the partial the close
 * had read (the probe's LEAD).
 *
 * - Owner STOPPED (`stopped: true` — `stopped`, `already-gone`, `released`, `no-owner`): the close is the
 *   only writer left. It reads the record AGAIN, so the owner's last output is in it, and its write may
 *   log the dead owner's last inline partial, at the log's true end (`adopt`).
 * - Owner NOT proven stopped (`successor`, `survived`, `identity-unverified`, …): a live writer may
 *   still append. The close writes the scalars only — `closed`, `closed_at`, the adapter pid cleared —
 *   keeps the watermark and the inline entries as they are on disk, and says why on stderr (`keep`).
 *
 * ⚠️ DO NOT "SIMPLIFY" THIS BACK TO `writeTerminalCloseRecord(record)` WITH THE EARLY COPY. That copy is
 * the stale one. Rows 60.1, 60.5 and 60.10 (test/writer-rules-a60*.test.ts) go red if you do.
 * A self-close and a deferred close are the owner's own writes and keep `writeTerminalCloseRecord`.
 */
export async function writeTerminalCloseAfterOwnerStop(
  record: SessionRecord,
  ownerStop: { stopped: boolean; reason?: string },
): Promise<{ record: SessionRecord; state: SessionCloseRecordState }> {
  if (!ownerStop.stopped) {
    process.stderr.write(
      `[acpx] close: owner of ${record.acpxRecordId} not proven stopped (${ownerStop.reason ?? "unknown"}); ` +
        `wrote the record's scalars only — its messages log and inline entries are left to the owner\n`,
    );
    return { record, state: await writeTerminalCloseRecord(record, "keep") };
  }
  const afterStop = await resolveSessionRecord(record.acpxRecordId);
  return { record: afterStop, state: await writeTerminalCloseRecord(afterStop, "adopt") };
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

/**
 * Block A8: in pod placement the scratch directory (`<state home>/session-tmp/acpx-<id>`) is removed
 * when the session closes — the shared volume must not accumulate what a pod's `/tmp` used to shed on
 * its own. Called beside `releaseConfigDirOnTerminalClose` on every close arm. Never throws, and does
 * nothing outside pod placement (`removeSessionTmpDir`).
 */
export function removeScratchOnTerminalClose(record: SessionRecord): void {
  removeSessionTmpDir(record.acpxRecordId);
}
