import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  catalogueNeedsWarm,
  WARM_ATTEMPT_COOLDOWN_MS,
  warmCatalogueInBackground,
} from "../src/models/catalogue-warm.js";
import { CATALOGUE_TTL_MS } from "../src/models/openrouter-catalogue.js";

/**
 * ⚠️ EVERY TEST HERE STARTS FROM AN ABSENT CACHE, ON PURPOSE.
 *
 * The defect this module fixes survived a full phase-1 gate *because that gate
 * measured against a WARM cache in an isolated store* — so a test that warms
 * first reproduces the original blind spot exactly rather than testing the fix
 * (brick://7a2d5c60, brick://db554b05 `reports/MEASUREMENT.md`).
 */

function tempCacheDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acpx-warm-test-"));
}

/**
 * A realistic acpx CLI entry. NOT `process.execPath` — the guard requires the
 * resolved entry to be acpx's own `cli.js`, because `process.argv[1]` is the TEST
 * FILE under `node --test` and re-invoking that is what produced a 116-failure
 * gate. Tests that expect a spawn must therefore look like acpx.
 */
function fakeCliEntry(dir: string): string {
  const distDir = path.join(dir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const entry = path.join(distDir, "cli.js");
  fs.writeFileSync(entry, "");
  return entry;
}

/** A spawn stub that records the call and hands back a minimal child. */
function recordingSpawn() {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  let unrefCalls = 0;
  const spawn = (command: string, args: string[], options: object): ChildProcess => {
    calls.push({ command, args, options: options as Record<string, unknown> });
    return {
      unref() {
        unrefCalls += 1;
      },
      on() {
        return this;
      },
    } as unknown as ChildProcess;
  };
  return {
    spawn,
    calls,
    get unrefCalls() {
      return unrefCalls;
    },
  };
}

// ── When a warm is needed at all ─────────────────────────────────────────────

test("an ABSENT cache needs a warm — the production state that made validation a no-op", () => {
  const dir = tempCacheDir();
  const cachePath = path.join(dir, "models-cache.json");
  assert.equal(fs.existsSync(cachePath), false, "precondition: the cache must not exist");
  assert.equal(catalogueNeedsWarm({ cachePath }), true);
});

test("a FRESH cache needs no warm; a STALE one does", () => {
  const dir = tempCacheDir();
  const cachePath = path.join(dir, "models-cache.json");
  const now = Date.parse("2026-09-05T00:00:00.000Z");

  fs.writeFileSync(
    cachePath,
    JSON.stringify({ fetchedAt: new Date(now - 60_000).toISOString(), models: [] }),
  );
  assert.equal(catalogueNeedsWarm({ cachePath, now: () => now }), false);

  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      fetchedAt: new Date(now - CATALOGUE_TTL_MS - 60_000).toISOString(),
      models: [],
    }),
  );
  assert.equal(catalogueNeedsWarm({ cachePath, now: () => now }), true);
});

test("an UNPARSEABLE cache is treated as absent, never as fresh", () => {
  const dir = tempCacheDir();
  const cachePath = path.join(dir, "models-cache.json");
  fs.writeFileSync(cachePath, "{ not json");
  assert.equal(catalogueNeedsWarm({ cachePath }), true);
});

// ── The never-awaited property ───────────────────────────────────────────────

test("NEVER AWAITED: it returns void, and the child is detached AND unref()'d", () => {
  // Three independent legs of one property, because the whole design rests on it:
  //  (a) `void` — there is no handle to await, so a caller cannot block on it
  //      even by mistake; making it awaitable would require changing the
  //      signature, which is a visible act rather than a slip.
  //  (b) `detached: true` + `stdio: "ignore"` — the work is in ANOTHER process,
  //      so an in-process fetch cannot hold this event loop open.
  //  (c) `unref()` — WITHOUT IT the child handle keeps the parent alive until the
  //      fetch finishes, which is precisely the latency regression on every first
  //      create that this design exists to avoid.
  const dir = tempCacheDir();
  const cachePath = path.join(dir, "models-cache.json");
  const spawner = recordingSpawn();

  const returned: unknown = warmCatalogueInBackground({
    cachePath,
    spawn: spawner.spawn,
    argv: ["node", fakeCliEntry(dir)],
    env: {},
  });

  assert.equal(returned, undefined, "(a) must return void — nothing to await");
  assert.equal(spawner.calls.length, 1);
  const call = spawner.calls[0];
  assert.ok(call);
  assert.equal(call.options.detached, true, "(b) must run in a detached child");
  assert.equal(call.options.stdio, "ignore", "(b) stdio must not be inherited");
  assert.equal(spawner.unrefCalls, 1, "(c) the child must be unref()'d");
});

test("the child re-invokes acpx's OWN refresh path — no second fetch implementation", () => {
  const dir = tempCacheDir();
  const spawner = recordingSpawn();
  warmCatalogueInBackground({
    cachePath: path.join(dir, "models-cache.json"),
    spawn: spawner.spawn,
    argv: ["node", fakeCliEntry(dir)],
    env: {},
  });
  const call = spawner.calls[0];
  assert.ok(call);
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args.slice(1), ["models", "--refresh", "--format", "json"]);
});

// ── When it must NOT spawn ───────────────────────────────────────────────────

