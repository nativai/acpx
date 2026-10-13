import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  captureRecordPidIdentity,
  isRecordedPidPossiblyAlive,
  type RecordPidIdentity,
} from "../src/process-identity.js";
import { evaluateLiveness } from "../src/session/archive/liveness.js";

// brick ae547131 §5.3 — T21. A record whose `pid_identity` names a process in ANOTHER pid namespace
// is KEPT by every keep decision (archive gate, export's "active", reconnect), even though its pid
// number reads ESRCH here: `unknown` counts as alive — the conservative direction for a keep. The
// ⊗ shape: d9ab5c0d probes the bare pid, reads ESRCH, and archives a session a foreign adapter is
// still serving.

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
  return Number(child.stdout.toString());
}

function foreignIdentityFor(pid: number): RecordPidIdentity {
  const own = captureRecordPidIdentity(process.pid);
  assert.ok(own);
  return { ...own, pid, pid_namespace: "pid:[1]" };
}

test("T21 a foreign pid_identity keeps the record: archive gate, export/reconnect liveness", async (t) => {
  if (process.platform !== "linux") {
    t.skip("linux identity");
    return;
  }
  const pid = deadPid();
  const foreign = foreignIdentityFor(pid);

  // the shared keep predicate (export's isSessionActive and reconnect use it)
  assert.equal(isRecordedPidPossiblyAlive(pid, foreign), true, "a foreign adapter read as gone");
  // positive control: the same dead pid in OUR scope is gone; no identity ⇒ the bare probe (gone)
  assert.equal(
    isRecordedPidPossiblyAlive(pid, {
      ...foreign,
      pid_namespace: captureRecordPidIdentity(process.pid)!.pid_namespace,
    }),
    false,
  );
  assert.equal(isRecordedPidPossiblyAlive(pid, undefined), false);

  // the archive gate
  const options = { wakeups: { status: "absent" as const } };
  const kept = await evaluateLiveness(
    "rec-foreign",
    "rec-foreign",
    [],
    pid,
    options,
    true,
    foreign,
  );
  assert.deepEqual(kept, { live: true, signal: "pid-alive" });
  const dropped = await evaluateLiveness(
    "rec-local",
    "rec-local",
    [],
    pid,
    options,
    true,
    undefined,
  );
  assert.equal(dropped.live, false, "control: a dead identity-less pid is not live");
});
