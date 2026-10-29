import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFullSourceHistory } from "../src/cli/session/fork-at-log-index.js";
import { runCompressSweep } from "../src/session/archive/compress-sweep.js";
import { encodeArchiveZst, zstNameFor } from "../src/session/archive/compressed.js";
import { createContext, runRestore } from "../src/session/archive/operations.js";
import { resolveSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionMessage } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import { removeTempHome, withTempHome } from "./temp-home.js";

// Brick 1861b06d, Lane A — `acpx-archive-zst/v1` driven as the REAL compiled CLI against a
// temp HOME (cli-contract.md is the surface under test). Fixtures are synthetic but shaped
// like a real archived session: a record with a messages-log watermark, an active stream,
// a rotated segment, a messages log and a timestamps sidecar, all with old mtimes.
//
// Every guarantee the contract publishes carries a NEGATIVE case here (a corrupt file, a
// missing init, a held lock, a non-empty --to, …) — never a mutation of the product.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const OLD_MTIME_MS = Date.parse("2026-09-02T03:04:05.678Z");
/**
 * ⚠️ NOT `utimes(p, ms / 1000, …)`: node truncates float seconds to the µs, so that lands on
 * `….677999` and every "mtime kept" assertion below would compare against a value the
 * fixture never had. Same rounding as the product's `setMtime`.
 */
const OLD_MTIME_S = (Math.round(OLD_MTIME_MS * 1000) + 0.5) / 1e6;

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(
  home: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extraEnv };
    delete env.ACPX_STATE_HOME;
    delete env.ACPX_SESSIONS_ARCHIVE_DIR;
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.on("close", (code, signal) =>
      resolve({ code: code ?? (signal ? -1 : null), stdout, stderr }),
    );
  });
}

function sha(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

type Fixture = {
  home: string;
  hot: string;
  archive: string;
  id: string;
  logical: Record<string, Buffer>;
  messageCount: number;
};

function messageLines(count: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const message: SessionMessage =
      i % 2 === 0
        ? { User: { id: `u${i}`, content: [{ Text: `question ${i}` }] } }
        : {
            Agent: {
              content: [{ Text: `answer ${i} ${"lorem ipsum ".repeat(12)}` }],
              tool_results: {},
            },
          };
    lines.push(JSON.stringify(message));
  }
  return lines;
}

function streamLines(count: number, offset = 0): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `chunk ${i + offset} ${"x".repeat(40)}` },
          },
        },
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** One archived session, as the archive wave leaves it (rename keeps old mtimes). */
async function writeArchivedSession(
  home: string,
  id: string,
  messageCount = 260,
): Promise<Fixture> {
  const hot = path.join(home, ".acpx", "sessions");
  const archive = path.join(home, ".acpx", "sessions-archive");
  await fs.mkdir(hot, { recursive: true });
  await fs.mkdir(archive, { recursive: true });
  const log = Buffer.from(`${messageLines(messageCount).join("\n")}\n`);
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: id,
    agentCommand: "claude",
    cwd: home,
    closed: true,
    closedAt: "2026-09-02T00:00:00.000Z",
    eventLog: {
      active_path: `${id}.stream.ndjson`,
      segment_count: 2,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: "2026-09-02T00:00:00.000Z",
      last_write_error: null,
    },
  });
  record.messagesLog = { v: 1, count: messageCount, base_index: 0, bytes: log.length };
  const logical: Record<string, Buffer> = {
    [`${id}.messages.ndjson`]: log,
    [`${id}.stream.ndjson`]: Buffer.from(streamLines(900)),
    [`${id}.stream.1.ndjson`]: Buffer.from(streamLines(700, 900)),
    [`${id}.timestamps.ndjson`]: Buffer.from(
      Array.from({ length: 400 }, (_, i) =>
        JSON.stringify({ o: i * 97, t: 1_788_000_000_000 + i }),
      ).join("\n"),
    ),
  };
  for (const [name, data] of Object.entries(logical)) {
    await fs.writeFile(path.join(archive, name), data);
  }
  // `split-tail`: the record carries the `messages_log` watermark, as every real one does.
  const onDisk = serializeSessionRecordForDisk(record, { messages: "split-tail" });
  const recordBytes = Buffer.from(`${JSON.stringify(onDisk, undefined, 2)}\n`);
  await fs.writeFile(path.join(archive, `${id}.json`), recordBytes);
  logical[`${id}.json`] = recordBytes;
  for (const name of Object.keys(logical)) {
    await fs.utimes(path.join(archive, name), OLD_MTIME_S, OLD_MTIME_S);
  }
  return { home, hot, archive, id, logical, messageCount };
}

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  id = "0a0a0a0a-1111-4222-8333-444455556666",
): Promise<void> {
  await withTempHome("acpx-zst-cli-", async (home) => {
    await run(await writeArchivedSession(home, id));
  });
}

const COMPRESS_INIT = [
  "sessions",
  "archive",
  "--compress",
  "--apply",
  "--initialize",
  "--skip-reader-check",
  "--json",
];

async function compressAll(fixture: Fixture): Promise<Record<string, unknown>> {
  const result = await runCli(fixture.home, COMPRESS_INIT);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function listing(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).toSorted();
}

/** Names, sizes and mtimes of a tree — the "wrote nothing" witness. */
async function treeFingerprint(dir: string): Promise<string> {
  const rows: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        rows.push(`d ${path.relative(dir, full)}`);
        await walk(full);
      } else {
        const stat = await fs.stat(full);
        rows.push(`f ${path.relative(dir, full)} ${stat.size} ${stat.mtimeMs}`);
      }
    }
  };
  await walk(dir);
  return rows.join("\n");
}

