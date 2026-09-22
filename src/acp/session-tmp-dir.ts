import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * `ACPX_SESSION_TMP` — a per-session scratch directory, one per `acpxRecordId`
 * (SPEC.md v2, brick 41e47c11 / ceca191f).
 *
 * ## ⚠️ WHY THE ROOT IS `/tmp` — A DELIBERATE CHOICE, TRADING AWAY CROSS-POD
 * ## VISIBILITY ON PURPOSE (v2; v1 rooted this in `/workspace` — see below)
 *
 * Three reasons, from SPEC.md's "Why `/tmp`":
 *
 *   1. **Self-cleaning.** `/tmp` is pod-local and wiped on pod restart, so a
 *      session's scratch directory cannot accumulate — that is the ENTIRE
 *      reason no reaper exists or is needed for this variable.
 *   2. **Room.** `/tmp` (overlay) has ~342 GB free on this box; `/workspace`
 *      (PVC) has 16 GB at 88% used. Scratch belongs on the roomy volume, not
 *      the tight permanent one.
 *   3. **Not shared with the workbench pod, and that is ACCEPTED, not a
 *      regression to work around.** `workbench-exec` forwards the whole
 *      environment, so the variable arrives on the workbench too — naming
 *      THAT pod's own `/tmp`, harmlessly: each pod gets its own scratch. An
 *      agent that genuinely needs a payload visible on both pods writes it
 *      under `/workspace` or the brick folder explicitly; that is a
 *      documented exception, not the default this variable provides.
 *
 * ⚠️ **DO NOT "FIX" THIS BACK TO `/workspace`.** That was v1's design, and it
 * is what CREATED the accumulation problem this variable's reaper was built to
 * solve — Daniel then measured the real footprint (0.27 GB across this box's
 * entire 6,844-session lifetime, against 16 GB free) and found the reaper was
 * solving a problem that did not exist at the cost it was built at. Moving
 * the root back to `/workspace` reintroduces that problem from nothing.
 *
 * `harness-config-dir-root.ts` is the sibling precedent for a per-session
 * directory root, and it ALSO defaults to `tmpdir()` (i.e. `/tmp`) for exactly
 * the reasons above — the two modules now agree, where v1 deliberately
 * diverged from that precedent for a cross-pod need this spec no longer asks
 * for.
 */
export const SESSION_TMP_DEFAULT_ROOT = "/tmp";

/** The prefix every `ACPX_SESSION_TMP` directory carries under `/tmp` — unlike
 *  v1's `/workspace/.tmp` root, which was acpx-only territory, `/tmp` is a
 *  generic, heavily-shared scratch space, so the directory name itself must
 *  self-identify to avoid colliding with (or being mistaken for) anything
 *  else living there. */
const SESSION_TMP_DIR_PREFIX = "acpx-";

/**
 * Test/operator override, mirroring `ACPX_HARNESS_CONFIG_DIR_ROOT`
 * (`harness-config-dir-root.ts`) — the only form that can scope a CHILD
 * process nobody edited, which is what the test suite needs.
 *
 * ⚠️ Deliberately NOT part of `ssh-remote`'s forwarded set, and never should
 * be — SPEC.md "Forwarding behaviour" is explicit that a scratch path from one
 * box names nothing meaningful on another.
 */
export const SESSION_TMP_ROOT_ENV = "ACPX_SESSION_TMP_ROOT";

/**
 * Resolve the root all session-tmp directories live under.
 *
 * Precedence: an explicit argument, then {@link SESSION_TMP_ROOT_ENV}, then the
 * real default. A blank/whitespace-only value at either level is treated as
 * ABSENT, not as the empty string — `join("", id)` would otherwise resolve to a
 * path relative to the process cwd.
 */
export function resolveSessionTmpRoot(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromArgument = explicit?.trim();
  if (fromArgument) {
    return fromArgument;
  }
  const fromEnv = env[SESSION_TMP_ROOT_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return SESSION_TMP_DEFAULT_ROOT;
}

/**
 * `<root>/acpx-<sessionId>` — the only place this path is composed, so a
 * future reader has no reason to duplicate it. No reaper exists or is needed
 * (SPEC.md v2): `/tmp` is pod-local and wiped on pod restart, which is the
 * entire cleanup mechanism.
 */
export function sessionTmpDirFor(sessionId: string, root: string): string {
  return join(root, `${SESSION_TMP_DIR_PREFIX}${sessionId}`);
}

/**
 * Create THIS session's scratch directory, mode `0700`, and return its path.
 *
 * ⚠️ BEST-EFFORT ON PURPOSE. A `mkdir` failure is reported to stderr rather
 * than thrown: failing session creation itself over a scratch directory would
 * be a strictly worse outcome than a session that starts without one.
 * `ACPX_SESSION_TMP` is still set to the intended path either way — a write
 * against a directory that never got created fails LOUDLY at the point of use
 * (ENOENT), which is the failure mode SPEC.md wants, not a silent fallback to
 * some other path.
 *
 * ⚠️ `chmodSync` AFTER `mkdirSync`, NOT `mode` ALONE — SPEC.md is explicit
 * about this ("set explicitly — mkdir's mode argument does not override an
 * inherited setgid bit"), and it is not a hypothetical: measured against a
 * REAL spawn under v1's `/workspace`-rooted design (which carried the setgid
 * bit, `2775`), `mkdirSync(dir, { mode: 0o700 })` alone produced `stat -c %a`
 * `2700`, not `700` — Linux directories INHERIT their parent's setgid bit on
 * creation regardless of the `mode` passed to `mkdir(2)`. `/tmp` on this box
 * is `1777` (no setgid) today, so the specific failure mode is not currently
 * reproducible here — but the code must not rely on that: a caller-supplied
 * `rootDir`, or a future box, can carry the same bit, and `chmodSync` (which
 * sets the mode exactly, clearing any inherited special bit) costs nothing to
 * keep unconditional.
 *
 * Idempotent and safe to call on every spawn of a resumed session: re-running
 * `chmod` on an already-0700 directory is a no-op, so this also self-heals a
 * directory whose mode drifted under a still-open session.
 */
export function ensureSessionTmpDir(
  sessionId: string,
  rootDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = sessionTmpDirFor(sessionId, resolveSessionTmpRoot(rootDir, env));
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch (error) {
    process.stderr.write(
      `[acpx] failed to create ACPX_SESSION_TMP directory ${dir}: ${String(error)}\n`,
    );
  }
  return dir;
}
