import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveClaudeForkResumeAt, resolveIndexForkMeta } from "../src/acp/client.js";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionMessage } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// brick 0dc53ac9 (conception 0d57058c D4, D5) — `sessions copy --at-log-index <n>
// [--expect-entry <fp>]`. Driven as the REAL compiled CLI against a temp HOME and
// the mock adapter, with the source written the way acpx stores it: a
// `<id>.messages.ndjson` log plus the record's inline tail and `messages_log`.
//
// Every guarantee carries a case that fails if it breaks:
//   - absolute addressing: a cut OLDER than the 200-entry window (impossible with
//     --at-index) and a cut on a compacted log (base_index > 0);
//   - the window ending at n is what the copy inherits;
//   - --expect-entry mismatch → FORK_CUT_MOVED, and NO record is created;
//   - range, mutual exclusion and fingerprint-shape refusals;
//   - Claude: entry[n-1].claude_uuid, walk-back past entries without one, and the
//     positional fallback reading n as ABSOLUTE;
//   - Codex: the absolute n (after its even-snap) reaches the adapter.
//
// The duplicated-pair fixture is the conception's shape-only extract of the
// incident record a6c485c6 (record lines 1-154, ids/uuids pseudonymized,
// content hashed): `fixtures/fork-at-log-index/a6c485c6-incident.messages.ndjson`.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_FORK = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-fork-session`;
const INCIDENT_LOG = path.join(
  process.cwd(),
  "test",
  "fixtures",
  "fork-at-log-index",
  "a6c485c6-incident.messages.ndjson",
);

const SCRUBBED_ENV = [
  "ACPX_SESSION_URL",
  "ACPX_SESSION_RECORD_ID",
  "ACPX_SEAT_URL",
  "ACPX_SESSION_NAME",
  "ACPX_PARENT_SESSION_URL",
  "ACPX_PARENT_SEAT_URL",
  "ACPX_TASK_FOLDER",
  "ACPX_BRICK",
  "ACPX_BRICK_PATH",
  "ACPX_OWNER_LOG",
];

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ACPX_STATE_HOME: homeDir,
      ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    };
    for (const key of SCRUBBED_ENV) {
      delete env[key];
    }
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function user(id: string, claudeUuid?: string): SessionMessage {
  return {
    User: {
      id,
      content: [{ Text: `prompt ${id}` }],
      ...(claudeUuid ? { claude_uuid: claudeUuid } : {}),
    },
  };
}

function agent(text: string, claudeUuid?: string): SessionMessage {
  return {
    Agent: {
      content: [{ Text: text }],
      tool_results: {},
      ...(claudeUuid ? { claude_uuid: claudeUuid } : {}),
    },
  };
}

/** `count` alternating User/Agent entries for absolute positions base..base+count-1. */
function conversation(base: number, count: number, uuids = false): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => {
    const position = base + i;
    return position % 2 === 0
      ? user(`u-${position}`, uuids ? `c-${position}` : undefined)
      : agent(`reply ${position}`, uuids ? `c-${position}` : undefined);
  });
}

function entryId(entry: SessionMessage | undefined): string {
  if (!entry || entry === "Resume") {
    return String(entry);
  }
  if ("User" in entry) {
    return entry.User.id;
  }
  const first = entry.Agent.content[0];
  return `agent:${first && "Text" in first ? first.Text : ""}`;
}

type Source = {
  id: string;
  agentCommand: string;
  cwd: string;
  /** Raw ndjson log lines (exactly as on disk). */
  logLines: string[];
  baseIndex?: number;
  /** The record's inline tail (entries not yet in the log). */
  inline?: SessionMessage[];
};

