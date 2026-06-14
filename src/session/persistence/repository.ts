import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionNotFoundError, SessionResolutionError } from "../../errors.js";
import { incrementPerfCounter, measurePerf } from "../../perf-metrics.js";
import { assertPersistedKeyPolicy } from "../../persisted-key-policy.js";
import { isProcessAlive } from "../../process-liveness.js";
import type { SessionRecord } from "../../types.js";
import { getLoggedMessageCount, markAllMessagesLogged } from "../messages-log-bookkeeping.js";
import {
  appendFinalizedMessagesToLog,
  clearMissingMessagesLogPointerForWrite,
  compactMessagesLog,
  hydrateSessionMessagesFromLog,
  messagesLogFileName,
  messagesLogPath,
  messagesLogStalePath,
  prepareMessagesLogForBoundary,
  resolveMessagesLogCompactBytes,
} from "../messages-log.js";
import {
  flushPendingSessionIndexUpdates,
  updateSessionIndexForRecordWrite,
} from "./index-update-queue.js";
import {
  loadOrRebuildSessionIndex,
  rebuildSessionIndex,
  toSessionIndexEntry,
  type SessionIndexEntry,
} from "./index.js";
import { parseSessionRecord } from "./parse.js";
import { serializeSessionRecordForDisk } from "./serialize.js";

export const DEFAULT_HISTORY_LIMIT = 20;

type FindSessionOptions = {
  agentCommand: string;
  agentName?: string;
  cwd: string;
  name?: string;
  includeClosed?: boolean;
};

type FindSessionByDirectoryWalkOptions = {
  agentCommand: string;
  agentName?: string;
  cwd: string;
  name?: string;
  boundary?: string;
};

function sessionFilePath(acpxRecordId: string): string {
  const safeId = encodeURIComponent(acpxRecordId);
  return path.join(sessionBaseDir(), `${safeId}.json`);
}

export function sessionBaseDir(): string {
  return path.join(os.homedir(), ".acpx", "sessions");
}

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(sessionBaseDir(), { recursive: true });
}

async function loadRecordFromIndexEntry(
  entry: SessionIndexEntry,
): Promise<SessionRecord | undefined> {
  try {
    const payload = await fs.readFile(path.join(sessionBaseDir(), entry.file), "utf8");
    const record = parseSessionRecord(JSON.parse(payload));
    return record
      ? await hydrateSessionMessagesFromLog(
          record,
          messagesLogPath(sessionBaseDir(), record.acpxRecordId),
        )
      : undefined;
  } catch {
    return undefined;
  }
}

async function loadSessionIndexEntries(): Promise<SessionIndexEntry[]> {
  await ensureSessionDir();
  // Read-your-writes within the process: drain any coalesced scalar updates
  // before serving index entries.
  await flushPendingSessionIndexUpdates(sessionBaseDir());
  const index = await measurePerf("session.index_load", async () => {
    return await loadOrRebuildSessionIndex(sessionBaseDir());
  });
  return index.entries;
}

function matchesSessionEntry(
  session: SessionIndexEntry,
  normalizedCwd: string,
  normalizedName: string | undefined,
  includeClosed = false,
): boolean {
  if (session.cwd !== normalizedCwd) {
    return false;
  }
  if (!includeClosed && session.closed) {
    return false;
  }
  if (normalizedName == null) {
    return session.name == null;
  }
  return session.name === normalizedName;
}

function matchesAgentIdentity(
  session: Pick<SessionIndexEntry, "agentCommand" | "agentName">,
  agentCommand: string,
  agentName: string | undefined,
): boolean {
  if (agentName && session.agentName) {
    return session.agentName === agentName;
  }
  return session.agentCommand === agentCommand;
}

export type PersistedSessionLifecycle = {
  closed: boolean | undefined;
  closedAt: string | undefined;
  favorite: boolean | undefined;
  favoritedAt: string | undefined;
  name: string | undefined;
  /** acpx-ui-owned template marker — read-preserved like closed/favorite/name so a
   * stale agent-exit checkpoint flush can't clobber an externally-set template (FW-16). */
  template: SessionRecord["template"];
  /** Last on-disk updated_at — lets the flush keep updated_at monotonic (no stale regress). */
  updatedAt: string | undefined;
  /** Extra fields the live-checkpoint closed-state merge needs — carried so
   * one read can serve both the preserve step and that merge (W2.4). */
  pid: number | undefined;
  acpx: SessionRecord["acpx"];
};

