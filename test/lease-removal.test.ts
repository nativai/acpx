import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { readControlPodStart } from "../src/cli/lease-removal-command.js";
import {
  READ_GAP_MS,
  RecordsFileError,
  runLeaseRemoval,
  START_MARGIN_MS,
  type LeaseRemovalOptions,
  type LeaseRemovalResult,
} from "../src/cli/queue/lease-removal.js";
import { queueKeyForSession } from "../src/cli/queue/paths.js";

// A-71 (brick 70921280; CONTRACTS-r4 A-71 (2), A-72 (1); test-plan row 71.3, offline half). The verb removes a
// lease only if its body cannot be read, is not JSON or is JSON that is not an object (A-69's kind (1)),
// is older than the control pod's start by more than START_MARGIN_MS, is unchanged across two reads, and
// is unchanged INSIDE the lease guard. Each negative below asserts the lease is KEPT with its reason.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const LEASE_MUTATION = new URL("../src/cli/queue/lease-mutation.js", import.meta.url).href;
const DAY = 86_400_000;
/** The injected control pod's start; fixtures are placed relative to it. */
const START = Date.parse("2026-11-18T10:00:00.000Z");
const OLD = START - 100 * DAY;

type World = {
  home: string;
  queues: string;
  sessions: string;
  archive: string;
  restore: () => void;
};

