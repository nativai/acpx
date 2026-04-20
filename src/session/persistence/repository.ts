import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionNotFoundError, SessionResolutionError } from "../../errors.js";
import { incrementPerfCounter, measurePerf } from "../../perf-metrics.js";
import { assertPersistedKeyPolicy } from "../../persisted-key-policy.js";
import type { SessionRecord } from "../../types.js";
import {
  loadOrRebuildSessionIndex,
  rebuildSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
  type SessionIndexEntry,
} from "./index.js";
import { parseSessionRecord } from "./parse.js";
import { serializeSessionRecordForDisk } from "./serialize.js";

export const DEFAULT_HISTORY_LIMIT = 20;

type FindSessionOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  includeClosed?: boolean;
};

type FindSessionByDirectoryWalkOptions = {
  agentCommand: string;
  cwd: string;
  name?: string;
  boundary?: string;
};

function sessionFilePath(acpxRecordId: string): string {
  const safeId = encodeURIComponent(acpxRecordId);
  return path.join(sessionBaseDir(), `${safeId}.json`);
}

function sessionBaseDir(): string {
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
    return parseSessionRecord(JSON.parse(payload)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function loadSessionIndexEntries(): Promise<SessionIndexEntry[]> {
  await ensureSessionDir();
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

/**
 * Read the current on-disk <id>.json (if present) and return the persisted
 * lifecycle fields (closed/closedAt). Returns undefined if the file is missing
 * or unreadable — callers should treat that as "no prior state to preserve."
 */
async function readPersistedLifecycle(
  acpxRecordId: string,
): Promise<{ closed: boolean | undefined; closedAt: string | undefined } | undefined> {
  try {
    const payload = await fs.readFile(sessionFilePath(acpxRecordId), "utf8");
    const parsed = parseSessionRecord(JSON.parse(payload));
    if (!parsed) {
      return undefined;
    }
    return { closed: parsed.closed, closedAt: parsed.closedAt };
  } catch {
    return undefined;
  }
}

/**
 * Write a session record to `<id>.json` and update the index cache.
 *
 * ## Session-lifecycle-state ownership (see DESIGN.md)
 *
 * UI-authored lifecycle fields (`closed`, `closed_at`) are **read-preserved**
 * on every daemon write: before serializing, we read the current on-disk
 * `<id>.json` and overwrite the in-memory `record.closed` / `record.closedAt`
 * with the on-disk values. This means a UI PATCH that flipped `closed=true`
 * survives the next daemon checkpoint — the daemon can never silently revert
 * user intent.
 *
 * The **one authorized daemon writer** of these fields is `closeSession`
 * (and its privileged helper variants): it calls
 * `writeSessionRecordWithLifecycle` to bypass the preserve step so it can
 * write `closed: true` from the daemon side. Every other writer — periodic
 * checkpoints, end-of-turn flushes, subagent updates — must use plain
 * `writeSessionRecord` and will be transparent to lifecycle state.
 *
 * `toSessionIndexEntry` and `serializeSessionRecordForDisk` remain unchanged:
 * they simply consume whatever `record.closed` is at call time, which is
 * already the correct value because the preserve step ran first.
 */
export async function writeSessionRecord(record: SessionRecord): Promise<void> {
  await writeSessionRecordInternal(record, { preserveLifecycle: true });
}

/**
 * Privileged write path — bypasses the read-preserve-lifecycle step so the
 * daemon's authorized closer (`closeSession`) can persist `closed: true` /
 * `closed_at`. All other daemon paths must use plain `writeSessionRecord`.
 */
export async function writeSessionRecordWithLifecycle(record: SessionRecord): Promise<void> {
  await writeSessionRecordInternal(record, { preserveLifecycle: false });
}

async function writeSessionRecordInternal(
  record: SessionRecord,
  options: { preserveLifecycle: boolean },
): Promise<void> {
  await measurePerf("session.write_record", async () => {
    await ensureSessionDir();

    if (options.preserveLifecycle) {
      const persistedLifecycle = await readPersistedLifecycle(record.acpxRecordId);
      if (persistedLifecycle) {
        record.closed = persistedLifecycle.closed;
        record.closedAt = persistedLifecycle.closedAt;
      }
    }

    const persisted = serializeSessionRecordForDisk(record);
    assertPersistedKeyPolicy(persisted);

    const file = sessionFilePath(record.acpxRecordId);
    const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(persisted, null, 2);
    await fs.writeFile(tempFile, `${payload}\n`, "utf8");
    await fs.rename(tempFile, file);

    const sessionDir = sessionBaseDir();
    const index = await loadOrRebuildSessionIndex(sessionDir);
    const fileName = path.basename(file);
    const entries = index.entries.filter((entry) => entry.file !== fileName);
    entries.push(toSessionIndexEntry(record, fileName));
    const files = [...new Set([...index.files.filter((entry) => entry !== fileName), fileName])];
    await writeSessionIndex(sessionDir, { files, entries });
  });
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
      return directRecord;
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

export async function listSessionsForAgent(agentCommand: string): Promise<SessionRecord[]> {
  const entries = (await loadSessionIndexEntries()).filter(
    (session) => session.agentCommand === agentCommand && session.kind !== "subagent",
  );
  const records = await Promise.all(entries.map((entry) => loadRecordFromIndexEntry(entry)));
  return records
    .filter((entry): entry is SessionRecord => Boolean(entry))
    .toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
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
      session.agentCommand === options.agentCommand &&
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
  const sessions = (await loadSessionIndexEntries()).filter(
    (session) => session.agentCommand === options.agentCommand,
  );

  let current = normalizedStart;
  const walkRoot = path.parse(current).root;

  for (;;) {
    const match = sessions.find((session) => matchesSessionEntry(session, current, normalizedName));
    if (match) {
      return await loadRecordFromIndexEntry(match);
    }

    if (current === walkBoundary || current === walkRoot) {
      return undefined;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }

    current = parent;

    if (!isWithinBoundary(walkBoundary, current)) {
      return undefined;
    }
  }
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
  await writeSessionRecordWithLifecycle(record);

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
          await writeSessionRecordWithLifecycle(subagentRecord);
        }
      } catch {
        // best effort
      }
    }
  }

  await rebuildSessionIndex(sessionBaseDir()).catch(() => {
    // best effort cache rebuild
  });
  return record;
}
