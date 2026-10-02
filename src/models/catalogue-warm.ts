/**
 * The never-awaited catalogue warm (brick://7a2d5c60, part of brick://6e66cbc1).
 *
 * ⚠️ THE DEFECT THIS EXISTS FOR: `/home/node/.acpx/models-cache.json` DOES NOT
 * EXIST on a box nobody has run `acpx models` on. `validateModelSelectionFromCache`
 * loads the catalogue `offline`, and with a cold cache
 * `validateModelSelection` stands aside entirely — so **phase 1's `--model`
 * validation was a no-op in production** while passing its whole gate, because
 * that gate measured the error shapes against a WARM cache in an isolated store.
 * MEASURED 2026-09-04, brick://db554b05 `reports/MEASUREMENT.md`.
 *
 * ⚠️ AND THE FIX MUST NOT BECOME A WORSE DEFECT THAN THE BUG. C4 §7.1 stands:
 * **no session create may ever block on a third-party fetch.** A warm that awaits
 * turns a silent no-op into a visible latency regression on every first create —
 * and OpenRouter being slow or unreachable would then delay, or fail, a create
 * that has nothing to do with it.
 *
 * Two things make "never awaited" true by CONSTRUCTION rather than by care:
 *
 *  1. **This function returns `void`, not a promise.** There is no handle to
 *     await, so a caller cannot await it even by mistake, and a future edit that
 *     wants to would have to change the signature — which is a visible act.
 *  2. **The work runs in a DETACHED, `unref()`d CHILD PROCESS**, not in this
 *     one. An in-process `fetch()` would be the obvious implementation and it is
 *     wrong in both directions: its pending socket keeps the event loop alive, so
 *     the CLI lingers on every create (the latency regression above), and if
 *     anything calls `process.exit()` first the fetch dies mid-flight — so the
 *     cache never lands and the SECOND create still would not validate, which is
 *     the acceptance criterion. Detached + `unref()` is the one shape where the
 *     parent exits immediately AND the refresh still completes.
 *
 * The child is the ordinary `acpx models` load path (`--warm`: "refresh what is
 * stale"), so there is no second fetch-and-write implementation to drift from the
 * first.
 *
 * brick ebfe4c3c added a THIRD cache the child fills: the Claude adapter's model
 * advertisement (`claude-advertisement.ts`), re-probed once per deployed adapter
 * version. The warm is the ONLY automatic place that probe runs — which is how
 * "at most one probe per deploy, never per session" holds while no create ever
 * waits on it.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAdvertisementNeedsProbe } from "./claude-advertisement.js";
import { CATALOGUE_TTL_MS, defaultCatalogueCachePath } from "./openrouter-catalogue.js";
import { defaultEntitlementCachePath, ENTITLEMENT_TTL_MS } from "./openrouter-entitlement.js";

/**
 * How long a warm attempt suppresses the next one. Without it, N concurrent
 * creates on a shared box each spawn their own refresh of the same list — this
 * box routinely runs a dozen agents at once. The sentinel is best-effort by
 * design: losing the race costs a redundant fetch, never a wrong catalogue.
 */
export const WARM_ATTEMPT_COOLDOWN_MS = 60_000;

/** Set to any non-empty value to disable the warm entirely (tests, air-gapped boxes). */
const DISABLE_ENV = "ACPX_NO_CATALOGUE_WARM";

export interface WarmDeps {
  spawn?: (command: string, args: string[], options: object) => ChildProcess;
  now?: () => number;
  cachePath?: string;
  /** The key's allowed-model set (brick ecfb0461) — the second cache the warm fills. */
  entitlementCachePath?: string;
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** The Claude model-advertisement cache (brick ebfe4c3c) — the third cache the warm fills. */
  claudeAdvertCachePath?: string;
  /** Where the deployed adapter's version is read (`ACPX_RUNTIME_INFO_PATH`). */
  runtimeInfoPath?: string;
  /**
   * `"all"` (default, the create path): any of the three caches decides.
   * `"claude-advertisement"` (the `acpx models` read verbs): ONLY the advertisement
   * term decides, so OpenRouter's warm behaviour is unchanged by those kicks.
   */
  scope?: WarmScope;
}

export type WarmScope = "all" | "claude-advertisement";

function sentinelPathFor(cachePath: string): string {
  return `${cachePath}.warming`;
}

/**
 * Whether a refresh is worth attempting: the cache is missing outright, or its
 * own `fetchedAt` is older than the TTL the normal read path already uses.
 *
 * Reads the file's CONTENT and never the network — and deliberately not its
 * mtime, for the same one-clock reason `warmedRecently` explains below.
 */
