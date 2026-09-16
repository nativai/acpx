/**
 * Identity and file-set claiming for the cold-archive tier — conception
 * `archive-formats.md` §1 R1.4 and §2.
 *
 * Everything in this module answers one question: *given a directory listing,
 * which files belong to which session id, and which files are not session files
 * at all?* Getting it wrong is silent data loss in both directions — a
 * non-session file swept into the archive, or one session's files split across
 * two pseudo-ids.
 */

import { encodeSessionSafeId } from "./safe-id.js";

/**
 * Literal names that are NEVER a session file set, in either directory.
 *
 * ⚠️ THIS LIST DEFENDS THE BOXES WE ACTUALLY RUN ON. A naive first-dot split
 * turns every non-session file in the hot dir into a pseudo-id, and two live ids
 * on devbox escape archiving **by accident, not by design**: `index` escapes only
 * because the real index happens to be named `index.json`, and
 * `brick-remote-links` only because it happens to be valid JSON at
 * `brick-remote-links.json`. Each is one rename away from eligibility, and the
 * `index` case drags 19 stale `index.json.<pid>.<ts>.tmp` atomic-write leftovers
 * (~1 MB) along with it under the "every file starting with `<id>.`" rule.
 *
 * ⚠️ `deletions.ndjson` IS THE SHARP ONE. It is acpx's deletion manifest — the
 * audit trail for `acpx sessions prune`. It is absent on devbox only because no
 * prune has ever run here; on any box where one has, `idOf` yields `deletions`,
 * no `deletions.json` record exists, and an `--orphans` policy would move acpx's
 * deletion manifest into the archive. `deletion-manifest.ts` documents that
 * file's invisibility to enumerators as STRUCTURAL ("`"deletions.ndjson"
 * .endsWith(".json")` is FALSE ... BY CONSTRUCTION rather than by appearing on any
 * exclusion list"). This list preserves that property rather than relying on it.
 */
const RESERVED_ID_PARTS: ReadonlySet<string> = new Set([
  "index",
  "MANIFEST",
  "ARCHIVE-INDEX",
  "README",
  "deletions",
  "brick-remote-links",
]);

/**
 * The structural half of the reserved rule: an id with no record behind it must
 * also LOOK like an id acpx would have minted.
 *
 * ⚠️ IDS ARE OPAQUE STRINGS, NOT UUIDS — devbox carries 18 live
 * `ses_f84bb7041ffeOayX6OGKPn4Elu` ids (agent `opencode`), and a uuid-only regex
 * leaves every one of them hot forever.
 *
 * ⚠️ AND THIS GUARD IS INGEST-ONLY — never apply it on the archive side. The
 * strict/lenient asymmetry is normative (formats §2 C2.4) and an implementer
 * reaches for symmetry by instinct: the live archive ALREADY contains
 * `mid-turn-injection`, a legacy codex fixture record with an arbitrary slug id,
 * legitimately moved by the one-off. An archive-side reader that enforced this
 * shape would drop it from the list, fail to resolve it, and leave it
 * unrestorable while it sits in plain sight. See `claimArchiveFileSets`, which
 * takes no shape guard at all.
 */
const INGEST_ORPHAN_ID_SHAPE =
  /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|ses_[A-Za-z0-9]+)$/;

/**
 * The suffixes acpx-ui treats as an ACTIVE delivery sidecar — `ACTIVE_SIDECAR_SUFFIXES`
 * in `acpx-ui/server/delivery-store.ts`. Their presence means undelivered work.
 */
const ACTIVE_SIDECAR_SUFFIXES: readonly string[] = [
  ".delivery.json",
  ".queue.json",
  ".inflight.json",
];

/** The id part of a filename under the first-dot split — orphans only. */
function idPartOf(fileName: string): string {
  const dot = fileName.indexOf(".");
  return dot === -1 ? fileName : fileName.slice(0, dot);
}

/**
 * THE record-filename constructor. Every "where does this id's record live"
 * question goes through here — there is no second place that concatenates
 * `".json"` onto an id.
 *
 * ⚠️ SEAM, DELIBERATE: a future cold tier may store the record under a different
 * extension (compressed, or off-PVC — brick 62b757f6). The move/restore path is
 * already immune because the unit of archiving is the whole `<id>.` prefix set,
 * but RECORD PRESENCE is not: see `findRecordFile` for what breaks. Teaching the
 * product a new record extension must stay a change to these two functions, not
 * an audit of every call site.
 */
export function recordFileNameFor(safeId: string): string {
  return `${safeId}.json`;
}

/**
 * THE record-presence test. `undefined` means "this id has no record anywhere",
 * which is exactly what makes an id an ORPHAN.
 *
 * ⚠️ WHY THIS IS ONE FUNCTION AND NOT AN INLINE `files.includes(id + ".json")`:
 * orphan classification is the most destructive verdict this feature can reach.
 * An orphan is swept under the `--orphans` policy, gets NO `ARCHIVE-INDEX` entry
 * (there is no record to project) and therefore no Restore affordance in the UI —
 * so an id misclassified as an orphan degrades from a complete session into
 * residue. If a future tier ever stores a record under another extension
 * (brick 62b757f6), a suffix assumption scattered across call sites would make
 * that failure silent and store-wide. It lives here so it can be taught once.
 */
export function findRecordFile(safeId: string, files: readonly string[]): string | undefined {
  const expected = recordFileNameFor(safeId);
  return files.find((file) => file === expected);
}