/**
 * Read the current on-disk <id>.json (if present) and return the persisted
 * lifecycle fields (closed/closedAt), the UI-owned favorite state
 * (favorite/favoritedAt), and the UI-owned display `name`. Returns undefined
 * if the file is missing or unreadable — callers should treat that as
 * "no prior state to preserve."
 */
export async function readPersistedLifecycle(
  acpxRecordId: string,
): Promise<PersistedSessionLifecycle | undefined> {
  try {
    const payload = await fs.readFile(sessionFilePath(acpxRecordId), "utf8");
    const parsed = parseSessionRecord(JSON.parse(payload));
    if (!parsed) {
      return undefined;
    }
    return {
      closed: parsed.closed,
      closedAt: parsed.closedAt,
      favorite: parsed.favorite,
      favoritedAt: parsed.favoritedAt,
      name: parsed.name,
      template: parsed.template,
      updatedAt: parsed.updated_at,
      pid: parsed.pid,
      acpx: parsed.acpx,
    };
  } catch {
    return undefined;
  }
}

/**
 * Write a session record to `<id>.json` and update the index cache.
 *
 * ## Session-lifecycle-state ownership (see DESIGN.md)
 *
 * UI-authored lifecycle fields (`closed`, `closed_at`), the UI-owned favorite
 * state (`favorite`, `favorited_at`), and the UI-owned display `name` are
 * **read-preserved** on every daemon write: before serializing, we read the
 * current on-disk `<id>.json` and overwrite the in-memory record's
 * lifecycle / favorite / name fields with the on-disk values. This means a
 * UI PATCH that flipped `closed=true` or `favorite=true`, or renamed the
 * session, survives the next daemon checkpoint — the daemon can never
 * silently revert user intent. (The daemon never legitimately renames a
 * session, so preserving `name` from disk has no productive write to
 * suppress.)
 *
 * The **one authorized daemon writer** of these fields is `closeSession`
 * (and its privileged helper variants): it bypasses the preserve step so it
 * can write `closed: true` from the daemon side. Finalization sites use the
 * boundary variants, which append finalized messages before writing the slim
 * record; periodic checkpoints and scalar edits use the non-boundary variants,
 * which never touch the messages log.
 */
export async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await writeSessionRecordInternal(record, {
    messagePersistence: "checkpoint",
    preserveLifecycle: true,
  });
}

export async function writeSessionRecordAtBoundary(record: SessionRecord): Promise<void> {
  await writeSessionRecordInternal(record, {
    messagePersistence: "boundary",
    preserveLifecycle: true,
  });
}

/**
 * Privileged write path — bypasses the read-preserve-lifecycle step so the
 * daemon's authorized closer (`closeSession`) can persist `closed: true` /
 * `closed_at`. All other daemon paths must use plain `writeSessionRecord`.
 */
export async function writeSessionRecordWithLifecycle(record: SessionRecord): Promise<void> {
  await writeSessionRecordInternal(record, {
    messagePersistence: "checkpoint",
    preserveLifecycle: false,
  });
}

export async function writeSessionRecordAtBoundaryWithLifecycle(
  record: SessionRecord,
): Promise<void> {
  await writeSessionRecordInternal(record, {
    messagePersistence: "boundary",
    preserveLifecycle: false,
  });
}

/**
 * Preserving write variant for callers that already hold the persisted
 * lifecycle from a fresh `readPersistedLifecycle` read — the live-checkpoint
 * path, which previously parsed the same multi-MB record twice per
 * checkpoint (once for its closed-state merge, once inside the write).
 * Semantics are identical to `writeSessionRecord`; `persisted` may be
 * undefined when the file was missing ("no prior state to preserve").
 */
export async function writeSessionRecordWithPersistedLifecycle(
  record: SessionRecord,
  persisted: PersistedSessionLifecycle | undefined,
): Promise<void> {
  await writeSessionRecordInternal(record, {
    messagePersistence: "checkpoint",
    preserveLifecycle: true,
    persisted: { value: persisted },
  });
}

