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
  for (let i = 0; i < n; i++) lines.push(...pair());
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
  // 5 pairs, boundary, 5 pairs -> 20 slots; the boundary sits before slot 8.
  const lines: string[] = [];
  for (let i = 0; i < 5; i++) lines.push(...pair());
  lines.push(boundaryLine());
  for (let i = 0; i < 5; i++) lines.push(...pair());
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
    JSON.stringify({ type: "user", uuid: "sidechain1", isSidechain: true, message: { content: "side" } }),
    JSON.stringify({ type: "user", uuid: "meta1", isMeta: true, message: { content: "meta" } }),
    JSON.stringify({
      type: "user",
      uuid: "toolresult1",
      message: { content: [{ type: "tool_result", content: "r" }] },
    }),
    JSON.stringify({ type: "user", uuid: "slash1", message: { content: "<command-name>/clear</command-name>" } }),
    JSON.stringify({ type: "user", uuid: "summary1", isCompactSummary: true, message: { content: "summary" } }),
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
    if (!line.trim()) continue;
    const record: {
      type?: string;
      uuid?: string;
      isMeta?: boolean;
      isSidechain?: boolean;
      isCompactSummary?: boolean;
      message?: { content?: unknown };
      subtype?: string;
    } = JSON.parse(line);
    if (record.type === "system" && record.subtype === "compact_boundary") continue;
    const indexable =
      (record.type === "user" || record.type === "assistant") &&
      typeof record.uuid === "string" &&
      record.isMeta !== true &&
      record.isSidechain !== true &&
      record.isCompactSummary !== true;
    if (!indexable) continue;
    const isRealUser =
      record.type === "user" &&
      !(Array.isArray(record.message?.content) &&
        (record.message?.content as Array<{ type?: string }>).some((e) => e.type === "tool_result")) &&
      !(typeof record.message?.content === "string" &&
        ["<command-name>", "<local-command-stdout>", "<local-command-stderr>", "<command-message>"].some((p) =>
          (record.message?.content as string).trimStart().startsWith(p),
        ));
    const slot = isRealUser ? (acpxIndex < 0 ? 0 : acpxIndex + 2) : acpxIndex + 1;
    if (!isRealUser && acpxIndex < 0) continue;
    if (slot === position) {
      found = record.uuid;
      break;
    }
    if (isRealUser) acpxIndex = slot;
  }
  return found;
}
