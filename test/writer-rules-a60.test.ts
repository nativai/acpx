// A-60 / C3.5 (i) — the writers of a session's messages log. Rows 60.3 (the record-level shape), 60.6,
// 60.7, 60.8 and 60.9 of the committed test plan (brick f67e0ff1). The production-shape rows (a real
// `acpx sessions close`, a real `acpx flow run`, a real queue owner) are in writer-rules-a60-cli.test.ts.
//
// The probe (brick c917d9c9) found one primitive under every loss: `appendFinalizedMessagesToLog`
// truncated `messages.ndjson` to the writer's IN-MEMORY watermark before appending, so any writer that
// read, waited and then appended erased what another writer appended in between. Every row here puts
// TWO copies of one record in this process — the "owner" (the writer that created its entries) and an
// "outside" writer that read earlier — and asserts what the disk holds after both have written.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { appendAtMeasuredEnd, messagesLogPath } from "../src/session/messages-log.js";
import {
  resolveSessionRecord,
  writeSessionRecord,
  writeSessionRecordAtBoundary,
} from "../src/session/persistence.js";
import type { SessionMessage, SessionRecord } from "../src/types.js";
import { makeSessionRecord, sessionFilePath, withTempHome } from "./runtime-test-helpers.js";

function user(id: string, text: string): SessionMessage {
  return { User: { id, content: [{ Text: text }] } };
}

function agent(text: string): SessionMessage {
  return { Agent: { content: [{ Text: text }], tool_results: {} } };
}

function setAgentText(message: SessionMessage, text: string): void {
  if (typeof message === "string" || !("Agent" in message)) {
    throw new Error("not an agent message");
  }
  message.Agent.content = [{ Text: text }];
}

function newRecord(homeDir: string, id: string, messages: SessionMessage[]): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand: "agent",
    cwd: homeDir,
    messages,
  });
}

type RawRecord = {
  messages: unknown[];
  messages_log?: { v: number; count: number; base_index: number; bytes: number };
};

async function rawRecord(homeDir: string, id: string): Promise<RawRecord> {
  return JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as RawRecord;
}

function logPathOf(homeDir: string, id: string): string {
  return messagesLogPath(path.join(homeDir, ".acpx", "sessions"), id);
}

/** Every line of the log must parse: a torn line is the F4-rev corruption. Returns the entries' texts. */
async function logTexts(homeDir: string, id: string): Promise<string[]> {
  const raw = await fs.readFile(logPathOf(homeDir, id), "utf8");
  assert.ok(raw === "" || raw.endsWith("\n"), "the log ends at a line boundary");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed = JSON.parse(line) as {
        User?: { content: { Text: string }[] };
        Agent?: { content: { Text: string }[] };
      };
      return (parsed.User ?? parsed.Agent)?.content.map((part) => part.Text).join("") ?? "";
    });
}

async function inlineTexts(homeDir: string, id: string): Promise<string[]> {
  return (await rawRecord(homeDir, id)).messages.map(
    (entry) =>
      (entry as { Agent?: { content: { Text: string }[] } }).Agent?.content
        .map((part) => part.Text)
        .join("") ?? "?",
  );
}

async function assertPointerMatchesLog(homeDir: string, id: string): Promise<void> {
  const raw = await rawRecord(homeDir, id);
  const stat = await fs.stat(logPathOf(homeDir, id));
  assert.equal(raw.messages_log?.bytes, stat.size, "the published watermark is the log's end");
  assert.equal(raw.messages_log?.count, (await logTexts(homeDir, id)).length);
}

// ---------------------------------------------------------------------------------------------
// 60.7 — the cut: a complete line is never cut; an incomplete tail is
// ---------------------------------------------------------------------------------------------

async function withLogFile<T>(
  contents: string,
  run: (logPath: string, dir: string) => Promise<T>,
): Promise<T> {
  return await withTempHome("acpx-a60-cut-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(dir, { recursive: true });
    const logPath = path.join(dir, "cut.messages.ndjson");
    await fs.writeFile(logPath, contents, "utf8");
    return await run(logPath, dir);
  });
}