/**
 * THE active-sidecar predicate — the `active-delivery-sidecar` blocker of
 * BRIEF §6.3 and liveness signal 2 of §6.5.
 *
 * Same seam rationale as `findRecordFile`: a compressed variant would stop
 * matching a scattered suffix comparison, and an id holding undelivered work
 * would quietly stop being excluded. One function, one place to teach.
 */
export function hasActiveSidecar(safeId: string, files: readonly string[]): boolean {
  return files.some((file) =>
    ACTIVE_SIDECAR_SUFFIXES.some((suffix) => file === `${safeId}${suffix}`),
  );
}

/** TAB/CR/LF in a filename — formats §2 C2.5. */
export function isHostileFileName(fileName: string): boolean {
  return /[\t\r\n]/.test(fileName);
}

export type ArchiveFileSet = {
  /** The session id as the record states it (or the filename token, for orphans). */
  id: string;
  /** `encodeURIComponent(id)` — what filenames are actually built from. */
  safeId: string;
  /** Basenames, sorted. Includes the record file when there is one. */
  files: string[];
};

/**
 * Claim files to ids by LONGEST MATCHING PREFIX (formats §2 C2.3 rule 2).
 *
 * ⚠️ NOT A FIRST-DOT SPLIT. acpx's own code guards this case explicitly — see the
 * comment on `indexStreamFilesBySafeId` in `persistence/repository.ts`, "a safeId
 * may itself contain `.stream.`", with a named regression test. No dotted id
 * exists on devbox today (measured: 0 of 3,602), but ids are opaque by contract,
 * so a first-dot split is a LATENT DATA-LOSS BUG: it can split one session's
 * files across two pseudo-ids, or merge two sessions under one. The candidate set
 * is enumerated from RECORDS, never guessed from filenames, precisely so this
 * rule has something authoritative to be longest against.
 *
 * `candidateSafeIds` is authoritative: a file matching no candidate is left
 * unclaimed and returned separately for the caller's orphan policy to judge.
 */
export function claimFileSets(
  files: readonly string[],
  candidateSafeIds: ReadonlySet<string>,
): { claimed: Map<string, string[]>; unclaimed: string[] } {
  const claimed = new Map<string, string[]>();
  const unclaimed: string[] = [];

  for (const file of files) {
    let owner: string | undefined;
    // Walk dot positions from the LAST to the FIRST so the first hit is the
    // longest matching candidate prefix.
    for (let i = file.lastIndexOf("."); i > 0; i = file.lastIndexOf(".", i - 1)) {
      const prefix = file.slice(0, i);
      if (candidateSafeIds.has(prefix)) {
        owner = prefix;
        break;
      }
    }
    if (owner == null) {
      unclaimed.push(file);
      continue;
    }
    const bucket = claimed.get(owner);
    if (bucket) {
      bucket.push(file);
    } else {
      claimed.set(owner, [file]);
    }
  }

  for (const bucket of claimed.values()) {
    bucket.sort();
  }
  return { claimed, unclaimed };
}

/**
 * Group the leftovers of `claimFileSets` into orphan file sets — the ONLY place a
 * first-dot split is permitted, and only after both halves of the reserved rule
 * have been applied (formats §1 R1.4, §2 C2.3 rule 3).
 */
export function claimOrphanFileSets(unclaimed: readonly string[]): {
  orphans: Map<string, string[]>;
  ignored: string[];
} {
  const orphans = new Map<string, string[]>();
  const ignored: string[] = [];

  for (const file of unclaimed) {
    const idPart = idPartOf(file);
    // A dotless name has an id-part equal to itself and no `<id>.` file set can
    // exist for it, so by R1.4's structural rule it is not a session file.
    if (idPart === file || RESERVED_ID_PARTS.has(idPart) || !INGEST_ORPHAN_ID_SHAPE.test(idPart)) {
      ignored.push(file);
      continue;
    }
    const bucket = orphans.get(idPart);
    if (bucket) {
      bucket.push(file);
    } else {
      orphans.set(idPart, [file]);
    }
  }

  for (const bucket of orphans.values()) {
    bucket.sort();
  }
  return { orphans, ignored };
}

/**
 * Claim file sets on the ARCHIVE side.
 *
 * ⚠️ NO SHAPE GUARD AND NO RESERVED FILTER BEYOND THE LITERAL NAMES — this is the
 * lenient half of formats §2 C2.4 and it is NOT an oversight. See
 * `INGEST_ORPHAN_ID_SHAPE` for the specimen already on disk that a symmetric
 * implementation loses.
 */
export function claimArchiveFileSets(files: readonly string[]): Map<string, string[]> {
  // Archive-side candidates come from the record files that are actually there,
  // which is the same record-driven enumeration as the hot side — just without
  // the ingest guards.
  const candidates = new Set<string>();
  for (const file of files) {
    if (file.endsWith(".json") && !RESERVED_ID_PARTS.has(idPartOf(file))) {
      candidates.add(file.slice(0, -".json".length));
    }
  }
  const { claimed, unclaimed } = claimFileSets(files, candidates);
  for (const file of unclaimed) {
    const idPart = idPartOf(file);
    if (idPart === file || RESERVED_ID_PARTS.has(idPart)) {
      continue;
    }
    const bucket = claimed.get(idPart);
    if (bucket) {
      bucket.push(file);
      bucket.sort();
    } else {
      claimed.set(idPart, [file]);
    }
  }
  return claimed;
}

export { ACTIVE_SIDECAR_SUFFIXES, encodeSessionSafeId, RESERVED_ID_PARTS };
