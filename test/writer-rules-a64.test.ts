// A-64 / C3.5 (ii) — a close whose owner is NOT proven stopped clears the record's adapter pid ONLY for
// an adapter it proved gone (compare-and-clear, in the scalars' own write under the record lock).
// Rows 64.2 (arms a–f, and g–h beside them) and the unit half of 64.1 of the committed test plan
// (brick 849cb075). The production half of 64.1 — a real `acpx sessions close` whose stop finds a real
// successor owner with its own adapter — is writer-rules-a64-cli.test.ts.
//
// Every arm puts ONE record on disk with an adapter pid and its identity (this process's own, so the
// identity is a real one), takes the close's FIRST read, optionally lets "another writer" move the
// record's adapter, and then runs the close's terminal write with the kill outcome under test.
// The pass/fail pairs control each other: (a)–(c) must clear, (d)–(h) must keep, and the proven-stopped
// arm must still clear.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import type { SessionCloseAdapterKill } from "../src/cli/session/session-control.js";
import {
  adapterProvedGone,
  writeTerminalCloseAfterOwnerStop,
} from "../src/cli/session/terminal-close.js";
import { captureRecordPidIdentity, type RecordPidIdentity } from "../src/process-identity.js";
import { resolveSessionRecord, writeSessionRecord } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, sessionFilePath, withTempHome } from "./runtime-test-helpers.js";

type RawAdapter = { closed?: boolean; closed_at?: string; pid?: number; pid_identity?: unknown };

async function rawAdapter(homeDir: string, id: string): Promise<RawAdapter> {
  return JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as RawAdapter;
}

function realIdentity(pid: number): RecordPidIdentity {
  const identity = captureRecordPidIdentity(pid);
  assert.ok(identity, `a process identity can be read for pid ${pid} on this platform`);
  return identity;
}

/** The same pid number, a different process incarnation (a recycled number). */
function otherIncarnation(identity: RecordPidIdentity): RecordPidIdentity {
  return identity.kind === "linux-proc"
    ? { ...identity, start_ticks: `${identity.start_ticks ?? "0"}9` }
    : { ...identity, value: `${identity.value ?? ""} (another incarnation)` };
}

async function recordWithAdapter(
  homeDir: string,
  id: string,
  pid: number,
  pidIdentity: RecordPidIdentity,
): Promise<SessionRecord> {
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand: "agent",
    cwd: homeDir,
    pid,
    pidIdentity,
  });
  await writeSessionRecord(record);
  // The GUARD: the subject really carries what the arm will or will not clear.
  const onDisk = await rawAdapter(homeDir, id);
  assert.equal(onDisk.pid, pid, "the subject has its adapter pid on disk");
  assert.deepEqual(onDisk.pid_identity, pidIdentity, "…and its identity");
  return await resolveSessionRecord(id); // the close's FIRST read
}

async function quietStderr<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return await run();
  } finally {
    process.stderr.write = original;
  }
}

const ADAPTER_PID = process.pid;

const KILLS: { arm: string; kill: SessionCloseAdapterKill; clears: boolean }[] = [
  { arm: "a signalled", kill: { signalled: true }, clears: true },
  { arm: "b gone", kill: { signalled: false, reason: "gone" }, clears: true },
  { arm: "c foreign", kill: { signalled: false, reason: "foreign" }, clears: true },
  { arm: "d no-identity", kill: { signalled: false, reason: "no-identity" }, clears: false },
  { arm: "e unverified", kill: { signalled: false, reason: "unverified" }, clears: false },
];

for (const { arm, kill, clears } of KILLS) {
  test(`64.2 (${arm}): the record still names the first read's adapter — its pid and identity are ${clears ? "cleared" : "kept"}`, async () => {
    await withTempHome("acpx-a64-kill-", async (homeDir) => {
      const id = `a64-${arm.replaceAll(" ", "-")}`;
      const identity = realIdentity(ADAPTER_PID);
      const first = await recordWithAdapter(homeDir, id, ADAPTER_PID, identity);

      const closed = await quietStderr(
        async () =>
          await writeTerminalCloseAfterOwnerStop(
            first,
            { stopped: false, reason: "survived" },
            { pid: first.pid, pidIdentity: first.pidIdentity, kill },
          ),
      );

      const after = await rawAdapter(homeDir, id);
      assert.equal(after.closed, true, "the scalars landed");
      assert.ok(after.closed_at);
      if (clears) {
        assert.equal(after.pid, undefined, "the adapter the close proved gone has no pid left");
        assert.equal(after.pid_identity, undefined, "…nor its identity");
        assert.equal(closed.record.pid, undefined, "the returned record agrees");
      } else {
        assert.equal(
          after.pid,
          ADAPTER_PID,
          "an adapter the close could not prove gone keeps its pid",
        );
        assert.deepEqual(after.pid_identity, identity, "…and its identity, byte for byte");
        assert.equal(closed.record.pid, ADAPTER_PID, "the returned record agrees");
      }
      assert.equal(adapterProvedGone(kill), clears, "the proof predicate names the same arms");
    });
  });
}

