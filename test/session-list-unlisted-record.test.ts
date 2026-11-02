import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listUnlistedRecordFiles } from "../src/session/persistence.js";
import { withTempHome } from "./runtime-test-helpers.js";

// Brick 929670fc (REG-2, from G5's test-engineer F-2) — ONE non-string value in a record's `metadata`
// (Record<string,string> only) used to make the whole record vanish from `acpx sessions list --local` with no trace.
// The reader's contract is "drop what cannot be loaded; the listing still succeeds" (one bad record must not hide the
// rest of the store), so the fix keeps the drop and REPORTS it: named on stderr, stdout unchanged. Never silent.
//
// REAL RECORD SHAPE: `real-fork-3a241311.json` (sampled read-only from devbox 2026-10-07, see byway-guard.test.ts) —
// its `metadata` is two string values. The bad record is that same record with one value turned into a JSON number.
// Driven as the REAL compiled CLI against a temp HOME.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const FIXTURE = path.join(
  process.cwd(),
  "test",
  "fixtures",
  "byway-records",
  "real-fork-3a241311.json",
);
const CLEAN_ID = "3a241311-4a19-4f36-b9df-f1d290bc3cac";
const BAD_ID = "bbbbbbbb-4a19-4f36-b9df-f1d290bc3cac";

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function plant(
  homeDir: string,
  id: string,
  edit: (raw: Record<string, unknown>) => void,
): Promise<void> {
  const raw = JSON.parse(await fs.readFile(FIXTURE, "utf8")) as Record<string, unknown>;
  raw.acpx_record_id = id;
  raw.acp_session_id = id;
  raw.agent_session_id = id;
  edit(raw);
  const dir = path.join(homeDir, ".acpx", "sessions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

const listJson = (homeDir: string, extra: string[] = []) =>
  runCli(
    ["--cwd", homeDir, "--format", "json", ...extra, "claude", "sessions", "list", "--local"],
    homeDir,
  );

const listedIds = (result: CliResult): string[] =>
  (JSON.parse(result.stdout) as Array<{ acpxRecordId: string }>).map(
    (record) => record.acpxRecordId,
  );

test("sessions list --local · a record with ONE non-string metadata value is not listed but NAMED on stderr; the clean record beside it is listed", async () => {
  await withTempHome("acpx-list-unlisted-", async (homeDir) => {
    await plant(homeDir, CLEAN_ID, () => {});
    await plant(homeDir, BAD_ID, (raw) => {
      (raw.metadata as Record<string, unknown>).brick_validation = 42;
    });
    // A dotted sidecar is not a record: it must NOT be reported as one that went missing.
    await fs.writeFile(
      path.join(homeDir, ".acpx", "sessions", `${CLEAN_ID}.delivery.json`),
      "{}\n",
      "utf8",
    );

    const result = await listJson(homeDir);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      listedIds(result),
      [CLEAN_ID],
      "control: the clean record is listed, the bad one is not",
    );
    assert.match(
      result.stderr,
      new RegExp(
        `WARNING: session record ${BAD_ID}\\.json is not listed: metadata\\.brick_validation is number`,
      ),
    );
    assert.ok(
      !result.stderr.includes(`${CLEAN_ID}.json is not listed`),
      "the clean record was reported",
    );
    assert.ok(
      !result.stderr.includes("delivery.json"),
      "a dotted sidecar was reported as a lost record",
    );
    // The report repeats on the NEXT list: it is not an index-rebuild one-off.
    const again = await listJson(homeDir);
    assert.match(again.stderr, new RegExp(`${BAD_ID}\\.json is not listed`));
  });
});

test("sessions list --local · NEGATIVE — a store of clean records reports nothing", async () => {
  await withTempHome("acpx-list-unlisted-clean-", async (homeDir) => {
    await plant(homeDir, CLEAN_ID, () => {});
    const result = await listJson(homeDir);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(listedIds(result), [CLEAN_ID]);
    assert.ok(
      !result.stderr.includes("not listed"),
      `a clean store was reported: ${result.stderr}`,
    );
  });
});

test("sessions list --local · --json-strict keeps stderr machine-clean (the report is suppressed, stdout still a bare array)", async () => {
  await withTempHome("acpx-list-unlisted-strict-", async (homeDir) => {
    await plant(homeDir, CLEAN_ID, () => {});
    await plant(homeDir, BAD_ID, (raw) => {
      (raw.metadata as Record<string, unknown>).brick_validation = 42;
    });
    const result = await listJson(homeDir, ["--json-strict"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(listedIds(result), [CLEAN_ID]);
    // (Not `stderr === ""`: the real fixture has no messages log, and acpx's own "messages log missing" notice is another
    // line's business.)
    assert.ok(
      !result.stderr.includes("not listed"),
      `--json-strict must not carry the report: ${result.stderr}`,
    );
  });
});

test("sessions list --local · a record that is ALREADY indexed and goes bad afterwards (numeric metadata; invalid JSON) is named exactly once on the next list", async () => {
  for (const [label, corrupt, reason] of [
    [
      "numeric metadata",
      async (file: string) => {
        const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
        (raw.metadata as Record<string, unknown>).brick_validation = 42;
        await fs.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
      },
      /metadata\.brick_validation is number, not a string/,
    ],
    [
      "invalid JSON",
      async (file: string) => {
        await fs.writeFile(file, "{not json", "utf8");
      },
      /unreadable: /,
    ],
  ] as const) {
    await withTempHome("acpx-list-unlisted-indexed-", async (homeDir) => {
      await plant(homeDir, CLEAN_ID, () => {});
      await plant(homeDir, BAD_ID, () => {});
      const before = await listJson(homeDir);
      assert.deepEqual(
        listedIds(before).toSorted(),
        [BAD_ID, CLEAN_ID].toSorted(),
        `${label}: both listed first (the index entry now exists)`,
      );
      assert.ok(!before.stderr.includes("not listed"), `${label}: a healthy store reports nothing`);

      await corrupt(path.join(homeDir, ".acpx", "sessions", `${BAD_ID}.json`));
      const after = await listJson(homeDir);
      assert.equal(after.code, 0, after.stderr);
      assert.deepEqual(
        listedIds(after),
        [CLEAN_ID],
        `${label}: the corrupted record is not listed, the clean one is`,
      );
      const lines = after.stderr.split("\n").filter((line) => line.includes("not listed"));
      assert.equal(lines.length, 1, `${label}: exactly one report, got: ${after.stderr}`);
      assert.match(
        lines[0] ?? "",
        new RegExp(`WARNING: session record ${BAD_ID}\\.json is not listed: `),
      );
      assert.match(lines[0] ?? "", reason);

      const strict = await listJson(homeDir, ["--json-strict"]);
      assert.deepEqual(listedIds(strict), [CLEAN_ID]);
      assert.ok(!strict.stderr.includes("not listed"), `${label}: --json-strict stays clean`);
    });
  }
});

test("listUnlistedRecordFiles · a record that is not valid JSON is named too (never only the metadata case)", async () => {
  await withTempHome("acpx-list-unlisted-corrupt-", async (homeDir) => {
    await plant(homeDir, CLEAN_ID, () => {});
    await fs.writeFile(
      path.join(homeDir, ".acpx", "sessions", `${BAD_ID}.json`),
      "{not json",
      "utf8",
    );
    const unlisted = await listUnlistedRecordFiles();
    assert.deepEqual(
      unlisted.map((row) => row.file),
      [`${BAD_ID}.json`],
    );
    assert.match(unlisted[0]?.reason ?? "", /^unreadable: /);
  });
});
