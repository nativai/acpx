// Brick 38465e2c — `sessions list --local` reads record BODIES, never the messages logs.
//
// It used to call `listSessionsForAgent`, which ran a `Promise.all` over every index entry through
// the hydrating loader (up to 200 messages per record) and then printed the hydrated records,
// messages included, under `--format json`. One listing reached 1682 MiB RSS on a 224-record store
// and OOM-killed labidio's control pod; on devbox (3,097 records) it died on a JS heap OOM. The rows
// below pin three things:
// - the listing stays within a 128 MB heap on a store the old loader cannot fit in one;
// - `--format json` emits no `messages` key, and every other field is byte-identical to the old
//   listing (the old algorithm is kept here as the oracle, over the same store);
// - the text rows are unchanged.
// Brick 0bf00929 adds the amended contract: on a record whose log runs past its body watermark,
// listing JSON reports the BODY watermark and the listing opens no log.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBywaySessionRecord } from "../src/session/byway.js";
import { messagesLogFileName, messagesLogPath } from "../src/session/messages-log.js";
import {
  isTemplateRecord,
  listSessions,
  rebuildSessionIndex,
  serializeSessionRecordForDisk,
  sessionBaseDir,
} from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const AGENT = "agent";

type Seed = Partial<SessionRecord> & { acpxRecordId: string; lastUsedAt: string };

function logLines(count: number, textBytes: number): string {
  const text = "x".repeat(textBytes);
  return Array.from(
    { length: count },
    (_, i) =>
      `${JSON.stringify({ Agent: { content: [{ Text: `${i}${text}` }], tool_results: {} } })}\n`,
  ).join("");
}

/**
 * Write `<id>.json`; with `log`, point it at a messages log holding those lines. The watermark is
 * `count` messages and, unless `bytes` says otherwise, all of `lines`.
 */
async function writeRecord(
  seed: Seed,
  log?: { lines: string; count: number; bytes?: number },
): Promise<void> {
  const dir = sessionBaseDir();
  await fs.mkdir(dir, { recursive: true });
  const record = makeSessionRecord({
    acpSessionId: `${seed.acpxRecordId}-acp`,
    agentCommand: AGENT,
    cwd: dir,
    ...seed,
  });
  const body = log
    ? {
        ...serializeSessionRecordForDisk(record),
        messages_log: {
          v: 1,
          count: log.count,
          base_index: 0,
          bytes: log.bytes ?? Buffer.byteLength(log.lines),
        },
      }
    : serializeSessionRecordForDisk(record);
  await fs.writeFile(path.join(dir, `${seed.acpxRecordId}.json`), `${JSON.stringify(body)}\n`);
  if (log) {
    await fs.writeFile(messagesLogPath(dir, seed.acpxRecordId), log.lines);
  }
}

// A listing that never exits is as much a failure as one that OOMs: kill it and say so, rather than
// leave the row to hang the file. The bound listing takes ~5 s here.
const CLI_TIMEOUT_MS = 60_000;

async function runCli(
  homeDir: string,
  args: string[],
  heapMb?: number,
  extraNodeArgs: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
  const nodeArgs = [
    ...(heapMb === undefined ? [] : [`--max-old-space-size=${heapMb}`]),
    ...extraNodeArgs,
  ];
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, CLI_PATH, ...args], {
      cwd: homeDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += `\n[test] CLI did not exit within ${CLI_TIMEOUT_MS} ms; stdout had ${stdout.length} chars; killed\n`;
      child.kill("SIGKILL");
    }, CLI_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ── Output parity ────────────────────────────────────────────────────────────────────────────

// Open, closed, seated, byway, inline-only, plus two records the listing must leave out (a
// subagent, another agent's session). Each logged record carries a few real messages.
async function seedMixedStore(): Promise<void> {
  const small = { lines: logLines(3, 40), count: 3 };
  await writeRecord({ acpxRecordId: "open", lastUsedAt: "2026-11-06T03:00:00.000Z" }, small);
  await writeRecord(
    {
      acpxRecordId: "closed",
      lastUsedAt: "2026-11-06T05:00:00.000Z",
      closed: true,
      closedAt: "2026-11-06T05:00:00.000Z",
    },
    small,
  );
  await writeRecord(
    {
      acpxRecordId: "seated",
      lastUsedAt: "2026-11-06T04:00:00.000Z",
      seatId: "5eat0000-0000-4000-8000-000000000001",
    },
    small,
  );
  await writeRecord(
    {
      acpxRecordId: "byway",
      lastUsedAt: "2026-11-06T02:00:00.000Z",
      metadata: { byway: "1" },
      parentSessionId: "open",
    },
    small,
  );
  await writeRecord({
    acpxRecordId: "inline",
    lastUsedAt: "2026-11-06T01:00:00.000Z",
    messages: [{ User: { id: "u1", content: [{ Text: "inline only" }] } }],
  });
  await writeRecord(
    {
      acpxRecordId: "child",
      lastUsedAt: "2026-11-06T06:00:00.000Z",
      kind: "subagent",
      parentSessionId: "open",
    },
    small,
  );
  await writeRecord(
    { acpxRecordId: "other", lastUsedAt: "2026-11-06T07:00:00.000Z", agentCommand: "other" },
    small,
  );
  await rebuildSessionIndex(sessionBaseDir(), "test seed");
}

