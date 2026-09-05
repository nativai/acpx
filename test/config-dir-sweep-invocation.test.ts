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
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HARNESS_CONFIG_DIR_ROOT_ENV } from "../src/acp/harness-config-dir-root.js";
import {
  claimHarnessConfigDirSweep,
  DEFAULT_SWEEP_INTERVAL_MS,
} from "../src/acp/harness-config-dir-sweep-gate.js";
import { assertHarnessConfigDirRootIsolated } from "./config-dir-root-isolation.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

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

/**
 * ⚠️ WRITE RECORDS THROUGH THE FIXTURE, NEVER BY HAND. A hand-rolled JSON record
 * missing a field `parseRecord` requires is dropped WHOLE, so `listSessions()`
 * returns nothing and the sweep reports `scanned=0` — which is indistinguishable
 * from "the sweep correctly spared it". Measured while writing these tests: a
 * hand-written record made the CONTROL below pass for the wrong reason.
 */
/**
 * A CLOSED record, which since `unrecognised` became retain-and-report is the ONLY
 * thing that makes a config dir removable. A planted directory with no record is now
 * retained, so a reap fixture without one would assert nothing.
 */
async function seedClosedSession(homeDir: string, id: string): Promise<void> {
  await writeSessionRecordFile(
    homeDir,
    makeSessionRecord(
      {
        acpxRecordId: id,
        acpSessionId: id,
        agentCommand: "node /opt/claude-agent-acp/dist/index.js",
        agentName: "claude",
        cwd: homeDir,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        closed: true,
        closedAt: "2026-01-02T00:00:00.000Z",
      },
      { defaultName: false, defaultAcpx: false },
    ),
  );
}

async function seedIdleOpenSession(homeDir: string, id: string): Promise<void> {
  await writeSessionRecordFile(
    homeDir,
    makeSessionRecord(
      {
        acpxRecordId: id,
        acpSessionId: id,
        agentCommand: "node /opt/claude-agent-acp/dist/index.js",
        agentName: "claude",
        cwd: homeDir,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        closed: false,
      },
      { defaultName: false, defaultAcpx: false },
    ),
  );
}

async function readClosed(homeDir: string, id: string): Promise<boolean | undefined> {
  const raw = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as {
    closed?: boolean;
  };
  return raw.closed;
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
    await seedClosedSession(homeDir, "verb-orphan");
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
    await seedClosedSession(homeDir, "verb-preview");
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
    await seedClosedSession(homeDir, "trigger-orphan");
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

// ---------------------------------------------------------------------------
// REGRESSIONS THIS BRICK'S OWN GATE CAUGHT AT 2e10e4e — both from the trigger
// ---------------------------------------------------------------------------

test("0bac6a00 C: the prompt trigger NEVER closes a session record", async () => {
  // ⚠️ THE REGRESSION, AND IT WAS WORSE THAN A RED TEST. The trigger originally ran
  // the abandoned-RECORD sweep too, so a prompt MUTATED SESSION STATE as a side
  // effect. Two gate failures showed the cost: it closed the very session being
  // prompted (exit 1), and — the one that matters — with two sessions sharing a
  // name it closed ONE, the ambiguity DISSOLVED, and a prompt the CLI must REFUSE
  // was delivered to the agent at exit 0.
  //
  // A reap that runs on someone else's turn may READ state. It may not WRITE it.
  await withTempHomeFixture("acpx-0bac6a00-noclose-", async (homeDir) => {
    const root = process.env[HARNESS_CONFIG_DIR_ROOT_ENV] as string;
    plantAged(root, "acpx-opencode-noclose-orphan");
    await seedIdleOpenSession(homeDir, "idle-open");

    await runCliUnguarded(["claude", "prompt", "--session", "no-such-session-zz", "hi"], homeDir);

    assert.equal(
      await readClosed(homeDir, "idle-open"),
      false,
      "the PROMPT path closed a session record",
    );
  });
});

test("0bac6a00 A: the explicit VERB still does close it — the control that keeps the test above honest", async () => {
  // Without this, "the record stayed open" would also be true of a sweep that never
  // ran at all, and the test above would pass against a completely broken trigger.
  await withTempHomeFixture("acpx-0bac6a00-doesclose-", async (homeDir) => {
    await seedIdleOpenSession(homeDir, "idle-open");

    await runCliUnguarded(["claude", "sessions", "sweep-config-dirs"], homeDir);

    assert.equal(
      await readClosed(homeDir, "idle-open"),
      true,
      "the explicit verb did NOT close an ownerless record",
    );
  });
});

test("0bac6a00: a PROMPT is now guarded as sweep-capable, not just a prune", () => {
  // ⚠️ THE OTHER HALF OF THE SAME MISTAKE. The scoping guard originally fired only
  // on args containing "prune", because prune was the only verb that swept. Adding
  // the trigger widened the surface that SWEEPS without widening the surface that
  // is SCOPED — and the gate immediately drove a cli.test.ts prompt against
  // `root=/tmp`, scanning the box's seven real acpx-pi-* directories. It removed
  // nothing only because cc9a5f25's retention rule held: saved by the safety net is
  // not the same as safe.
  const saved = process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
  try {
    delete process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
    assert.throws(
      () => assertHarnessConfigDirRootIsolated(["claude", "prompt", "hello"]),
      /no scoped config-dir root/,
      "a prompt must be guarded — it reaches the sweep too",
    );
    // Still exempt, still for the same reason: it prints and exits.
    assertHarnessConfigDirRootIsolated(["claude", "prompt", "--help"]);
  } finally {
    if (saved === undefined) {
      delete process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
    } else {
      process.env[HARNESS_CONFIG_DIR_ROOT_ENV] = saved;
    }
  }
});
