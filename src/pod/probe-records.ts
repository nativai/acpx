import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { acpAdapterKind } from "../acp/agent-command.js";
import { mapWithConcurrency } from "../async-control.js";
import { findProfile, loadProfileRegistry } from "../config/profiles.js";
import {
  listSessionIndexEntries,
  resolveSessionRecord,
  sessionBaseDir,
} from "../session/persistence.js";
import type { SessionIndexEntry } from "../session/persistence/index.js";
import type { SessionRecord } from "../types.js";
import { podMode, thisPodFile } from "./placement.js";

/**
 * A10 — what the create dialog asks (output styles, model lists) is answered from what owners
 * ALREADY record in their session records at connect, never from a bridge the control pod starts
 * (CONCEPTION r4 §K2 "Probes and one-shot runs", criterion 1; CONTRACTS-r4 C1.2 `one-shot`:
 * "from records where possible").
 *
 * The rule, one place: of the sessions that have run (an `acpSessionId`), of the SAME harness as the
 * agent asked about, prefer a record started with the very agent command this box launches (`exact`),
 * then any other command of the harness (`harness`); of the records of the first tier that has one that
 * carries the advertisement wanted, the one whose ADAPTER STARTED last (`agent_started_at`) answers — a
 * long-running session that started before an update must not look new — a record with no such time
 * ranks last, ties by `lastUsedAt`. `match`:
 *   exact    the record's agent command is the SAME COMMAND STRING as this box's deployed one. Real
 *            commands are the stable link `node /opt/<adapter>/dist/index.js`, which a deploy does not
 *            change: `exact` is NOT "the same adapter version" — a record written before a deploy is
 *            still `exact`. Records hold no version.
 *   harness  another command of the same harness (a dev or rig worktree adapter): a good-faith answer.
 * Output styles and Claude's model list are served whatever account the record ran under — which is an
 * approximation (output styles DO vary by account directory: `<account>/output-styles/*.md`); `profile`
 * filters the model list of a harness whose catalogue differs by account (Codex), where a record with
 * no profile counts as the default profile (see `profileMatches`).
 *
 * ⚠️ This module is the HEAVY side (record reads); the placement step (light graph) only imports it
 * dynamically.
 */

export type RecordAdvertisement = {
  recordId: string;
  agentCommand: string;
  lastUsedAt: string;
  /**
   * When the record's adapter started (`agent_started_at`) — the lists were captured then, so this, not
   * `lastUsedAt`, says how new they are. `undefined` for a record that has none (it ranks LAST in its
   * tier and is never served as fresh).
   */
  agentStartedAt: string | undefined;
  match: "exact" | "harness";
  configOptions: SessionConfigOption[];
  availableModels: string[];
  currentModelId: string | undefined;
};

/** What the answer needs: `config_options` (output styles, Claude's model select) or `available_models`. */
export type AdvertisementNeed = "config_options" | "available_models";

export type RecordAdvertisementQuery = {
  agentCommand: string;
  need: AdvertisementNeed;
  /** Only records started under this profile (Codex's model list differs by ChatGPT profile). */
  profile?: string;
};

/** How many of the newest candidates are opened before giving up: a bound on the reads, not a policy. */
export const RECORD_ADVERTISEMENT_MAX_READS = 25;

export type RecordAdvertisementDeps = {
  entries?: typeof listSessionIndexEntries;
  /** The FULL record, loaded only for a candidate the ranking reaches. */
  load?: (id: string) => Promise<SessionRecord>;
  /** The ranking field alone (`agent_started_at`) — default: a few KB read from the record file. */
  peekStart?: (entry: SessionIndexEntry) => Promise<string | undefined>;
  noProfileMatches?: NoProfileMatches;
};

function satisfies(record: SessionRecord, need: AdvertisementNeed): boolean {
  const acpx = record.acpx;
  return need === "config_options"
    ? (acpx?.config_options?.length ?? 0) > 0
    : (acpx?.available_models?.length ?? 0) > 0;
}

function recordProfile(record: SessionRecord): string | undefined {
  const options = record.acpx?.session_options as { profile?: unknown } | undefined;
  return typeof options?.profile === "string" ? options.profile : undefined;
}

/**
 * Order of preference: a record of the very adapter command this box launches (`exact`) before any
 * other command of the harness (`harness` — a dev or rig worktree), each newest first. A newer rig
 * record must never hide what the deployed adapter's own sessions advertise (TE F-G).
 */
function newestExactFirst(agentCommand: string) {
  return (a: SessionIndexEntry, b: SessionIndexEntry): number =>
    Number(b.agentCommand === agentCommand) - Number(a.agentCommand === agentCommand) ||
    b.lastUsedAt.localeCompare(a.lastUsedAt);
}

