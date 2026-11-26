import type { PodMarksVerdict } from "../../pod/reclaim-marks.js";
import type { ReleaseRefusal } from "../queue/messages.js";

// brick 35d4e64b (acpx half of ef5934ba) — the ON-DEMAND release gate: may this owner be ended NOW to make
// room for a message held for home room? Pure, so every refusal is a row a test calls directly; the
// owner's own loop feeds it live state in ONE synchronous step (nothing here awaits).
//
// This is NOT `decideIdleOwnerRelease`'s gate, on purpose. That gate answers "may a quiet owner release
// ITSELF, unasked" and opts `--ttl 0` out (a master never-recycle switch). This one answers a request
// from the box's admission path, and `--ttl 0` does NOT exempt a session from it (decision 2026-11-25,
// "Option A": an idle `--ttl 0` home session is reclaimable — one forgotten orchestrator would otherwise
// hold a home slot for 7 days). Nothing here reads `ttlMs`.
//
// ⚠️ EVERY REFUSAL LEAVES THE OWNER UNTOUCHED — the caller commits only on `ok`. And a doubt is a refusal:
// the order below puts the owner's own state first, the pod's marks last (they cost file reads).

export type ReclaimGateInput = {
  /**
   * The owner's loop is PARKED waiting for work (`await owner.nextBatch`). The one state in which no
   * turn is starting, running or finishing. From a handed-out batch until the loop parks again it is
   * FALSE, which closes the gap `hasActiveTurn()` alone leaves (batch taken, turn not yet begun).
   */
  loopParked: boolean;
  hasActiveTurn: boolean;
  /** Something is queued for this owner. */
  queued: boolean;
  /** No inter-turn idle-drain relay within the check cadence (the same window the idle gate uses). */
  quiescent: boolean;
  /** The adapter holds background tasks: a release closes it and KILLS them. */
  liveBackgroundTaskCount: number;
  /** Lazy: file reads, evaluated only after every owner-side condition holds. */
  podMarks: () => PodMarksVerdict;
};

export type ReclaimGateVerdict =
  | { ok: true }
  | { ok: false; reason: ReleaseRefusal; detail: string };

export function decideReclaim(input: ReclaimGateInput): ReclaimGateVerdict {
  if (input.hasActiveTurn) {
    return { ok: false, reason: "turn_running", detail: "a turn is running" };
  }
  if (!input.loopParked) {
    return {
      ok: false,
      reason: "turn_running",
      detail: "the owner's loop is between turns (a batch was just handed out or a turn is ending)",
    };
  }
  if (input.queued) {
    return { ok: false, reason: "queued", detail: "a prompt is queued for this session" };
  }
  if (!input.quiescent) {
    return {
      ok: false,
      reason: "turn_running",
      detail: "the owner is relaying inter-turn activity from its agent",
    };
  }
  if (input.liveBackgroundTaskCount > 0) {
    return {
      ok: false,
      reason: "turn_running",
      detail: `background: ${input.liveBackgroundTaskCount} background task(s) live; a release would kill them`,
    };
  }
  const marks = input.podMarks();
  if (!marks.ok) {
    return { ok: false, reason: `pod_busy:${marks.reason}`, detail: marks.detail };
  }
  return { ok: true };
}

/** The ONE loud line per reclaim (condition 4 of the accepted design). Greppable: `queue owner RECLAIMED`. */
export function formatOwnerReclaimLine(input: {
  sessionId: string;
  at: number;
  idleMs: number;
  heldTarget: string | undefined;
}): string {
  const totalSeconds = Math.max(0, Math.floor(input.idleMs / 1000));
  const idle = `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, "0")}s`;
  return (
    `[acpx] queue owner RECLAIMED session ${input.sessionId} (reason=reclaim) to make room for a held message; ` +
    `its record stays and the next message starts it again; at=${new Date(input.at).toISOString()} ` +
    `idle=${idle} held_target=${input.heldTarget ?? "unknown"}\n`
  );
}
