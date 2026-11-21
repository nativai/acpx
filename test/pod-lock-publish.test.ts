import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { writeSessionRecord } from "../src/session/persistence.js";
import {
  LockLostError,
  setPodLockDepsForTests,
} from "../src/session/persistence/identity-file-lock.js";
import { parseSessionRecord } from "../src/session/persistence/parse.js";
import {
  isRecordLockLost,
  isRecordLockTimeout,
  RECORD_LOCK_LOST_ATTEMPTS,
  updateRecordFile,
  withRecordFileLock,
} from "../src/session/persistence/record-file-lock.js";
import { SpawnLedger, type DiskRecord } from "../src/spawn-ledger.js";
import { makeSessionRecord, sessionFilePath, withTempHome } from "./runtime-test-helpers.js";

// C3.2 A-4 "the holder checks before it publishes" (brick 8d85cb47), through the record-write entry
// agreed with atrium lane T (EXPORT-lock-module.md v2) and the spawn ledger's own rename.

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acpx-publish-"));
}

/**
 * What a break plus a new holder leaves at the lock path: someone else's lock. Here a provably DEAD
 * local holder (the record lock's legacy body: this host and boot, an exited pid), so the next
 * attempt can break it at once.
 */
function stealLock(recordFile: string): void {
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  fs.writeFileSync(
    `${recordFile}.lock`,
    JSON.stringify({ pid: dead, start: null, host: os.hostname(), boot }),
  );
}

function leftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
}

test.beforeEach(() => {
  // Deterministic: a control pod without identity (today's rules for the stolen no-pod lock).
  setPodLockDepsForTests({
    ownPod: () => undefined,
    lockPod: () => undefined,
    place: () => "control",
  });
});
test.afterEach(() => setPodLockDepsForTests(undefined));

test("updateRecordFile: the change gets the bytes read INSIDE the lock and its bytes are published; lock released", async () => {
  const dir = tmpDir();
  const record = path.join(dir, "r.json");
  fs.writeFileSync(record, "old\n");
  let sawLock = false;
  const result = await updateRecordFile(record, (current) => {
    sawLock = fs.existsSync(`${record}.lock`);
    return `${current?.trim()}+new\n`;
  });
  assert.deepEqual(result, { written: true });
  assert.equal(sawLock, true, "the change ran under the record lock");
  assert.equal(fs.readFileSync(record, "utf8"), "old+new\n");
  assert.equal((fs.statSync(record).mode & 0o777).toString(8), "600");
  assert.deepEqual(leftovers(dir), []);
});

test("updateRecordFile: `undefined` writes nothing and releases cleanly; a missing record reads as undefined", async () => {
  const dir = tmpDir();
  const record = path.join(dir, "r.json");
  let seen: string | undefined = "unset";
  assert.deepEqual(
    await updateRecordFile(record, (current) => {
      seen = current;
      return undefined;
    }),
    { written: false },
  );
  assert.equal(seen, undefined);
  assert.equal(fs.existsSync(record), false);
  assert.deepEqual(leftovers(dir), []);
});

test("NEVER: a holder whose lock was broken refuses to publish — and starts again (here it then succeeds)", async () => {
  const dir = tmpDir();
  const record = path.join(dir, "r.json");
  fs.writeFileSync(record, "v0\n");
  const seen: (string | undefined)[] = [];
  const result = await updateRecordFile(record, (current) => {
    seen.push(current);
    if (seen.length === 1) {
      stealLock(record); // broken between the read and the rename
      return "LOST WRITE\n";
    }
    return "v1\n";
  });
  assert.deepEqual(result, { written: true });
  assert.deepEqual(seen, ["v0\n", "v0\n"], "the second attempt re-read the record");
  assert.equal(fs.readFileSync(record, "utf8"), "v1\n", "the lost attempt published nothing");
  assert.deepEqual(leftovers(dir), []);
});

test(`NEVER: a lock broken at every attempt → record-lock-lost after ${RECORD_LOCK_LOST_ATTEMPTS} attempts, the record unchanged`, async () => {
  const dir = tmpDir();
  const record = path.join(dir, "r.json");
  fs.writeFileSync(record, "v0\n");
  let attempts = 0;
  const error = await updateRecordFile(record, () => {
    attempts += 1;
    stealLock(record);
    return "never\n";
  }).then(
    () => assert.fail("must not publish"),
    (caught: unknown) => caught,
  );
  assert.equal(isRecordLockLost(error), true);
  assert.equal(isRecordLockTimeout(error), false);
  assert.equal(attempts, RECORD_LOCK_LOST_ATTEMPTS);
  assert.equal(fs.readFileSync(record, "utf8"), "v0\n");
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0);
});

