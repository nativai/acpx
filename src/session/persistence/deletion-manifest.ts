import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { resolveAcpxUiBaseUrl } from "../../acp/auth-env.js";

/**
 * The deletion manifest — acpx's record of its own destructive acts.
 *
 * Written WRITE-AHEAD by both paths that destroy a session record, and by no
 * other. It exists because the store's accidental leftovers were being read as
 * evidence: three hard-deleted sessions that survived as a timestamps sidecar
 * plus an owner log were filed as records that had *vanished*, which seeded a
 * whole "record-loss platform class" investigation (brick://29eaff14). The
 * residue's shape is ambiguous between the two deleters; a manifest line is not.
 *
 * Scoped to the ACT, not the verb: `sessions prune` and `templates rollback
 * --delete` are the only two paths in acpx that unlink a session record, so a
 * manifest written by both covers every deletion acpx can perform. A
 * prune-only manifest would not have recorded the case that motivated it.
 */

/**
 * ⚠️ NOT `.json`-suffixed, and that is STRUCTURAL rather than stylistic.
 *
 * acpx's own index rebuild ingests every `*.json` in this directory as a
 * candidate session record (`persistence/index.ts` `listSessionRecordFiles`:
 * `name.endsWith(".json") && name !== "index.json"`) and relies on the parse
 * failure to discard it. The live store is the proof of what that costs: 200
 * `<id>.delivery.json` files are read and thrown away on every rebuild.
 *
 * `"deletions.ndjson".endsWith(".json")` is FALSE — the last five characters are
 * `djson` — so this file is invisible to that filter, and equally to acpx-ui's
 * single orphan-scan consumer (`server/index.ts:4652`, whose first filter line
 * is the same test), BY CONSTRUCTION rather than by appearing on any exclusion
 * list.
 *
 * A convention is not a control, so that property is pinned by a test that runs
 * the real index-rebuild path over a directory containing this file
 * (`test/deletion-manifest.test.ts`), not by this comment. If someone renames
 * this constant to something `.json`-suffixed, that test is what fails.
 *
 * No leading dot, deliberately: an investigator must SEE it in `ls`.
 */
export const DELETION_MANIFEST_FILE_NAME = "deletions.ndjson";

const MANIFEST_SCHEMA_VERSION = 1;

/**
 * Which deleters this build records. Written into the header because an absence
 * has two causes and the artifact must name which (`verification-soundness` §2).
 * Without it, "I grepped the manifest and found nothing" means *not deleted by
 * acpx* OR *deleted before the manifest existed* OR *deleted by a path this
 * manifest never covered*. The header's `at` dates the boundary; `covers` names
 * it.
 *
 * A READER must take `covers` from the header line of the file in front of them,
 * never from this constant — an older file was written by an older `covers`.
 */
const MANIFEST_COVERS = ["sessions_prune", "templates_rollback_delete"];

/** Which deleter ran — the thing the residue's file-shape could never resolve. */
export type DeletionManifestOp = "sessions_prune" | "templates_rollback_delete";

/**
 * One destroyed session.
 *
 * Absent-vs-null is a schema rule, because the distinction is load-bearing
 * exactly once. A key is ABSENT when its value is unknown or not applicable.
 * `null` is used ONLY for `invoker`, where it is a positive assertion — *no acpx
 * session in the environment*, i.e. a human at a terminal or a shell script —
 * and not a gap. A consumer must therefore treat `"invoker": null` and a missing
 * `invoker` as DIFFERENT, and every other missing key as simply unknown.
 */
export type DeletionManifestEntry = {
  op: DeletionManifestOp;
  at: string;
  /** Agent identity scope. Absent on the rollback path, which has none. */
  agent?: string;
  /** The resolved CLI prune scope. Absent on the rollback path. */
  scope?: unknown;
  id: string;
  name?: string;
  cwd: string;
  createdAt?: string;
  closedAt?: string;
  /** Which file classes this deletion covers, from
   *  {record, messages, stream, timestamps, owner}. This is what makes the entry
   *  self-describing about the tiering: a reader learns not only THAT a session
   *  was deleted but WHAT went with it, so a surviving sidecar is explained by
   *  the entry rather than interpreted from the shape. */
  classes: string[];
};

/**
 * The write-ahead record could not be written, so nothing was destroyed.
 *
 * ⚠️ Both destructive CLI handlers catch THIS TYPE ONLY and re-throw everything
 * else, the same discipline `PruneAborted` establishes. A bare `catch` on a
 * destructive path swallows unrelated failures and reports them to the operator
 * as an audit failure — telling them to free disk space when the real fault was
 * something else entirely.
 */
export class DeletionManifestWriteError extends Error {
  constructor(
    readonly manifestPath: string,
    readonly cause: unknown,
  ) {
    super(`could not record the deletion in ${manifestPath}`);
    this.name = "DeletionManifestWriteError";
  }
}

export function deletionManifestPath(sessionDir: string): string {
  return path.join(sessionDir, DELETION_MANIFEST_FILE_NAME);
}

/** The message an operator sees as `cause:`. Node's fs errors carry the useful
 *  part (`ENOSPC: no space left on device, ...`) on `message`. */
