import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionNotFoundError, SessionResolutionError } from "../../errors.js";
import { incrementPerfCounter, measurePerf } from "../../perf-metrics.js";
import { assertPersistedKeyPolicy } from "../../persisted-key-policy.js";
import type { SessionRecord } from "../../types.js";
import { getLoggedMessageCount, markAllMessagesLogged } from "../messages-log-bookkeeping.js";
import {
  appendFinalizedMessagesToLog,
  clearMissingMessagesLogPointerForWrite,
  compactMessagesLog,
  hydrateSessionMessagesFromLog,
  initializeEmptyMessagesLog,
  messagesLogFileName,
  messagesLogPath,
  messagesLogStalePath,
  prepareMessagesLogForBoundary,
  resolveMessagesLogCompactBytes,
} from "../messages-log.js";
import { appendDeletionManifest, type DeletionManifestEntry } from "./deletion-manifest.js";
import { withSessionIndexLock } from "./index-lock.js";
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
import {
  mergeRecordMetadataForPersist,
  rememberSessionMetadataBaseline,
} from "./metadata-merge.js";
import { mergeRecordPinnedModelForPersist, rememberSessionModelBaseline } from "./model-merge.js";
import { parseSessionRecord } from "./parse.js";
import { serializeSessionRecordForDisk } from "./serialize.js";
import {
  effectiveTemplateSlug,
  pickLatestTemplate,
  slugify,
  type TemplateOrderKey,
} from "./template-slug.js";

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

type ResolveSessionByExactNameOptions = {
  name: string;
  agentCommand?: string;
  agentName?: string;
  cwd?: string;
  includeClosed?: boolean;
  excludeSubagents?: boolean;
};

export type SessionNameCandidate = {
  acpxRecordId: string;
  agentCommand: string;
  agentName?: string;
  cwd: string;
};

export type SessionNameResolution =
  | { kind: "none" }
  | { kind: "found"; record: SessionRecord }
  | { kind: "ambiguous"; candidates: SessionNameCandidate[] };

function sessionFilePath(acpxRecordId: string): string {
  const safeId = encodeURIComponent(acpxRecordId);
  return path.join(sessionBaseDir(), `${safeId}.json`);
}

export function sessionBaseDir(): string {
  return path.join(process.env.ACPX_STATE_HOME || os.homedir(), ".acpx", "sessions");
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
  /** Current on-disk metadata; merged at write time so stale owner records do
   * not clobber concurrent UI/CLI metadata patches. */
  metadata: SessionRecord["metadata"];
  /** Extra fields the live-checkpoint closed-state merge needs — carried so
   * one read can serve both the preserve step and that merge (W2.4). */
  pid: number | undefined;
  acpx: SessionRecord["acpx"];
};

/**
 * Read the current on-disk <id>.json (if present) and return the persisted
 * lifecycle fields, UI-owned scalar state, and metadata snapshot. Returns
 * undefined if the file is missing or unreadable — callers should treat that
 * as "no prior state to preserve."
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
      metadata: parsed.metadata,
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
 * lifecycle from a fresh `readPersistedLifecycle` read. Metadata is still
 * reread inside the write so external metadata patches survive stale owner
 * checkpoints (W11). Semantics are otherwise identical to `writeSessionRecord`;
 * `persisted` may be undefined when the file was missing ("no prior state to
 * preserve").
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

function applyPersistedLifecycleForWrite(
  record: SessionRecord,
  persistedLifecycle: PersistedSessionLifecycle | undefined,
): void {
  if (!persistedLifecycle) {
    return;
  }
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

    const persistedLifecycle = options.persisted
      ? options.persisted.value
      : await readPersistedLifecycle(record.acpxRecordId);
    // When the caller supplied a (possibly stale) lifecycle snapshot, reread the
    // on-disk record ONCE so both metadata AND the pinned model merge against the
    // freshest concurrent state rather than the caller's snapshot. Otherwise the
    // fresh lifecycle read above already holds current disk state — no extra read.
    const freshPersisted = options.persisted
      ? await readPersistedLifecycle(record.acpxRecordId)
      : persistedLifecycle;
    const persistedMetadata = freshPersisted?.metadata;

    if (options.preserveLifecycle) {
      applyPersistedLifecycleForWrite(record, persistedLifecycle);
    }
    mergeRecordMetadataForPersist(record, persistedMetadata);
    // Same baseline-diff protection metadata gets (2c848d3), extended to the
    // pinned model: a stale/dropped write can't regress a record-pinned model,
    // while a deliberate set-model/subscription-switch/new --model still wins.
    mergeRecordPinnedModelForPersist(record, freshPersisted?.acpx);

    const sessionDir = sessionBaseDir();
    const logPath = messagesLogPath(sessionDir, record.acpxRecordId);
    if (options.messagePersistence === "boundary") {
      await writeMessagesLogBoundary(record, logPath);
    } else {
      await clearMissingMessagesLogPointerForWrite(record, logPath);
    }

    const persistedRecord = serializeSessionRecordForDisk(record, { messages: "split-tail" });
    assertPersistedKeyPolicy(persistedRecord);

    const file = sessionFilePath(record.acpxRecordId);
    // The temp name must be unique PER CALL, not per millisecond: two writes
    // from this process in the same millisecond used to build the identical
    // path, so the first rename won and the second hit ENOENT — turning a
    // concurrent record write into a thrown error. Reachable on the normal
    // mid-turn injection path (queue-owner-runtime drains the whole
    // midTurnBuffer synchronously, so several injections start in one tick and
    // race each other's recordPromptStart). Uniqueness, not serialization:
    // this is a filename collision, and ordering here is deliberately free.
    // Same shape already used by src/flows/store.ts.
    const tempFile = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    // Compact JSON: parses identically everywhere, saves ~30-40% of bytes and
    // stringify CPU on every checkpoint of a multi-MB record.
    const payload = JSON.stringify(persistedRecord);
    await fs.writeFile(tempFile, `${payload}\n`, "utf8");
    await fs.rename(tempFile, file);

    const fileName = path.basename(file);
    // Membership-immediate / scalar-throttled index update (W2.3). The
    // privileged lifecycle path (close/favorite/name) always writes
    // immediately — human-frequency and freshness-sensitive.
    await updateSessionIndexForRecordWrite(sessionDir, toSessionIndexEntry(record, fileName), {
      immediate: !options.preserveLifecycle,
    });
    rememberSessionMetadataBaseline(record);
    rememberSessionModelBaseline(record);
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

  // Converge the zero-message case. Guarded on `messages.length` rather than on
  // "did the append set a pointer", so it cannot mis-fire on a record that has
  // messages: with messages present there is always something to append here
  // (a cleared pointer always resets the logged count to 0 alongside), so the
  // append owns that case and this branch is unreachable for it.
  if (!record.messagesLog && record.messages.length === 0) {
    await initializeEmptyMessagesLog(record, logPath);
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

// ===========================================================================
// Template slug + version primitive (W13-01). acpx is the SOLE author of
// `template.slug` / `template.version`. The two algorithms it leans on
// (slugify, the "latest" comparator) live in template-slug.ts and are a frozen
// cross-repo contract mirrored byte-for-byte by acpx-ui.
// ===========================================================================

function indexEntryTemplateOrderKey(entry: SessionIndexEntry): TemplateOrderKey {
  return {
    version: entry.templateVersion,
    created_at: entry.templateCreatedAt,
    acpxRecordId: entry.acpxRecordId,
  };
}

// Index entries for the ENABLED templates that resolve/group under `slug`
// (effectiveSlug === slug). Subagents are never templates. Used by slug
// resolution and rollback (both enabled-gated, so a soft-retract drops a
// record from both at once).
async function enabledTemplateEntriesForSlug(slug: string): Promise<SessionIndexEntry[]> {
  const entries = await loadSessionIndexEntries();
  return entries.filter(
    (entry) =>
      entry.templateEnabled === true &&
      entry.kind !== "subagent" &&
      effectiveTemplateSlug(entry.templateSlug, entry.name) === slug,
  );
}

export type TemplateSelectorKind = "id" | "slug";
export type TemplateSelectorResult = {
  record: SessionRecord;
  selectorKind: TemplateSelectorKind;
};

/**
 * Resolve a `--from-template <arg>` selector: id-first, then slug. ONLY for the
 * --from-template path — the global `resolveSessionRecord` (which backs many
 * verbs) is deliberately NOT widened.
 *
 * 1. id semantics via `resolveSessionRecord` (direct file → exact id → unique
 *    suffix). A known id / unique suffix is a SNAPSHOT and is NEVER silently
 *    redirected to a slug. An AMBIGUOUS id is rethrown (surfaced), not fallen
 *    through. Only a true miss continues to (2).
 * 2. slug: among ENABLED templates whose effectiveSlug === arg, the Appendix-B
 *    latest. Runs off the index, then loads the single winner.
 * 3. miss: one clear error naming both attempts.
 *
 * Documented edge (E4): a slug made only of [0-9a-f] could in theory suffix-
 * match a record's UUID. Because step 1 is id-first and we only reach step 2 on
 * an id MISS, the id always wins when it exists — there is nothing to special-
 * case. Real slugs come from display names (letters g/i/n/r/s/t/x…) that a
 * hex+dash UUID suffix can't match, so the clash is theoretical.
 */