function makeWorld(): World {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-a71-"));
  const queues = path.join(home, ".acpx", "queues");
  const sessions = path.join(home, ".acpx", "sessions");
  const archive = path.join(home, ".acpx", "sessions-archive");
  for (const dir of [queues, sessions, archive]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const saved = {
    ACPX_STATE_HOME: process.env.ACPX_STATE_HOME,
    ACPX_SESSIONS_ARCHIVE_DIR: process.env.ACPX_SESSIONS_ARCHIVE_DIR,
  };
  process.env.ACPX_STATE_HOME = home;
  delete process.env.ACPX_SESSIONS_ARCHIVE_DIR;
  return {
    home,
    queues,
    sessions,
    archive,
    restore: () => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function lease(world: World, key: string, body: string | Buffer, mtimeMs: number): string {
  const file = path.join(world.queues, `${key}.lock`);
  fs.writeFileSync(file, body);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function sessionRecord(dir: string, id: string, closed: boolean): void {
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ acpxRecordId: id, closed }));
}

/** A key no session record names. */
const ORPHAN = "0123456789abcdef01234567";

function options(
  world: World,
  extra: Partial<LeaseRemovalOptions> & { apply: boolean },
): LeaseRemovalOptions {
  return {
    controlPodStart: () => ({ ms: START, source: "test" }),
    minGapMs: 0,
    sleep: async () => {},
    ...(extra.apply ? { recordsFile: path.join(world.home, "records", "run.ndjson") } : {}),
    ...extra,
  };
}

function only(result: LeaseRemovalResult, key: string) {
  const found = result.records.filter((r) => r.key === key);
  assert.equal(found.length, 1, `exactly one record for ${key}: ${JSON.stringify(result.records)}`);
  return found[0];
}

/** Everything under `dir` with the fields a write would move: names, inode, size, mtime, ctime, mode. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of fs.readdirSync(current).toSorted()) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full, { bigint: true });
      out.push(
        `${path.relative(dir, full)}|${stat.ino}|${stat.size}|${stat.mtimeNs}|${stat.ctimeNs}|${stat.mode}`,
      );
      if (stat.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(dir);
  return out;
}

function records(
  file: string,
): Array<{ event: string; record?: { key: string; decision: string } }> {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("the named constants: 15 s between reads, a 10 min margin before the start", () => {
  assert.equal(READ_GAP_MS, 15_000);
  assert.equal(START_MARGIN_MS, 10 * 60_000);
});

test("POSITIVES: each unparsable body is removed exactly once, with its record; a second apply removes nothing", async () => {
  const world = makeWorld();
  try {
    const bodies: Array<[string, string, string]> = [
      ["zero-byte", "", "not-json"],
      ["null", "null", "json-not-object"],
      ["array", "[]", "json-not-object"],
      ["number", "7", "json-not-object"],
      ["string", '"x"', "json-not-object"],
      ["boolean", "true", "json-not-object"],
      ["truncated", '{"pid": 12', "not-json"],
    ];
    const keys = new Map<string, string>();
    for (const [label, body] of bodies) {
      const id = `rec-a71-${label}`;
      const key = queueKeyForSession(id);
      keys.set(label, key);
      lease(world, key, body, OLD);
      sessionRecord(world.sessions, id, true);
    }
    lease(world, ORPHAN, "", OLD);

    const result = await runLeaseRemoval(options(world, { apply: true }));
    assert.equal(result.mode, "apply");
    assert.deepEqual(result.summary, { removed: 8, wouldRemove: 0, kept: 0, alreadyAbsent: 0 });
    for (const [label, , parse] of bodies) {
      const key = keys.get(label) as string;
      const record = only(result, key);
      assert.equal(record.decision, "removed", label);
      assert.equal(record.parse, parse, label);
      assert.equal(record.sessionId, `rec-a71-${label}`);
      assert.equal(record.state, "closed");
      assert.equal(fs.existsSync(path.join(world.queues, `${key}.lock`)), false, label);
      assert.match(record.fingerprint.sha256, /^[0-9a-f]{64}$/);
    }
    // A key that no session record names is recorded BY ITS KEY, and says so.
    const orphan = only(result, ORPHAN);
    assert.equal(orphan.decision, "removed");
    assert.equal(orphan.sessionId, null);
    assert.equal(orphan.sessionRecord, "none-found");
    assert.equal(orphan.state, "none");
    assert.equal(fs.existsSync(path.join(world.queues, `${ORPHAN}.lock`)), false);

    // The durable file: a run line, then an intent and a result for each removal, never a second removal.
    const lines = records(result.recordsFile as string);
    assert.equal(lines[0].event, "run");
    assert.equal(lines.filter((l) => l.event === "intent").length, 8);
    assert.equal(lines.filter((l) => l.event === "result").length, 8);
    assert.equal(
      new Set(lines.filter((l) => l.event === "intent").map((l) => l.record?.key)).size,
      8,
    );

    const again = await runLeaseRemoval(
      options(world, { apply: true, recordsFile: path.join(world.home, "records", "run2.ndjson") }),
    );
    assert.deepEqual(again.summary, { removed: 0, wouldRemove: 0, kept: 0, alreadyAbsent: 0 });
    assert.equal(again.scanned.selected, 0);
  } finally {
    world.restore();
  }
});

test("a session's state is recorded: hot closed, hot open, archived", async () => {
  const world = makeWorld();
  try {
    sessionRecord(world.sessions, "rec-hot-closed", true);
    sessionRecord(world.sessions, "rec-hot-open", false);
    sessionRecord(world.archive, "rec-archived", false);
    for (const id of ["rec-hot-closed", "rec-hot-open", "rec-archived"]) {
      lease(world, queueKeyForSession(id), "", OLD);
    }
    const result = await runLeaseRemoval(options(world, { apply: false }));
    const state = (id: string) => only(result, queueKeyForSession(id));
    assert.deepEqual(
      [state("rec-hot-closed"), state("rec-hot-open"), state("rec-archived")].map((r) => [
        r.sessionId,
        r.state,
        r.location,
        r.decision,
      ]),
      [
        ["rec-hot-closed", "closed", "hot", "would-remove"],
        ["rec-hot-open", "open", "hot", "would-remove"],
        ["rec-archived", "archived", "archive", "would-remove"],
      ],
    );
  } finally {
    world.restore();
  }
});

test("NEGATIVE: a whole JSON lease object is never selected, parseable or schema-refused", async () => {
  const world = makeWorld();
  try {
    const whole = path.join(world.queues, `${ORPHAN}.lock`);
    const bodies = [
      JSON.stringify({
        pid: 4242,
        sessionId: "rec-x",
        socketPath: "/tmp/x.sock",
        createdAt: "2026-06-01T00:00:00.000Z",
      }),
      JSON.stringify({ ownerGeneration: "g-3" }),
      "{}",
    ];
    for (const [index, body] of bodies.entries()) {
      const key = `${index}`.repeat(24);
      lease(world, key, body, OLD);
    }
    void whole;
    const result = await runLeaseRemoval(options(world, { apply: true }));
    assert.deepEqual(result.records, []);
    assert.equal(result.scanned.leases, 3);
    assert.equal(result.scanned.notSelected, 3);
    for (const [index, body] of bodies.entries()) {
      const file = path.join(world.queues, `${`${index}`.repeat(24)}.lock`);
      assert.equal(fs.readFileSync(file, "utf8"), body);
    }
  } finally {
    world.restore();
  }
});

test("NEGATIVE: a lease written after the control pod started is kept", async () => {
  const world = makeWorld();
  try {
    const file = lease(world, queueKeyForSession("rec-new"), "", START + 60_000);
    const result = await runLeaseRemoval(options(world, { apply: true }));
    const record = only(result, queueKeyForSession("rec-new"));
    assert.equal(record.decision, "kept");
    assert.equal(record.reason, "written-after-pod-start");
    assert.equal(fs.existsSync(file), true);
  } finally {
    world.restore();
  }
});

test("NEGATIVE: the margin — a lease 1 min older than the start is kept `near-start`; one older than the margin goes", async () => {
  const world = makeWorld();
  try {
    const near = queueKeyForSession("rec-near");
    const inside = queueKeyForSession("rec-inside-margin");
    const beyond = queueKeyForSession("rec-beyond-margin");
    lease(world, near, "", START - 60_000);
    lease(world, inside, "null", START - START_MARGIN_MS + 1000);
    lease(world, beyond, "", START - START_MARGIN_MS - 1000);
    const result = await runLeaseRemoval(options(world, { apply: true }));
    assert.deepEqual(
      [near, inside, beyond].map((k) => [only(result, k).decision, only(result, k).reason]),
      [
        ["kept", "near-start"],
        ["kept", "near-start"],
        ["removed", "all-conditions-met"],
      ],
    );
    assert.equal(fs.existsSync(path.join(world.queues, `${near}.lock`)), true);
    assert.equal(fs.existsSync(path.join(world.queues, `${inside}.lock`)), true);
    assert.equal(fs.existsSync(path.join(world.queues, `${beyond}.lock`)), false);
  } finally {
    world.restore();
  }
});

test("NEGATIVE: changed between the two reads — content, and mtime alone — is kept", async () => {
  const world = makeWorld();
  try {
    const content = queueKeyForSession("rec-changes-content");
    const touched = queueKeyForSession("rec-changes-mtime");
    const contentFile = lease(world, content, "", OLD);
    const touchedFile = lease(world, touched, "", OLD);
    const result = await runLeaseRemoval(
      options(world, {
        apply: true,
        hooks: {
          betweenReads: (key) => {
            if (key === content) {
              fs.writeFileSync(contentFile, "x");
              fs.utimesSync(contentFile, OLD / 1000, OLD / 1000);
            } else if (key === touched) {
              fs.utimesSync(touchedFile, (OLD + 5000) / 1000, (OLD + 5000) / 1000);
            }
          },
        },
      }),
    );
    for (const key of [content, touched]) {
      assert.equal(only(result, key).decision, "kept", key);
      assert.equal(only(result, key).reason, "changed-between-reads", key);
    }
    assert.equal(fs.existsSync(contentFile), true);
    assert.equal(fs.existsSync(touchedFile), true);
  } finally {
    world.restore();
  }
});

test("the second read waits at least the gap after the first (a real clock, a small gap)", async () => {
  const world = makeWorld();
  try {
    lease(world, queueKeyForSession("rec-gap"), "", OLD);
    const slept: number[] = [];
    await runLeaseRemoval(
      options(world, {
        apply: false,
        minGapMs: 300,
        sleep: async (ms) => {
          slept.push(ms);
        },
      }),
    );
    assert.equal(slept.length, 1);
    assert.ok(slept[0] > 0 && slept[0] <= 300, `slept ${slept[0]}`);
  } finally {
    world.restore();
  }
});

test("NEGATIVE: changed INSIDE the guard is kept; gone inside the guard is `already-absent`", async () => {
  const world = makeWorld();
  try {
    const changed = queueKeyForSession("rec-inside-changes");
    const gone = queueKeyForSession("rec-inside-gone");
    const changedFile = lease(world, changed, "", OLD);
    const goneFile = lease(world, gone, "null", OLD);
    const result = await runLeaseRemoval(
      options(world, {
        apply: true,
        hooks: {
          insideGuard: (key) => {
            if (key === changed) {
              fs.writeFileSync(changedFile, "now something else");
              fs.utimesSync(changedFile, OLD / 1000, OLD / 1000);
            } else if (key === gone) {
              fs.unlinkSync(goneFile);
            }
          },
        },
      }),
    );
    assert.equal(only(result, changed).decision, "kept");
    assert.equal(only(result, changed).reason, "changed-inside-guard");
    assert.equal(fs.readFileSync(changedFile, "utf8"), "now something else");
    assert.equal(only(result, gone).decision, "already-absent");
    const lines = records(result.recordsFile as string);
    assert.equal(
      lines.filter((l) => l.event === "intent").length,
      0,
      "no intent without a removal",
    );
  } finally {
    world.restore();
  }
});

test("NEGATIVE: a lease whose guard another process holds is not removed (`guard-unavailable`)", async () => {
  const world = makeWorld();
  const key = queueKeyForSession("rec-guard-held");
  const file = lease(world, key, "", OLD);
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(LEASE_MUTATION)}).then((m) => m.withQueueLeaseMutationAtKey(${JSON.stringify(key)}, () => new Promise((resolve) => { process.stdout.write("held\\n"); process.stdin.on("end", resolve); process.stdin.resume(); })));`,
    ],
    { env: { ...process.env }, stdio: ["pipe", "pipe", "inherit"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once("data", () => resolve());
      holder.once("error", reject);
      holder.once("exit", (code) => reject(new Error(`holder exited ${code} before holding`)));
    });
    const result = await runLeaseRemoval(options(world, { apply: true }));
    assert.equal(only(result, key).decision, "kept");
    assert.equal(only(result, key).reason, "guard-unavailable");
    assert.equal(fs.existsSync(file), true);
    assert.equal(result.summary.removed, 0);
  } finally {
    holder.stdin.end();
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    world.restore();
  }
});

test("the guard of a lease with a session and of one without are one lock (`<key>.lock.guard`)", async () => {
  const world = makeWorld();
  try {
    const { queueLeaseGuardPath, queueLeaseGuardPathForKey } =
      await import("../src/cli/queue/lease-mutation.js");
    assert.equal(
      queueLeaseGuardPathForKey(queueKeyForSession("rec-g")),
      queueLeaseGuardPath("rec-g"),
    );
  } finally {
    world.restore();
  }
});

test("NEGATIVE: an unknown control pod start removes nothing, and a dry run says why", async () => {
  const world = makeWorld();
  try {
    const key = queueKeyForSession("rec-unknown-start");
    const file = lease(world, key, "", OLD);
    for (const apply of [false, true]) {
      const result = await runLeaseRemoval(
        options(world, {
          apply,
          controlPodStart: () => ({ ms: undefined, reason: "test: no start" }),
          recordsFile: path.join(world.home, "records", `unknown-${apply}.ndjson`),
        }),
      );
      assert.equal(only(result, key).decision, "kept");
      assert.match(only(result, key).reason, /^control-pod-start-unknown: test: no start$/);
      assert.equal(result.controlPodStart, null);
      assert.equal(fs.existsSync(file), true);
    }
  } finally {
    world.restore();
  }
});

test("`readControlPodStart` fails closed: not the control pod, an unreadable /proc, a calibration miss", () => {
  const own = process.pid;
  const stat = (pid: number, ticks: number) =>
    `${pid} (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 0 0`;
  const proc = (initTicks: number, ownTicks: number) => ({
    read: (file: string) => {
      if (file === "/proc/stat") {
        return "cpu 1 2 3\nbtime 1700000000\n";
      }
      if (file === "/proc/1/stat") {
        return stat(1, initTicks);
      }
      if (file === `/proc/${own}/stat`) {
        return stat(own, ownTicks);
      }
      throw Object.assign(new Error("nope"), { code: "ENOENT" });
    },
  });
  const nowMs = 1_700_000_000_000 + 5_000_000;
  const clock = { nowMs: () => nowMs, uptimeS: () => 100 };
  // Own start by the clock: nowMs - 100 s = btime + 4900 s → ticks 490000.
  const ok = readControlPodStart({ proc: proc(1000, 490_000), place: () => "control", ...clock });
  if (ok.ms === undefined) {
    // Off Linux, or with an unverifiable own pid namespace, the verdict is "unknown" too: still closed.
    assert.match(ok.reason, /pid namespace/);
  } else {
    assert.equal(ok.ms, 1_700_000_000_000 + 10_000);
  }
  for (const place of ["elsewhere", "agent-pod"]) {
    const verdict = readControlPodStart({
      proc: proc(1000, 490_000),
      place: () => place,
      ...clock,
    });
    assert.equal(verdict.ms, undefined);
    assert.match((verdict as { reason: string }).reason, /not the control pod/);
  }
  const miss = readControlPodStart({ proc: proc(1000, 480_000), place: () => "control", ...clock });
  assert.equal(miss.ms, undefined);
  const unreadable = readControlPodStart({
    proc: {
      read: () => {
        throw Object.assign(new Error("x"), { code: "EACCES" });
      },
    },
    place: () => "control",
    ...clock,
  });
  assert.equal(unreadable.ms, undefined);
});

test("NEGATIVE: a directory named like a lease is kept, never unlinked", async () => {
  const world = makeWorld();
  try {
    const key = queueKeyForSession("rec-dir");
    const dir = path.join(world.queues, `${key}.lock`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "inner"), "x");
    const result = await runLeaseRemoval(options(world, { apply: true }));
    assert.equal(only(result, key).decision, "kept");
    assert.equal(only(result, key).reason, "not-a-regular-file");
    assert.equal(fs.existsSync(path.join(dir, "inner")), true);
  } finally {
    world.restore();
  }
});

test("NEGATIVE: no removal when the records file cannot be created", async () => {
  const world = makeWorld();
  try {
    const key = queueKeyForSession("rec-no-records");
    const file = lease(world, key, "", OLD);
    const taken = path.join(world.home, "records.ndjson");
    fs.writeFileSync(taken, "already here");
    await assert.rejects(
      runLeaseRemoval(options(world, { apply: true, recordsFile: taken })),
      /EEXIST/,
    );
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.readFileSync(taken, "utf8"), "already here");
  } finally {
    world.restore();
  }
});

test("A DRY RUN REMOVES AND WRITES NOTHING: no guard, no records, no directory — the whole state home is unchanged", async () => {
  const world = makeWorld();
  try {
    sessionRecord(world.sessions, "rec-dry-1", true);
    lease(world, queueKeyForSession("rec-dry-1"), "", OLD);
    lease(world, ORPHAN, "null", OLD);
    lease(world, "a".repeat(24), "{}", OLD);
    lease(world, queueKeyForSession("rec-dry-new"), "", Date.now());
    const before = listing(world.home);
    const result = await runLeaseRemoval(options(world, { apply: false }));
    assert.equal(result.mode, "dry-run");
    assert.equal(result.recordsFile, null);
    assert.equal(result.summary.wouldRemove, 2);
    assert.equal(result.summary.kept, 1);
    assert.deepEqual(listing(world.home), before);
    assert.equal(fs.existsSync(path.join(world.home, "records")), false);
    assert.equal(fs.existsSync(path.join(world.home, ".acpx", "maintenance")), false);
    assert.equal(
      fs.readdirSync(world.queues).some((n) => n.includes("guard")),
      false,
    );
  } finally {
    world.restore();
  }
});

// The real CLI (a built child process). Two homes run in parallel: each run takes the real 15 s gap.
test("THE CLI: the dry run changes nothing; the apply removes, records durably, and a second census reads empty", async () => {
  const dry = makeWorld();
  const apply = makeWorld();
  const env = (home: string) => ({
    ...process.env,
    ACPX_STATE_HOME: home,
    NODE_TEST_CONTEXT: "child-v8",
    ACPX_POD_TEST_HOME: home,
  });
  const cli = (home: string, args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [CLI, "--format", "json", "sessions", "unparsable-leases", ...args],
        {
          env: env(home),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
    });
  try {
    const OLD_TIME = Date.parse("2020-01-01T00:00:00Z");
    for (const world of [dry, apply]) {
      sessionRecord(world.sessions, "rec-cli-1", true);
      lease(world, queueKeyForSession("rec-cli-1"), "", OLD_TIME);
      lease(world, ORPHAN, "[]", OLD_TIME);
      lease(world, "b".repeat(24), JSON.stringify({ ownerGeneration: "g-3" }), OLD_TIME);
    }
    lease(dry, queueKeyForSession("rec-cli-new"), "null", Date.now());
    const before = listing(dry.home);
    const recordsFile = path.join(apply.home, "out", "removals.ndjson");
    const [dryRun, applyRun] = await Promise.all([
      cli(dry.home, []),
      cli(apply.home, ["--apply", "--records-file", recordsFile]),
    ]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryJson = JSON.parse(dryRun.stdout) as LeaseRemovalResult;
    assert.equal(dryJson.mode, "dry-run");
    assert.ok(dryJson.controlPodStart, `a start was read: ${dryJson.controlPodStartSource}`);
    assert.equal(dryJson.summary.wouldRemove, 2, dryRun.stdout);
    assert.equal(dryJson.summary.kept, 1);
    assert.deepEqual(listing(dry.home), before);

    assert.equal(applyRun.code, 0, applyRun.stderr);
    const applyJson = JSON.parse(applyRun.stdout) as LeaseRemovalResult;
    assert.equal(applyJson.summary.removed, 2, applyRun.stdout);
    assert.equal(applyJson.recordsFile, recordsFile);
    assert.equal(records(recordsFile).filter((l) => l.event === "intent").length, 2);
    assert.deepEqual(fs.readdirSync(apply.queues).filter((n) => n.endsWith(".lock")).length, 1);

    const second = await cli(apply.home, []);
    assert.equal(second.code, 0, second.stderr);
    const secondJson = JSON.parse(second.stdout) as LeaseRemovalResult;
    assert.equal(secondJson.scanned.selected, 0);
    assert.deepEqual(secondJson.records, []);
    const text = spawnSync(process.execPath, [CLI, "sessions", "unparsable-leases"], {
      env: env(apply.home),
      encoding: "utf8",
    });
    assert.match(text.stdout, /DRY RUN \(removes and writes nothing\)/);
    assert.match(text.stdout, /selected .*: 0/);
  } finally {
    dry.restore();
    apply.restore();
  }
});

test("THE CLI off the control pod: the census names the leases and removes nothing", async () => {
  const world = makeWorld();
  try {
    const file = lease(world, ORPHAN, "", Date.parse("2020-01-01T00:00:00Z"));
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "--format",
        "json",
        "sessions",
        "unparsable-leases",
        "--apply",
        "--records-file",
        path.join(world.home, "r.ndjson"),
      ],
      {
        env: {
          ...process.env,
          ACPX_STATE_HOME: world.home,
          ACPX_POD_TEST_HOME: "",
          NODE_TEST_CONTEXT: "",
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    const json = JSON.parse(result.stdout) as LeaseRemovalResult;
    assert.equal(json.controlPodStart, null, `${result.stdout}${result.stderr}`);
    assert.equal(json.records[0].decision, "kept");
    assert.match(json.records[0].reason, /^control-pod-start-unknown: not the control pod/);
    assert.equal(fs.existsSync(file), true);
    assert.equal(result.status, 1);
  } finally {
    world.restore();
  }
});

// ---- Round 2 (the TE's four LOWs) ----

/** Make `fsp[method]` fail with `code` for `file` only, until the returned restore is called. */
function failFor(method: "lstat" | "open", file: string, code: string): () => void {
  const original = fsp[method].bind(fsp) as (...args: unknown[]) => Promise<unknown>;
  const spy = mock.method(fsp, method, async (...args: unknown[]) => {
    if (args[0] === file) {
      throw Object.assign(new Error(`${code}: injected`), { code });
    }
    return await original(...args);
  });
  return () => spy.mock.restore();
}

test("LOW-1: an lstat error on a lease written NOW is kept `stat-error`, never read as the epoch (real EACCES)", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores directory permissions");
    return;
  }
  const world = makeWorld();
  const key = queueKeyForSession("rec-stat-eacces");
  const file = lease(world, key, "", Date.now());
  fs.chmodSync(world.queues, 0o600); // listable, but no entry can be statted
  try {
    for (const apply of [false, true]) {
      const result = await runLeaseRemoval(options(world, { apply }));
      const record = only(result, key);
      assert.equal(record.decision, "kept", `apply=${apply}`);
      assert.equal(record.reason, "stat-error: EACCES");
      assert.equal(record.mtime, null, "an unknown mtime is null, not 1970");
      assert.equal(result.summary.wouldRemove + result.summary.removed, 0);
    }
  } finally {
    fs.chmodSync(world.queues, 0o700);
  }
  assert.equal(fs.existsSync(file), true);
  world.restore();
});

