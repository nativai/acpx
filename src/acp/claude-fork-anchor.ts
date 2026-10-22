import type { SessionAgentMessage, SessionMessage } from "../types.js";
import {
  type ClaudeJsonlRecord,
  isCompactionBoundary,
  isIndexableClaudeRecord,
  isRealUserRecord,
  parseClaudeJsonlRecord,
} from "./claude-fork-index.js";

// brick 0dc53ac9 (conception 0d57058c D5, verification T10) — where a
// `--at-log-index n` fork's Claude context may end when NO entry in the window
// ending at n carries a `claude_uuid` (pre-provenance records).
//
// ⚠️ DO NOT FALL BACK TO POSITIONAL ARITHMETIC HERE (`resolveClaudeForkCut`).
// It assumes record positions and transcript slots coincide. On a record with
// duplicated entries, re-deliveries and steers they do not: on dbf3122b
// (1,257 entries vs 536 transcript slots) the absolute slot 481 was transcript
// line 7648 = record entry 1155, so the branch agent knew 675 entries of the
// parent's FUTURE while the record copy was correct and the exit was 0.
//
// What this does instead is PROVE the cut:
//   1. ANCHOR — the window's last User is found in the transcript by its text,
//      among real user rows and `queued_command` attachments (how Claude Code
//      records a mid-turn delivery). It must match EXACTLY ONE row.
//   2. END — a cut right after that User ends before its row; a cut after its
//      reply (only at a record turn boundary: entry n is a User, or n = total)
//      ends before the next input row.
//   3. SAFE PREFIX — the context stops before the first transcript row that
//      carries content (text, thinking, tool_use id, tool_result id) or a user
//      input found ONLY in record entries at or after n. Rows with content the
//      record never stored are neutral.
// So everything in the agent's context is either attributable to the copy or
// to nothing — never to the parent's future. Anything unprovable is REFUSED
// (FORK_CUT_UNRESOLVED), never shifted. A cut before the last compaction gets
// the compaction refusal.

export const FORK_CUT_UNRESOLVED = "FORK_CUT_UNRESOLVED";

/** The message IS the stderr JSON line, as `ForkCutMovedError`'s is. */
export class ForkCutUnresolvedError extends Error {
  readonly detailCode = FORK_CUT_UNRESOLVED;
  readonly stderrLine: string;

  constructor(atLogIndex: number, reason: string) {
    super(JSON.stringify({ code: FORK_CUT_UNRESOLVED, at_log_index: atLogIndex, reason }));
    this.name = "ForkCutUnresolvedError";
    this.stderrLine = this.message;
  }
}

export function forkCutBeforeCompactionError(atLogIndex: number): Error {
  return new Error(
    `Cannot fork at --at-log-index ${atLogIndex}: that point lies before the session's last context compaction, so Claude Code can no longer resume from it. Fork at a later point in the conversation, or copy the whole session (no cut).`,
  );
}

export type RecordAnchoredCut = {
  atLogIndex: number;
  /** The entries ending at n-1 (what the copy inherits). */
  window: readonly SessionMessage[];
  /** The source's full history before n, and from n on. */
  before: readonly SessionMessage[];
  after: readonly SessionMessage[];
};

type Piece = { kind: "text" | "id"; value: string };
type Side = { blocks: Set<string>; blob: string; ids: Set<string> };

function normalize(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text);
}

function isQueuedCommand(record: ClaudeJsonlRecord): boolean {
  return record.type === "attachment" && record.attachment?.type === "queued_command";
}

function isInputRow(record: ClaudeJsonlRecord): boolean {
  return isQueuedCommand(record) || (isRealUserRecord(record) && isIndexableClaudeRecord(record));
}

function inputText(record: ClaudeJsonlRecord): string {
  const content = isQueuedCommand(record) ? record.attachment?.prompt : record.message?.content;
  return normalize(textBlocks(content).join("\n"));
}

