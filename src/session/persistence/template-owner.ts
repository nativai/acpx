/**
 * Turning what a person TYPES into a template's stored key (TEMPLATES CONCEPTION §6.1, §8.1; brick 4608e926;
 * build block T1 of brick fcef527e).
 *
 *   `laatz/reviewer`                          handle form: the people list names the person
 *   `p-fb566154c0bf245b7538/reviewer`         id form: used as written, NO people list read
 *
 * Both give the stored key `<person-id>/<base>`. A name with no `/` is never handled here: a plain name is
 * machine-wide and matches the stored key byte for byte (`resolveTemplateSelector`).
 *
 * ⚠️ A QUALIFIED NAME NEVER FALLS BACK — not to the id leg, not to the plain `<base>`, not to "nobody".
 * Every failure below throws, so `nosuch/reviewer` can never quietly spawn machine-wide `reviewer`, and an
 * unreadable people list can never read as "no such person" (C6.3). The handle form reads `people.json`
 * through `readPeopleFile`, which returns no rows ONLY for an absent file and throws for any other failure
 * of the document; a row it cannot use is skipped and named on stderr, not a failure (brick 509d3884, O4).
 */
import { SessionResolutionError } from "../../errors.js";
import {
  type PeopleFileRow,
  PeopleFileError,
  readPeopleFile,
  reportSkippedPeopleRows,
} from "./people-file.js";
import { type MatchResult, type PersonHit, isPersonId, matchRef } from "./person.js";
import { parseNameKey, personNameKey } from "./template-name-key.js";
import { slugify } from "./template-slug.js";

type OwnerFailure = Exclude<MatchResult, { ok: true }>;

function personLine(person: PersonHit): string {
  return `${person.handle} (${person.name}) ${person.id}`;
}

function failureMessage(ref: string, where: string, failure: OwnerFailure): string {
  if (failure.error === "other-box") {
    return `templates are per box: '${ref}' names a person on ${failure.box}${where}`;
  }
  if (failure.error === "ambiguous") {
    return `'${ref}' is ambiguous${where}; it matches:\n  ${failure.candidates.map(personLine).join("\n  ")}`;
  }
  const note = failure.note === undefined ? "" : ` (${failure.note})`;
  const heading = `unknown person '${ref}'${where}${note}`;
  return failure.suggestions.length === 0
    ? heading
    : `${heading}; did you mean:\n  ${failure.suggestions.map(personLine).join("\n  ")}`;
}

async function readPeopleOrThrow(ref: string): Promise<PeopleFileRow[]> {
  try {
    const read = await readPeopleFile();
    reportSkippedPeopleRows(read);
    return read.rows;
  } catch (error) {
    if (error instanceof PeopleFileError) {
      throw new SessionResolutionError(
        `cannot resolve person '${ref}': people list unreadable (${error.message})`,
      );
    }
    throw error;
  }
}

/**
 * A person reference to a person id. An id is returned as written when `acceptUnlistedId` (a READ: the
 * stored key is literally `<id>/<base>`, so the lookup needs no list). Otherwise the people list is read
 * and the C4 resolver decides; `where` is appended to the error text (` in 'laatz/reviewer'`).
 */
export async function resolvePersonRef(
  ref: string,
  options: { acceptUnlistedId: boolean; where?: string },
): Promise<string> {
  if (options.acceptUnlistedId && isPersonId(ref)) {
    return ref;
  }
  const answer = matchRef(await readPeopleOrThrow(ref), ref);
  if (!answer.ok) {
    throw new SessionResolutionError(failureMessage(ref, options.where ?? "", answer));
  }
  return answer.person.id;
}

/** True for a typed name that carries an owner (`<ref>/<base>`); the id leg is skipped for these (ids hold no `/`). */
export function isQualifiedTemplateName(typed: string): boolean {
  return typed.includes("/");
}

/**
 * `<ref>/<base>` to the stored key. Exactly one `/`, and a canonical base (a typed name is NOT slugified:
 * `laatz/Reviewer` is an error, never `laatz/reviewer`, because resolution is exact).
 */