const L1 = JSON.stringify(user("u1", "one"));
const L2 = JSON.stringify(agent("two"));
const L3 = JSON.stringify(agent("three"));
const X = agent("appended");

test("60.7 (a): an incomplete tail is cut back to the last newline, then the entry is appended", async () => {
  const torn = `{"Agent":{"content":[{"Te`;
  await withLogFile(`${L1}\n${L2}\n${torn}`, async (logPath) => {
    const bytes = Buffer.byteLength(`${L1}\n${L2}\n`);
    const measured = await appendAtMeasuredEnd(logPath, { v: 1, count: 2, base_index: 0, bytes }, [
      X,
    ]);
    assert.equal(await fs.readFile(logPath, "utf8"), `${L1}\n${L2}\n${JSON.stringify(X)}\n`);
    assert.equal(measured.state.count, 3);
    assert.equal(measured.state.bytes, (await fs.stat(logPath)).size);
    assert.equal(measured.adopted, 0);
  });
});

test("60.7 (b): two complete lines past the writer's watermark are adopted, never cut", async () => {
  await withLogFile(`${L1}\n${L2}\n${L3}\n`, async (logPath) => {
    // The writer's watermark is after L1 only: another writer appended L2 and L3 since.
    const bytes = Buffer.byteLength(`${L1}\n`);
    const measured = await appendAtMeasuredEnd(logPath, { v: 1, count: 1, base_index: 0, bytes }, [
      X,
    ]);
    assert.equal(
      await fs.readFile(logPath, "utf8"),
      `${L1}\n${L2}\n${L3}\n${JSON.stringify(X)}\n`,
      "nothing was cut: the appended entry follows BOTH complete lines",
    );
    assert.equal(measured.adopted, 2);
    assert.equal(measured.state.count, 4);
    assert.equal(measured.state.bytes, (await fs.stat(logPath)).size);
  });
});

