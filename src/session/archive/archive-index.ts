import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withAdvisoryLock } from "../persistence/index-lock.js";
import { archiveIndexDir } from "./paths.js";

/**
 * `ARCHIVE-INDEX/<YYYY-MM>.json` — the list index for the cold tier
 * (formats §4).
 *
 * ⚠️ A CACHE, NEVER TRUTH. THE FILES ARE TRUTH. Every read path must behave
 * correctly with the whole `ARCHIVE-INDEX/` directory deleted — degraded (a
 * rebuild, or an empty list) but never wrong. Point lookups deliberately do not
 * consult it at all: with original filenames preserved, "is id X archived?" is
 * `exists(<archive>/<safeId>.json)`, an O(1) ext4 htree lookup. Only the list view
 * needs this file, and only for metadata.
 *
 * Sharded by archived-at month so NO read path is ever O(all-time-archived): the
 * default newest-first page reads one shard, a retention run rewrites one shard, a
 * restore rewrites one shard.
 */

export const ARCHIVE_INDEX_SCHEMA = "acpx.session-archive-index.v1";

/** ⚠️ KEY ORDER IS PART OF THE FORMAT (formats §4.3) — build key by key, never by spread. */
export type ArchiveIndexEntry = {
  id: string;
  archivedAt: string;
  reason: string;
  wave: string;
  kind?: string;
  /** ⚠️ NOT `clean()`ed — faithful and JSON-escaped, unlike the manifest's column 10. */
  name?: string;
  cwd?: string;
  agentName?: string;
  brick?: string;
  closed?: boolean;
  closedAt?: string;
  lastUsedAt?: string;
  createdAt?: string;
  /** `$.last_seq` — an EVENT SEQUENCE, not a message count. Never label it as one. */
  lastSeq?: number;
  files: number;
  bytes: number;
};

export type ArchiveIndexShard = {
  schema: typeof ARCHIVE_INDEX_SCHEMA;
  shard: string;
  generatedAt: string;
  entries: ArchiveIndexEntry[];
};

export type ShardReadResult =
  | { status: "ok"; shard: ArchiveIndexShard; droppedEntries: number }
  | { status: "absent" }
  /** Unreadable, not JSON, or a schema mismatch — quarantine THIS shard only. */
  | { status: "corrupt"; detail: string };

const SHARD_NAME = /^(\d{4})-(\d{2})\.json$/;

