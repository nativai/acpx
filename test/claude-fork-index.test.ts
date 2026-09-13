import assert from "node:assert/strict";
import test from "node:test";
import { resolveClaudeForkCut } from "../src/acp/claude-fork-index.js";

// brick://4d6cb66d — the fork cut resolver must interpret --at-index in the
// RECORD WINDOW space (the MAX_RUNTIME_MESSAGES-capped tail of the conversation)
// and remap it onto the transcript tail, plus refuse cuts that provably sit
// before the last compaction boundary (Claude Code's resume-at cannot reach
// them; they surfaced as the unclassified -32603 "Internal error").

let seq = 0;
function userLine(text = "user message"): string {
  return JSON.stringify({
    type: "user",
    uuid: `u${++seq}`.padEnd(8, "0"),
    message: { content: text },
    timestamp: "2026-09-13T10:00:00.000Z",
  });
}
function assistantLine(): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `a${++seq}`.padEnd(8, "0"),
    message: { content: [{ type: "text", text: "assistant reply" }] },
    timestamp: "2026-09-13T10:00:01.000Z",
  });
}
function pair(): string[] {
  return [userLine(), assistantLine()];
}
function boundaryLine(): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    uuid: `b${++seq}`.padEnd(8, "0"),
    content: "Conversation compacted",
  });
}
/** n user/assistant pairs, alternating user,assistant,user,assistant,... */
function transcript(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    lines.push(...pair());
  }
  return lines.join("\n") + "\n";
}

test("window semantics: at-index counts from the conversation TAIL when the transcript exceeds the window", () => {
  // 10 pairs -> 20 transcript slots. Window of the last 6 slots.
  const content = transcript(10);
  // at-index 6 means "cut before window message 6"; the last included message
  // is window message 5 = transcript slot 20 - 6 + 5 = 19 (0-based), the
  // assistant entry of the 10th pair.
  const cut = resolveClaudeForkCut(content, 6, 6);
  assert.equal(cut.transcriptMessageTotal, 20);
  assert.equal(cut.cutPosition, 19);
  assert.equal(cut.uuid, uuidAt(content, 19));
  // The uuid at slot 19 must NOT be what the legacy absolute walk would return
  // (slot 5) — that conflation is the defect this fixes.
  assert.notEqual(cut.uuid, uuidAt(content, 5));
});

test("window semantics: at-index just below the window top maps near the transcript tail", () => {
  const content = transcript(10);
  const cut = resolveClaudeForkCut(content, 5, 6);
  assert.equal(cut.cutPosition, 18);
  assert.equal(cut.uuid, uuidAt(content, 18));
});

test("legacy absolute semantics without window info", () => {
  const content = transcript(10);
  const cut = resolveClaudeForkCut(content, 6, undefined);
  assert.equal(cut.cutPosition, 5);
  assert.equal(cut.uuid, uuidAt(content, 5));
});

test("legacy absolute semantics when the transcript fits inside the window", () => {
  const content = transcript(3); // 6 slots <= window 6
  const cut = resolveClaudeForkCut(content, 6, 6);
  assert.equal(cut.cutPosition, 5);
  assert.equal(cut.uuid, uuidAt(content, 5));
});

test("a cut before the last compaction boundary is refused with an actionable message", () => {
  // 5 pairs, boundary, 5 pairs -> 20 slots; the boundary sits before slot 10.
  const lines: string[] = [];
  for (let i = 0; i < 5; i++) {
    lines.push(...pair());
  }
  lines.push(boundaryLine());
  for (let i = 0; i < 5; i++) {
    lines.push(...pair());
  }
  const content = lines.join("\n") + "\n";

  // Post-boundary cut: reports the reachable floor and resolves normally.
  const after = resolveClaudeForkCut(content, 16, 16);
  assert.equal(after.firstPostCompactionPosition, 10);
  assert.equal(after.cutPosition, 19);
  assert.ok(after.uuid);
  // Window remap that lands BEFORE the floor refuses loudly...
  assert.throws(
    () => resolveClaudeForkCut(content, 4, 16),
    /before the session's last context compaction/,
  );
  // ...and so does the legacy absolute walk into the same region.
  assert.throws(
    () => resolveClaudeForkCut(content, 4, undefined),
    /before the session's last context compaction/,
  );
});

test("a cut at or after the boundary is reachable and returns the entry's uuid", () => {
  const lines: string[] = [];
  lines.push(...pair());
  lines.push(boundaryLine());
  lines.push(...pair());
  const content = lines.join("\n") + "\n";
  const cut = resolveClaudeForkCut(content, 4, 4);
  assert.equal(cut.cutPosition, 3);
  assert.ok(cut.uuid);
  assert.equal(cut.firstPostCompactionPosition, 2);
});

