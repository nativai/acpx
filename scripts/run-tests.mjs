// brick://113073b8 — the test-run wrapper that makes the suite reap its own
// `__queue-owner` daemons.
//
// It does three things, in this order:
//   1. Mints a run-unique tag and exports it, BEFORE `node --test` forks its file
//      processes, so every file's L1 tag carries it as a prefix.
//   2. Caps the owner idle-release deadline for the run (see IDLE_RELEASE_MS).
//   3. Runs `node --test` with the L1 preload, then runs the L2 backstop sweep,
//      then exits with `node --test`'s OWN status.
//
// EXIT CODE. Step 3's order is the trap: a trailing command in a `;`-chain
// silently overwrites the status you read, and a gate that died at stage 3 of 8
// has been reported green exactly that way. `rc` is captured from the child and
// nothing after it may change it — the L2 sweep's own outcome is logged, never
// folded into the exit status.
//
// Usage:
//   node scripts/run-tests.mjs <files...>          run the suite, then L2-sweep
//   node scripts/run-tests.mjs --sweep-only <tag>  L2-sweep a known run tag only

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const preloadPath = join(repoRoot, "dist-test", "test", "install-owner-reaper.js");
const reaperPath = join(repoRoot, "dist-test", "test", "owner-reaper.js");

// The owner idle-release deadline for the whole test run, in ms.
//
// WHY 60_000 AND NOT "a few seconds". This is the deadline after which a
// provably-idle owner releases itself (`ACPX_OWNER_IDLE_RELEASE_MS`, read at
// queue-owner-runtime.ts:616; production default 1_800_000 = 30 min). Too small
// and a test whose warm owner sits idle between two turns loses it mid-test.
// The harness's own CLI timeouts bound that legitimate idle gap: `runCli` in
// integration.test.ts defaults to 15_000 and conformance-runner.test.ts to
// 30_000, so a gap longer than those means a CLI call already timed out and the
// test has failed for its own reasons. 60_000 is 2x the largest of them, and 30x
// below the production default — which is the whole point: it is what stops
// owners accumulating DURING a run, with the reaper as the teardown backstop.
//
// It does NOT rescue every owner: the release check only runs when the task poll
// times out, so the cadence is the TTL. An owner spawned with a large `--ttl`
// keeps a floor of that TTL regardless of this value (which is why the three
// `--ttl 3600` sites were reduced to 60).
const IDLE_RELEASE_MS = "60000";

function log(line) {
  process.stderr.write(`[acpx-test-reaper] ${line}\n`);
}

// brick://c028c10e — THERE IS NO CODEX-QUOTA FIXTURE SERVER HERE ANY MORE, AND
// NOTHING MAY BIND A FIXED PORT FROM THIS HARNESS AGAIN.
//
// What used to be here: an HTTP server on a hardcoded `127.0.0.1:3456` answering
// `/api/usage/codex/quota`, so that child-process tests taking a Codex turn would
// pass the subscription-cap gate (which fetches that endpoint from acpx-ui in
// production, `src/runtime/engine/codex-subscription-cap.ts`).
//
// Why it had to go: `3456` is also the port real acpx-ui serves on, and this
// server bound it unconditionally on every run — including targeted ones. Two
// lanes could not run the suite at once, and the loser died inside `build:test`
// with `EADDRINUSE` and `GATE_RC=1` — no tally, no `not ok` lines, and an
// unhandled rejection with no `[acpx-test-reaper]` prefix, so it read as "my
// change broke the build". Worse, `run-gate.sh` does not reserve the port, so a
// lane running `pnpm test` directly held it while holding no mutex, and the lane
// that politely took the mutex was the one that failed. Measured 2026-09-29.
//
// What replaced it: `ACPX_TEST_CODEX_QUOTA_JSON` below. The gate's quota read
// accepts a canned observation from that variable instead of an HTTP endpoint, and
// `runCli`-style helpers pass `...process.env` to their children, so it reaches
// every spawned CLI and its detached queue owner. No server, no port, no
// collision. It is a canned INPUT, not a skip — `classifyObservation` still runs
// on it, and it is honoured only when it parses as a usable observation
// (`src/runtime/engine/codex-subscription-cap.ts`).
//
// MEASURED, so none of this is taken on faith (worktree at dev 1543b96):
// without any fixture, `cli.test.js` + `integration.test.js` were 252/257 with 5
// failures; with the fixture, 257/257 — so the fixture's presence was the only
// discriminator.
//
// ⚠️ DO NOT "FIX" THIS BY RENAMING THE TESTS' `codex-acp-ops.jsonl` LOG FILE.
// Four of those five failures are `cli.test.ts` brick tests whose agent is
// `node <mock-agent.js>` — nothing to do with Codex — and the ONLY source of the
// `codex-acp` substring is that log filename, passed as an argument, which
// `isCodexAcpCommand` (`src/acp/codex-compat.ts:15`) substring-matches. It looks
// exactly like an accident worth renaming. It is not: the SAME classifier drives
// `resolvePrimerChannel` (`src/acp/agent-command.ts:151`), so the substring is
// what selects the `developer-instructions` primer channel — and that is what
// makes the brick-context resolution those tests assert happen at all. Renaming it
// was tried under this brick: 5 rows went red with a missing
// `brick context … --format inject` call, i.e. it silently changed what the tests
// exercise. The substring matcher itself is brick://5a7cf1f0.