async function writeSource(homeDir: string, source: Source): Promise<void> {
  const sessionDir = path.join(homeDir, ".acpx", "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(source.cwd, { recursive: true });
  const payload = source.logLines.map((line) => `${line}\n`).join("");
  await fs.writeFile(path.join(sessionDir, `${source.id}.messages.ndjson`), payload, "utf8");
  const serialized = serializeSessionRecordForDisk(
    makeSessionRecord({
      acpxRecordId: source.id,
      acpSessionId: `acp-${source.id}`,
      agentCommand: source.agentCommand,
      cwd: source.cwd,
      messages: source.inline ?? [],
    }),
  );
  serialized.messages_log = {
    v: 1,
    count: source.logLines.length,
    base_index: source.baseIndex ?? 0,
    bytes: Buffer.byteLength(payload),
  };
  await fs.writeFile(
    path.join(sessionDir, `${source.id}.json`),
    `${JSON.stringify(serialized, null, 2)}\n`,
    "utf8",
  );
}

async function recordFiles(homeDir: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(homeDir, ".acpx", "sessions"));
  return entries.filter((name) => name.endsWith(".json") && name !== "index.json").toSorted();
}

type Copied = {
  id: string;
  record: Record<string, unknown> & {
    forked_at_message_index?: unknown;
    forked_at_message_index_requested?: unknown;
    metadata?: Record<string, unknown>;
  };
  log: SessionMessage[];
};

async function copy(homeDir: string, source: Source, extra: string[]): Promise<Copied> {
  const result = await runCli(
    [
      "--cwd",
      source.cwd,
      "--agent",
      source.agentCommand,
      "--approve-all",
      "--format",
      "json",
      "sessions",
      "copy",
      "--from",
      source.id,
      "--ephemeral",
      ...extra,
    ],
    homeDir,
  );
  assert.equal(result.code, 0, `copy ${extra.join(" ")}: ${result.stderr}${result.stdout}`);
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  const id = String((JSON.parse(line) as { acpxRecordId?: unknown }).acpxRecordId);
  const sessionDir = path.join(homeDir, ".acpx", "sessions");
  const record = JSON.parse(
    await fs.readFile(path.join(sessionDir, `${encodeURIComponent(id)}.json`), "utf8"),
  ) as Copied["record"];
  const logRaw = await fs
    .readFile(path.join(sessionDir, `${encodeURIComponent(id)}.messages.ndjson`), "utf8")
    .catch(() => "");
  const log = logRaw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as SessionMessage);
  return { id, record, log };
}

async function copyFails(homeDir: string, source: Source, extra: string[], format = "json") {
  const before = await recordFiles(homeDir);
  const result = await runCli(
    [
      "--cwd",
      source.cwd,
      "--agent",
      source.agentCommand,
      "--approve-all",
      "--format",
      format,
      "sessions",
      "copy",
      "--from",
      source.id,
      "--ephemeral",
      ...extra,
    ],
    homeDir,
  );
  assert.notEqual(result.code, 0, `expected a refusal for ${extra.join(" ")}: ${result.stdout}`);
  // The refusal happened BEFORE any record existed.
  assert.deepEqual(await recordFiles(homeDir), before);
  return result;
}

const lines = (entries: SessionMessage[]) => entries.map((entry) => JSON.stringify(entry));
const withForkMeta = (command: string, meta: unknown) =>
  `${command} --expect-fork-meta-json ${JSON.stringify(JSON.stringify(meta))}`;

// ── absolute addressing over the full history ───────────────────────────────

test("a cut OLDER than the 200-entry window copies the window ending at n and sends the absolute n", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const all = conversation(0, 260);
    // n=50 lies 210 entries before the tail — outside the hydrated window
    // [60, 260), so no --at-index value can express it.
    const source: Source = {
      id: "long-source",
      agentCommand: withForkMeta(MOCK_FORK, { acpx: { forkAtMessageIndex: 50 } }),
      cwd: path.join(homeDir, "workspace"),
      logLines: lines(all),
    };
    await writeSource(homeDir, source);

    const copied = await copy(homeDir, source, ["--at-log-index", "50"]);
    assert.deepEqual(copied.log, all.slice(0, 50));
    assert.equal(copied.record.forked_at_message_index, 50);
    assert.equal(copied.record.metadata?.fork_at_log_index, "50");
    assert.equal(copied.record.metadata?.byway_at, "50");
  });
});