export async function resolveQualifiedTemplateKey(typed: string): Promise<string> {
  const parts = typed.split("/");
  const base = parts[1];
  if (parts.length !== 2 || parts[0] === "" || parseNameKey(base).owner !== "machine") {
    throw new SessionResolutionError(`'${typed}' is not a template name`);
  }
  const personId = await resolvePersonRef(parts[0], {
    acceptUnlistedId: true,
    where: ` in '${typed}'`,
  });
  return personNameKey(personId, base);
}

/** A mark's `--slug`: a BASE. It is canonicalized, and a `/` is refused rather than silently flattened. */
export function canonicalMarkBase(explicitSlug: string): string {
  if (explicitSlug.includes("/")) {
    throw new SessionResolutionError(
      `--slug '${explicitSlug}' contains '/': give the base name only; the owner is set with --owner`,
    );
  }
  const base = slugify(explicitSlug);
  if (base === undefined) {
    throw new SessionResolutionError(
      `--slug '${explicitSlug}' has no [a-z0-9] characters; provide a non-empty slug`,
    );
  }
  return base;
}

type CurrentOwner = Exclude<ReturnType<typeof parseNameKey>, { owner: "invalid" }>;

/** The owner a stored key carries, or undefined for no key and for an invalid one (it belongs to nobody). */
function currentOwnerOf(existingKey: string | undefined): CurrentOwner | undefined {
  const parsed = existingKey === undefined ? undefined : parseNameKey(existingKey);
  return parsed === undefined || parsed.owner === "invalid" ? undefined : parsed;
}

function assertOwnerUnchanged(
  existingKey: string | undefined,
  current: CurrentOwner,
  ownerId: string,
): void {
  if (current.owner === "person" && current.personId === ownerId) {
    return;
  }
  const holder = current.owner === "person" ? "another owner" : "no owner (machine-wide)";
  throw new SessionResolutionError(
    `a template's owner is fixed: '${existingKey}' already has ${holder}; ` +
      "make a new template to change who owns it",
  );
}

/**
 * The key a mark writes, and the owner rule (CONCEPTION §8.1, K8): `--owner` applies on the FIRST mark; a
 * re-mark keeps the owner, and a different `--owner` is an error. A record's current owner is read from
 * its stored key — machine-wide for a plain key, a person for `<id>/<base>`. A record with NO stored key
 * (a legacy slug-less template) has no owner yet, and an INVALID stored key belongs to nobody, so both may
 * take one with their first valid key.
 *
 * `ownerId` is a person id already resolved (the caller reads the people list; this stays pure).
 * `explicitBase` is `--slug`, already canonical. Returns the key to store, or undefined when the mark
 * leaves the key as it is (no `--slug` given). Throws `SessionResolutionError` before anything is written.
 */
export function planMarkKey(
  existingKey: string | undefined,
  ownerId: string | undefined,
  explicitBase: string | undefined,
): string | undefined {
  const current = currentOwnerOf(existingKey);
  if (current !== undefined && ownerId !== undefined) {
    assertOwnerUnchanged(existingKey, current, ownerId);
  }
  if (explicitBase === undefined) {
    assertOwnerHasBase(ownerId, current);
    return undefined;
  }
  const owner = current?.owner === "person" ? current.personId : ownerId;
  return owner === undefined ? explicitBase : personNameKey(owner, explicitBase);
}

function assertOwnerHasBase(ownerId: string | undefined, current: CurrentOwner | undefined): void {
  if (ownerId !== undefined && current === undefined) {
    throw new SessionResolutionError(
      "--owner needs --slug: a personal template's name is <person>/<base>, and a mark with no --slug has no base",
    );
  }
}

/**
 * The person whose templates the CALLER sees besides machine-wide ones: `ACPX_PRINCIPAL_ID`, which acpx sets
 * for an agent whose session names a person (C8.6) and which a bare shell does not have. A value that is
 * not a person id is no principal.
 */
export function callerPrincipalId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.ACPX_PRINCIPAL_ID;
  return isPersonId(value) ? value : undefined;
}
