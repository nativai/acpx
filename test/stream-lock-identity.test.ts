import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
  setProcReaderForTests,
} from "../src/process-identity.js";
import { STREAM_LOCK_IDENTITY_MISSING_CODE, acquireEventsLock } from "../src/session/events.js";
import { sweepOwnPodLocks } from "../src/session/persistence/identity-file-lock.js";
import { withTempHome } from "./runtime-test-helpers.js";

// A-60, C3.5 (iii), row 60.11 — THE STREAM LOCK IS NEVER TAKEN FROM A HOLDER JUDGED LIVE.
// Before A-60 the stream lock added R11 on top of the primitive: a body without `pod` was broken once
// it was 15 s old, a live holder included (the probe's F4-normal). Bodies here have no `pod`, as on
// every control pod today. The waiter and atrium's 5 s sweep (`sweepOwnPodLocks`) are both driven.

const AN_HOUR_AGO = (): Date => new Date(Date.now() - 3_600_000);

function body(pid: number, identity: Record<string, string> | undefined, createdAt: Date): string {
  return JSON.stringify({
    pid,
    created_at: createdAt.toISOString(),
    host: os.hostname(),
    ...(identity ? { processIdentity: identity } : {}),
  });
}

function lockFile(homeDir: string, name: string, raw: string, mtime: Date): string {
  const lockPath = path.join(homeDir, ".acpx", "sessions", `${name}.stream.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, raw);
  fs.utimesSync(lockPath, mtime, mtime);
  return lockPath;
}

async function withSleeper<T>(
  run: (pid: number, birth: Record<string, string>) => Promise<T>,
): Promise<T> {
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
  });
  try {
    assert.ok(sleeper.pid);
    // The child needs a moment before /proc/<pid>/stat is readable with its own start time.
    const birth = readProcessBirthIdentity(sleeper.pid);
    assert.ok(birth, "the sleeper's birth identity is readable");
    return await run(sleeper.pid, serializeProcessBirthIdentity(birth));
  } finally {
    sleeper.kill("SIGKILL");
  }
}

async function captureStderr(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

test("60.11 (a): a live holder whose birth identity matches is never broken — by a waiter or by the sweep — at any age", async (t) => {
  if (process.platform !== "linux") {
    t.skip("linux identity");
    return;
  }
  await withTempHome("acpx-a60-live-", async (homeDir) => {
    await withSleeper(async (pid, birth) => {
      const raw = body(pid, birth, AN_HOUR_AGO());
      const lockPath = lockFile(homeDir, "live", raw, AN_HOUR_AGO());

      await assert.rejects(acquireEventsLock("live", 800), { code: "stream-lock-timeout" });
      assert.equal(
        fs.readFileSync(lockPath, "utf8"),
        raw,
        "the waiter left the lock byte-identical",
      );

      const swept = await sweepOwnPodLocks({ dirs: [path.dirname(lockPath)] });
      assert.deepEqual(swept.removed, [], "the 5 s sweep never removes a live holder's lock");
      assert.equal(fs.readFileSync(lockPath, "utf8"), raw);
    });
  });
});

test("60.11 (b): the same pid with another start time is a different process — the lock is broken (proof: pid)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("linux identity");
    return;
  }
  await withTempHome("acpx-a60-recycled-", async (homeDir) => {
    await withSleeper(async (pid, birth) => {
      const recycled = { ...birth, startTimeTicks: String(Number(birth.startTimeTicks) + 12_345) };
      lockFile(homeDir, "recycled", body(pid, recycled, new Date()), new Date());
      const lock = await acquireEventsLock("recycled", 3_000);
      assert.equal(JSON.parse(fs.readFileSync(lock.filePath, "utf8")).pid, process.pid);
    });
  });
});

test("60.11 (c): a holder in another pid namespace, older than 15 s, is broken with the warning — the named residual", async (t) => {
  if (process.platform !== "linux") {
    t.skip("linux identity");
    return;
  }
  await withTempHome("acpx-a60-foreignns-", async (homeDir) => {
    await withSleeper(async (pid, birth) => {
      const otherNamespace = { ...birth, pidNamespace: "pid:[1]" };
      const raw = body(pid, otherNamespace, AN_HOUR_AGO());
      // Younger than 15 s: it cannot be judged, so it is not broken.
      lockFile(homeDir, "young-ns", raw, new Date());
      await assert.rejects(acquireEventsLock("young-ns", 600), { code: "stream-lock-timeout" });
      // Older: broken by age, and said so.
      lockFile(homeDir, "old-ns", raw, AN_HOUR_AGO());
      const stderr = await captureStderr(async () => {
        const lock = await acquireEventsLock("old-ns", 3_000);
        assert.equal(JSON.parse(fs.readFileSync(lock.filePath, "utf8")).pid, process.pid);
      });
      assert.match(stderr, /broke stale session stream lock/);
    });
  });
});

test("60.11 (negative): a process that cannot read its own birth identity takes no stream lock", async (t) => {
  if (process.platform !== "linux") {
    t.skip("linux identity");
    return;
  }
  await withTempHome("acpx-a60-noident-", async (homeDir) => {
    const unreadable = {
      readFile: () => {
        throw new Error("no /proc here");
      },
      readLink: () => {
        throw new Error("no /proc here");
      },
    };
    setProcReaderForTests(unreadable);
    try {
      await assert.rejects(acquireEventsLock("noident", 600), {
        code: STREAM_LOCK_IDENTITY_MISSING_CODE,
      });
      assert.equal(
        fs.existsSync(path.join(homeDir, ".acpx", "sessions", "noident.stream.lock")),
        false,
        "no lock file was written",
      );
    } finally {
      setProcReaderForTests(undefined);
    }
    // Control: with its identity readable again the same call takes the lock.
    const lock = await acquireEventsLock("noident", 3_000);
    assert.match(fs.readFileSync(lock.filePath, "utf8"), /processIdentity/);
  });
});
