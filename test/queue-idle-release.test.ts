// W13-24-14 Phase 2 — idle-owner memory-release decision regression suite.
//
// THE LOAD-BEARING INVARIANT: never release a maybe-active owner. An active turn,
// a 15-20 min tool call, or a busy-wait → hasActiveTurn() === true → the owner is
// NEVER torn down, no matter how long quiet, and regardless of the idle clock or a
// deploy difference. These tests pin the pure decideIdleOwnerRelease gate (the
// North-Star invariant, evaluated once) and the ACPX_OWNER_IDLE_RELEASE_MS knob's
// normalizer — both unit-testable without a live owner, mirroring how the queue
// module factors isRecoverableQueueOwnerState / classifyQueueOwnerState.
//
// The end-to-end proof (real owners, real signals) lives in the tester plan; this
// suite proves the decision logic in isolation.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OWNER_IDLE_RELEASE_MS,
  normalizeOwnerIdleReleaseMs,
} from "../src/cli/session/contracts.js";
import {
  type DecideIdleOwnerReleaseInput,
  decideIdleOwnerRelease,
} from "../src/cli/session/queue-owner-runtime.js";

// Fixed epoch ms — pure tests must not read the wall clock.
const BASE_NOW = 1_700_000_000_000;

// Default input = a freshly-idle, quiescent, current-code owner under a 10s cadence
// and a 30s memory timeout. lastIdleDrainActivityAt = 0 mirrors the real "no relay
// since spawn" baseline (now - 0 is huge → quiescent). Override per case.
function input(overrides: Partial<DecideIdleOwnerReleaseInput> = {}): DecideIdleOwnerReleaseInput {
  return {
    ttlMs: 10_000,
    hasActiveTurn: false,
    hasLiveBackgroundWork: false,
    now: BASE_NOW,
    lastIdleDrainActivityAt: 0,
    lastTaskCompletedAt: BASE_NOW,
    quiescenceWindowMs: 10_000,
    idleReleaseMs: 30_000,
    deployDiffers: () => false,
    ...overrides,
  };
}

// #1 — THE INVARIANT (load-bearing). hasActiveTurn() === true ⇒ NEVER release,
// even with the idle clock far past idleReleaseMs AND deployDiffers === true. This
// is the single assertion that proves a maybe-active owner is never torn down by
// EITHER reason; the gate refuses before either reason is considered.
test("P2 #1 INVARIANT: hasActiveTurn ⇒ never release (both reasons), clock far past + deploy-stale", async () => {
  let deployConsulted = 0;
  const decision = await decideIdleOwnerRelease(
    input({
      hasActiveTurn: true,
      now: BASE_NOW + 60 * 60_000, // 60 min idle on the clock — far past any timeout
      lastTaskCompletedAt: BASE_NOW,
      idleReleaseMs: 1, // memory timeout essentially zero
      deployDiffers: () => {
        deployConsulted += 1;
        return true; // even outdated code
      },
    }),
  );
  assert.deepEqual(decision, { release: false }, "an active owner is NEVER released");
  assert.equal(
    deployConsulted,
    0,
    "the gate short-circuits before the deploy check — neither reason is reached",
  );
});

// #1b — THE BACKGROUND-WORK INVARIANT (brick c92f6bdc, Fix A). Live background
// process-group work protects the owner EXACTLY as a live turn does: the gate
// measures work liveness, not just turn liveness. A model that backgrounds a long
// command and ends its turn (hasActiveTurn === false) must NOT have its owner
// reaped while that job runs — the one surviving gap the RCA proved. Peer of #1:
// hasLiveBackgroundWork === true ⇒ NEVER release, even with the idle clock far
// past idleReleaseMs AND deployDiffers === true.
test("P2 #1b INVARIANT: hasLiveBackgroundWork ⇒ never release (both reasons), clock far past + deploy-stale", async () => {
  let deployConsulted = 0;
  const decision = await decideIdleOwnerRelease(
    input({
      hasLiveBackgroundWork: true,
      hasActiveTurn: false, // turn already ended — the exact backgrounded-work shape
      now: BASE_NOW + 60 * 60_000, // 60 min idle on the clock — far past any timeout
      lastTaskCompletedAt: BASE_NOW,
      idleReleaseMs: 1, // memory timeout essentially zero
      deployDiffers: () => {
        deployConsulted += 1;
        return true; // even outdated code
      },
    }),
  );
  assert.deepEqual(
    decision,
    { release: false },
    "an owner with live background work is NEVER released",
  );
  assert.equal(
    deployConsulted,
    0,
    "the gate short-circuits before the deploy check — neither reason is reached",
  );
});

