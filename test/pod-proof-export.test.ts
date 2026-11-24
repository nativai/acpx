import assert from "node:assert/strict";
import test from "node:test";
import { isSessionActive } from "../src/session/export.js";
import type { SessionRecord } from "../src/types.js";
import { makeWorld, withEnv, worldEnv } from "./pod-owner-helpers.js";
import { RECORD_ID, writePodLease } from "./pod-proof-helpers.js";

// Block A11 (brick e867b917), A-67: `acpx sessions export` refuses an active session; a session whose lease
// names a pod counts as active here, in pod mode and out of it.

test("A11 export: a session whose lease names a pod counts as active; without one a pid-less record does not", async () => {
  const world = makeWorld("ex");
  await writePodLease(world, RECORD_ID);
  const record = (id: string) => ({ acpxRecordId: id, closed: false }) as unknown as SessionRecord;
  for (const podMode of [true, false]) {
    await withEnv(worldEnv(world, { podMode }), async () => {
      assert.equal(await isSessionActive(record(RECORD_ID)), true, `podMode=${podMode}`);
      assert.equal(await isSessionActive(record("rec-no-lease")), false);
    });
  }
});
