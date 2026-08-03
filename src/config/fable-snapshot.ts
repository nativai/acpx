import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The persisted per-account Fable-share snapshot (brick://1badc6f1). Replaces the
// per-process in-memory fable cache, which died with every CLI invocation, so a
// reading survives across the CLI, the acpx-ui server and every __queue-owner on
// the box.
//
// ONE FILE PER ACCOUNT — never a single account MAP. That is what makes the
// lock-free tmp+rename genuinely atomic here: two processes probing DIFFERENT
// accounts own disjoint files and cannot clobber each other. A shared map would
// lose the losing writer's key on every concurrent rename, and the field that
// hurts most is `lastProbeAttemptAt` — the burst-collapse guard, whose whole
// point is the N-simultaneous-askers case.

/** One account's persisted Fable-share reading. Every field is optional: a file
 *  may hold only an attempt stamp (written BEFORE the probe) or only a real-turn
 *  exhaustion stamp. */
export type FableSnapshot = {
  /** ISO of the last SUCCESSFUL reading — freshness is measured from THIS, never
   *  from an attempt or an exhaustion stamp. */
  fetchedAt?: string;
  /** The last reading's availability (200 ⇒ true; clean 429 ⇒ false). */
  available?: boolean;
  /** Real Fable weekly utilization [0,1] from anthropic-ratelimit-unified-7d_oi-utilization. */
  utilization?: number | null;
  /** Raw …-7d_oi-status ("allowed", …). Carried as DATA only — it never flips
   *  `available` (see subscription-usage.ts probeFableAvailability). */
  status?: string | null;
  /** ISO reset from …-7d_oi-reset (equals the account's weekly 7d reset). */
  resetsAt?: string | null;
  /** ISO stamped BEFORE the probe request is issued. Written first — not with the
   *  result — so N simultaneous askers collapse to one outbound probe instead of
   *  all reading "no recent attempt" during the 10s request window. */
  lastProbeAttemptAt?: string;
  /** ISO of the last REAL-TURN Fable-share exhaustion (FableShareExhaustedError).
   *  Authoritative for a short TTL and deliberately does NOT advance `fetchedAt`,
   *  so it can never become a box-wide sticky false negative. */
  exhaustedStampAt?: string;
};

const SNAPSHOT_SUBPATH = [".acpx", "usage", "fable"] as const;

function snapshotDirForHome(homeDir: string): string {
  return path.join(homeDir, ...SNAPSHOT_SUBPATH);
}

/** The REAL home, read from the password database — deliberately NOT os.homedir()
 *  / $HOME, which a test can (and should) redirect. Undefined when unreadable. */
function realHomeDir(): string | undefined {
  try {
    return os.userInfo().homedir;
  } catch {
    return undefined;
  }
}

// Refuse to touch the live snapshot store from a test run. Without this, every
// `pnpm test` would write fixture values (a synthetic `available:false`, say)
// into /home/node/.acpx/usage/fable — which live agents then read. Same class as
// acpx-ui's brick-DB real-home guard. NODE_TEST_CONTEXT is set by `node --test`
// in every test child process.
function assertNotRealHomeUnderTest(dir: string): void {
  if (process.env.NODE_TEST_CONTEXT === undefined) {
    return;
  }
  const realHome = realHomeDir();
  if (realHome === undefined || path.resolve(dir) !== path.resolve(snapshotDirForHome(realHome))) {
    return;
  }
  throw new Error(
    "refusing to use the real-home Fable snapshot store under test — set " +
      "ACPX_FABLE_SNAPSHOT_DIR (or an isolated HOME) in this suite",
  );
}

/** Directory holding the per-account snapshot files. `ACPX_FABLE_SNAPSHOT_DIR`
 *  overrides it (test isolation); otherwise ~/.acpx/usage/fable. Throws under
 *  test when it would resolve to the real home store. */
export function fableSnapshotDir(): string {
  const override = process.env.ACPX_FABLE_SNAPSHOT_DIR?.trim();
  const dir = override ? override : snapshotDirForHome(process.env.ACPX_STATE_HOME || os.homedir());
  assertNotRealHomeUnderTest(dir);
  return dir;
}

function snapshotFilePath(account: string): string {
  return path.join(fableSnapshotDir(), `${encodeURIComponent(account)}.json`);
}

function asSnapshot(value: unknown): FableSnapshot | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as FableSnapshot)
    : undefined;
}

/** This account's snapshot, or undefined when absent/unreadable/malformed. Never
 *  rejects for I/O reasons — a missing snapshot simply reads as stale. */
export async function readFableSnapshot(account: string): Promise<FableSnapshot | undefined> {
  const file = snapshotFilePath(account);
  try {
    return asSnapshot(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * Merge `patch` into this account's snapshot and rewrite it atomically
 * (tmp + rename). Read-modify-write is safe without a lock because the file is
 * owned by exactly one account, so the only racers are writers of the SAME
 * account — for whom last-write-wins is the correct outcome.
 *
 * Best-effort: an I/O failure is swallowed. A snapshot write must never break a
 * turn; the worst case is one extra probe on the next read.
 */
export async function patchFableSnapshot(account: string, patch: FableSnapshot): Promise<void> {
  const file = snapshotFilePath(account);
  const next = { ...(await readFableSnapshot(account)), ...patch };
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, `${JSON.stringify(next)}\n`, "utf8");
    await fs.rename(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}
