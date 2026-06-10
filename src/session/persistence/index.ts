import fs from "node:fs/promises";
import path from "node:path";
import type { SessionRecord } from "../../types.js";
import { parseSessionRecord } from "./parse.js";

const SESSION_INDEX_SCHEMA = "acpx.session-index.v1";

export type SessionIndexSubscriptionSwitch = {
  from?: string;
  to: string;
  reason: "manual" | "failover";
  at: string;
};

export type SessionIndexEntry = {
  file: string;
  acpxRecordId: string;
  acpSessionId: string;
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
  desiredEffort?: string;
  subscription?: string;
  profile?: string;
  subscriptionSwitch?: SessionIndexSubscriptionSwitch;
  templateEnabled?: boolean;
  templateCreatedAt?: string;
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
    desiredEffort: optionalString(record.desiredEffort),
    subscription: optionalString(record.subscription),
    profile: optionalString(record.profile),
    subscriptionSwitch: parseIndexSubscriptionSwitch(record.subscriptionSwitch),
    templateEnabled: optionalBoolean(record.templateEnabled),
    templateCreatedAt: optionalString(record.templateCreatedAt),
  };
}

function hasRequiredIndexEntryFields(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  file: string;
  acpxRecordId: string;
  acpSessionId: string;
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
    desiredEffort: acpx?.desired_config_options?.effort,
    subscription: sessionOptions?.subscription,
    profile: sessionOptions?.profile,
    subscriptionSwitch: sessionOptions?.subscription_switch,
    templateEnabled: record.template?.enabled,
    templateCreatedAt: record.template?.created_at,
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
  const payload = JSON.stringify(
    {
      schema: SESSION_INDEX_SCHEMA,
      files: [...index.files].toSorted(),
      entries: [...index.entries].toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)),
    },
    null,
    2,
  );
  await fs.writeFile(tempFile, `${payload}\n`, "utf8");
  await fs.rename(tempFile, filePath);
}

export async function rebuildSessionIndex(sessionDir: string): Promise<SessionIndex> {
  const entries = await fs.readdir(sessionDir, { withFileTypes: true });
  const files = entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json",
    )
    .map((entry) => entry.name)
    .toSorted();

  const indexEntries: SessionIndexEntry[] = [];
  for (const file of files) {
    try {
      const payload = await fs.readFile(path.join(sessionDir, file), "utf8");
      const parsed = parseSessionRecord(JSON.parse(payload));
      if (!parsed) {
        continue;
      }
      indexEntries.push(toSessionIndexEntry(parsed, file));
    } catch {
      // ignore corrupt session files while rebuilding the cache index
    }
  }

  const index: SessionIndex = {
    schema: SESSION_INDEX_SCHEMA,
    files,
    entries: indexEntries,
  };
  await writeSessionIndex(sessionDir, index);
  return index;
}

export async function loadOrRebuildSessionIndex(sessionDir: string): Promise<SessionIndex> {
  const files = (await fs.readdir(sessionDir, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json",
    )
    .map((entry) => entry.name)
    .toSorted();
  const existing = await readSessionIndex(sessionDir);
  if (
    existing &&
    existing.files.length === files.length &&
    existing.files.every((file, index) => file === files[index])
  ) {
    return existing;
  }
  return await rebuildSessionIndex(sessionDir);
}