function userText(entry: SessionMessage): string | undefined {
  if (entry === "Resume" || !("User" in entry)) {
    return undefined;
  }
  return normalize(
    entry.User.content.map((block) => ("Text" in block ? block.Text : "")).join("\n"),
  );
}

/** Which field of a transcript content block identifies it, by block type. */
const PIECE_FIELDS: Readonly<Record<string, { field: string; kind: Piece["kind"] }>> = {
  text: { field: "text", kind: "text" },
  thinking: { field: "thinking", kind: "text" },
  tool_use: { field: "id", kind: "id" },
  tool_result: { field: "tool_use_id", kind: "id" },
};

function blockPiece(block: Record<string, unknown>): Piece | undefined {
  const spec = typeof block.type === "string" ? PIECE_FIELDS[block.type] : undefined;
  const field = spec ? block[spec.field] : undefined;
  if (!spec || typeof field !== "string") {
    return undefined;
  }
  const value = spec.kind === "id" ? field : normalize(field);
  return value ? { kind: spec.kind, value } : undefined;
}

function rowPieces(record: ClaudeJsonlRecord): Piece[] {
  const content = record.message?.content;
  if (typeof content === "string") {
    const value = record.type === "assistant" ? normalize(content) : "";
    return value ? [{ kind: "text", value }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((block): block is Record<string, unknown> => typeof block === "object" && !!block)
    .map(blockPiece)
    .filter((piece): piece is Piece => piece !== undefined);
}

function addAgentContent(message: SessionAgentMessage, blocks: Set<string>, ids: Set<string>) {
  for (const block of message.content) {
    if ("ToolUse" in block) {
      ids.add(block.ToolUse.id);
      continue;
    }
    const text = normalize(
      "Text" in block ? block.Text : "Thinking" in block ? block.Thinking.text : "",
    );
    if (text) {
      blocks.add(text);
    }
  }
  for (const id of Object.keys(message.tool_results)) {
    ids.add(id);
  }
}

function agentSide(entries: readonly SessionMessage[]): Side {
  const blocks = new Set<string>();
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry !== "Resume" && "Agent" in entry) {
      addAgentContent(entry.Agent, blocks, ids);
    }
  }
  return { blocks, blob: [...blocks].join(" "), ids };
}

function sideHas(side: Side, piece: Piece): boolean {
  if (piece.kind === "id") {
    return side.ids.has(piece.value);
  }
  return side.blocks.has(piece.value) || side.blob.includes(piece.value);
}

function matchesUserText(text: string, users: readonly string[]): boolean {
  return users.some((user) => text === user || text.endsWith(user));
}

function userTexts(entries: readonly SessionMessage[]): string[] {
  return entries.map(userText).filter((text): text is string => !!text);
}

/** Whether a transcript row carries something the parent recorded only at or after n. */
function futureOnlyRow(
  record: ClaudeJsonlRecord,
  sides: { past: Side; future: Side; pastUsers: string[]; futureUsers: string[] },
): boolean {
  if (isInputRow(record)) {
    const text = inputText(record);
    return (
      !!text && matchesUserText(text, sides.futureUsers) && !matchesUserText(text, sides.pastUsers)
    );
  }
  if (!isIndexableClaudeRecord(record)) {
    return false;
  }
  return rowPieces(record).some(
    (piece) => sideHas(sides.future, piece) && !sideHas(sides.past, piece),
  );
}

function findAnchorRow(rows: readonly ClaudeJsonlRecord[], want: string): number[] {
  const hits: number[] = [];
  rows.forEach((record, index) => {
    if (!isInputRow(record)) {
      return;
    }
    const text = inputText(record);
    if (text === want || text.endsWith(want)) {
      hits.push(index);
    }
  });
  return hits;
}

/** Where the context may at most extend to (exclusive), before the safe-prefix check. */
function anchoredEnd(
  rows: readonly ClaudeJsonlRecord[],
  anchor: number,
  endsOnUser: boolean,
  next: SessionMessage | undefined,
  refuse: (reason: string) => never,
): number {
  if (endsOnUser) {
    return anchor;
  }
  if (next !== undefined && (next === "Resume" || !("User" in next))) {
    refuse("the cut lies inside an agent turn (entry n is not a user message)");
  }
  const following = rows.findIndex((record, index) => index > anchor && isInputRow(record));
  return following === -1 ? rows.length : following;
}