test("withRecordFileLock hands the holder `assertHeld`: passes while held, throws lock-lost once stolen", async () => {
  const record = path.join(tmpDir(), "r.json");
  await withRecordFileLock(record, async (lock) => {
    await lock.assertHeld();
    lock.assertHeldSync();
    stealLock(record);
    await assert.rejects(lock.assertHeld(), LockLostError);
    assert.throws(() => lock.assertHeldSync(), LockLostError);
  });
});

test("spawn ledger: `beforePublish` runs before the record's rename — a throw publishes nothing", () => {
  const home = tmpDir();
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const ledger = new SpawnLedger();
    try {
      const id = randomUUID();
      const record = { acpx_record_id: id, metadata: {} } as unknown as DiskRecord;
      const file = ledger.recordPath(id);
      assert.throws(
        () =>
          ledger.saveRecord(record, {
            beforePublish: () => {
              throw new LockLostError(`${file}.lock`, "");
            },
          }),
        LockLostError,
      );
      assert.equal(fs.existsSync(file), false, "nothing published");
      assert.deepEqual(
        fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp")),
        [],
      );
      let checked = false;
      ledger.saveRecord(record, { beforePublish: () => void (checked = true) });
      assert.equal(checked, true);
      assert.equal(fs.existsSync(file), true, "positive control: published when the check passes");
    } finally {
      ledger.close();
    }
  } finally {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
  }
});

/**
 * Steals the record's lock right after the writer wrote the RECORD's temp file (`<record>.<pid>.….tmp`)
 * — `times` times. ⚠️ MATCH THE RECORD'S PREFIX EXACTLY: the lock's own temp file is
 * `<record>.lock.<pid>.….tmp`, and the first version of this hook matched it too, so its one steal
 * landed before the lock was even taken and the "retry" test passed without exercising the check.
 */
function stealAfterTempWrite(recordFile: string, times: number) {
  const realWriteFile = fsp.writeFile.bind(fsp);
  const prefix = `${recordFile}.${process.pid}.`;
  let stolen = 0;
  const writeFile = mock.method(fsp, "writeFile", async (file: unknown, ...rest: unknown[]) => {
    const result = await (realWriteFile as (...args: unknown[]) => Promise<void>)(file, ...rest);
    if (
      typeof file === "string" &&
      file.startsWith(prefix) &&
      file.endsWith(".tmp") &&
      stolen < times
    ) {
      assert.ok(
        fs.existsSync(`${recordFile}.lock`),
        "the steal happens while the writer holds the lock",
      );
      stolen += 1;
      stealLock(recordFile);
    }
    return result;
  });
  return { stolen: () => stolen, restore: () => writeFile.mock.restore() };
}