test("LOW-1: a stat error on an OLD lease, at read 2 and inside the guard, is kept `stat-error` (injected EIO)", async () => {
  const world = makeWorld();
  try {
    const atRead2 = queueKeyForSession("rec-eio-read2");
    const inGuard = queueKeyForSession("rec-eio-guard");
    const f2 = lease(world, atRead2, "", OLD);
    const fg = lease(world, inGuard, "null", OLD);
    let restore = () => {};
    const result = await runLeaseRemoval(
      options(world, {
        apply: true,
        hooks: {
          betweenReads: (key) => {
            if (key === atRead2) {
              restore = failFor("lstat", f2, "EIO");
            }
          },
          insideGuard: (key) => {
            if (key === inGuard) {
              restore = failFor("lstat", fg, "EIO");
            }
          },
        },
      }),
    );
    restore();
    assert.deepEqual(
      [atRead2, inGuard].map((k) => [only(result, k).decision, only(result, k).reason]),
      [
        ["kept", "stat-error: EIO"],
        ["kept", "stat-error: EIO"],
      ],
    );
    assert.equal(fs.existsSync(f2) && fs.existsSync(fg), true);
    assert.equal(
      records(result.recordsFile as string).filter((l) => l.event === "intent").length,
      0,
    );
  } finally {
    world.restore();
  }
});

