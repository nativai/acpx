import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tryAcquireQueueOwnerLease } from "../src/cli/queue/lease-store.js";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import { withEnv, worldEnv, type PodWorld } from "./pod-owner-helpers.js";

export const RECORD_ID = "rec-proof-scope-1";
export const ELEVEN_MIN = 11 * 60_000;
export const CWD = "/work/proof";

export function writeLeaseGarbage(world: PodWorld, recordId: string): string {
  const file = queueLockFilePath(recordId, world.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not a lease");
  return file;
}

/** A lease that names an agent pod, written the way an owner there writes it. */
export async function writePodLease(world: PodWorld, recordId: string): Promise<void> {
  await withEnv(worldEnv(world, { place: "agent-pod", podMode: true }), async () => {
    assert(await tryAcquireQueueOwnerLease(recordId));
  });
  fs.rmSync(path.join(world.home, ".nv-agent"));
}