/** The candidates: sessions that have run, of the harness asked about, in the order above. */
async function candidateEntries(
  harness: string,
  agentCommand: string,
  entries: RecordAdvertisementDeps["entries"],
): Promise<SessionIndexEntry[]> {
  const all = await (entries ?? listSessionIndexEntries)();
  return all
    .filter(
      (entry) =>
        entry.kind !== "subagent" &&
        entry.acpSessionId.length > 0 &&
        acpAdapterKind(entry.agentCommand) === harness,
    )
    .toSorted(newestExactFirst(agentCommand))
    .slice(0, RECORD_ADVERTISEMENT_MAX_READS);
}

/**
 * `--profile P` matches a record started under P — and a record that names NO profile, when P is
 * what "no profile" means on this box: a profile whose Codex home is the native `~/.codex` a raw login
 * uses (see `noProfileMatchesOnThisBox`; NOT the default binding — F-A2). 233 of 236 real Codex records carry no profile (a default-profile
 * session writes none), while atrium always asks for the active one (TE F-A).
 */
function profileMatches(
  record: SessionRecord,
  query: RecordAdvertisementQuery,
  noProfileMatches: NoProfileMatches,
): boolean {
  if (query.profile === undefined) {
    return true;
  }
  const own = recordProfile(record);
  return own === undefined
    ? noProfileMatches(query.profile, query.agentCommand)
    : own === query.profile;
}

/** Whether a record with no profile ran as the asked profile. Injected in tests; the box's registry otherwise. */
export type NoProfileMatches = (profile: string, agentCommand: string) => boolean;

/**
 * ⚠️ A RECORD WITH NO PROFILE RAN ON THE NATIVE `~/.codex`, AND ONLY THAT PROFILE ANSWERS FOR IT (F-A2).
 * The control pod's create path binds the default profile when none is selected
 * (`defaultAccountBindingForAgent`) and WRITES it into `session_options.profile` — so a record that
 * carries none was written when nothing bound, and its adapter ran the raw login in the native home.
 * It therefore answers `--profile P` only for a chatgpt profile whose `codexHome` is that native home.
 * DO NOT add "or P is the default binding" back: in a registry whose default is bound to a non-native
 * chatgpt profile, that serves one native-home record as two accounts (`exact` for the default, and
 * for the native profile too). `test/pod-a10-probes.test.ts` carries that shape (S1) as the negative.
 */
export const noProfileMatchesOnThisBox: NoProfileMatches = (profile) => {
  try {
    const entry = findProfile(profile, loadProfileRegistry());
    return (
      entry?.authMode === "chatgpt" &&
      path.resolve(entry.codexHome) ===
        path.resolve(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"))
    );
  } catch {
    return false;
  }
};

function answers(
  record: SessionRecord,
  query: RecordAdvertisementQuery,
  noProfileMatches: NoProfileMatches,
): boolean {
  return satisfies(record, query.need) && profileMatches(record, query, noProfileMatches);
}

async function loadQuietly(
  load: (id: string) => Promise<SessionRecord>,
  id: string,
): Promise<SessionRecord | undefined> {
  try {
    return await load(id);
  } catch {
    return undefined;
  }
}

function advertisementOf(
  entry: SessionIndexEntry,
  record: SessionRecord,
  query: RecordAdvertisementQuery,
): RecordAdvertisement {
  return {
    recordId: entry.acpxRecordId,
    agentCommand: entry.agentCommand,
    lastUsedAt: entry.lastUsedAt,
    agentStartedAt: record.agentStartedAt || undefined,
    match: entry.agentCommand === query.agentCommand ? "exact" : "harness",
    configOptions: record.acpx?.config_options ?? [],
    availableModels: record.acpx?.available_models ?? [],
    currentModelId: record.acpx?.current_model_id,
  };
}

/** How many candidate records are peeked at once. */
const RECORD_READ_CONCURRENCY = 8;

/** How much of a record file is read to find `agent_started_at` (it sits ~900 bytes in). */
export const START_PEEK_BYTES = 8192;

/**
 * ⚠️ THE RANKING READS A FEW KB OF EACH CANDIDATE, NOT THE RECORD. A real record is up to ~1.7 MB, and
 * the first version of the ranking opened up to 25 of them in full (messages log included): record-served
 * probes took 1.6 s instead of 0.8 s and atrium's create dialog sat on "Loading…" (brick 94958870).
 *
 * `agent_started_at` is a top-level key that `serializeSessionRecordForDisk` writes BEFORE `messages`
 * and the `acpx` object, so on a normal record the first {@link START_PEEK_BYTES} hold it. The peek
 * READS THE HEAD AS JSON, not as text ({@link scanHeadForStart}): it tracks string and bracket depth, and
 * accepts the field ONLY as a key of the record's own top-level object — a nested `"agent_started_at"` (in a
 * tool call's input, in `agent_capabilities._meta`) is not the record's start (brick c2b7358d, R1a).
 * It is conclusive only when it finds that key, or reads the whole record's closing brace. Anything else —
 * the head ends before either (a large `messages` array, a record written in another key order, even a
 * `"messages":` key reached with no start before it: the field may follow it, R1b) — falls back to parsing the
 * whole file. A record that has no field ranks last; on a record with no field the fallback is a full parse.
 * `test/pod-a10-probes.test.ts` pins the serializer's key order, so a reorder reds there.
 */
export async function peekAgentStartedAt(file: string): Promise<string | undefined> {
  try {
    const head = await readHead(file);
    const scanned = scanHeadForStart(head.text, head.whole);
    if (scanned.kind === "found") {
      return scanned.value;
    }
    if (scanned.kind === "absent") {
      return undefined;
    }
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { agent_started_at?: unknown };
    return typeof parsed.agent_started_at === "string" && parsed.agent_started_at
      ? parsed.agent_started_at
      : undefined;
  } catch {
    return undefined;
  }
}

type HeadScan =
  | { kind: "found"; value: string | undefined }
  | { kind: "absent" }
  | { kind: "unsure" };

/** The end index (of the closing quote) of the JSON string opening at `from`, or -1 when the text ends first. */
function stringEnd(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
    } else if (text[i] === '"') {
      return i;
    }
  }
  return -1;
}