test("non-message entries (sidechain, meta, compact summary, tool results, slash commands) are not counted", () => {
  const lines: string[] = [
    userLine(),
    assistantLine(),
    JSON.stringify({
      type: "user",
      uuid: "sidechain1",
      isSidechain: true,
      message: { content: "side" },
    }),
    JSON.stringify({ type: "user", uuid: "meta1", isMeta: true, message: { content: "meta" } }),
    JSON.stringify({
      type: "user",
      uuid: "toolresult1",
      message: { content: [{ type: "tool_result", content: "r" }] },
    }),
    JSON.stringify({
      type: "user",
      uuid: "slash1",
      message: { content: "<command-name>/clear</command-name>" },
    }),
    JSON.stringify({
      type: "user",
      uuid: "summary1",
      isCompactSummary: true,
      message: { content: "summary" },
    }),
    userLine(),
    assistantLine(),
  ];
  const content = lines.join("\n");
  const cut = resolveClaudeForkCut(content, 4, undefined);
  // Only the 2 real pairs count -> 4 slots; at-index 4 -> cut at slot 3.
  assert.equal(cut.transcriptMessageTotal, 4);
  assert.equal(cut.cutPosition, 3);
  assert.ok(cut.uuid);
});

test("empty transcript resolves to no uuid", () => {
  const cut = resolveClaudeForkCut("", 1, undefined);
  assert.equal(cut.transcriptMessageTotal, 0);
  assert.equal(cut.uuid, undefined);
});

/** Walk helper mirroring the resolver's slot scheme, for asserting positions. */
function uuidAt(content: string, position: number): string | undefined {
  let acpxIndex = -1;
  let found: string | undefined;
  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const record: {
      type?: string;
      uuid?: string;
      isMeta?: boolean;
      isSidechain?: boolean;
      isCompactSummary?: boolean;
      message?: { content?: unknown };
      subtype?: string;
    } = JSON.parse(line);
    if (record.type === "system" && record.subtype === "compact_boundary") {
      continue;
    }
    const indexable =
      (record.type === "user" || record.type === "assistant") &&
      typeof record.uuid === "string" &&
      record.isMeta !== true &&
      record.isSidechain !== true &&
      record.isCompactSummary !== true;
    if (!indexable) {
      continue;
    }
    const messageContent = record.message?.content;
    const isRealUser =
      record.type === "user" &&
      !(
        Array.isArray(messageContent) &&
        (messageContent as Array<{ type?: string }>).some((e) => e.type === "tool_result")
      ) &&
      !(
        typeof messageContent === "string" &&
        [
          "<command-name>",
          "<local-command-stdout>",
          "<local-command-stderr>",
          "<command-message>",
        ].some((p) => messageContent.trimStart().startsWith(p))
      );
    const slot = isRealUser ? (acpxIndex < 0 ? 0 : acpxIndex + 2) : acpxIndex + 1;
    if (!isRealUser && acpxIndex < 0) {
      continue;
    }
    if (slot === position) {
      found = record.uuid;
      break;
    }
    if (isRealUser) {
      acpxIndex = slot;
    }
  }
  return found;
}

test("adjacent window cuts select exact Claude boundaries before and after compaction", () => {
  for (const compacted of [false, true]) {
    const content = [
      JSON.stringify({ type: "user", uuid: "old-user" }),
      JSON.stringify({ type: "assistant", uuid: "old-assistant" }),
      ...(compacted ? [boundaryLine()] : []),
      JSON.stringify({ type: "user", uuid: "tail-user" }),
      JSON.stringify({ type: "assistant", uuid: "tail-assistant-first" }),
      JSON.stringify({ type: "assistant", uuid: "tail-assistant-later" }),
      JSON.stringify({ type: "user", uuid: "pending-user" }),
    ].join("\n");

    for (const [index, position, uuid] of [
      [1, 2, "tail-user"],
      [2, 3, "tail-assistant-first"],
      [3, 4, "pending-user"],
    ] as const) {
      assert.deepEqual(resolveClaudeForkCut(content, index, 3), {
        uuid,
        cutPosition: position,
        transcriptMessageTotal: 5,
        firstPostCompactionPosition: compacted ? 2 : undefined,
      });
    }
    if (compacted) {
      assert.throws(() => resolveClaudeForkCut(content, 0, 3), /last context compaction/);
    } else {
      assert.equal(resolveClaudeForkCut(content, 0, 3).uuid, "old-assistant");
    }
    assert.equal(resolveClaudeForkCut(content, 4, 3).uuid, undefined);
  }
});

