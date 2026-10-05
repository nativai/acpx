import assert from "node:assert/strict";
import test from "node:test";
import { OutboxError } from "../src/brick-outbox.js";
import { LiveSessionCheckpoint } from "../src/session/live-checkpoint.js";

/**
 * brick://48aca560 — a checkpoint that fails silently is indistinguishable from
 * a healthy session, and that is exactly how a frozen session record went
 * unnoticed for four bisect sessions. These pin the REPORTING, not the saving.
 */

async function captureStderr(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  // Node types this overload set broadly; the test only ever receives strings.
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
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

/** Let the `request()` timer fire and its rejected flush settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

test("a failing checkpoint reports itself with NO onError supplied", async () => {
  const captured = await captureStderr(async () => {
    const checkpoint = new LiveSessionCheckpoint({
      intervalMs: 1,
      save: () =>
        Promise.reject(new Error("Persisted key policy violation: acpx.cost_units.cacheRead")),
    });
    checkpoint.request();
    await settle();
  });

  // The default must fire — `runtime/engine/manager.ts` supplies no onError at
  // all, so anything weaker than a reporting default leaves it silent.
  assert.match(captured, /checkpoint FAILED/);
  // It must name the CONSEQUENCE, not just the error: "checkpoint failed" alone
  // does not tell a reader their session has stopped persisting.
  assert.match(captured, /stopped being written to disk/);
  assert.match(captured, /acpx\.cost_units\.cacheRead/);
});

// brick://b8e251eb — the banner used to blame "a non-snake_case persisted key" for
// EVERY failure, including the outbox-busy lock timeouts of 2026-10-05.
async function reportFor(error: Error): Promise<string> {
  return await captureStderr(async () => {
    const checkpoint = new LiveSessionCheckpoint({
      intervalMs: 1,
      save: () => Promise.reject(error),
    });
    checkpoint.request();
    await settle();
  });
}

test("b8e251eb: an outbox-busy checkpoint failure is named as lock contention, never as a key-policy violation", async () => {
  const captured = await reportFor(
    new OutboxError("outbox-busy", "session write refused: outbox-busy; retry the operation"),
  );
  assert.match(captured, /checkpoint FAILED/);
  assert.match(captured, /OutboxError outbox-busy/);
  assert.doesNotMatch(captured, /snake_case/);
});

test("b8e251eb: an unrelated failure is not blamed on the key policy either", async () => {
  const captured = await reportFor(new Error("EACCES: permission denied, open '/x'"));
  assert.match(captured, /not a persisted-key violation/);
  assert.doesNotMatch(captured, /non-snake_case persisted key \(/);
});

test("b8e251eb CONTROL: a real key-policy violation still names the key policy", async () => {
  const captured = await reportFor(
    new Error("Persisted key policy violation (expected snake_case keys): acpx.costUnits"),
  );
  assert.match(captured, /non-snake_case persisted key/);
  assert.match(captured, /persisted-key-policy\.ts/);
});

test("CONTROL: a checkpoint that succeeds reports nothing", async () => {
  const captured = await captureStderr(async () => {
    const checkpoint = new LiveSessionCheckpoint({
      intervalMs: 1,
      save: () => Promise.resolve(),
    });
    checkpoint.request();
    await settle();
  });

  assert.equal(captured, "");
});

test("a persistent identical failure is reported once, a NEW failure still reports", async () => {
  let message = "first failure";
  const checkpoint = new LiveSessionCheckpoint({
    intervalMs: 1,
    save: () => Promise.reject(new Error(message)),
  });

  const firstRound = await captureStderr(async () => {
    for (let i = 0; i < 3; i += 1) {
      checkpoint.request();
      await settle();
    }
  });
  assert.equal(firstRound.match(/checkpoint FAILED/g)?.length, 1, firstRound);

  // A DIFFERENT failure mode must not be swallowed by the deduplication — that
  // would trade one silence for another.
  message = "second, different failure";
  const secondRound = await captureStderr(async () => {
    checkpoint.request();
    await settle();
  });
  assert.match(secondRound, /second, different failure/);
});

test("an explicit onError still wins over the reporting default", async () => {
  const seen: unknown[] = [];
  const captured = await captureStderr(async () => {
    const checkpoint = new LiveSessionCheckpoint({
      intervalMs: 1,
      save: () => Promise.reject(new Error("routed")),
      onError: (error) => seen.push(error),
    });
    checkpoint.request();
    await settle();
  });

  assert.equal(seen.length, 1);
  assert.equal(captured, "");
});
