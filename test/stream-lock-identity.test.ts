import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import test from "node:test";
import {
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
} from "../src/process-identity.js";
import { isStreamLockStealable } from "../src/session/events.js";

// brick ae547131 §6.4 — T18 (⊗: d9ab5c0d steals a foreign holder at once, because its pid reads
// ESRCH here). The stream lock keeps its 15 s steal of a LIVE local holder (deliberate non-change,
// R11); only the foreign-holder case changes.

function body(pid: number, createdAt: Date, processIdentity?: Record<string, string>): string {
  return JSON.stringify({
    pid,
    created_at: createdAt.toISOString(),
    host: os.hostname(),
    ...(processIdentity ? { processIdentity } : {}),
  });
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid!;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

test("T18 stream lock: foreign < 15 s with an ESRCH pid is NOT stolen; local dead is; local alive after 15 s is", async (t) => {
  if (process.platform !== "linux") {
    t.skip("linux identity");
    return;
  }
  const own = readProcessBirthIdentity(process.pid);
  assert.ok(own);
  const now = Date.now();
  const young = new Date(now - 1_000);
  const old = new Date(now - 16_000);
  const dead = await deadPid();
  const scoped = serializeProcessBirthIdentity(own);

  // foreign: our boot, another pid namespace — ESRCH here proves nothing
  const foreign = { ...scoped, pidNamespace: "pid:[1]" };
  assert.equal(isStreamLockStealable(body(dead, young, foreign), now), false);
  assert.equal(isStreamLockStealable(body(dead, old, foreign), now), true, "age bound");

  // local dead (0a body in our scope, ESRCH) — at once
  assert.equal(isStreamLockStealable(body(dead, young, { ...scoped }), now), true);

  // local alive — not before 15 s, after it yes (unchanged)
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
  });
  try {
    assert.ok(sleeper.pid);
    const live = serializeProcessBirthIdentity(readProcessBirthIdentity(sleeper.pid)!);
    assert.equal(isStreamLockStealable(body(sleeper.pid, young, live), now), false);
    assert.equal(isStreamLockStealable(body(sleeper.pid, old, live), now), true);
    // legacy body (no identity): today's rule — dead pid at once, alive only after 15 s
    assert.equal(isStreamLockStealable(body(dead, young), now), true);
    assert.equal(isStreamLockStealable(body(sleeper.pid, young), now), false);
  } finally {
    sleeper.kill("SIGKILL");
  }
  // no created_at ⇒ infinite age, as a pre-0a reader computes it
  assert.equal(isStreamLockStealable(JSON.stringify({ pid: process.pid }), now), true);
});