async function loadReaper() {
  if (!existsSync(reaperPath)) {
    // Loud, and deliberately NOT fatal to the run's own verdict.
    log(`L2 SKIPPED — ${reaperPath} is missing (was build:test run?)`);
    return null;
  }
  return await import(pathToFileURL(reaperPath).href);
}

async function sweepRunTag(runTag) {
  const reaper = await loadReaper();
  if (reaper === null) {
    return;
  }
  reaper.sweepOwners(reaper.runTagMatcher(runTag), { label: `L2 run=${runTag}` });
}

const args = process.argv.slice(2);

if (args[0] === "--sweep-only") {
  const runTag = args[1];
  if (runTag === undefined || runTag.length === 0) {
    log("--sweep-only requires a run tag");
    process.exit(2);
  }
  await sweepRunTag(runTag);
  process.exit(0);
}

const runTag =
  `${process.env.NV_GATE_TAG ?? "acpx"}-${String(process.pid)}-${randomBytes(4).toString("hex")}`.replace(
    /[^A-Za-z0-9_-]/g,
    "-",
  );

const env = {
  ...process.env,
  ACPX_TEST_OWNER_RUN_TAG: runTag,
  // An explicit setting from the caller wins — an operator tuning this for a
  // targeted run must not be silently overridden.
  ACPX_OWNER_IDLE_RELEASE_MS: process.env.ACPX_OWNER_IDLE_RELEASE_MS ?? IDLE_RELEASE_MS,
  // brick://c028c10e — the replacement for the deleted fixture server; see the
  // block above. A below-cap weekly observation, so a test whose agent command is
  // Codex-classified can take a turn without an acpx-ui to ask. An explicit value
  // from the caller wins, so a row wanting an at-cap reading can still set one.
  ACPX_TEST_CODEX_QUOTA_JSON:
    process.env.ACPX_TEST_CODEX_QUOTA_JSON ??
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      secondary: { windowMinutes: 10_080, usedPercent: 0, elapsed: false },
    }),
};

if (!existsSync(preloadPath)) {
  log(
    `FATAL — L1 preload ${preloadPath} is missing; refusing to run untagged (was build:test run?)`,
  );
  process.exit(2);
}

log(
  `run=${runTag} idle_release_ms=${env.ACPX_OWNER_IDLE_RELEASE_MS} node_test_args=${String(args.length)}`,
);

const child = spawn(
  process.execPath,
  ["--test", "--import", pathToFileURL(preloadPath).href, ...args],
  { env, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // Forward and let the normal exit path below run L2 — an interrupted gate is
    // exactly the case the backstop exists for.
    child.kill(signal);
  });
}

child.on("error", (error) => {
  log(`FATAL — could not start node --test: ${String(error)}`);
  process.exit(2);
});

child.on("exit", (code, signal) => {
  // Captured BEFORE the sweep. Nothing below may change it.
  const rc = code ?? 1;
  void (async () => {
    try {
      await sweepRunTag(runTag);
    } catch (error) {
      // Logged, never folded into the exit status — see the EXIT CODE note in the
      // file header. Previously a `finally` guaranteed we reached `process.exit`
      // below even if the sweep threw; with the fixture teardown gone, this catch
      // is what keeps that guarantee.
      log(`L2 sweep failed: ${String(error)}`);
    }
    if (signal !== null) {
      log(`node --test was terminated by ${signal}`);
    }
    process.exit(rc);
  })();
});
