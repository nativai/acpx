import fs from "node:fs";
import path from "node:path";
import type { SessionRecord } from "../../types.js";

const MAX_AGENT_FOLDER_NAME_LENGTH = 64;
const ID_SLUG_LENGTH = 8;

/**
 * Turn a session name into a single, filesystem-safe path segment, or return
 * `undefined` when nothing usable remains. Session names are only trim-normalized
 * when persisted, so they may still contain unsafe characters, be `.`/`..`, or
 * strip down to empty.
 *
 * C7: the agent-folder derivation no longer calls this — the folder is keyed on
 * ids alone (`deriveAgentFolders`). It stays exported for the name-slug consumers.
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

export type AgentFolders = { agentFolder: string; seatFolder: string | null };

/**
 * C7 (brick 09197f03) — THE ONE DERIVATION of an agent's workspace. Two string concatenations, and that
 * is the point: there is no name input, so there is nothing to sanitize and nothing to drift.
 *
 * - seated   → `agentFolder = <brick>/agents/<seat8>/holders/<session8>`, `seatFolder = <brick>/agents/<seat8>`
 * - seat-less → `agentFolder = <brick>/agents/<session-uuid>` (the FULL id, where the lived artifacts of a
 *   pre-backfill session already sit), `seatFolder = null` — a seat path is never invented for a record that
 *   has no seat.
 *
 * ⚠️ ID-ONLY, NO NAME SLUG — DO NOT "IMPROVE" THIS BACK INTO `<name>-<id8>` FOR LEGIBILITY. The name lives
 * on the seat record and is MUTABLE, so a name in the path orphans the folder on every rename; legibility
 * comes from atrium's seat name, not from the directory. No ordinal appears either: an ordinal is a label,
 * never an address.
 *
 * ⚠️ acpx-ui carries the SAME derivation (`brick/module/agentFolder.ts`) because the injected primer
 * renders the workspace line there. The two are pinned by ONE fixture, `test/fixtures/
 * agent-folder-derivation.fixture.json`, byte-identical in both repos and sha256-pinned in each repo's
 * test — `test/agent-folder-derivation.test.ts` goes red if either side changes alone.
 */
export function deriveAgentFolders(input: {
  brickPath: string;
  sessionId: string;
  seatId?: string | null;
}): AgentFolders {
  const normalized = path.posix.normalize(input.brickPath.trim());
  const base = normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
  const sessionId = input.sessionId.trim();
  const seatId = input.seatId?.trim() ?? "";
  if (seatId.length === 0) {
    return { agentFolder: `${base}/agents/${sessionId}`, seatFolder: null };
  }
  const seatFolder = `${base}/agents/${seatId.slice(0, ID_SLUG_LENGTH)}`;
  return {
    agentFolder: `${seatFolder}/holders/${sessionId.slice(0, ID_SLUG_LENGTH)}`,
    seatFolder,
  };
}

/** A usable single path segment: ids come off disk, so a separator or dot-segment must never reach a `mkdir`. */
export function isSafePathSegment(value: string | null | undefined): value is string {
  const trimmed = value?.trim();
  return (
    Boolean(trimmed) && !/[\\/]/.test(trimmed as string) && trimmed !== "." && trimmed !== ".."
  );
}

/**
 * Resolve (and create) the agent folder for a session — see `deriveAgentFolders`. Returns the folders, or
 * `null` when there is no usable brick folder (or the record's ids are not usable path segments).
 *
 * Defensive: only acts when the brick path is absolute and already exists as a directory, so a junk/typo
 * path never materializes a bogus tree. Re-derived each spawn with an idempotent `mkdir -p` (which also
 * creates the seat folder), and — being a function of ids only — independent of any later rename.
 *
 * brick b11f98fb: the legacy `metadata.task_folder` fallback was removed here; the brick path is the sole base.
 */
export function resolveAndEnsureAgentFolder(
  record: SessionRecord,
  brickPath?: string | null,
): AgentFolders | null {
  const baseDirectory = usableBaseDirectory(brickPath);
  if (!baseDirectory) {
    return null;
  }
  const seatId = record.seatId?.trim() ?? "";
  if (
    !isSafePathSegment(record.acpxRecordId) ||
    (seatId.length > 0 && !isSafePathSegment(seatId))
  ) {
    return null;
  }
  const folders = deriveAgentFolders({
    brickPath: baseDirectory,
    sessionId: record.acpxRecordId,
    seatId,
  });
  fs.mkdirSync(folders.agentFolder, { recursive: true });
  return folders;
}