test("acpx's own record writer: a lock stolen before the rename publishes nothing, and the write starts again", async () => {
  await withTempHome("acpx-publish-", async (home) => {
    const id = "publish-retry";
    const file = sessionFilePath(home, id);
    const record = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-acp`,
      agentCommand: "agent",
      cwd: home,
      lastSeq: 7,
    });
    const steal = stealAfterTempWrite(file, 1);
    try {
      await writeSessionRecord(record);
    } finally {
      steal.restore();
    }
    assert.equal(steal.stolen(), 1, "the lock was stolen between temp write and rename");
    assert.equal((JSON.parse(fs.readFileSync(file, "utf8")) as { last_seq: number }).last_seq, 7);
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp")),
      [],
    );
  });
});

test(`NEVER: acpx's own record writer, its lock stolen at every attempt → record-lock-lost, the record on disk unchanged`, async () => {
  await withTempHome("acpx-publish-", async (home) => {
    const id = "publish-lost";
    const file = sessionFilePath(home, id);
    const base = { acpxRecordId: id, acpSessionId: `${id}-acp`, agentCommand: "agent", cwd: home };
    await writeSessionRecord(makeSessionRecord({ ...base, lastSeq: 1 }));
    const steal = stealAfterTempWrite(file, Number.POSITIVE_INFINITY);
    let error: unknown;
    try {
      await writeSessionRecord(makeSessionRecord({ ...base, lastSeq: 7 }));
    } catch (caught) {
      error = caught;
    } finally {
      steal.restore();
    }
    assert.equal(isRecordLockLost(error), true, String(error));
    assert.equal(steal.stolen(), RECORD_LOCK_LOST_ATTEMPTS);
    assert.equal((JSON.parse(fs.readFileSync(file, "utf8")) as { last_seq: number }).last_seq, 1);
  });
});

// T1 (test-engineer, 175aa1cc): acpx's own writer on a SPAWN-OWNED record, where the rename happens
// inside the spawn ledger (`ledger.saveRecordAsync(raw, { beforePublish: lock.assertHeldSync })`).
// Ported from the test-engineer's probe te-ledger-publish.mjs. The steal lands right after the LEDGER
// opened its temp file (`fs.openSync(<record>.<pid>.….tmp, "wx")`), i.e. while the writer holds the
// record lock and before the ledger's check + rename. Drop `beforePublish` from that call and the
// "every attempt" half goes red (the stolen-lock write would land).

test("T1: acpx's writer on a SPAWN-OWNED record — a lock stolen before the ledger's rename retries; stolen every time → record-lock-lost, disk unchanged", async () => {
  await withTempHome("acpx-ledger-publish-", async (home) => {
    const recordId = "11111111-1111-4111-8111-111111111111";
    fs.mkdirSync(path.join(home, ".acpx", "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".acpx", "instance.json"),
      JSON.stringify({ instance_id: "i-111111111111", home }),
    );
    const ledger = new SpawnLedger();
    ledger.bindIdentity({ instance_id: "i-111111111111" });
    const attempt = ledger.reserveSpawn({
      run_id: "run-1",
      fence: 1,
      trigger_id: "t-1",
      parent_brick_id: "22222222-2222-4222-8222-222222222222",
      child_brick_id: "33333333-3333-4333-8333-333333333333",
      target_record_id: recordId,
    });
    const file = ledger.recordPath(recordId);
    const disk = (seq: number): DiskRecord =>
      ({
        schema: "acpx.session.v1",
        kind: "session",
        acpx_record_id: recordId,
        acp_session_id: "adapter-independent-id",
        agent_command: "node /opt/codex-acp/dist/index.js",
        agent_name: "codex",
        cwd: home,
        created_at: new Date().toISOString(),
        last_used_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_seq: seq,
        messages: [],
        metadata: { spawn_key: attempt.idempotency_key, spawn_state: "pending" },
        closed: false,
      }) as unknown as DiskRecord;
    // Seed through the ledger, so the writer's metadata baseline equals disk and it takes the
    // ledger branch (a baseline mismatch would drop spawn_key).
    ledger.recordSpawnChild("run-1", 1, process.pid);
    ledger.saveRecord(disk(0));
    ledger.close();
    const onDiskSeq = () =>
      (JSON.parse(fs.readFileSync(file, "utf8")) as { last_seq: number }).last_seq;

    const realOpenSync = fs.openSync.bind(fs);
    let steals = 0;
    let maxSteals = 0;
    const heldWhenStolen: boolean[] = [];
    const openSync = mock.method(
      fs,
      "openSync",
      (target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const fd = realOpenSync(target, flags, mode);
        if (
          typeof target === "string" &&
          target.startsWith(`${file}.${process.pid}.`) &&
          target.endsWith(".tmp") &&
          flags === "wx" &&
          steals < maxSteals
        ) {
          heldWhenStolen.push(fs.existsSync(`${file}.lock`));
          steals += 1;
          stealLock(file);
        }
        return fd;
      },
    );
    const write = async (seq: number, times: number) => {
      steals = 0;
      maxSteals = times;
      heldWhenStolen.length = 0;
      try {
        await writeSessionRecord(parseSessionRecord(disk(seq))!);
        return undefined;
      } catch (error) {
        return error;
      }
    };
    try {
      assert.equal(await write(1, 0), undefined, "positive control: no steal");
      assert.equal(onDiskSeq(), 1);
      assert.equal(steals, 0);

      assert.equal(await write(2, 1), undefined, "stolen once: the write starts again and lands");
      assert.equal(steals, 1, "the steal happened on the ledger branch");
      assert.deepEqual(heldWhenStolen, [true]);
      assert.equal(onDiskSeq(), 2);

      const lost = await write(3, Number.POSITIVE_INFINITY);
      assert.equal(isRecordLockLost(lost), true, String(lost));
      assert.equal(steals, RECORD_LOCK_LOST_ATTEMPTS);
      assert.equal(onDiskSeq(), 2, "nothing published");
      assert.deepEqual(
        fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")),
        [],
      );
    } finally {
      openSync.mock.restore();
    }
  });
});
