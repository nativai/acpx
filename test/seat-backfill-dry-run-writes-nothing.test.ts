import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  makeSessionRecord,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// Brick bbb215c0 — "the abandoned-record sweep writes during a `seats backfill` DRY RUN".
//
// MEASURED 2026-10-03 (acpx seat/wave-b-late): THE CLAIM DOES NOT HOLD, and these rows pin the
// truth so it cannot be re-asserted from the report line alone. The sweep is called ONLY from
// `runSeatBackfill` (not "every CLI invocation"), and there its `closeSession` is a no-op by
// ruling (L10b in seat-backfill.test.ts: report-only, an abandoned record stays OPEN). The
// finding's `scanned=3 closed=3` is the sweep's VERDICT line — `closed=` counts the ids a real
// sweep WOULD close, not closes that happened. So no code change: these rows are green on
// arrival and exist to keep it so.
//
// The measurement is the one the brick asks for: sha256 of EVERY file under the state tree,
// before and after, plus the file list (an added file is a write too).

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_PARENT_SEAT_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: homeDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** `relative path → sha256` for every file under `<home>/.acpx`. */
async function snapshot(homeDir: string): Promise<Map<string, string>> {
  const root = path.join(homeDir, ".acpx");
  const out = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out.set(
          path.relative(root, full),
          createHash("sha256")
            .update(await fs.readFile(full))
            .digest("hex"),
        );
      }
    }
  };
  await walk(root);
  return out;
}

function abandoned(id: string, homeDir: string) {
  // Idle since January with no pid: exactly the shape the sweep classifies as abandoned.
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: "node never-running.js",
    agentName: "claude",
    cwd: homeDir,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
  });
}

test("BD1 · a seats backfill DRY RUN over abandoned-shaped records leaves every file under the state tree byte-identical", async () => {
  await withTempHomeFixture("acpx-backfill-dry-", async (homeDir) => {
    for (const id of ["abandoned-a", "abandoned-b"]) {
      await writeSessionRecordFile(homeDir, abandoned(id, homeDir));
    }
    const before = await snapshot(homeDir);
    const dry = await runCli(["seats", "backfill", "--format", "json"], homeDir);
    assert.equal(dry.code, 0, `${dry.stderr}${dry.stdout}`);
    // CONTROL: the sweep really ran and really judged both records abandoned — without this,
    // "nothing changed" is satisfied just as well by a sweep that never looked.
    const report = JSON.parse(dry.stdout.trim()) as {
      apply: boolean;
      sweep: { notMeasured: boolean; closed: string[] };
    };
    assert.equal(report.apply, false);
    assert.equal(report.sweep.notMeasured, false);
    assert.deepEqual(report.sweep.closed.toSorted(), ["abandoned-a", "abandoned-b"]);

    assert.deepEqual(
      [...(await snapshot(homeDir))],
      [...before],
      "a dry run changed (or added, or removed) a file under the state tree",
    );
  });
});

test("BD2 · the same holds once the store is already backfilled (index and seat rows present) and a NEW abandoned record appears", async () => {
  await withTempHomeFixture("acpx-backfill-dry2-", async (homeDir) => {
    await writeSessionRecordFile(homeDir, abandoned("first", homeDir));
    const applied = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.equal(applied.code, 0, `${applied.stderr}${applied.stdout}`);
    await writeSessionRecordFile(homeDir, abandoned("second", homeDir));

    const before = await snapshot(homeDir);
    const dry = await runCli(["seats", "backfill", "--format", "json"], homeDir);
    assert.equal(dry.code, 0, `${dry.stderr}${dry.stdout}`);
    assert.ok(
      (JSON.parse(dry.stdout.trim()) as { sweep: { closed: string[] } }).sweep.closed.includes(
        "second",
      ),
      "control: the new record is an abandonment candidate",
    );
    assert.deepEqual([...(await snapshot(homeDir))], [...before]);
  });
});

test("BD3 · the sweep's `closed=` is a VERDICT, not an act: after `--apply` the abandoned record is still open on disk", async () => {
  await withTempHomeFixture("acpx-backfill-apply-", async (homeDir) => {
    await writeSessionRecordFile(homeDir, abandoned("candidate", homeDir));
    const applied = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.equal(applied.code, 0, `${applied.stderr}${applied.stdout}`);
    const report = JSON.parse(applied.stdout.trim()) as { sweep: { closed: string[] } };
    assert.deepEqual(report.sweep.closed, ["candidate"], "control: it IS a candidate");
    const stored = JSON.parse(
      await fs.readFile(path.join(homeDir, ".acpx", "sessions", "candidate.json"), "utf8"),
    ) as { closed?: boolean };
    assert.equal(stored.closed, false);
  });
});
