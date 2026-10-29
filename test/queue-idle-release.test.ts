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
  IDLE_CHECK_CADENCE_MS,
  decideIdleOwnerRelease,
  formatOwnerReleaseLine,
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
// brick://a81e16a1 (2026-10-28) — 5-MIN DEFAULT, and brick://0c593c10
// (2026-10-29) — A LIVE BACKGROUND TASK IS NEVER RELEASED. Daniel moved the default
// idle-memory release from 30 min to 5 min, then decided that a session whose
// adapter still holds a live background task is RUNNING: it closes the shared
// gate for every reason, with no time cap (8f539d53's 30-min floor is gone). These
// cases run against the REAL default (normalizeOwnerIdleReleaseMs of an unset
// env), so a default that drifts away from 5 min reds them.
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

// Idle ages from just past the 5-min default to a week, the ones 8f539d53 released
// at (30 min) and the T9 self-test checkpoint (35 min) included.
const BACKGROUND_IDLE_AGES = [5 * MIN, 30 * MIN, 35 * MIN, 24 * 60 * MIN, 7 * 24 * 60 * MIN];

// The three release reasons, each made true on its own. The thunks count their
// calls: with a live task the gate must refuse BEFORE either is consulted.
function everyReason(): Array<{
  reason: "idle-memory" | "deploy-staleness" | "output-style-change";
  overrides: Partial<DecideIdleOwnerReleaseInput>;
  consulted: () => number;
}> {
  let deployCalls = 0;
  let styleCalls = 0;
  const deployDiffers = () => {
    deployCalls += 1;
    return true;
  };
  const outputStyleDiffers = () => {
    styleCalls += 1;
    return true;
  };
  return [
    { reason: "idle-memory", overrides: {}, consulted: () => 0 },
    { reason: "deploy-staleness", overrides: { deployDiffers }, consulted: () => deployCalls },
    {
      reason: "output-style-change",
      overrides: { outputStyleDiffers },
      consulted: () => styleCalls,
    },
  ];
}

test("0c593c10 #1: a live background task blocks EVERY release reason at ANY idle age — no time cap", async () => {
  for (const { reason, overrides, consulted } of everyReason()) {
    for (const idleForMs of BACKGROUND_IDLE_AGES) {
      for (const liveBackgroundTaskCount of [1, 3]) {
        assert.deepEqual(
          await decideIdleOwnerRelease(
            prodIdle(idleForMs, { ...overrides, liveBackgroundTaskCount }),
          ),
          { release: false },
          `${reason}: held at ${idleForMs}ms idle with ${liveBackgroundTaskCount} live task(s)`,
        );
      }
    }
    assert.equal(consulted(), 0, `${reason}: the gate refuses before the reason is consulted`);
  }
});

test("0c593c10 #2: control — WITHOUT a live task the same inputs release for each reason, unchanged", async () => {
  for (const { reason, overrides } of everyReason()) {
    for (const idleForMs of BACKGROUND_IDLE_AGES) {
      assert.deepEqual(
        await decideIdleOwnerRelease(
          prodIdle(idleForMs, { ...overrides, liveBackgroundTaskCount: 0 }),
        ),
        { release: true, reason },
        `${reason} at ${idleForMs}ms idle`,
      );
    }
  }
});

test("a81e16a1 #4: the ACPX_OWNER_IDLE_RELEASE_MS override still wins — and never outranks a live task", async () => {
  // Shorter than the default, no background task: the override governs, not 5 min.
  const twoMin = normalizeOwnerIdleReleaseMs(2 * MIN);
  assert.deepEqual(await decideIdleOwnerRelease(prodIdle(2 * MIN, { idleReleaseMs: twoMin })), {
    release: true,
    reason: "idle-memory",
  });
  // Longer than the default: honoured exactly.
  const hour = normalizeOwnerIdleReleaseMs(60 * MIN);
  assert.deepEqual(await decideIdleOwnerRelease(prodIdle(45 * MIN, { idleReleaseMs: hour })), {
    release: false,
  });
  assert.deepEqual(await decideIdleOwnerRelease(prodIdle(60 * MIN, { idleReleaseMs: hour })), {
    release: true,
    reason: "idle-memory",
  });
  // With a live task neither a short nor a long override releases, at any age.
  for (const idleReleaseMs of [twoMin, hour]) {
    assert.deepEqual(
      await decideIdleOwnerRelease(
        prodIdle(24 * 60 * MIN, { idleReleaseMs, liveBackgroundTaskCount: 1 }),
      ),
      { release: false },
    );
  }
});