test("a cut deep in a long record inherits exactly [n-200, n), not the tail window", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const all = conversation(0, 260);
    const source: Source = {
      id: "long-source-deep",
      agentCommand: withForkMeta(MOCK_FORK, { acpx: { forkAtMessageIndex: 231 } }),
      cwd: path.join(homeDir, "workspace"),
      logLines: lines(all),
    };
    await writeSource(homeDir, source);

    const copied = await copy(homeDir, source, ["--at-log-index", "231"]);
    assert.equal(copied.log.length, 200);
    assert.deepEqual(copied.log, all.slice(31, 231));
    assert.equal(entryId(copied.log.at(-1)), entryId(all[230]));
    // The inherited COUNT (today's meaning, what acpx-ui's byway display slices
    // by) — not the absolute position, which rides as metadata.
    assert.equal(copied.record.forked_at_message_index, 200);
    assert.equal(copied.record.metadata?.fork_at_log_index, "231");
  });
});

test("--at-index on the same long record stays window-relative (unchanged)", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const all = conversation(0, 260);
    const source: Source = {
      id: "long-source-at-index",
      // --at-index 50 is window-relative: the adapter still gets 50, and the copy
      // is window[0..50) = absolute [60, 110) — the shift --at-log-index removes.
      agentCommand: withForkMeta(MOCK_FORK, { acpx: { forkAtMessageIndex: 50 } }),
      cwd: path.join(homeDir, "workspace"),
      logLines: lines(all),
    };
    await writeSource(homeDir, source);

    const copied = await copy(homeDir, source, ["--at-index", "50"]);
    assert.deepEqual(copied.log, all.slice(60, 110));
    assert.equal(copied.record.metadata?.fork_at_log_index, undefined);
  });
});

test("a compacted log (base_index > 0) is addressed from base_index", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const kept = conversation(40, 30); // absolute positions 40..69
    const source: Source = {
      id: "compacted-source",
      agentCommand: withForkMeta(MOCK_FORK, { acpx: { forkAtMessageIndex: 47 } }),
      cwd: path.join(homeDir, "workspace"),
      logLines: lines(kept),
      baseIndex: 40,
    };
    await writeSource(homeDir, source);

    const copied = await copy(homeDir, source, ["--at-log-index", "47"]);
    assert.deepEqual(copied.log, kept.slice(0, 7));
    assert.equal(entryId(copied.log.at(-1)), "u-46");
    assert.equal(copied.record.forked_at_message_index, 7);
    assert.equal(copied.record.metadata?.fork_at_log_index, "47");
  });
});

test("n = base_index is the empty-copy path; n below base_index or past the total is refused", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const source: Source = {
      id: "compacted-edges",
      agentCommand: MOCK_FORK,
      cwd: path.join(homeDir, "workspace"),
      logLines: lines(conversation(40, 30)),
      baseIndex: 40,
    };
    await writeSource(homeDir, source);

    const empty = await copy(homeDir, source, ["--at-log-index", "40"]);
    assert.deepEqual(empty.log, []);
    assert.equal(empty.record.forked_at_message_index, 0);

    for (const n of ["39", "71"]) {
      const refused = await copyFails(homeDir, source, ["--at-log-index", n], "text");
      assert.equal(refused.code, 2, refused.stderr);
      assert.match(refused.stderr, /--at-log-index out of range \(40-70\)/);
    }
  });
});

test("the inline tail counts after the log, de-duplicated against log lines past the watermark", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const all = conversation(0, 12);
    const source: Source = {
      id: "inline-tail",
      agentCommand: withForkMeta(MOCK_FORK, { acpx: { forkAtMessageIndex: 11 } }),
      cwd: path.join(homeDir, "workspace"),
      logLines: lines(all.slice(0, 8)),
      inline: all.slice(8),
    };
    await writeSource(homeDir, source);
    // A writer appended entry 8 to the log after the record's watermark; the
    // inline tail still holds it too. It must count ONCE, at position 8.
    const logPath = path.join(homeDir, ".acpx", "sessions", `${source.id}.messages.ndjson`);
    await fs.appendFile(logPath, `${JSON.stringify(all[8])}\n`, "utf8");

    const copied = await copy(homeDir, source, ["--at-log-index", "11"]);
    assert.deepEqual(copied.log, all.slice(0, 11));

    const refused = await copyFails(homeDir, source, ["--at-log-index", "13"], "text");
    assert.match(refused.stderr, /--at-log-index out of range \(0-12\)/);
  });
});

