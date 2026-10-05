/**
 * A message pushed onto a record WHILE its boundary write is appending to the
 * messages log must not be lost (brick://5e7c2a85).
 *
 * The sub-agent tailer pushes onto the live shadow record (`childRecord.messages`)
 * whenever a batch arrives, and the record's save is in flight at the same time.
 * `writeMessagesLogBoundary` used to append `messages.slice(logged)`, await the
 * I/O, and then mark ALL messages logged, including the ones pushed during that
 * await. Those were never appended, and every later write slices past them, so
 * they were gone from disk for good. Lane E's probe found 1–4 such losses per
 * owner per 45 s run, on the base tree as well as with coalescing.
 *
 * The push is injected deterministically inside the append's own `open` call,
 * so the row does not depend on timing.
 */
import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import test from "node:test";
import { resolveSessionRecord, writeSessionRecordAtBoundary } from "../src/session/persistence.js";
import type { SessionMessage } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

function message(i: number): SessionMessage {
  return { Agent: { content: [{ Text: `m${i}` }], tool_results: {} } } as SessionMessage;
}

test("a message pushed during the boundary append is persisted by the next boundary write", async () => {
  await withTempHome("acpx-boundary-push-", async (homeDir) => {
    const record = makeSessionRecord({
      acpxRecordId: "child-record",
      acpSessionId: "child-record-acp",
      agentCommand: "agent",
      cwd: homeDir,
      kind: "subagent",
      messages: [message(0), message(1)],
    });
    await writeSessionRecordAtBoundary(record);
    record.messages.push(message(2));

    const originalOpen = fsPromises.open;
    let injected = 0;
    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const [file, flags] = args;
      if (injected === 0 && flags === "a" && String(file).includes("child-record")) {
        // The tailer delivers a batch while this append is in flight.
        injected += 1;
        record.messages.push(message(3));
      }
      return await originalOpen(...args);
    }) as typeof originalOpen;
    try {
      await writeSessionRecordAtBoundary(record);
    } finally {
      fsPromises.open = originalOpen;
    }
    assert.equal(injected, 1, "the push was never injected into the append");

    await writeSessionRecordAtBoundary(record);
    const onDisk = await resolveSessionRecord("child-record");
    assert.deepEqual(
      onDisk.messages.map((m) => JSON.stringify(m)),
      [0, 1, 2, 3].map((i) => JSON.stringify(message(i))),
      "a message pushed during the append was marked logged but never written",
    );
  });
});
