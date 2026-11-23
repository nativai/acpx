import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withTempHome } from "./runtime-test-helpers.js";

// Brick eadfe315 (lows-r4 TE: TE-1e13-3, TE-1e13-2): `acpx sessions archive` honours the global `--format json` / `--format quiet`
// and `--json-strict` like the other verbs, and its JSON carries an `intent` and wording that does not say "above". Each row
// runs the real built CLI against an isolated state home.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OLD_MS = 30 * 24 * 60 * 60 * 1000;

type Run = { code: number | null; stdout: string; stderr: string };

function run(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ACPX_STATE_HOME: home };
    delete env.ACPX_ARCHIVE_ALLOW_FIRST_RUN;
    delete env.ACPX_SESSIONS_ARCHIVE_DIR;
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [CLI, ...args], {
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

/** A hot dir with NO archive dir (a first run), optionally holding one old closed record. */
async function firstRunHome(home: string, withRecord = false): Promise<{ archiveDir: string }> {
  const hot = path.join(home, ".acpx", "sessions");
  await fs.mkdir(hot, { recursive: true });
  if (withRecord) {
    const file = path.join(hot, `${ID}.json`);
    const closedAt = new Date(Date.now() - OLD_MS).toISOString();
    await fs.writeFile(
      file,
      JSON.stringify({
        acpx_record_id: ID,
        closed: true,
        closed_at: closedAt,
        last_used_at: closedAt,
        cwd: "/tmp",
      }),
      "utf8",
    );
    const old = new Date(Date.now() - OLD_MS);
    await fs.utimes(file, old, old);
  }
  return { archiveDir: path.join(home, ".acpx", "sessions-archive") };
}

/** stdout must be exactly ONE JSON document. */
function oneDocument(stdout: string): Record<string, unknown> {
  const parsed = JSON.parse(stdout) as unknown; // throws on two documents or on text
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), stdout);
  return parsed as Record<string, unknown>;
}

test("`--format json` is `--json`: one document, an `intent`, and warnings that name the `plan` FIELD — never 'the plan above' (TE-1e13-2/3)", async () => {
  await withTempHome("acpx-archive-format-", async (home) => {
    const { archiveDir } = await firstRunHome(home);
    const dry = await run(["--format", "json", "sessions", "archive", "--dry-run"], home);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.stderr, "");
    const dryDoc = oneDocument(dry.stdout);
    assert.equal(dryDoc.intent, "dry-run");
    assert.deepEqual(dryDoc.warnings, [
      `First run: no archive directory exists yet at ${archiveDir}, so a real --apply would be held by D2 first-run gating and move nothing. Nothing was moved by this dry run either. The \`plan\` field is what WOULD move once the first run is allowed: --apply --allow-first-run (or set ACPX_ARCHIVE_ALLOW_FIRST_RUN=1).`,
    ]);

    const apply = await run(["--format", "json", "sessions", "archive", "--apply"], home);
    assert.equal(apply.code, 0, apply.stderr);
    assert.equal(apply.stderr, "");
    const applyDoc = oneDocument(apply.stdout);
    assert.equal(applyDoc.intent, "apply", "the STATED intent, though the gate held it");
    assert.equal(applyDoc.applied, false);
    assert.equal(applyDoc.firstRunGated, true);
    assert.deepEqual(applyDoc.warnings, [
      `--apply was honoured, but D2 first-run gating held it: no archive directory exists yet at ${archiveDir}, so this is this box's FIRST run and nothing was moved. The \`plan\` field is what WOULD move. Re-run with --apply --allow-first-run (or set ACPX_ARCHIVE_ALLOW_FIRST_RUN=1) to apply it.`,
    ]);
    assert.doesNotMatch(dry.stdout + apply.stdout, /plan above/u);
  });
});

test("the TEXT output keeps `the plan above`, and `--format text` is the default (control)", async () => {
  await withTempHome("acpx-archive-format-", async (home) => {
    await firstRunHome(home);
    const bare = await run(["sessions", "archive", "--dry-run"], home);
    const text = await run(["--format", "text", "sessions", "archive", "--dry-run"], home);
    assert.equal(bare.code, 0, bare.stderr);
    assert.match(bare.stdout, /^\[FIRST-RUN DRY RUN\]/u);
    assert.match(bare.stdout, /The plan above is what WOULD move/u);
    assert.equal(text.stdout.replace(/wave \S+/u, ""), bare.stdout.replace(/wave \S+/u, ""));
  });
});

