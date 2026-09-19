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

function usableBaseDirectory(candidate: string | null | undefined): string | null {
  const trimmed = candidate?.trim();
  return trimmed && path.isAbsolute(trimmed) && isExistingDirectory(trimmed) ? trimmed : null;
}

/**
 * Resolve (and create) the per-agent folder for a session:
 * `<brick_path>/agents/<sanitized-name>-<id8>/` (bare `<id8>` when the name is
 * empty). Returns the absolute path, or `null` when there is no usable brick
 * folder.
 *
 * Defensive: only acts when the brick path is absolute and already exists as a
 * directory, so a junk/typo path never materializes a bogus tree. Re-derived
 * each spawn with an idempotent `mkdir -p`, so a later rename or re-link is
 * picked up on the next spawn.
 *
 * brick b11f98fb: the legacy `metadata.task_folder` fallback was removed here;
 * the brick path is now the sole base.
 */
export function resolveAndEnsureAgentFolder(
  record: SessionRecord,
  brickPath?: string | null,
): string | null {
  const baseDirectory = usableBaseDirectory(brickPath);
  if (!baseDirectory) {
    return null;
  }
  const agentFolder = path.join(baseDirectory, "agents", buildAgentFolderName(record));
  fs.mkdirSync(agentFolder, { recursive: true });
  return agentFolder;
}
