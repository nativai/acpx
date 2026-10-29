import fs from "node:fs/promises";
import path from "node:path";
import {
  decodeArchiveZst,
  isArchivedFileCorrupt,
  logicalNameOf,
  resolveArchivedFile,
  sha256Hex,
  zstNameFor,
} from "./compressed.js";
import type { CompressionJournalRow } from "./compression-journal.js";
import { claimArchiveFileSets } from "./identity.js";

/**
 * Reconcile LONE `begin` rows (TE, AC-6/AC-9, 2026-10-29). A crash between the write-ahead
 * `begin` and the row that closes it leaves the journal without a resolution — after a
 * crash at step 9 a file is compressed on disk with NO `compress` row, so it is missing
 * from the audit trail and from that wave's `--manifest-out`.
 *
 * Every sweep therefore closes each lone `begin` BEFORE it selects new work, from the
 * on-disk state alone (the footer is self-contained, so nothing else is needed):
 *
 * | on disk                      | row written                                              |
 * |------------------------------|----------------------------------------------------------|
 * | `.zst` verifies, plain gone  | `compress` (verified=1, sizes + hashes, `recovered: …`)  |
 * | `.zst` corrupt, plain gone   | `fail` (`recovered: … corrupt`) — the file is left as is |
 * | plain, no `.zst`             | `abort` (`recovered: … plain untouched`)                 |
 * | both forms                   | the sweep's own resolve-both / quarantine row            |
 * | neither (restored meanwhile) | `abort` (`recovered: … no longer in the archive`)        |
 *
 * No new journal action: the row set of amendment §H.6 is unchanged; `recovered:` in
 * `detail` marks a row written on behalf of an earlier, interrupted wave.
 */

/** A row that closes the `begin`s before it, for the same file. */
const RESOLVING_ACTIONS: ReadonlySet<string> = new Set([
  "compress",
  "skip",
  "abort",
  "fail",
  "resolve-both",
  "quarantine",
  "decompress",
]);

/**
 * file → number of `begin` rows not followed by a resolving row for that file. Several
 * consecutive `begin`s (an older build re-ran without reconciling) all count, and one
 * resolution row closes them all.
 */
export function findLoneBegins(rows: readonly CompressionJournalRow[]): Map<string, number> {
  const open = new Map<string, number>();
  for (const row of rows) {
    if (row.action === "begin") {
      open.set(row.file, (open.get(row.file) ?? 0) + 1);
    } else if (RESOLVING_ACTIONS.has(row.action)) {
      open.delete(row.file);
    }
  }
  return open;
}

export type ReconcileAction = "compress" | "abort" | "fail" | "resolve-both";

export type ReconcilePlan = {
  file: string;
  /** The archive id (safe form) the file belongs to, when it is still claimed. */
  safeId?: string;
  action: ReconcileAction;
  detail: string;
  logicalBytes?: number;
  logicalSha256?: string;
  zstBytes?: number;
  zstSha256?: string;
};

function begins(count: number): string {
  return count === 1 ? "1 begin" : `${count} begins`;
}

async function readIfPresent(target: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** `.zst` alone: verified ⇒ the `compress` row the crash never wrote; corrupt ⇒ `fail`. */
function planCommitted(
  file: string,
  zst: Buffer,
  zstPath: string,
  head: string,
): Omit<ReconcilePlan, "safeId"> {
  try {
    const logical = decodeArchiveZst(zst, zstPath);
    return {
      file,
      action: "compress",
      detail: `${head}; committed before the crash`,
      logicalBytes: logical.length,
      logicalSha256: sha256Hex(logical),
      zstBytes: zst.length,
      zstSha256: sha256Hex(zst),
    };
  } catch (error) {
    if (!isArchivedFileCorrupt(error)) {
      throw error;
    }
    return {
      file,
      action: "fail",
      detail: `${head}; .zst corrupt (${error.check}), no plain — left in place`,
    };
  }
}

async function planOne(
  archiveDir: string,
  file: string,
  count: number,
): Promise<Omit<ReconcilePlan, "safeId">> {
  const head = `recovered: resolves ${begins(count)} of an interrupted wave`;
  const plain = (await resolveArchivedFile(archiveDir, file)).form === "plain";
  const zstPath = path.join(archiveDir, zstNameFor(file));
  const zst = await readIfPresent(zstPath);
  if (plain) {
    return zst
      ? { file, action: "resolve-both", detail: `${head}; both forms` }
      : { file, action: "abort", detail: `${head}; no commit — plain untouched` };
  }
  if (!zst) {
    return {
      file,
      action: "abort",
      detail: `${head}; the file is no longer in the archive (restored)`,
    };
  }
  return planCommitted(file, zst, zstPath, head);
}

/** One plan per lone `begin`, read from disk; writes nothing (the dry run reports it as-is). */
export async function planReconcile(
  archiveDir: string,
  rows: readonly CompressionJournalRow[],
): Promise<ReconcilePlan[]> {
  const lone = findLoneBegins(rows);
  if (lone.size === 0) {
    return [];
  }
  const owners = new Map<string, string>();
  for (const [safeId, files] of claimArchiveFileSets(await fs.readdir(archiveDir))) {
    for (const file of files) {
      owners.set(logicalNameOf(file), safeId);
    }
  }
  const plans: ReconcilePlan[] = [];
  for (const [file, count] of [...lone].toSorted(([a], [b]) => a.localeCompare(b))) {
    plans.push({ ...(await planOne(archiveDir, file, count)), safeId: owners.get(file) });
  }
  return plans;
}
