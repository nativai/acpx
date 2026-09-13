// PREPARED INSTRUMENT — run against an explicit built producer module and isolated HOME.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DiskRecord, SpawnAttempt } from "../../src/brick-outbox.js";

assert.ok(os.homedir().startsWith("/workspace/bricksdb-b14-selftest/"));
const modulePath = process.env.B14_OUTBOX_MODULE;
if (!modulePath || !path.isAbsolute(modulePath)) {
  process.stderr.write("EXAMINED NOTHING\n");
  process.exit(2);
}
const { BrickOutbox } = (await import(
  pathToFileURL(modulePath).href
)) as typeof import("../../src/brick-outbox.js");
const outbox = new BrickOutbox();
fs.writeFileSync(
  path.join(os.homedir(), ".acpx", "instance.json"),
  JSON.stringify({ instance_id: "i-111111111111", home: os.homedir() }),
);
outbox.bindIdentity({
  instance_id: "i-111111111111",
  box: "fixture",
  public_base_url: "https://example.invalid",
});
const brick = "44444444-4444-4444-8444-444444444444";
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const control = "33333333-3333-4333-8333-333333333333";
function reserve(run: string, fence: number, target: string): SpawnAttempt {
  return outbox.reserveSpawn({
    run_id: run,
    fence,
    trigger_id: "trigger",
    parent_brick_id: brick,
    child_brick_id: brick,
    target_record_id: target,
  });
}
function adopt(attempt: SpawnAttempt): void {
  outbox.recordSpawnChild(attempt.run_id, attempt.fence, process.pid);
  const at = new Date().toISOString();
  const raw: DiskRecord = {
    schema: "acpx.session.v1",
    kind: "session",
    acpx_record_id: attempt.target_record_id,
    acp_session_id: `adapter-${attempt.target_record_id}`,
    agent_command: "codex",
    agent_name: "codex",
    cwd: os.homedir(),
    created_at: at,
    updated_at: at,
    last_used_at: at,
    last_seq: 0,
    messages: [],
    closed: false,
    metadata: { brick, spawn_key: attempt.idempotency_key, spawn_state: "pending" },
  };
  outbox.writeOwnedRecord(attempt.target_record_id, raw, () => raw);
  outbox.transitionSpawn(attempt.run_id, attempt.fence, "published");
  outbox.transitionSpawn(attempt.run_id, attempt.fence, "adopted");
}
let controlCalls = 0,
  subjectCalls = 0;
try {
  const ordinary = reserve("ordinary", 1, control);
  outbox.queueInitialPrompt("ordinary", { sessionId: control, text: "content" });
  adopt(ordinary);
  await outbox.releaseInitialPrompt("ordinary", async (payload) => {
    controlCalls++;
    assert.equal(payload.sessionId, control);
  });
  assert.equal(controlCalls, 1);
  reserve("replacement", 1, first);
  const deliveryId = outbox.queueInitialPrompt("replacement", {
    sessionId: first,
    text: "content",
  });
  const replacement = reserve("replacement", 2, second);
  assert.equal(
    outbox.queueInitialPrompt("replacement", { sessionId: second, text: "content" }),
    deliveryId,
  );
  adopt(replacement);
  await outbox.releaseInitialPrompt("replacement", async (payload, actualDeliveryId) => {
    subjectCalls++;
    process.stdout.write(
      `${JSON.stringify({ actors: 1, controlCalls, subjectCalls, expectedTarget: second, actualTarget: payload.sessionId })}\n`,
    );
    assert.equal(actualDeliveryId, deliveryId);
    assert.equal(
      payload.sessionId,
      second,
      "release must bind the adopted winner, not the first attempted target",
    );
  });
  assert.throws(
    () => outbox.queueInitialPrompt("replacement", { sessionId: second, text: "changed content" }),
    /different initial prompt content/,
  );
} catch (error) {
  console.error(error);
  process.exitCode = subjectCalls === 0 ? 2 : 1;
  if (subjectCalls === 0) {process.stderr.write("EXAMINED NOTHING\n");}
} finally {
  outbox.close();
}
