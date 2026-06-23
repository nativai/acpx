import fs from "node:fs/promises";
import path from "node:path";
import type { SessionRecord } from "../../types.js";
import { withSessionIndexLock } from "./index-lock.js";
import { parseSessionRecord } from "./parse.js";

const SESSION_INDEX_SCHEMA = "acpx.session-index.v1";

export type SessionIndexSubscriptionSwitch = {
  from?: string;
  to: string;
  reason: "manual" | "failover";
  at: string;
};

export type SessionIndexAccountSwitch = {
  fromProfile?: string;
  toProfile: string;
  fromAccount?: string;
  toAccount: string;
  effectiveAccount?: string;
  effectiveProfile?: string;
  effectiveAuthMode?: string;
  effectiveAnchor?: string;
  effectiveResolutionMethod?: "path" | "selection";
  reason: "manual" | "failover";
  at: string;
};

export type SessionIndexEntry = {
  file: string;
  acpxRecordId: string;
  acpSessionId: string;
  agentName?: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  closed: boolean;
  lastUsedAt: string;
  kind?: "session" | "subagent";
  // ── Hot-path enrichment (perf/index-entry-enrichment) ───────────────────────
  // Scalar fields acpx-ui's ~2 Hz session-list rebuild needs per session,
  // projected into this sidecar so the hot path reads index.json (already
  // stat-gated + cached) instead of decoding + JSON.parsing each multi-MB
  // session record. All optional + additive — NO schema bump: an old index, or
  // an acpx-ui-written partial entry, simply lacks them and acpx-ui falls back
  // to the per-record read for those fields, self-healing on the next daemon
  // rewrite. Kept as fresh as the record itself (written in the same atomic
  // index rewrite as the record write — see repository.ts).
  lastWriteAt?: string;
  activePath?: string;
  lastPromptAt?: string;
  favorite?: boolean;
  title?: string | null;
  createdAt?: string;
  parentSessionId?: string;
  forkedFromSessionId?: string;
  forkedAtMessageIndex?: number;
  metadataTaskFolder?: string;
  // A byway is stored as a normal kind:"session" fork flagged metadata.byway==="1"
  // (acpx-ui convention). Projected so acpx-ui's kind resolution can run from the
  // entry without reading the record. Byway *lineage* (byway_parent/byway_at)
  // stays on acpx-ui's record-fallback for the rare byway case.
  byway?: boolean;
  currentModelId?: string;
  sessionModel?: string;
  // Agent's advertised image-prompt capability (record agentCapabilities
  // .promptCapabilities.image), projected so acpx-ui drives the chat image-attach
  // affordance from this entry instead of reading the multi-MB record on every
  // ~2 Hz session-list rebuild. undefined = the agent never advertised a boolean
  // (older record / capability not captured) → acpx-ui treats absent as off.
  promptImageSupported?: boolean;
  desiredEffort?: string;
  subscription?: string;
  profile?: string;
  subscriptionSwitch?: SessionIndexSubscriptionSwitch;
  accountSwitch?: SessionIndexAccountSwitch;
  templateEnabled?: boolean;
  templateCreatedAt?: string;
  templateAutoPrompt?: string;
  // Slug + version (W13-01). Projected so the latest-per-slug collapse + slug
  // resolution run off the index with no per-record read. effectiveSlug =
  // templateSlug ?? slugify(name); the comparator (template-slug.ts Appendix B)
  // uses templateVersion/templateCreatedAt to pick the latest.
  templateSlug?: string;
  templateVersion?: number;
};

