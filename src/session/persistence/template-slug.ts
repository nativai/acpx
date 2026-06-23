/**
 * Template slug + "latest version" primitives (W13-01).
 *
 * These two algorithms are a FROZEN CROSS-REPO CONTRACT: acpx-ui implements the
 * byte-for-byte identical `slugify` (Appendix A) and "latest" comparator
 * (Appendix B) so that the slug a template groups/resolves under, and the
 * winner of a latest-per-slug collapse, are computed identically on both sides.
 * If you change anything here, change acpx-ui's mirror in the SAME commit and
 * keep CONCEPTION_v2_locked.md Appendix A/B in sync.
 */

/**
 * Appendix A — canonical slugify. Lowercase kebab; any run of non-`[a-z0-9]`
 * collapses to a single `-`; leading/trailing `-` trimmed; capped at 64 chars
 * (re-trimmed after the slice so a cut mid-`-`-run can't leave a trailing dash).
 *
 * Returns `undefined` for a name that slugifies to empty (e.g. an emoji-only
 * name) — the caller then falls back to the record id for grouping/resolution.
 *
 * Excludes `.`/`_` (unlike `sanitizeAgentFolderName`) so slugs are clean kebab.
 * Idempotent on an already-canonical slug, so it is safe to canonicalize an
 * explicit `--slug` value through it.
 */
export function slugify(name: string): string | undefined {
  let slug = name.trim().toLowerCase();
  slug = slug.replace(/[^a-z0-9]+/g, "-");
  slug = slug.replace(/^-+/, "").replace(/-+$/, "");
  slug = slug.slice(0, 64);
  slug = slug.replace(/-+$/, "");
  return slug.length > 0 ? slug : undefined;
}

/**
 * The slug a template effectively groups / resolves under: the persisted
 * `template.slug` when present, else `slugify(name)`. Lets slug-less records
 * (UI-created or pre-migration) still collapse and resolve. `undefined` ⇒ the
 * caller falls back to the record id (singleton group).
 */
export function effectiveTemplateSlug(
  slug: string | undefined,
  name: string | undefined,
): string | undefined {
  if (slug !== undefined) {
    return slug;
  }
  return name !== undefined ? slugify(name) : undefined;
}

/**
 * The fields the "latest" comparator orders on. Mapped from either a record
 * (`template.version` / `template.created_at` / `acpxRecordId`) or an index
 * entry (`templateVersion` / `templateCreatedAt` / `acpxRecordId`).
 */
export type TemplateOrderKey = {
  version: number | undefined;
  created_at: string | undefined;
  acpxRecordId: string;
};

/**
 * Appendix B — "a is later than b". Total order, so acpx and acpx-ui always
 * agree on the single winner for a slug:
 *   1. higher `version` (un-versioned ⇒ 0, so a versioned refresh always wins);
 *   2. else later `created_at` ISO string (undefined ⇒ "" sorts earliest);
 *   3. else higher `acpxRecordId` lexicographically (final tiebreak).
 */
export function isLaterTemplate(a: TemplateOrderKey, b: TemplateOrderKey): boolean {
  const aVersion = a.version ?? 0;
  const bVersion = b.version ?? 0;
  if (aVersion !== bVersion) {
    return aVersion > bVersion;
  }
  const aCreated = a.created_at ?? "";
  const bCreated = b.created_at ?? "";
  if (aCreated !== bCreated) {
    return aCreated > bCreated;
  }
  return a.acpxRecordId > b.acpxRecordId;
}

/**
 * Reduce a non-empty list to its Appendix-B latest. Returns undefined for an
 * empty list. Callers map their record/entry shape to a `TemplateOrderKey`.
 */
export function pickLatestTemplate<T>(
  items: readonly T[],
  toKey: (item: T) => TemplateOrderKey,
): T | undefined {
  let latest: T | undefined;
  let latestKey: TemplateOrderKey | undefined;
  for (const item of items) {
    const key = toKey(item);
    if (latestKey === undefined || isLaterTemplate(key, latestKey)) {
      latest = item;
      latestKey = key;
    }
  }
  return latest;
}
