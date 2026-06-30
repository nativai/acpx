// Unit coverage for the injected-prompt drain backstop
// (drainInjectedPromptsWithBackstop), the bound that stops a pathological
// injected prompt from wedging the queue owner's turn forever
// (bugs/stuck-red-turn-end-not-persisted #1 backstop).
//
// Two core guarantees, plus the boundary cases:
//   (i)  normal completion — every injected promise is awaited to completion
//        (NO truncation), the shared timer is cleared so the call returns as
//        soon as they settle (it must not wait out a generous deadline), and
//        the diagnostic callback never fires.
//   (ii) a never-resolving injected prompt — the drain finalizes at the
//        deadline, reporting the count of still-pending injected prompts to the
//        diagnostic callback exactly once, so the turn can close.

import assert from "node:assert/strict";
import test from "node:test";
import { drainInjectedPromptsWithBackstop } from "../src/cli/session/runtime.js";

test("drain backstop: empty set returns immediately without invoking the diagnostic", async () => {
  let timeoutCalls = 0;
  const result = await drainInjectedPromptsWithBackstop([], 1_000, () => {
    timeoutCalls += 1;
  });
  assert.deepEqual(result, { timedOut: false, pending: 0 });
  assert.equal(timeoutCalls, 0);
});

test("drain backstop: all injected prompts settle before the deadline → no truncation, no diagnostic, returns promptly", async () => {
  let settled = 0;
  const fast = Promise.resolve().then(() => {
    settled += 1;
  });
  const slower = new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() => {
    settled += 1;
  });

  let timeoutCalls = 0;
  const start = Date.now();
  // A deliberately huge deadline: a correct implementation clears the timer on
  // normal settle and returns as soon as both promises resolve, rather than
  // waiting the full 60s out.
  const result = await drainInjectedPromptsWithBackstop([fast, slower], 60_000, () => {
    timeoutCalls += 1;
  });
  const elapsedMs = Date.now() - start;

  assert.equal(settled, 2, "both injected prompts were awaited to completion (no truncation)");
  assert.deepEqual(result, { timedOut: false, pending: 0 });
  assert.equal(timeoutCalls, 0, "diagnostic callback not invoked on a normal settle");
  assert.ok(
    elapsedMs < 5_000,
    `returned promptly (${elapsedMs}ms) — the backstop timer did not hold the call open`,
  );
});

test("drain backstop: an injected prompt that outlives the deadline finalizes at the deadline with the still-pending count", async () => {
  const settles = Promise.resolve();
  // Simulates the pathological case (e.g. an agent that stays alive but never
  // returns a stop reason in time): this prompt only settles at 200ms, well
  // past the 30ms backstop. It still settles eventually so the test leaves no
  // dangling promise — by then the drain has long since finalized.
  const outlivesDeadline = new Promise<void>((resolve) => setTimeout(resolve, 200));

  let timeoutCalls = 0;
  let reportedPending = -1;
  const result = await drainInjectedPromptsWithBackstop(
    [settles, outlivesDeadline],
    30,
    (pending) => {
      timeoutCalls += 1;
      reportedPending = pending;
    },
  );

  assert.deepEqual(result, { timedOut: true, pending: 1 });
  assert.equal(timeoutCalls, 1, "diagnostic callback fired exactly once on expiry");
  assert.equal(reportedPending, 1, "diagnostic reports the one still-pending injected prompt");

  // Let the straggler settle so no promise is left pending for the runner.
  await outlivesDeadline;
});

test("drain backstop: timeoutMs=0 is unbounded — awaits the injected prompt to completion", async () => {
  let settled = false;
  const eventual = new Promise<void>((resolve) => setTimeout(resolve, 10)).then(() => {
    settled = true;
  });

  let timeoutCalls = 0;
  const result = await drainInjectedPromptsWithBackstop([eventual], 0, () => {
    timeoutCalls += 1;
  });

  assert.equal(settled, true, "the injected prompt was awaited despite no backstop");
  assert.deepEqual(result, { timedOut: false, pending: 0 });
  assert.equal(timeoutCalls, 0);
});