test("a81e16a1 #5: override 0 stays OFF for idle-memory, task or not", async () => {
  for (const liveBackgroundTaskCount of [0, 1]) {
    assert.deepEqual(
      await decideIdleOwnerRelease(
        prodIdle(10 * 60 * MIN, { idleReleaseMs: 0, liveBackgroundTaskCount }),
      ),
      { release: false },
    );
  }
});

test("0c593c10 #3: once the last task ends, the normal rules apply — the 5-min clock and the quiescence window", async () => {
  // The task ran 40 min; its end arrived as a notification turn that completed at
  // T+40 min (the clock restarts there), or as inter-turn relay at T+40 min (the
  // 15-min quiescence window applies from there).
  const ended = BASE_NOW + 40 * MIN;
  const afterTurn = (minutes: number) =>
    prodIdle(0, { now: BASE_NOW + minutes * MIN, lastTaskCompletedAt: ended });
  assert.deepEqual(await decideIdleOwnerRelease(afterTurn(44)), { release: false });
  assert.deepEqual(await decideIdleOwnerRelease(afterTurn(45)), {
    release: true,
    reason: "idle-memory",
  });
  const afterRelay = (minutes: number) =>
    prodIdle(0, { now: BASE_NOW + minutes * MIN, lastIdleDrainActivityAt: ended });
  assert.deepEqual(await decideIdleOwnerRelease(afterRelay(54)), { release: false });
  assert.deepEqual(await decideIdleOwnerRelease(afterRelay(55)), {
    release: true,
    reason: "idle-memory",
  });
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

// ---------------------------------------------------------------------------
// brick a81e16a1 (R4) — the diagnosable release line. The old text must survive
// BYTE-IDENTICAL up to and including `(reason=…)` and the sentence after it;
// at=, idle= and live_background_tasks= are appended.
// ---------------------------------------------------------------------------
const PRE_R4_LINE =
  "[acpx] queue owner releasing session s-1 (reason=idle-memory); next prompt cold-respawns with context";

test("a81e16a1 R4: the release line keeps the old text byte-identical and appends at/idle/live_background_tasks", () => {
  const line = formatOwnerReleaseLine({
    sessionId: "s-1",
    reason: "idle-memory",
    at: Date.parse("2026-10-29T00:40:05.123Z"),
    idleMs: 302_400,
    liveBackgroundTasks: 0,
  });
  assert.equal(
    line,
    `${PRE_R4_LINE}; at=2026-10-29T00:40:05.123Z idle=5m02s live_background_tasks=0\n`,
  );
  assert.ok(line.startsWith(PRE_R4_LINE), "the pre-R4 text is a byte-identical prefix");
});

test("a81e16a1 R4: idle age floors to whole seconds and zero-pads them", () => {
  const idle = (idleMs: number) =>
    /idle=(\S+) /.exec(
      formatOwnerReleaseLine({
        sessionId: "s",
        reason: "idle-memory",
        at: 0,
        idleMs,
        liveBackgroundTasks: 0,
      }),
    )?.[1];
  assert.equal(idle(0), "0m00s");
  assert.equal(idle(59_999), "0m59s");
  assert.equal(idle(60_000), "1m00s");
  assert.equal(idle(1_800_000), "30m00s");
  assert.equal(idle(3_725_000), "62m05s");
  assert.equal(idle(-5), "0m00s", "a clock step backwards never prints a negative age");
});

test("a81e16a1 R4: the line names the reason and the live background-task count it killed", () => {
  const line = formatOwnerReleaseLine({
    sessionId: "s-2",
    reason: "deploy-staleness",
    at: 0,
    idleMs: 61_000,
    liveBackgroundTasks: 3,
  });
  assert.ok(
    line.startsWith("[acpx] queue owner releasing session s-2 (reason=deploy-staleness); "),
  );
  assert.match(line, / live_background_tasks=3\n$/);
  assert.match(line, / at=1970-01-01T00:00:00\.000Z /);
});
