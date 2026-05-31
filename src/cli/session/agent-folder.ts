import fs from "node:fs";
import path from "node:path";
import type { SessionRecord } from "../../types.js";

const MAX_AGENT_FOLDER_NAME_LENGTH = 64;
const AGENT_RECORD_ID_SLUG_LENGTH = 8;

/**
 * Turn a session name into a single, filesystem-safe path segment, or return
 * `undefined` when nothing usable remains (the caller then falls back to the
 * record id). Session names are only trim-normalized when persisted, so they
 * may still contain unsafe characters, be `.`/`..`, or strip down to empty.
 */
export function sanitizeAgentFolderName(name: string | undefined): string | undefined {
  if (name == null) {
    return undefined;
  }
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, MAX_AGENT_FOLDER_NAME_LENGTH)
    .replace(/[-.]+$/, "");
  if (slug.length === 0 || slug === "." || slug === "..") {
    return undefined;
  }
  return slug;
}

function buildAgentFolderName(record: SessionRecord): string {
  const idSuffix = record.acpxRecordId.slice(0, AGENT_RECORD_ID_SLUG_LENGTH);
  const sanitized = sanitizeAgentFolderName(record.name);
  return sanitized ? `${sanitized}-${idSuffix}` : idSuffix;
}

function isExistingDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve (and create) the per-agent folder for a session:
 * `<task_folder>/agents/<sanitized-name>-<id8>/` (bare `<id8>` when the name is
 * empty). Returns the absolute path, or `null` when there is no usable task
 * folder.
 *
 * Defensive: only acts when `task_folder` is absolute and already exists as a
 * directory, so an inherited junk/typo path never materializes a bogus task
 * tree. Re-derived each spawn with an idempotent `mkdir -p`, so a later rename
 * or self-applied `task_folder` is picked up on the next spawn.
 */
export function resolveAndEnsureAgentFolder(record: SessionRecord): string | null {
  const taskFolder = record.metadata?.task_folder?.trim();
  if (!taskFolder || !path.isAbsolute(taskFolder)) {
    return null;
  }
  if (!isExistingDirectory(taskFolder)) {
    return null;
  }
  const agentFolder = path.join(taskFolder, "agents", buildAgentFolderName(record));
  fs.mkdirSync(agentFolder, { recursive: true });
  return agentFolder;
}