// ── --expect-entry ──────────────────────────────────────────────────────────

test("--expect-entry matching entry n-1 copies; a user: or agent: fingerprint both work", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const all = conversation(0, 230);
    const logLines = lines(all);
    const source: Source = {
      id: "expect-ok",
      agentCommand: MOCK_FORK,
      cwd: path.join(homeDir, "workspace"),
      logLines,
    };
    await writeSource(homeDir, source);

    const asUser = await copy(homeDir, source, [
      "--at-log-index",
      "11",
      "--expect-entry",
      "user:u-10",
    ]);
    assert.equal(entryId(asUser.log.at(-1)), "u-10");

    const sha = createHash("sha1").update(logLines[11], "utf8").digest("hex");
    const asAgent = await copy(homeDir, source, [
      "--at-log-index",
      "12",
      "--expect-entry",
      `agent:${sha}`,
    ]);
    assert.equal(asAgent.log.length, 12);
  });
});

test("--expect-entry mismatch exits FORK_CUT_MOVED on stderr and creates NO record (text and json)", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const source: Source = {
      id: "expect-moved",
      agentCommand: MOCK_FORK,
      cwd: path.join(homeDir, "workspace"),
      logLines: lines(conversation(0, 230)),
    };
    await writeSource(homeDir, source);

    for (const format of ["text", "json"]) {
      // entry 9 is an Agent, not user u-10: the cut moved by one.
      const moved = await copyFails(
        homeDir,
        source,
        ["--at-log-index", "10", "--expect-entry", "user:u-10"],
        format,
      );
      assert.equal(moved.code, 1, moved.stderr);
      const line = moved.stderr.split("\n").find((l) => l.includes('"code":"FORK_CUT_MOVED"'));
      assert.ok(line, `${format}: no FORK_CUT_MOVED line on stderr: ${moved.stderr}`);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.equal(parsed.code, "FORK_CUT_MOVED");
      assert.equal(parsed.at_log_index, 10);
      assert.equal(parsed.expected, "user:u-10");
      assert.match(String(parsed.found), /^agent:[0-9a-f]{40}$/);
      if (format === "json") {
        assert.match(moved.stdout, /"detailCode":"FORK_CUT_MOVED"/);
      }
    }

    // n = base_index has no entry n-1, so no fingerprint can match it.
    const atBase = await copyFails(homeDir, source, [
      "--at-log-index",
      "0",
      "--expect-entry",
      "user:u-0",
    ]);
    assert.match(atBase.stderr, /"code":"FORK_CUT_MOVED"/);
  });
});

test("the choke point re-checks --expect-entry itself: a cut that moved after the CLI's check creates no record", async () => {
  // The CLI handler checks first so a refusal costs no adapter spawn; THIS is the
  // guard that closes the race (conception 0d57058c M7/K1) — the record re-read
  // inside `createSession` is the one the copy is cut from. Driven against the
  // library, so the handler's early check cannot be what refuses.
  const { createSession } = await import("../src/session/session.js");
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const source: Source = {
      id: "choke-point",
      agentCommand: MOCK_FORK,
      cwd: path.join(homeDir, "workspace"),
      logLines: lines(conversation(0, 230)),
    };
    await writeSource(homeDir, source);
    const before = await recordFiles(homeDir);
    await assert.rejects(
      () =>
        createSession({
          agentCommand: MOCK_FORK,
          cwd: source.cwd,
          permissionMode: "approve-all",
          forkFromSessionId: source.id,
          forkAtLogIndex: 10,
          forkExpectEntry: "user:u-10",
        }),
      (error: unknown) =>
        error instanceof Error && error.message.includes('"code":"FORK_CUT_MOVED"'),
    );
    assert.deepEqual(await recordFiles(homeDir), before);
  });
});

