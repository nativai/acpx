/**
 * acpx's lock module for the atrium server (block S4, brick 8d85cb47) — loaded IN-PROCESS the way
 * atrium loads the spawn ledger: `acpx __pod-lock-module` prints this file's URL, atrium imports it
 * and checks POD_LOCK_API_VERSION. The agreed surface (atrium stream, 2026-11-21):
 * /wisdom/Bricks/8d85cb47-604b-4d0f-9b79-b010bcedfb2d/reports/EXPORT-lock-module.md — change it only
 * with both stream sub-HoDs, and raise the version.
 *
 * 🛑 NO SQLITE, NO HEAVY IMPORT, ANYWHERE IN THIS FILE'S GRAPH: atrium loads it on any path.
 * `test/pod-lock-module.test.ts` walks the BUILT graph and loads it in a fresh process.
 */

export const POD_LOCK_API_VERSION = 1 as const;

export {
  withRecordFileLock,
  updateRecordFile,
  RECORD_LOCK_BUDGET_MS,
  isRecordLockTimeout,
  isRecordLockLost,
} from "./session/persistence/record-file-lock.js";
export { type HeldLock } from "./session/persistence/identity-file-lock.js";
export { proveDeath, DEATH_PROOF_TIMEOUT_MS, type DeathProof } from "./pod/death-proof.js";
export { ownPodIdentity, type PodIdentity, type PodRef } from "./pod/identity.js";
export {
  sweepOwnPodLocks,
  type PodLockSweepResult,
} from "./session/persistence/identity-file-lock.js";
