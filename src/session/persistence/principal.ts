/**
 * The recorded principal of a session — "whose session is this" (PERSON-CONTRACT v3.1 C8; brick b0968426,
 * build block P1 of brick fcef527e).
 *
 * It lives in the record's `metadata` as flat STRINGS, because `metadata` is `Record<string,string>` and
 * `parseMetadata` fails the WHOLE record load on any other value:
 *   principal_via   always written: started | armer | telegram | inherited | none
 *   principal_id    only when there is a principal (`p-` + 20 hex, C1)
 *   principal_name  only when there is a principal
 *   principal_from  the creator session's id, only when principal_via = inherited
 *
 * acpx writes `inherited` (a copy of the creator's answer, one hop) and `none` (no creator at all); the
 * `started` / `armer` / `telegram` rows are atrium's and arrive here through an explicit `--metadata`.
 * No verb rewrites the keys afterwards (C8.3).
 *
 * ⚠️ THE PRINCIPAL OF A COPY IS ITS MAKER'S, NEVER ITS SOURCE'S (C8.3, G2). `withRecordedPrincipal` takes the
 * CREATOR — the caller of the verb — and has no parameter through which a copy's source could reach it. Do
 * not add one: a copy that answered its source's person would hand one person's session to another.
 */
import { isPersonId } from "./person.js";

/** Key prefix of the principal entries in a record's metadata and on its index entry. */
export const PRINCIPAL_METADATA_PREFIX = "principal_";
const STARTED_BY_PREFIX = "started_by_";

const VIA_KEY = "principal_via";
const ID_KEY = "principal_id";
const NAME_KEY = "principal_name";
const FROM_KEY = "principal_from";

/** The entries of `source` whose key starts with `prefix`, keys and string values verbatim; undefined when none. */
export function stringEntriesWithPrefix(
  source: unknown,
  prefix: string,
): Record<string, string> | undefined {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return undefined;
  }
  const picked: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith(prefix) && typeof value === "string") {
      picked[key] = value;
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** The record's `principal_*` metadata, verbatim; undefined when it carries none. */
export function principalEntriesOf(metadata: unknown): Record<string, string> | undefined {
  return stringEntriesWithPrefix(metadata, PRINCIPAL_METADATA_PREFIX);
}

/** What `acpx people principal` and the agent environment read out of a record's metadata. */
export type RecordedPrincipal = {
  via: string;
  id: string | null;
  name: string | null;
  from: string | null;
};

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Null when the record has no `principal_via` — a session that predates the keys ("not recorded"). */
export function recordedPrincipalOf(metadata: unknown): RecordedPrincipal | null {
  const entries = principalEntriesOf(metadata);
  const via = nonEmpty(entries?.[VIA_KEY]);
  if (!entries || via === null) {
    return null;
  }
  return {
    via,
    id: nonEmpty(entries[ID_KEY]),
    name: nonEmpty(entries[NAME_KEY]),
    from: nonEmpty(entries[FROM_KEY]),
  };
}

// eslint-disable-next-line no-control-regex -- the point is to refuse control characters in an env value
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/**
 * `ACPX_PRINCIPAL_ID` / `ACPX_PRINCIPAL_NAME` for a record (C8.6): set only when the record names a person,
 * so a bare-shell session's agent has the variables UNSET, never empty. A malformed id is no principal; a
 * name with a control character is dropped rather than put into an environment.
 */
export function principalEnvOf(metadata: unknown): { id: string; name: string | null } | null {
  const recorded = recordedPrincipalOf(metadata);
  if (!recorded || !isPersonId(recorded.id)) {
    return null;
  }
  const name =
    recorded.name !== null && !CONTROL_CHARACTER.test(recorded.name) ? recorded.name : null;
  return { id: recorded.id, name };
}

/** A resolved creator session: its id and its `principal_*` entries (empty for a record that predates them). */
export type PrincipalCreator = {
  acpxRecordId: string;
  principal?: Record<string, string>;
};

/**
 * One hop of C8.3 for a session whose creator is `creator`: a copy of the creator's answer, `inherited`,
 * with `principal_from` naming the creator. Nothing for a creator that records no `principal_via` (a
 * session that predates the keys, or a creator on another box whose record is not here) — the walk
 * answers for those.
 */
export function inheritedPrincipalEntries(
  creator: PrincipalCreator,
): Record<string, string> | undefined {
  const recorded = recordedPrincipalOf(creator.principal);
  if (!recorded) {
    return undefined;
  }
  const entries: Record<string, string> = { [VIA_KEY]: "inherited" };
  if (recorded.id !== null) {
    entries[ID_KEY] = recorded.id;
  }
  if (recorded.name !== null) {
    entries[NAME_KEY] = recorded.name;
  }
  entries[FROM_KEY] = creator.acpxRecordId;
  return entries;
}

/**
 * The metadata a new session is created with, once its principal is recorded (C8.3, CONCEPTION §4.2).
 * Precedence: explicit `principal_*` keys win (atrium's own create paths pass them); then the creator's
 * answer; otherwise nothing is added. `creator` undefined means no creator was found — a bare shell — and
 * records `principal_via=none`.
 *
 * Two cases write nothing, and the second is a deliberate narrowing of "a bare shell records none":
 *  - the creator is a session that records no `principal_via`, or is not on this box;
 *  - the create carries `started_by_*` metadata. That is atrium creating the session for a person (or for
 *    the system), and atrium owns the principal of that session; a `none` written here, while atrium's own
 *    writer is not yet deployed, would hide the person from the walk that would still find them.
 */
export function withRecordedPrincipal(
  childMetadata: Record<string, string> | undefined,
  creator: PrincipalCreator | undefined,
): Record<string, string> | undefined {
  if (
    principalEntriesOf(childMetadata) !== undefined ||
    stringEntriesWithPrefix(childMetadata, STARTED_BY_PREFIX) !== undefined
  ) {
    return childMetadata;
  }
  if (creator === undefined) {
    return { ...childMetadata, [VIA_KEY]: "none" };
  }
  const inherited = inheritedPrincipalEntries(creator);
  return inherited === undefined ? childMetadata : { ...childMetadata, ...inherited };
}

/**
 * The two `sessionContext` fields a record contributes to the agent environment (C8.6), spread into every
 * place a `sessionContext` is built from a record. `null`, not absent, for "no principal" so a leg that
 * forgot the spread differs from a leg that asked: `test/principal-env.test.ts` finds every such site by
 * scanning for it.
 */
export function principalContextFields(metadata: unknown): {
  principalId: string | null;
  principalName: string | null;
} {
  const env = principalEnvOf(metadata);
  return { principalId: env?.id ?? null, principalName: env?.name ?? null };
}
