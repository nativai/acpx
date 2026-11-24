import { createHash } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { sessionArchiveDirFor } from "../../session/archive/paths.js";
import { sessionBaseDir } from "../../session/persistence/session-base-dir.js";
import { isQueueLeaseGuardTimeout, withQueueLeaseMutationAtKey } from "./lease-mutation.js";
import { classifyLeasePayload } from "./lease-store.js";
import { queueBaseDir, queueKeyForSession } from "./paths.js";

/**
 * A-71 (brick 70921280): the one-time removal of the legacy leases acpx cannot parse, before a box's
 * control pod first runs A-69's code with the pod's identity (CONTRACTS-r4 A-71 (2), A-72 (1)).
 *
 * SELECTED: a lease whose bytes cannot be read, are not JSON, or are JSON that is not an object — exactly
 * A-69's kind (1), decided by the store's own `classifyLeasePayload` over the very bytes that are
 * fingerprinted. A whole JSON object, parseable or schema-refused, is NEVER selected.
 * REMOVED only if (a) its mtime is older than the control pod's start MINUS `START_MARGIN_MS`, and it is
 * unchanged (inode, mtime, size, sha256) across two reads at least `READ_GAP_MS` apart; and (b) the
 * removal runs inside the lease guard, re-checking the fingerprint there before the unlink.
 * Everything that fails a condition is KEPT and named, with its reason.
 *
 * ⚠️ DO NOT "TIDY" THE GUARD AWAY. The unlink is reached only from inside `withQueueLeaseMutationAtKey`
 * (the guard acquire takes), because a starting owner's acquire could otherwise race the removal.
 */

/** The two reads of a lease are at least this far apart (A-71 (2)(a)). ONE named constant. */
export const READ_GAP_MS = 15_000;
/**
 * A lease is removed only if it is older than the control pod's start by MORE than this. The ruling says
 * "older than"; the state is on a file server whose clock is not this pod's, so a lease near the boundary
 * is kept and named `near-start` (sub-HoD decision, 2026-11-24). The legacy leases are months older.
 */
export const START_MARGIN_MS = 10 * 60_000;

export type LeaseParse = "unreadable" | "not-json" | "json-not-object";

export type LeaseFingerprint = {
  /** Inode, decimal. */
  ino: string;
  /** mtime in nanoseconds since the epoch, decimal. */
  mtimeNs: string;
  size: number;
  /** Hex sha256 of the bytes, or `unreadable:<errno>` for a body that could not be read. */
  sha256: string;
};

export type LeaseDecision = "would-remove" | "removed" | "kept" | "already-absent";

export type SessionState = "closed" | "open" | "archived" | "unknown" | "none";

export type LeaseRecord = {
  key: string;
  /** The session id the key resolves to, or null when no session record names the lease. */
  sessionId: string | null;
  /** `none-found` is spoken out in the text form: "no session record found". */
  sessionRecord: "found" | "none-found";
  location: "hot" | "archive" | null;
  state: SessionState;
  closed: boolean | null;
  bytes: number;
  mtime: string;
  parse: LeaseParse;
  fingerprint: LeaseFingerprint;
  decision: LeaseDecision;
  reason: string;
};

export type ControlPodStart = { ms: number; source: string } | { ms: undefined; reason: string };

export type LeaseRemovalOptions = {
  apply: boolean;
  /** The control pod's start. Unknown (`ms: undefined`) means nothing is removed. */
  controlPodStart: () => ControlPodStart;
  /** Tests only; the CLI passes none (READ_GAP_MS). */
  minGapMs?: number;
  /** Tests only. */
  sleep?: (ms: number) => Promise<void>;
  /** Apply only: where the durable records go. Created exclusively; if it cannot be, nothing is removed. */
  recordsFile?: string;
  /** Tests only: observation points. */
  hooks?: {
    betweenReads?: (key: string) => Promise<void> | void;
    insideGuard?: (key: string) => Promise<void> | void;
  };
  now?: () => Date;
};

export type LeaseRemovalResult = {
  mode: "dry-run" | "apply";
  queuesDir: string;
  controlPodStart: string | null;
  controlPodStartSource: string;
  startMarginMs: number;
  readGapMs: number;
  scanned: { leases: number; selected: number; notSelected: number };
  records: LeaseRecord[];
  summary: { removed: number; wouldRemove: number; kept: number; alreadyAbsent: number };
  recordsFile: string | null;
};

