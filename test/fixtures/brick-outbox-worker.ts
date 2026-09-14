import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { BrickOutbox, writeRecordAtomic, type DiskRecord } from "../../src/brick-outbox.js";
import { parseSessionRecord } from "../../src/session/persistence/parse.js";

assert.ok(os.homedir().startsWith("/workspace/bricksdb-b14-selftest/"));
const outbox = new BrickOutbox();
fs.writeFileSync(
  `${os.homedir()}/.acpx/instance.json`,
  JSON.stringify({ instance_id: "i-111111111111", home: os.homedir() }),
);
process.env.ACPX_UI_BASE_URL = "https://example.invalid";
const id = "11111111-1111-4111-8111-111111111111";
const brick = "22222222-2222-4222-8222-222222222222";
const record: DiskRecord = {
  schema: "acpx.session.v1",
  kind: "session",
  acpx_record_id: id,
  acp_session_id: "adapter-independent-id",
  agent_command: "node /opt/codex-acp/dist/index.js",
  agent_name: "codex",
  cwd: os.homedir(),
  created_at: new Date().toISOString(),
  last_used_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_seq: 0,
  messages: [],
  metadata: { brick },
  closed: false,
};
const identity = {
  instance_id: "i-111111111111",
  box: "fixture",
  session_url: `https://example.invalid/?session=${id}`,
  agent_type: "codex",
};
let acted = 0;
const scenario = process.argv[2];
try {
  assert.ok(parseSessionRecord(record), "positive real parser control");
  assert.equal(
    parseSessionRecord({ ...record, schema: "invalid" }),
    null,
    "negative parser control",
  );
  acted++;
  if (scenario === "drain-exit") {
    outbox.prepareProjection(id, record, identity);
    outbox.setDrain("owned-exit");
    const observer = new DatabaseSync(outbox.dbPath);
    const snapshot = () =>
      JSON.stringify(
        observer
          .prepare(
            "SELECT key,value FROM meta WHERE key IN ('drain','admission_frontier') ORDER BY key",
          )
          .all(),
      );
    const before = snapshot();
    assert.equal(JSON.parse(before).length, 2, "both durable marker values are observed");
    let called = false;
    assert.throws(
      () =>
        outbox.exitDrainWithMutationGate("wrong-owner", () => {
          called = true;
        }),
      /expected cutover/,
    );
    assert.equal(called, false);
    assert.equal(snapshot(), before);
    assert.throws(
      () =>
        outbox.exitDrainWithMutationGate("owned-exit", () =>
          outbox.withUserMutationGate(() => {
            assert.equal(outbox.inventory().drain, null);
            assert.equal(
              snapshot(),
              before,
              "independent reader must not observe the uncommitted marker removal",
            );
            assert.throws(() => new BrickOutbox(), /outbox-busy/);
            throw new Error("reopen-failed-control");
          }),
        ),
      /reopen-failed-control/,
    );
    assert.equal(snapshot(), before);
    assert.throws(
      () => outbox.exitDrainWithMutationGate("owned-exit", async () => 1),
      /synchronous/,
    );
    assert.equal(snapshot(), before);
    const thenable = {
      // eslint-disable-next-line unicorn/no-thenable -- Adversarial control for B8's synchronous-only drain-exit callback contract.
      then() {},
    };
    assert.throws(
      () => outbox.exitDrainWithMutationGate("owned-exit", () => thenable),
      /synchronous/,
    );
    assert.equal(snapshot(), before);
    const result = outbox.exitDrainWithMutationGate("owned-exit", () =>
      outbox.withUserMutationGate(() =>
        outbox.withUserMutationGate(() => {
          assert.throws(() => new BrickOutbox(), /outbox-busy/);
          return 42;
        }),
      ),
    );
    assert.equal(result, 42);
    assert.equal(outbox.inventory().drain, null);
    assert.deepEqual(outbox.inventory().admission_frontier, []);
    assert.equal(snapshot(), "[]");
    assert.equal(
      outbox.withUserMutationGate(() => 43),
      43,
    );
    observer.close();
    acted++;
    console.log(`ACTED=${acted}`);
    process.exit(0);
  }
  if (scenario === "gate") {
    assert.equal(
      outbox.withUserMutationGate(() => outbox.withUserMutationGate(() => 42)),
      42,
    );
    outbox.withUserMutationGate(() => {
      assert.throws(() => new BrickOutbox(), /outbox-busy/);
    });
    assert.throws(() => outbox.withUserMutationGate(async () => 1), /synchronous/);
    outbox.setDrain("gate-refusal");
    let invoked = false;
    assert.throws(
      () =>
        outbox.withUserMutationGate(() => {
          invoked = true;
        }),
      /maintenance/,
    );
    assert.equal(invoked, false);
    acted++;
    console.log(`ACTED=${acted}`);
    process.exit(0);
  }
  if (scenario === "frontier") {
    for (let revision = 1; revision <= 3; revision++) {
      const intent = outbox.prepareProjection(id, record, identity)!;
      outbox.applyProjection(intent.id);
      outbox.acknowledge(intent.id);
    }
    const abandoned = outbox.prepareProjection(id, record, identity)!;
    outbox.setDrain("frontier-cut");
    assert.throws(() => outbox.applyProjection(abandoned.id), /maintenance/);
    const inventory = outbox.inventory();
    assert.equal(inventory.admission_frontier[0]?.revision, 4);
    assert.equal(inventory.high_water[0]?.revision, 3);
    assert.equal(inventory.dispositioned_prefix[0]?.revision, 4);
    assert.equal(inventory.outbox_depth, 0);
    acted++;
    console.log(`ACTED=${acted}`);
    process.exit(0);
  }
  if (["projection", "drain", "rename-cut", "superseded"].includes(scenario ?? "")) {
    const first = outbox.prepareProjection(id, record, identity)!;
    assert.equal(first.state, "prepared");
    assert.equal(fs.existsSync(outbox.recordPath(id)), false);
    if (scenario === "drain") {
      outbox.setDrain("cut-1");
      assert.throws(() => outbox.applyProjection(first.id), /maintenance/);
      assert.equal(outbox.getIntent(first.id)?.state, "abandoned");
      assert.equal(outbox.inventory().outbox_depth, 0);
      assert.equal(outbox.inventory().admission_frontier[0]?.revision, 1);
      assert.throws(() => outbox.prepareProjection(id, record, identity), /maintenance/);
      outbox.setDrain(null);
      const next = outbox.prepareProjection(id, record, identity)!;
      assert.equal(next.revision, 2);
      outbox.applyProjection(next.id);
    } else if (scenario === "rename-cut") {
      writeRecordAtomic(outbox.recordPath(id), {
        ...record,
        metadata: { brick, brick_projection_revision: "0:1" },
      });
      outbox.setDrain("cut-after-rename");
      outbox.applyProjection(first.id);
      assert.equal(outbox.getIntent(first.id)?.state, "applied");
      assert.equal(outbox.inventory().outbox_depth, 1);
    } else if (scenario === "superseded") {
      const second = outbox.prepareProjection(id, record, identity)!;
      outbox.applyProjection(second.id);
      outbox.applyProjection(first.id);
      assert.equal(outbox.getIntent(first.id)?.state, "superseded");
      assert.equal(outbox.readRecord(id)?.metadata?.brick_projection_revision, "0:2");
    } else {
      outbox.applyProjection(first.id);
      assert.ok(parseSessionRecord(outbox.readRecord(id)));
      outbox.acknowledge(first.id);
      outbox.acknowledge(first.id);
      assert.equal(outbox.inventory().outbox_depth, 0);
      assert.equal(outbox.inventory().projection_heads, 1);
      assert.equal(outbox.inventory().high_water[0]?.revision, 1);
    }
    acted++;
  } else {
    const reservation = outbox.reserveSpawn({
      run_id: "run-1",
      fence: 1,
      trigger_id: "trigger-1",
      parent_brick_id: brick,
      child_brick_id: brick,
      target_record_id: id,
    });
    outbox.recordSpawnChild("run-1", 1, process.pid);
    assert.equal(outbox.spawnChildLiveness("run-1", 1), "alive");
    const pending: DiskRecord = {
      ...record,
      metadata: { brick, spawn_key: reservation.idempotency_key, spawn_state: "pending" },
    };
    outbox.writeOwnedRecord(id, pending, () => pending);
    assert.equal(outbox.prepareProjection(id, pending, identity), undefined);
    if (scenario === "lookup-error") {
      const intent = outbox.prepareProjection(
        id,
        { ...pending, metadata: { ...pending.metadata, spawn_state: "published" } },
        identity,
        { run_id: "run-1", fence: 1, next: "published" },
      )!;
      const original = outbox.getSpawnAttempt.bind(outbox);
      outbox.getSpawnAttempt = () => {
        throw Object.assign(new Error("fixture SQLITE_IOERR"), { code: "SQLITE_IOERR" });
      };
      assert.throws(() => outbox.applyProjection(intent.id), /SQLITE_IOERR/);
      assert.equal(outbox.getIntent(intent.id)?.state, "prepared");
      assert.equal(outbox.readRecord(id)?.metadata?.spawn_state, "pending");
      outbox.getSpawnAttempt = original;
      outbox.applyProjection(intent.id);
      assert.equal(outbox.getIntent(intent.id)?.state, "applied");
      assert.equal(outbox.readRecord(id)?.metadata?.spawn_state, "published");
    } else if (scenario === "ownership") {
      outbox.transitionSpawn("run-1", 1, "revoked");
      assert.throws(() => outbox.writeOwnedRecord(id, pending, () => pending), /refused/);
      assert.throws(() => outbox.transitionSpawn("run-1", 1, "published"), {
        code: "invalid-spawn-transition",
      });
      assert.throws(() => outbox.transitionSpawn("run-1", 1, "cancelled"), /forbidden/);
      outbox.transitionSpawn("run-1", 1, "cancelled", { child_gone: true });
      assert.throws(() => outbox.transitionSpawn("run-1", 1, "published"), {
        code: "invalid-spawn-transition",
      });
    } else {
      outbox.transitionSpawn("run-1", 1, "published");
      outbox.transitionSpawn("run-1", 1, "adopted");
      assert.equal(outbox.getSpawnRun("run-1")?.ack_confirmed_at, null);
      assert.equal(outbox.inventory().runs.adopted_without_ack_confirmation, 1);
      assert.throws(
        () => outbox.transitionSpawn("run-1", 1, "revoked", { higher_fence: 2 }),
        /forbidden/,
      );
      if (scenario === "receipt-conflict") {
        outbox.confirmSpawnReceipt("run-1", { status: "spawned", session_id: brick });
        assert.equal(outbox.getSpawnAttempt("run-1", 1)?.state, "adopted");
        assert.equal(outbox.readRecord(id)?.metadata?.spawn_state, "orphaned");
        assert.ok(outbox.getSpawnRun("run-1")?.receipt_conflict);
      } else if (scenario === "initial-prompt") {
        outbox.queueInitialPrompt("run-1", { text: "real queued content", sessionId: id });
        const prompts = outbox.pendingInitialPrompts();
        assert.equal(prompts.length, 1);
        let submitted = 0;
        await outbox.releaseInitialPrompt("run-1", async (_payload, deliveryId) => {
          assert.equal(deliveryId, prompts[0]?.delivery_id);
          submitted++;
        });
        await outbox.releaseInitialPrompt("run-1", async () => {
          submitted++;
        });
        assert.equal(submitted, 1);
        assert.equal(outbox.pendingInitialPrompts().length, 0);
      } else {
        outbox.confirmSpawnReceipt("run-1", { status: "spawned", session_id: id });
        assert.equal(outbox.inventory().runs.adopted_without_ack_confirmation, 0);
      }
    }
    acted++;
  }
} finally {
  outbox.close();
}
if (acted === 0) {
  console.error("EXAMINED NOTHING");
  process.exit(2);
}
console.log(`ACTED=${acted} scenario=${scenario}`);