function corruptCopy(data: Buffer, offset: number): Buffer {
  const copy = Buffer.from(data);
  copy[offset] ^= 0xff;
  return copy;
}

// ─── the sweep: gating, dry-run, apply ────────────────────────────────────────

test("--compress --apply without --initialize on a box with no COMPRESSION/: exit 2 compression-not-initialized, writes NOTHING", async () => {
  await withFixture(async (fixture) => {
    const before = await treeFingerprint(fixture.archive);
    const result = await runCli(fixture.home, [
      "sessions",
      "archive",
      "--compress",
      "--apply",
      "--skip-reader-check",
      "--json",
    ]);
    assert.equal(result.code, 2);
    const body = JSON.parse(result.stdout) as {
      outcome: string;
      error: { code: string };
      applied: boolean;
    };
    assert.equal(body.outcome, "compression-not-initialized");
    assert.equal(body.error.code, "compression-not-initialized");
    assert.equal(body.applied, false);
    assert.equal(await treeFingerprint(fixture.archive), before);
  });
});

test("--compress with no intent is refused (exit 2); --dry-run writes nothing — not even COMPRESSION/ — and reports an estimate", async () => {
  await withFixture(async (fixture) => {
    const unstated = await runCli(fixture.home, ["sessions", "archive", "--compress", "--json"]);
    assert.equal(unstated.code, 2);
    assert.equal(
      (JSON.parse(unstated.stdout) as { error: { code: string } }).error.code,
      "intent-unstated",
    );

    const before = await treeFingerprint(fixture.archive);
    const dry = await runCli(fixture.home, [
      "sessions",
      "archive",
      "--compress",
      "--dry-run",
      "--json",
    ]);
    assert.equal(dry.code, 0, dry.stderr);
    const body = JSON.parse(dry.stdout) as {
      outcome: string;
      selected: number;
      eligible: { files: number };
      estimate: { ratio: number } | null;
      compressed: unknown[];
    };
    assert.equal(body.outcome, "dry-run");
    assert.equal(body.eligible.files, 4, "the four families — never the record");
    assert.equal(body.selected, 4);
    assert.ok(body.estimate && body.estimate.ratio > 0 && body.estimate.ratio < 1);
    assert.deepEqual(body.compressed, []);
    assert.equal(await treeFingerprint(fixture.archive), before);
  });
});

test("--compress --apply --initialize: four .zst, record plain, mtimes kept, journal + run record + README; a re-run compresses nothing twice", async () => {
  await withFixture(async (fixture) => {
    const body = (await compressAll(fixture)) as {
      outcome: string;
      initialized: boolean;
      compressed: { file: string; logicalSha256: string }[];
      bytesBefore: number;
      bytesAfter: number;
      wave: string;
    };
    assert.equal(body.outcome, "applied");
    assert.equal(body.initialized, true);
    assert.equal(body.compressed.length, 4);
    assert.ok(body.bytesAfter < body.bytesBefore / 4);
    for (const entry of body.compressed) {
      assert.equal(entry.logicalSha256, sha(fixture.logical[entry.file]), entry.file);
    }
    const names = await listing(fixture.archive);
    assert.ok(names.includes(`${fixture.id}.json`), "the record is NEVER compressed");
    assert.ok(!names.includes(`${fixture.id}.json.zst`));
    for (const name of Object.keys(fixture.logical).filter((n) => !n.endsWith(".json"))) {
      assert.ok(names.includes(zstNameFor(name)), name);
      assert.ok(!names.includes(name), `${name}: the plain is gone once its verified .zst exists`);
      const stat = await fs.stat(path.join(fixture.archive, zstNameFor(name)));
      assert.equal(Math.floor(stat.mtimeMs), OLD_MTIME_MS, `${name}: mtime carried`);
    }
    const journal = await fs.readFile(
      path.join(fixture.archive, "COMPRESSION", "journal.tsv"),
      "utf8",
    );
    assert.match(
      journal,
      /^at\twave\taction\tfile\tlogical_bytes\tlogical_sha256\tzst_bytes\tzst_sha256\tverified\tdetail\n/,
    );
    assert.equal(journal.match(/\tbegin\t/g)?.length, 4);
    assert.equal(journal.match(/\tcompress\t/g)?.length, 4);
    assert.ok(names.includes("README.md"));
    assert.match(
      await fs.readFile(path.join(fixture.archive, "README.md"), "utf8"),
      /acpx-archive-zst\/v1/,
    );
    await fs.access(path.join(fixture.archive, "COMPRESSION", "runs", `${body.wave}.json`));

    const again = await runCli(fixture.home, [
      "sessions",
      "archive",
      "--compress",
      "--apply",
      "--skip-reader-check",
      "--json",
    ]);
    assert.equal(again.code, 0, again.stderr);
    assert.equal((JSON.parse(again.stdout) as { compressed: unknown[] }).compressed.length, 0);
  });
});

