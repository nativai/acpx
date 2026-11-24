import { readFile } from "node:fs/promises";
import { AcpxOperationalError, SourceTranscriptMissingError } from "../errors.js";
import type { SessionAgentContent, SessionMessage } from "../types.js";
import {
  ForkCutUnresolvedError,
  type RecordAnchoredCut,
  isContextNeutral,
} from "./claude-fork-anchor.js";
import { locatePiSessionTranscript } from "./harness-config-dir.js";

// brick 4bf088a7 (conception DESIGN.md §2) — which pi entry a `--at-log-index n` fork keeps.
//
// pi-acp used to be told `forkAtMessageIndex = n` and counted n in ITS "client-visible" records.
// The two counts disagree whenever pi files a record somewhere acpx does not (a mid-turn steer, an
// auto-retry error record, a failed delivery, a batch), so the fork silently held content the copied
// record does not inherit — 654 of 1,385 real cuts, 18 of 117 records. This module PROVES the cut
// instead: it finds the pi entry id X such that "the file up to and including X" holds exactly what
// the copied record inherits, or REFUSES (`FORK_CUT_UNRESOLVED`, a stable reason string per case).
// acpx then sends `forkAfterEntryId = X`.
//
// ⚠️ DO NOT ADD A POSITIONAL FALLBACK — "when the counts look aligned", "for an old adapter", "as a
// last resort". Positions are the defect. The same rule is written for Claude at
// `claude-fork-anchor.ts` and `client.ts` (`resolveLogIndexClaudeCut`). Test:
// `test/pi-fork-anchor.test.ts` → "an old adapter is refused, never used by position".
//
// ⚠️ THE CONTEXT END IS THE FIRST MISSING ENTRY, NOT THE LAST PRESENT ONE (the shape of Claude's
// `contextEndCount`). Measured: "last present" let a weakly matched later entry hide a missing user
// (01a0a3b2 n=18). Test: `test/pi-fork-anchor.test.ts` → "first missing, not last present".
//
// Files only: no adapter, no bridge, so the same proof runs at the live copy, at the pod-mode wake
// and (phase 2) at create.

/** The stable reasons of `FORK_CUT_UNRESOLVED` for a Pi cut. Tests assert each by name. */
export const PI_CUT_REFUSALS = {
  /** R1 */ noUserPlaced: "no user message in the window can be placed in pi's file",
  /** R2 */ userNotPlaced: "a user message in the window cannot be placed in pi's file",
  /** R3 */ anchorCount: (deliveries: number, records: number): string =>
    `the anchoring user message is ${deliveries} deliveries in the record but ${records} pi user records`,
  /** R4 */ previousUserDiffers:
    "the user message before the anchor differs between the record and pi's file",
  /** R5 */ replyNotProven:
    "the selected reply cannot be proven to precede the parent's later entries",
  /** R6 */ nothingPrecedes: "no pi entry precedes the cut",
  /** R7 */ brokenChain:
    "pi's file has an entry whose parent is missing, so its path cannot be read",
} as const;

export type PiForkCut = {
  /** The pi entry id the fork keeps up to and including. */
  entryId: string;
  /** Its line in pi's file (1-based). */
  line: number;
  anchorEntryId: string;
  /** Absolute log index the agent's context provably ends at, when short of a non-neutral entry before n. */
  contextEndLogIndex?: number;
};

/** The wire codes pi-acp refuses a `forkAfterEntryId` with (DESIGN §3). */
export const PI_FORK_ENTRY_REFUSAL_CODES = [
  "FORK_ENTRY_INVALID",
  "FORK_CUT_AMBIGUOUS",
  "FORK_ENTRY_NOT_FOUND",
  "FORK_ENTRY_OFF_PATH",
  "FORK_ENTRY_SPLITS_TOOL_CALL",
] as const;

export const FORK_ENTRY_UNSUPPORTED = "FORK_ENTRY_UNSUPPORTED";