test("60.7 (negative): a watermark past the end, or inside a line, never cuts a complete line", async () => {
  const whole = `${L1}\n${L2}\n`;
  await withLogFile(whole, async (logPath) => {
    // Past the end: the log is shorter than the writer believes (a compaction by another writer).
    await appendAtMeasuredEnd(logPath, { v: 1, count: 9, base_index: 0, bytes: 99_999 }, [X]);
    assert.equal(await fs.readFile(logPath, "utf8"), `${whole}${JSON.stringify(X)}\n`);
  });
  await withLogFile(whole, async (logPath) => {
    // Inside L2: a torn watermark an older build published (the F4-rev idle-release republish).
    const inside = Buffer.byteLength(`${L1}\n`) + 7;
    await appendAtMeasuredEnd(logPath, { v: 1, count: 1, base_index: 0, bytes: inside }, [X]);
    assert.equal(
      await fs.readFile(logPath, "utf8"),
      `${whole}${JSON.stringify(X)}\n`,
      "the pointer moved back to the line boundary; the line it stood in is whole",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 60.8 — only its own entries: an outside writer never logs another writer's inline entry
// ---------------------------------------------------------------------------------------------

test("60.8: an outside writer logs exactly its own entry; the owner's partial stays unlogged until the owner's boundary", async () => {
  await withTempHome("acpx-a60-own-", async (homeDir) => {
    const id = "own-entries";
    // The OWNER: it created every entry it holds. One boundary, then a streamed partial checkpointed inline.
    const owner = newRecord(homeDir, id, [user("u1", "go")]);
    await writeSessionRecordAtBoundary(owner);
    const partial = agent("partial");
    owner.messages.push(partial);
    await writeSessionRecord(owner);
    assert.deepEqual(await logTexts(homeDir, id), ["go"]);
    assert.deepEqual(await inlineTexts(homeDir, id), ["partial"]);

    // An OUTSIDE writer: its copy holds the owner's partial inline, as loaded; it adds one entry of its own.
    const outside = await resolveSessionRecord(id);
    assert.equal(outside.messages.length, 2, "its copy holds the owner's partial");
    outside.messages.push(agent("outside notice"));
    await writeSessionRecordAtBoundary(outside);

    assert.deepEqual(
      await logTexts(homeDir, id),
      ["go", "outside notice"],
      "the log gained exactly the outside writer's entry — not the owner's partial",
    );
    assert.deepEqual(
      await inlineTexts(homeDir, id),
      ["partial"],
      "the owner's partial is still its own, inline",
    );
    await assertPointerMatchesLog(homeDir, id);

    // The owner finishes: its own boundary logs its reply, once, and the inline entry goes.
    setAgentText(partial, "partial and the final reply");
    await writeSessionRecordAtBoundary(owner);
    assert.deepEqual(await logTexts(homeDir, id), [
      "go",
      "outside notice",
      "partial and the final reply",
    ]);
    assert.deepEqual(await inlineTexts(homeDir, id), []);
    await assertPointerMatchesLog(homeDir, id);
  });
});

// ---------------------------------------------------------------------------------------------
// 60.9 — a write publishes the measured watermark and only its own unfinished inline entries
// ---------------------------------------------------------------------------------------------

test("60.9 (the F4-rev / idle-release shape): a scalar write from a stale copy republishes what the other writer published", async () => {
  await withTempHome("acpx-a60-stale-", async (homeDir) => {
    const id = "stale-scalar";
    const owner = newRecord(homeDir, id, [user("u1", "go")]);
    await writeSessionRecordAtBoundary(owner);
    const partial = agent("partial");
    owner.messages.push(partial);
    await writeSessionRecord(owner);

    // The stale copy: read while the owner's partial was inline (the idle owner's / `acpx set-mode`'s copy).
    const stale = await resolveSessionRecord(id);

    // The owner ends its turn; another writer appends a notice behind it.
    setAgentText(partial, "the final reply");
    await writeSessionRecordAtBoundary(owner);
    const notice = await resolveSessionRecord(id);
    notice.messages.push(agent("a notice"));
    await writeSessionRecordAtBoundary(notice);
    assert.deepEqual(await logTexts(homeDir, id), ["go", "the final reply", "a notice"]);
    const published = (await rawRecord(homeDir, id)).messages_log;

    // The stale copy writes a scalar (not a boundary): it holds the old partial and the old watermark.
    stale.lastPromptAt = "2026-02-02T00:00:00.000Z";
    await writeSessionRecord(stale);

    const after = await rawRecord(homeDir, id);
    assert.deepEqual(
      after.messages_log,
      published,
      "the watermark is the one the other writer published",
    );
    assert.deepEqual(after.messages, [], "the stale partial is not published again as inline");
    assert.deepEqual(await logTexts(homeDir, id), ["go", "the final reply", "a notice"]);

    // Then a later write of the stale copy's kind — an idle release — and a later queue turn: no torn line.
    await writeSessionRecord(stale);
    const next = await resolveSessionRecord(id);
    next.messages.push(user("u2", "the next prompt"));
    await writeSessionRecordAtBoundary(next);
    assert.deepEqual(await logTexts(homeDir, id), [
      "go",
      "the final reply",
      "a notice",
      "the next prompt",
    ]);
    await assertPointerMatchesLog(homeDir, id);
  });
});

test("60.9 (control): the owner's checkpoint publishes its own partial with the measured watermark", async () => {
  await withTempHome("acpx-a60-ctl-", async (homeDir) => {
    const id = "owner-checkpoint";
    const owner = newRecord(homeDir, id, [user("u1", "go")]);
    await writeSessionRecordAtBoundary(owner);
    // Another writer appends while the owner's copy still believes the log ends after "go".
    const other = await resolveSessionRecord(id);
    other.messages.push(agent("a notice"));
    await writeSessionRecordAtBoundary(other);

    const partial = agent("owner partial");
    owner.messages.push(partial);
    await writeSessionRecord(owner);
    const afterCheckpoint = await rawRecord(homeDir, id);
    assert.equal(afterCheckpoint.messages_log?.count, 2, "the measured count includes the notice");
    assert.equal(afterCheckpoint.messages_log?.bytes, (await fs.stat(logPathOf(homeDir, id))).size);
    assert.deepEqual(await inlineTexts(homeDir, id), ["owner partial"]);

    setAgentText(partial, "owner reply");
    await writeSessionRecordAtBoundary(owner);
    assert.deepEqual(await logTexts(homeDir, id), ["go", "a notice", "owner reply"]);
    assert.deepEqual(await inlineTexts(homeDir, id), []);
    await assertPointerMatchesLog(homeDir, id);
  });
});

// ---------------------------------------------------------------------------------------------
// 60.3 (record level) — F4-rev: a writer that read before another appended and published
// ---------------------------------------------------------------------------------------------

test("60.3 (record level): a notice written after the owner's turn end, from a copy read before it, keeps the reply and tears no line", async () => {
  await withTempHome("acpx-a60-f4rev-", async (homeDir) => {
    const id = "f4-rev";
    const owner = newRecord(homeDir, id, [user("u1", "echo Q")]);
    await writeSessionRecordAtBoundary(owner);
    const reply = agent("owner reply");
    owner.messages.push(reply);
    // The flow read the record while the owner was mid-turn (the reply not yet in the log) …
    const flow = await resolveSessionRecord(id);
    // … the owner's turn ends first …
    await writeSessionRecordAtBoundary(owner);
    // … and only then the flow's pre-submit refusal mirror lands, from the old copy.
    flow.messages.push(agent("⚠ turn failed: refused"));
    await writeSessionRecordAtBoundary(flow);

    assert.deepEqual(await logTexts(homeDir, id), [
      "echo Q",
      "owner reply",
      "⚠ turn failed: refused",
    ]);
    // The owner's idle release rewrites its record from its own copy (its watermark is the old one).
    await writeSessionRecord(owner);
    // A later queue turn appends behind it.
    const later = await resolveSessionRecord(id);
    later.messages.push(user("u2", "echo Q2"));
    await writeSessionRecordAtBoundary(later);
    assert.deepEqual(await logTexts(homeDir, id), [
      "echo Q",
      "owner reply",
      "⚠ turn failed: refused",
      "echo Q2",
    ]);
    await assertPointerMatchesLog(homeDir, id);
  });
});

// ---------------------------------------------------------------------------------------------
// 60.6 — compaction keeps the file's own tail
// ---------------------------------------------------------------------------------------------

test("60.6: a compaction by a stale writer keeps the entries another writer appended after its read", async () => {
  await withTempHome("acpx-a60-compact-", async (homeDir) => {
    const previous = process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES;
    process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES = "1";
    try {
      const id = "compact-stale";
      const writerA = newRecord(homeDir, id, [user("a1", "a-first")]);
      await writeSessionRecordAtBoundary(writerA);
      const writerB = await resolveSessionRecord(id);
      writerB.messages.push(agent("b-one"), agent("b-two"));
      await writeSessionRecordAtBoundary(writerB);

      // A has not read B's two entries; its unbounded boundary write crosses the threshold and compacts.
      writerA.messages.push(agent("a-second"));
      await writeSessionRecordAtBoundary(writerA);

      assert.deepEqual(await logTexts(homeDir, id), ["a-first", "b-one", "b-two", "a-second"]);
      await assertPointerMatchesLog(homeDir, id);

      // Control: a compaction by the writer that read last keeps the same tail.
      const reader = await resolveSessionRecord(id);
      reader.messages.push(agent("reader-last"));
      await writeSessionRecordAtBoundary(reader);
      assert.deepEqual(await logTexts(homeDir, id), [
        "a-first",
        "b-one",
        "b-two",
        "a-second",
        "reader-last",
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES;
      } else {
        process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES = previous;
      }
    }
  });
});
