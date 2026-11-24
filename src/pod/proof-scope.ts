import { readFileSync } from "node:fs";
import {
  classifyLeasePayload,
  readQueueOwnerLeaseFile,
  type LeaseFile,
  type UnparsableShape,
} from "../cli/queue/lease-store.js";
import { queueLockFilePath } from "../cli/queue/paths.js";
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
  return scopeWithoutLease(recordId, env) ?? scopeOfLease(await readQueueOwnerLeaseFile(recordId));
}

/**
 * `localProofScope` for a SYNCHRONOUS caller (A-80's sync stream helper): the same rule, the lease read with
 * `readFileSync`. One rule — both call `scopeWithoutLease` and `scopeOfLease`; there is no second copy.
 */
export function localProofScopeSync(
  recordId: string,
  env: NodeJS.ProcessEnv = process.env,
): ProofScope {
  return scopeWithoutLease(recordId, env) ?? scopeOfLease(readLeaseFileSync(recordId));
}

function readLeaseFileSync(recordId: string): LeaseFile {
  try {
    return classifyLeasePayload(readFileSync(queueLockFilePath(recordId), "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unparsable", shape: { kind: "bytes" } };
  }
}

/** The answer that needs no lease; `undefined` when the lease decides. */
function scopeWithoutLease(recordId: string, env: NodeJS.ProcessEnv): ProofScope | undefined {
  if (lockHostPlace(env) === "agent-pod") {
    return placeOf(readPodFileWithWitness(env), recordId) === "own-pod"
      ? { local: true }
      : { local: false, reason: "other-pod" };
  }
  // A switched host that cannot name its pod has an unknown relation to every lease: fail closed.
  if (podModeVerdictNow(env).mode === "refuse") {
    return { local: false, reason: "pod-unreadable" };
  }
  return lockPodIdentity(env) === undefined ? { local: true } : undefined;
}

function scopeOfLease(lease: LeaseFile): ProofScope {
  if (lease.kind === "unparsable") {
    return unparsableScope(lease.shape);
  }
  // A lease whose `pod` is present but cannot be read is as unreadable as a lease that cannot be parsed:
  // reading it as "no pod" would remove what a living pod writes (TE LOW-1).
  if (lease.kind === "ok" && lease.record.podUnreadable === true) {
    return { local: false, reason: "pod-unreadable" };
  }
  return lease.kind === "ok" && lease.record.pod !== undefined
    ? { local: false, reason: "session-in-pod" }
    : { local: true };
}

/**
 * A-69 / A-67 (C1.1 "On any other host"): a lease acpx cannot parse is read by the SHAPE the lease store gives it
 * (`UnparsableShape`, the one `removeUnparsableLease` reads — never re-parsed here). A JSON object with NO `pod`
 * key is a control-pod writer's lease (only an agent pod writes `pod`): local. One whose readable `pod` names a
 * pod is that pod's: not local until C3.3 proves it gone and the lease is removed. A `pod` that names no pod, and
 * every body that is not a JSON object (kind (1)), stay `pod-unreadable`.
 */
function unparsableScope(shape: UnparsableShape): ProofScope {
  if (shape.kind === "schema" && shape.pod.kind === "absent") {
    return { local: true };
  }
  return shape.kind === "schema" && shape.pod.kind === "pod"
    ? { local: false, reason: "session-in-pod" }
    : { local: false, reason: "pod-unreadable" };
}