test("--max-bytes stops BEFORE the file that would exceed it; --limit caps the count", async () => {
  await withFixture(async (fixture) => {
    const sizes = Object.entries(fixture.logical)
      .filter(([name]) => !name.endsWith(".json"))
      .map(([name, data]) => [name, data.length] as const)
      .toSorted(([a], [b]) => a.localeCompare(b));
    const budget = sizes[0][1] + sizes[1][1];
    const result = await runCli(fixture.home, [...COMPRESS_INIT, "--max-bytes", String(budget)]);
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout) as {
      compressed: { file: string }[];
      budget: { exhausted: boolean };
      bytesBefore: number;
    };
    assert.ok(body.bytesBefore <= budget);
    assert.deepEqual(
      body.compressed.map((entry) => entry.file),
      [sizes[0][0], sizes[1][0]],
    );
    assert.equal(body.budget.exhausted, true);
    const limited = await runCli(fixture.home, [
      "sessions",
      "archive",
      "--compress",
      "--apply",
      "--skip-reader-check",
      "--json",
      "--limit",
      "1",
    ]);
    assert.equal((JSON.parse(limited.stdout) as { compressed: unknown[] }).compressed.length, 1);
  });
});

test("a second sweep while the lock is held: exit 2 lock-held, nothing compressed", async () => {
  await withFixture(async (fixture) => {
    await fs.mkdir(path.join(fixture.archive, "COMPRESSION"), { recursive: true });
    // A live holder in this pid namespace — the test process itself — is never taken over.
    await fs.writeFile(
      path.join(fixture.archive, "COMPRESSION", ".lock"),
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }),
    );
    const result = await runCli(fixture.home, [
      "sessions",
      "archive",
      "--compress",
      "--apply",
      "--skip-reader-check",
      "--json",
    ]);
    assert.equal(result.code, 2, result.stderr);
    const body = JSON.parse(result.stdout) as { outcome: string; compressed: unknown[] };
    assert.equal(body.outcome, "lock-held");
    assert.deepEqual(body.compressed, []);
    assert.ok((await listing(fixture.archive)).includes(`${fixture.id}.stream.ndjson`));
  });
});

test("selection: a half-restored id (record hot) and a file whose last MANIFEST row is `restore` are never compressed", async () => {
  await withTempHome("acpx-zst-cli-", async (home) => {
    const half = await writeArchivedSession(home, "1b1b1b1b-1111-4222-8333-444455556666");
    const interrupted = await writeArchivedSession(home, "2c2c2c2c-1111-4222-8333-444455556666");
    await fs.rename(
      path.join(half.archive, `${half.id}.json`),
      path.join(half.hot, `${half.id}.json`),
    );
    const restoredFile = `${interrupted.id}.messages.ndjson`;
    const header =
      "at\twave\taction\tid\treason\tclosed\tclosed_at\tlast_used_at\tkind\tname\tbrick\tfile\tbytes\tmtime";
    const row = [
      "2026-10-01T00:00:00.000Z",
      "restore-x",
      "restore",
      interrupted.id,
      "restore",
      "",
      "",
      "",
      "",
      "",
      "",
      restoredFile,
      "1",
      "2026-09-02T00:00:00.000Z",
    ].join("\t");
    await fs.writeFile(
      path.join(home, ".acpx", "sessions-archive", "MANIFEST.tsv"),
      `${header}\n${row}\n`,
    );
    const result = await runCli(home, COMPRESS_INIT);
    assert.equal(result.code, 0, result.stderr);
    const compressed = (
      JSON.parse(result.stdout) as { compressed: { file: string }[] }
    ).compressed.map((entry) => entry.file);
    assert.ok(
      compressed.every((file) => !file.startsWith(half.id)),
      "the half-restored id is untouched",
    );
    assert.ok(!compressed.includes(restoredFile), "a restore-row file belongs to --repair");
    assert.equal(compressed.filter((file) => file.startsWith(interrupted.id)).length, 3);
  });
});

// ─── both forms (AC-7) ────────────────────────────────────────────────────────

test("AC-7 both forms, identical: readers use the plain; the next sweep unlinks the plain and keeps the .zst", async () => {
  await withFixture(async (fixture) => {
    const name = `${fixture.id}.stream.ndjson`;
    await fs.writeFile(
      path.join(fixture.archive, zstNameFor(name)),
      encodeArchiveZst(fixture.logical[name]),
    );
    const cat = await runCli(fixture.home, ["sessions", "archive", "--cat", name]);
    assert.equal(sha(cat.stdout), sha(fixture.logical[name]));
    const body = (await compressAll(fixture)) as { resolved: { file: string }[] };
    assert.deepEqual(
      body.resolved.map((entry) => entry.file),
      [name],
    );
    const names = await listing(fixture.archive);
    assert.ok(!names.includes(name) && names.includes(zstNameFor(name)));
  });
});

test("AC-7 both forms, diverging: readers return the PLAIN; the sweep keeps it, quarantines the .zst, exits 1 naming the conflict", async () => {
  await withFixture(async (fixture) => {
    const name = `${fixture.id}.messages.ndjson`;
    await fs.writeFile(
      path.join(fixture.archive, zstNameFor(name)),
      encodeArchiveZst(Buffer.from("a DIFFERENT history\n".repeat(400))),
    );
    const read = await runCli(fixture.home, ["sessions", "archive", "--cat", name]);
    assert.equal(sha(read.stdout), sha(fixture.logical[name]), "plain wins");
    const result = await runCli(fixture.home, COMPRESS_INIT);
    assert.equal(result.code, 1, result.stderr);
    const body = JSON.parse(result.stdout) as { conflicts: { file: string; reason: string }[] };
    assert.deepEqual(body.conflicts, [{ file: name, reason: "zst-differs-from-plain" }]);
    assert.equal(
      sha(await fs.readFile(path.join(fixture.archive, name))),
      sha(fixture.logical[name]),
    );
    assert.ok(!(await listing(fixture.archive)).includes(zstNameFor(name)));
    assert.equal(
      (await listing(path.join(fixture.archive, "COMPRESSION", "quarantine"))).length,
      1,
    );
  });
});

