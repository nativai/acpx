import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inBandLine, messageUrl, seatMessageText } from "../src/capacity/governor/notify.js";
import {
  ClickHouseWriter,
  clickHouseConfig,
  clickhouseRow,
  clickhouseTime,
  emptyEvent,
  EVENT_COLUMNS,
  FIXTURE_BOX,
  parseClickhouseTime,
  peaksEventId,
  peaksEvents,
  resolveBoxIdentity,
} from "../src/capacity/governor/record.js";
import { parseGovernorArgs } from "../src/capacity/governor/run.js";
import { governorLivenessLine, readGovernorLiveness } from "../src/capacity/governor/status.js";
import { governorScanJson } from "../src/cli/governor-command.js";
import { FakeBox, SECRET } from "./governor-fixtures.js";

// brick 5d7a23b6 — CONCEPTION §6 (telling, the record), §7.2 (the entry's arguments), the
// ClickHouse contract, and the read-only CLI views.

/**
 * The columns of `acpx_usage.process_governor_events_v1`, COPIED from the contract file
 * `/wisdom/Bricks/5d7a23b6-4f15-4d85-ba27-1eb366271d73/contracts/process_governor_events_v1.sql`
 * (CREATE TABLE, DDL order). ⚠️ The live server runs with `input_format_skip_unknown_fields = 1`:
 * a missing or misspelled JSONEachRow key is SILENTLY skipped (HTTP 200, column default). This list
 * is the only thing that can catch a drift — change it only together with the contract.
 */
const CONTRACT_COLUMNS = [
  "event_id",
  "captured_at",
  "box",
  "mode",
  "rule",
  "action",
  "session_kind",
  "orphaned",
  "session_id",
  "seat_id",
  "attribution",
  "processes",
  "threads",
  "anon_bytes",
  "comm_top",
  "started_at",
  "rounds",
  "kill_ms",
  "survivors",
  "box_committed_bytes",
  "box_limit_bytes",
  "psi_full_avg10",
  "notified",
  "notify_status",
  "test",
];

function assertContractKeys(row: Record<string, unknown>): void {
  const keys = Object.keys(row);
  const missing = CONTRACT_COLUMNS.filter((column) => !keys.includes(column));
  const extra = keys.filter((key) => !CONTRACT_COLUMNS.includes(key));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
}

const sample = () =>
  emptyEvent(
    { box: "devbox.nativai.de", mode: "enforce", test: false, action: "killed" },
    Date.parse("2026-11-08T17:52:30.123Z"),
  );

test("record: the ClickHouse row's keys are exactly the contract's columns — a missing and an extra key both fail", () => {
  assertContractKeys(clickhouseRow(sample()));
  assert.deepEqual([...EVENT_COLUMNS], CONTRACT_COLUMNS, "and in DDL order");
  // Negative cases: the check itself must fail on either drift.
  const { attribution: _dropped, ...missing } = clickhouseRow(sample());
  assert.throws(() => assertContractKeys(missing), /attribution/u);
  assert.throws(() => assertContractKeys({ ...clickhouseRow(sample()), sid: 2000 }), /sid/u);
  // An event carrying an extra in-memory key is still trimmed to the contract on the way out.
  assertContractKeys(clickhouseRow({ ...sample(), sid: 2000 } as never));
});

