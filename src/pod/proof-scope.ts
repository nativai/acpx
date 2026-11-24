import { readQueueOwnerLeaseFile } from "../cli/queue/lease-store.js";
import { lockHostPlace, lockPodIdentity } from "./identity.js";
import { placeOf, podModeVerdictNow, readPodFileWithWitness } from "./placement.js";

/**
 * Block A11 / A-67 (C1.1 "Proofs from this host's process table"; the audit list K7 and C91): a proof
 * read from THIS process's `/proc` — a writer holding a transcript open, a process naming a session, a
 * recorded pid — answers only for the processes of THIS pod. The control pod cannot see an agent pod's
 * processes, so "no writer" and "no owner" read there are false negatives, and the caller would delete
 * or close on them.
 *
 * `localProofScope(recordId)` says whether this process's table is the whole world for that session:
 *
 *   in an agent pod            → `local` only for THAT session's own pod
 *   any other host             → THE SESSION'S LEASE DECIDES, in or out of pod mode:
 *                                a lease that names a pod → `session-in-pod`;
 *                                no lease, or one without `pod` → `local`;
 *                                a lease that cannot be read, or whose `pod` key is present but unreadable
 *                                → `pod-unreadable` (fail closed)
 *   a host with no pod identity (A-5) that is not switched
 *                              → `local` before anything is read: it was never switched, so no lease
 *                                of its own names a pod — a box that was never switched is unchanged
 *
 * ⚠️ DO NOT "SIMPLIFY" THE LEASE READ INTO `podModeVerdictNow(...).mode === "off" → local`. After a
 * revert (A-16) a session whose lease still names a living pod stays a pod session until C3.3 proves
 * the pod gone, and the pod's adapter keeps writing the transcript this host's `/proc` cannot see.
 * Held by `test/pod-proof-scope.test.ts` ("pod mode OFF after a revert").
 *
 * ⚠️ A DELETION, CLOSE OR "OWNERLESS" VERDICT THAT RESTS ON A LOCAL PROCESS TABLE MUST ASK THIS FIRST.
 * `test/pod-proof-scope.test.ts` scans `src/` for `/proc` readers and fails on one that neither calls
 * this nor is on its reviewed allow-list.
 */
export type ProofScope =
  | { local: true }
  | { local: false; reason: "session-in-pod" | "other-pod" | "pod-unreadable" };

export async function localProofScope(
  recordId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProofScope> {
  if (lockHostPlace(env) === "agent-pod") {
    return placeOf(readPodFileWithWitness(env), recordId) === "own-pod"
      ? { local: true }
      : { local: false, reason: "other-pod" };
  }
  // A switched host that cannot name its pod has an unknown relation to every lease: fail closed.
  if (podModeVerdictNow(env).mode === "refuse") {
    return { local: false, reason: "pod-unreadable" };
  }
  if (lockPodIdentity(env) === undefined) {
    return { local: true };
  }
  return await leaseScope(recordId);
}

async function leaseScope(recordId: string): Promise<ProofScope> {
  const lease = await readQueueOwnerLeaseFile(recordId);
  // A lease whose `pod` is present but cannot be read is as unreadable as a lease that cannot be parsed:
  // reading it as "no pod" would remove what a living pod writes (TE LOW-1).
  if (lease.kind === "unparsable" || (lease.kind === "ok" && lease.record.podUnreadable === true)) {
    return { local: false, reason: "pod-unreadable" };
  }
  return lease.kind === "ok" && lease.record.pod !== undefined
    ? { local: false, reason: "session-in-pod" }
    : { local: true };
}