/** The index of the next non-whitespace character at or after `from`, or -1. */
function nextSignificant(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (!/\s/u.test(text[i] ?? "")) {
      return i;
    }
  }
  return -1;
}

/**
 * Scan the head of a record file for the top-level key `agent_started_at`: `found` (its string value, or
 * `undefined` for a value that is not a non-empty string), `absent` (the record's own object closed in the
 * head without it), or `unsure` (the head ended first, or is not a JSON object).
 */
export function scanHeadForStart(text: string, whole: boolean): HeadScan {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      const step = scanStringAt(text, i, depth);
      if ("stop" in step) {
        return step.stop;
      }
      i = step.end;
      continue;
    }
    const delta = bracketDelta(text[i]);
    depth += delta;
    if (delta < 0 && depth === 0) {
      return whole ? { kind: "absent" } : { kind: "unsure" };
    }
  }
  return { kind: "unsure" };
}

/** One string met while scanning: the scan ends (`stop`), or goes on after the string (`end`). */
function scanStringAt(
  text: string,
  from: number,
  depth: number,
): { stop: HeadScan } | { end: number } {
  const token = stringToken(text, from);
  if (token === undefined) {
    return { stop: { kind: "unsure" } };
  }
  if (depth === 1 && token.isKey && token.value === "agent_started_at") {
    return { stop: startValueAt(text, token.afterColon) };
  }
  return { end: token.end };
}

function bracketDelta(char: string | undefined): number {
  if (char === "{" || char === "[") {
    return 1;
  }
  return char === "}" || char === "]" ? -1 : 0;
}

/** The string opening at `from`: where it ends, its raw text, and whether a `:` follows it (it is a key). Undefined when the text ends inside it. */
function stringToken(
  text: string,
  from: number,
): { end: number; value: string; isKey: boolean; afterColon: number } | undefined {
  const end = stringEnd(text, from);
  if (end < 0) {
    return undefined;
  }
  const colon = nextSignificant(text, end + 1);
  return {
    end,
    value: text.slice(from + 1, end),
    isKey: colon >= 0 && text[colon] === ":",
    afterColon: colon + 1,
  };
}

/** The value after `agent_started_at:` — a string is the answer; any other value is "no start"; a cut value is unsure. */
function startValueAt(text: string, from: number): HeadScan {
  const at = nextSignificant(text, from);
  if (at < 0) {
    return { kind: "unsure" };
  }
  if (text[at] !== '"') {
    return { kind: "found", value: undefined };
  }
  const end = stringEnd(text, at);
  if (end < 0) {
    return { kind: "unsure" };
  }
  try {
    const value: unknown = JSON.parse(text.slice(at, end + 1));
    return { kind: "found", value: typeof value === "string" && value ? value : undefined };
  } catch {
    return { kind: "unsure" };
  }
}

/** The first {@link START_PEEK_BYTES} of a file, and whether that was all of it. */
async function readHead(file: string): Promise<{ text: string; whole: boolean }> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(START_PEEK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, START_PEEK_BYTES, 0);
    return { text: buffer.toString("utf8", 0, bytesRead), whole: bytesRead < START_PEEK_BYTES };
  } finally {
    await handle.close();
  }
}