type SessionIndex = {
  schema: typeof SESSION_INDEX_SCHEMA;
  files: string[];
  entries: SessionIndexEntry[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseIndexSubscriptionSwitch(value: unknown): SessionIndexSubscriptionSwitch | undefined {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.to !== "string" ||
    (record.reason !== "manual" && record.reason !== "failover") ||
    typeof record.at !== "string"
  ) {
    return undefined;
  }
  return {
    ...(typeof record.from === "string" ? { from: record.from } : {}),
    to: record.to,
    reason: record.reason,
    at: record.at,
  };
}

function isValidIndexAccountSwitch(record: Record<string, unknown>): record is {
  fromProfile?: string;
  toProfile: string;
  fromAccount?: string;
  toAccount: string;
  effectiveAccount?: string;
  effectiveProfile?: string;
  effectiveAuthMode?: string;
  effectiveAnchor?: string;
  effectiveResolutionMethod?: "path" | "selection";
  reason: "manual" | "failover";
  at: string;
} {
  return (
    typeof record.toProfile === "string" &&
    typeof record.toAccount === "string" &&
    (record.reason === "manual" || record.reason === "failover") &&
    typeof record.at === "string"
  );
}

type IndexAccountSwitchStringKey = Exclude<
  keyof Omit<SessionIndexAccountSwitch, "reason" | "at">,
  "effectiveResolutionMethod"
>;

function assignOptionalAccountSwitchString(
  target: Partial<SessionIndexAccountSwitch>,
  key: IndexAccountSwitchStringKey,
  value: unknown,
): void {
  if (typeof value === "string") {
    target[key] = value;
  }
}

function accountSwitchMetadata(
  record: Record<string, unknown>,
): Partial<SessionIndexAccountSwitch> {
  const metadata: Partial<SessionIndexAccountSwitch> = {};
  assignOptionalAccountSwitchString(metadata, "fromProfile", record.fromProfile);
  assignOptionalAccountSwitchString(metadata, "fromAccount", record.fromAccount);
  assignOptionalAccountSwitchString(metadata, "effectiveAccount", record.effectiveAccount);
  assignOptionalAccountSwitchString(metadata, "effectiveProfile", record.effectiveProfile);
  assignOptionalAccountSwitchString(metadata, "effectiveAuthMode", record.effectiveAuthMode);
  assignOptionalAccountSwitchString(metadata, "effectiveAnchor", record.effectiveAnchor);
  if (
    record.effectiveResolutionMethod === "path" ||
    record.effectiveResolutionMethod === "selection"
  ) {
    metadata.effectiveResolutionMethod = record.effectiveResolutionMethod;
  }
  return metadata;
}

function parseIndexAccountSwitch(value: unknown): SessionIndexAccountSwitch | undefined {
  const record = asRecord(value);
  if (!record || !isValidIndexAccountSwitch(record)) {
    return undefined;
  }
  return {
    toProfile: record.toProfile,
    toAccount: record.toAccount,
    ...accountSwitchMetadata(record),
    reason: record.reason,
    at: record.at,
  };
}

// eslint-disable-next-line complexity -- flat field-by-field projection of the optional hot-path enrichment scalars; linear, not branchy logic
function parseIndexEntry(raw: unknown): SessionIndexEntry | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  if (!hasRequiredIndexEntryFields(record)) {
    return undefined;
  }
  if (record.name !== undefined && typeof record.name !== "string") {
    return undefined;
  }
  if (record.kind !== undefined && record.kind !== "session" && record.kind !== "subagent") {
    return undefined;
  }
  // Preserve the optional hot-path enrichment fields untouched. This is
  // load-bearing: writeSessionRecordInternal rebuilds only the touched entry via
  // toSessionIndexEntry and writes back every OTHER entry exactly as parsed here
  // — so dropping these on parse would strip enrichment off all untouched
  // sessions on every record write. Lenient: a wrong-typed optional field is
  // dropped, never rejects the entry.
  return {
    file: record.file,
    acpxRecordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId,
    agentName: optionalString(record.agentName),
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name: record.name,
    closed: record.closed,
    lastUsedAt: record.lastUsedAt,
    kind: record.kind,
    lastWriteAt: optionalString(record.lastWriteAt),
    activePath: optionalString(record.activePath),
    lastPromptAt: optionalString(record.lastPromptAt),
    favorite: optionalBoolean(record.favorite),
    title: typeof record.title === "string" ? record.title : undefined,
    createdAt: optionalString(record.createdAt),
    parentSessionId: optionalString(record.parentSessionId),
    forkedFromSessionId: optionalString(record.forkedFromSessionId),
    forkedAtMessageIndex: optionalFiniteNumber(record.forkedAtMessageIndex),
    metadataTaskFolder: optionalString(record.metadataTaskFolder),
    byway: optionalBoolean(record.byway),
    currentModelId: optionalString(record.currentModelId),
    sessionModel: optionalString(record.sessionModel),
    promptImageSupported: optionalBoolean(record.promptImageSupported),
    desiredEffort: optionalString(record.desiredEffort),
    subscription: optionalString(record.subscription),
    profile: optionalString(record.profile),
    subscriptionSwitch: parseIndexSubscriptionSwitch(record.subscriptionSwitch),
    accountSwitch: parseIndexAccountSwitch(record.accountSwitch),
    templateEnabled: optionalBoolean(record.templateEnabled),
    templateCreatedAt: optionalString(record.templateCreatedAt),
    templateAutoPrompt: optionalString(record.templateAutoPrompt),
    templateSlug: optionalString(record.templateSlug),
    templateVersion: optionalFiniteNumber(record.templateVersion),
  };
}

function hasRequiredIndexEntryFields(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  file: string;
  acpxRecordId: string;
  acpSessionId: string;
  agentName?: string;
  agentCommand: string;
  cwd: string;
  lastUsedAt: string;
  closed: boolean;
} {
  return (
    ["file", "acpxRecordId", "acpSessionId", "agentCommand", "cwd", "lastUsedAt"].every(
      (key) => typeof record[key] === "string",
    ) && typeof record.closed === "boolean"
  );
}