export async function resolveTemplateSelector(arg: string): Promise<TemplateSelectorResult> {
  try {
    const record = await resolveSessionRecord(arg);
    return { record, selectorKind: "id" };
  } catch (error) {
    if (error instanceof SessionResolutionError) {
      throw error; // ambiguous id — surface it, do NOT fall through to slug
    }
    if (!(error instanceof SessionNotFoundError)) {
      throw error; // unexpected failure — propagate
    }
    // SessionNotFoundError ⇒ id miss, fall through to slug resolution
  }

  const winner = pickLatestTemplate(
    await enabledTemplateEntriesForSlug(arg),
    indexEntryTemplateOrderKey,
  );
  if (winner) {
    const record = await loadRecordFromIndexEntry(winner);
    if (record) {
      return { record, selectorKind: "slug" };
    }
  }

  throw new SessionNotFoundError(`no template matches '${arg}' (tried session id, then slug)`);
}

// Canonicalize the slug to store at mark-time: an explicit `--slug` is run
// through slugify (idempotent on an already-canonical value) and must be
// non-empty; otherwise default to slugify(name). A degenerate name (slugifies
// to empty) ⇒ undefined: the mark leaves slug/version unset and the record
// groups/resolves by id (graceful — same as a UI-created slug-less template).
function resolveMarkSlug(
  record: SessionRecord,
  explicitSlug: string | undefined,
): string | undefined {
  if (explicitSlug !== undefined) {
    const slug = slugify(explicitSlug);
    if (slug === undefined) {
      throw new SessionResolutionError(
        `--slug '${explicitSlug}' has no [a-z0-9] characters; provide a non-empty slug`,
      );
    }
    return slug;
  }
  return record.name !== undefined ? slugify(record.name) : undefined;
}

// An index entry counts toward a slug's version-max when it IS or WAS a template
// (templateEnabled present: enabled OR soft-retracted — never a plain session or a
// subagent), it is not the record being marked, and its effectiveSlug matches —
// counting slug-less/version-less siblings via slugify(name).
function entryIsVersionPeer(entry: SessionIndexEntry, slug: string, selfRecordId: string): boolean {
  return (
    entry.templateEnabled !== undefined &&
    entry.kind !== "subagent" &&
    entry.acpxRecordId !== selfRecordId &&
    effectiveTemplateSlug(entry.templateSlug, entry.name) === slug
  );
}

// version = max(version ?? 0) + 1 over the effectiveSlug group, read from the
// INDEX (nuance #1). So a refresh always sorts latest even over prior versions
// that predate this feature. An idempotent re-mark under the SAME slug preserves
// the existing version (re-enabling an old version must not bump it to latest) —
// mirroring the created_at/source_session_id preserve idiom.
function markVersionForSlug(
  record: SessionRecord,
  slug: string,
  entries: SessionIndexEntry[],
): number {
  if (record.template?.slug === slug && typeof record.template.version === "number") {
    return record.template.version;
  }
  let max = 0;
  for (const entry of entries) {
    if (entryIsVersionPeer(entry, slug, record.acpxRecordId)) {
      max = Math.max(max, entry.templateVersion ?? 0);
    }
  }
  return max + 1;
}

/**
 * Persist a template mark, assigning slug + version under a single hold of the
 * index lock (E6): the max+1 read and the record write happen atomically, so two
 * concurrent marks under the same slug can't both read the same max. The lock is
 * re-entrant, so the privileged write's own immediate index update runs inline.
 * `record.template` must already carry the enabled/created_at/source/auto_prompt
 * block (built by the caller); this only adds slug/version then writes.
 */
export async function persistTemplateMark(
  record: SessionRecord,
  options: { slug?: string } = {},
): Promise<void> {
  await ensureSessionDir();
  await withSessionIndexLock(sessionBaseDir(), async () => {
    const slug = resolveMarkSlug(record, options.slug);
    if (slug !== undefined && record.template) {
      const version = markVersionForSlug(record, slug, await loadSessionIndexEntries());
      record.template.slug = slug;
      record.template.version = version;
    }
    await writeSessionRecordWithLifecycle(record);
  });
}

export type TemplateRollbackOutcome = "soft-retract" | "delete" | "noop";
export type TemplateRollbackTarget = {
  acpxRecordId: string;
  version: number | undefined;
};
export type TemplateRollbackResult = {
  slug: string;
  outcome: TemplateRollbackOutcome;
  retracted?: TemplateRollbackTarget;
  newLatest?: TemplateRollbackTarget;
};

/**
 * Retract the current latest version of `slug`. Default is a SOFT retract (flip
 * `template.enabled = false`, keeping slug/version/created_at/auto_prompt) so it
 * drops from both slug resolution and ?view=templates (both enabled-gated) and
 * re-enable restores it. `--delete` HARD-deletes the record + sidecars + index
 * entry (loses the version). The whole find→retract→find-new-latest runs under
 * one lock hold so it's atomic against a concurrent mark.
 */