/** The adapter cannot fork a Pi session at an entry (it does not advertise it, or ignored the id). */
export class ForkEntryUnsupportedError extends AcpxOperationalError {
  constructor(reason: string) {
    super(`${FORK_ENTRY_UNSUPPORTED}: ${reason}`, {
      outputCode: "RUNTIME",
      detailCode: FORK_ENTRY_UNSUPPORTED,
      origin: "runtime",
    });
  }
}

/** pi-acp refused the entry id acpx proved; `detailCode` is pi-acp's own code. */
export class PiForkEntryRefusedError extends AcpxOperationalError {
  constructor(code: string, message: string) {
    super(message, { outputCode: "RUNTIME", detailCode: code, origin: "runtime" });
  }
}

/** pi-acp's `data.code` on a refused fork, or undefined when `error` is not one of §3's. */
export function piForkEntryRefusalCode(error: unknown): string | undefined {
  const data = (error as { data?: { code?: unknown } } | null)?.data;
  const code = typeof data?.code === "string" ? data.code : undefined;
  return code !== undefined && (PI_FORK_ENTRY_REFUSAL_CODES as readonly string[]).includes(code)
    ? code
    : undefined;
}

const TEXT_CAP = 8_000;
const THINK_CAP = 4_000;

/** pi-acp joins prompt blocks with no separator, so only a whitespace-blind comparison is sound. */
function squash(text: string): string {
  return text.replace(/\s+/gu, "");
}

/** Same rule as `trimRuntimeText` (`session/conversation-model.ts`): a block at its cap ending in "...". */
function storedKey(raw: string, cap: number): { key: string; trimmed: boolean } {
  const trimmed = raw.length === cap && raw.endsWith("...");
  return { key: squash(trimmed ? raw.slice(0, -3) : raw), trimmed };
}

type UserKey = { key: string; trimmed: boolean; id: string };

function userKeyOf(entry: SessionMessage | undefined): UserKey | undefined {
  if (entry === undefined || entry === "Resume" || !("User" in entry)) {
    return undefined;
  }
  let key = "";
  let trimmed = false;
  for (const block of entry.User.content) {
    if (trimmed || !("Text" in block)) {
      continue; // what follows a trimmed block was never stored
    }
    const stored = storedKey(block.Text, TEXT_CAP);
    key += stored.key;
    trimmed = stored.trimmed;
  }
  return key ? { key, trimmed, id: entry.User.id } : undefined;
}

type Side = { ids: Set<string>; blob: string; texts: string[] };

function agentBlockText(block: SessionAgentContent): string | undefined {
  if ("Text" in block) {
    return storedKey(block.Text, TEXT_CAP).key;
  }
  return "Thinking" in block ? storedKey(block.Thinking.text, THINK_CAP).key : undefined;
}

function agentSideOf(entries: readonly SessionMessage[]): Side {
  const ids = new Set<string>();
  const texts: string[] = [];
  for (const entry of entries) {
    if (entry === "Resume" || !("Agent" in entry)) {
      continue;
    }
    for (const block of entry.Agent.content) {
      const text = agentBlockText(block);
      if (text) {
        texts.push(text);
      }
      if ("ToolUse" in block) {
        ids.add(block.ToolUse.id);
      }
    }
    for (const id of Object.keys(entry.Agent.tool_results)) {
      ids.add(id);
    }
  }
  return { ids, blob: texts.join("\u0000"), texts };
}

/**
 * A pi text piece is held by a side when the side's blob contains it, or — for a stored block that
 * was trimmed or carries acpx chrome in front — when some stored block contains the piece's opening.
 */
function sideHasText(side: Side, piece: string): boolean {
  if (!piece) {
    return false;
  }
  if (side.blob.includes(piece)) {
    return true;
  }
  const head = piece.slice(0, 64);
  return head.length >= 16 && side.texts.some((text) => text.includes(head));
}