// The pre-38465e2c listing, as the oracle: every hydrated record of this agent, newest first.
async function oracleListing(includeByways: boolean): Promise<SessionRecord[]> {
  return (await listSessions()).filter(
    (record) =>
      record.agentCommand === AGENT &&
      record.kind !== "subagent" &&
      (includeByways || !isBywaySessionRecord(record)),
  );
}

function withoutMessages(records: SessionRecord[]): string {
  return JSON.stringify(records.map(({ messages: _messages, ...rest }) => rest));
}

test("38465e2c: --format json omits messages; every other field matches the old listing byte for byte", async () => {
  await withTempHome("acpx-list-local-", async (homeDir) => {
    await seedMixedStore();
    for (const includeByways of [false, true]) {
      const args = ["--format", "json", AGENT, "sessions", "list", "--local"];
      const result = await runCli(homeDir, includeByways ? [...args, "--include-byways"] : args);
      assert.equal(result.code, 0, result.stderr);
      const oracle = await oracleListing(includeByways);
      // The oracle really does carry messages, so the comparison below is not vacuous.
      assert.ok(oracle.some((record) => record.messages.length === 3));
      assert.ok(oracle.some((record) => record.messages.length === 1));
      assert.equal(result.stdout.trim(), withoutMessages(oracle));
      const listed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      assert.deepEqual(
        listed.map((row) => row.acpxRecordId),
        includeByways
          ? ["closed", "seated", "open", "byway", "inline"]
          : ["closed", "seated", "open", "inline"],
      );
      for (const row of listed) {
        assert.equal(Object.hasOwn(row, "messages"), false, String(row.acpxRecordId));
      }
    }
  });
});

