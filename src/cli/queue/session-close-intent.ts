// Process-local "this owner has been told its session is closing" flag, per session id.
//
// WHY (practical-tests pass 1, brick 71fdcaf2 / S5.4). `sessions close` drains the owner (`drain_deliveries`,
// reason `session-close`), then asks the adapter to close the ACP session — which cancels the turn in flight —
// and only THEN stamps `closed: true` on the record. A delivery whose turn the close cancelled therefore ended
// `cancelled` with no code, written ~100 ms BEFORE the record read closed, so neither side could tell it from a
// Stop-button cancel: acpx-ui's sender notice fires only on `failed` + a code, and the sender was never told.
//
// The owner is the one process that WITNESSED the close (the drain verb is the only thing that tells it), so it
// is the right place to say so. This module is the same shape as `absorbed-delivery-registry`: runtime.ts and the
// IPC server both live in the owner process but share no object, so the fact goes through a module-level set.
//
// Never cleared, deliberately: a draining owner is on its way out (see `OwnerExitCause`), and an owner whose
// close was abandoned after the drain is still not accepting work.
const closingSessions = new Set<string>();

export function noteSessionCloseDrain(sessionId: string): void {
  closingSessions.add(sessionId);
}

export function isSessionCloseDrainActive(sessionId: string): boolean {
  return closingSessions.has(sessionId);
}

/** Test seam: the set is process-global, and a test process hosts many owners. */
export function resetSessionCloseIntentForTests(): void {
  closingSessions.clear();
}