export function sessionIndexPath(sessionDir: string): string {
  return path.join(sessionDir, "index.json");
}

// Agent's advertised image-prompt capability, derived from the record's
// agentCapabilities.promptCapabilities.image. Mirrors acpx-ui's
// extractPromptImageSupported EXACTLY (`typeof boolean ? value : undefined`) so the
// projected index field and acpx-ui's record-read derivation agree byte-for-byte —
// this is one half of the cross-repo W13-18 contract (the other half: acpx-ui reads
// `entry.promptImageSupported` and drops its per-record fallback). undefined = the
// agent never advertised a boolean (older record / capability never captured).
function promptImageSupportedFromRecord(record: SessionRecord): boolean | undefined {
  const image = record.agentCapabilities?.promptCapabilities?.image;
  return typeof image === "boolean" ? image : undefined;
}

// eslint-disable-next-line complexity -- flat field-by-field projection of the optional hot-path enrichment scalars; linear, not branchy logic
export function toSessionIndexEntry(record: SessionRecord, fileName: string): SessionIndexEntry {
  const acpx = record.acpx;
  const sessionOptions = acpx?.session_options;
  const metadata = record.metadata;
  // undefined-valued fields are dropped by JSON.stringify in writeSessionIndex,
  // so the index stays lean — only fields the record actually carries are
  // persisted. Every field below is a small scalar (or the tiny subscription
  // switch breadcrumb); the bulky `messages` array is never projected.
  return {
    file: fileName,
    acpxRecordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId,
    agentName: record.agentName,
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name: record.name,
    closed: record.closed === true,
    lastUsedAt: record.lastUsedAt,
    kind: record.kind,
    lastWriteAt: record.eventLog?.last_write_at,
    activePath: record.eventLog?.active_path,
    lastPromptAt: record.lastPromptAt,
    favorite: record.favorite,
    title: record.title ?? undefined,
    createdAt: record.createdAt,
    parentSessionId: record.parentSessionId,
    forkedFromSessionId: record.forkedFromSessionId,
    forkedAtMessageIndex: record.forkedAtMessageIndex,
    metadataTaskFolder: metadata?.task_folder,
    byway: metadata?.byway === "1" ? true : undefined,
    currentModelId: acpx?.current_model_id,
    sessionModel: sessionOptions?.model,
    promptImageSupported: promptImageSupportedFromRecord(record),
    desiredEffort: acpx?.desired_config_options?.effort,
    subscription: sessionOptions?.subscription,
    profile: sessionOptions?.profile,
    subscriptionSwitch: sessionOptions?.subscription_switch,
    accountSwitch: sessionOptions?.account_switch,
    templateEnabled: record.template?.enabled,
    templateCreatedAt: record.template?.created_at,
    templateAutoPrompt: record.template?.auto_prompt,
    templateSlug: record.template?.slug,
    templateVersion: record.template?.version,
  };
}

export async function readSessionIndex(sessionDir: string): Promise<SessionIndex | undefined> {
  const filePath = sessionIndexPath(sessionDir);
  try {
    const payload = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(payload) as unknown;
    const record = asRecord(parsed);
    if (!record || record.schema !== SESSION_INDEX_SCHEMA || !Array.isArray(record.files)) {
      return undefined;
    }
    const files = record.files.filter((entry): entry is string => typeof entry === "string");
    if (files.length !== record.files.length || !Array.isArray(record.entries)) {
      return undefined;
    }
    const entries = record.entries
      .map((entry) => parseIndexEntry(entry))
      .filter((entry): entry is SessionIndexEntry => Boolean(entry));
    if (entries.length !== record.entries.length) {
      return undefined;
    }
    return {
      schema: SESSION_INDEX_SCHEMA,
      files,
      entries,
    };
  } catch {
    return undefined;
  }
}

export async function writeSessionIndex(
  sessionDir: string,
  index: {
    files: string[];
    entries: SessionIndexEntry[];
  },
): Promise<void> {
  const filePath = sessionIndexPath(sessionDir);
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  // Compact JSON (no pretty-print): parses identically for every consumer,
  // saves ~30-40% of bytes and stringify CPU per rewrite.
  const payload = JSON.stringify({
    schema: SESSION_INDEX_SCHEMA,
    files: [...index.files].toSorted(),
    entries: [...index.entries].toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)),
  });
  await fs.writeFile(tempFile, `${payload}\n`, "utf8");
  await fs.rename(tempFile, filePath);
}