test("flag refusals: mutual exclusion, --expect-entry without --at-log-index, malformed fingerprint", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const source: Source = {
      id: "flag-refusals",
      agentCommand: MOCK_FORK,
      cwd: path.join(homeDir, "workspace"),
      logLines: lines(conversation(0, 10)),
    };
    await writeSource(homeDir, source);

    const both = await copyFails(
      homeDir,
      source,
      ["--at-index", "2", "--at-log-index", "2"],
      "text",
    );
    assert.equal(both.code, 2);
    assert.match(both.stderr, /--at-index and --at-log-index are mutually exclusive/);

    const orphan = await copyFails(homeDir, source, ["--expect-entry", "user:u-0"], "text");
    assert.equal(orphan.code, 2);
    assert.match(orphan.stderr, /--expect-entry requires --at-log-index/);

    // A malformed value is refused at PARSE time, by the same commander path
    // that refuses a malformed --at-index — so it exits exactly as that does.
    const parseRefusal = await copyFails(homeDir, source, ["--at-index", "abc"], "text");
    for (const bad of ["u-0", "agent:nothex", "user:"]) {
      const malformed = await copyFails(
        homeDir,
        source,
        ["--at-log-index", "2", "--expect-entry", bad],
        "text",
      );
      assert.equal(malformed.code, parseRefusal.code, `${bad}: ${malformed.stderr}`);
      assert.match(malformed.stderr, /--expect-entry must be/);
    }
    const badIndex = await copyFails(homeDir, source, ["--at-log-index", "-1"], "text");
    assert.equal(badIndex.code, parseRefusal.code);
    assert.match(badIndex.stderr, /--at-log-index must be a non-negative integer/);
  });
});

// ── Claude: the agent's context gets the same cut (D5) ──────────────────────

const MOCK_CLAUDE = `${MOCK_FORK} --claude-agent-acp`;

test("Claude, duplicated pairs: entry n-1 without a uuid walks back to the nearest earlier one", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const incident = (await fs.readFile(INCIDENT_LOG, "utf8")).split("\n").filter(Boolean);
    // Record line 34 (n=34) is User u-0015 with NO claude_uuid; line 33 is the
    // terminal-error Agent, also without one; line 32 carries c-0014.
    assert.match(incident[33], /"id":"u-0015"/);
    assert.doesNotMatch(incident[33], /claude_uuid/);
    assert.doesNotMatch(incident[32], /claude_uuid/);
    assert.match(incident[31], /"claude_uuid":"c-0014"/);
    const source: Source = {
      id: "incident-walk-back",
      agentCommand: withForkMeta(MOCK_CLAUDE, {
        claudeCode: { options: { resumeSessionAt: "c-0014" } },
      }),
      cwd: path.join(homeDir, "workspace"),
      logLines: incident,
    };
    await writeSource(homeDir, source);

    const copied = await copy(homeDir, source, [
      "--at-log-index",
      "34",
      "--expect-entry",
      "user:u-0015",
    ]);
    assert.equal(copied.log.length, 34);
    assert.equal(entryId(copied.log.at(-1)), "u-0015");
  });
});

test("Claude, a cut ending on a duplicate forks at the ORIGINAL's uuid", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const incident = (await fs.readFile(INCIDENT_LOG, "utf8")).split("\n").filter(Boolean);
    // Lines 8-9 re-append the pair at lines 6-7 (Agent c-0003, User u-0004).
    assert.equal(incident[7], incident[5]);
    assert.equal(incident[8], incident[6]);
    const source: Source = {
      id: "incident-duplicate",
      agentCommand: withForkMeta(MOCK_CLAUDE, {
        claudeCode: { options: { resumeSessionAt: "c-0003" } },
      }),
      cwd: path.join(homeDir, "workspace"),
      logLines: incident,
    };
    await writeSource(homeDir, source);

    const copied = await copy(homeDir, source, ["--at-log-index", "9"]);
    assert.equal(copied.log.length, 9);
  });
});