export function describeManifestFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Append one line per destroyed session, returning how many were written.
 *
 * ⚠️ ONE OPEN FD, ONE `write` PER LINE — deliberately NOT one `appendFile` for
 * the whole run. A whole-box prune is ~2,350 lines ≈ 700 KB, and a single 700 KB
 * `write(2)` to an `O_APPEND` fd is NOT atomic against a concurrent writer, so
 * two racing prunes could interleave MID-LINE and corrupt the NDJSON. At ~300 B
 * per line the worst concurrent outcome is interleaved WHOLE lines, which NDJSON
 * tolerates.
 *
 * Honest bound, because this comment would otherwise assert a guarantee nobody
 * tested: line-level `O_APPEND` atomicity is a practical property of this
 * filesystem, not a POSIX promise at any size. Racing whole-box prunes are
 * already an unsupported, unfixed pre-existing condition (brick://dd4cb0e8 §8
 * E-h), so this does not make anything worse — but the only concurrency
 * property acpx CLAIMS here is the header race, which `"ax"` genuinely
 * guarantees. Do not upgrade one passing race into a general guarantee. If it
 * ever matters, the fix is an exclusive `flock` on the manifest, which is
 * additive.
 */
export async function appendDeletionManifest(
  sessionDir: string,
  entries: DeletionManifestEntry[],
): Promise<number> {
  // Driven by the deleted set, not by being called: a run that destroys nothing
  // records nothing, and does not even create the file.
  if (entries.length === 0) {
    return 0;
  }

  const manifestPath = deletionManifestPath(sessionDir);
  await writeManifestHeaderOnce(manifestPath);

  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(manifestPath, "a");
    for (const entry of entries) {
      await handle.write(serializeManifestEntry(entry));
    }
  } catch (error) {
    throw new DeletionManifestWriteError(manifestPath, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }

  return entries.length;
}

/**
 * `"ax"` is `O_CREAT|O_EXCL`: it succeeds exactly once for a given path, ever.
 * `EEXIST` means the header is already there — another process wrote it, or an
 * earlier run did — and is the expected outcome on every invocation but the
 * first. This is the ONE concurrency property this module claims.
 */
async function writeManifestHeaderOnce(manifestPath: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await fs.open(manifestPath, "ax");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw new DeletionManifestWriteError(manifestPath, error);
  }

  try {
    await handle.write(
      `${JSON.stringify({
        v: MANIFEST_SCHEMA_VERSION,
        op: "manifest_open",
        at: new Date().toISOString(),
        // ⚠️ resolveAcpxUiBaseUrl, NEVER os.hostname(). On a dev box the hostname
        // is the EPHEMERAL pod name (it changes on every restart), so a header
        // stamped with it names a machine that no longer exists — misleading
        // provenance in the one artifact whose whole job is provenance. acpx
        // calls os.hostname() nowhere in src/, which is itself the tell. This
        // resolver is already "the single point that decides the host agents
        // see", survives the ssh-with-empty-env case, and covers the boxes
        // canonically served on a third TLD, which no hostname rule can. A base
        // URL is also self-describing off-box: a manifest copied between boxes
        // still says which box wrote it.
        box: resolveAcpxUiBaseUrl(process.env),
        covers: MANIFEST_COVERS,
      })}\n`,
    );
  } catch (error) {
    throw new DeletionManifestWriteError(manifestPath, error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Built key-by-key rather than by spreading, because both the ORDER (so a human
 *  scanning the file reads deleter → when → who → what) and the absent-vs-null
 *  rule above are part of the frozen schema. */
function serializeManifestEntry(entry: DeletionManifestEntry): string {
  const line: Record<string, unknown> = {
    v: MANIFEST_SCHEMA_VERSION,
    op: entry.op,
    // ⚠️ "begin", not "done", and there is deliberately no "end" record.
    //
    // The line is written BEFORE the destruction, so it records a deletion that
    // was AUTHORISED AND BEGUN, not a completed one — and an audit record that
    // asserted a completion nobody observed would be the worst possible place
    // for a form that asserts a warrant.
    //
    // There is no "end" because there is nothing for it to report:
    // `unlinkCountingBytes` swallows every unlink error, so the delete loop
    // cannot fail part-way. The only interruption between this write and the
    // last unlink is process death, and a reader resolves that in one step —
    // THE RECORD FILE'S PRESENCE IS THE AUTHORITY: present ⇒ not deleted, absent
    // ⇒ deleted. A second write would be best-effort by construction
    // (everything is already destroyed; aborting is meaningless), reintroducing
    // exactly the unreliable-audit property this design exists to avoid.
    //
    // `phase` is a string, not a boolean, so "end" stays available additively if
    // a future lane ever measures a mid-loop failure mode that does not exist
    // today.
    phase: "begin",
    at: entry.at,
  };
  if (entry.agent != null) {
    line.agent = entry.agent;
  }
  // The ONE null in the schema, and it is a value rather than a gap: no acpx
  // session in the environment means a human at a terminal or a shell script.
  // dd4cb0e8 declared that caller permanently invisible; it is not invisible any
  // more. This identifies THAT it was not an acpx session, not WHO.
  line.invoker = process.env.ACPX_SESSION_URL ?? null;
  if (entry.scope !== undefined) {
    line.scope = entry.scope;
  }
  line.id = entry.id;
  if (entry.name != null) {
    line.name = entry.name;
  }
  line.cwd = entry.cwd;
  if (entry.createdAt != null) {
    line.createdAt = entry.createdAt;
  }
  if (entry.closedAt != null) {
    line.closedAt = entry.closedAt;
  }
  line.classes = entry.classes;
  return `${JSON.stringify(line)}\n`;
}