test("LOW-1: a READ error on a selected lease (open EIO) is kept `read-error`, with its real mtime", async () => {
  const world = makeWorld();
  const key = queueKeyForSession("rec-open-eio");
  const file = lease(world, key, "", OLD);
  const restore = failFor("open", file, "EIO");
  try {
    const result = await runLeaseRemoval(options(world, { apply: true }));
    assert.equal(only(result, key).decision, "kept");
    assert.equal(only(result, key).reason, "read-error: EIO");
    assert.equal(only(result, key).mtime, new Date(OLD).toISOString());
    assert.equal(fs.existsSync(file), true);
  } finally {
    restore();
    world.restore();
  }
});

test("LOW-1 audit: no record carries an epoch — a non-regular entry shows its real mtime", async () => {
  const world = makeWorld();
  try {
    const key = queueKeyForSession("rec-dir-mtime");
    const dir = path.join(world.queues, `${key}.lock`);
    fs.mkdirSync(dir);
    fs.utimesSync(dir, OLD / 1000, OLD / 1000);
    const result = await runLeaseRemoval(options(world, { apply: false }));
    assert.equal(only(result, key).mtime, new Date(OLD).toISOString());
    assert.ok(result.records.every((r) => r.mtime !== "1970-01-01T00:00:00.000Z"));
  } finally {
    world.restore();
  }
});