export function shardKeyForArchivedAt(archivedAt: string): string {
  const ms = Date.parse(archivedAt);
  const date = Number.isFinite(ms) ? new Date(ms) : new Date();
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function shardPath(archiveDir: string, shardKey: string): string {
  return path.join(archiveIndexDir(archiveDir), `${shardKey}.json`);
}

function archiveIndexLockPath(archiveDir: string): string {
  return path.join(archiveIndexDir(archiveDir), ".lock");
}

export async function withArchiveIndexLock<T>(
  archiveDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  await fs.mkdir(archiveIndexDir(archiveDir), { recursive: true });
  return await withAdvisoryLock(archiveIndexLockPath(archiveDir), fn);
}

/**
 * ⚠️ THIS ARRAY IS THE FORMAT'S KEY ORDER, NOT A CONVENIENCE LIST. Entry key order
 * is part of the on-disk contract (formats §4.3), and a shard is compared
 * byte-for-byte after a rebuild (AC-11). Iterating it is what keeps the order in
 * ONE place instead of implicit in the sequence of a dozen `if` statements, where
 * a reordered edit would be invisible to every type check.
 */
const OPTIONAL_ENTRY_KEYS = [
  "kind",
  "name",
  "cwd",
  "agentName",
  "brick",
  "closed",
  "closedAt",
  "lastUsedAt",
  "createdAt",
  "lastSeq",
] as const satisfies readonly (keyof ArchiveIndexEntry)[];

/** ⚠️ Optional keys are OMITTED when absent, never `null` (formats §4.3). */
export function buildArchiveIndexEntry(input: ArchiveIndexEntry): ArchiveIndexEntry {
  const entry: Record<string, unknown> = {
    id: input.id,
    archivedAt: input.archivedAt,
    reason: input.reason,
    wave: input.wave,
  };
  for (const key of OPTIONAL_ENTRY_KEYS) {
    const value = input[key];
    if (value != null) {
      entry[key] = value;
    }
  }
  entry.files = input.files;
  entry.bytes = input.bytes;
  return entry as unknown as ArchiveIndexEntry;
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

type RequiredEntryFields = {
  id: string;
  archivedAt: string;
  reason: string;
  wave: string;
  files: number;
  bytes: number;
};

function requiredEntryFields(raw: Record<string, unknown>): RequiredEntryFields | undefined {
  const { id, archivedAt, reason, wave, files, bytes } = raw;
  if (typeof id !== "string" || typeof archivedAt !== "string") {
    return undefined;
  }
  if (typeof reason !== "string" || typeof wave !== "string") {
    return undefined;
  }
  if (typeof files !== "number" || typeof bytes !== "number") {
    return undefined;
  }
  return { id, archivedAt, reason, wave, files, bytes };
}

function parseEntry(value: unknown): ArchiveIndexEntry | undefined {
  const raw = asPlainObject(value);
  if (!raw) {
    return undefined;
  }
  const required = requiredEntryFields(raw);
  if (!required) {
    return undefined;
  }
  return buildArchiveIndexEntry({
    ...required,
    kind: str(raw.kind),
    name: str(raw.name),
    cwd: str(raw.cwd),
    agentName: str(raw.agentName),
    brick: str(raw.brick),
    closed: bool(raw.closed),
    closedAt: str(raw.closedAt),
    lastUsedAt: str(raw.lastUsedAt),
    createdAt: str(raw.createdAt),
    lastSeq: num(raw.lastSeq),
  });
}

/**
 * ⚠️ THE DIVERGENCE FROM `index.json` THAT MATTERS, AND IT IS DELIBERATE.
 * `readSessionIndex` discards the ENTIRE index if any single entry fails to parse
 * (`entries.length !== record.entries.length`), forcing a full-store re-parse —
 * precisely the cost this feature exists to remove. Here one bad entry is DROPPED
 * and the rest of the shard is used. Do not "fix" this into symmetry with
 * `readSessionIndex`.
 */
async function readShardJson(
  archiveDir: string,
  shardKey: string,
): Promise<
  { status: "absent" } | { status: "corrupt"; detail: string } | { status: "ok"; raw: unknown }
> {
  let payload: string;
  try {
    payload = await fs.readFile(shardPath(archiveDir, shardKey), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "absent" };
    }
    return { status: "corrupt", detail: (error as NodeJS.ErrnoException).code ?? "read-failed" };
  }
  try {
    return { status: "ok", raw: JSON.parse(payload) as unknown };
  } catch {
    return { status: "corrupt", detail: "invalid-json" };
  }
}

export async function readArchiveIndexShard(
  archiveDir: string,
  shardKey: string,
): Promise<ShardReadResult> {
  const read = await readShardJson(archiveDir, shardKey);
  if (read.status !== "ok") {
    return read;
  }
  const raw = asPlainObject(read.raw);
  if (!raw) {
    return { status: "corrupt", detail: "not-an-object" };
  }
  if (raw.schema !== ARCHIVE_INDEX_SCHEMA) {
    return { status: "corrupt", detail: `schema:${String(raw.schema)}` };
  }
  if (!Array.isArray(raw.entries)) {
    return { status: "corrupt", detail: "entries-not-an-array" };
  }
  const { entries, dropped } = parseEntries(raw.entries);
  return {
    status: "ok",
    droppedEntries: dropped,
    shard: {
      schema: ARCHIVE_INDEX_SCHEMA,
      shard: str(raw.shard) ?? shardKey,
      generatedAt: str(raw.generatedAt) ?? "",
      entries,
    },
  };
}

function parseEntries(raw: readonly unknown[]): {
  entries: ArchiveIndexEntry[];
  dropped: number;
} {
  const entries: ArchiveIndexEntry[] = [];
  let dropped = 0;
  for (const candidate of raw) {
    const entry = parseEntry(candidate);
    if (entry) {
      entries.push(entry);
    } else {
      dropped += 1;
    }
  }
  return { entries, dropped };
}

/** Rename a bad shard aside — NEVER delete it — so a rebuild is auditable. */
export async function quarantineArchiveIndexShard(
  archiveDir: string,
  shardKey: string,
): Promise<string | undefined> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const target = `${shardPath(archiveDir, shardKey)}.corrupt-${stamp}`;
  try {
    await fs.rename(shardPath(archiveDir, shardKey), target);
    return target;
  } catch {
    return undefined;
  }
}

