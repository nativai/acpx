import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Cross-cwd copies under the fixed session root (brick 45917618, CONCEPTION c53cbd97 §5.5 D6/D7).
 *
 * A copy of a legacy session runs at the session root, but the harness finds its SOURCE by the
 * cwd-keyed store: Claude reads `projects/<slug(cwd)>/<id>.jsonl`, pi-acp walks only the copy's own
 * `sessions/--<cwd>--/` dir. So the source transcript is STAGED under the destination's key before
 * the fork, and removed again afterwards — one staging scope around the whole fork.
 *
 * Two concurrent copies of one source would interleave stage/cleanup (the second cleanup restoring
 * the first's staged bytes leaves a stray copy behind), so every stage runs under an exclusive lock
 * file beside the staged path.
 */

/** A lock whose mtime is older than this belongs to a dead copy (the holder touches it). */
export const STAGE_LOCK_STALE_MS = 120_000;
const STAGE_LOCK_HEARTBEAT_MS = 20_000;
const STAGE_LOCK_POLL_MS = 250;
/** A waiter gives up after this long behind a LIVE holder. */
export const STAGE_LOCK_MAX_WAIT_MS = 15 * 60_000;

export type StageLockOptions = { staleMs?: number; maxWaitMs?: number; pollMs?: number };

export type StageLockHandle = {
  /** True when the lock was taken over from a dead holder — its staged file is a leftover. */
  tookOverStale: boolean;
};

export function stageLockPath(stagedPath: string): string {
  return `${stagedPath}.acpx-stage.lock`;
}

async function tryCreateLock(lockPath: string): Promise<boolean> {
  try {
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, token: randomUUID(), at: new Date().toISOString() })}\n`,
      { flag: "wx" },
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

/** Create the lock (`O_EXCL`), taking over a stale one; returns whether a stale one was taken. */
async function acquireStageLock(
  lockPath: string,
  staleMs: number,
  options: StageLockOptions,
): Promise<boolean> {
  const deadline = Date.now() + (options.maxWaitMs ?? STAGE_LOCK_MAX_WAIT_MS);
  let tookOverStale = false;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  while (!(await tryCreateLock(lockPath))) {
    if (await lockIsStale(lockPath, staleMs)) {
      await fs.rm(lockPath, { force: true });
      tookOverStale = true;
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for another copy of the same source session to finish (lock ${lockPath})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? STAGE_LOCK_POLL_MS));
  }
  return tookOverStale;
}

async function lockIsStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return false; // vanished meanwhile: just retry the create
  }
}

/**
 * Run `run` holding the exclusive stage lock for `stagedPath` (`O_EXCL` create). A stale lock (no
 * heartbeat for `staleMs`) is removed and taken over.
 */
export async function withStageLock<T>(
  stagedPath: string,
  run: (handle: StageLockHandle) => Promise<T>,
  options: StageLockOptions = {},
): Promise<T> {
  const lockPath = stageLockPath(stagedPath);
  const staleMs = options.staleMs ?? STAGE_LOCK_STALE_MS;
  const tookOverStale = await acquireStageLock(lockPath, staleMs, options);
  const heartbeat = setInterval(
    () => {
      const now = new Date();
      void fs.utimes(lockPath, now, now).catch(() => {});
    },
    Math.min(STAGE_LOCK_HEARTBEAT_MS, Math.max(1, Math.floor(staleMs / 4))),
  );
  heartbeat.unref();
  try {
    return await run({ tookOverStale });
  } finally {
    clearInterval(heartbeat);
    await fs.rm(lockPath, { force: true });
  }
}

/**
 * Copy `sourcePath` to `stagedPath` and return the cleanup. A file already at `stagedPath` is
 * PRESERVED (restored by the cleanup) unless the lock was taken over from a dead copy, in which case
 * it is that copy's leftover stage and the cleanup removes it.
 */
export async function stageFile(
  sourcePath: string,
  stagedPath: string,
  lock: StageLockHandle,
  transform: (content: Buffer) => Buffer = (content) => content,
): Promise<() => Promise<void>> {
  const content = transform(await fs.readFile(sourcePath));
  const existing = lock.tookOverStale ? undefined : await readOptional(stagedPath);
  await fs.mkdir(path.dirname(stagedPath), { recursive: true });
  await fs.writeFile(stagedPath, content);
  return async () => {
    if (existing === undefined) {
      await fs.rm(stagedPath, { force: true });
      return;
    }
    await fs.writeFile(stagedPath, existing);
  };
}

/**
 * A pi session JSONL whose `type:"session"` header (its FIRST line) names `cwd` — rewritten to the
 * copy's destination, every other byte kept (brick 45917618, CONCEPTION v1.5 §5.5 D7, HoD ruling).
 * pi-acp's fork copies that header verbatim, and pi refuses to start a session whose stored cwd is
 * gone ("Stored session working directory does not exist"), so without this a Pi copy at the root
 * would die as soon as the legacy folder is reaped. Applied ONLY to the staged copy — the source
 * file is never touched.
 *
 * A header pi-acp could not parse (`parseSessionHeader`: `type:"session"`, string `id` and `cwd`)
 * is refused with `undefined`: the caller never forks from an unrewritten header.
 */
export function rewritePiSessionHeaderCwd(content: Buffer, cwd: string): Buffer | undefined {
  const text = content.toString("utf8");
  const newline = text.indexOf("\n");
  const firstLine = newline === -1 ? text : text.slice(0, newline);
  const header = parsePiSessionHeader(firstLine);
  if (!header) {
    return undefined;
  }
  const rewritten = JSON.stringify({ ...header, cwd });
  return Buffer.from(newline === -1 ? rewritten : rewritten + text.slice(newline), "utf8");
}

/** pi-acp's `parseSessionHeader` shape: `type:"session"` with string `id` and `cwd`. */
function parsePiSessionHeader(line: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const header = value as Record<string, unknown>;
  const valid =
    header.type === "session" && typeof header.id === "string" && typeof header.cwd === "string";
  return valid ? header : undefined;
}

async function readOptional(filePath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
