import path from "node:path";
import { InvalidArgumentError } from "commander";
import type { SessionRecord } from "../../types.js";
import { isBrickUuid } from "./brick-link.js";

/**
 * Validate a value for the self-apply `sessions set-metadata <key> <value>`
 * command. Generic keys accept any non-empty (trimmed) string — parity with the
 * `--metadata key=value` flag on `sessions new`/`ensure`. The one key with
 * semantics, `task_folder`, must additionally be an absolute path (mirrors
 * acpx-ui's `PATCH /metadata` contract and the `--metadata` example). Existence
 * is intentionally NOT checked here — a non-existent absolute path is accepted,
 * matching `--metadata` (the caller may emit a soft warning).
 */
export function validateSessionMetadataValue(key: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("Metadata value must not be empty");
  }
  if (key === "task_folder" && !path.isAbsolute(trimmed)) {
    throw new InvalidArgumentError(
      `task_folder must be an absolute path (got: ${JSON.stringify(value)})`,
    );
  }
  if (key === "brick") {
    const normalized = trimmed.toLowerCase();
    if (!isBrickUuid(normalized)) {
      throw new InvalidArgumentError(
        `brick must be a full uuid (got: ${JSON.stringify(value)}); resolve refs with: brick show <ref> --json`,
      );
    }
    return normalized;
  }
  return trimmed;
}

/**
 * Update-in-place (per-key) merge of a single metadata entry into a session
 * record. Pure: returns a new record, never mutates the input. Mirrors the
 * `ensureSession` merge shape (`{ ...existing, ...new }`) so the create/ensure
 * and self-apply paths cannot drift; other metadata keys are preserved.
 */
export function mergeSessionMetadata(
  record: SessionRecord,
  key: string,
  value: string,
): SessionRecord {
  return { ...record, metadata: { ...record.metadata, [key]: value } };
}