// #1c — The complement: with NO background work, the idle-memory path still fires
// unchanged (the gate only adds a conjunct; it does not disturb the release path).
test("P2 #1c: no background work + idle past the timeout ⇒ release idle-memory (path intact)", async () => {
  const decision = await decideIdleOwnerRelease(
    input({
      hasLiveBackgroundWork: false,
      now: BASE_NOW + 30_000,
      lastTaskCompletedAt: BASE_NOW,
    }),
  );
  assert.deepEqual(decision, { release: true, reason: "idle-memory" });
});

// #2 — A current-code idle owner re-arms across successive wakes, THEN releases
// once the accumulated idle reaches the timeout — and only while not active.
test("P2 #2: re-arm across wakes, then release idle-memory at the timeout", async () => {
  // wake at +10s and +20s — accumulated idle < 30s → re-arm (no release)
  for (const elapsed of [10_000, 20_000, 29_999]) {
    const d = await decideIdleOwnerRelease(
      input({ now: BASE_NOW + elapsed, lastTaskCompletedAt: BASE_NOW }),
    );
    assert.deepEqual(d, { release: false }, `re-arm at +${elapsed}ms (< 30s)`);
  }
  // wake at +30s — accumulated idle >= 30s → release idle-memory
  const released = await decideIdleOwnerRelease(
    input({ now: BASE_NOW + 30_000, lastTaskCompletedAt: BASE_NOW }),
  );
  assert.deepEqual(released, { release: true, reason: "idle-memory" });
  // ...but only when not active: same clock, active turn ⇒ no release
  const active = await decideIdleOwnerRelease(
    input({ now: BASE_NOW + 30_000, lastTaskCompletedAt: BASE_NOW, hasActiveTurn: true }),
  );
  assert.deepEqual(active, { release: false }, "past the timeout but active ⇒ still protected");
});

// #3 — Quiescence blocks release; a relay resets the accumulated-idle clock.
test("P2 #3: recent relay blocks release; a relay resets the clock to T + idleReleaseMs", async () => {
  // Idle clock says 60s (past 30s), but a relay 5s ago (< 10s window) ⇒ NOT
  // quiescent ⇒ no release. The quiescence gate is load-bearing for both reasons.
  const blocked = await decideIdleOwnerRelease(
    input({
      now: BASE_NOW + 60_000,
      lastTaskCompletedAt: BASE_NOW,
      lastIdleDrainActivityAt: BASE_NOW + 55_000,
      quiescenceWindowMs: 10_000,
    }),
  );
  assert.deepEqual(blocked, { release: false }, "recent relay blocks release via quiescence");

  // Relay at T resets the max() clock: at T+20s (quiescent again, 20s ≥ 10s window)
  // the accumulated idle since the relay is 20s < 30s ⇒ still no release.
  const T = BASE_NOW + 100_000;
  const notYet = await decideIdleOwnerRelease(
    input({
      now: T + 20_000,
      lastTaskCompletedAt: BASE_NOW, // old turn-end, superseded by the later relay
      lastIdleDrainActivityAt: T,
      quiescenceWindowMs: 10_000,
    }),
  );
  assert.deepEqual(notYet, { release: false }, "relay reset the clock: 20s < 30s since relay");

  // At T+30s the clock has reached the timeout measured from the relay ⇒ release.
  const released = await decideIdleOwnerRelease(
    input({
      now: T + 30_000,
      lastTaskCompletedAt: BASE_NOW,
      lastIdleDrainActivityAt: T,
      quiescenceWindowMs: 10_000,
    }),
  );
  assert.deepEqual(
    released,
    { release: true, reason: "idle-memory" },
    "release 30s after the relay",
  );
});

// #4 — ttlMs === 0 (the master opt-out) ⇒ never release, either reason, any elapsed.
test("P2 #4: ttlMs === 0 ⇒ never release (both reasons), any elapsed", async () => {
  const deployStale = await decideIdleOwnerRelease(
    input({
      ttlMs: 0,
      now: BASE_NOW + 10 * 60_000,
      lastTaskCompletedAt: BASE_NOW,
      deployDiffers: () => true,
    }),
  );
  assert.deepEqual(deployStale, { release: false }, "ttl 0 blocks deploy-staleness");
  const memory = await decideIdleOwnerRelease(
    input({
      ttlMs: 0,
      now: BASE_NOW + 10 * 60_000,
      lastTaskCompletedAt: BASE_NOW,
      idleReleaseMs: 1,
    }),
  );
  assert.deepEqual(memory, { release: false }, "ttl 0 blocks idle-memory");
});