export async function rollbackTemplateSlug(
  slug: string,
  options: { delete?: boolean } = {},
): Promise<TemplateRollbackResult> {
  await ensureSessionDir();
  return await withSessionIndexLock(sessionBaseDir(), async () => {
    const target = pickLatestTemplate(
      await enabledTemplateEntriesForSlug(slug),
      indexEntryTemplateOrderKey,
    );
    if (!target) {
      return { slug, outcome: "noop" };
    }
    if (options.delete === true) {
      await hardDeleteSessionRecord(target);
    } else {
      await softRetractTemplateRecord(target.acpxRecordId);
    }
    const newLatest = pickLatestTemplate(
      await enabledTemplateEntriesForSlug(slug),
      indexEntryTemplateOrderKey,
    );
    return {
      slug,
      outcome: options.delete === true ? "delete" : "soft-retract",
      retracted: { acpxRecordId: target.acpxRecordId, version: target.templateVersion },
      newLatest: newLatest
        ? { acpxRecordId: newLatest.acpxRecordId, version: newLatest.templateVersion }
        : undefined,
    };
  });
}

// Soft retract: keep the whole template block, only flip enabled:false. Distinct
// from `--disable`/unmark, which clears the block entirely (losing slug/version).
async function softRetractTemplateRecord(acpxRecordId: string): Promise<void> {
  const record = await resolveSessionRecord(acpxRecordId);
  if (record.template) {
    record.template = { ...record.template, enabled: false };
  }
  await writeSessionRecordWithLifecycle(record);
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // already absent — nothing to remove
  }
}

/**
 * Hard delete: record JSON + messages-log sidecars + owner log + stream sidecars
 * + the stream's timestamps index, then a rebuild to drop the now-missing index
 * entry (the same teardown prune uses).
 *
 * ⚠️ THIS IS THE SECOND OF THE acpx CLI's ONLY TWO record-deleting paths, and it
 * is the one that motivated the manifest. The `29eaff14` RCA's three baker
 * nights were destroyed HERE, not by a prune — a manifest written only by
 * `sessions prune` would have recorded nothing about any of them and that RCA
 * would have been exactly as hard. If you add a further record-deleting path TO
 * THE CLI, it needs a manifest write too, and `MANIFEST_COVERS` needs its name.
 *
 * Takes the INDEX ENTRY rather than a bare id because the manifest records the
 * session's identity and `SessionIndexEntry` carries no `createdAt`/`closedAt` —
 * `pickLatestTemplate` already has the entry in hand, so the record is loaded
 * from it. One ~2.7 KB read for a record that is about to be unlinked anyway,
 * and it keeps the entry schema uniform across both `op` values.
 *
 * A throw from the manifest write is safe under the index lock, verified rather
 * than assumed: `withSessionIndexLock` wraps `fn()` in nested `try/finally`, so
 * the lock file is released in the inner one and the in-process queue gate in
 * the outer. The failure propagates having deleted nothing — the same
 * fail-closed shape as the prune path, for free.
 */
async function hardDeleteSessionRecord(entry: SessionIndexEntry): Promise<void> {
  const sessionDir = sessionBaseDir();
  const acpxRecordId = entry.acpxRecordId;
  const safeId = encodeURIComponent(acpxRecordId);

  // Loaded BEFORE anything is unlinked, for the manifest. If it cannot be read,
  // fall back to the index entry's own projection — `name`/`cwd` are there, and
  // `createdAt`/`closedAt` are then ABSENT from the entry, which per the schema
  // means "we could not read it", never "it had none".
  const record = await loadRecordFromIndexEntry(entry).catch(() => undefined);

  // Write-ahead, exactly as the prune path: a failure here aborts having
  // destroyed nothing.
  await appendDeletionManifest(sessionDir, [
    {
      op: "templates_rollback_delete",
      at: isoNow(),
      id: acpxRecordId,
      name: record?.name ?? entry.name,
      cwd: record?.cwd ?? entry.cwd,
      createdAt: record?.createdAt,
      closedAt: record?.closedAt,
      // This path has no --include-history: it always takes everything.
      classes: deletedFileClasses(true),
    },
  ]);

  await unlinkHardDeletedFiles(sessionDir, acpxRecordId, safeId);
  await rebuildSessionIndex(sessionDir, "template-rollback-delete").catch(() => {
    // best-effort cache rebuild; the record files are already gone
  });
}

/**
 * Every file class a hard delete takes — the same set `pruneSessionFiles` takes
 * with history included, because this path has no `--include-history` to opt out
 * of. It must stay in step with `deletedFileClasses(true)`, which is what the
 * manifest entry above claims was destroyed.
 */
async function unlinkHardDeletedFiles(
  sessionDir: string,
  acpxRecordId: string,
  safeId: string,
): Promise<void> {
  await unlinkIfPresent(path.join(sessionDir, `${safeId}.json`));
  const logPath = path.join(sessionDir, messagesLogFileName(acpxRecordId));
  await unlinkIfPresent(logPath);
  await unlinkIfPresent(messagesLogStalePath(logPath));
  await unlinkIfPresent(ownerLogPath(sessionDir, safeId));
  await unlinkIfPresent(timestampsSidecarPath(sessionDir, safeId));
  try {
    const dirEntries = await fs.readdir(sessionDir);
    for (const name of dirEntries.filter((entry) => isSessionStreamFile(entry, safeId))) {
      await unlinkIfPresent(path.join(sessionDir, name));
    }
  } catch {
    // dir vanished between operations — nothing left to clean
  }
}

export type TemplateSlugAssignment = {
  acpxRecordId: string;
  name: string | undefined;
  slug: string;
  version: number;
};
export type MigrateSlugsResult = {
  scanned: number;
  assigned: number;
  skipped: number;
  degenerate: number;
  failed: number;
  dryRun: boolean;
  assignments: TemplateSlugAssignment[];
};

function disambiguateSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

// Deterministic created_at-asc, then acpxRecordId-asc, via a single composite key
// (NUL separator keeps the created_at boundary clean — neither field contains NUL).
function templateCreatedAtSortKey(record: SessionRecord): string {
  return `${record.template?.created_at ?? record.createdAt ?? ""}\u0000${record.acpxRecordId}`;
}

