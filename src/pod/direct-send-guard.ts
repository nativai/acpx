import { readQueueOwnerLeaseFile } from "../cli/queue/lease-store.js";
import { lockHostPlace, lockPodIdentity } from "./identity.js";
import { OwnerOutsidePodError } from "./owner-pod.js";
import { BridgeOnControlPodError, podModeVerdictNow, readPodFileWithWitness } from "./placement.js";

/**
 * C1.2 "A flow's direct send" (brick 59070d68, architect #19): `sendSessionDirect` runs a TURN — owner work on its
 * target session — so in pod mode it may run only in an agent pod, and only on a session whose lease is absent or
 * held by that pod. It refuses BEFORE it writes anything (no record write, no stream writer, no marker, no lock):
 *
 *   (i)  a control-role host in pod mode → the EXISTING bridge refusal (`bridge_on_control_pod`). The turn would be
 *        refused at the adapter spawn anyway, but only AFTER the record write, the turn writer's lock and the
 *        `acpx/turn active` marker; a one-shot's bridge never runs on the control pod, so this is the path nobody
 *        classified — `FlowRunner` of the public `acpx/flows` export reaches it with no CLI placement step.
 *   (ii) an agent pod whose target session's lease is held elsewhere (another pod, or — without `pod` — a home
 *        owner on the control pod: a holder this pod cannot judge, C3.2, and may not write beside, C10) → the
 *        existing owner-entry refusal, `owner_outside_pod session=<record id>` (exit 2; its next line names the
 *        holder). The pod only READS the lease file; it never asks the API server (C3.2). An unreadable lease, or a
 *        pod that cannot name itself, is not judgeable: refused.
 *
 * Anywhere else — pod mode off, a workbench, a rig — nothing changes (rows 60.2 / 60.4 run there).
 * ⚠️ (i) is `assertBridgeMayStartHere`'s predicate taken NOW instead of memoised, so a test can vary the
 * environment; in a real process the environment never changes, so the two agree. Held by
 * `test/pod-5907-flow-direct-send.test.ts`.
 */
export async function refuseFlowDirectSendOutsideItsPod(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (podModeVerdictNow(env).mode !== "off" && readPodFileWithWitness(env).kind === "absent") {
    throw new BridgeOnControlPodError("adapter");
  }
  if (lockHostPlace(env) !== "agent-pod") {
    return;
  }
  const heldBy = await leaseHeldElsewhere(sessionId, env);
  if (heldBy !== undefined) {
    throw new OwnerOutsidePodError(
      sessionId,
      `${heldBy} A flow's direct send runs a turn only in the pod that holds the session's lease; nothing was written.`,
    );
  }
}

/**
 * Undefined: no lease, or the lease of THIS pod. Else the sentence that names the holder: another pod, a home owner
 * (a lease without `pod`), a `pod` key that names no pod, or a lease that cannot be read. Never an API call (C3.2).
 */
async function leaseHeldElsewhere(
  sessionId: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const lease = await readQueueOwnerLeaseFile(sessionId);
  if (lease.kind === "missing") {
    return undefined;
  }
  if (lease.kind !== "ok") {
    return "The session's lease cannot be read.";
  }
  if (lease.record.podUnreadable === true) {
    return "The session's lease names a pod that cannot be read.";
  }
  const holder = lease.record.pod;
  if (holder === undefined) {
    return "The session's lease is held by a home owner on the control pod (a lease without a pod).";
  }
  return holder.uid === lockPodIdentity(env)?.uid
    ? undefined
    : "The session's lease is held by another pod.";
}
