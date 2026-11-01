/**
 * The template name-key grammar (TEMPLATES CONCEPTION §4.1; brick 4608e926; build block T1 of brick fcef527e).
 *
 * ⚠️ FROZEN CROSS-REPO CONTRACT, BYTE-FOR-BYTE. This exact file lives at two paths and acpx-ui's mirror
 * (build block T2) must be this text, changed only in what a TypeScript target forces (nothing, today):
 *   - acpx     `src/session/persistence/template-name-key.ts`
 *   - acpx-ui  `server/templateNameKey.ts`   (precedent: `template-slug.ts` ↔ `server/templateSlug.ts`)
 * Both repos' tests run the same vectors through it. It has NO imports on purpose: an import line that
 * differs between the repos would make "byte-identical" a claim about everything but the one line that can
 * drift. The person-id pattern below is therefore a second copy of `person.ts`'s `isPersonId`; the acpx test
 * `template-name-key.test.ts` checks the two agree on every vector.
 *
 * A template's stored name key is `<base>` (machine-wide) or `<person-id>/<base>` (one person's). The owner
 * is part of the key, so every chain, list and lookup that already groups by the stored string keeps
 * working unchanged, and an acpx that knows nothing about owners can never mistake `p-…/reviewer` for
 * `reviewer` (the bytes differ).
 *
 * ⚠️ AN INVALID KEY BELONGS TO NOBODY. It is in no list and is never read as machine-wide (ruling B15): a
 * hand-edited `!!bad/reviewer` must not become something a plain name resolves to. Callers that need the
 * distinction read `owner === "invalid"`; they never treat "not a person key" as "machine-wide".
 */

/** Appendix A's canonical base: lowercase kebab, at most 64 characters. */
const BASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BASE_LENGTH = 64;

/** PERSON-CONTRACT C1.1: `p-` + 20 lowercase hex. */
const PERSON_ID_PATTERN = /^p-[0-9a-f]{20}$/;

export type NameKey =
  | { owner: "machine"; base: string }
  | { owner: "person"; personId: string; base: string }
  | { owner: "invalid"; raw: string };

function isCanonicalBase(base: string): boolean {
  return base.length <= MAX_BASE_LENGTH && BASE_RE.test(base);
}

/**
 * Classify a stored template key. `machine` is a canonical base with no `/`; `person` is exactly one `/`
 * with a C1.1 person id before it and a canonical base after it; everything else is `invalid`: more than
 * one `/`, an empty side, a non-canonical base (including one over 64 characters), a prefix that is not a
 * person id, or a value that is not a string.
 */
export function parseNameKey(key: unknown): NameKey {
  if (typeof key !== "string") {
    return { owner: "invalid", raw: "" };
  }
  const parts = key.split("/");
  if (parts.length === 1 && isCanonicalBase(key)) {
    return { owner: "machine", base: key };
  }
  if (parts.length === 2 && PERSON_ID_PATTERN.test(parts[0]) && isCanonicalBase(parts[1])) {
    return { owner: "person", personId: parts[0], base: parts[1] };
  }
  return { owner: "invalid", raw: key };
}

/** The stored key of a person's template. `base` must already be canonical (slugify it first). */
export function personNameKey(personId: string, base: string): string {
  return `${personId}/${base}`;
}

/**
 * CONCEPTION §5, the one visibility rule: machine-wide templates, plus the current person's own. No
 * person (`undefined`) shows machine-wide only. An invalid key and another person's key are never
 * visible. A template with no stored key at all (a legacy slug-less one, id-only) is machine-wide.
 */
export function isVisibleTemplateKey(
  key: string | undefined,
  personId: string | undefined,
): boolean {
  if (key === undefined) {
    return true;
  }
  const parsed = parseNameKey(key);
  if (parsed.owner === "machine") {
    return true;
  }
  return parsed.owner === "person" && personId !== undefined && parsed.personId === personId;
}