/** A Claude transcript of `count` alternating user/assistant entries, uuids t-0..t-(count-1). */
async function writeTranscript(homeDir: string, cwd: string, acpSessionId: string, count: number) {
  const transcriptPath = transcriptJsonlPath(path.join(homeDir, ".claude"), cwd, acpSessionId);
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const rows = Array.from({ length: count }, (_, i) =>
    JSON.stringify({
      type: i % 2 === 0 ? "user" : "assistant",
      uuid: `t-${i}`,
      message:
        i % 2 === 0
          ? { content: `message ${i}` }
          : { content: [{ type: "text", text: `reply ${i}` }] },
    }),
  );
  await fs.writeFile(transcriptPath, `${rows.join("\n")}\n`, "utf8");
}

test("Claude, no uuid anywhere in the window: the positional fallback receives the ABSOLUTE n", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const cwd = path.join(homeDir, "project");
    await writeTranscript(homeDir, cwd, "session-absolute", 300);
    // The window ending at n=101 (positions [0, 101)), no claude_uuid anywhere —
    // a September-style record. Absolute: slot n-1 = 100 → t-100. Window
    // semantics (recordMessageTotal = the window length) would count back from
    // the transcript TAIL: 300 - 101 + 100 = 299 → t-299.
    const resolved = await resolveClaudeForkResumeAt({
      cwd,
      acpSessionId: "session-absolute",
      atIndex: 101,
      sourceMessages: conversation(0, 101),
      atIndexIsAbsolute: true,
    });
    assert.equal(resolved, "t-100");
  });
});

test("Claude, --at-index keeps its old resolution: no walk-back, window semantics", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const cwd = path.join(homeDir, "project");
    await writeTranscript(homeDir, cwd, "session-window", 300);
    const window: SessionMessage[] = [...conversation(0, 9, true), user("u-9")];
    // Not absolute: entry 9 has no uuid and is NOT walked back from; the
    // positional fallback reads 10 as window-relative (300 - 10 + 9 = 299).
    const resolved = await resolveClaudeForkResumeAt({
      cwd,
      acpSessionId: "session-window",
      atIndex: 10,
      sourceMessages: window,
    });
    assert.equal(resolved, "t-299");
    // The same window, absolute: walks back to entry 8's own uuid.
    const absolute = await resolveClaudeForkResumeAt({
      cwd,
      acpSessionId: "session-window",
      atIndex: 10,
      sourceMessages: window,
      atIndexIsAbsolute: true,
    });
    assert.equal(absolute, "c-8");
  });
});

test("non-Claude meta: absolute mode reads the window's LAST entry, never [atIndex-1]", () => {
  const window: SessionMessage[] = [agent("a", "uuid-a"), user("u-x")];
  // [atIndex-1] would be out of the window entirely at an absolute 301.
  assert.deepEqual(resolveIndexForkMeta(window, 301, true), {
    acpx: { forkAtMessageIndex: 301 },
  });
  assert.deepEqual(resolveIndexForkMeta([user("u-y"), agent("b", "uuid-b")], 301, true), {
    claudeCode: { options: { resumeSessionAt: "uuid-b" } },
  });
});

// ── Codex: the absolute n reaches the adapter, after its turn snap ──────────

test("Codex on a record longer than 200 entries gets the ABSOLUTE n (even-snapped), never the window index", async () => {
  await withTempHome("acpx-at-log-index-", async (homeDir) => {
    const all = conversation(0, 260);
    const codex = `${MOCK_FORK} --codex-acp`;
    const source: Source = {
      id: "codex-long",
      // n=231 is odd: codex keeps floor(n/2) turns, so the landed index is 230.
      agentCommand: withForkMeta(codex, { acpx: { forkAtMessageIndex: 230 } }),
      cwd: path.join(homeDir, "workspace"),
      logLines: lines(all),
    };
    await writeSource(homeDir, source);

    const copied = await copy(homeDir, source, ["--at-log-index", "231"]);
    assert.deepEqual(copied.log, all.slice(30, 230));
    assert.equal(copied.record.forked_at_message_index, 200);
    assert.equal(copied.record.forked_at_message_index_requested, 201);
    assert.equal(copied.record.metadata?.fork_at_log_index, "230");
  });
});