async function writeSessionRecordInternal(
  record: SessionRecord,
  options: {
    messagePersistence: "checkpoint" | "boundary";
    preserveLifecycle: boolean;
    /** Wrapper distinguishes "caller provided a read result (possibly
     * undefined)" from "not provided — read from disk here". */
    persisted?: { value: PersistedSessionLifecycle | undefined };
  },
): Promise<void> {
  await measurePerf("session.write_record", async () => {
    await ensureSessionDir();

    if (options.preserveLifecycle) {
      const persistedLifecycle = options.persisted
        ? options.persisted.value
        : await readPersistedLifecycle(record.acpxRecordId);
      if (persistedLifecycle) {
        record.closed = persistedLifecycle.closed;
        record.closedAt = persistedLifecycle.closedAt;
        record.favorite = persistedLifecycle.favorite;
        record.favoritedAt = persistedLifecycle.favoritedAt;
        record.name = persistedLifecycle.name;
        // `template` is an acpx-ui-owned marker the daemon/agent never authors, so the
        // agent-exit checkpoint flush of a (possibly stale) in-memory record must adopt
        // the on-disk value rather than overwrite it — same read-preserve contract as
        // closed/favorite/name. Without this, marking a template while its agent is live
        // then letting the agent gracefully disconnect (connection_close) clobbers the
        // marker and the template silently vanishes from ?view=templates (FW-16).
        record.template = persistedLifecycle.template;
        // Keep updated_at monotonic: a stale in-memory flush must not roll it back below
        // what is already on disk (e.g. the template-mark write). A genuinely newer
        // in-memory value still wins.
        if (
          persistedLifecycle.updatedAt !== undefined &&
          persistedLifecycle.updatedAt > record.updated_at
        ) {
          record.updated_at = persistedLifecycle.updatedAt;
        }
      }
    }

    const sessionDir = sessionBaseDir();
    const logPath = messagesLogPath(sessionDir, record.acpxRecordId);
    if (options.messagePersistence === "boundary") {
      await writeMessagesLogBoundary(record, logPath);
    } else {
      await clearMissingMessagesLogPointerForWrite(record, logPath);
    }

    const persisted = serializeSessionRecordForDisk(record, { messages: "split-tail" });
    assertPersistedKeyPolicy(persisted);

    const file = sessionFilePath(record.acpxRecordId);
    const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    // Compact JSON: parses identically everywhere, saves ~30-40% of bytes and
    // stringify CPU on every checkpoint of a multi-MB record.
    const payload = JSON.stringify(persisted);
    await fs.writeFile(tempFile, `${payload}\n`, "utf8");
    await fs.rename(tempFile, file);

    const fileName = path.basename(file);
    // Membership-immediate / scalar-throttled index update (W2.3). The
    // privileged lifecycle path (close/favorite/name) always writes
    // immediately — human-frequency and freshness-sensitive.
    await updateSessionIndexForRecordWrite(sessionDir, toSessionIndexEntry(record, fileName), {
      immediate: !options.preserveLifecycle,
    });
  });
}

async function writeMessagesLogBoundary(record: SessionRecord, logPath: string): Promise<void> {
  await prepareMessagesLogForBoundary(record, logPath);

  const loggedCount = getLoggedMessageCount(record);
  const messagesToAppend = record.messages.slice(loggedCount);
  await appendFinalizedMessagesToLog(record, logPath, messagesToAppend);
  if (messagesToAppend.length > 0) {
    markAllMessagesLogged(record);
  }

  if (record.messagesLog) {
    await compactMessagesLog(record, logPath, resolveMessagesLogCompactBytes());
  }
}

export async function resolveSessionRecord(sessionId: string): Promise<SessionRecord> {
  await ensureSessionDir();

  const directPath = sessionFilePath(sessionId);
  try {
    const directPayload = await measurePerf("session.resolve_direct", async () => {
      return await fs.readFile(directPath, "utf8");
    });
    const directRecord = parseSessionRecord(JSON.parse(directPayload));
    if (directRecord) {
      return await hydrateSessionMessagesFromLog(
        directRecord,
        messagesLogPath(sessionBaseDir(), directRecord.acpxRecordId),
      );
    }
  } catch {
    // fallback to indexed search
  }

  const entries = await loadSessionIndexEntries();
  const exactEntries = entries.filter(
    (entry) => entry.acpxRecordId === sessionId || entry.acpSessionId === sessionId,
  );
  const exactRecords = (
    await Promise.all(exactEntries.map((entry) => loadRecordFromIndexEntry(entry)))
  ).filter((entry): entry is SessionRecord => Boolean(entry));
  if (exactRecords.length === 1) {
    return exactRecords[0];
  }
  if (exactRecords.length > 1) {
    throw new SessionResolutionError(`Multiple sessions match id: ${sessionId}`);
  }

  const suffixEntries = entries.filter(
    (entry) => entry.acpxRecordId.endsWith(sessionId) || entry.acpSessionId.endsWith(sessionId),
  );
  const suffixRecords = (
    await Promise.all(suffixEntries.map((entry) => loadRecordFromIndexEntry(entry)))
  ).filter((entry): entry is SessionRecord => Boolean(entry));
  if (suffixRecords.length === 1) {
    return suffixRecords[0];
  }
  if (suffixRecords.length > 1) {
    throw new SessionResolutionError(`Session id is ambiguous: ${sessionId}`);
  }

  incrementPerfCounter("session.resolve_miss");
  throw new SessionNotFoundError(sessionId);
}

