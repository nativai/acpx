import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * `ACPX_SESSION_SHARED_TMP` — TIER 2 of the dev-box scratch model: a per-session
 * scratch directory that BOTH PODS SEE and that SURVIVES A POD RESTART
 * (brick f61391ac, SPEC.md §3 of brick 62cdfc3b).
 *
 * ## THE ONE THING THIS IS FOR, AND THE ONE REASON TO PREFER TIER 1
 *
 * A dev box is two pods — a control plane and a workbench — sharing exactly two
 * paths, `/workspace` and `/wisdom`. {@link import("./session-tmp-dir.js")}'s
 * `ACPX_SESSION_TMP` is rooted in `/tmp`, which is PER-POD: the variable is
 * forwarded into the workbench environment by `workbench-exec` while the
 * directory it names does not exist there, so the obvious move fails as a
 * missing file. This variable is the named home for the three cases that need
 * the other side to read the bytes: a payload the workbench must open, output
 * produced on the workbench and read here, and an isolated `HOME`/rig for a
 * gate run.
 *
 * **Prefer tier 1, and the reason IS the cleanup asymmetry.** `/tmp` self-cleans
 * on pod restart, which is why it needs no reaper at all. This tier has no such
 * mechanism and no reaper either, so NOTHING EVER RECLAIMS IT — whatever you
 * leave here stays until a human removes it, and it stays on the PVC, the box's
 * tight filesystem (192 GB with 46 GB free at 75% used — measured 2026-09-30; a
 * reading at a time, not a property of the volume). That is the whole trade:
 * tier 1 forgives what you forget and tier 2 does not. Reach for this one only
 * when the workbench must read the file, or it must outlive a pod restart — and
 * see the next section, which states the same thing as a rule.
 *
 * ## ⚠️ TEMPORARY SEMANTICS ARE IN THE NAME — AND NOTHING ENFORCES THEM
 *
 * `_TMP` is a promise the WRITER keeps, not one the system collects on: there
 * is deliberately **no reclaim mechanism** for this tier. Nothing sweeps it,
 * nothing expires it, and unlike tier 1 there is no pod restart to wipe it —
 * whatever you leave here stays until someone removes it. So treat it as
 * scratch by discipline: anything you will later cite is not scratch at all and
 * belongs in the brick folder (tier 3).
 *
 * ⚠️ **DO NOT ADD A REAPER FOR THIS. IT LOOKS LIKE THE OBVIOUS MISSING PIECE
 * AND IT HAS ALREADY BEEN DISCARDED TWICE.** v1 of tier 1 (brick ceca191f)
 * shipped this same kind of variable WITH a reaper; Daniel measured the real
 * footprint — 0.27 GB across the box's entire 6,844-session lifetime — and
 * removed it (7a89ec64) as a mechanism solving a problem that did not exist, at
 * the cost it was built at. The tier-2 design then re-introduced one, and it
 * was cut again before it shipped (2026-09-30, Daniel: *"we don't want to
 * implement any automatic cleanup no sweeping"*). **The default for scratch on
 * this fleet is NO reclaim mechanism until a MEASUREMENT demands one** — not a
 * well-designed reclaim mechanism. If accumulation here ever becomes real,
 * measure it first; the answer is a separate, deliberate decision, and the
 * measurement is the thing that licenses it.
 *
 * ## `SHARED` MEANS BETWEEN PODS — IT IS NOT AN ACCESS STATEMENT
 *
 * Every agent on a box runs as one uid, so "shared" could be misread as "other
 * agents may read this". It is not: the directory is mode `0700`, per-session,
 * keyed off `acpxRecordId`, and it inherits tier 1's collision immunity rather
 * than re-introducing the hazard brick 41e47c11 was opened for. Cross-AGENT
 * handoff is tier 3's job (the brick folder — durable, discoverable,
 * attributable). And like `/tmp`, this is NOT a secret store: one uid means
 * mode bits are not a boundary here — `shred -u` anything credential-bearing.
 */
export const SESSION_SHARED_TMP_DEFAULT_ROOT = "/workspace/.session-scratch";

/**
 * ⚠️ **NOT `/workspace/.scratch`, AND NOT BY ACCIDENT.** That path ALREADY
 * EXISTS on devbox (measured 2026-09-30: 284 MB, 6 entries dated Sep 5–13,
 * referenced nowhere in the Operating System) — itself an instance of the
 * hand-rolled scratch sprawl this tier exists to replace. Writing acpx's
 * per-session directories into someone else's hand-made directory would
 * entangle the two populations: this root is EXCLUSIVELY acpx-owned, so
 * everything in it is `acpx-<recordId>` and anything else is immediately
 * recognisable as not ours.
 *
 * ⚠️ **AND NOT `/workspace/.tmp`** — that was v1's `ACPX_SESSION_TMP` root.
 * Reusing the name invites exactly the tier-1/tier-2 confusion the three-tier
 * model exists to remove.
 *
 * ⚠️ **AND NOT `/workspace/projects/temp/`** — that path sits inside the
 * *projects* namespace and holds LIVE GIT WORKTREES, so anything operating over
 * it in bulk would be operating on branches' working directories. It stays what
 * it is: a human/task-named throwaway area, outside this model.
 *
 * Hidden (leading dot) because the `/workspace` root listing is already ~2,488
 * entries; the fix must not add a 2,489th visible one. Discoverability comes
 * from the environment variable and the primer, exactly as it does for tier 1.
 */
