import { InvalidArgumentError } from "commander";
import { PRINCIPAL_METADATA_PREFIX } from "../../session/persistence/principal.js";
import type { SessionRecord } from "../../types.js";
import { isBrickUuid } from "./brick-link.js";

/**
 * Validate a value for the self-apply `sessions set-metadata <key> <value>`
 * command. Generic keys accept any non-empty (trimmed) string — parity with the
 * `--metadata key=value` flag on `sessions new`/`ensure`. The one key with
 * semantics, `brick`, must additionally be a full uuid.
 */
export function validateSessionMetadataValue(key: string, value: string): string {
  // brick b0968426 (PERSON-CONTRACT C8.3, G1): the recorded principal is written ONCE, at creation, and no verb
  // rewrites it — this is the only verb that writes a free-form key, so it is refused here, before any write.
  if (key.startsWith(PRINCIPAL_METADATA_PREFIX)) {
    throw new InvalidArgumentError(
      `${key} is recorded once, when the session is created, and cannot be changed afterwards`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("Metadata value must not be empty");
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
 * record. Pure: returns a new record, never mutates the input. Uses the
 * `{ ...existing, ...new }` merge shape so the create and self-apply paths
 * cannot drift; other metadata keys are preserved.
 */
export function mergeSessionMetadata(
  record: SessionRecord,
  key: string,
  value: string,
): SessionRecord {
  return { ...record, metadata: { ...record.metadata, [key]: value } };
}