type NotRegular = { kind: "not-regular"; fingerprint: LeaseFingerprint; bytes: number };
type ReadBody = {
  kind: "read";
  fingerprint: LeaseFingerprint;
  mtimeMs: number;
  bytes: number;
  /** Present iff the store's classification SELECTS the body. */
  parse?: LeaseParse;
};
type ReadLease = { kind: "absent" } | NotRegular | ReadBody;
/** A body the store's classification selected. */
type SelectedBody = ReadBody & { parse: LeaseParse };

const LEASE_FILE = /^([0-9a-f]{24})\.lock$/;
const ABSENT: ReadLease = { kind: "absent" };
type Stat = { ino: bigint; mtimeNs: bigint; size: bigint };

function errnoOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "EUNKNOWN";
}

function fingerprintOf(stat: Stat, sha256: string): LeaseFingerprint {
  return {
    ino: stat.ino.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    size: Number(stat.size),
    sha256,
  };
}

function sameFingerprint(a: LeaseFingerprint, b: LeaseFingerprint): boolean {
  return a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.size === b.size && a.sha256 === b.sha256;
}

/** Why a SELECTED body is unparsable, for the record only: the decision never reads it. */
function parseLabel(payload: string): LeaseParse {
  try {
    JSON.parse(payload);
    return "json-not-object";
  } catch {
    return "not-json";
  }
}

function unreadable(stat: Stat | undefined, code: string): ReadLease {
  const base = stat ?? { ino: 0n, mtimeNs: 0n, size: 0n };
  return {
    kind: "read",
    fingerprint: fingerprintOf(base, `unreadable:${code}`),
    mtimeMs: Number(base.mtimeNs / 1_000_000n),
    bytes: Number(base.size),
    parse: "unreadable",
  };
}

async function lstatLease(file: string): Promise<{ stat: Stat } | { early: ReadLease }> {
  try {
    const stat = await fs.lstat(file, { bigint: true });
    return stat.isFile()
      ? { stat }
      : {
          early: {
            kind: "not-regular",
            fingerprint: fingerprintOf(stat, "not-a-regular-file"),
            bytes: Number(stat.size),
          },
        };
  } catch (error) {
    return { early: errnoOf(error) === "ENOENT" ? ABSENT : unreadable(undefined, errnoOf(error)) };
  }
}

async function readOpened(handle: FileHandle): Promise<ReadLease> {
  const fstat = await handle.stat({ bigint: true });
  const buffer = await handle.readFile();
  const payload = buffer.toString("utf8");
  const found = classifyLeasePayload(payload);
  const selected = found.kind === "unparsable" && found.shape.kind === "bytes";
  return {
    kind: "read",
    fingerprint: fingerprintOf(fstat, createHash("sha256").update(buffer).digest("hex")),
    mtimeMs: Number(fstat.mtimeNs / 1_000_000n),
    bytes: buffer.length,
    ...(selected ? { parse: parseLabel(payload) } : {}),
  };
}

/** One read of one lease: its fingerprint, and whether the store's classification selects it. */
async function readLease(file: string): Promise<ReadLease> {
  const first = await lstatLease(file);
  if ("early" in first) {
    return first.early;
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    return errnoOf(error) === "ENOENT" ? ABSENT : unreadable(first.stat, errnoOf(error));
  }
  try {
    return await readOpened(handle);
  } catch (error) {
    return unreadable(first.stat, errnoOf(error));
  } finally {
    await handle.close();
  }
}

type SessionHit = { id: string; location: "hot" | "archive" };
type SessionFacts = Pick<
  LeaseRecord,
  "sessionId" | "sessionRecord" | "location" | "state" | "closed"
>;

/** key → session, from the NAMES in the hot and archive directories (hot first). No record is read here. */
async function sessionLookup(): Promise<Map<string, SessionHit>> {
  const hotDir = sessionBaseDir();
  const dirs: Array<[string, "hot" | "archive"]> = [
    [hotDir, "hot"],
    [sessionArchiveDirFor(hotDir), "archive"],
  ];
  const lookup = new Map<string, SessionHit>();
  for (const [dir, location] of dirs) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const id of names.map((name) => name.split(".")[0]).filter(Boolean)) {
      const key = queueKeyForSession(id);
      if (!lookup.has(key)) {
        lookup.set(key, { id, location });
      }
    }
  }
  return lookup;
}