export function catalogueNeedsWarm(deps: WarmDeps = {}): boolean {
  const now = (deps.now ?? Date.now)();
  // ⚠️ TWO CACHES, EITHER ONE STALE IS ENOUGH (brick ecfb0461). The refresh child
  // is a single `acpx models --refresh`, which rewrites both — so asking only
  // about the catalogue would leave the ONE state that most needs warming
  // unwarmed: a fresh catalogue beside a cold allowed-model set, which is exactly
  // what a box looks like the first time this ships. The entitlement cache then
  // never fills, `assertModelPolicy` fails open forever, and nothing anywhere
  // reports a problem — the silent no-op this module was written to end, in a new
  // costume.
  //
  // ⚠️ THE THIRD TERM IS FILE READS ONLY (the advertisement cache, info.json, the
  // SDK's package.json) — no socket, no child — because this predicate runs on the
  // session-create path. The probe itself only ever runs in the detached child.
  const claudeTerm = () =>
    claudeAdvertisementNeedsProbe({
      cachePath: deps.claudeAdvertCachePath,
      runtimeInfoPath: deps.runtimeInfoPath,
      env: deps.env,
      now: () => now,
    });
  if (deps.scope === "claude-advertisement") {
    return claudeTerm();
  }
  return (
    cacheOlderThan(deps.cachePath ?? defaultCatalogueCachePath(deps.env), CATALOGUE_TTL_MS, now) ||
    cacheOlderThan(
      deps.entitlementCachePath ?? defaultEntitlementCachePath(deps.env),
      ENTITLEMENT_TTL_MS,
      now,
    ) ||
    claudeTerm()
  );
}

/** Missing, unparseable, undated or past its TTL — all "worth refreshing". */
function cacheOlderThan(cachePath: string, ttlMs: number, now: number): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch {
    return true; // cold — the case that made validation a no-op
  }
  try {
    const parsed = JSON.parse(raw) as { fetchedAt?: string };
    const fetchedAt = parsed.fetchedAt === undefined ? Number.NaN : Date.parse(parsed.fetchedAt);
    if (!Number.isFinite(fetchedAt)) {
      return true;
    }
    return now - fetchedAt > ttlMs;
  } catch {
    return true; // unparseable is as good as absent
  }
}

/**
 * True when a warm was attempted recently enough that another would be waste.
 *
 * ⚠️ THE TIMESTAMP IS THE SENTINEL'S CONTENT, NOT ITS mtime. Reading `mtimeMs`
 * is the obvious implementation and it puts a SECOND CLOCK in a decision the
 * caller's `now` is supposed to own — which makes the cooldown untestable
 * (a test's injected `now` is compared against a real wall-clock mtime) and,
 * worse, silently wrong wherever the two disagree. One clock decides.
 *
 * The window is bounded at BOTH ends on purpose: a negative delta means the
 * sentinel is stamped in the future (a clock step, or a file copied in), and
 * treating that as "recent" would suppress every warm indefinitely — the failure
 * mode that turns a cost optimisation into the original bug.
 */
function warmedRecently(cachePath: string, now: number): boolean {
  try {
    const stamped = Number.parseInt(fs.readFileSync(sentinelPathFor(cachePath), "utf8").trim(), 10);
    if (!Number.isFinite(stamped)) {
      return false;
    }
    const elapsed = now - stamped;
    return elapsed >= 0 && elapsed < WARM_ATTEMPT_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markWarmAttempt(cachePath: string, now: number): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(sentinelPathFor(cachePath), String(now));
  } catch {
    // Best-effort. A sentinel we could not write costs a redundant fetch later,
    // which is strictly better than failing a create over it.
  }
}

/**
 * 🛑 THE ENTRY WE ARE ABOUT TO RE-INVOKE MUST ACTUALLY BE acpx's CLI. `process.argv[1]`
 * IS NOT ALWAYS acpx — AND ASSUMING IT WAS COST A RED GATE (116 failures).
 *
 * MEASURED 2026-09-05: inside a `node --test` worker `process.argv[1]` is **the
 * TEST FILE**, not the CLI. So the first version of this module spawned
 * `node <some>.test.js models --refresh --format json` — RE-RUNNING AN ENTIRE
 * TEST FILE as a detached child, inheriting the parent's env including its
 * scratch `ACPX_STATE_HOME`. Under the full parallel suite that is dozens of
 * duplicate test processes racing the real ones over the same scratch stores:
 * the suite's own guard fired ("test attempted to touch the acpx session store
 * with ACPX_STATE_HOME outside the temp dir"), plus 'session not found',
 * timeouts and missing rejections across 12 files. It did NOT reproduce when a
 * file was run alone, which is why only the full gate caught it.
 *
 * The unit tests could not catch it either, because they INJECT `argv` — the
 * harness supplying what the real run does not (verification-soundness §7).
 * `test/models-catalogue-warm.test.ts` now passes a realistic `.test.js` path
 * and asserts NOTHING is spawned.
 *
 * ⚠️ Failing CLOSED is free here and failing open is not: a warm that does not
 * happen costs one unvalidated create, which is exactly the pre-existing
 * behaviour. A wrong process spawned costs a corrupted test run — or, in the
 * field, an arbitrary program re-invoked with `models --refresh` appended.
 *
 * ⚠️ AND THE CHECK MUST RUN ON THE RESOLVED PATH, NOT ON `argv[1]` AS WRITTEN —
 * getting that backwards disables the warm on the ONE build where it matters.
 * MEASURED on this box: the installed bin is a SYMLINK,
 * `/usr/local/bin/acpx → ../lib/node_modules/acpx/dist/cli.js`, so a real
 * `acpx …` invocation has `argv[1]` basename **`acpx`** and only its realpath is
 * `cli.js`. A raw-basename test would fail closed on the deployed CLI and pass
 * only in a source worktree — silently reinstating the cold-cache no-op in
 * production, which is the exact bug this module exists to fix.
 *
 * Returns the resolved entry to spawn, or `null` when this process is not acpx.
 */
