import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HARNESS_CONFIG_DIR_ROOT_ENV } from "../src/acp/harness-config-dir-root.js";
import {
  claimHarnessConfigDirSweep,
  DEFAULT_SWEEP_INTERVAL_MS,
} from "../src/acp/harness-config-dir-sweep-gate.js";
import { withTempHome as withTempHomeFixture } from "./runtime-test-helpers.js";

/**
 * brick 0bac6a00 — THE INVOCATION: A + C(first-prompt), form 2 (interval timestamp).
 *
 * ## ⚠️ THE ONE PROPERTY MOST WORTH PINNING, BECAUSE ITS FAILURE IS SILENT
 *
 * Form 2's whole value is that the gate costs a timestamp read rather than the
 * `readdir` that is 81% of the census. The natural implementation — a module-level
 * `lastSweepAt` — reads correctly and gates NOTHING on the trigger that was
 * actually ruled, because `acpx prompt` is a fresh process every time. The
 * cross-process test below is what distinguishes a real gate from that one.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCliUnguarded(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.stdin.end();
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function plantAged(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "marker.txt"), "planted");
  const past = (Date.now() - SEVEN_HOURS_MS) / 1000;
  utimesSync(dir, past, past);
  return dir;
}

// ---------------------------------------------------------------------------
// The interval gate (form 2)
// ---------------------------------------------------------------------------

test("0bac6a00 gate: the FIRST claim on a fresh root is granted, the second is not", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-gate-"));
  try {
    const now = Date.parse("2026-09-05T12:00:00.000Z");
    assert.equal(claimHarnessConfigDirSweep({ root, now }), true, "a never-swept root must sweep");
    assert.equal(
      claimHarnessConfigDirSweep({ root, now: now + 1000 }),
      false,
      "a second claim one second later must be declined",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 gate: a claim is granted again once the interval has ELAPSED", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-gate2-"));
  try {
    const now = Date.parse("2026-09-05T12:00:00.000Z");
    assert.equal(claimHarnessConfigDirSweep({ root, now }), true);
    // Just inside — still declined. Just outside — granted. Both directions, or
    // "it declined" would also be true of a gate that declines everything.
    assert.equal(
      claimHarnessConfigDirSweep({ root, now: now + DEFAULT_SWEEP_INTERVAL_MS - 1 }),
      false,
    );
    assert.equal(
      claimHarnessConfigDirSweep({ root, now: now + DEFAULT_SWEEP_INTERVAL_MS + 1 }),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 gate: the claim SURVIVES THE PROCESS — a module variable would not", () => {
  // ⚠️ THE TEST THAT SEPARATES A REAL GATE FROM ONE THAT READS LIKE A GATE. Each
  // `acpx prompt` is a fresh process; an in-memory `lastSweepAt` starts unset in
  // every one of them, so the census would run on EVERY prompt while the source
  // said "at most once per interval". Two independent processes here, sharing only
  // the root.
  const root = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-gate3-"));
  try {
    const claimInChild = (): string => {
      return execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { claimHarnessConfigDirSweep } from ${JSON.stringify(
            fileURLToPath(new URL("../src/acp/harness-config-dir-sweep-gate.js", import.meta.url)),
          )};
           process.stdout.write(String(claimHarnessConfigDirSweep({ root: ${JSON.stringify(root)} })));`,
        ],
        { encoding: "utf8" },
      );
    };
    assert.equal(claimInChild(), "true", "the first process must be granted the claim");
    assert.equal(claimInChild(), "false", "a SECOND PROCESS must see the first one's claim");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 gate: an UNWRITABLE root DECLINES rather than sweeping every time", () => {
  // A failed claim means nothing bounds the next caller either, so proceeding
  // would run an ungated census on every single prompt — the exact cost the gate
  // exists to prevent. Skipping is recoverable; that is not.
  assert.equal(
    claimHarnessConfigDirSweep({ root: join(tmpdir(), "acpx-0bac6a00-absent-root-zz") }),
    false,
  );
});

test("0bac6a00 gate: the stamp is never itself a sweep CANDIDATE", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-stamp-"));
  try {
    claimHarnessConfigDirSweep({ root });
    const entries = readdirSync(root);
    assert.equal(entries.length, 1, `expected only the stamp: ${entries.join(", ")}`);
    const stamp = entries[0];
    assert.equal(
      stamp.startsWith("acpx-"),
      false,
      "the stamp must not match the acpx-<harness>- candidate prefix",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A — the record-preserving verb
// ---------------------------------------------------------------------------

test("0bac6a00 A: `sessions sweep-config-dirs` reaps a directory and prints its census", async () => {
  await withTempHomeFixture("acpx-0bac6a00-verb-", async (homeDir) => {
    const root = process.env[HARNESS_CONFIG_DIR_ROOT_ENV] as string;
    const dir = plantAged(root, "acpx-opencode-verb-orphan");

    const result = await runCliUnguarded(["claude", "sessions", "sweep-config-dirs"], homeDir);

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(
      result.stderr.includes(`harness config dirs: root=${root}`),
      `census missing:\n${result.stderr}`,
    );
    assert.equal(existsSync(dir), false, "the verb did not reap the orphan");
  });
});

test("0bac6a00 A: `sessions sweep-config-dirs --dry-run` previews and removes nothing", async () => {
  await withTempHomeFixture("acpx-0bac6a00-verbdry-", async (homeDir) => {
    const root = process.env[HARNESS_CONFIG_DIR_ROOT_ENV] as string;
    const dir = plantAged(root, "acpx-opencode-verb-preview");

    const result = await runCliUnguarded(
      ["claude", "sessions", "sweep-config-dirs", "--dry-run"],
      homeDir,
    );

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /DRY RUN \(nothing removed\)/);
    assert.ok(result.stderr.includes(`WOULD REMOVE ${dir}`), result.stderr);
    assert.equal(existsSync(dir), true);
  });
});

test("0bac6a00 A: the verb NEVER deletes a session record or its transcript — that is the coupling it breaks", async () => {
  // ⚠️ THE PROPERTY THE WHOLE BRICK TURNS ON. Until this verb existed the only
  // thing that invoked the sweep was `sessions prune`, which removes each session's
  // record AND its messages sidecar — so reclaiming a leaked directory was coupled
  // to destroying transcripts, and the fleet's answer was to forbid the command.
  await withTempHomeFixture("acpx-0bac6a00-preserve-", async (homeDir) => {
    const root = process.env[HARNESS_CONFIG_DIR_ROOT_ENV] as string;
    plantAged(root, "acpx-opencode-preserve-orphan");
    const sessionsDir = join(homeDir, ".acpx", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // Two files a prune WOULD take: a closed record and its messages sidecar.
    const record = join(sessionsDir, "keepme.json");
    const sidecar = join(sessionsDir, "keepme.messages.ndjson");
    writeFileSync(
      record,
      JSON.stringify({
        schema: "acpx.session.v1",
        acpxRecordId: "keepme",
        acpSessionId: "keepme",
        agentName: "claude",
        agentCommand: "node /opt/claude-agent-acp/dist/index.js",
        cwd: homeDir,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        closed: true,
        closedAt: "2026-01-01T00:00:00.000Z",
        lastSeq: 0,
      }),
    );
    writeFileSync(sidecar, "one line of transcript\n");

    const result = await runCliUnguarded(["claude", "sessions", "sweep-config-dirs"], homeDir);

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(existsSync(record), true, "the verb deleted a session RECORD");
    assert.equal(existsSync(sidecar), true, "the verb deleted a messages SIDECAR");
  });
});

// ---------------------------------------------------------------------------
// C — the first-prompt trigger, driven through the real CLI
// ---------------------------------------------------------------------------

test("0bac6a00 C: a PROMPT triggers the sweep, and does so before the session lookup", async () => {
  // ⚠️ THE PROMPT IS DELIBERATELY ONE THAT FAILS. The trigger sits ahead of session
  // resolution, so a prompt naming no session still fires it — which is what makes
  // this testable without an adapter, and is also the honest behaviour: the reap
  // must not depend on the turn succeeding.
  await withTempHomeFixture("acpx-0bac6a00-trigger-", async (homeDir) => {
    const root = process.env[HARNESS_CONFIG_DIR_ROOT_ENV] as string;
    const dir = plantAged(root, "acpx-opencode-trigger-orphan");

    const result = await runCliUnguarded(
      ["claude", "prompt", "--session", "no-such-session-zz", "hello"],
      homeDir,
    );

    assert.ok(
      result.stderr.includes(`harness config dirs: root=${root}`),
      `the prompt path did not run the sweep:\n${result.stderr}`,
    );
    assert.equal(existsSync(dir), false, "the prompt trigger did not reap the orphan");
  });
});

test("0bac6a00 C: a SECOND prompt inside the interval does NOT sweep again", async () => {
  // The gate's whole purpose, measured at the CLI rather than at the unit: two
  // consecutive prompts, one census. Without this, "it is interval-gated" is a
  // claim about a function nobody proved was on the path.
  await withTempHomeFixture("acpx-0bac6a00-trigger2-", async (homeDir) => {
    const root = process.env[HARNESS_CONFIG_DIR_ROOT_ENV] as string;
    const first = await runCliUnguarded(
      ["claude", "prompt", "--session", "no-such-session-zz", "hello"],
      homeDir,
    );
    assert.ok(first.stderr.includes(`harness config dirs: root=${root}`), first.stderr);

    const second = await runCliUnguarded(
      ["claude", "prompt", "--session", "no-such-session-zz", "hello"],
      homeDir,
    );
    assert.equal(
      second.stderr.includes("harness config dirs:"),
      false,
      `the second prompt swept again — the interval gate is not on the path:\n${second.stderr}`,
    );
  });
});