test("record: timestamps are 'YYYY-MM-DD hh:mm:ss.sss' UTC — never ISO T/Z (ClickHouse Code 27, a no-retry 400)", () => {
  const ms = Date.parse("2026-11-08T17:52:30.123Z");
  assert.equal(clickhouseTime(ms), "2026-11-08 17:52:30.123");
  assert.equal(parseClickhouseTime("2026-11-08 17:52:30.123"), ms);
  assert.match(sample().captured_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/u);
  assert.match(
    sample().event_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

test("record: peaks rows — one per kind, a zero row on a day with nothing governed, a deterministic UUID, 00:00 of the day", () => {
  const base = { box: "devbox.nativai.de", mode: "observe" as const, test: false };
  const empty = peaksEvents(
    { day: "2026-11-08", kinds: {}, recorded: false, delivered: false },
    base,
  );
  assert.equal(empty.length, 1);
  assert.equal(empty[0].session_kind, "");
  assert.equal(empty[0].processes, 0);
  assert.equal(empty[0].captured_at, "2026-11-08 00:00:00.000");
  const id = peaksEventId("devbox.nativai.de", "2026-11-08", "tool");
  assert.equal(
    id,
    peaksEventId("devbox.nativai.de", "2026-11-08", "tool"),
    "stable across re-sends",
  );
  assert.notEqual(id, peaksEventId("devbox.nativai.de", "2026-11-09", "tool"));
  assert.notEqual(id, peaksEventId("labidio.test", "2026-11-08", "tool"));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  for (const row of empty) {
    assertContractKeys(clickhouseRow(row));
  }
});

test("record: box identity is configuration and fails closed; test mode always writes the fixture label (§18 C2)", () => {
  assert.deepEqual(resolveBoxIdentity({ NATIVAI_BOX_FQDN: "devbox.nativai.de" }, false), {
    box: "devbox.nativai.de",
  });
  assert.deepEqual(
    resolveBoxIdentity({ OOM_CLICKHOUSE_BOX: "devbox.labidio.de", NATIVAI_BOX_FQDN: "x.y" }, false),
    { box: "devbox.labidio.de" },
  );
  assert.equal(resolveBoxIdentity({}, false).box, undefined);
  assert.equal(resolveBoxIdentity({ NATIVAI_BOX_FQDN: "devbox" }, false).box, undefined, "no dot");
  assert.equal(resolveBoxIdentity({ NATIVAI_BOX_FQDN: "a'b.c" }, false).box, undefined);
  assert.equal(
    resolveBoxIdentity({ NATIVAI_BOX_FQDN: FIXTURE_BOX }, false).box,
    undefined,
    "reserved",
  );
  assert.deepEqual(resolveBoxIdentity({ NATIVAI_BOX_FQDN: "devbox.nativai.de" }, true), {
    box: FIXTURE_BOX,
  });
});

test("record: the ClickHouse writer is refused for a non-supervised governor, a bad endpoint override, or no password", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-gov-ch-"));
  const pw = path.join(dir, "password");
  fs.writeFileSync(pw, "s3cret\n");
  const fetchImpl = async () => ({ status: 200 });
  const box = { box: "devbox.nativai.de" };
  const base = { env: {}, testMode: false, allowed: true, box, fetchImpl };
  assert.deepEqual(clickHouseConfig({ ...base, allowed: false }), {
    enabled: false,
    reason: "clickhouse_not_supervised",
  });
  assert.equal(
    clickHouseConfig({ ...base, box: { box: undefined, reason: "box_identity_unset" } }).enabled,
    false,
  );
  assert.deepEqual(
    clickHouseConfig({ ...base, env: { ACPX_GOVERNOR_CLICKHOUSE_URL: "http://127.0.0.1:8123" } }),
    { enabled: false, reason: "clickhouse_config_invalid" },
    "an override outside test mode",
  );
  assert.deepEqual(
    clickHouseConfig({
      ...base,
      testMode: true,
      env: { ACPX_GOVERNOR_CLICKHOUSE_URL: "http://evil.example:8123" },
    }),
    { enabled: false, reason: "clickhouse_config_invalid" },
    "only a loopback port",
  );
  const ok = clickHouseConfig({
    ...base,
    testMode: true,
    env: {
      ACPX_GOVERNOR_CLICKHOUSE_URL: "http://127.0.0.1:18123",
      ACPX_GOVERNOR_CLICKHOUSE_PASSWORD_FILE: pw,
    },
  });
  assert.equal(ok.enabled && ok.password, "s3cret");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("record: test mode WITHOUT the credential captures the exact JSONEachRow bodies to a file; production never does", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-gov-cap-"));
  const captureFile = path.join(dir, "clickhouse-rows.ndjson");
  const missing = path.join(dir, "no-such-password");
  const fetchImpl = async () => {
    throw new Error("must not POST in capture mode");
  };
  const env = { ACPX_GOVERNOR_CLICKHOUSE_PASSWORD_FILE: missing };
  const base = { allowed: true, box: { box: FIXTURE_BOX }, fetchImpl, captureFile };
  const production = clickHouseConfig({
    ...base,
    env: {},
    testMode: false,
    box: { box: "devbox.nativai.de" },
  });
  assert.equal(production.enabled, false, "no capture outside test mode");
  const config = clickHouseConfig({ ...base, env, testMode: true });
  assert.ok(config.enabled && config.capture);
  const writer = new ClickHouseWriter(config, () => {});
  const row = clickhouseRow({ ...sample(), box: FIXTURE_BOX, test: true });
  writer.enqueue(row);
  assert.equal(await writer.flush(), "ok");
  assert.equal(writer.lastStatus, "captured");
  assert.equal(
    fs.readFileSync(captureFile, "utf8"),
    `${JSON.stringify(row)}\n`,
    "the same bytes the POST carries",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("args: --test-rig and --limit-bytes are REFUSED without ACPX_GOVERNOR_TEST=1; the production start takes none; there is no --enforce", () => {
  assert.deepEqual(parseGovernorArgs([], {}), { testRig: false });
  for (const argv of [["--test-rig"], ["--limit-bytes", "100"]]) {
    assert.ok("error" in parseGovernorArgs(argv, {}), argv.join(" "));
  }
  const env = { ACPX_GOVERNOR_TEST: "1" };
  assert.deepEqual(parseGovernorArgs(["--test-rig", "--limit-bytes", "4096"], env), {
    testRig: true,
    limitBytes: 4096,
  });
  assert.deepEqual(parseGovernorArgs(["--limit-bytes=8192"], env), {
    testRig: false,
    limitBytes: 8192,
  });
  assert.ok("error" in parseGovernorArgs(["--limit-bytes", "x"], env));
  assert.ok("error" in parseGovernorArgs(["run"], env), "never a verb");
  // The mode is the constant and nothing else (D1 decided; §13.1): no flag can switch it.
  assert.ok("error" in parseGovernorArgs(["--enforce"], env));
  assert.ok("error" in parseGovernorArgs(["--observe"], env));
});

test("notify: the in-band line and the seat message carry rule, counts, comm classes and the remedy — never argv", () => {
  const facts = {
    rule: "fork-storm" as const,
    processes: 412,
    limit: 128,
    commTop: [
      ["bash", 409],
      ["git", 2],
      ["grep", 1],
    ] as Array<[string, number]>,
    eventId: "7f3c0000-0000-4000-8000-000000000000",
    startedAt: "2026-11-08 17:48:01.000",
    orphaned: true,
  };
  assert.equal(
    inBandLine(facts),
    "process-governor: KILLED this command (rule=fork-storm processes=412 limit=128; bash×409 git×2 grep×1). " +
      "Nothing else in your session was touched. A command that forks without bound — a recursive function, " +
      "a `&` loop, a fork bomb (for example tr(){ … | tr …; }, a function that calls the command it shadows) " +
      "— never stops by itself; heavy or parallel work belongs in workbench-exec. " +
      "Event 7f3c0000-0000-4000-8000-000000000000 in ~/.acpx/governor/events.ndjson.\n",
  );
  // A terminal's second sweep ended the shell: the line must not claim nothing else was touched (F9).
  const second = inBandLine({ ...facts, shellEnded: true });
  assert.match(second, /Your shell was ended too: this terminal ran away twice within 60 s\./u);
  assert.doesNotMatch(second, /Nothing else in your session was touched/u);
  // F8: without a known start the message says when it was FIRST SEEN, never "started at".
  const unknownStart = seatMessageText({
    ...facts,
    startedAt: undefined,
    firstSeenAt: "2026-11-08 17:49:00.000",
  });
  assert.match(
    unknownStart,
    /first seen at 2026-11-08 17:49:00\.000 UTC \(its own start is unknown\)/u,
  );
  assert.doesNotMatch(unknownStart, /started at/u);
  const text = seatMessageText(facts);
  assert.match(text, /started at 2026-11-08 17:48:01\.000 UTC/u);
  assert.match(text, /ORPHANED: its tool call had already ended or been stopped/u);
  assert.match(text, /acpx governor status/u);
  assert.equal(
    messageUrl("http://127.0.0.1:3456/", { kind: "seat", id: "abc" }),
    "http://127.0.0.1:3456/api/seats/abc/message",
  );
  assert.equal(
    messageUrl("http://h:1", { kind: "session", id: "s-1" }),
    "http://h:1/api/sessions/s-1/message",
  );
});

test("status: liveness from the heartbeat — alive needs a fresh scan AND the named live process", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-gov-hb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  assert.deepEqual(readGovernorLiveness(dir, now), {
    alive: false,
    lastScanAt: null,
    mode: null,
    killsLast24h: null,
    lastKill: null,
  });
  const self = fs.readFileSync("/proc/self/stat", "utf8");
  const startTicks = self
    .slice(self.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u)[19];
  const hb = {
    pid: process.pid,
    startTicks,
    lastScanAt: new Date(now - 1000).toISOString(),
    mode: "observe",
    killsLast24h: 2,
    lastKill: null,
  };
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify(hb));
  assert.equal(readGovernorLiveness(dir, now).alive, true);
  assert.equal(readGovernorLiveness(dir, now + 10_000).alive, false, "stale heartbeat");
  fs.writeFileSync(path.join(dir, "heartbeat.json"), JSON.stringify({ ...hb, startTicks: "1" }));
  assert.equal(readGovernorLiveness(dir, now).alive, false, "the pid is someone else now");
  assert.match(governorLivenessLine(readGovernorLiveness(dir, now), now), /NOT ALIVE/u);
});

test("cli: `acpx governor scan` classifies a fixture box read-only and prints comm names only", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-scan", "seat-scan");
  box.toolSession(2000, claudePid, 3);
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  process.env.ACPX_CAPACITY_PROC_ROOT = box.proc;
  const scan = governorScanJson(box.dir, box.nowMs);
  const sessions = scan.sessions as Array<Record<string, unknown>>;
  const tool = sessions.find((s) => s.sid === 2000);
  assert.equal(tool?.kind, "tool");
  assert.equal(tool?.processes, 3);
  assert.deepEqual(box.signals, [], "no action taken");
  assert.ok(!fs.existsSync(path.join(box.dir, "groups.json")), "no state written");
  assert.ok(!JSON.stringify(scan).includes(SECRET));
  assert.equal(scan.systemSid, 6);
});
