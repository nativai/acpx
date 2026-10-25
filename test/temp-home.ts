// The one temp-HOME fixture and the one teardown for it (brick://1d1cd13a).
//
// WHY THIS EXISTS. Roughly forty test files each carried a private `withTempHome`
// that removed the home with `fs.rm(dir, { recursive: true, force: true })` and no
// retry. `force` suppresses ENOENT, NOT ENOTEMPTY. The CLI intentionally leaves a
// detached `__queue-owner` daemon (and its ACP adapter) running past the call that
// spawned it, with `HOME=<tempHome>` inherited — so when the test's own `finally`
// ran, a live process was still holding and writing under `<tempHome>/.acpx[/q|
// /sessions]`, and the recursive walk-then-rmdir lost the race with ENOTEMPTY. The
// test body had passed; the red was the teardown. The owner reaper (owner-reaper.ts)
// reaps those daemons, but only once per test FILE, in `after()` — so within a file
// every earlier test's owner was still alive while its own home was being removed.
//
// WHAT THIS DOES, in this order, on every teardown:
//   1. REAP what the test started against THIS home — by positive identification
//      only: this file's exact ACPX_TEST_OWNER_TAG AND a `HOME` / `ACPX_STATE_HOME` in
//      the process's environ that IS this home or lies under it (a fixture may hand
//      the CLI `<root>/home` and `<root>/state`; message-ledger.test.ts does). It reuses owner-reaper's /proc readers and its
//      identify -> group-kill -> verify-absence sweep; there is no second killer.
//   2. REMOVE with bounded retries (Node's `fs.rm` `maxRetries`/`retryDelay`, which
//      covers ENOTEMPTY/EBUSY/EPERM) for the in-process writers a reap cannot name.
//   3. NOTHING IS SWALLOWED. A process still holding the home after the reap throws
//      with its pid and comm; a home that still cannot be removed throws naming the
//      directory, what is left in it and which processes hold it. Never argv, never
//      environ.
//
// ⚠️ DO NOT "FIX" A FUTURE RED HERE BY WIDENING THE MATCH (reaping by HOME alone, or
// by a bare `node` name), BY DROPPING THE THROW, OR BY ADDING `force`-style
// tolerance for ENOTEMPTY. Each of those turns a leaked process into a silent
// success. The negative cases in temp-home.test.ts (a different tag and a different
// HOME both survive; a persistent failure throws) are what go red if you do.

import { readdirSync, rmSync, type Dirent, type RmOptions } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  OWNER_TAG_ENV,
  exactTagMatcher,
  findHomeHolders,
  installOwnerReaper,
  readComm,
  sweepOwners,
} from "./owner-reaper.js";

// Mint (or reuse) this file process's tag at MODULE LOAD, before any test body
// spawns anything: every child the test starts then inherits it, which is what
// lets the teardown identify them. Idempotent — `install-owner-reaper.ts` and
// `runtime-test-helpers.ts` call the same function.
installOwnerReaper();

/** Environment variables a fixture can pin to the temp home for the duration of
 *  `run`. Restored (or deleted, if they were unset) before the home is removed. */
export type PinnedHomeVar = "HOME" | "ACPX_STATE_HOME";

export type TempHomeOptions = {
  /** Variables set to the temp home while `run` executes. Default: none — the
   *  caller passes `HOME` to the CLI through its own `env`. */
  pin?: readonly PinnedHomeVar[];
  removal?: RemovalOptions;
};

export type RemovalOptions = {
  /** `fs.rm` retries on ENOTEMPTY/EBUSY/EPERM. Default 10. */
  maxRetries?: number;
  /** `fs.rm` base delay in ms, multiplied by the attempt number. Default 100. */
  retryDelayMs?: number;
};

const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_RETRY_DELAY_MS = 100;
const LEFTOVER_LIST_LIMIT = 40;

/** Create a temp home under `os.tmpdir()`, run `run` against it, and tear it down
 *  with `removeTempHome`. A throw from `run` is never masked by a teardown failure:
 *  if both fail the caller gets one error whose message carries both. */
export async function withTempHome<T>(
  prefix: string,
  run: (homeDir: string) => Promise<T>,
  options: TempHomeOptions = {},
): Promise<T> {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const restorePins = pinEnv(options.pin ?? [], tempHome);

  let result: T;
  try {
    result = await run(tempHome);
  } catch (runError) {
    restorePins();
    try {
      await removeTempHome(tempHome, options.removal);
    } catch (teardownError) {
      throw new Error(
        `test body and temp-home teardown both failed (${tempHome}). Test body: ${errorLine(runError)}. ` +
          `Teardown: ${errorLine(teardownError)}`,
        { cause: teardownError },
      );
    }
    throw runError;
  }
  restorePins();
  await removeTempHome(tempHome, options.removal);
  return result;
}