test("AC-2 a corrupt .zst PLUS its plain: the sweep keeps the plain unchanged and quarantines the .zst", async () => {
  await withFixture(async (fixture) => {
    const name = `${fixture.id}.timestamps.ndjson`;
    const encoded = encodeArchiveZst(fixture.logical[name]);
    await fs.writeFile(path.join(fixture.archive, zstNameFor(name)), encoded.subarray(0, -5));
    const result = await runCli(fixture.home, COMPRESS_INIT);
    assert.equal(result.code, 1);
    const body = JSON.parse(result.stdout) as { quarantined: { file: string; check: string }[] };
    assert.deepEqual(body.quarantined, [
      { file: name, reason: "zst-corrupt-plain-kept", check: "footer" },
    ]);
    assert.equal(
      sha(await fs.readFile(path.join(fixture.archive, name))),
      sha(fixture.logical[name]),
    );
  });
});

// ─── readers (AC-3) ───────────────────────────────────────────────────────────

test("AC-3 A1: `sessions read` / `history` (text + json) are byte-identical before and after compression", async () => {
  await withFixture(async (fixture) => {
    const views = [
      ["sessions", "read", "--session-id", fixture.id],
      ["--format", "json", "sessions", "read", "--session-id", fixture.id],
      ["--format", "json", "sessions", "history", "--session-id", fixture.id],
      ["--format", "json", "sessions", "show", "--session-id", fixture.id],
    ];
    const before: string[] = [];
    for (const view of views) {
      const result = await runCli(fixture.home, view);
      assert.equal(result.code, 0, `${view.join(" ")}: ${result.stderr}`);
      before.push(result.stdout);
    }
    assert.match(before[0], /question 258/, "the hydrated window reaches the log's tail");
    await compressAll(fixture);
    for (const [index, view] of views.entries()) {
      const result = await runCli(fixture.home, view);
      assert.equal(result.code, 0, `${view.join(" ")}: ${result.stderr}`);
      assert.equal(result.stdout, before[index], view.join(" "));
    }
  });
});

test("AC-2 a corrupt messages .zst: `sessions read` exits NON-ZERO naming the file — never 'Session not found', never empty history", async () => {
  await withFixture(async (fixture) => {
    await compressAll(fixture);
    const zst = path.join(fixture.archive, zstNameFor(`${fixture.id}.messages.ndjson`));
    await fs.writeFile(zst, corruptCopy(await fs.readFile(zst), 30));
    for (const view of [
      ["sessions", "read", "--session-id", fixture.id],
      [
        "sessions",
        "export",
        "--session-id",
        fixture.id,
        "--output",
        path.join(fixture.home, "x.json"),
      ],
    ]) {
      const result = await runCli(fixture.home, view);
      assert.notEqual(result.code, 0, view.join(" "));
      assert.match(
        `${result.stderr}${result.stdout}`,
        /ARCHIVED_FILE_CORRUPT \S+\.messages\.ndjson\.zst \((frame|hash|size)\)/,
      );
      assert.doesNotMatch(
        `${result.stderr}${result.stdout}`,
        /not found/i,
        "a corrupt log must not read as a lookup miss",
      );
      assert.doesNotMatch(result.stdout, /question \d+/, "no transcript printed");
    }
  });
});

test("AC-3 A9: `sessions export` of an archived session carries its FULL history (pre-existing defect: it exported none)", async () => {
  await withFixture(async (fixture) => {
    for (const phase of ["plain", "compressed"]) {
      if (phase === "compressed") {
        await compressAll(fixture);
      }
      const out = path.join(fixture.home, `export-${phase}.json`);
      const result = await runCli(fixture.home, [
        "sessions",
        "export",
        "--session-id",
        fixture.id,
        "--output",
        out,
      ]);
      assert.equal(result.code, 0, result.stderr);
      const exported = JSON.parse(await fs.readFile(out, "utf8")) as {
        history: unknown[];
        messages_log?: { data: string };
      };
      assert.equal(
        exported.messages_log?.data,
        fixture.logical[`${fixture.id}.messages.ndjson`].toString(),
        phase,
      );
      assert.equal(
        exported.history.length,
        1600,
        `${phase}: 900 active + 700 rotated stream events`,
      );
    }
  });
});

test("AC-3 A10: forking from an archived session inherits the source's FULL message count, plain and compressed", async () => {
  await withFixture(async (fixture) => {
    const previous = process.env.ACPX_STATE_HOME;
    process.env.ACPX_STATE_HOME = fixture.home;
    try {
      for (const phase of ["plain", "compressed"]) {
        if (phase === "compressed") {
          await compressAll(fixture);
        }
        const source = await resolveSessionRecord(fixture.id);
        const history = await readFullSourceHistory(source);
        assert.equal(
          history.messages.length,
          fixture.messageCount,
          `${phase}: the whole log, not the inline tail`,
        );
      }
    } finally {
      if (previous === undefined) {
        delete process.env.ACPX_STATE_HOME;
      } else {
        process.env.ACPX_STATE_HOME = previous;
      }
    }
  });
});

// ─── verify / repair (A3, A4) ─────────────────────────────────────────────────

