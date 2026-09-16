import fs from "node:fs/promises";
import path from "node:path";

/**
 * A read-only projection of an on-disk session record, for the archiver only.
 *
 * ⚠️ THIS READS THE **ON-DISK (snake_case)** KEY NAMES AND THAT IS THE WHOLE POINT
 * OF THE MODULE. The TypeScript `SessionRecord` type and every `index.json` entry
 * use camelCase (`closedAt`, `lastUsedAt`, `forkedFromSessionId`); the files on
 * disk use `closed_at`, `last_used_at`, `forked_from_session_id`,
 * `metadata.byway_parent`. An implementer who reads only the TS types produces
 * EMPTY COLUMNS THAT TYPECHECK — the manifest and shard index fill with blanks and
 * nothing fails. Verified on live records 2026-09-16: `closed_at` present on
 * 400/400 sampled closed records.
 *
 * ⚠️ AND IT DELIBERATELY DOES NOT GO THROUGH `parseSessionRecord`. Two reasons.
 * (a) That parser hydrates `messages` and is built for records acpx intends to
 * USE; the archiver only ever needs ~15 scalars off a file it must not mutate, and
 * on a multi-MB record the difference is the run's cost. (b) Its acceptance
 * criteria are stricter than "is this a session": a record it rejects must be
 * treated as `record-unparseable` (keep, never move), and borrowing acpx's
 * usability bar as the archiver's preservation bar would move files acpx merely
 * cannot open.
 */
export type ArchiveRecordView = {
  /** `$.acpx_record_id` — the authoritative id, not the filename token. */
  id: string | undefined;
  closed: boolean;
  closedAt: string | undefined;
  lastUsedAt: string | undefined;
  updatedAt: string | undefined;
  createdAt: string | undefined;
  kind: string | undefined;
  name: string | undefined;
  cwd: string | undefined;
  agentName: string | undefined;
  brick: string | undefined;
  lastSeq: number | undefined;
  /** PRESENCE, not `.enabled` — a soft-retracted blueprint keeps `enabled:false`. */
  hasTemplate: boolean;
  favorite: boolean;
  pid: number | undefined;
  parentSessionId: string | undefined;
  /**
   * `$.metadata.byway_parent` — checked FIRST when resolving a byway's anchor,
   * per acpx-ui's `server/byway.ts` `isOrphanByway`, which is the source of truth.
   */
  bywayParent: string | undefined;
  forkedFromSessionId: string | undefined;
  /** Superset flag: `kind === "byway" || metadata.byway != null`. */
  isByway: boolean;
};

export type ArchiveRecordRead =
  | { status: "ok"; view: ArchiveRecordView }
  /** The file is not there. This id is an ORPHAN, not a blocked one. */
  | { status: "absent" }
  /**
   * The file exists and could not be turned into a view — unreadable (EIO,
   * EACCES), truncated, not JSON, or JSON that is not a session record.
   *
   * ⚠️ ONE STATUS FOR ALL OF THOSE, ON PURPOSE. This inherits acpx's own prune
   * doctrine verbatim: *"for a destruction guard the error path IS the guard"*
   * (`repository.ts:1540-1553`). A transient EIO must read as "possibly
   * protected, skip this run", never as "safe to move" — and splitting a
   * blocker into "definitely corrupt" and "maybe corrupt" invites exactly the
   * branch where the second one moves.
   */
  | { status: "unreadable"; detail: string };

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asRecordObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return metadata ? optionalString(metadata[key]) : undefined;
}

/**
 * ⚠️ A SUPERSET ON THE FLAG IS SAFE; A SUBSET IS NOT. acpx-ui's `isOrphanByway`
 * is what hard-deletes a byway whose anchor vanished, so failing to recognise a
 * record AS a byway is the direction that loses data — it drops out of companion
 * closure and is destroyed within five minutes of its anchor leaving. Recognising
 * a non-byway as one merely moves it with its parent, which is harmless.
 */
function isBywayRecord(
  record: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
): boolean {
  return record.kind === "byway" || metadata?.byway != null;
}

