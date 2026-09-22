import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * `ACPX_SESSION_TMP` — a per-session scratch directory, one per `acpxRecordId`
 * (SPEC.md, brick 41e47c11 / ceca191f).
 *
 * ## ⚠️ WHY THE ROOT IS `/workspace`, NEVER `os.tmpdir()`
 *
 * A dev box is two pods sharing exactly `/workspace` (and `/wisdom`) at the same
 * path — `/tmp` is per-pod. `workbench-exec` forwards the spawning process's
 * WHOLE environment to the workbench, so a `/tmp`-rooted value would arrive
 * there naming a directory that pod never wrote to: the agent's own file
 * invisible, a read silently creating an empty one. Rooting in `/workspace`
 * makes that forwarding correct instead of merely harmless — same path, same
 * file, both pods. It also means the directory survives a control-plane pod
 * restart for free, since `/workspace` is PVC-backed.
 *
 * `harness-config-dir-root.ts` is the sibling precedent for a per-session
 * directory root, and it deliberately falls back to `tmpdir()` — that is
 * correct THERE because that root need not be cross-pod. It is exactly the
 * wrong default here, which is why this module does not reuse that one.
 */
export const SESSION_TMP_DEFAULT_ROOT = "/workspace/.tmp";

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

/** `<root>/<sessionId>` — the only place this path is composed, shared by the
 *  writer here and the reaper in `session-tmp-sweep.ts`, so they cannot disagree. */
export function sessionTmpDirFor(sessionId: string, root: string): string {
  return join(root, sessionId);
}

/**
 * Create THIS session's scratch directory, mode `0700`, and return its path.
 *
 * ⚠️ BEST-EFFORT ON PURPOSE. A `mkdir` failure (disk full — `/workspace` runs at
 * 88%, which is the whole reason a reaper ships with this feature) is reported
 * to stderr rather than thrown: failing session creation itself over a scratch
 * directory would be a strictly worse outcome than a session that starts
 * without one. `ACPX_SESSION_TMP` is still set to the intended path either
 * way — a write against a directory that never got created fails LOUDLY at the
 * point of use (ENOENT), which is the failure mode SPEC.md wants, not a silent
 * fallback to `/tmp`.
 *
 * ⚠️ `chmodSync` AFTER `mkdirSync`, NOT `mode` ALONE — measured against a REAL
 * spawn on devbox, not assumed. `/workspace` carries the setgid bit (`2775`),
 * and Linux directories INHERIT their parent's setgid bit on creation
 * regardless of the `mode` passed to `mkdir(2)` — `mkdirSync(dir, { mode:
 * 0o700 })` under such a parent produced `stat -c %a` `2700`, not `700`
 * (acceptance criterion 1 is the literal `%a` value). The setgid bit does not
 * by itself widen access — group permission bits are still 0 — but the
 * criterion is exact, so an explicit `chmodSync(dir, 0o700)` (which sets the
 * mode exactly, clearing any inherited special bits) is not belt-and-braces
 * here, it is the fix for a real, measured mismatch.
 *
 * Idempotent and safe to call on every spawn of a resumed session: re-running
 * `chmod` on an already-0700 directory is a no-op, so this also self-heals a
 * directory whose mode drifted (or whose parent's setgid got re-inherited by
 * some other means) under a still-open session.
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
