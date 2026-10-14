// Brick ac0be75e — `sessions owner-status --all` / `--descendants-of` are built from INDEX ENTRIES.
//
// The scans used to start from `listSessions()`, which hydrates every record's messages log (up to
// 200 messages each, closed records included) before any filter ran. That cost ~1.6 MB of heap per
// record, and the scan OOMed on a 3,540-record store. The rows below show two things:
// - the output still matches the old algorithm, which is kept here as an oracle over the same store;
// - the scan stays within a 128 MB heap on a store that the old algorithm cannot fit in one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  familyDescendantRecords,
  readAllSessionOwnerStatuses,
  readDescendantSessionOwnerStatuses,
  readOwnerStatusForRecord,
  type SessionOwnerStatus,
} from "../src/cli/session/session-control.js";
import { messagesLogPath } from "../src/session/messages-log.js";
import {
  listSessions,
  rebuildSessionIndex,
  serializeSessionRecordForDisk,
  sessionBaseDir,
} from "../src/session/persistence.js";
import type { SessionIndexEntry } from "../src/session/persistence/index.js";
import type { SessionRecord } from "../src/types.js";
import { queuePaths, writeQueueOwnerLock } from "./queue-test-helpers.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type Seed = Partial<SessionRecord> & { acpxRecordId: string; lastUsedAt: string };

async function writeRecord(seed: Seed): Promise<void> {
  const record = makeSessionRecord({
    acpSessionId: `${seed.acpxRecordId}-acp`,
    agentCommand: "agent",
    cwd: sessionBaseDir(),
    ...seed,
  });
  await fs.mkdir(sessionBaseDir(), { recursive: true });
  await fs.writeFile(
    path.join(sessionBaseDir(), `${seed.acpxRecordId}.json`),
    `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
  );
}

// p ─┬─ c1 (open, subagent, dead-owner lease)
//    └─ c2 (closed) ── g (open)
// s (open, standalone) · x (closed, standalone)
async function seedFamily(homeDir: string): Promise<void> {
  await writeRecord({ acpxRecordId: "p", lastUsedAt: "2026-10-14T03:00:00.000Z" });
  await writeRecord({
    acpxRecordId: "c1",
    lastUsedAt: "2026-10-14T05:00:00.000Z",
    parentSessionId: "p",
    kind: "subagent",
  });
  await writeRecord({
    acpxRecordId: "c2",
    lastUsedAt: "2026-10-14T04:00:00.000Z",
    parentSessionId: "p",
    closed: true,
  });
  await writeRecord({
    acpxRecordId: "g",
    lastUsedAt: "2026-10-14T01:00:00.000Z",
    parentSessionId: "c2",
  });
  await writeRecord({ acpxRecordId: "s", lastUsedAt: "2026-10-14T02:00:00.000Z" });
  await writeRecord({ acpxRecordId: "x", lastUsedAt: "2026-10-14T06:00:00.000Z", closed: true });
  await rebuildSessionIndex(sessionBaseDir(), "test seed");
  const { lockPath, socketPath } = queuePaths(homeDir, "c1");
  await writeQueueOwnerLock({ lockPath, pid: 999_999, sessionId: "c1", socketPath });
}

/** Tear the index from the record: rewrite one field on the index ENTRY only. */
async function tearIndexEntry(id: string, patch: Partial<SessionIndexEntry>): Promise<void> {
  const indexPath = path.join(sessionBaseDir(), "index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
    entries: SessionIndexEntry[];
  };
  const entry = index.entries.find((candidate) => candidate.acpxRecordId === id);
  assert.ok(entry, `no index entry for ${id}`);
  Object.assign(entry, patch);
  await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`);
}

// The pre-ac0be75e algorithm, verbatim, as the oracle.
async function oracleAll(): Promise<SessionOwnerStatus[]> {
  const records = (await listSessions()).filter((record) => record.closed !== true);
  return await Promise.all(records.map(async (record) => await readOwnerStatusForRecord(record)));
}

async function oracleDescendants(rootId: string): Promise<SessionOwnerStatus[]> {
  const descendants = familyDescendantRecords(rootId, await listSessions());
  return await Promise.all(
    descendants.map(async (record) => await readOwnerStatusForRecord(record)),
  );
}

const idsOf = (sessions: SessionOwnerStatus[]) => sessions.map((status) => status.sessionId);

// Byte-for-byte as the CLI prints it, key order included, minus the one field that is a clock
// reading (`heartbeatAgeMs` is "now − heartbeatAt", so two reads a few ms apart differ).
function asPrinted(sessions: SessionOwnerStatus[]): string {
  return JSON.stringify(sessions.map(({ heartbeatAgeMs: _age, ...rest }) => rest));
}