test("LOW-2: an apply whose records file cannot be created refuses BEFORE reading anything (RecordsFileError) and removes nothing", async () => {
  const world = makeWorld();
  try {
    const file = lease(world, queueKeyForSession("rec-refused"), "", OLD);
    const taken = path.join(world.home, "taken.ndjson");
    fs.writeFileSync(taken, "mine");
    let reads = 0;
    await assert.rejects(
      runLeaseRemoval(
        options(world, {
          apply: true,
          recordsFile: taken,
          hooks: { betweenReads: () => void (reads += 1) },
        }),
      ),
      (error: unknown) => error instanceof RecordsFileError && error.message.includes("EEXIST"),
    );
    assert.equal(reads, 0, "no second read happened: the refusal came first");
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.readFileSync(taken, "utf8"), "mine");
  } finally {
    world.restore();
  }
});

test("LOW-3: what was found for a session is reported as it is: record / residue-only / none; a record beats residue", async () => {
  const world = makeWorld();
  try {
    sessionRecord(world.archive, "rec-archived-record", true);
    fs.writeFileSync(path.join(world.archive, "rec-archived-residue.owner.log"), "x");
    fs.writeFileSync(path.join(world.sessions, "rec-hot-residue.stream.ndjson"), "x");
    // residue in the hot dir, the record in the archive: the record wins.
    fs.writeFileSync(path.join(world.sessions, "rec-split.owner.log"), "x");
    sessionRecord(world.archive, "rec-split", false);
    for (const id of [
      "rec-archived-record",
      "rec-archived-residue",
      "rec-hot-residue",
      "rec-split",
    ]) {
      lease(world, queueKeyForSession(id), "", OLD);
    }
    lease(world, ORPHAN, "", OLD);
    const result = await runLeaseRemoval(options(world, { apply: false }));
    const row = (key: string) => {
      const r = only(result, key);
      return [r.sessionId, r.sessionRecord, r.location, r.state, r.closed];
    };
    assert.deepEqual(row(queueKeyForSession("rec-archived-record")), [
      "rec-archived-record",
      "record",
      "archive",
      "archived",
      true,
    ]);
    assert.deepEqual(row(queueKeyForSession("rec-archived-residue")), [
      "rec-archived-residue",
      "residue-only",
      "archive",
      "residue-only",
      null,
    ]);
    assert.deepEqual(row(queueKeyForSession("rec-hot-residue")), [
      "rec-hot-residue",
      "residue-only",
      "hot",
      "residue-only",
      null,
    ]);
    assert.deepEqual(row(queueKeyForSession("rec-split")), [
      "rec-split",
      "record",
      "archive",
      "archived",
      false,
    ]);
    assert.deepEqual(row(ORPHAN), [null, "none-found", null, "none", null]);
  } finally {
    world.restore();
  }
});