async function writeArchiveManifest(
  fixture: Fixture,
  action: "archive" | "restore",
): Promise<void> {
  const header =
    "at\twave\taction\tid\treason\tclosed\tclosed_at\tlast_used_at\tkind\tname\tbrick\tfile\tbytes\tmtime";
  const rows = Object.entries(fixture.logical).map(([file, data]) =>
    [
      "2026-09-16T00:00:00.000Z",
      "w",
      action,
      fixture.id,
      action === "archive" ? "closed" : "restore",
      "",
      "",
      "",
      "",
      "",
      "",
      file,
      String(data.length),
      "2026-09-02T03:04:05.678Z",
    ].join("\t"),
  );
  await fs.writeFile(path.join(fixture.archive, "MANIFEST.tsv"), `${header}\n${rows.join("\n")}\n`);
}

test("A3 --verify: a compressed file is PRESENT, not LOST; --verify --deep decodes every .zst and exits 1 on a corrupt one", async () => {
  await withFixture(async (fixture) => {
    await writeArchiveManifest(fixture, "archive");
    await compressAll(fixture);
    const verify = await runCli(fixture.home, [
      "sessions",
      "archive",
      "--verify",
      "--deep",
      "--json",
    ]);
    assert.equal(verify.code, 0, verify.stdout);
    const ok = JSON.parse(verify.stdout) as {
      checked: number;
      problems: unknown[];
      deepChecked: number;
      corrupt: unknown[];
    };
    assert.equal(ok.checked, 5);
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.deepChecked, 4);
    const zst = path.join(fixture.archive, zstNameFor(`${fixture.id}.stream.1.ndjson`));
    await fs.writeFile(zst, corruptCopy(await fs.readFile(zst), (await fs.stat(zst)).size - 3));
    const bad = await runCli(fixture.home, ["sessions", "archive", "--verify", "--deep", "--json"]);
    assert.equal(bad.code, 1);
    assert.deepEqual((JSON.parse(bad.stdout) as { corrupt: unknown[] }).corrupt, [
      { file: `${fixture.id}.stream.1.ndjson`, check: "hash" },
    ]);
  });
});

test("A4 --repair: a restore row + a hot plain + an identical archive .zst (crash after the hot link) ⇒ the .zst is unlinked", async () => {
  await withFixture(async (fixture) => {
    await compressAll(fixture);
    const name = `${fixture.id}.messages.ndjson`;
    await fs.writeFile(path.join(fixture.hot, name), fixture.logical[name]);
    await writeArchiveManifest(fixture, "archive");
    const manifest = path.join(fixture.archive, "MANIFEST.tsv");
    const restoreRow = [
      "2026-10-01T00:00:00.000Z",
      "r",
      "restore",
      fixture.id,
      "restore",
      "",
      "",
      "",
      "",
      "",
      "",
      name,
      "1",
      "2026-09-02T03:04:05.678Z",
    ].join("\t");
    await fs.appendFile(manifest, `${restoreRow}\n`);
    const repair = await runCli(fixture.home, ["sessions", "archive", "--repair", "--json"]);
    assert.equal(repair.code, 0, repair.stdout);
    assert.deepEqual((JSON.parse(repair.stdout) as { completed: unknown[] }).completed, [
      { file: name, direction: "to-hot" },
    ]);
    assert.ok(!(await listing(fixture.archive)).includes(zstNameFor(name)));
    assert.equal(sha(await fs.readFile(path.join(fixture.hot, name))), sha(fixture.logical[name]));
  });
});

// ─── restore (A2, AC-2, AC-3) ─────────────────────────────────────────────────

