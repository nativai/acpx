import { readQueueOwnerLeaseFile } from "../cli/queue/lease-store.js";
import { PodForeignWriteError } from "./foreign-write-guard.js";
import { lockHostPlace, lockPodIdentity } from "./identity.js";
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
 *        existing A-8 refusal, `pod_foreign_write file=session`. The pod only READS the lease file; it never asks
 *        the API server (C3.2). An unreadable lease, or a pod that cannot name itself, is not judgeable: refused.
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
  if (lockHostPlace(env) === "agent-pod" && !(await leaseIsAbsentOrOwn(sessionId, env))) {
    throw new PodForeignWriteError("session");
  }
}

/** No lease, or one this pod wrote. Anything else — another pod, no `pod`, unreadable — is not this pod's to write beside. */
async function leaseIsAbsentOrOwn(sessionId: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const lease = await readQueueOwnerLeaseFile(sessionId);
  if (lease.kind === "missing") {
    return true;
  }
  const own = lockPodIdentity(env);
  return own !== undefined && lease.kind === "ok" && lease.record.pod?.uid === own.uid;
}