function runCli(home: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [CLI, "--format", "json", "sessions", "unparsable-leases", ...args],
    {
      env: {
        ...process.env,
        ACPX_STATE_HOME: home,
        NODE_TEST_CONTEXT: "child-v8",
        ACPX_POD_TEST_HOME: home,
      },
      encoding: "utf8",
      timeout: 90_000,
    },
  );
}

test("LOW-2 (CLI): a records file that cannot be created exits 2 (not 1), at once, nothing removed; kept-a-lease still exits 1", () => {
  const world = makeWorld();
  try {
    const file = lease(world, ORPHAN, "", Date.parse("2020-01-01T00:00:00Z"));
    const taken = path.join(world.home, "taken.ndjson");
    fs.writeFileSync(taken, "mine");
    const began = Date.now();
    const result = runCli(world.home, ["--apply", "--records-file", taken]);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.ok(Date.now() - began < 12_000, "refused before the 15 s gap");
    assert.match(result.stderr, /REFUSED reason=records_file_unavailable .*EEXIST/);
    assert.equal(result.stdout, "");
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.readFileSync(taken, "utf8"), "mine");
  } finally {
    world.restore();
  }
});

test("LOW-4 (CLI): `--records-file` without `--apply` is refused with exit 2 before anything runs", () => {
  const world = makeWorld();
  try {
    lease(world, ORPHAN, "", Date.parse("2020-01-01T00:00:00Z"));
    const target = path.join(world.home, "out.ndjson");
    const before = listing(world.home);
    const began = Date.now();
    const result = runCli(world.home, ["--records-file", target]);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /REFUSED reason=records_file_needs_apply .*--apply/);
    assert.equal(result.stdout, "");
    assert.ok(Date.now() - began < 12_000, "no census, no gap");
    assert.deepEqual(listing(world.home), before);
    assert.equal(fs.existsSync(target), false);
  } finally {
    world.restore();
  }
});