/** pi entry `piKey` ends with the copied User's text (a trimmed text: contains it). */
const userEndsWith = (piKey: string, user: UserKey): boolean =>
  user.trimmed ? piKey.includes(user.key) : piKey === user.key || piKey.endsWith(user.key);

// ---- pi side ---------------------------------------------------------------------------------

type PiRow = {
  id: string;
  line: number;
  kind: string;
  /** squashed text of a `user` entry; "" for every other kind */
  userKey: string;
  calls: string[];
  resultFor?: string;
  texts: string[];
};

type PiMessage = { role?: unknown; content?: unknown; toolCallId?: unknown };
type PiLine = { type?: unknown; id?: unknown; parentId?: unknown; message?: PiMessage };

function contentParts(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return Array.isArray(content)
    ? content.filter((part): part is Record<string, unknown> => typeof part === "object" && !!part)
    : [];
}

function partText(part: Record<string, unknown>, field: string): string[] {
  return typeof part[field] === "string" ? [squash(part[field])] : [];
}

function assistantTexts(parts: Record<string, unknown>[]): string[] {
  return parts
    .flatMap((part) =>
      part.type === "text"
        ? partText(part, "text")
        : part.type === "thinking"
          ? partText(part, "thinking")
          : [],
    )
    .filter(Boolean);
}

