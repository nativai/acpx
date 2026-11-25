import { InvalidArgumentError } from "commander";
import { metadataKeyRuleViolation } from "../../persisted-key-policy.js";
import {
  ATRIUM_OS_METADATA_PREFIX,
  PRINCIPAL_METADATA_PREFIX,
} from "../../session/persistence/principal.js";
import { SEAT_AUTO_NAME_KEY } from "../../session/seat-display-name.js";
import type { SessionRecord } from "../../types.js";
import { isBrickUuid } from "./brick-link.js";

/** Refuses a `metadata` key that breaks the rule, as a usage error (exit 2) naming the key and the rule. */
export function assertMetadataKeyRule(key: string): void {
  const violation = metadataKeyRuleViolation(key);
  if (violation !== undefined) {
    throw new InvalidArgumentError(violation);
  }
}

/**
 * Validate a value for the self-apply `sessions set-metadata <key> <value>`
 * command. Generic keys accept any non-empty (trimmed) string — parity with the
 * `--metadata key=value` flag on `sessions new`/`ensure`. The one key with
 * semantics, `brick`, must additionally be a full uuid.
 */
export function validateSessionMetadataValue(key: string, value: string): string {
  // A-65 correction (C3.5 (iv)): a key acpx would write itself is spelled `^[a-z][a-z0-9_]*$`, refused here
  // before any write — the write path no longer judges a `metadata` key it merely carries.
  assertMetadataKeyRule(key);
  // brick b0968426 (PERSON-CONTRACT C8.3, G1): the recorded principal is written ONCE, at creation, and no verb
  // rewrites it — this is the only verb that writes a free-form key, so it is refused here, before any write.
  if (key.startsWith(PRINCIPAL_METADATA_PREFIX)) {
    throw new InvalidArgumentError(
      `${key} is recorded once, when the session is created, and cannot be changed afterwards`,
    );
  }
  // P3a §5: the OS choice has ONE writer after creation, so its validation cannot be bypassed, and the
  // three observation keys are acpx-owned (the lifecycle snapshot writes them).
  if (key.startsWith(ATRIUM_OS_METADATA_PREFIX)) {
    throw new InvalidArgumentError(
      `${key} is not set with set-metadata; use acpx sessions set-os <session> <default|path>`,
    );
  }
  // brick fac2128a §4.2 (TE finding F2): the generic-name marker is written only by a create — acpx's own copy
  // default, a caller's `--metadata` checked against the name it stores, a succession's carry. Set later it
  // could mark a name a PERSON chose as machine-made, and that seat's agent would then rename it.
  if (key === SEAT_AUTO_NAME_KEY) {
    throw new InvalidArgumentError(
      `${key} is recorded once, when the session is created, and cannot be set afterwards`,
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