test("a FRESH cache spawns nothing", () => {
  const dir = tempCacheDir();
  const cachePath = path.join(dir, "models-cache.json");
  const now = Date.parse("2026-09-05T00:00:00.000Z");
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ fetchedAt: new Date(now - 1000).toISOString(), models: [] }),
  );
  const spawner = recordingSpawn();
  warmCatalogueInBackground({
    cachePath,
    now: () => now,
    spawn: spawner.spawn,
    argv: ["node", fakeCliEntry(dir)],
    env: {},
  });
  assert.equal(spawner.calls.length, 0);
});

test("the cooldown stops N concurrent creates each spawning their own refresh", () => {
  // This box routinely runs a dozen agents at once, so the stampede is real.
  // Losing the race costs a redundant fetch, never a wrong catalogue.
  const dir = tempCacheDir();
  const cachePath = path.join(dir, "models-cache.json");
  const now = Date.parse("2026-09-05T00:00:00.000Z");
  const spawner = recordingSpawn();
  const call = (at: number) =>
    warmCatalogueInBackground({
      cachePath,
      now: () => at,
      spawn: spawner.spawn,
      argv: ["node", fakeCliEntry(dir)],
      env: {},
    });

  call(now);
  call(now + 1000);
  call(now + WARM_ATTEMPT_COOLDOWN_MS - 1);
  assert.equal(spawner.calls.length, 1, "inside the cooldown, only the first spawns");

  call(now + WARM_ATTEMPT_COOLDOWN_MS + 1);
  assert.equal(spawner.calls.length, 2, "past the cooldown it may try again");
});

test("the disable env var suppresses it entirely", () => {
  const dir = tempCacheDir();
  const spawner = recordingSpawn();
  warmCatalogueInBackground({
    cachePath: path.join(dir, "models-cache.json"),
    spawn: spawner.spawn,
    argv: ["node", fakeCliEntry(dir)],
    env: { ACPX_NO_CATALOGUE_WARM: "1" },
  });
  assert.equal(spawner.calls.length, 0);
});

test("a spawn that throws is swallowed — a create must never fail over a refresh", () => {
  const dir = tempCacheDir();
  assert.doesNotThrow(() =>
    warmCatalogueInBackground({
      cachePath: path.join(dir, "models-cache.json"),
      spawn: () => {
        throw new Error("EMFILE");
      },
      argv: ["node", fakeCliEntry(dir)],
      env: {},
    }),
  );
});

test("no self-entry to re-invoke: nothing spawns and nothing throws", () => {
  const dir = tempCacheDir();
  const spawner = recordingSpawn();
  assert.doesNotThrow(() =>
    warmCatalogueInBackground({
      cachePath: path.join(dir, "models-cache.json"),
      spawn: spawner.spawn,
      argv: ["node"],
      env: {},
    }),
  );
  assert.equal(spawner.calls.length, 0);
});

/**
 * 🛑 THE REGRESSION TEST FOR THE 116-FAILURE GATE. This is the case every other
 * test in this file could not see, because they all INJECT an `argv` that
 * happens to be acpx — the harness supplying what the real run does not
 * (verification-soundness §7).
 *
 * MEASURED: inside a `node --test` worker `process.argv[1]` is the TEST FILE.
 * The first version of this module therefore spawned
 * `node <file>.test.js models --refresh --format json`, re-running whole test
 * files as detached children against the parent's scratch `ACPX_STATE_HOME`.
 * It was invisible when a file ran alone and catastrophic under the parallel
 * suite.
 */
test("a NON-acpx argv[1] (a test file) must spawn NOTHING", () => {
  const dir = tempCacheDir();
  for (const entry of [
    "/workspace/projects/acpx/p2-cli/dist-test/test/integration.test.js",
    "/usr/local/bin/some-other-tool",
    "/tmp/whatever.mjs",
  ]) {
    const spawner = recordingSpawn();
    warmCatalogueInBackground({
      cachePath: path.join(dir, `${path.basename(entry)}-cache.json`),
      spawn: spawner.spawn,
      argv: ["node", entry],
      env: {},
    });
    assert.equal(spawner.calls.length, 0, `${entry} must not be re-invoked`);
  }
});

test("the REAL installed entry shape — a symlink to cli.js — still warms", () => {
  // The mirror of the test above, and it is what stops the guard from failing
  // closed everywhere: on this box `/usr/local/bin/acpx` is a SYMLINK to
  // `…/dist/cli.js`, so a real invocation's `argv[1]` basename is `acpx` and
  // only its realpath is `cli.js`. A raw-basename check would pass in a source
  // worktree and silently disable the warm on the deployed CLI — reinstating
  // the very no-op this module exists to fix.
  const dir = tempCacheDir();
  const realCli = path.join(dir, "dist");
  fs.mkdirSync(realCli, { recursive: true });
  const cliPath = path.join(realCli, "cli.js");
  fs.writeFileSync(cliPath, "");
  const linkPath = path.join(dir, "acpx");
  fs.symlinkSync(cliPath, linkPath);

  const spawner = recordingSpawn();
  warmCatalogueInBackground({
    cachePath: path.join(dir, "models-cache.json"),
    spawn: spawner.spawn,
    argv: ["node", linkPath],
    env: {},
  });
  assert.equal(spawner.calls.length, 1, "the symlinked bin must still warm");
  // And the child is spawned with the RESOLVED path, not the symlink.
  assert.equal(spawner.calls[0]?.args[0], fs.realpathSync(cliPath));
});