function hasGitDirectory(dir: string): boolean {
  const gitPath = path.join(dir, ".git");
  try {
    return statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

function isWithinBoundary(boundary: string, target: string): boolean {
  const relative = path.relative(boundary, target);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function absolutePath(value: string): string {
  return path.resolve(value);
}

export function findGitRepositoryRoot(startDir: string): string | undefined {
  let current = absolutePath(startDir);
  const root = path.parse(current).root;

  for (;;) {
    if (hasGitDirectory(current)) {
      return current;
    }

    if (current === root) {
      return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function normalizeName(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export async function listSessions(): Promise<SessionRecord[]> {
  await ensureSessionDir();
  const entries = await loadSessionIndexEntries();
  const records: SessionRecord[] = [];

  for (const entry of entries) {
    const parsed = await loadRecordFromIndexEntry(entry);
    if (parsed) {
      records.push(parsed);
    }
  }

  records.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return records;
}

export async function listSessionsForAgent(
  agentCommand: string,
  agentName?: string,
): Promise<SessionRecord[]> {
  const entries = (await loadSessionIndexEntries()).filter(
    (session) =>
      matchesAgentIdentity(session, agentCommand, agentName) && session.kind !== "subagent",
  );
  const records = await Promise.all(entries.map((entry) => loadRecordFromIndexEntry(entry)));
  return records
    .filter((entry): entry is SessionRecord => Boolean(entry))
    .toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

/**
 * A session is a reusable template when acpx-ui has flagged it via the top-level
 * `template` block (an acpx-ui-owned marker the daemon parses + re-serializes
 * untouched). Centralized so the CLI template verbs and acpx-ui agree on exactly
 * one predicate; if the marker representation ever changes, change it only here.
 */
export function isTemplateRecord(record: Pick<SessionRecord, "template">): boolean {
  return record.template?.enabled === true;
}

export async function listSubagentsForSession(
  parentAcpxRecordId: string,
): Promise<SessionRecord[]> {
  const entries = (await loadSessionIndexEntries()).filter(
    (session) => session.kind === "subagent",
  );
  const records = await Promise.all(entries.map((entry) => loadRecordFromIndexEntry(entry)));
  return records
    .filter((entry): entry is SessionRecord => Boolean(entry))
    .filter((entry) => entry.parentSessionId === parentAcpxRecordId)
    .toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

export async function findSession(options: FindSessionOptions): Promise<SessionRecord | undefined> {
  const normalizedCwd = absolutePath(options.cwd);
  const normalizedName = normalizeName(options.name);
  const entries = await loadSessionIndexEntries();
  const match = entries.find(
    (session) =>
      matchesAgentIdentity(session, options.agentCommand, options.agentName) &&
      matchesSessionEntry(session, normalizedCwd, normalizedName, options.includeClosed),
  );
  if (!match) {
    return undefined;
  }
  return await loadRecordFromIndexEntry(match);
}

export async function findSessionByDirectoryWalk(
  options: FindSessionByDirectoryWalkOptions,
): Promise<SessionRecord | undefined> {
  const normalizedName = normalizeName(options.name);
  const normalizedStart = absolutePath(options.cwd);
  const normalizedBoundary = absolutePath(options.boundary ?? normalizedStart);
  const walkBoundary = isWithinBoundary(normalizedBoundary, normalizedStart)
    ? normalizedBoundary
    : normalizedStart;
  const sessions = (await loadSessionIndexEntries()).filter((session) =>
    matchesAgentIdentity(session, options.agentCommand, options.agentName),
  );

  let current = normalizedStart;
  const walkRoot = path.parse(current).root;

  for (;;) {
    const match = sessions.find((session) => matchesSessionEntry(session, current, normalizedName));
    if (match) {
      return await loadRecordFromIndexEntry(match);
    }

    const parent = nextWalkParent(current, walkBoundary, walkRoot);
    if (!parent) {
      return undefined;
    }
    current = parent;
  }
}

function nextWalkParent(
  current: string,
  walkBoundary: string,
  walkRoot: string,
): string | undefined {
  if (current === walkBoundary || current === walkRoot) {
    return undefined;
  }

  const parent = path.dirname(current);
  if (parent === current || !isWithinBoundary(walkBoundary, parent)) {
    return undefined;
  }

  return parent;
}

function killSignalCandidates(signal: NodeJS.Signals | undefined): NodeJS.Signals[] {
  if (!signal) {
    return ["SIGTERM", "SIGKILL"];
  }

  const normalized = signal.toUpperCase() as NodeJS.Signals;
  if (normalized === "SIGKILL") {
    return ["SIGKILL"];
  }

  return [normalized, "SIGKILL"];
}

export type PruneOptions = {
  agentCommand?: string;
  agentName?: string;
  before?: Date;
  olderThanMs?: number;
  includeHistory?: boolean;
  dryRun?: boolean;
};

export type PruneResult = {
  pruned: SessionRecord[];
  bytesFreed: number;
  dryRun: boolean;
};

export type MigrateMessagesOptions = {
  dryRun?: boolean;
  includeActive?: boolean;
};

export type MigrateMessagesResult = {
  scanned: number;
  migrated: number;
  skippedActive: number;
  skippedAlreadySplit: number;
  failed: number;
  dryRun: boolean;
};

type MigrateMessagesEntryResult = "migrated" | "active" | "already-split" | "failed";

function closedAtOrLastUsedAt(record: SessionRecord): string {
  return record.closedAt ?? record.lastUsedAt;
}

function isSessionStreamFile(fileName: string, safeId: string): boolean {
  return (
    fileName === `${safeId}.stream.ndjson` ||
    fileName === `${safeId}.stream.lock` ||
    fileName.startsWith(`${safeId}.stream.`)
  );
}

export async function pruneSessions(options: PruneOptions = {}): Promise<PruneResult> {
  await ensureSessionDir();
  const entries = await loadSessionIndexEntries();

  const eligible = filterPruneCandidates(entries, options.agentCommand, options.agentName);

  const cutoff =
    options.before ??
    (options.olderThanMs != null ? new Date(Date.now() - options.olderThanMs) : undefined);

  const records = await loadPrunableRecords(eligible, cutoff);

  if (options.dryRun) {
    return { pruned: records, bytesFreed: 0, dryRun: true };
  }

  const sessionDir = sessionBaseDir();
  let bytesFreed = 0;

  // Read the directory once upfront so stream-file matching doesn't re-read
  // it for every session in the loop.
  let dirEntries: string[] = [];
  if (options.includeHistory) {
    try {
      dirEntries = await fs.readdir(sessionDir);
    } catch {
      // ignore
    }
  }

  for (const record of records) {
    bytesFreed += await pruneSessionFiles(
      record,
      sessionDir,
      dirEntries,
      options.includeHistory === true,
    );
  }

  await rebuildSessionIndex(sessionDir, "prune").catch(() => {
    // best effort cache rebuild
  });

  return { pruned: records, bytesFreed, dryRun: false };
}

export async function migrateSessionMessages(
  options: MigrateMessagesOptions = {},
): Promise<MigrateMessagesResult> {
  await ensureSessionDir();
  const entries = await loadSessionIndexEntries();
  const result: MigrateMessagesResult = {
    scanned: 0,
    migrated: 0,
    skippedActive: 0,
    skippedAlreadySplit: 0,
    failed: 0,
    dryRun: options.dryRun === true,
  };

  for (const entry of entries) {
    result.scanned += 1;
    tallyMigrateMessagesEntryResult(
      result,
      await migrateSessionMessagesEntry(entry, options, result.dryRun),
    );
  }

  return result;
}

async function migrateSessionMessagesEntry(
  entry: SessionIndexEntry,
  options: MigrateMessagesOptions,
  dryRun: boolean,
): Promise<MigrateMessagesEntryResult> {
  const record = await loadRecordFromIndexEntry(entry);
  if (!record) {
    return "failed";
  }

  if (record.messagesLog) {
    return "already-split";
  }

  if (!record.closed && options.includeActive !== true && isProcessAlive(record.pid)) {
    return "active";
  }

  if (dryRun) {
    return "migrated";
  }

  try {
    await writeSessionRecordAtBoundary(record);
    return "migrated";
  } catch {
    return "failed";
  }
}

function tallyMigrateMessagesEntryResult(
  result: MigrateMessagesResult,
  entryResult: MigrateMessagesEntryResult,
): void {
  if (entryResult === "migrated") {
    result.migrated += 1;
  } else if (entryResult === "active") {
    result.skippedActive += 1;
  } else if (entryResult === "already-split") {
    result.skippedAlreadySplit += 1;
  } else {
    result.failed += 1;
  }
}

function filterPruneCandidates(
  entries: SessionIndexEntry[],
  agentCommand: string | undefined,
  agentName: string | undefined,
): SessionIndexEntry[] {
  return entries.filter(
    (entry) =>
      entry.closed && (!agentCommand || matchesAgentIdentity(entry, agentCommand, agentName)),
  );
}

async function loadPrunableRecords(
  entries: SessionIndexEntry[],
  cutoff: Date | undefined,
): Promise<SessionRecord[]> {
  const records: SessionRecord[] = [];
  const cutoffIso = cutoff?.toISOString();
  for (const entry of entries) {
    const record = await loadRecordFromIndexEntry(entry);
    if (record && isBeforeCutoff(record, cutoffIso)) {
      records.push(record);
    }
  }
  return records;
}

function isBeforeCutoff(record: SessionRecord, cutoffIso: string | undefined): boolean {
  return !cutoffIso || closedAtOrLastUsedAt(record) < cutoffIso;
}

async function pruneSessionFiles(
  record: SessionRecord,
  sessionDir: string,
  dirEntries: string[],
  includeHistory: boolean,
): Promise<number> {
  const safeId = encodeURIComponent(record.acpxRecordId);
  let bytesFreed = await unlinkCountingBytes(path.join(sessionDir, `${safeId}.json`));
  const logPath = path.join(sessionDir, messagesLogFileName(record.acpxRecordId));
  bytesFreed += await unlinkCountingBytes(logPath);
  bytesFreed += await unlinkCountingBytes(messagesLogStalePath(logPath));
  if (includeHistory) {
    for (const name of dirEntries.filter((entry) => isSessionStreamFile(entry, safeId))) {
      bytesFreed += await unlinkCountingBytes(path.join(sessionDir, name));
    }
  }
  return bytesFreed;
}

async function unlinkCountingBytes(filePath: string): Promise<number> {
  let bytes = 0;
  try {
    const stat = await fs.stat(filePath);
    bytes = stat.size;
  } catch {
    // file already gone
  }
  await fs.unlink(filePath).catch(() => undefined);
  return bytes;
}

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
export async function closeSession(id: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(id);
  const now = isoNow();

  if (record.pid) {
    for (const signal of killSignalCandidates(record.lastAgentExitSignal ?? undefined)) {
      try {
        process.kill(record.pid, signal);
      } catch {
        // ignore
      }
    }
  }

  record.closed = true;
  record.closedAt = now;
  record.pid = undefined;
  record.lastUsedAt = now;
  record.lastPromptAt = record.lastPromptAt ?? now;

  // Privileged write: closeSession is the single daemon-authorized writer of
  // lifecycle fields. See the writeSessionRecord doc comment for the rules.
  await writeSessionRecordAtBoundaryWithLifecycle(record);

  // Also mark any subagents of this session as closed. Cascade is operational,
  // not user-intent, and runs under the same privileged write path.
  if (record.subagents && record.subagents.length > 0) {
    for (const subagentRef of record.subagents) {
      try {
        const subagentRecord = await resolveSessionRecord(subagentRef.acpxRecordId);
        if (!subagentRecord.closed) {
          subagentRecord.closed = true;
          subagentRecord.closedAt = now;
          subagentRecord.lastUsedAt = now;
          await writeSessionRecordAtBoundaryWithLifecycle(subagentRecord);
        }
      } catch {
        // best effort
      }
    }
  }

  // No index rebuild here: the lifecycle writes above already updated the
  // affected entries, and the full-store re-parse is reserved for a missing
  // or unparseable index.json (incremental reconcile heals any drift).
  return record;
}