test("`--format quiet`: one id per line — those that would move (dry run) or moved (apply) — and no report; a dry run with nothing selected prints nothing", async () => {
  await withTempHome("acpx-archive-format-", async (home) => {
    await firstRunHome(home, true);
    const dry = await run(
      ["--format", "quiet", "sessions", "archive", "--dry-run", "--allow-first-run"],
      home,
    );
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.stdout, `${ID}\n`);
    assert.doesNotMatch(dry.stdout, /DRY RUN|selected/u);
    const applied = await run(
      ["--format", "quiet", "sessions", "archive", "--apply", "--allow-first-run"],
      home,
    );
    assert.equal(applied.code, 0, applied.stderr);
    assert.equal(applied.stdout, `${ID}\n`);
    await fs.stat(path.join(home, ".acpx", "sessions-archive", `${ID}.json`)); // it really moved
    const again = await run(
      ["--format", "quiet", "sessions", "archive", "--dry-run", "--allow-first-run"],
      home,
    );
    assert.equal(again.stdout, "", "nothing left to move: nothing printed");
  });
});

test("`--json-strict` (with `--format json`): stdout is ONE document and stderr is EMPTY — for a dry run, a held apply, a refusal, a bad flag value and an unexpected error", async () => {
  await withTempHome("acpx-archive-format-", async (home) => {
    await firstRunHome(home);
    const strict = ["--format", "json", "--json-strict", "sessions", "archive"];
    const cases: Array<[string[], number, (doc: Record<string, unknown>) => void]> = [
      [
        ["--dry-run"],
        0,
        (doc) => {
          assert.equal(doc.intent, "dry-run");
        },
      ],
      [
        ["--apply"],
        0,
        (doc) => {
          assert.equal(doc.intent, "apply");
        },
      ],
      [
        [],
        2,
        (doc) => {
          assert.equal(doc.refused, true, "an unstated intent is a refusal DOCUMENT");
        },
      ],
      [
        ["--apply", "--closed-before", "bogus"],
        2,
        (doc) => {
          assert.equal(doc.refused, true);
          assert.match(JSON.stringify(doc), /--closed-before must be a day count/u);
        },
      ],
    ];
    for (const [extra, code, check] of cases) {
      const result = await run([...strict, ...extra], home);
      assert.equal(result.code, code, `${extra.join(" ")}: ${result.stderr}`);
      assert.equal(result.stderr, "", `${extra.join(" ")}: stderr is empty under --json-strict`);
      check(oneDocument(result.stdout));
    }
    // an unexpected error: no hot dir at all
    await withTempHome("acpx-archive-format-empty-", async (empty) => {
      const result = await run([...strict, "--dry-run"], empty);
      assert.equal(result.code, 1, result.stderr);
      assert.equal(result.stderr, "");
      const doc = oneDocument(result.stdout); // ONE document: the error is not printed twice
      assert.equal((doc.error as { code?: unknown }).code, "ENOENT");
    });
  });
});

test("`--json-strict` also silences the DETACHED-archive-dir warning that text mode writes to stderr (control: text mode writes it)", async () => {
  await withTempHome("acpx-archive-format-", async (home) => {
    await firstRunHome(home);
    const detached = { ACPX_SESSIONS_ARCHIVE_DIR: path.join(home, "elsewhere", "archive") };
    const text = await run(["sessions", "archive", "--dry-run"], home, detached);
    assert.match(text.stderr, /is not a sibling of the hot dir/u, "control: text mode warns");
    const strict = await run(
      ["--format", "json", "--json-strict", "sessions", "archive", "--dry-run"],
      home,
      detached,
    );
    assert.equal(strict.stderr, "");
    oneDocument(strict.stdout);
  });
});

test("NEGATIVE: `--json-strict` WITHOUT `--format json` is refused (exit 2, nothing on stdout), as every other verb refuses it", async () => {
  await withTempHome("acpx-archive-format-", async (home) => {
    await firstRunHome(home);
    for (const args of [
      ["--json-strict", "sessions", "archive", "--dry-run"],
      ["--format", "quiet", "--json-strict", "sessions", "archive", "--dry-run"],
    ]) {
      const result = await run(args, home);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /--json-strict requires --format json/u);
    }
  });
});

test("a `--compress` / `--decompress` refusal keeps its OWN envelope as the single document (no second `{refused}` is added), and is stderr-clean under `--json-strict`", async () => {
  await withTempHome("acpx-archive-format-", async (home) => {
    await firstRunHome(home);
    for (const [flag, action] of [
      ["--compress", "compress"],
      ["--decompress", "decompress"],
    ] as const) {
      const result = await run(
        ["--format", "json", "--json-strict", "sessions", "archive", flag, "--all"],
        home,
      );
      assert.equal(result.code, 2, result.stderr);
      assert.equal(result.stderr, "");
      const doc = oneDocument(result.stdout);
      assert.equal(doc.action, action);
      assert.equal(doc.outcome, "refused");
      assert.equal(doc.refused, undefined, "not wrapped a second time");
    }
  });
});