// #5 — Deploy-staleness intact and takes precedence over idle-memory when both fire.
test("P2 #5: deploy-staleness fires and wins precedence when both reasons hold", async () => {
  // Outdated but only briefly idle (5s < 30s) ⇒ deploy-staleness (clock irrelevant).
  const deployOnly = await decideIdleOwnerRelease(
    input({ now: BASE_NOW + 5_000, lastTaskCompletedAt: BASE_NOW, deployDiffers: () => true }),
  );
  assert.deepEqual(deployOnly, { release: true, reason: "deploy-staleness" });

  // Both fire (outdated AND past the timeout) ⇒ deploy-staleness wins (more specific).
  const both = await decideIdleOwnerRelease(
    input({ now: BASE_NOW + 60_000, lastTaskCompletedAt: BASE_NOW, deployDiffers: () => true }),
  );
  assert.deepEqual(both, { release: true, reason: "deploy-staleness" });

  // The deploy check may be async (real deployedBuildDiffersFromOwner returns a Promise).
  const asyncDeploy = await decideIdleOwnerRelease(
    input({
      now: BASE_NOW + 5_000,
      lastTaskCompletedAt: BASE_NOW,
      deployDiffers: async () => true,
    }),
  );
  assert.deepEqual(asyncDeploy, { release: true, reason: "deploy-staleness" });
});

// #6 — idleReleaseMs === 0 disables ONLY memory-release; deploy-staleness survives.
test("P2 #6: idleReleaseMs === 0 disables memory-release only; deploy-staleness still fires", async () => {
  const noMemory = await decideIdleOwnerRelease(
    input({ now: BASE_NOW + 10 * 60_000, lastTaskCompletedAt: BASE_NOW, idleReleaseMs: 0 }),
  );
  assert.deepEqual(noMemory, { release: false }, "idleReleaseMs 0 ⇒ idle-memory never fires");
  const stillDeploy = await decideIdleOwnerRelease(
    input({
      now: BASE_NOW + 10 * 60_000,
      lastTaskCompletedAt: BASE_NOW,
      idleReleaseMs: 0,
      deployDiffers: () => true,
    }),
  );
  assert.deepEqual(stillDeploy, { release: true, reason: "deploy-staleness" });
});

// #6b — Cost-ordering / short-circuit: the deploy-file read is evaluated ONLY after
// the safety gate already holds (the W13-24-10 short-circuit, preserved by the
// lazy thunk). A drift here is cost-only, never a safety effect — but pin it.
test("P2 #6b: deployDiffers is consulted only once the gate holds (cost-ordering)", async () => {
  let calls = 0;
  const spy = () => {
    calls += 1;
    return true;
  };
  await decideIdleOwnerRelease(input({ hasActiveTurn: true, deployDiffers: spy }));
  assert.equal(calls, 0, "gate closed by active turn ⇒ deploy check not evaluated");
  await decideIdleOwnerRelease(input({ ttlMs: 0, deployDiffers: spy }));
  assert.equal(calls, 0, "gate closed by ttl 0 ⇒ deploy check not evaluated");
  await decideIdleOwnerRelease(
    input({
      lastIdleDrainActivityAt: BASE_NOW,
      now: BASE_NOW + 1_000,
      quiescenceWindowMs: 10_000,
      deployDiffers: spy,
    }),
  );
  assert.equal(calls, 0, "gate closed by non-quiescence ⇒ deploy check not evaluated");
  await decideIdleOwnerRelease(input({ deployDiffers: spy }));
  assert.equal(calls, 1, "gate open ⇒ deploy check evaluated exactly once");
});

// #7 — normalizeOwnerIdleReleaseMs (mirror normalizeQueueOwnerTtlMs in
// session-persistence.test.ts): undefined/NaN/±Infinity/negative → default; 0 → 0
// (disables memory-release only); finite → rounded.
test("P2 #7: normalizeOwnerIdleReleaseMs applies default and edge-case normalization", () => {
  assert.equal(DEFAULT_OWNER_IDLE_RELEASE_MS, 1_800_000);
  assert.equal(normalizeOwnerIdleReleaseMs(undefined), DEFAULT_OWNER_IDLE_RELEASE_MS);
  assert.equal(normalizeOwnerIdleReleaseMs(0), 0);
  assert.equal(normalizeOwnerIdleReleaseMs(-1), DEFAULT_OWNER_IDLE_RELEASE_MS);
  assert.equal(normalizeOwnerIdleReleaseMs(Number.NaN), DEFAULT_OWNER_IDLE_RELEASE_MS);
  assert.equal(
    normalizeOwnerIdleReleaseMs(Number.POSITIVE_INFINITY),
    DEFAULT_OWNER_IDLE_RELEASE_MS,
  );
  assert.equal(
    normalizeOwnerIdleReleaseMs(Number.NEGATIVE_INFINITY),
    DEFAULT_OWNER_IDLE_RELEASE_MS,
  );
  assert.equal(normalizeOwnerIdleReleaseMs(1.6), 2);
  assert.equal(normalizeOwnerIdleReleaseMs(30_000), 30_000);
});