function assistantCalls(parts: Record<string, unknown>[]): string[] {
  return parts.flatMap((part) =>
    part.type === "toolCall" && typeof part.id === "string" ? [part.id] : [],
  );
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function userText(parts: Record<string, unknown>[]): string {
  return parts
    .filter((part) => part.type === "text")
    .flatMap((part) => partText(part, "text"))
    .join("");
}

function messageRole(line: PiLine): string | undefined {
  const message = line.type === "message" ? line.message : undefined;
  return typeof message?.role === "string" ? message.role : undefined;
}

function piRowOf(line: PiLine, lineNo: number): PiRow {
  const role = messageRole(line);
  const parts = contentParts(line.message?.content);
  const toolCallId = line.message?.toolCallId;
  return {
    id: line.id as string,
    line: lineNo,
    kind: role ?? (line.type as string),
    userKey: role === "user" ? userText(parts) : "",
    calls: role === "assistant" ? assistantCalls(parts) : [],
    resultFor: role === "toolResult" ? stringOrUndefined(toolCallId) : undefined,
    texts: role === "assistant" ? assistantTexts(parts) : [],
  };
}

function parsePiLine(text: string): PiLine | undefined {
  try {
    const parsed = JSON.parse(text) as PiLine | null;
    const entry = parsed !== null && typeof parsed === "object" ? parsed : undefined;
    // the header is not an entry; a line without string id/type is no entry either
    return entry && entry.type !== "session" && typeof entry.id === "string" ? entry : undefined;
  } catch {
    return undefined; // a half-written tail, as pi itself skips it
  }
}

/**
 * The entries of pi's active path in root→leaf order: the leaf is the LAST entry of the file (what pi
 * itself loads), the chain follows `parentId`. A parent that is not in the file — or a cycle —
 * refuses (R7): the path cannot be read, so nothing can be proven.
 */
function loadPiPath(content: string, refuse: (reason: string) => never): PiRow[] {
  const rows: PiRow[] = [];
  const parents = new Map<string, unknown>();
  content.split("\n").forEach((text, index) => {
    const line = text.trim() ? parsePiLine(text) : undefined;
    if (line && typeof line.type === "string") {
      rows.push(piRowOf(line, index + 1));
      parents.set(line.id as string, line.parentId);
    }
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path: PiRow[] = [];
  const seen = new Set<string>();
  for (let cur = rows.at(-1); cur; ) {
    if (seen.has(cur.id)) {
      return refuse(PI_CUT_REFUSALS.brokenChain);
    }
    seen.add(cur.id);
    path.push(cur);
    const parentId = parents.get(cur.id);
    if (parentId === null || parentId === undefined || parentId === "") {
      break;
    }
    cur = typeof parentId === "string" ? byId.get(parentId) : undefined;
    if (!cur) {
      return refuse(PI_CUT_REFUSALS.brokenChain);
    }
  }
  return path.toReversed();
}

const hasContent = (row: PiRow): boolean =>
  row.calls.length > 0 ||
  row.resultFor !== undefined ||
  row.texts.length > 0 ||
  row.kind === "user";

const rowIds = (row: PiRow): string[] => [...row.calls, ...(row.resultFor ? [row.resultFor] : [])];

type Sides = { past: Side; future: Side; pastUsers: UserKey[]; futureUsers: UserKey[] };
type RowClass = "future" | "past" | "unknown" | "neutral";

function classifyUser(row: PiRow, sides: Sides): RowClass {
  const inPast = sides.pastUsers.some((user) => row.userKey.includes(user.key));
  const inFuture = sides.futureUsers.some((user) => row.userKey.includes(user.key));
  return inFuture && !inPast ? "future" : inPast ? "past" : "unknown";
}

function classify(row: PiRow, sides: Sides): RowClass {
  if (row.kind === "user") {
    return classifyUser(row, sides);
  }
  const ids = rowIds(row);
  const onlyFuture = ids.some((id) => sides.future.ids.has(id) && !sides.past.ids.has(id));
  if (
    onlyFuture ||
    row.texts.some((t) => sideHasText(sides.future, t) && !sideHasText(sides.past, t))
  ) {
    return "future";
  }
  if (
    ids.some((id) => sides.past.ids.has(id)) ||
    row.texts.some((t) => sideHasText(sides.past, t))
  ) {
    return "past";
  }
  return hasContent(row) ? "unknown" : "neutral";
}

const userOf = (entries: readonly SessionMessage[]): UserKey[] =>
  entries.map(userKeyOf).filter((user): user is UserKey => user !== undefined);

function sidesOf(before: readonly SessionMessage[], after: readonly SessionMessage[]): Sides {
  const pastUsers = userOf(before);
  const pastIds = new Set(pastUsers.map((user) => user.id));
  return {
    past: agentSideOf(before),
    future: agentSideOf(after),
    pastUsers,
    futureUsers: userOf(after).filter((user) => !pastIds.has(user.id)),
  };
}

type Proof = {
  path: PiRow[];
  /** indices into `path` of the pi `user` entries */
  userAt: number[];
  before: readonly SessionMessage[];
  after: readonly SessionMessage[];
  sides: Sides;
  refuse: (reason: string) => never;
};

/** Every entry is neutral, or a User no pi user entry carries (never delivered). */
function onlyNeutralOrUndelivered(proof: Proof, entries: readonly SessionMessage[]): boolean {
  return entries.every((entry) => {
    const user = userKeyOf(entry);
    return (
      isContextNeutral(entry) ||
      (user !== undefined && !proof.userAt.some((i) => proof.path[i].userKey.includes(user.key)))
    );
  });
}

/**
 * The previous-user check, batch-aware: skip the Users right before the anchor that its pi record
 * also carries (a batch's members), then any User no earlier pi record carries (undelivered); the
 * next record User must be carried by the pi user entry just before the anchor (or both absent).
 */
function previousUserAgrees(proof: Proof, k: number, h: number): boolean {
  const { path, userAt, before } = proof;
  const batchMember = (user: UserKey | undefined): boolean =>
    user !== undefined && path[h].userKey.includes(user.key);
  const carriedBefore = (user: UserKey | undefined): boolean =>
    user !== undefined && userAt.some((i) => i < h && path[i].userKey.includes(user.key));
  let p = k - 1;
  while (p >= 0 && batchMember(userKeyOf(before[p]))) {
    p -= 1;
  }
  while (p >= 0 && !carriedBefore(userKeyOf(before[p]))) {
    p -= 1;
  }
  const previousPi = userAt.findLast((i) => i < h);
  return sameOrBothAbsent(
    p >= 0 ? userKeyOf(before[p])?.key : undefined,
    previousPi === undefined ? undefined : path[previousPi].userKey,
  );
}

/** Both absent, or the pi entry's text carries the record's. */
function sameOrBothAbsent(recordKey: string | undefined, piKey: string | undefined): boolean {
  return recordKey === undefined || piKey === undefined
    ? recordKey === undefined && piKey === undefined
    : piKey.includes(recordKey);
}

/**
 * ORDINAL (DESIGN Q3): the j-th distinct delivery of a repeated text is the j-th pi user record
 * carrying it — only when the record's delivery count equals pi's record count.
 */
function ordinalHit(proof: Proof, user: UserKey, hits: number[]): number {
  const deliveries = [
    ...new Set(
      [...proof.before, ...proof.after].flatMap((entry) => {
        const other = userKeyOf(entry);
        return other?.key === user.key ? [other.id] : [];
      }),
    ),
  ];
  if (deliveries.length !== hits.length) {
    return proof.refuse(PI_CUT_REFUSALS.anchorCount(deliveries.length, hits.length));
  }
  return hits[deliveries.indexOf(user.id)];
}

/** 1. ANCHOR — the last User of `before` that pi provably received: its entry and `before` index. */
function findAnchor(proof: Proof): { anchorAt: number; hit: number } {
  for (let k = proof.before.length - 1; k >= 0; k -= 1) {
    const user = userKeyOf(proof.before[k]);
    if (!user) {
      continue;
    }
    const hits = proof.userAt.filter((i) => userEndsWith(proof.path[i].userKey, user));
    if (hits.length === 0) {
      // skippable only when everything after it is neutral or undelivered too (a failed delivery,
      // or a steer pi has not injected yet)
      if (!onlyNeutralOrUndelivered(proof, proof.before.slice(k + 1))) {
        return proof.refuse(PI_CUT_REFUSALS.userNotPlaced);
      }
      continue;
    }
    const hit = ordinalHit(proof, user, hits);
    if (!previousUserAgrees(proof, k, hit)) {
      return proof.refuse(PI_CUT_REFUSALS.previousUserDiffers);
    }
    return { anchorAt: k, hit };
  }
  return proof.refuse(PI_CUT_REFUSALS.noUserPlaced);
}

/** 3. SAFE PREFIX — stop at the first future entry; after the anchor also at the first unknown one. */
function safePrefixEnd(proof: Proof, end: number, hit: number): number {
  const at = proof.path.findIndex((row, i) => {
    if (i >= end) {
      return false;
    }
    const rowClass = classify(row, proof.sides);
    return rowClass === "future" || (i > hit && rowClass === "unknown");
  });
  return at === -1 ? end : at;
}

/**
 * 4. CLOSURE — the last entry before `safe` that does not separate a tool call from a result the
 * source writes LATER (a call pi never answered — a killed turn — does not block).
 */
function closedEntryBefore(path: readonly PiRow[], safe: number): number {
  const answered = new Set(path.flatMap((row) => (row.resultFor ? [row.resultFor] : [])));
  const open = new Set<string>();
  let x = -1;
  for (const [i, row] of path.slice(0, safe).entries()) {
    row.calls.filter((call) => answered.has(call)).forEach((call) => open.add(call));
    if (row.resultFor) {
      open.delete(row.resultFor);
    }
    x = open.size === 0 ? i : x;
  }
  return x;
}

type Footprint = { side: Side; users: PiRow[] };

function footprint(rows: readonly PiRow[]): Footprint {
  const texts = rows.flatMap((row) => row.texts);
  return {
    side: { ids: new Set(rows.flatMap(rowIds)), blob: texts.join("\u0000"), texts },
    users: rows.filter((row) => row.kind === "user"),
  };
}

function holds(held: Footprint, entry: SessionMessage): boolean {
  const user = userKeyOf(entry);
  if (user) {
    return held.users.some((row) => row.userKey.includes(user.key));
  }
  const side = agentSideOf([entry]);
  const textHeld = (t: string): boolean =>
    held.side.texts.some((p) => p.length >= 16 && (t.includes(p) || p.startsWith(t.slice(0, 64))));
  return [...side.ids].some((id) => held.side.ids.has(id)) || side.texts.some(textHeld);
}

/**
 * 5. CONTEXT END = the FIRST entry of `before` that pi's path carries somewhere and the fork (the
 * path up to X) does not; -1 when none. A User pi never received, or an Agent entry with no pi
 * footprint (chrome only), is not missing. ⚠️ NOT "the last present entry".
 */
function firstMissingEntry(proof: Proof, x: number): number {
  const inFork = footprint(proof.path.slice(0, x + 1));
  const onPath = footprint(proof.path);
  return proof.before.findIndex(
    (entry) => !isContextNeutral(entry) && holds(onPath, entry) && !holds(inFork, entry),
  );
}

/**
 * The pi entry a Pi fork at `cut` keeps up to and including, or a `FORK_CUT_UNRESOLVED` refusal.
 * `content` is the source's pi JSONL.
 */
export function resolvePiForkCutByRecord(content: string, cut: RecordAnchoredCut): PiForkCut {
  const refuse = (reason: string): never => {
    throw new ForkCutUnresolvedError(cut.atLogIndex, reason);
  };
  const path = loadPiPath(content, refuse);
  const proof: Proof = {
    path,
    userAt: path.flatMap((row, i) => (row.kind === "user" ? [i] : [])),
    before: cut.before,
    after: cut.after,
    sides: sidesOf(cut.before, cut.after),
    refuse,
  };
  const { anchorAt, hit } = findAnchor(proof);

  // 2. END — a cut right after the anchor user keeps its record (inclusive); a cut after its reply
  //    ends before the next pi user record.
  const userIsLast = onlyNeutralOrUndelivered(proof, cut.before.slice(anchorAt + 1));
  const end = userIsLast ? hit + 1 : (proof.userAt.find((i) => i > hit) ?? path.length);
  const safe = safePrefixEnd(proof, end, hit);
  if (!userIsLast && safe <= hit) {
    return refuse(PI_CUT_REFUSALS.replyNotProven);
  }
  const x = closedEntryBefore(path, safe);
  if (x === -1) {
    return refuse(PI_CUT_REFUSALS.nothingPrecedes);
  }
  const missing = firstMissingEntry(proof, x);
  return {
    entryId: path[x].id,
    line: path[x].line,
    anchorEntryId: path[hit].id,
    ...(missing === -1 ? {} : { contextEndLogIndex: cut.atLogIndex - cut.before.length + missing }),
  };
}

/**
 * Locate the source's pi JSONL and prove the cut against it — the one call both the live copy and
 * the pod-mode paths make. A source file nowhere on the box is `SOURCE_TRANSCRIPT_MISSING`, before
 * any adapter is asked anything.
 */
export async function proveLogIndexPiCut(args: {
  cwd: string;
  acpSessionId: string;
  env?: NodeJS.ProcessEnv;
  cut: RecordAnchoredCut;
}): Promise<PiForkCut> {
  const located = locatePiSessionTranscript({
    cwd: args.cwd,
    acpSessionId: args.acpSessionId,
    env: args.env ?? process.env,
  });
  if (!located) {
    throw new SourceTranscriptMissingError({ acpSessionId: args.acpSessionId, cwd: args.cwd });
  }
  return resolvePiForkCutByRecord(await readFile(located.path, "utf8"), args.cut);
}