test("64.2 (f): the same pid number under ANOTHER identity (a recycled number) is kept, though the close signalled its first read's", async () => {
  await withTempHome("acpx-a64-recycled-", async (homeDir) => {
    const id = "a64-f-recycled";
    const first = await recordWithAdapter(homeDir, id, ADAPTER_PID, realIdentity(ADAPTER_PID));
    // After the close's first read another writer moves the record onto a new incarnation of the number.
    const successorIdentity = otherIncarnation(realIdentity(ADAPTER_PID));
    const later = await resolveSessionRecord(id);
    later.pidIdentity = successorIdentity;
    await writeSessionRecord(later);

    await quietStderr(
      async () =>
        await writeTerminalCloseAfterOwnerStop(
          first,
          { stopped: false, reason: "successor" },
          { pid: first.pid, pidIdentity: first.pidIdentity, kill: { signalled: true } },
        ),
    );

    const after = await rawAdapter(homeDir, id);
    assert.equal(after.closed, true);
    assert.equal(after.pid, ADAPTER_PID, "the pid is another incarnation's: it stays");
    assert.deepEqual(after.pid_identity, successorIdentity, "…with that incarnation's identity");
  });
});

test("64.2 (g) / 64.1 (record level): a successor's adapter — another pid on disk than the one the close signalled — keeps its pid and identity", async () => {
  await withTempHome("acpx-a64-successor-", async (homeDir) => {
    const id = "a64-g-successor";
    const first = await recordWithAdapter(homeDir, id, ADAPTER_PID, realIdentity(ADAPTER_PID));
    // The successor's adapter: a live process that is not the first read's (the parent of this test).
    const successorPid = process.ppid;
    const successorIdentity = realIdentity(successorPid);
    const later = await resolveSessionRecord(id);
    later.pid = successorPid;
    later.pidIdentity = successorIdentity;
    await writeSessionRecord(later);

    await quietStderr(
      async () =>
        await writeTerminalCloseAfterOwnerStop(
          first,
          { stopped: false, reason: "successor" },
          // The close signalled ITS adapter (the first read's) and it ended: signalled.
          { pid: first.pid, pidIdentity: first.pidIdentity, kill: { signalled: true } },
        ),
    );

    const after = await rawAdapter(homeDir, id);
    assert.equal(after.closed, true);
    assert.equal(after.pid, successorPid, "the successor's pid stays");
    assert.deepEqual(after.pid_identity, successorIdentity, "…with its identity, byte for byte");
  });
});

test("64.2 (h): a first read with no adapter proves nothing — a pid that appeared since stays", async () => {
  await withTempHome("acpx-a64-nopid-", async (homeDir) => {
    const id = "a64-h-no-pid";
    const bare = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-acp`,
      agentCommand: "agent",
      cwd: homeDir,
    });
    await writeSessionRecord(bare);
    const first = await resolveSessionRecord(id);
    assert.equal(first.pid, undefined, "the close's first read saw no adapter");
    const identity = realIdentity(ADAPTER_PID);
    const later = await resolveSessionRecord(id);
    later.pid = ADAPTER_PID;
    later.pidIdentity = identity;
    await writeSessionRecord(later);

    await quietStderr(
      async () =>
        await writeTerminalCloseAfterOwnerStop(
          first,
          { stopped: false, reason: "successor" },
          {
            pid: first.pid,
            pidIdentity: first.pidIdentity,
            kill: { signalled: false, reason: "no-pid" },
          },
        ),
    );

    const after = await rawAdapter(homeDir, id);
    assert.equal(
      after.pid,
      ADAPTER_PID,
      "an adapter that appeared after the first read is not the close's",
    );
    assert.deepEqual(after.pid_identity, identity);
  });
});

test("64.2 (control): an owner proven STOPPED still clears the adapter pid and identity, whatever the kill said", async () => {
  await withTempHome("acpx-a64-stopped-", async (homeDir) => {
    const id = "a64-control-stopped";
    const first = await recordWithAdapter(homeDir, id, ADAPTER_PID, realIdentity(ADAPTER_PID));

    await writeTerminalCloseAfterOwnerStop(
      first,
      { stopped: true, reason: "stopped" },
      // The weakest kill outcome there is: the stopped arm does not read it.
      {
        pid: first.pid,
        pidIdentity: first.pidIdentity,
        kill: { signalled: false, reason: "unverified" },
      },
    );

    const after = await rawAdapter(homeDir, id);
    assert.equal(after.closed, true);
    assert.equal(after.pid, undefined, "the terminal write of a stopped owner clears the pid");
    assert.equal(after.pid_identity, undefined, "…and the identity");
  });
});

test("64.2 (predicate): only signalled, gone and foreign prove an adapter gone", () => {
  const verdicts = {
    signalled: adapterProvedGone({ signalled: true }),
    gone: adapterProvedGone({ signalled: false, reason: "gone" }),
    foreign: adapterProvedGone({ signalled: false, reason: "foreign" }),
    noIdentity: adapterProvedGone({ signalled: false, reason: "no-identity" }),
    unverified: adapterProvedGone({ signalled: false, reason: "unverified" }),
    noPid: adapterProvedGone({ signalled: false, reason: "no-pid" }),
    selfClose: adapterProvedGone({ signalled: false, reason: "self-close" }),
  };
  assert.deepEqual(verdicts, {
    signalled: true,
    gone: true,
    foreign: true,
    noIdentity: false,
    unverified: false,
    noPid: false,
    selfClose: false,
  });
});