function byTemplateCreatedAtThenId(a: SessionRecord, b: SessionRecord): number {
  const aKey = templateCreatedAtSortKey(a);
  const bKey = templateCreatedAtSortKey(b);
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

type TemplateSlugPlan =
  | { kind: "assign"; slug: string; version: number }
  | { kind: "skipped" }
  | { kind: "degenerate" };

// The slug a record keeps (already-slugged) or is assigned during migration: a
// slug-less record gets a disambiguated slug (D3) added to `takenSlugs`. Returns
// undefined only for a degenerate name (slugifies to empty) — leave it slug-less.
function migrationSlugFor(record: SessionRecord, takenSlugs: Set<string>): string | undefined {
  const existing = record.template?.slug;
  if (existing !== undefined) {
    return existing;
  }
  const base = record.name !== undefined ? slugify(record.name) : undefined;
  if (base === undefined) {
    return undefined;
  }
  const slug = disambiguateSlug(base, takenSlugs);
  takenSlugs.add(slug);
  return slug;
}

// Decide the slug+version for one template record during migration. Skips an
// already slug+version-bearing record (idempotency); otherwise assigns the
// migration slug + the next version for that slug. Updates the in-memory state.
function planTemplateSlugMigration(
  record: SessionRecord,
  takenSlugs: Set<string>,
  maxVersionBySlug: Map<string, number>,
): TemplateSlugPlan {
  const { slug: existingSlug, version: existingVersion } = record.template ?? {};
  if (existingSlug !== undefined && typeof existingVersion === "number") {
    return { kind: "skipped" };
  }
  const slug = migrationSlugFor(record, takenSlugs);
  if (slug === undefined) {
    return { kind: "degenerate" };
  }
  const currentMax = maxVersionBySlug.get(slug) ?? 0;
  const version = typeof existingVersion === "number" ? existingVersion : currentMax + 1;
  maxVersionBySlug.set(slug, Math.max(currentMax, version));
  return { kind: "assign", slug, version };
}

// Anchor idempotency + disambiguation on slugs/versions already persisted.
function seedTemplateSlugState(records: readonly SessionRecord[]): {
  takenSlugs: Set<string>;
  maxVersionBySlug: Map<string, number>;
} {
  const takenSlugs = new Set<string>();
  const maxVersionBySlug = new Map<string, number>();
  for (const record of records) {
    const slug = record.template?.slug;
    if (slug !== undefined) {
      takenSlugs.add(slug);
      maxVersionBySlug.set(
        slug,
        Math.max(maxVersionBySlug.get(slug) ?? 0, record.template?.version ?? 0),
      );
    }
  }
  return { takenSlugs, maxVersionBySlug };
}

async function loadEnabledTemplateRecordsSorted(): Promise<SessionRecord[]> {
  const entries = (await loadSessionIndexEntries()).filter(
    (entry) => entry.templateEnabled === true && entry.kind !== "subagent",
  );
  const records = (
    await Promise.all(entries.map((entry) => loadRecordFromIndexEntry(entry)))
  ).filter((record): record is SessionRecord => Boolean(record));
  // created_at asc so the EARLIEST collision gets the bare slug (D3).
  records.sort(byTemplateCreatedAtThenId);
  return records;
}

// Apply one record's migration plan: record the assignment, then (unless dry-run)
// write slug+version via the privileged writer. Tallies the outcome onto `result`.
async function migrateOneTemplateRecord(
  record: SessionRecord,
  plan: TemplateSlugPlan,
  dryRun: boolean,
  result: MigrateSlugsResult,
): Promise<void> {
  if (plan.kind === "skipped") {
    result.skipped += 1;
    return;
  }
  if (plan.kind === "degenerate") {
    result.degenerate += 1; // emoji-only/empty name — leave slug-less (groups by id)
    return;
  }
  result.assignments.push({
    acpxRecordId: record.acpxRecordId,
    name: record.name,
    slug: plan.slug,
    version: plan.version,
  });
  if (dryRun) {
    result.assigned += 1;
    return;
  }
  try {
    record.template = { ...record.template, enabled: true, slug: plan.slug, version: plan.version };
    await writeSessionRecordWithLifecycle(record);
    result.assigned += 1;
  } catch {
    result.failed += 1;
  }
}

/**
 * Idempotent one-shot backfill of slug + version onto existing (enabled)
 * templates. Only fills where ABSENT — never renumbers an already-versioned
 * record (re-runnable as a no-op). Collisions (two distinct templates slugifying
 * to the same base, D3) get DISTINCT slugs (`-2`, `-3` by created_at), never
 * merged. Runs under the index lock; in-memory bookkeeping keeps the assignment
 * consistent across the batch without re-reading the index per record.
 */
export async function migrateTemplateSlugs(
  options: { dryRun?: boolean } = {},
): Promise<MigrateSlugsResult> {
  await ensureSessionDir();
  return await withSessionIndexLock(sessionBaseDir(), async () => {
    const records = await loadEnabledTemplateRecordsSorted();
    const { takenSlugs, maxVersionBySlug } = seedTemplateSlugState(records);
    const result: MigrateSlugsResult = {
      scanned: records.length,
      assigned: 0,
      skipped: 0,
      degenerate: 0,
      failed: 0,
      dryRun: options.dryRun === true,
      assignments: [],
    };
    for (const record of records) {
      const plan = planTemplateSlugMigration(record, takenSlugs, maxVersionBySlug);
      await migrateOneTemplateRecord(record, plan, options.dryRun === true, result);
    }
    return result;
  });
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

/**
 * The one ambiguous-name message shape for the whole repository: a name (or an
 * unnamed cwd lookup) either resolves to exactly one session or errors — it
 * never silently picks a winner. Names every candidate so the operator can act
 * without reading source, and hands them the exact next selector to use.
 */
function ambiguousSessionResolutionError(
  name: string | undefined,
  candidates: readonly Pick<SessionIndexEntry, "acpxRecordId" | "cwd">[],
): SessionResolutionError {
  const subject = name === undefined ? "Unnamed session lookup" : `Session name "${name}"`;
  const rendered = candidates
    .toSorted((a, b) => a.cwd.localeCompare(b.cwd) || a.acpxRecordId.localeCompare(b.acpxRecordId))
    .map((candidate) => `  - cwd: ${candidate.cwd}; record ID: ${candidate.acpxRecordId}`)
    .join("\n");
  return new SessionResolutionError(
    `${subject} is ambiguous across eligible sessions:\n` +
      `${rendered}\n` +
      "Use --session-id <id> or --session-url <url> to select one.",
  );
}

export async function findSession(options: FindSessionOptions): Promise<SessionRecord | undefined> {
  const normalizedCwd = absolutePath(options.cwd);
  const normalizedName = normalizeName(options.name);
  const entries = await loadSessionIndexEntries();
  // filter, not find: co-located duplicates have no principled winner, and the
  // index is ordered by lastUsedAt desc — so `find` silently returns whichever
  // session was touched most recently, and every misdelivery makes that winner
  // stickier. Fail closed instead, like every sibling resolver in this file.
  const matches = entries.filter(
    (session) =>
      matchesAgentIdentity(session, options.agentCommand, options.agentName) &&
      matchesSessionEntry(session, normalizedCwd, normalizedName, options.includeClosed),
  );
  if (matches.length === 0) {
    return undefined;
  }
  // Ambiguity is judged among OPEN candidates only. Closed sessions are ranked
  // below live ones rather than competing with them, and that ranking is a
  // contract, not a convenience: `sessions new -s <name>` soft-closes the prior
  // same-named session and creates a fresh one, so one closed predecessor beside
  // one live session is the ordinary shape of any recreated name — treating it
  // as ambiguous would break `sessions show <name>` after a single re-`new`.
  // With no live candidate at all, the closed set keeps its documented
  // newest-first archival fallback (index order is lastUsedAt desc), which
  // `exportSession` relies on. Neither case can misdeliver: a closed session
  // receives nothing.
  const open = matches.filter((session) => !session.closed);
  if (open.length > 1) {
    throw ambiguousSessionResolutionError(normalizedName, open);
  }
  return await loadRecordFromIndexEntry(open[0] ?? matches[0]);
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
    // Ambiguity is judged at THIS directory level, never globally: a match in a
    // deeper cwd legitimately shadows a shallower one — that is how nested
    // worktrees resolve. Only co-located duplicates are ambiguous.
    const matches = sessions.filter((session) =>
      matchesSessionEntry(session, current, normalizedName),
    );
    if (matches.length > 1) {
      throw ambiguousSessionResolutionError(normalizedName, matches);
    }
    if (matches.length === 1) {
      return await loadRecordFromIndexEntry(matches[0]);
    }

    const parent = nextWalkParent(current, walkBoundary, walkRoot);
    if (!parent) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * The CLOSED counterpart of {@link findSessionByDirectoryWalk}: walk the same
 * path and report the CLOSED entries that would have matched, newest first.
 *
 * Exists for `ensureSession`'s create-because-closed warning (brick://16712ece).
 * `findSessionByDirectoryWalk` filters closed entries out at
 * {@link matchesSessionEntry} (`includeClosed` defaults false), so a closed
 * match is invisible to `ensureSession` and it falls through to `createSession`
 * with rc=0 and no signal — an operator who meant RECOVERY silently lands in a
 * fresh empty session with the history abandoned.
 *
 * ⚠️ DO NOT "improve" this into a resolution that throws on multiple matches
 * the way the open walk does. It reports a COUNT, and a fixed name accumulating
 * many closed records is the ORDINARY shape of legitimate automation, not an
 * ambiguity: measured 2026-09-05 on devbox's production index, the nightly
 * intaker re-bake (`intaker-refresh-charter.md` step 2, which ensures
 * `-s tmpl:intaker-bake` in a fixed cwd) had left 38 same-name records, all 38
 * closed and 0 open. Throwing here would abort that job every night — which is
 * exactly why `ensure` warns instead of refusing. The regression guard is
 * "warns and still creates with MANY closed same-name matches" in
 * test/session-closed-recovery.test.ts.
 */
export async function findClosedSessionsByDirectoryWalk(
  options: FindSessionByDirectoryWalkOptions,
): Promise<SessionIndexEntry[]> {
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
    // Same shadowing rule as the open walk: the DEEPEST level with a match wins,
    // so a closed session in an ancestor cwd is not reported when a nearer one
    // exists.
    const matches = sessions.filter(
      (session) => session.closed && matchesSessionEntry(session, current, normalizedName, true),
    );
    if (matches.length > 0) {
      return matches.toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
    }

    const parent = nextWalkParent(current, walkBoundary, walkRoot);
    if (!parent) {
      return [];
    }
    current = parent;
  }
}

/**
 * Resolve an explicitly supplied display name from index entries, hydrating
 * only the unique exact candidate. Callers decide whether this query is local
 * (pass cwd) or global (omit cwd).
 */
function exactSessionNameCandidates(
  entries: SessionIndexEntry[],
  options: ResolveSessionByExactNameOptions,
  normalizedName: string,
): SessionIndexEntry[] {
  const normalizedCwd = options.cwd === undefined ? undefined : absolutePath(options.cwd);
  let candidates = entries.filter(
    (entry) => entry.name === normalizedName && (options.includeClosed || !entry.closed),
  );
  if (normalizedCwd !== undefined) {
    candidates = candidates.filter((entry) => entry.cwd === normalizedCwd);
  }
  if (options.excludeSubagents) {
    candidates = candidates.filter((entry) => entry.kind !== "subagent");
  }
  const agentCommand = options.agentCommand;
  if (agentCommand !== undefined) {
    candidates = candidates.filter((entry) =>
      matchesAgentIdentity(entry, agentCommand, options.agentName),
    );
  }
  return candidates.toSorted(
    (a, b) => a.cwd.localeCompare(b.cwd) || a.acpxRecordId.localeCompare(b.acpxRecordId),
  );
}

export async function resolveSessionByExactName(
  options: ResolveSessionByExactNameOptions,
): Promise<SessionNameResolution> {
  const normalizedName = normalizeName(options.name);
  if (normalizedName === undefined) {
    return { kind: "none" };
  }

  const candidates = exactSessionNameCandidates(
    await loadSessionIndexEntries(),
    options,
    normalizedName,
  );

  if (candidates.length === 0) {
    return { kind: "none" };
  }
  if (candidates.length > 1) {
    return {
      kind: "ambiguous",
      candidates: candidates.map(({ acpxRecordId, agentCommand, agentName, cwd }) => ({
        acpxRecordId,
        agentCommand,
        agentName,
        cwd,
      })),
    };
  }

  const record = await loadRecordFromIndexEntry(candidates[0]);
  return record ? { kind: "found", record } : { kind: "none" };
}

export async function resolveGlobalSessionByName(options: {
  agentCommand: string;
  agentName?: string;
  name: string;
  includeClosed?: boolean;
}): Promise<SessionRecord | undefined> {
  const resolution = await resolveSessionByExactName(options);
  if (resolution.kind === "none") {
    return undefined;
  }
  if (resolution.kind === "found") {
    return resolution.record;
  }

  throw ambiguousSessionResolutionError(
    normalizeName(options.name) ?? options.name,
    resolution.candidates,
  );
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
  /** Opt in to deleting template blueprints too. Off by default — see isTemplateMarkedOnDisk. */
  includeTemplates?: boolean;
  dryRun?: boolean;
  /** Exactly these sessions (acpx record id, ACP session id, or unique suffix). */
  sessionIds?: string[];
  /** Absolute, already-resolved. Exact equality against the record's cwd. */
  cwd?: string;
  /**
   * The resolved CLI scope (`PruneScope`), recorded verbatim in each deletion
   * manifest entry so an investigator sees what the operator actually asked for,
   * not just which sessions matched. Typed loosely on purpose: the shape is the
   * CLI's, and the core has no business depending on a CLI type. Absent =>
   * omitted from the entry.
   */
  auditScope?: unknown;
  /**
   * Invoked once after record loading and BEFORE both the dry-run early return
   * and the first unlink. Throwing aborts with nothing deleted.
   *
   * ⚠️ DO NOT move this call below the `if (options.dryRun)` early return. That
   * is the obvious reading of "before the delete loop" and it is the bug: it
   * would exempt --dry-run from the caller's all-or-nothing id contract, so
   * `prune --dry-run <good-id> <typo>` would preview 1 session and report
   * success while the real run it is previewing aborts. A preview that does not
   * fail where the real run fails is worse than no preview. The callback gets
   * `dryRun` and decides what to render.
   * test/sessions-prune.test.ts "onBeforeDelete runs on a dry run too" goes red
   * if this moves.
   */
  onBeforeDelete?: (plan: {
    records: SessionRecord[];
    strandedStreamFiles: number;
    strandedStreamBytes: number;
    dryRun: boolean;
  }) => void;
};

export type PruneResult = {
  pruned: SessionRecord[];
  /** Template blueprints that matched every prune criterion and were spared anyway. */
  skippedTemplates: SessionRecord[];
  bytesFreed: number;
  dryRun: boolean;
  /**
   * Stream files owned by the pruned records that were NOT deleted (no
   * --include-history). Nothing can ever match them again — prune selects off
   * the record index, so once the record is gone no later prune reclaims them.
   * Both are 0 when includeHistory is true.
   */
  strandedStreamFiles: number;
  strandedStreamBytes: number;
  /** Lines this run appended to the deletion manifest — 0 on a dry run, because
   *  a dry run destroys nothing and so records nothing. Lets a scripted consumer
   *  assert the audit actually happened rather than trusting that it did. */
  auditEntries: number;
};

/** Index-entry counts for the CLI's unscoped-prune refusal. Deliberately cheap:
 *  index entries only, never a record load — the refusal's whole job is to cost
 *  nothing on a path that deletes nothing. The numbers are therefore an upper
 *  bound (the template skip needs loaded records), which is why the refusal says
 *  "considers", not "deletes". */
export type PruneCandidateCounts = {
  total: number;
  inCwd: number;
};

/** One positional id, resolved against the index for the CLI's all-or-nothing
 *  contract. `openMatches` is what separates "no such session" from "close it
 *  first" — a distinction the prunable-record set alone cannot make. */
export type PruneIdResolution = {
  id: string;
  closedMatches: { acpxRecordId: string; name?: string; lastUsedAt: string }[];
  openMatches: number;
};

/**
 * Deliberately BROADER than `isTemplateRecord` above, and the two must not be
 * merged. `isTemplateRecord` gates *resolution* (`enabled === true` — only a live
 * template resolves under its slug); this gates *destruction*, where the safe
 * answer is the wider one.
 *
 * ⚠️ DO NOT "unify" this with isTemplateRecord or narrow it to
 * `template?.enabled === true`. It looks like the obvious cleanup and it is the
 * bug: `softRetractTemplateRecord` retires a template by flipping `enabled:false`
 * while KEEPING the block, precisely so the blueprint survives for rollback — so
 * an enabled-gated test hands every soft-retracted blueprint straight back to
 * prune, and `templates rollback` then has nothing to roll back to. The mark is
 * the presence of the block, at any version, enabled or not. The disabled-template
 * case in test/sessions-prune.test.ts goes red if this is narrowed.
 *
 * ⚠️ Reads the RAW on-disk `template` field, not `record.template` (brick://bbaa1ef4).
 * `record.template` is `parseTemplateState`'s output (parse.ts) — LOSSY by design:
 * a `template` block the parser cannot recognize (unrecognized/mistyped fields, or
 * a non-object value) leniently parses to `undefined`, since the daemon only
 * round-trips the block and never authors it. That makes a check against the
 * PARSED value blind to a block that is present-but-malformed on disk from the
 * very first read — and a plain checkpoint write re-parses and re-serializes,
 * so the malformed block then vanishes from disk too, deleting the evidence it
 * was ever there. `raw.template != null` is a strict superset of
 * `parseTemplateState(raw) != null` in the destruction-safe direction: every
 * raw shape the parser accepts is also raw-non-null, so this only ever widens
 * what gets protected, never narrows it. Measured against a real prune run:
 * before this fix, a malformed-but-present block was NOT skipped and was
 * deleted with no warning (bbaa1ef4 probe/FINDINGS.md).
 */
async function isTemplateMarkedOnDisk(entry: SessionIndexEntry): Promise<boolean> {
  try {
    const payload = await fs.readFile(path.join(sessionBaseDir(), entry.file), "utf8");
    const raw = JSON.parse(payload) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return false;
    }
    return (raw as Record<string, unknown>).template != null;
  } catch {
    // TE-caught (bbaa1ef4 F1): fail CLOSED toward preservation. This read can
    // fail for reasons that have nothing to do with whether the record is a
    // template — a transient EIO, EMFILE under box load, or the file being
    // concurrently replaced or removed — and `false` here means "not
    // template-marked" -> prunable -> DELETED. For a destruction guard the
    // error path IS the guard: an unreadable file must read as "possibly a
    // protected blueprint, skip it this run" (it can be re-evaluated on the
    // next prune), never as "assume it's safe to delete." This is what makes
    // "only ever widens what gets protected, never narrows it" (above) true
    // of the function as implemented, not just of the raw!=null expression.
    return true;
  }
}

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

const STREAM_FILE_INFIX = ".stream.";

/**
 * Inverse of `isSessionStreamFile`: safeId → the stream files that id owns, in
 * `dirEntries` order. Built ONCE per invocation and shared by every record,
 * replacing a per-record `dirEntries.filter(isSessionStreamFile)` over the whole
 * listing. On this box that filter was 2,362 records × 15,325 entries ≈ 36M
 * predicate calls, measured at +821 ms / 1.17x on a box-wide run
 * (brick://dd4cb0e8 verification/VERIFICATION.md §14) — and paid on EVERY prune,
 * because exactly one of measureStrandedStreams / pruneSessionFiles runs on any
 * given invocation.
 *
 * ⚠️ DO NOT narrow this to the FIRST `.stream.` in each filename. It looks like
 * the obvious loop and it is a silent data-loss bug: a safeId may itself contain
 * `.stream.`, and a first-occurrence-only index stops finding those sessions'
 * files entirely — so their streams survive a prune that reports having taken
 * them. The existing `stream-session.stream-neighbor` fixture CANNOT catch it
 * (it contains `.stream-`, not `.stream.`); the test "a session id containing
 * .stream. still owns its stream files" is the one that reds.
 *
 * The `at === 0` case (empty safeId) is kept rather than skipped so this is
 * byte-for-byte the inverse of the predicate above, which also matches it.
 */
function indexStreamFilesBySafeId(dirEntries: string[]): Map<string, string[]> {
  const bySafeId = new Map<string, string[]>();
  for (const name of dirEntries) {
    for (
      let at = name.indexOf(STREAM_FILE_INFIX);
      at !== -1;
      at = name.indexOf(STREAM_FILE_INFIX, at + 1)
    ) {
      const safeId = name.slice(0, at);
      const owned = bySafeId.get(safeId);
      if (owned) {
        owned.push(name);
      } else {
        bySafeId.set(safeId, [name]);
      }
    }
  }
  return bySafeId;
}

function streamFilesFor(streamFilesBySafeId: Map<string, string[]>, safeId: string): string[] {
  return streamFilesBySafeId.get(safeId) ?? [];
}

export async function pruneSessions(options: PruneOptions = {}): Promise<PruneResult> {
  await ensureSessionDir();
  const entries = await loadSessionIndexEntries();

  const eligible = filterPruneCandidates(
    entries,
    options.agentCommand,
    options.agentName,
    options.sessionIds,
    options.cwd,
  );

  const cutoff =
    options.before ??
    (options.olderThanMs != null ? new Date(Date.now() - options.olderThanMs) : undefined);

  const { prunable: records, skippedTemplates } = await loadPrunableRecords(
    eligible,
    cutoff,
    options.includeTemplates === true,
    options.cwd,
    options.sessionIds,
  );

  const sessionDir = sessionBaseDir();

  // Read the directory once upfront, then invert it once (indexStreamFilesBySafeId)
  // so stream-file matching costs a Map lookup per session instead of a scan of
  // the whole listing per session.
  //
  // Unconditional, and the justification is now TRUE where it used to overstate:
  // the stranded-stream total really is reported on every run, dry ones
  // included, in TEXT as well as JSON. It was not before — `printPrunePlan` is
  // suppressed on dry runs, so a text `--dry-run` computed the total and showed
  // the operator none of it, while this comment claimed otherwise and was the
  // load-bearing justification for a cost paid on every invocation. A preview
  // that does not say what it would strand is hiding the verb's single worst
  // measured behaviour.
  let dirEntries: string[] = [];
  try {
    dirEntries = await fs.readdir(sessionDir);
  } catch {
    // ignore
  }
  const streamFilesBySafeId = indexStreamFilesBySafeId(dirEntries);

  const { files: strandedStreamFiles, bytes: strandedStreamBytes } = await measureStrandedStreams(
    records,
    sessionDir,
    streamFilesBySafeId,
    options.includeHistory === true,
  );

  options.onBeforeDelete?.({
    records,
    strandedStreamFiles,
    strandedStreamBytes,
    dryRun: options.dryRun === true,
  });

  if (options.dryRun) {
    return {
      pruned: records,
      skippedTemplates,
      bytesFreed: 0,
      dryRun: true,
      strandedStreamFiles,
      strandedStreamBytes,
      auditEntries: 0,
    };
  }

  const includeHistory = options.includeHistory === true;

  // ⚠️ WRITE-AHEAD, and its position between the two lines above and below is
  // the whole design. Two ways to get it wrong, each of which type-checks:
  //
  //  - ABOVE the id-contract check in `onBeforeDelete` => `prune <good-id>
  //    <typo>` records deletions that then never happen.
  //  - ABOVE the `if (options.dryRun)` return => every `--dry-run` writes a
  //    false audit trail. This is the EXACT INVERSE of the ⚠️ on
  //    `onBeforeDelete` above, which forbids moving THAT call below the same
  //    return. The two calls sit either side of one line and their correct
  //    placements are opposite: the contract check must not be exempted from a
  //    preview, and the audit record must not be written for one.
  //
  // A throw here aborts with NOTHING deleted, on the abort path the
  // all-or-nothing id contract already depends on — so the failure mode is
  // "nothing happened", and there is no such thing as destroyed-but-unrecorded.
  // Abort costs zero new failure machinery; best-effort would cost a silently
  // missing audit record on exactly the box that is already unhealthy.
  const auditEntries = await appendDeletionManifest(
    sessionDir,
    records.map(
      (record): DeletionManifestEntry => ({
        op: "sessions_prune",
        at: isoNow(),
        agent: options.agentName,
        scope: options.auditScope,
        id: record.acpxRecordId,
        name: record.name,
        cwd: record.cwd,
        createdAt: record.createdAt,
        closedAt: record.closedAt,
        classes: deletedFileClasses(includeHistory),
      }),
    ),
  );

  let bytesFreed = 0;
  for (const record of records) {
    bytesFreed += await pruneSessionFiles(record, sessionDir, streamFilesBySafeId, includeHistory);
  }

  await rebuildSessionIndex(sessionDir, "prune").catch(() => {
    // best effort cache rebuild
  });

  return {
    pruned: records,
    skippedTemplates,
    bytesFreed,
    dryRun: false,
    strandedStreamFiles,
    strandedStreamBytes,
    auditEntries,
  };
}

/**
 * The two deletion tiers, as the manifest records them.
 *
 * RECORD tier (always): the session record, its messages sidecar, and the queue
 * owner's log — acpx's own file, whose only reader takes a session id and is
 * unreachable once the record is gone.
 *
 * HISTORY tier (unless `--no-include-history`): the event streams and the
 * timestamps sidecar. The sidecar is acpx-ui's file, and acpx deletes it not as
 * a tidy-up in someone else's data but because it is an INDEX OF THE STREAM and
 * the stream is acpx's: acpx-ui derives its path from the stream path and only
 * ever opens it that way, so deleting the stream makes it unreachable to its own
 * owner in the same act. Keep the stream and the index stays with it — which is
 * exactly what the tiering encodes.
 */
function deletedFileClasses(includeHistory: boolean): string[] {
  return includeHistory
    ? ["record", "messages", "stream", "timestamps", "owner"]
    : ["record", "messages", "owner"];
}

async function measureStrandedStreams(
  records: SessionRecord[],
  sessionDir: string,
  streamFilesBySafeId: Map<string, string[]>,
  includeHistory: boolean,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  if (includeHistory) {
    // Nothing is stranded — the delete loop takes these files too.
    return { files, bytes };
  }
  for (const record of records) {
    const safeId = encodeURIComponent(record.acpxRecordId);
    for (const name of streamFilesFor(streamFilesBySafeId, safeId)) {
      files += 1;
      try {
        bytes += (await fs.stat(path.join(sessionDir, name))).size;
      } catch {
        // raced away between readdir and stat — it is not ours to strand
      }
    }
  }
  return { files, bytes };
}

/**
 * `sessionIds` and `cwd` are SELECTIVE predicates and so may read the index
 * entry, where the template check above must not. The direction of failure is
 * what separates them: a protective predicate that reads an absent projection
 * turns a missing field into a deleted blueprint, whereas a selective predicate
 * reading a stale one merely fails to select — nothing extra is deleted. Both
 * fields it reads (`cwd`, `acpxRecordId`/`acpSessionId`) are required on
 * SessionIndexEntry, not optional hot-path enrichment. `cwd` is re-confirmed on
 * the loaded record in loadPrunableRecords anyway, closing the one direction in
 * which a stale index could over-select.
 */
function filterPruneCandidates(
  entries: SessionIndexEntry[],
  agentCommand: string | undefined,
  agentName: string | undefined,
  sessionIds: string[] | undefined,
  cwd: string | undefined,
): SessionIndexEntry[] {
  return entries.filter(
    (entry) =>
      entry.closed &&
      (!agentCommand || matchesAgentIdentity(entry, agentCommand, agentName)) &&
      matchesPruneSelectors(entry, sessionIds, cwd),
  );
}

/**
 * Ids and `--cwd` are a UNION — "this directory's, plus the ones I name". Age
 * filters then intersect the result, which is why they are applied separately in
 * loadPrunableRecords rather than here.
 *
 * ⚠️ NOT an intersection. That looks like the obvious reading of "combine the
 * filters" and it silently drops every named session that lives outside the
 * invocation cwd — which, under the all-or-nothing id contract, turns a valid
 * `prune --cwd <id-from-elsewhere>` into a whole-run abort.
 * test/sessions-prune-scope.test.ts "binds the id as an id" goes red if this
 * becomes an intersection.
 */
function matchesPruneSelectors(
  entry: SessionIndexEntry,
  sessionIds: string[] | undefined,
  cwd: string | undefined,
): boolean {
  if (!sessionIds && cwd == null) {
    return true;
  }
  if (cwd != null && entry.cwd === cwd) {
    return true;
  }
  return sessionIds?.some((id) => matchesPruneSessionId(entry, id)) === true;
}

/**
 * Suffix — deliberately not `includes` and not `startsWith`. "acpx record id,
 * ACP session id, or unique SUFFIX" is the documented id contract everywhere
 * else in this CLI (`recover`, `prompt -s`), and a looser match on a destructive
 * verb selects sessions the operator did not name.
 *
 * Exported so the CLI's all-or-nothing contract check resolves ids by exactly the
 * same rule the core selected them with. Two copies of a matcher that decides what
 * gets deleted is one drift away from "I named four and it deleted three".
 */
export function matchesPruneSessionId(
  target: Pick<SessionIndexEntry, "acpxRecordId" | "acpSessionId">,
  id: string,
): boolean {
  return (
    target.acpxRecordId === id ||
    target.acpSessionId === id ||
    target.acpxRecordId.endsWith(id) ||
    target.acpSessionId.endsWith(id)
  );
}

export async function countPruneCandidates(options: {
  agentCommand?: string;
  agentName?: string;
  cwd: string;
}): Promise<PruneCandidateCounts> {
  await ensureSessionDir();
  const entries = await loadSessionIndexEntries();
  const eligible = filterPruneCandidates(
    entries,
    options.agentCommand,
    options.agentName,
    undefined,
    undefined,
  );
  return {
    total: eligible.length,
    inCwd: eligible.filter((entry) => entry.cwd === options.cwd).length,
  };
}

export async function resolvePruneSessionIds(
  ids: string[],
  options: { agentCommand?: string; agentName?: string },
): Promise<PruneIdResolution[]> {
  await ensureSessionDir();
  const entries = await loadSessionIndexEntries();
  const mine = entries.filter(
    (entry) =>
      !options.agentCommand || matchesAgentIdentity(entry, options.agentCommand, options.agentName),
  );
  return ids.map((id) => {
    const matches = mine.filter((entry) => matchesPruneSessionId(entry, id));
    return {
      id,
      closedMatches: matches
        .filter((entry) => entry.closed)
        .map((entry) => ({
          acpxRecordId: entry.acpxRecordId,
          name: entry.name,
          lastUsedAt: entry.lastUsedAt,
        })),
      openMatches: matches.filter((entry) => !entry.closed).length,
    };
  });
}

/**
 * The template check deliberately runs HERE, on the fully-loaded record, and not
 * up in filterPruneCandidates on the index entry. SessionIndexEntry.templateSlug
 * & friends are optional hot-path enrichment: an old index, or an entry written
 * by acpx-ui, simply lacks them. Filtering on a field that may be absent turns a
 * missing projection into a deleted blueprint.
 *
 * The destruction guard itself (`isTemplateMarkedOnDisk`) re-reads the entry's
 * RAW on-disk JSON rather than trusting `record.template` — `record.template`
 * is `parseTemplateState`'s lossy parsed output and is NOT the authority for
 * this check (brick://bbaa1ef4; the loaded `record` is still the authority for
 * every other prune decision here — cutoff, cwd, sessionIds). The raw re-read
 * is deliberately scoped to prune's own load path, not threaded into
 * `loadRecordFromIndexEntry` or the shared parser — those have a dozen other
 * call sites this guard has no business widening into.
 */
async function loadPrunableRecords(
  entries: SessionIndexEntry[],
  cutoff: Date | undefined,
  includeTemplates: boolean,
  cwd: string | undefined,
  sessionIds: string[] | undefined,
): Promise<{ prunable: SessionRecord[]; skippedTemplates: SessionRecord[] }> {
  const prunable: SessionRecord[] = [];
  const skippedTemplates: SessionRecord[] = [];
  const cutoffIso = cutoff?.toISOString();
  for (const entry of entries) {
    const record = await loadRecordFromIndexEntry(entry);
    if (!record || !isBeforeCutoff(record, cutoffIso)) {
      continue;
    }
    if (!includeTemplates && (await isTemplateMarkedOnDisk(entry))) {
      skippedTemplates.push(record);
      continue;
    }
    if (isPruneCwdMismatch(record, cwd, sessionIds)) {
      continue;
    }
    prunable.push(record);
  }
  return { prunable, skippedTemplates };
}

/**
 * Re-confirms `--cwd` on the LOADED record, which is the authority, exactly as
 * the template check is. filterPruneCandidates already narrowed on `entry.cwd`;
 * this is what stops a stale index entry pointing at the target directory from
 * getting a record that lives elsewhere deleted. Exact equality, never a
 * prefix/subtree match — `/w/p/sweep` must not select `/w/p/sweep-32002`.
 * test/sessions-prune.test.ts "cwd is not out-run by a stale index entry" goes red
 * if this is dropped.
 *
 * An explicitly NAMED session is exempt: ids and cwd are a union, so a named
 * session is selected on its own merit and its cwd is irrelevant. The stale-index
 * guard is unaffected — an id the operator did not type cannot reach this branch.
 */
function isPruneCwdMismatch(
  record: SessionRecord,
  cwd: string | undefined,
  sessionIds: string[] | undefined,
): boolean {
  if (cwd == null || record.cwd === cwd) {
    return false;
  }
  return sessionIds?.some((id) => matchesPruneSessionId(record, id)) !== true;
}

function isBeforeCutoff(record: SessionRecord, cutoffIso: string | undefined): boolean {
  return !cutoffIso || closedAtOrLastUsedAt(record) < cutoffIso;
}

async function pruneSessionFiles(
  record: SessionRecord,
  sessionDir: string,
  streamFilesBySafeId: Map<string, string[]>,
  includeHistory: boolean,
): Promise<number> {
  const safeId = encodeURIComponent(record.acpxRecordId);
  let bytesFreed = await unlinkCountingBytes(path.join(sessionDir, `${safeId}.json`));
  const logPath = path.join(sessionDir, messagesLogFileName(record.acpxRecordId));
  bytesFreed += await unlinkCountingBytes(logPath);
  bytesFreed += await unlinkCountingBytes(messagesLogStalePath(logPath));
  bytesFreed += await unlinkCountingBytes(ownerLogPath(sessionDir, safeId));
  if (includeHistory) {
    for (const name of streamFilesFor(streamFilesBySafeId, safeId)) {
      bytesFreed += await unlinkCountingBytes(path.join(sessionDir, name));
    }
    bytesFreed += await unlinkCountingBytes(timestampsSidecarPath(sessionDir, safeId));
  }
  return bytesFreed;
}

/**
 * The queue owner's log — RECORD tier, so it goes even under
 * `--no-include-history`. acpx's own file, capped at 1 MiB; its only reader
 * takes a session id and is unreachable once the record is gone.
 *
 * ⚠️ RESOLVED FROM `sessionDir`, NEVER FROM `homedir()`. The WRITER
 * (`queue-owner-process.ts` `openQueueOwnerLogFd`) builds this path from a bare
 * `homedir()` and its reader's comment records that as deliberate — *"the log is
 * intentionally not state-home-isolated"*. So "delete it where it was written"
 * is the obvious reading and it is FORBIDDEN: under `ACPX_STATE_HOME`
 * isolation it would make every prune test reach OUT of its temp store and
 * unlink real owner logs from the developer's `~/.acpx`. Deleting from
 * `sessionDir` is a harmless no-op inside the temp store instead.
 *
 * Residual, stated rather than hidden: in a deployment where
 * `ACPX_STATE_HOME !== HOME`, owner logs survive a prune. That fails SAFE
 * (nothing wrongly deleted) and is consistent with the writer's own stated
 * intent. Because the unlink is always ATTEMPTED, the manifest's `classes`
 * carries `"owner"` either way and never over-claims about a file that was
 * already absent — the same as every other class here, none of which is
 * stat-confirmed.
 *
 * Pinned by the T-ISO-4 decoy test, which is the ONE test allowed to diverge
 * `HOME` from `ACPX_STATE_HOME` (both to temp paths, neither ever the real `~`),
 * because the property does not exist while they are equal.
 */
function ownerLogPath(sessionDir: string, safeId: string): string {
  return path.join(sessionDir, `${safeId}.owner.log`);
}

/**
 * acpx-ui's per-message `{offset, ts}` index for a session's event stream —
 * HISTORY tier, because it is a SIDECAR OF THE STREAM and follows it.
 *
 * acpx neither writes nor reads this file; acpx-ui derives its path from the
 * stream path by string replacement and only ever loads it with that derived
 * path. Delete the stream and acpx-ui never opens this file again — so deleting
 * it alongside is not acpx destroying another repo's data, it is acpx removing
 * an index it just made unreachable. Keep the stream
 * (`--no-include-history`) and the index stays with it.
 */
function timestampsSidecarPath(sessionDir: string, safeId: string): string {
  return path.join(sessionDir, `${safeId}.timestamps.ndjson`);
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