const SESSION_SHARED_TMP_DIR_PREFIX = "acpx-";

/**
 * Test/operator override, mirroring `ACPX_SESSION_TMP_ROOT` and
 * `ACPX_HARNESS_CONFIG_DIR_ROOT` — the only form that can scope a CHILD process
 * nobody edited, which is what the test suite needs.
 *
 * Scoping matters MORE here than for tier 1: the real default is on the PVC and
 * nothing reclaims it, so an unscoped suite run would strew synthetic-recordId
 * debris across the box's real scratch root and leave it there indefinitely.
 * `test/session-shared-tmp-test-root.ts` pins it from the `--import` preload,
 * by construction rather than per-row opt-in.
 *
 * ⚠️ Deliberately NOT part of `ssh-remote`'s forwarded set, and never should be
 * — a scratch path from one box names nothing meaningful on another, identical
 * to tier 1.
 */
export const SESSION_SHARED_TMP_ROOT_ENV = "ACPX_SESSION_SHARED_TMP_ROOT";

/**
 * Resolve the root all shared-session-tmp directories live under.
 *
 * Precedence: an explicit argument, then {@link SESSION_SHARED_TMP_ROOT_ENV},
 * then the real default. A blank/whitespace-only value at either level is
 * treated as ABSENT, not as the empty string — `join("", id)` would otherwise
 * resolve to a path relative to the process cwd, i.e. a scratch directory
 * wherever the CLI happened to be invoked from. Nothing would error: the
 * session would simply write its scratch into some unrelated working
 * directory, and the agent looking for it under the documented root would find
 * an empty one.
 */
export function resolveSessionSharedTmpRoot(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromArgument = explicit?.trim();
  if (fromArgument) {
    return fromArgument;
  }
  const fromEnv = env[SESSION_SHARED_TMP_ROOT_ENV]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return SESSION_SHARED_TMP_DEFAULT_ROOT;
}

/**
 * `<root>/acpx-<sessionId>` — the only place this path is composed, so a future
 * reader has no reason to re-type it.
 *
 * The `acpx-` prefix makes every entry in the root self-identifying: the root
 * is acpx-owned, so anything there NOT matching `acpx-*` did not come from
 * here.
 */
export function sessionSharedTmpDirFor(sessionId: string, root: string): string {
  return join(root, `${SESSION_SHARED_TMP_DIR_PREFIX}${sessionId}`);
}

/**
 * Create THIS session's shared scratch directory, mode `0700`, and return its
 * path.
 *
 * ⚠️ **`chmodSync` AFTER `mkdirSync` IS LOAD-BEARING HERE IN A WAY IT IS NOT FOR
 * TIER 1 — THIS ROOT'S PARENT CARRIES THE SETGID BIT TODAY.** `/workspace` is
 * `drwxrwsr-x` (`2775`, measured 2026-09-30), and Linux directories INHERIT a
 * parent's setgid bit on creation REGARDLESS of the `mode` passed to
 * `mkdir(2)`. This is not hypothetical and not borrowed reasoning: v1 of the
 * tier-1 work was `/workspace`-rooted and measured exactly this against a real
 * spawn — `mkdirSync(dir, { mode: 0o700 })` alone produced `stat -c %a` `2700`,
 * not `700`. Tier 1's own comment notes that `/tmp` does not carry the bit, so
 * the failure is not reproducible at ITS root; for THIS root it is the live
 * case, and the `chmod` — which sets the mode exactly, clearing any inherited
 * special bit — is the only thing making the published `0700` guarantee true.
 * `test/session-shared-tmp-dir.test.ts` carries the setgid-parent row as a
 * permanent negative case, because a guarantee stated only in a comment has no
 * adversary.
 *
 * ⚠️ BEST-EFFORT ON PURPOSE. A `mkdir` failure is reported to stderr rather than
 * thrown: failing session creation itself over a scratch directory would be a
 * strictly worse outcome than a session that starts without one — and this root
 * is on the PVC, which can genuinely be full. `ACPX_SESSION_SHARED_TMP` is still
 * set to the intended path either way, so a write against a directory that never
 * got created fails LOUDLY at the point of use (ENOENT) rather than silently
 * landing somewhere else.
 *
 * Idempotent and safe to call on every spawn of a resumed session: re-running
 * `chmod` on an already-0700 directory is a no-op, so this also self-heals a
 * directory whose mode drifted under a still-open session — which matters more
 * here than for tier 1, since this directory outlives pod restarts and can
 * therefore be much older than the process looking at it.
 */
export function ensureSessionSharedTmpDir(
  sessionId: string,
  rootDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = sessionSharedTmpDirFor(sessionId, resolveSessionSharedTmpRoot(rootDir, env));
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch (error) {
    process.stderr.write(
      `[acpx] failed to create ACPX_SESSION_SHARED_TMP directory ${dir}: ${String(error)}\n`,
    );
  }
  return dir;
}