const peekStartFromDisk = (entry: SessionIndexEntry): Promise<string | undefined> =>
  peekAgentStartedAt(path.join(sessionBaseDir(), entry.file));

type Ranked = { entry: SessionIndexEntry; start: string | undefined };

/** Later adapter start first; no `agent_started_at` last; ties newest `lastUsedAt` first, then id. */
function startedLastFirst(a: Ranked, b: Ranked): number {
  return (
    (b.start ?? "").localeCompare(a.start ?? "") ||
    b.entry.lastUsedAt.localeCompare(a.entry.lastUsedAt) ||
    a.entry.acpxRecordId.localeCompare(b.entry.acpxRecordId)
  );
}

/** One tier's candidates in answering order: peek the start times (8 at a time), then rank. */
async function rankTier(
  tier: readonly SessionIndexEntry[],
  peek: (entry: SessionIndexEntry) => Promise<string | undefined>,
): Promise<SessionIndexEntry[]> {
  const starts = await mapWithConcurrency(tier, RECORD_READ_CONCURRENCY, peek);
  return tier
    .map((entry, index): Ranked => ({ entry, start: starts[index] }))
    .toSorted(startedLastFirst)
    .map((ranked) => ranked.entry);
}

/**
 * The record that can answer and whose adapter started last, or undefined — "records cannot answer"
 * (the caller routes to the utility pod). The pool is at most {@link RECORD_ADVERTISEMENT_MAX_READS}
 * candidates (`exact` before `harness`, newest `lastUsedAt` first); their start times are peeked, and
 * full records are loaded in RANK order until one answers — usually the first, so one full load.
 * The `harness` tier is only ranked when no `exact` record answers.
 *
 * The pool is cut by last use BEFORE start times are known (reading start times of a whole store is
 * what this avoids). It can miss a record that started later but was used earlier than 25 others'
 * last use; a session's last use is almost never before its start (1 of 3,045 real records measured has an
 * adapter start AFTER its last use), so that needs 25 more recently used sessions — accepted, and documented in
 * EXPORT-probes.md.
 */
export async function newestRecordAdvertisement(
  query: RecordAdvertisementQuery,
  deps: RecordAdvertisementDeps = {},
): Promise<RecordAdvertisement | undefined> {
  const harness = acpAdapterKind(query.agentCommand);
  if (harness === undefined) {
    return undefined;
  }
  const candidates = await candidateEntries(harness, query.agentCommand, deps.entries);
  const reads = {
    load: deps.load ?? resolveSessionRecord,
    peek: deps.peekStart ?? peekStartFromDisk,
    noProfileMatches: deps.noProfileMatches ?? noProfileMatchesOnThisBox,
  };
  for (const exact of [true, false]) {
    const tier = candidates.filter(
      (entry) => (entry.agentCommand === query.agentCommand) === exact,
    );
    const found = await firstAnsweringInRank(tier, query, reads);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Full records, best-ranked first, until one answers. */
async function firstAnsweringInRank(
  tier: readonly SessionIndexEntry[],
  query: RecordAdvertisementQuery,
  reads: {
    load: (id: string) => Promise<SessionRecord>;
    peek: (entry: SessionIndexEntry) => Promise<string | undefined>;
    noProfileMatches: NoProfileMatches;
  },
): Promise<RecordAdvertisement | undefined> {
  for (const entry of await rankTier(tier, reads.peek)) {
    const record = await loadQuietly(reads.load, entry.acpxRecordId);
    if (record && answers(record, query, reads.noProfileMatches)) {
      return advertisementOf(entry, record, query);
    }
  }
  return undefined;
}

/**
 * True on the control pod in pod mode — the one place where no bridge starts, so a probe is served
 * from records (or, by the placement step, by the utility pod). Everywhere else (pod mode off; an
 * agent pod, where a one-shot is the caller's own load) a probe runs as it always did.
 */
export function probesServedFromRecordsHere(): boolean {
  return podMode().mode === "pod" && thisPodFile().kind === "absent";
}

/**
 * The refusal a probe that REACHES a bridge-free control pod without an answer raises. Unreachable
 * through the placement step (it routes to the utility pod first); the typed error is the second line,
 * so a path nobody routed never spawns a bridge — `AcpClient.spawnAgentProcess` is the third
 * (`assertBridgeMayStartHere`).
 */
const RECORDS_CANNOT_ANSWER_LINE =
  "acpx: REFUSED reason=probe_needs_utility_pod nothing_started=true protocol=1";

export class RecordsCannotAnswerError extends Error {
  readonly stderrLine = RECORDS_CANNOT_ANSWER_LINE;
  constructor(what: string) {
    super(
      `${RECORDS_CANNOT_ANSWER_LINE}\nNo session record carries ${what}; in pod mode the control pod starts no bridge for a probe.`,
    );
  }
}