test("ac0be75e: --all matches the old full-hydration scan, open sessions newest first", async () => {
  await withTempHome("acpx-owner-scan-", async (homeDir) => {
    await seedFamily(homeDir);
    const batch = await readAllSessionOwnerStatuses();
    assert.equal(asPrinted(batch.sessions), asPrinted(await oracleAll()));
    assert.deepEqual(idsOf(batch.sessions), ["c1", "p", "s", "g"]);
    assert.equal(batch.count, 4);
    assert.equal(batch.recoverableCount, 1, "c1's dead-owner lease is still read");
    const c1 = batch.sessions.find((status) => status.sessionId === "c1");
    assert.equal(c1?.kind, "subagent");
    assert.equal(c1?.parentSessionId, "p");
    assert.equal(c1?.classification, "recoverable_owner");
  });
});

test("ac0be75e: --descendants-of matches the old scan, closed descendants kept as closed_ignored", async () => {
  await withTempHome("acpx-owner-scan-", async (homeDir) => {
    await seedFamily(homeDir);
    const batch = await readDescendantSessionOwnerStatuses("p");
    assert.equal(asPrinted(batch.sessions), asPrinted(await oracleDescendants("p")));
    assert.deepEqual(idsOf(batch.sessions), ["c1", "c2", "g"]);
    assert.equal(batch.ignoredCount, 1);
    assert.equal(
      batch.sessions.find((status) => status.sessionId === "c2")?.classification,
      "closed_ignored",
    );
  });
});

test("ac0be75e: torn — index entry open, record closed: the RECORD wins, in both scopes", async () => {
  await withTempHome("acpx-owner-scan-", async (homeDir) => {
    await seedFamily(homeDir);
    await tearIndexEntry("c2", { closed: false });
    await tearIndexEntry("x", { closed: false });
    const all = await readAllSessionOwnerStatuses();
    assert.equal(asPrinted(all.sessions), asPrinted(await oracleAll()));
    assert.deepEqual(idsOf(all.sessions), ["c1", "p", "s", "g"], "neither c2 nor x is open");
    const descendants = await readDescendantSessionOwnerStatuses("p");
    const c2 = descendants.sessions.find((status) => status.sessionId === "c2");
    assert.equal(c2?.closed, true);
    assert.equal(c2?.classification, "closed_ignored");
  });
});

// An index entry still marked closed after its record was reopened is a LIVE session until that
// session's next index flush re-projects the entry. The old full scan listed it, and `--all` must
// too: a scan that pre-filters on `entry.closed` goes red here (session-control.ts, the ⚠️ note).
test("ac0be75e: torn — index entry closed, record open: --all still reports the session", async () => {
  await withTempHome("acpx-owner-scan-", async (homeDir) => {
    await seedFamily(homeDir);
    await tearIndexEntry("s", { closed: true });
    const all = await readAllSessionOwnerStatuses();
    assert.equal(asPrinted(all.sessions), asPrinted(await oracleAll()));
    assert.deepEqual(idsOf(all.sessions), ["c1", "p", "s", "g"]);
    const s = all.sessions.find((status) => status.sessionId === "s");
    assert.equal(s?.closed, false);
    assert.equal(s?.classification, "idle_no_owner");
  });
});

test("ac0be75e: an entry whose record no longer parses is dropped, as listSessions dropped it", async () => {
  await withTempHome("acpx-owner-scan-", async (homeDir) => {
    await seedFamily(homeDir);
    await fs.writeFile(path.join(sessionBaseDir(), "s.json"), "{ not json\n");
    const all = await readAllSessionOwnerStatuses();
    assert.equal(asPrinted(all.sessions), asPrinted(await oracleAll()));
    assert.deepEqual(idsOf(all.sessions), ["c1", "p", "g"]);
  });
});

// ── Two INTENDED behaviour changes from 037a1fb1, pinned (TE finding F2) ─────────────────────

/** Point the record at a messages log, and make that log path a DIRECTORY, so every read fails. */
async function breakMessagesLog(id: string): Promise<void> {
  const recordPath = path.join(sessionBaseDir(), `${id}.json`);
  const raw = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<string, unknown>;
  raw.messages_log = { v: 1, count: 5, base_index: 0, bytes: 100 };
  await fs.writeFile(recordPath, `${JSON.stringify(raw)}\n`);
  await fs.mkdir(messagesLogPath(sessionBaseDir(), id), { recursive: true });
}