/**
 * ⚠️ TOTAL ORDER, SO TWO REBUILDS OF THE SAME INPUT ARE BYTE-IDENTICAL.
 * `archivedAt` descending alone is not a total order — ids archived in the same
 * run share one `at` by construction (formats §3.2 column 1), which is most of a
 * shard. The `id` tiebreak is what makes AC-11's "rebuilds it to a byte-identical
 * file" checkable rather than luck.
 */
function sortEntries(entries: ArchiveIndexEntry[]): ArchiveIndexEntry[] {
  return entries.toSorted(
    (a, b) => b.archivedAt.localeCompare(a.archivedAt) || a.id.localeCompare(b.id),
  );
}

export async function writeArchiveIndexShard(
  archiveDir: string,
  shardKey: string,
  entries: readonly ArchiveIndexEntry[],
  generatedAt: string,
): Promise<void> {
  const dir = archiveIndexDir(archiveDir);
  await fs.mkdir(dir, { recursive: true });
  const filePath = shardPath(archiveDir, shardKey);
  // randomUUID is REQUIRED, not decorative: `${pid}.${Date.now()}` alone collides
  // between two writes in the same millisecond, and the loser hits ENOENT on
  // rename — turning a concurrent write into a thrown error. `writeSessionIndex`
  // records the same finding for index.json.
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  // Compact JSON, matching writeSessionIndex's choice: parses identically for
  // every consumer, saves ~30-40% of bytes and stringify CPU.
  const payload = JSON.stringify({
    schema: ARCHIVE_INDEX_SCHEMA,
    shard: shardKey,
    generatedAt,
    entries: sortEntries([...entries]),
  });
  await fs.writeFile(tempFile, `${payload}\n`, "utf8");
  await fs.rename(tempFile, filePath);
}

export type ShardMutation = {
  /** Entries to merge in by id (last write wins). */
  upsert?: readonly ArchiveIndexEntry[];
  /** Ids to remove — a restore's half of the contract. */
  remove?: readonly string[];
};

/**
 * Read → merge → write one shard, atomically, under the archive-index lock.
 *
 * A run spanning several months touches several shards. Each write is independent
 * and individually atomic; there is NO cross-shard transaction and none is needed
 * — the shards are a partition, never a join.
 */
/**
 * Load a shard's entries for a read-modify-write, quarantining it if it is
 * unusable. Returns `[]` for absent and for corrupt — in the corrupt case the bad
 * file has been renamed aside first, never deleted.
 */
async function loadShardEntriesForMutation(
  archiveDir: string,
  shardKey: string,
  onWarning: ((message: string) => void) | undefined,
): Promise<ArchiveIndexEntry[]> {
  const existing = await readArchiveIndexShard(archiveDir, shardKey);
  if (existing.status === "absent") {
    return [];
  }
  if (existing.status === "corrupt") {
    const target = await quarantineArchiveIndexShard(archiveDir, shardKey);
    const quarantined = target ? ` — quarantined as ${path.basename(target)}` : "";
    onWarning?.(
      `[acpx] archive index shard ${shardKey} is corrupt (${existing.detail})${quarantined}; rebuilding from what this run knows`,
    );
    return [];
  }
  if (existing.droppedEntries > 0) {
    const plural = existing.droppedEntries === 1 ? "y" : "ies";
    onWarning?.(
      `[acpx] archive index shard ${shardKey}: dropped ${existing.droppedEntries} unparseable entr${plural}`,
    );
  }
  return existing.shard.entries;
}

export async function mutateArchiveIndexShard(
  archiveDir: string,
  shardKey: string,
  mutation: ShardMutation,
  generatedAt: string,
  onWarning?: (message: string) => void,
): Promise<void> {
  const entries = await loadShardEntriesForMutation(archiveDir, shardKey, onWarning);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const id of mutation.remove ?? []) {
    byId.delete(id);
  }
  for (const entry of mutation.upsert ?? []) {
    byId.set(entry.id, entry);
  }
  await writeArchiveIndexShard(archiveDir, shardKey, [...byId.values()], generatedAt);
}

export async function listArchiveIndexShardKeys(archiveDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(archiveIndexDir(archiveDir));
  } catch {
    return [];
  }
  return names
    .filter((name) => SHARD_NAME.test(name))
    .map((name) => name.slice(0, -".json".length))
    .toSorted((a, b) => b.localeCompare(a));
}