test("only the last compaction boundary sets the reachable floor, including a trailing boundary", () => {
  const content = [
    JSON.stringify({ type: "user", uuid: "first" }),
    JSON.stringify({ type: "assistant", uuid: "first-reply" }),
    boundaryLine(),
    JSON.stringify({ type: "user", uuid: "middle" }),
    JSON.stringify({ type: "assistant", uuid: "middle-reply" }),
    boundaryLine(),
    JSON.stringify({ type: "user", uuid: "last" }),
  ].join("\n");
  assert.throws(() => resolveClaudeForkCut(content, 4, undefined), /last context compaction/);
  assert.deepEqual(resolveClaudeForkCut(content, 5, undefined), {
    uuid: "last",
    cutPosition: 4,
    transcriptMessageTotal: 5,
    firstPostCompactionPosition: 4,
  });
  const trailing = `${content}\n${boundaryLine()}`;
  assert.throws(() => resolveClaudeForkCut(trailing, 5, undefined), /last context compaction/);
  assert.equal(resolveClaudeForkCut(trailing, 6, undefined).uuid, undefined);
});

test("missing and optional message content retains user slots and ignores malformed transcript rows", () => {
  const content = [
    "",
    "  ",
    "{broken json",
    "null",
    "[]",
    JSON.stringify({ type: "assistant", uuid: "orphan" }),
    JSON.stringify({ type: "user" }),
    JSON.stringify({ type: "user", uuid: "" }),
    JSON.stringify({ type: "user", uuid: "no-message" }),
    JSON.stringify({ type: "assistant", uuid: "no-content-reply", message: {} }),
    JSON.stringify({ type: "user", uuid: "no-content", message: {} }),
    JSON.stringify({ type: "assistant", uuid: "null-content-reply", message: { content: null } }),
    JSON.stringify({ type: "user", uuid: "null-content", message: { content: null } }),
    JSON.stringify({ type: "assistant", uuid: "array-reply", message: { content: [] } }),
    JSON.stringify({
      type: "user",
      uuid: "mixed-content",
      message: { content: [null, {}, "text"] },
    }),
  ].join("\n");
  for (const [index, uuid] of [
    [1, "no-message"],
    [2, "no-content-reply"],
    [3, "no-content"],
    [4, "null-content-reply"],
    [5, "null-content"],
    [6, "array-reply"],
    [7, "mixed-content"],
  ] as const) {
    const cut = resolveClaudeForkCut(content, index, undefined);
    assert.equal(cut.uuid, uuid);
    assert.equal(cut.transcriptMessageTotal, 7);
  }
});

test("test oracle handles missing message and content without unsafe optional chaining", () => {
  const content = [
    JSON.stringify({ type: "user", uuid: "missing" }),
    JSON.stringify({ type: "assistant", uuid: "empty", message: {} }),
  ].join("\n");
  assert.equal(uuidAt(content, 0), "missing");
  assert.equal(uuidAt(content, 1), "empty");
});

test("invalid window metadata keeps absolute semantics and unmapped cuts have no UUID", () => {
  const content = [
    JSON.stringify({ type: "user", uuid: "first" }),
    JSON.stringify({ type: "user", uuid: "second" }),
  ].join("\n");
  for (const window of [undefined, 0, -1, Number.NaN, Infinity, -Infinity, 3, 20]) {
    assert.equal(resolveClaudeForkCut(content, 1, window).uuid, "first");
    assert.equal(resolveClaudeForkCut(content, 3, window).uuid, "second");
    for (const index of [-1, 0, 2, 4, 1.5, Number.NaN, Infinity]) {
      assert.equal(resolveClaudeForkCut(content, index, window).uuid, undefined);
    }
  }
});

test("tool results and slash echoes occupy the assistant slot without replacing its leading entry", () => {
  const content = [
    JSON.stringify({ type: "user", uuid: "prompt" }),
    JSON.stringify({
      type: "user",
      uuid: "tool-first",
      message: { content: [null, { type: "tool_result" }] },
    }),
    JSON.stringify({ type: "assistant", uuid: "reply-later" }),
    ...[
      "<command-name>",
      "<local-command-stdout>",
      "<local-command-stderr>",
      "<command-message>",
    ].map((prefix) =>
      JSON.stringify({ type: "user", uuid: prefix, message: { content: `  ${prefix}ignored` } }),
    ),
    JSON.stringify({ type: "user", uuid: "next-prompt" }),
  ].join("\n");
  assert.equal(resolveClaudeForkCut(content, 2, undefined).uuid, "tool-first");
  assert.equal(resolveClaudeForkCut(content, 3, undefined).uuid, "next-prompt");
  assert.equal(resolveClaudeForkCut(content, 3, undefined).transcriptMessageTotal, 3);
});