function pinEnv(vars: readonly PinnedHomeVar[], tempHome: string): () => void {
  const previous = vars.map((name) => [name, process.env[name]] as const);
  for (const name of vars) {
    process.env[name] = tempHome;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

/** Reap what this file started against `tempHome`, then remove it. Throws — never
 *  returns quietly — if a process still holds the home or the directory survives. */
export async function removeTempHome(
  tempHome: string,
  options: RemovalOptions = {},
): Promise<void> {
  const survivors = reapHomeProcesses(tempHome);
  let removalError: unknown;
  try {
    await fs.rm(tempHome, rmOptions(options));
  } catch (error) {
    removalError = error;
  }
  failIfNotClean(tempHome, survivors, removalError, options);
}

/** `removeTempHome` for the synchronous teardowns (`afterEach`, `finally` in a
 *  non-async fixture). Same reap, same retries (`rmSync` blocks between them), same
 *  throws. */
export function removeTempHomeSync(tempHome: string, options: RemovalOptions = {}): void {
  const survivors = reapHomeProcesses(tempHome);
  let removalError: unknown;
  try {
    rmSync(tempHome, rmOptions(options));
  } catch (error) {
    removalError = error;
  }
  failIfNotClean(tempHome, survivors, removalError, options);
}

function rmOptions(options: RemovalOptions): RmOptions {
  return {
    recursive: true,
    force: true,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryDelay: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  };
}

/** The "nothing is swallowed" step, shared by the async and sync teardown. */
function failIfNotClean(
  tempHome: string,
  survivors: number[],
  removalError: unknown,
  options: RemovalOptions,
): void {
  if (survivors.length > 0) {
    throw new Error(
      `temp-home teardown: ${survivors.map(describePid).join(", ")} still hold ${tempHome} (via HOME / ACPX_STATE_HOME) ` +
        `after SIGTERM and SIGKILL — a leaked process, not a flake. ` +
        (removalError === undefined
          ? "The directory itself was removed."
          : `The directory could not be removed either: ${errorLine(removalError)}`),
      { cause: removalError },
    );
  }
  if (removalError !== undefined) {
    const holders = findHomeHolders(tempHome);
    throw new Error(
      `temp-home teardown: could not remove ${tempHome} after the reap and ` +
        `${String(options.maxRetries ?? DEFAULT_MAX_RETRIES)} retries: ${errorLine(removalError)}. ` +
        `Left in it: ${describeLeftovers(tempHome)}. ` +
        `Processes with HOME / ACPX_STATE_HOME at or under it: ${
          holders.length === 0 ? "none" : holders.map(describePid).join(", ")
        } (an unreapable holder has no ${OWNER_TAG_ENV} of this file).`,
      { cause: removalError },
    );
  }
}

/** The reap step alone: group-kills this file's tagged processes whose HOME is
 *  `tempHome`, verifies absence, and returns the pids that SURVIVED it. */
function reapHomeProcesses(tempHome: string): number[] {
  const tag = process.env[OWNER_TAG_ENV];
  if (tag === undefined) {
    // installOwnerReaper() ran at module load, so this is unreachable unless
    // something deleted the tag mid-run. Loud, not a silent skip.
    throw new Error(`temp-home teardown: ${OWNER_TAG_ENV} is unset, cannot identify owners`);
  }
  const result = sweepOwners(exactTagMatcher(tag, { home: tempHome }), {
    label: `temp-home ${path.basename(tempHome)}`,
    quietWhenEmpty: true,
  });
  return result.survivingPids;
}

function describePid(pid: number | { pid: number; comm: string }): string {
  return typeof pid === "number"
    ? `pid=${String(pid)} comm=${readComm(pid) ?? "?"}`
    : `pid=${String(pid.pid)} comm=${pid.comm}`;
}

function errorLine(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeLeftovers(root: string): string {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      found.push(`${path.relative(root, dir) || "."} (unreadable: ${errorLine(error)})`);
      return;
    }
    for (const entry of entries) {
      if (found.length >= LEFTOVER_LIST_LIMIT) {
        return;
      }
      const full = path.join(dir, entry.name);
      found.push(path.relative(root, full) + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(root);
  if (found.length === 0) {
    return "nothing (the directory is empty or gone)";
  }
  const capped =
    found.length >= LEFTOVER_LIST_LIMIT ? ` … (first ${String(LEFTOVER_LIST_LIMIT)})` : "";
  return found.join(", ") + capped;
}