function lastIndexableBefore(rows: readonly ClaudeJsonlRecord[], end: number): number {
  for (let index = end - 1; index >= 0; index -= 1) {
    if (isIndexableClaudeRecord(rows[index])) {
      return index;
    }
  }
  return -1;
}

function lastCompactionBoundary(rows: readonly ClaudeJsonlRecord[]): number {
  return rows.findLastIndex((record) => isCompactionBoundary(record));
}

export function parseClaudeTranscriptRows(content: string): ClaudeJsonlRecord[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseClaudeJsonlRecord)
    .filter((record): record is ClaudeJsonlRecord => record !== undefined);
}

/** `--at-log-index` + walk-back uuid: refuse a uuid older than the last compaction. */
export function assertUuidAfterLastCompaction(
  content: string,
  uuid: string,
  atLogIndex: number,
): void {
  const rows = parseClaudeTranscriptRows(content);
  const at = rows.findIndex((record) => record.uuid === uuid);
  if (at !== -1 && at < lastCompactionBoundary(rows)) {
    throw forkCutBeforeCompactionError(atLogIndex);
  }
}

/** The ONE transcript input row the window's last User was delivered as, or a refusal. */
function findAnchor(
  rows: readonly ClaudeJsonlRecord[],
  window: readonly SessionMessage[],
  refuse: (reason: string) => never,
): number {
  const userAt = window.findLastIndex((entry) => userText(entry) !== undefined);
  const want = userAt === -1 ? undefined : userText(window[userAt]);
  if (!want) {
    return refuse("no user message with text in the window to anchor the cut on");
  }
  const hits = findAnchorRow(rows, want);
  if (hits.length !== 1) {
    return refuse(`the anchoring user message matches ${hits.length} transcript rows, not 1`);
  }
  return hits[0];
}

/** `end`, or the first earlier row carrying something the parent recorded only at/after n. */
function safePrefixEnd(rows: readonly ClaudeJsonlRecord[], end: number, cut: RecordAnchoredCut) {
  const pastUsers = userTexts(cut.before);
  const sides = {
    past: agentSide(cut.before),
    future: agentSide(cut.after),
    pastUsers,
    futureUsers: userTexts(cut.after).filter((text) => !pastUsers.includes(text)),
  };
  const futureAt = rows.findIndex((record, index) => index < end && futureOnlyRow(record, sides));
  return futureAt === -1 ? end : futureAt;
}

/**
 * The transcript uuid a uuid-free `--at-log-index` cut forks at — proven as
 * described at the top of this file — or a refusal.
 */
export function resolveClaudeForkCutByRecord(content: string, cut: RecordAnchoredCut): string {
  const refuse = (reason: string): never => {
    throw new ForkCutUnresolvedError(cut.atLogIndex, reason);
  };
  const rows = parseClaudeTranscriptRows(content);
  const endsOnUser = cut.window.findLastIndex((entry) => userText(entry) !== undefined);
  const anchor = findAnchor(rows, cut.window, refuse);
  const userIsLast = endsOnUser === cut.window.length - 1;
  const end = anchoredEnd(rows, anchor, userIsLast, cut.after[0], refuse);
  const safeEnd = safePrefixEnd(rows, end, cut);
  if (!userIsLast && safeEnd <= anchor) {
    refuse("the selected reply cannot be proven to precede the parent's later entries");
  }
  const at = lastIndexableBefore(rows, safeEnd);
  if (at === -1) {
    return refuse("no transcript entry precedes the cut");
  }
  if (at < lastCompactionBoundary(rows)) {
    throw forkCutBeforeCompactionError(cut.atLogIndex);
  }
  return rows[at].uuid as string;
}
