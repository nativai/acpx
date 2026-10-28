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
  BACKGROUND_TASK_IDLE_RELEASE_HOLD_MS,
  DEFAULT_OWNER_IDLE_RELEASE_MS,
  normalizeOwnerIdleReleaseMs,
} from "../src/cli/session/contracts.js";
import {
  type DecideIdleOwnerReleaseInput,
  IDLE_CHECK_CADENCE_MS,
  decideIdleOwnerRelease,
  idleCheckTimings,
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
    now: BASE_NOW,
    lastIdleDrainActivityAt: 0,
    lastTaskCompletedAt: BASE_NOW,
    quiescenceWindowMs: 10_000,
    idleReleaseMs: 30_000,
    liveBackgroundTaskCount: 0,
    deployDiffers: () => false,
    outputStyleDiffers: () => false,
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
  assert.equal(DEFAULT_OWNER_IDLE_RELEASE_MS, 300_000);
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

// brick://874fee67 — the output-style release reason. Path (B): an owner that is
// idle and never receives another prompt would otherwise hold the stale style
// forever, and the user's change would appear to have done nothing.

// The INVARIANT again, for the new reason specifically. It must sit BEHIND the
// same shared gate: recycling mid-turn is the one thing the accept-anytime
// contract exists to avoid, so an active turn must refuse before the predicate is
// even consulted.
test("output-style: hasActiveTurn ⇒ never release, and the predicate is NOT consulted", async () => {
  let consulted = 0;
  const decision = await decideIdleOwnerRelease(
    input({
      hasActiveTurn: true,
      outputStyleDiffers: () => {
        consulted += 1;
        return true;
      },
    }),
  );
  assert.equal(decision.release, false);
  assert.equal(consulted, 0, "the shared gate must refuse before the style check runs");
});

test("output-style: a pending change releases an idle owner", async () => {
  const decision = await decideIdleOwnerRelease(input({ outputStyleDiffers: () => true }));
  assert.deepEqual(decision, { release: true, reason: "output-style-change" });
});

// Ordering: the more specific, more user-visible reason wins the label. A human
// just asked for this and is watching for it; "deploy-staleness" would be a
// confusing thing to report back.
test("output-style: outranks deploy-staleness when both hold", async () => {
  const decision = await decideIdleOwnerRelease(
    input({ outputStyleDiffers: () => true, deployDiffers: () => true }),
  );
  assert.deepEqual(decision, { release: true, reason: "output-style-change" });
});

// AC-TB4's unit-level mirror: no pending change ⇒ nothing happens. An
// intent-queue implementation would recycle here; the derived predicate does not.
test("output-style: no pending change leaves a current, in-window owner alone", async () => {
  const decision = await decideIdleOwnerRelease(input({ outputStyleDiffers: () => false }));
  assert.equal(decision.release, false);
});

// The documented `--ttl 0` limit, pinned so it is a known bound rather than a
// surprise: path (B) is gated off there and path (A), the turn boundary, covers it.
test("output-style: ttl 0 gates path (B) off (documented limit — path (A) still fires)", async () => {
  const decision = await decideIdleOwnerRelease(
    input({ ttlMs: 0, outputStyleDiffers: () => true }),
  );
  assert.equal(decision.release, false);
});

// ---------------------------------------------------------------------------
// IDLE-CHECK CADENCE (2026-09-07). The suite accumulated 43 live detached owners
// in one run and helped evict the pod. Cause: the check cadence and the
// quiescence window were ONE variable, so an owner could only ask its gate as
// often as its TTL. The fix polls faster while handing the gate the ORIGINAL
// window — these tests pin that they stayed apart.
// ---------------------------------------------------------------------------

// #14 — the poll shortens; the WINDOW DOES NOT. This is the whole fix in one
// assertion, and the one a future "simplify: just reuse pollTimeoutMs" breaks.
test("P2 #14 cadence: the poll is capped at the cadence while the quiescence window is UNCHANGED", () => {
  const ttl = 60 * 60_000; // a --ttl 3600 owner: one hour between checks, before
  const { pollTimeoutMs, quiescenceWindowMs } = idleCheckTimings(ttl);
  assert.equal(pollTimeoutMs, IDLE_CHECK_CADENCE_MS, "asks its gate on the cadence, not the TTL");
  assert.equal(quiescenceWindowMs, ttl, "the gate still gets the FULL TTL-derived window");
  assert.ok(pollTimeoutMs < quiescenceWindowMs, "cadence must be shorter than the window");
});

// #15 — THE DISCRIMINATOR. An owner that relayed background work 30s ago must NOT
// be released. With the correct (full) window it is protected. Substituting the
// SHORT poll as the window — the naive "just poll more often" fix — RELEASES it.
// This test fails on the bug and passes on the fix, which is the only way to know
// the fix addresses the thing it claims to.
test("P2 #15 DISCRIMINATOR: a recently-relaying owner survives the short cadence, and would NOT have under the naive fix", async () => {
  const ttl = 60 * 60_000;
  const { pollTimeoutMs, quiescenceWindowMs } = idleCheckTimings(ttl);
  const relayedRecentlyAt = BASE_NOW - 30_000; // 30s ago: inside the real window

  const correct = await decideIdleOwnerRelease(
    input({
      ttlMs: ttl,
      now: BASE_NOW,
      lastIdleDrainActivityAt: relayedRecentlyAt,
      lastTaskCompletedAt: BASE_NOW - 10 * 60_000,
      quiescenceWindowMs, // the FULL window — what the call site passes
      // MUST be SHORTER than the relay age (30s), or the accumulated-idle CLOCK
      // refuses release in BOTH arms and the test proves nothing about the window.
      // The first version of this test used 60_000 and its control caught that.
      idleReleaseMs: 10_000,
    }),
  );
  assert.equal(correct.release, false, "an owner relaying background work is never torn down");

  const naive = await decideIdleOwnerRelease(
    input({
      ttlMs: ttl,
      now: BASE_NOW,
      lastIdleDrainActivityAt: relayedRecentlyAt,
      lastTaskCompletedAt: BASE_NOW - 10 * 60_000,
      quiescenceWindowMs: pollTimeoutMs ?? 0, // the BUG: window collapsed onto the cadence
      idleReleaseMs: 10_000, // IDENTICAL to the arm above — the window is the ONLY variable
    }),
  );
  assert.equal(
    naive.release,
    true,
    "control: collapsing the window onto the cadence DOES release it — the trap is real, not hypothetical",
  );
});

// #16 — ttl 0 is the master never-recycle opt-out. The cadence must not resurrect
// the idle branch: nextTask(undefined) never times out, so it stays unreachable.
test("P2 #16 cadence: --ttl 0 still yields no poll timeout (idle branch stays structurally unreachable)", () => {
  const { pollTimeoutMs, quiescenceWindowMs } = idleCheckTimings(undefined);
  assert.equal(
    pollTimeoutMs,
    undefined,
    "no timeout ⇒ nextTask never returns empty ⇒ never released",
  );
  assert.equal(quiescenceWindowMs, 0);
});

// #17 — the other direction: a genuinely idle owner IS released once the clock
// passes idleReleaseMs, now noticed within the cadence instead of within the TTL.
test("P2 #17 cadence: a provably-idle owner IS released, and the clock is unchanged by the cadence", async () => {
  const ttl = 60 * 60_000;
  const { quiescenceWindowMs } = idleCheckTimings(ttl);
  const decision = await decideIdleOwnerRelease(
    input({
      ttlMs: ttl,
      now: BASE_NOW + 61_000, // just past a 60s idle timeout
      lastIdleDrainActivityAt: 0, // no relay since spawn ⇒ quiescent
      lastTaskCompletedAt: BASE_NOW,
      quiescenceWindowMs,
      idleReleaseMs: 60_000,
    }),
  );
  assert.equal(decision.release, true);
  assert.equal(decision.reason, "idle-memory");
});

// ---------------------------------------------------------------------------
// brick://a81e16a1 (2026-10-28) — 5-MIN DEFAULT + BACKGROUND-TASK HOLD.
// Daniel moved the default idle-memory release from 30 min to 5 min. An owner
// whose adapter still holds live background tasks keeps the old 30-min window,
// because a release kills them and a silent background job never resets the
// clock. These cases run against the REAL default (normalizeOwnerIdleReleaseMs of
// an unset env), so a default that drifts away from 5 min reds them.
// ---------------------------------------------------------------------------
const MIN = 60_000;
const REAL_DEFAULT_MS = normalizeOwnerIdleReleaseMs(undefined);

// A freshly-idle owner at production timings: --ttl 900 default window, the
// unset-env default timeout, the turn ended at BASE_NOW. Override per case.
function prodIdle(
  idleForMs: number,
  overrides: Partial<DecideIdleOwnerReleaseInput> = {},
): DecideIdleOwnerReleaseInput {
  return input({
    ttlMs: 900_000,
    quiescenceWindowMs: idleCheckTimings(900_000).quiescenceWindowMs,
    now: BASE_NOW + idleForMs,
    lastTaskCompletedAt: BASE_NOW,
    lastIdleDrainActivityAt: 0,
    idleReleaseMs: REAL_DEFAULT_MS,
    ...overrides,
  });
}

test("a81e16a1 #1: with no background task an idle owner is released at 5 min, not before", async () => {
  assert.equal(REAL_DEFAULT_MS, 5 * MIN, "the unset-env default is 5 min");
  assert.deepEqual(await decideIdleOwnerRelease(prodIdle(5 * MIN - 1)), { release: false });
  assert.deepEqual(await decideIdleOwnerRelease(prodIdle(5 * MIN)), {
    release: true,
    reason: "idle-memory",
  });
  assert.deepEqual(await decideIdleOwnerRelease(prodIdle(6 * MIN)), {
    release: true,
    reason: "idle-memory",
  });
});

test("a81e16a1 #2: a live background task holds the owner between 5 and 30 min", async () => {
  assert.equal(BACKGROUND_TASK_IDLE_RELEASE_HOLD_MS, 30 * MIN);
  for (const idleForMs of [5 * MIN, 6 * MIN, 15 * MIN, 30 * MIN - 1]) {
    for (const liveBackgroundTaskCount of [1, 3]) {
      assert.deepEqual(
        await decideIdleOwnerRelease(prodIdle(idleForMs, { liveBackgroundTaskCount })),
        { release: false },
        `held at ${idleForMs}ms idle with ${liveBackgroundTaskCount} live background task(s)`,
      );
    }
  }
});

test("a81e16a1 #3: a live background task is released at 30 min — the hold is a floor, not forever", async () => {
  for (const idleForMs of [30 * MIN, 45 * MIN]) {
    assert.deepEqual(
      await decideIdleOwnerRelease(prodIdle(idleForMs, { liveBackgroundTaskCount: 1 })),
      { release: true, reason: "idle-memory" },
      `released at ${idleForMs}ms idle`,
    );
  }
});

test("a81e16a1 #4: the ACPX_OWNER_IDLE_RELEASE_MS override still wins", async () => {
  // Shorter than the default, no background task: the override governs, not 5 min.
  const twoMin = normalizeOwnerIdleReleaseMs(2 * MIN);
  assert.deepEqual(await decideIdleOwnerRelease(prodIdle(2 * MIN, { idleReleaseMs: twoMin })), {
    release: true,
    reason: "idle-memory",
  });
  // Longer than the hold: max() keeps the override, with or without a background task.
  const hour = normalizeOwnerIdleReleaseMs(60 * MIN);
  for (const liveBackgroundTaskCount of [0, 1]) {
    assert.deepEqual(
      await decideIdleOwnerRelease(
        prodIdle(45 * MIN, { idleReleaseMs: hour, liveBackgroundTaskCount }),
      ),
      { release: false },
      `60-min override not yet reached at 45 min (bg=${liveBackgroundTaskCount})`,
    );
    assert.deepEqual(
      await decideIdleOwnerRelease(
        prodIdle(60 * MIN, { idleReleaseMs: hour, liveBackgroundTaskCount }),
      ),
      { release: true, reason: "idle-memory" },
      `60-min override reached (bg=${liveBackgroundTaskCount})`,
    );
  }
  // A short override with a background task is still floored at the hold.
  assert.deepEqual(
    await decideIdleOwnerRelease(
      prodIdle(10 * MIN, { idleReleaseMs: twoMin, liveBackgroundTaskCount: 1 }),
    ),
    { release: false },
  );
});

test("a81e16a1 #5: override 0 stays OFF with a background task — the hold must not re-enable it", async () => {
  assert.deepEqual(
    await decideIdleOwnerRelease(
      prodIdle(10 * 60 * MIN, { idleReleaseMs: 0, liveBackgroundTaskCount: 1 }),
    ),
    { release: false },
  );
});

test("a81e16a1 #6: the hold is idle-memory only — deploy-staleness and output-style still release", async () => {
  assert.deepEqual(
    await decideIdleOwnerRelease(
      prodIdle(1 * MIN, { liveBackgroundTaskCount: 1, deployDiffers: () => true }),
    ),
    { release: true, reason: "deploy-staleness" },
  );
  assert.deepEqual(
    await decideIdleOwnerRelease(
      prodIdle(1 * MIN, { liveBackgroundTaskCount: 1, outputStyleDiffers: () => true }),
    ),
    { release: true, reason: "output-style-change" },
  );
});

test("a81e16a1 #7: the shared gate is unchanged — an active turn or recent relay blocks the 5-min release", async () => {
  assert.deepEqual(await decideIdleOwnerRelease(prodIdle(60 * MIN, { hasActiveTurn: true })), {
    release: false,
  });
  // Relay 10 min ago: the idle CLOCK (10 min) is past the 5-min default, so only
  // the 15-min quiescence window can hold it — and it must. With a 5-min default
  // the window, not the clock, is the binding constraint after relay activity.
  assert.deepEqual(
    await decideIdleOwnerRelease(
      prodIdle(60 * MIN, { lastIdleDrainActivityAt: BASE_NOW + 50 * MIN }),
    ),
    { release: false },
    "relay inside the quiescence window blocks release",
  );
  assert.deepEqual(
    await decideIdleOwnerRelease(
      prodIdle(60 * MIN, { lastIdleDrainActivityAt: BASE_NOW + 45 * MIN }),
    ),
    { release: true, reason: "idle-memory" },
    "control: the same owner is released once the relay is a full window old",
  );
  // The cadence/window split at the production --ttl 900: ask every 5 s, keep the
  // full 15-min window.
  assert.equal(IDLE_CHECK_CADENCE_MS, 5_000);
  assert.deepEqual(idleCheckTimings(900_000), {
    pollTimeoutMs: 5_000,
    quiescenceWindowMs: 900_000,
  });
});