/** The record's `closed` flag; null when the record is absent or unreadable. */
async function closedFlag(file: string): Promise<boolean | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { closed?: unknown } | null;
    return parsed !== null && typeof parsed === "object" ? parsed.closed === true : null;
  } catch {
    return null;
  }
}

function stateOf(location: "hot" | "archive", closed: boolean | null): SessionState {
  if (location === "archive") {
    return "archived";
  }
  if (closed === null) {
    return "unknown";
  }
  return closed ? "closed" : "open";
}

async function sessionFacts(hit: SessionHit | undefined): Promise<SessionFacts> {
  if (!hit) {
    return {
      sessionId: null,
      sessionRecord: "none-found",
      location: null,
      state: "none",
      closed: null,
    };
  }
  const hotDir = sessionBaseDir();
  const dir = hit.location === "hot" ? hotDir : sessionArchiveDirFor(hotDir);
  const closed = await closedFlag(path.join(dir, `${hit.id}.json`));
  return {
    sessionId: hit.id,
    sessionRecord: "found",
    location: hit.location,
    state: stateOf(hit.location, closed),
    closed,
  };
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Candidate = { key: string; file: string; first: SelectedBody | NotRegular };

/** The record of a lease's body as last read, before a decision. */
function draft(
  key: string,
  read: ReadBody,
  parse: LeaseParse,
  facts: SessionFacts,
): Omit<LeaseRecord, "decision" | "reason"> {
  return {
    key,
    ...facts,
    bytes: read.bytes,
    mtime: new Date(read.mtimeMs).toISOString(),
    parse,
    fingerprint: read.fingerprint,
  };
}

function isSelected(read: ReadLease): read is SelectedBody {
  return read.kind === "read" && read.parse !== undefined;
}

function summarize(records: LeaseRecord[]): LeaseRemovalResult["summary"] {
  const count = (decision: LeaseDecision) => records.filter((r) => r.decision === decision).length;
  return {
    removed: count("removed"),
    wouldRemove: count("would-remove"),
    kept: count("kept"),
    alreadyAbsent: count("already-absent"),
  };
}

async function appendFsynced(handle: FileHandle, value: unknown): Promise<void> {
  await handle.appendFile(`${JSON.stringify(value)}\n`);
  await handle.sync();
}

/** What a lease's mtime says against the control pod's start, or undefined when it may be removed. */
function ageVerdict(mtimeMs: number, start: ControlPodStart): string | undefined {
  if (start.ms === undefined) {
    return `control-pod-start-unknown: ${start.reason}`;
  }
  if (mtimeMs >= start.ms) {
    return "written-after-pod-start";
  }
  return mtimeMs >= start.ms - START_MARGIN_MS ? "near-start" : undefined;
}

function startFields(start: ControlPodStart): {
  controlPodStart: string | null;
  controlPodStartSource: string;
} {
  return start.ms === undefined
    ? { controlPodStart: null, controlPodStartSource: start.reason }
    : { controlPodStart: new Date(start.ms).toISOString(), controlPodStartSource: start.source };
}

async function listQueues(queuesDir: string): Promise<string[]> {
  try {
    return (await fs.readdir(queuesDir)).toSorted();
  } catch (error) {
    if (errnoOf(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** Read 1 of every `<key>.lock`: what is selected (or not a regular file), and how many were not. */
async function scanLeases(
  queuesDir: string,
): Promise<{ leases: number; notSelected: number; candidates: Candidate[] }> {
  let leases = 0;
  let notSelected = 0;
  const candidates: Candidate[] = [];
  for (const name of await listQueues(queuesDir)) {
    const match = LEASE_FILE.exec(name);
    const file = path.join(queuesDir, name);
    const first = match ? await readLease(file) : ABSENT;
    if (!match || first.kind === "absent") {
      continue;
    }
    leases += 1;
    // A directory or special file named like a lease is kept and named; it is never unlinked here.
    if (first.kind === "not-regular" || isSelected(first)) {
      candidates.push({ key: match[1], file, first });
    } else {
      notSelected += 1;
    }
  }
  return { leases, notSelected, candidates };
}

type Judged = { record: LeaseRecord; read2?: SelectedBody };
type JudgeContext = {
  apply: boolean;
  start: ControlPodStart;
  hooks: LeaseRemovalOptions["hooks"];
};

function notRegularRecord(key: string, first: NotRegular, facts: SessionFacts): LeaseRecord {
  return {
    key,
    ...facts,
    bytes: first.bytes,
    mtime: new Date(0).toISOString(),
    parse: "unreadable",
    fingerprint: first.fingerprint,
    decision: "kept",
    reason: "not-a-regular-file",
  };
}

/** What read 2 says against read 1: a settled record, or the still-selected body to go on with. */
function afterSecondRead(
  key: string,
  first: SelectedBody,
  second: ReadLease,
  facts: SessionFacts,
): { record: LeaseRecord } | { second: SelectedBody } {
  if (second.kind === "absent") {
    const gone = draft(key, first, first.parse, facts);
    return { record: { ...gone, decision: "already-absent", reason: "gone-between-reads" } };
  }
  if (!isSelected(second)) {
    const reason = second.kind === "read" ? "no-longer-unparsable" : "changed-between-reads";
    return {
      record: { ...draft(key, first, first.parse, facts), decision: "kept", reason },
    };
  }
  if (!sameFingerprint(first.fingerprint, second.fingerprint)) {
    const changed = draft(key, second, second.parse, facts);
    return { record: { ...changed, decision: "kept", reason: "changed-between-reads" } };
  }
  return { second };
}

async function judgeCandidate(
  candidate: Candidate,
  facts: SessionFacts,
  ctx: JudgeContext,
): Promise<Judged> {
  const { first, key } = candidate;
  if (first.kind === "not-regular") {
    return { record: notRegularRecord(key, first, facts) };
  }
  await ctx.hooks?.betweenReads?.(key);
  const settled = afterSecondRead(key, first, await readLease(candidate.file), facts);
  if ("record" in settled) {
    return settled;
  }
  const base = draft(key, settled.second, settled.second.parse, facts);
  const aged = ageVerdict(settled.second.mtimeMs, ctx.start);
  if (aged !== undefined) {
    return { record: { ...base, decision: "kept", reason: aged } };
  }
  if (!ctx.apply) {
    return { record: { ...base, decision: "would-remove", reason: "all-conditions-met" } };
  }
  return { record: { ...base, decision: "kept", reason: "pending" }, read2: settled.second };
}

async function waitGap(
  candidates: Candidate[],
  readEndedAt: number,
  gapMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const remaining = gapMs - (performance.now() - readEndedAt);
  if (candidates.length > 0 && remaining > 0) {
    await sleep(remaining);
  }
}

export async function runLeaseRemoval(options: LeaseRemovalOptions): Promise<LeaseRemovalResult> {
  const queuesDir = queueBaseDir();
  const gapMs = options.minGapMs ?? READ_GAP_MS;
  const start = options.controlPodStart();
  const scan = await scanLeases(queuesDir);
  const readEndedAt = performance.now();
  const { candidates } = scan;
  const lookup = candidates.length > 0 ? await sessionLookup() : new Map<string, SessionHit>();
  await waitGap(candidates, readEndedAt, gapMs, options.sleep ?? realSleep);

  // Read 2 (at least `gapMs` after read 1 ended) and the age rule.
  const ctx: JudgeContext = { apply: options.apply, start, hooks: options.hooks };
  const records: LeaseRecord[] = [];
  const pending: Array<{ index: number; candidate: Candidate; read2: SelectedBody }> = [];
  for (const candidate of candidates) {
    const facts = await sessionFacts(lookup.get(candidate.key));
    const judged = await judgeCandidate(candidate, facts, ctx);
    if (judged.read2) {
      pending.push({ index: records.length, candidate, read2: judged.read2 });
    }
    records.push(judged.record);
  }

  const recordsFile = options.apply
    ? await removeAll(options, { records, pending, start, scan: { ...scan, gapMs, queuesDir } })
    : null;
  return {
    mode: options.apply ? "apply" : "dry-run",
    queuesDir,
    ...startFields(start),
    startMarginMs: START_MARGIN_MS,
    readGapMs: gapMs,
    scanned: { leases: scan.leases, selected: candidates.length, notSelected: scan.notSelected },
    records: records.toSorted((a, b) => a.key.localeCompare(b.key)),
    summary: summarize(records),
    recordsFile,
  };
}

/** Apply: open the records file FIRST (no file, no removal), then remove each pending lease under its guard. */
async function removeAll(
  options: LeaseRemovalOptions,
  run: {
    records: LeaseRecord[];
    pending: Array<{ index: number; candidate: Candidate; read2: SelectedBody }>;
    start: ControlPodStart;
    scan: { leases: number; candidates: Candidate[]; gapMs: number; queuesDir: string };
  },
): Promise<string> {
  const target = options.recordsFile;
  if (!target) {
    throw new Error("apply needs a records file");
  }
  const handle = await openRecordsFile(target);
  try {
    await appendFsynced(handle, {
      event: "run",
      at: (options.now?.() ?? new Date()).toISOString(),
      queuesDir: run.scan.queuesDir,
      ...startFields(run.start),
      startMarginMs: START_MARGIN_MS,
      readGapMs: run.scan.gapMs,
      leases: run.scan.leases,
      selected: run.scan.candidates.length,
      toRemove: run.pending.length,
    });
    for (const { index, candidate, read2 } of run.pending) {
      run.records[index] = await removeUnderGuard(candidate, read2, run.records[index], run.start, {
        handle,
        hooks: options.hooks,
      });
    }
    for (const record of run.records.filter((r) => r.decision === "kept")) {
      await appendFsynced(handle, { event: "kept", record });
    }
  } finally {
    await handle.close();
  }
  return target;
}

async function openRecordsFile(target: string): Promise<FileHandle> {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  return await fs.open(target, "wx", 0o600);
}

type RemovalIo = { handle: FileHandle; hooks: LeaseRemovalOptions["hooks"] };

function decided(base: LeaseRecord, decision: LeaseDecision, reason: string): LeaseRecord {
  return { ...base, decision, reason };
}

/** The unlink and its result line; ENOENT at the unlink is `already-absent`, any other error keeps the lease. */
async function unlinkRecorded(
  candidate: Candidate,
  base: LeaseRecord,
  removing: LeaseRecord,
  handle: FileHandle,
): Promise<LeaseRecord> {
  let outcome = removing;
  try {
    await fs.unlink(candidate.file);
  } catch (error) {
    const code = errnoOf(error);
    outcome =
      code === "ENOENT"
        ? decided(base, "already-absent", "gone-at-unlink")
        : decided(base, "kept", `unlink-failed: ${code}`);
  }
  await appendFsynced(handle, { event: "result", record: outcome });
  return outcome;
}

/** Still the very lease read 2 saw: selected, same fingerprint, still old enough. */
function unchangedSince(read2: SelectedBody, third: ReadLease, start: ControlPodStart): boolean {
  return (
    isSelected(third) &&
    sameFingerprint(read2.fingerprint, third.fingerprint) &&
    ageVerdict(third.mtimeMs, start) === undefined
  );
}

/** Inside the guard: read 3 against read 2, then the intent line (fsynced), the unlink and the result line. */
async function removeInsideGuard(
  candidate: Candidate,
  read2: SelectedBody,
  base: LeaseRecord,
  start: ControlPodStart,
  io: RemovalIo,
): Promise<LeaseRecord> {
  await io.hooks?.insideGuard?.(candidate.key);
  const third = await readLease(candidate.file);
  if (third.kind === "absent") {
    return decided(base, "already-absent", "gone-before-the-guard-re-read");
  }
  if (!unchangedSince(read2, third, start)) {
    const seen = third.kind === "read" ? { ...base, fingerprint: third.fingerprint } : base;
    return decided(seen, "kept", "changed-inside-guard");
  }
  const removing = decided(base, "removed", "all-conditions-met");
  await appendFsynced(io.handle, { event: "intent", record: removing });
  return await unlinkRecorded(candidate, base, removing, io.handle);
}

/** The unlink is reached only through the lease guard. A lease-level failure is a kept record, never a throw. */
async function removeUnderGuard(
  candidate: Candidate,
  read2: SelectedBody,
  base: LeaseRecord,
  start: ControlPodStart,
  io: RemovalIo,
): Promise<LeaseRecord> {
  try {
    return await withQueueLeaseMutationAtKey(candidate.key, () =>
      removeInsideGuard(candidate, read2, base, start, io),
    );
  } catch (error) {
    return isQueueLeaseGuardTimeout(error)
      ? decided(base, "kept", "guard-unavailable")
      : decided(base, "kept", `error: ${(error as Error).message}`);
  }
}