test("38465e2c: text rows are unchanged — id, [closed], cwd, lastUsedAt, seat column", async () => {
  await withTempHome("acpx-list-local-", async (homeDir) => {
    await seedMixedStore();
    const result = await runCli(homeDir, [
      AGENT,
      "sessions",
      "list",
      "--local",
      "--include-byways",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const expected = (await oracleListing(true))
      .map((record) => {
        const seat = record.seatId ? `seat ${record.seatId.slice(0, 8)} (unnamed)` : "seat -";
        const closed = record.closed ? " [closed]" : "";
        return `${record.acpxRecordId}${closed}\t${record.cwd}\t${record.lastUsedAt}\t${seat}\n`;
      })
      .join("");
    assert.equal(result.stdout, expected);
    assert.match(result.stdout, /^closed \[closed\]\t/);
    assert.match(result.stdout, /\tseat 5eat0000 \(unnamed\)\n/);
  });
});

// ── A log ahead of its body watermark (brick 0bf00929) ───────────────────────────────────────
//
// The production shape: a record closed after its last body write, whose final message reached the
// log ~0.5 s later (~0.5% of devbox's records). Its body's `messages_log` says 18 messages / 1,718
// bytes; the log on disk holds 19 / 1,814. The old listing hydrated every record, and hydration
// rolls the watermark forward to the log (`hydrateFromLogReader`), so it printed 19 / 1,814. The
// amended contract (HoD decision (ii) on brick 38465e2c): listing JSON carries the BODY watermark,
// and the listing never opens the log. The JSON-parity row above cannot see this: its fixture has
// no lagging record, so there the two watermarks agree.
//
// ⚠️ DO NOT "FIX" THE STALE COUNT BY STAT-ING OR READING THE LOG IN THE LISTING. It looks like a
// cheap correctness win, and it is a filesystem call per record on every listing, the cost brick
// 38465e2c removed; the no-read row below fails on it. A single-record load (`sessions show`,
// `history`) still rolls the watermark forward, which is that row's planted positive.
const LAG_LOG_MESSAGES = 19;
const LAG_LOG_BYTES = 1_814;
const LAG_WATERMARK = { v: 1, count: 18, base_index: 0, bytes: 1_718 };

async function seedLaggingStore(): Promise<void> {
  await writeRecord(
    {
      acpxRecordId: "lagging",
      lastUsedAt: "2026-11-06T02:00:00.000Z",
      closed: true,
      closedAt: "2026-11-06T02:00:00.000Z",
      template: {
        enabled: true,
        slug: "lagging-tpl",
        version: 1,
        created_at: "2026-11-06T02:00:00.000Z",
      },
    },
    {
      lines: logLines(LAG_LOG_MESSAGES, 40),
      count: LAG_WATERMARK.count,
      bytes: LAG_WATERMARK.bytes,
    },
  );
  await writeRecord(
    { acpxRecordId: "steady", lastUsedAt: "2026-11-06T01:00:00.000Z" },
    { lines: logLines(3, 40), count: 3 },
  );
  await rebuildSessionIndex(sessionBaseDir(), "test seed");
}

const LAG_LISTINGS: Array<{ label: string; args: string[] }> = [
  { label: "sessions list --local", args: ["--format", "json", AGENT, "sessions", "list", "--local"] },
  { label: "sessions templates", args: ["--format", "json", AGENT, "sessions", "templates"] },
];

test("0bf00929: a log ahead of its body watermark — listing JSON reports the BODY watermark; every other field matches the old listing", async () => {
  await withTempHome("acpx-list-local-lag-", async (homeDir) => {
    await seedLaggingStore();
    // The fixture provably lags: the log on disk holds more than the body's watermark says.
    const onDisk = await fs.readFile(messagesLogPath(sessionBaseDir(), "lagging"), "utf8");
    const diskBytes = Buffer.byteLength(onDisk);
    const diskCount = onDisk.split("\n").filter(Boolean).length;
    assert.equal(diskBytes, LAG_LOG_BYTES);
    assert.equal(diskCount, LAG_LOG_MESSAGES);
    // The oracle (the old hydrating listing) read the log and rolled the watermark forward to it.
    const oracle = await oracleListing(false);
    const oracleLagging = oracle.find((record) => record.acpxRecordId === "lagging");
    assert.equal(oracleLagging?.messages.length, LAG_LOG_MESSAGES);
    assert.deepEqual(oracleLagging?.messagesLog, {
      ...LAG_WATERMARK,
      count: LAG_LOG_MESSAGES,
      bytes: LAG_LOG_BYTES,
    });
    // Old minus `messages`, with only the lagging record's `messagesLog` put back to its body's.
    const expected = (records: SessionRecord[]): string =>
      JSON.stringify(
        records.map(({ messages: _messages, ...rest }) =>
          rest.acpxRecordId === "lagging" ? { ...rest, messagesLog: LAG_WATERMARK } : rest,
        ),
      );
    const oracles = [oracle, oracle.filter(isTemplateRecord)];
    for (const [at, { label, args }] of LAG_LISTINGS.entries()) {
      const result = await runCli(homeDir, args);
      assert.equal(result.code, 0, `${label}: ${result.stderr}`);
      const listed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      const lagging = listed.find((row) => row.acpxRecordId === "lagging");
      const messagesLog = lagging?.messagesLog as { count?: number; bytes?: number } | undefined;
      assert.deepEqual(messagesLog, LAG_WATERMARK, label);
      assert.notEqual(messagesLog?.bytes, diskBytes, label);
      assert.notEqual(messagesLog?.count, diskCount, label);
      assert.equal(result.stdout.trim(), expected(oracles[at] ?? []), label);
    }
  });
});

// The `hydratedDuring` spy of test/session-scan-no-hydration.test.ts, moved INTO the CLI child: a
// preload wraps `fs/promises` stat, open and readFile (named imports too, via
// `syncBuiltinESMExports`) and records each call on a messages log. Hydration starts by stat-ing
// the log, so a listing that records nothing opened none.
async function installLogSpy(
  homeDir: string,
): Promise<{ nodeArgs: string[]; take: () => Promise<string[]> }> {
  const out = path.join(homeDir, "log-spy.out");
  const preload = path.join(homeDir, "log-spy.mjs");
  await fs.writeFile(
    preload,
    [
      `import { appendFileSync } from "node:fs";`,
      `import fs from "node:fs/promises";`,
      `import { syncBuiltinESMExports } from "node:module";`,
      `import path from "node:path";`,
      `for (const name of ["stat", "open", "readFile"]) {`,
      `  const original = fs[name];`,
      `  fs[name] = async (target, ...rest) => {`,
      `    const base = path.basename(String(target));`,
      `    if (base.endsWith(${JSON.stringify(messagesLogFileName(""))})) {`,
      `      appendFileSync(${JSON.stringify(out)}, name + " " + base + "\\n");`,
      `    }`,
      `    return await original(target, ...rest);`,
      `  };`,
      `}`,
      `syncBuiltinESMExports();`,
      ``,
    ].join("\n"),
  );
  return {
    nodeArgs: ["--import", pathToFileURL(preload).href],
    take: async () => {
      let recorded = "";
      try {
        recorded = await fs.readFile(out, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      await fs.rm(out, { force: true });
      return recorded.split("\n").filter(Boolean);
    },
  };
}

test("0bf00929: the listing and templates JSON come from bodies — no messages log is opened", async () => {
  await withTempHome("acpx-list-local-lag-", async (homeDir) => {
    await seedLaggingStore();
    const spy = await installLogSpy(homeDir);
    // Planted positive: `sessions show` hydrates its record, and the spy inside the CLI sees it.
    const shown = await runCli(
      homeDir,
      ["--format", "json", AGENT, "sessions", "show", "--session-id", "lagging"],
      undefined,
      spy.nodeArgs,
    );
    assert.equal(shown.code, 0, shown.stderr);
    assert.ok(
      (await spy.take()).includes(`stat ${messagesLogFileName("lagging")}`),
      "the spy saw the hydration",
    );
    for (const { label, args } of LAG_LISTINGS) {
      const result = await runCli(homeDir, args, undefined, spy.nodeArgs);
      assert.equal(result.code, 0, `${label}: ${result.stderr}`);
      const listed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      assert.ok(
        listed.some((row) => row.acpxRecordId === "lagging"),
        label,
      );
      assert.deepEqual(await spy.take(), [], label);
    }
  });
});

// ── The memory bound ─────────────────────────────────────────────────────────────────────────
//
// 500 records, every other one closed, each with a 200-message (~1.2 MB) messages log hard-linked
// to ONE file, so the fixture costs ~1.2 MB of disk. The old listing hydrated all 500 tails at once
// (~600 MB) and then stringified them, and aborts with "JavaScript heap out of memory" under a
// 128 MB heap. On the old code this row FAILS.
const BOUND_RECORDS = 500;
const BOUND_MESSAGES = 200;
const BOUND_HEAP_MB = 128;

async function seedHeavyStore(): Promise<void> {
  const dir = sessionBaseDir();
  await fs.mkdir(dir, { recursive: true });
  const lines = logLines(BOUND_MESSAGES, 6_000);
  const sharedLog = path.join(dir, "shared-log.ndjson.src");
  await fs.writeFile(sharedLog, lines);
  const bytes = Buffer.byteLength(lines);
  for (let i = 0; i < BOUND_RECORDS; i += 1) {
    const id = `heavy-${String(i).padStart(4, "0")}`;
    const record = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-acp`,
      agentCommand: AGENT,
      cwd: dir,
      lastUsedAt: `2026-11-06T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
      closed: i % 2 === 1,
    });
    await fs.writeFile(
      path.join(dir, `${id}.json`),
      `${JSON.stringify({
        ...serializeSessionRecordForDisk(record),
        messages_log: { v: 1, count: BOUND_MESSAGES, base_index: 0, bytes },
      })}\n`,
    );
    await fs.link(sharedLog, messagesLogPath(dir, id));
  }
  await rebuildSessionIndex(dir, "test seed");
}

test(`38465e2c: sessions list --local over ${BOUND_RECORDS} records with ~1.2 MB message logs completes under a ${BOUND_HEAP_MB} MB heap`, async () => {
  await withTempHome("acpx-list-local-bound-", async (homeDir) => {
    await seedHeavyStore();
    const result = await runCli(
      homeDir,
      ["--format", "json", AGENT, "sessions", "list", "--local", "--include-byways"],
      BOUND_HEAP_MB,
    );
    assert.doesNotMatch(result.stderr, /heap out of memory/);
    assert.equal(result.code, 0, result.stderr.slice(-2_000));
    const listed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    assert.equal(listed.length, BOUND_RECORDS);
    assert.equal(listed.filter((row) => row.closed === true).length, BOUND_RECORDS / 2);
    assert.equal(
      listed.some((row) => Object.hasOwn(row, "messages")),
      false,
    );
  });
});