async function listSessionRecordFiles(sessionDir: string): Promise<string[]> {
  return (await fs.readdir(sessionDir, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json",
    )
    .map((entry) => entry.name)
    .toSorted();
}

async function readIndexEntryFromDisk(
  sessionDir: string,
  file: string,
): Promise<SessionIndexEntry | undefined> {
  try {
    const payload = await fs.readFile(path.join(sessionDir, file), "utf8");
    const parsed = parseSessionRecord(JSON.parse(payload));
    if (!parsed) {
      return undefined;
    }
    return toSessionIndexEntry(parsed, file);
  } catch {
    // corrupt, or vanished between readdir and read — treated the same as the
    // full-rebuild path: the file keeps its file-list row but gets no entry
    return undefined;
  }
}

// --json-strict guarantees machine-clean stderr; the CLI entrypoint suppresses
// the rebuild notice for those invocations (same class as session banners).
let rebuildLogSuppressed = false;

export function setSessionIndexRebuildLogSuppressed(suppressed: boolean): void {
  rebuildLogSuppressed = suppressed;
}

export async function rebuildSessionIndex(
  sessionDir: string,
  reason: string,
): Promise<SessionIndex> {
  // Full-store re-parse — the prod observable for the "zero full-store
  // rebuilds on new-file creation" target (VERIFICATION-ANNEX S4 greps for it).
  if (!rebuildLogSuppressed) {
    process.stderr.write(`[acpx] full session-index rebuild (reason: ${reason})\n`);
  }
  // Advisory lock (re-entrant under a caller already holding it). A rebuild
  // over a very large store can outlive the 5 s stale threshold and lose the
  // lock to a takeover — acceptable: that degrades to the pre-lock racing
  // behaviour for this rare reserve path.
  return await withSessionIndexLock(sessionDir, async () => {
    const files = await listSessionRecordFiles(sessionDir);

    const indexEntries: SessionIndexEntry[] = [];
    for (const file of files) {
      const entry = await readIndexEntryFromDisk(sessionDir, file);
      if (entry) {
        indexEntries.push(entry);
      }
    }

    const index: SessionIndex = {
      schema: SESSION_INDEX_SCHEMA,
      files,
      entries: indexEntries,
    };
    await writeSessionIndex(sessionDir, index);
    return index;
  });
}

export type ReconciledSessionIndex = {
  index: SessionIndex;
  /** True when the on-disk file list and index.files disagreed (the returned
   * index reflects disk but has NOT been written back — membership changes
   * persist via the caller's index write). */
  drift: boolean;
};

/**
 * Load the session index, reconciling file-list drift incrementally: records
 * absent from the index are read and parsed individually; index rows whose
 * files vanished are dropped without any read. The full-store re-parse
 * (`rebuildSessionIndex`) is reserved for a missing or unparseable index.json.
 *
 * `providedEntries` lets a caller that already holds a fresh entry for a file
 * (e.g. the record writer that just created it) supply it directly, so the
 * reconcile does not re-read the multi-MB record it was derived from.
 */
export async function reconcileSessionIndex(
  sessionDir: string,
  providedEntries?: ReadonlyMap<string, SessionIndexEntry>,
): Promise<ReconciledSessionIndex> {
  const files = await listSessionRecordFiles(sessionDir);
  const existing = await readSessionIndex(sessionDir);
  if (!existing) {
    return {
      index: await rebuildSessionIndex(sessionDir, "index.json missing or unparseable"),
      drift: true,
    };
  }
  if (existing.files.length === files.length && existing.files.every((f, i) => f === files[i])) {
    return { index: existing, drift: false };
  }

  return {
    index: {
      schema: SESSION_INDEX_SCHEMA,
      files,
      entries: await reconcileDriftedEntries(sessionDir, existing, files, providedEntries),
    },
    drift: true,
  };
}

async function reconcileDriftedEntries(
  sessionDir: string,
  existing: SessionIndex,
  files: string[],
  providedEntries: ReadonlyMap<string, SessionIndexEntry> | undefined,
): Promise<SessionIndexEntry[]> {
  const diskFiles = new Set(files);
  const indexedFiles = new Set(existing.files);
  // Vanished files: drop their entries; no reads.
  const entries = existing.entries.filter((entry) => diskFiles.has(entry.file));
  // New files: parse only those records (last-wins on duplicate entries,
  // matching the existing filter+push replace behaviour).
  for (const file of files) {
    if (indexedFiles.has(file)) {
      continue;
    }
    const entry = providedEntries?.get(file) ?? (await readIndexEntryFromDisk(sessionDir, file));
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

export async function loadOrRebuildSessionIndex(sessionDir: string): Promise<SessionIndex> {
  return (await reconcileSessionIndex(sessionDir)).index;
}
