/**
 * The id -> filename encoding, isolated so both the archiver and the resolver use
 * the same one.
 *
 * ⚠️ MUST STAY IDENTICAL TO `sessionFilePath`'s `encodeURIComponent(acpxRecordId)`
 * in `persistence/repository.ts`. The archive keeps original filenames byte for
 * byte (formats §1 R1.1), so a divergence here does not produce a wrong path — it
 * produces a MISS: the record is in the archive under the name the repository
 * wrote, and the resolver looks for a name nobody ever created. That reads as
 * "this session was never archived", which is indistinguishable from a typo.
 */
export function encodeSessionSafeId(id: string): string {
  return encodeURIComponent(id);
}
