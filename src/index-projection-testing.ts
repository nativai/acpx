/**
 * TEST-ONLY: hold the session index lock (`index.json.lock`) from another process. For the atrium server's
 * tests of its index-projection row "another acpx process holds `index.json.lock` for more than 20 s" (brick
 * e17c571e): the lock is held by the real primitive, exactly as an owner's write holds it, so the row's
 * instrument cannot go stale when the projection changes (its old instrument — a FIFO named in a projection batch —
 * stopped holding the lock when the batch learned to skip non-regular files, brick d67ad597).
 *
 * ⚠️ NOT PART OF THE PRODUCTION SURFACE. `index-projection.ts` stays at its seven names and never imports this
 * file (`test/index-projection-testing.test.ts` holds both). It is built as its own entry
 * (`dist/index-projection-testing.js`) so another repo's test can import it; nothing in acpx's runtime does.
 */
import { withSessionIndexLock } from "./session/persistence/index-lock.js";

export { withSessionIndexLock };

/**
 * Take `index.json.lock` of `sessionDir` and hold it for `ms` milliseconds, then release it. The lock file then
 * names THIS process (`pid`) as the holder, like any holder. `onHeld` runs once the lock is taken — a test's
 * signal that the lock really is held (print a line, resolve a promise) before it starts the contender.
 */
export async function holdSessionIndexLock(
  sessionDir: string,
  ms: number,
  onHeld?: () => void,
): Promise<void> {
  await withSessionIndexLock(sessionDir, async () => {
    onHeld?.();
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  });
}