test("A2 restore of a compressed session: hot files byte-identical to the originals, mtimes kept, no .zst in the hot dir, logical MANIFEST rows", async () => {
  await withFixture(async (fixture) => {
    await compressAll(fixture);
    const result = await runCli(fixture.home, ["sessions", "restore", fixture.id, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout) as {
      restored: { files: string[]; decompressed: string[]; bytes: number }[];
      skipped: unknown[];
      failures: unknown[];
    };
    assert.equal(body.restored.length, 1);
    assert.equal(body.restored[0].files.at(-1), `${fixture.id}.json`, "the record lands LAST");
    assert.equal(body.restored[0].decompressed.length, 4);
    const total = Object.values(fixture.logical).reduce((sum, data) => sum + data.length, 0);
    assert.equal(body.restored[0].bytes, total, "logical bytes");
    for (const [name, data] of Object.entries(fixture.logical)) {
      const target = path.join(fixture.hot, name);
      assert.equal(sha(await fs.readFile(target)), sha(data), name);
      assert.equal(Math.floor((await fs.stat(target)).mtimeMs), OLD_MTIME_MS, `${name}: mtime`);
    }
    assert.ok((await listing(fixture.hot)).every((name) => !name.endsWith(".zst")));
    assert.ok((await listing(fixture.archive)).every((name) => !name.startsWith(fixture.id)));
    const manifest = await fs.readFile(path.join(fixture.archive, "MANIFEST.tsv"), "utf8");
    assert.ok(!manifest.includes(".zst"), "MANIFEST names LOGICAL files");
    assert.ok(
      manifest.includes(
        `\t${fixture.id}.stream.ndjson\t${fixture.logical[`${fixture.id}.stream.ndjson`].length}\t`,
      ),
    );
  });
});

test("AC-2 restore of an id with a corrupt .zst: refused WHOLE — skipped ARCHIVED_FILE_CORRUPT, no hot file of the id, the .zst byte-identical", async () => {
  await withFixture(async (fixture) => {
    await compressAll(fixture);
    const zst = path.join(fixture.archive, zstNameFor(`${fixture.id}.stream.ndjson`));
    const corrupt = corruptCopy(await fs.readFile(zst), 20);
    await fs.writeFile(zst, corrupt);
    const result = await runCli(fixture.home, ["sessions", "restore", fixture.id, "--json"]);
    assert.equal(result.code, 1);
    const body = JSON.parse(result.stdout) as {
      restored: unknown[];
      skipped: { reason: string; file: string }[];
    };
    assert.deepEqual(body.restored, []);
    assert.equal(body.skipped[0].reason, "ARCHIVED_FILE_CORRUPT");
    assert.equal(body.skipped[0].file, `${fixture.id}.stream.ndjson`);
    assert.ok(
      (await listing(fixture.hot)).every((name) => !name.startsWith(fixture.id)),
      "no hot file created",
    );
    assert.equal(sha(await fs.readFile(zst)), sha(corrupt));
    assert.deepEqual(
      await listing(path.join(fixture.archive, "COMPRESSION", "staging")),
      [],
      "no staged temp left",
    );
  });
});

test("AC-7(c) restore with both forms present: the hot dir gets the PLAIN's bytes", async () => {
  await withFixture(async (fixture) => {
    const name = `${fixture.id}.messages.ndjson`;
    await fs.writeFile(
      path.join(fixture.archive, zstNameFor(name)),
      encodeArchiveZst(Buffer.from("stale other bytes\n".repeat(400))),
    );
    const result = await runCli(fixture.home, ["sessions", "restore", fixture.id, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(sha(await fs.readFile(path.join(fixture.hot, name))), sha(fixture.logical[name]));
  });
});

test("AC-8 restore racing a sweep in one process (10 rounds): always exactly one complete copy, never a truncated hot file", async () => {
  for (let round = 0; round < 10; round += 1) {
    await withFixture(
      async (fixture) => {
        const previous = process.env.ACPX_STATE_HOME;
        process.env.ACPX_STATE_HOME = fixture.home;
        try {
          await fs.mkdir(path.join(fixture.archive, "COMPRESSION", "staging"), { recursive: true });
          const context = createContext(fixture.hot, `race-${round}`);
          await Promise.all([
            runRestore(context, [fixture.id]),
            runCompressSweep({
              context,
              apply: true,
              initialize: false,
              skipReaderCheck: true,
              readerProbe: async () => ({ ok: true }),
              runtimeInfoPath: "/nonexistent/info.json",
            }),
          ]);
          // Wherever each file ended up, its logical bytes exist exactly once.
          const leftover = await runRestore(createContext(fixture.hot, `race-${round}-b`), [
            fixture.id,
          ]);
          assert.deepEqual(leftover.failures, [], `round ${round}`);
          for (const [name, data] of Object.entries(fixture.logical)) {
            assert.equal(
              sha(await fs.readFile(path.join(fixture.hot, name))),
              sha(data),
              `round ${round}: ${name}`,
            );
          }
          assert.ok(
            (await listing(fixture.archive)).every((name) => !name.startsWith(fixture.id)),
            `round ${round}: no second copy`,
          );
        } finally {
          if (previous === undefined) {
            delete process.env.ACPX_STATE_HOME;
          } else {
            process.env.ACPX_STATE_HOME = previous;
          }
        }
      },
      `3d3d3d3d-1111-4222-8333-44445555${String(6000 + round)}`,
    );
  }
});

test("A11 re-archiving an id whose .zst lingers in the archive is a clobber (already-at-destination), never a second form", async () => {
  await withFixture(async (fixture) => {
    await compressAll(fixture);
    const restored = await runCli(fixture.home, ["sessions", "restore", fixture.id, "--json"]);
    assert.equal(restored.code, 0, restored.stderr);
    const name = `${fixture.id}.stream.ndjson`;
    await fs.writeFile(
      path.join(fixture.archive, zstNameFor(name)),
      encodeArchiveZst(fixture.logical[name]),
    );
    for (const file of await listing(fixture.hot)) {
      await fs.utimes(path.join(fixture.hot, file), OLD_MTIME_S, OLD_MTIME_S);
    }
    const result = await runCli(fixture.home, [
      "sessions",
      "archive",
      "--apply",
      "--ids",
      fixture.id,
      "--restore-grace-days",
      "0",
      "--json",
    ]);
    const body = JSON.parse(result.stdout) as {
      skippedAtApply: { id: string; reason: string }[];
      moved: unknown[];
    };
    assert.deepEqual(body.moved, []);
    assert.equal(body.skippedAtApply[0]?.reason, "already-at-destination", result.stdout);
    assert.ok((await listing(fixture.hot)).includes(name), "nothing moved");
  });
});

// ─── thaw / cat (cli-contract §1, §4) ─────────────────────────────────────────

test("--thaw: record + four families, plain, verified, with mtimes; the archive is untouched", async () => {
  await withFixture(async (fixture) => {
    await compressAll(fixture);
    const before = await treeFingerprint(fixture.archive);
    const to = await fs.mkdtemp(path.join(fixture.home, "..", "thaw-"));
    try {
      const result = await runCli(fixture.home, [
        "sessions",
        "archive",
        "--thaw",
        fixture.id,
        "--to",
        to,
        "--max-bytes",
        "1GiB",
        "--json",
      ]);
      assert.equal(result.code, 0, result.stderr);
      const body = JSON.parse(result.stdout) as {
        status: string;
        files: { file: string; family: string; form: string; bytes: number }[];
        maxBytes: number;
      };
      assert.equal(body.status, "thawed");
      assert.equal(body.maxBytes, 1024 ** 3);
      assert.deepEqual(body.files.map((entry) => entry.family).toSorted(), [
        "messages",
        "record",
        "stream",
        "stream-segment",
        "timestamps",
      ]);
      for (const [name, data] of Object.entries(fixture.logical)) {
        assert.equal(sha(await fs.readFile(path.join(to, name))), sha(data), name);
        assert.equal(Math.floor((await fs.stat(path.join(to, name))).mtimeMs), OLD_MTIME_MS);
      }
      assert.equal(await treeFingerprint(fixture.archive), before);
    } finally {
      await removeTempHome(to);
    }
  });
});

test("--thaw refusals (exit 2, JSON error on stdout, --to left empty): non-empty --to, --to inside the archive, too-large, corrupt, not-in-archive", async () => {
  await withFixture(async (fixture) => {
    await compressAll(fixture);
    const to = await fs.mkdtemp(path.join(fixture.home, "..", "thaw-"));
    const thaw = async (
      args: string[],
    ): Promise<{ code: number | null; error: { code: string; check?: string; file?: string } }> => {
      const result = await runCli(fixture.home, [
        "sessions",
        "archive",
        "--thaw",
        fixture.id,
        ...args,
        "--json",
      ]);
      return {
        code: result.code,
        error: (JSON.parse(result.stdout) as { error: { code: string } }).error,
      };
    };
    try {
      await fs.writeFile(path.join(to, "occupied"), "x");
      assert.deepEqual(await thaw(["--to", to]), {
        code: 2,
        error: { code: "bad-argument", message: `--to ${to} is not empty` },
      });
      await fs.unlink(path.join(to, "occupied"));

      const inside = path.join(fixture.archive, "COMPRESSION", "runs");
      const insideResult = await thaw(["--to", inside]);
      assert.equal(insideResult.code, 2);
      assert.equal(insideResult.error.code, "bad-argument");

      const tooLarge = await thaw(["--to", to, "--max-bytes", "1K"]);
      assert.equal(tooLarge.error.code, "too-large");
      assert.deepEqual(await listing(to), []);

      const zst = path.join(fixture.archive, zstNameFor(`${fixture.id}.timestamps.ndjson`));
      await fs.writeFile(zst, corruptCopy(await fs.readFile(zst), (await fs.stat(zst)).size - 1));
      const corrupt = await thaw(["--to", to]);
      assert.equal(corrupt.code, 2);
      assert.equal(corrupt.error.code, "ARCHIVED_FILE_CORRUPT");
      assert.equal(corrupt.error.file, `${fixture.id}.timestamps.ndjson`);
      assert.equal(corrupt.error.check, "hash");
      assert.deepEqual(
        await listing(to),
        [],
        "a failed thaw leaves --to empty — never a partial copy",
      );

      const missing = await runCli(fixture.home, [
        "sessions",
        "archive",
        "--thaw",
        "ffffffff-0000-4000-8000-000000000000",
        "--to",
        to,
        "--json",
      ]);
      assert.equal(missing.code, 2);
      assert.equal(
        (JSON.parse(missing.stdout) as { error: { code: string } }).error.code,
        "not-in-archive",
      );
    } finally {
      await removeTempHome(to);
    }
  });
});

test("--cat: verified logical bytes (a .zst suffix is accepted); corrupt or absent ⇒ exit 2 and NOTHING on stdout", async () => {
  await withFixture(async (fixture) => {
    await compressAll(fixture);
    const name = `${fixture.id}.stream.ndjson`;
    for (const arg of [name, zstNameFor(name)]) {
      const cat = await runCli(fixture.home, ["sessions", "archive", "--cat", arg]);
      assert.equal(cat.code, 0);
      assert.equal(sha(cat.stdout), sha(fixture.logical[name]));
    }
    const zst = path.join(fixture.archive, zstNameFor(name));
    await fs.writeFile(zst, (await fs.readFile(zst)).subarray(0, 100));
    const bad = await runCli(fixture.home, ["sessions", "archive", "--cat", name]);
    assert.equal(bad.code, 2);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /ARCHIVED_FILE_CORRUPT .* \(footer\)/);
    const absent = await runCli(fixture.home, [
      "sessions",
      "archive",
      "--cat",
      "nope.stream.ndjson",
    ]);
    assert.equal(absent.code, 2);
  });
});

// ─── crash seams (AC-6) ───────────────────────────────────────────────────────

for (const step of ["4", "5", "7", "8", "9"]) {
  test(`AC-6 SIGKILL after step ${step}: every logical file stays readable; the next sweep finishes; journal shows begin then a resolution`, async () => {
    await withFixture(async (fixture) => {
      const crashed = await runCli(fixture.home, COMPRESS_INIT, {
        ACPX_ARCHIVE_COMPRESS_CRASH_AFTER: step,
      });
      assert.equal(crashed.code, -1, `the seam must kill the run (step ${step})`);
      for (const [name, data] of Object.entries(fixture.logical)) {
        const cat = await runCli(fixture.home, ["sessions", "archive", "--cat", name]);
        assert.equal(cat.code, 0, `${name} after crash ${step}: ${cat.stderr}`);
        assert.equal(sha(cat.stdout), sha(data), `${name} after crash ${step}`);
      }
      const finish = await runCli(fixture.home, [
        "sessions",
        "archive",
        "--compress",
        "--apply",
        "--skip-reader-check",
        "--json",
      ]);
      assert.equal(finish.code, 0, finish.stderr);
      const names = await listing(fixture.archive);
      for (const [name, data] of Object.entries(fixture.logical)) {
        if (name.endsWith(".json")) {
          continue;
        }
        assert.ok(
          names.includes(zstNameFor(name)) && !names.includes(name),
          `${name}: exactly one form after the re-run`,
        );
        const cat = await runCli(fixture.home, ["sessions", "archive", "--cat", name]);
        assert.equal(sha(cat.stdout), sha(data));
      }
      const journal = await fs.readFile(
        path.join(fixture.archive, "COMPRESSION", "journal.tsv"),
        "utf8",
      );
      assert.ok(
        journal.indexOf("\tbegin\t") < journal.lastIndexOf("\tcompress\t") ||
          journal.includes("\tresolve-both\t"),
      );
    });
  });
}

// ─── decompress (AC-13) and shards (AC-11) ───────────────────────────────────

test("AC-13 --decompress --all --apply: every plain back with its original sha256 and mtime, no .zst left", async () => {
  await withFixture(async (fixture) => {
    await compressAll(fixture);
    const dry = await runCli(fixture.home, [
      "sessions",
      "archive",
      "--decompress",
      "--all",
      "--dry-run",
      "--json",
    ]);
    assert.equal((JSON.parse(dry.stdout) as { selected: { files: number } }).selected.files, 4);
    const result = await runCli(fixture.home, [
      "sessions",
      "archive",
      "--decompress",
      "--all",
      "--apply",
      "--json",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { decompressed: unknown[] }).decompressed.length, 4);
    for (const [name, data] of Object.entries(fixture.logical)) {
      assert.equal(sha(await fs.readFile(path.join(fixture.archive, name))), sha(data), name);
      assert.equal(
        Math.floor((await fs.stat(path.join(fixture.archive, name))).mtimeMs),
        OLD_MTIME_MS,
      );
    }
    assert.ok((await listing(fixture.archive)).every((name) => !name.endsWith(".zst")));
    const both = await runCli(fixture.home, [
      "sessions",
      "archive",
      "--decompress",
      "--json",
      "--apply",
    ]);
    assert.equal(both.code, 2, "neither ids nor --all is a refusal");
  });
});

test("AC-11 shard `bytes` = ON-DISK bytes after a sweep, and a --reindex rebuild equals the live shard", async () => {
  await withFixture(async (fixture) => {
    await writeArchiveManifest(fixture, "archive");
    const reindex = await runCli(fixture.home, ["sessions", "archive", "--reindex", "--json"]);
    assert.equal(reindex.code, 0, reindex.stderr);
    await compressAll(fixture);
    const shardDir = path.join(fixture.archive, "ARCHIVE-INDEX");
    const shardFile = (await listing(shardDir)).find((name) => name.endsWith(".json")) ?? "";
    const live = JSON.parse(await fs.readFile(path.join(shardDir, shardFile), "utf8")) as {
      entries: { id: string; bytes: number; files: number }[];
    };
    let onDisk = 0;
    for (const name of (await listing(fixture.archive)).filter((n) => n.startsWith(fixture.id))) {
      onDisk += (await fs.stat(path.join(fixture.archive, name))).size;
    }
    assert.equal(live.entries[0].bytes, onDisk);
    assert.equal(live.entries[0].files, 5);
    await runCli(fixture.home, ["sessions", "archive", "--reindex", "--json"]);
    const rebuilt = JSON.parse(await fs.readFile(path.join(shardDir, shardFile), "utf8")) as {
      entries: unknown[];
    };
    assert.deepEqual(rebuilt.entries, live.entries);
  });
});

// ─── the atrium capability probe (§3.13; HoD 2026-10-29) ──────────────────────

async function withStatsServer(
  body: string,
  contentType: string,
  run: (origin: string, hits: string[]) => Promise<void>,
): Promise<void> {
  const hits: string[] = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url ?? "");
    response.writeHead(200, { "content-type": contentType });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("capability probe: an atrium advertising zst-v1 passes; an HTML SPA catch-all refuses (reader-capability-missing), writes nothing", async () => {
  await withFixture(async (fixture) => {
    await withStatsServer("<!doctype html><html></html>", "text/html", async (origin, hits) => {
      const before = await treeFingerprint(fixture.archive);
      const result = await runCli(
        fixture.home,
        ["sessions", "archive", "--compress", "--apply", "--initialize", "--json"],
        { ACPX_UI_BASE_URL: origin },
      );
      assert.equal(result.code, 2);
      const body = JSON.parse(result.stdout) as { outcome: string; error: { code: string } };
      assert.equal(body.error.code, "reader-capability-missing");
      assert.deepEqual(hits, ["/api/sessions/archived/stats?capability=1"]);
      assert.equal(await treeFingerprint(fixture.archive), before);
    });
    await withStatsServer(
      JSON.stringify({ present: true, compression: "zst-v1" }),
      "application/json",
      async (origin) => {
        const result = await runCli(
          fixture.home,
          ["sessions", "archive", "--compress", "--apply", "--initialize", "--json"],
          { ACPX_UI_BASE_URL: origin },
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal((JSON.parse(result.stdout) as { compressed: unknown[] }).compressed.length, 4);
      },
    );
  });
});

test("capability probe: an https (public mTLS) ACPX_UI_BASE_URL is never probed — the box-local origin is", async () => {
  await withFixture(async (fixture) => {
    await withStatsServer(
      JSON.stringify({ compression: "zst-v1" }),
      "application/json",
      async (origin, hits) => {
        const result = await runCli(
          fixture.home,
          ["sessions", "archive", "--compress", "--apply", "--initialize", "--json"],
          {
            ACPX_UI_BASE_URL: "https://atrium.unreachable.invalid",
            ACPX_UI_INTERNAL_URL: origin,
          },
        );
        assert.equal(result.code, 0, result.stderr);
        assert.equal(hits.length, 1, "the internal origin answered the probe");
      },
    );
  });
});
