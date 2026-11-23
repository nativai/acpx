import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withTempHome } from "./runtime-test-helpers.js";

// Brick 1e13eb2f: in a state home with no archive directory, `acpx sessions archive --dry-run` (no `--apply`) warned
// "--apply was honoured, but D2 first-run gating held it" — a flag nobody gave. The dry run now says what a real apply would
// meet on this box's first run; the apply keeps its own text. Each is asserted EXACTLY, from the real built CLI.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type Run = { code: number | null; stdout: string; stderr: string };

function run(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ACPX_STATE_HOME: home };
    delete env.ACPX_ARCHIVE_ALLOW_FIRST_RUN;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [CLI, "sessions", "archive", ...args], {
      env,
      cwd: home,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** A state home with a hot sessions dir and NO archive dir: this box's first run. */
async function firstRunHome(home: string): Promise<{ archiveDir: string }> {
  await fs.mkdir(path.join(home, ".acpx", "sessions"), { recursive: true });
  const archiveDir = path.join(home, ".acpx", "sessions-archive");
  await assert.rejects(fs.stat(archiveDir), "precondition: no archive directory yet");
  return { archiveDir };
}

const warningLines = (stdout: string): string[] =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("  ⚠ "))
    .map((line) => line.slice("  ⚠ ".length));

test("a first-run `--dry-run` does NOT claim `--apply` was honoured: it says what a real apply would meet, exactly", async () => {
  await withTempHome("acpx-archive-first-run-", async (home) => {
    const { archiveDir } = await firstRunHome(home);
    const result = await run(["--dry-run"], home);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(warningLines(result.stdout), [
      `First run: no archive directory exists yet at ${archiveDir}, so a real --apply would be held by D2 first-run gating and move nothing. Nothing was moved by this dry run either. The plan above is what WOULD move once the first run is allowed: --apply --allow-first-run (or set ACPX_ARCHIVE_ALLOW_FIRST_RUN=1).`,
    ]);
    assert.doesNotMatch(result.stdout, /--apply was honoured/u, "nobody stated --apply");
    await assert.rejects(fs.stat(archiveDir), "a dry run writes no archive directory");
  });
});

test("a first-run `--apply` keeps its text: `--apply was honoured, but D2 first-run gating held it` — exactly, and nothing is moved", async () => {
  await withTempHome("acpx-archive-first-run-", async (home) => {
    const { archiveDir } = await firstRunHome(home);
    const result = await run(["--apply"], home);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(warningLines(result.stdout), [
      `--apply was honoured, but D2 first-run gating held it: no archive directory exists yet at ${archiveDir}, so this is this box's FIRST run and nothing was moved. The plan above is what WOULD move. Re-run with --apply --allow-first-run (or set ACPX_ARCHIVE_ALLOW_FIRST_RUN=1) to apply it.`,
    ]);
    assert.match(result.stdout, /^\[FIRST-RUN DRY RUN\]/u);
    await assert.rejects(fs.stat(archiveDir), "the gate held: no archive directory");
  });
});

const firstRunWarnings = (stdout: string): string[] =>
  warningLines(stdout).filter((line) => /first[- ]run/iu.test(line));

test("NEGATIVE: once the first run is allowed (`--allow-first-run`, or the env), neither intent prints a first-run warning", async () => {
  await withTempHome("acpx-archive-first-run-", async (home) => {
    await firstRunHome(home);
    const dry = await run(["--dry-run", "--allow-first-run"], home);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(firstRunWarnings(dry.stdout), []);
    const applied = await run(["--apply"], home, { ACPX_ARCHIVE_ALLOW_FIRST_RUN: "1" });
    assert.equal(applied.code, 0, applied.stderr);
    assert.deepEqual(firstRunWarnings(applied.stdout), []);
    assert.match(applied.stdout, /^\[APPLIED\]/u);
  });
});