export function projectArchiveRecord(parsed: unknown): ArchiveRecordView | undefined {
  const record = asRecordObject(parsed);
  if (!record) {
    return undefined;
  }
  // The minimum that makes this a session record rather than some other JSON
  // that happens to sit in the sessions dir (`brick-remote-links.json` is the
  // live specimen). Deliberately weak — see the module comment on why the
  // archiver must not borrow acpx's usability bar as its preservation bar.
  const id = optionalString(record.acpx_record_id);
  if (id == null) {
    return undefined;
  }
  const metadata = asRecordObject(record.metadata);
  return {
    id,
    closed: record.closed === true,
    closedAt: optionalString(record.closed_at),
    lastUsedAt: optionalString(record.last_used_at),
    updatedAt: optionalString(record.updated_at),
    createdAt: optionalString(record.created_at),
    kind: optionalString(record.kind),
    name: optionalString(record.name) ?? optionalString(record.title),
    cwd: optionalString(record.cwd),
    agentName: optionalString(record.agent_name),
    brick: metadataString(metadata, "brick"),
    lastSeq: optionalNumber(record.last_seq),
    hasTemplate: record.template != null,
    favorite: record.favorite === true,
    pid: optionalNumber(record.pid),
    parentSessionId: optionalString(record.parent_session_id),
    bywayParent: metadataString(metadata, "byway_parent"),
    forkedFromSessionId: optionalString(record.forked_from_session_id),
    isByway: isBywayRecord(record, metadata),
  };
}

export async function readArchiveRecord(
  dir: string,
  recordFileName: string,
): Promise<ArchiveRecordRead> {
  let payload: string;
  try {
    payload = await fs.readFile(path.join(dir, recordFileName), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "absent" };
    }
    return { status: "unreadable", detail: (error as NodeJS.ErrnoException).code ?? "read-failed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return { status: "unreadable", detail: "invalid-json" };
  }
  const view = projectArchiveRecord(parsed);
  return view ? { status: "ok", view } : { status: "unreadable", detail: "not-a-session-record" };
}

/**
 * The age anchor a tier compares against: `closed_at ?? last_used_at`, with
 * acpx's own fallback chain behind it (`updated_at`, then `created_at`) for the
 * records that predate `last_used_at` being mandatory.
 *
 * ⚠️ TAKEN FROM THE RECORD, NEVER FROM THE INDEX ENTRY. `index.json` does NOT
 * project `closed_at` — it is `null` even on `closed:true` rows — so an
 * implementation reading the age off the index silently ages every session by
 * `lastUsedAt` instead. Measured specimen: record `closed_at` 18:02:57Z vs entry
 * `lastUsedAt` 17:33:39Z. The rig's `AGE-DISAGREE-*` cohort puts the two fields on
 * OPPOSITE SIDES of the boundary precisely so that substitution flips the verdict
 * instead of merely shifting it.
 *
 * ⚠️ THIS IS THE SINGLE PLACE RETENTION READS AN AGE OFF A RECORD, AND IT IS KEPT
 * THAT WAY ON PURPOSE — A SPEC AMENDMENT IS PENDING HERE. A restore-to-consult
 * followed by a re-close RE-STAMPS `closed_at`, so a session someone actually
 * reaches for stays hot for another full retention window, and one consulted
 * periodically never returns to the archive at all. `closed_at` is a live
 * lifecycle field, so the re-stamp is legitimate; what is wrong is retention
 * asking it "when did this session END" when it answers "when did someone last
 * CLOSE this". The endorsed fix direction is to key retention on the ORIGINAL
 * `closed_at` recorded in `MANIFEST.tsv` at archive time, with the record's
 * current value used only for never-archived sessions. ⚠️ DO NOT IMPROVISE THAT —
 * which field wins, and what a second archive row means for the first row's value,
 * are being settled by conception. This function is where the amendment lands.
 */
export function recordAgeAnchor(view: ArchiveRecordView): string | undefined {
  return view.closedAt ?? view.lastUsedAt ?? view.updatedAt ?? view.createdAt;
}