// (a) The scan never reads the messages log, so a session whose log cannot be read (EISDIR here;
// EACCES behaves the same way) is REPORTED. On 037a1fb1, hydration threw, `listSessions()` dropped
// the record, and its owner vanished from both scopes. Here that owner is a recoverable one.
// That was a silent miss in a verb that exists to find owners. On 037a1fb1 this row FAILS: c1 is
// missing from both scopes.
test("ac0be75e: a session whose messages log is unreadable (EISDIR) IS reported, in both scopes", async () => {
  await withTempHome("acpx-owner-scan-", async (homeDir) => {
    await seedFamily(homeDir);
    await breakMessagesLog("c1");
    const all = await readAllSessionOwnerStatuses();
    assert.deepEqual(idsOf(all.sessions), ["c1", "p", "s", "g"]);
    assert.equal(
      all.sessions.find((status) => status.sessionId === "c1")?.classification,
      "recoverable_owner",
    );
    const descendants = await readDescendantSessionOwnerStatuses("p");
    assert.deepEqual(idsOf(descendants.sessions), ["c1", "c2", "g"]);
  });
});

// (b) `--descendants-of` takes MEMBERSHIP from the INDEX graph (parent and seat fields) and prints
// every FIELD from the record. HoD decision on TE finding F1: that is the graph acpx-ui's board
// draws from the same entries, so this verb and the board agree on who is whose child. The tear
// heals at that session's next index flush, which re-projects the entry from its record
// (brick 19ee17ab). The accepted cost: while an entry is torn, the child is listed under its INDEX
// parent, and the printed `parentSessionId` (the record's) names a different session from the
// scope it was listed under.
// On 037a1fb1, which walked the record graph, this row FAILS: g stays under p, and s has no
// descendants.
test("ac0be75e: torn parent — --descendants-of follows the INDEX parent, prints the RECORD's", async () => {
  await withTempHome("acpx-owner-scan-", async (homeDir) => {
    await seedFamily(homeDir);
    await tearIndexEntry("g", { parentSessionId: "s" });
    const underP = await readDescendantSessionOwnerStatuses("p");
    assert.deepEqual(idsOf(underP.sessions), ["c1", "c2"]);
    const underS = await readDescendantSessionOwnerStatuses("s");
    assert.deepEqual(idsOf(underS.sessions), ["g"]);
    assert.equal(underS.sessions[0]?.parentSessionId, "c2", "the printed field is the record's");
  });
});

// ── The memory bound ─────────────────────────────────────────────────────────────────────────
//
// 500 records, every other one CLOSED so `--all` reads closed bodies too. Each has a 200-message
// (~1.2 MB) messages log, hard-linked to ONE file so the fixture costs ~1.2 MB of disk. The old scan
// hydrated every record's tail, closed ones included, and retained ~600 MB of it,
// and aborted with "JavaScript heap out of memory" under a 128 MB heap. On the old code this row
// FAILS. Measured against 037a1fb1 for brick ac0be75e; see verification/MEASURE.md.
const BOUND_RECORDS = 500;
const BOUND_MESSAGES = 200;
const BOUND_HEAP_MB = 128;

async function seedHeavyStore(): Promise<void> {
  const dir = sessionBaseDir();
  await fs.mkdir(dir, { recursive: true });
  const text = "x".repeat(6_000);
  const lines = Array.from(
    { length: BOUND_MESSAGES },
    (_, i) =>
      `${JSON.stringify({ Agent: { content: [{ Text: `${i}${text}` }], tool_results: {} } })}\n`,
  ).join("");
  const sharedLog = path.join(dir, "shared-log.ndjson.src");
  await fs.writeFile(sharedLog, lines);
  const bytes = Buffer.byteLength(lines);
  for (let i = 0; i < BOUND_RECORDS; i += 1) {
    const id = `heavy-${String(i).padStart(4, "0")}`;
    const record = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-acp`,
      agentCommand: "agent",
      cwd: dir,
      lastUsedAt: `2026-10-14T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
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

async function runBoundedCli(
  homeDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${BOUND_HEAP_MB}`,
        CLI_PATH,
        "--format",
        "json",
        "sessions",
        "owner-status",
        "--all",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test(`ac0be75e: --all over ${BOUND_RECORDS} records with ~1.2 MB message logs completes under a ${BOUND_HEAP_MB} MB heap`, async () => {
  await withTempHome("acpx-owner-scan-bound-", async (homeDir) => {
    await seedHeavyStore();
    const result = await runBoundedCli(homeDir);
    assert.doesNotMatch(result.stderr, /heap out of memory/);
    assert.equal(result.code, 0, result.stderr.slice(-2_000));
    const batch = JSON.parse(result.stdout.trim()) as { count: number; sessions: unknown[] };
    assert.equal(batch.count, BOUND_RECORDS / 2);
    assert.equal(batch.sessions.length, BOUND_RECORDS / 2);
  });
});