function resolveAcpxCliEntry(entry: string | undefined): string | null {
  if (entry === undefined || entry.trim() === "") {
    return null;
  }
  let resolved: string;
  try {
    resolved = realpathSync(entry.trim());
  } catch {
    return null;
  }
  return path.basename(resolved) === "cli.js" ? resolved : null;
}

/**
 * Every reason NOT to warm, in one place — it returns the resolved CLI entry to
 * spawn, or null. None of these ever throws: a create must not fail over the
 * decision not to refresh a list.
 */
function resolveWarmTarget(params: {
  env: NodeJS.ProcessEnv;
  cachePath: string;
  now: number;
  entry: string | undefined;
  deps: WarmDeps;
}): string | null {
  if (params.env[DISABLE_ENV]) {
    return null;
  }
  // Not acpx, or no self-entry to re-invoke — nothing to do, nothing to report.
  const cliEntry = resolveAcpxCliEntry(params.entry);
  if (cliEntry === null) {
    return null;
  }
  if (!catalogueNeedsWarm({ ...params.deps, cachePath: params.cachePath, now: () => params.now })) {
    return null;
  }
  return warmedRecently(params.cachePath, params.now) ? null : cliEntry;
}

/**
 * Kick off a catalogue refresh and RETURN IMMEDIATELY.
 *
 * ⚠️ Returns `void` deliberately — see the header. Every failure mode here is
 * swallowed: a create must not fail, warn, or slow down because a refresh could
 * not be started.
 */
export function warmCatalogueInBackground(deps: WarmDeps = {}): void {
  const env = deps.env ?? process.env;
  const cachePath = deps.cachePath ?? defaultCatalogueCachePath();
  const now = (deps.now ?? Date.now)();
  const entry = (deps.argv ?? process.argv)[1];
  const cliEntry = resolveWarmTarget({ env, cachePath, now, entry, deps });
  if (cliEntry === null) {
    return;
  }
  markWarmAttempt(cachePath, now);
  detachRefreshChild(deps.spawn ?? nodeSpawn, cliEntry, env);
}

/**
 * The spawn itself, isolated so the decision above stays readable.
 *
 * The options are the queue owner's idiom, not a new one — see
 * `buildQueueOwnerSpawnOptions` in `src/cli/session/queue-owner-process.ts`,
 * which spawns `detached: true` with `stdio: "ignore"` and a `safeCwd()` for the
 * same reasons.
 */
function detachRefreshChild(
  spawnFn: NonNullable<WarmDeps["spawn"]>,
  entry: string,
  env: NodeJS.ProcessEnv,
): void {
  try {
    // ⚠️ `--warm`, NOT `--refresh` (brick ebfe4c3c). `--refresh` FORCES — and now
    // forces a Claude adapter probe too. This child fires up to once a minute per
    // box, so forcing here would probe roughly hourly: "never per session or per
    // turn" violated through the side door. `--warm` refreshes only what is stale.
    const child = spawnFn(process.execPath, [entry, "models", "--warm", "--format", "json"], {
      detached: true,
      // Nothing is read back — the child's product is the cache file on disk.
      // Inheriting stdout would also corrupt a `--format json` parent.
      stdio: "ignore",
      // Same hardening as the queue owner: never inherit a cwd that may have
      // been reaped, or the detached child dies on `uv_cwd`.
      cwd: safeSpawnCwd(),
      env,
      windowsHide: true,
    });
    // THE LINE THAT MAKES THE PARENT ABLE TO EXIT. Without it the child's handle
    // holds this process's event loop open until the fetch finishes — exactly
    // the latency regression this whole design exists to avoid.
    child.unref();
    child.on("error", () => {
      // A refresh that cannot even start is not the create's problem.
    });
  } catch {
    // spawn threw synchronously (bad entry, EMFILE…). Same rule.
  }
}

function safeSpawnCwd(): string {
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}
