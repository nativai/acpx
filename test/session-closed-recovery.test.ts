// brick://16712ece — a closed session's refusal must print advice an operator
// can actually EXECUTE, and `sessions ensure` must not revive-by-accident in
// silence.
//
// Three defects, three groups of tests:
//
//   PART 1 — NO VERB REOPENED A CLOSED SESSION. `sessions recover` returns rc=0
//     with `{"ownerFound":false,"state":"no_owner"}` and leaves `closed` true
//     (it un-wedges a queue OWNER, a different problem). `sessions reopen` is
//     the lifecycle inverse of `sessions close`; these tests read the RECORD
//     BACK, because a command's success line is intent, not outcome.
//
//   PART 2 — `sessions ensure` CREATED A NEW SESSION SILENTLY when the named
//     session existed but was closed. It still creates — measured 2026-09-05 on
//     devbox's production index, the nightly intaker re-bake had left 38
//     same-name records, ALL closed, and it REQUIRES a fresh session each night
//     — but it now says so on stderr and in an additive JSON key. The assertion
//     that matters is on the STORE (a new record appeared / the warning fired),
//     never on the exit code: rc=0 looking fine is the entire defect.
//
//   PART 3 — THE `SESSION_CLOSED` TEXT PROMISED A REMOVED BEHAVIOUR
//     ("reopen-and-deliver" on a plain delivery). It recurred because nothing
//     tested the text — and the one assertion that touched it pinned the OLD
//     reality (`doesNotMatch(/sessions reopen/)`). The text is now asserted
//     directly, AND checked structurally against `sessions --help` so the CLI
//     and its own error text cannot drift apart again.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reopenSession } from "../src/cli/session/session-control.js";
import { SessionClosedError } from "../src/errors.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import type { SessionRecord } from "../src/types.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type CliRunResult = { code: number | null; stdout: string; stderr: string };

// Isolated by CONSTRUCTION: `sessionBaseDir()` reads ACPX_STATE_HOME || homedir,
// so ACPX_STATE_HOME must be pinned alongside HOME or an inherited value wins
// and these tests would run against the real store (brick://dd4cb0e8).
async function runCli(
  args: string[],
  homeDir: string,
  options: { cwd?: string } = {},
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ACPX_STATE_HOME: homeDir,
    };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end();
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const originalStateHome = process.env.ACPX_STATE_HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-closed-recovery-"));
  process.env.HOME = tempHome;
  process.env.ACPX_STATE_HOME = tempHome;
  try {
    await run(tempHome);
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalStateHome == null) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = originalStateHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

function sessionsDir(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

function sessionFilePath(homeDir: string, acpxRecordId: string): string {
  return path.join(sessionsDir(homeDir), `${encodeURIComponent(acpxRecordId)}.json`);
}

async function readRecordJson(
  homeDir: string,
  acpxRecordId: string,
): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(sessionFilePath(homeDir, acpxRecordId), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

// Count the session RECORDS in the store. The whole of part 2 is that rc=0
// looked fine while a record appeared, so every ensure assertion below is
// anchored on this, not on the exit code.
async function countRecords(homeDir: string): Promise<number> {
  const entries = await fs.readdir(sessionsDir(homeDir)).catch(() => [] as string[]);
  return entries.filter((name) => name.endsWith(".json") && name !== "index.json").length;
}

function makeSessionRecord(
  overrides: Partial<SessionRecord> & {
    acpxRecordId: string;
    acpSessionId: string;
    agentCommand: string;
    cwd: string;
  },
): SessionRecord {
  const timestamp = "2026-04-20T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: overrides.acpxRecordId,
    acpSessionId: overrides.acpSessionId,
    agentSessionId: overrides.agentSessionId,
    agentCommand: overrides.agentCommand,
    agentName: overrides.agentName,
    cwd: path.resolve(overrides.cwd),
    name: overrides.name,
    createdAt: overrides.createdAt ?? timestamp,
    lastUsedAt: overrides.lastUsedAt ?? timestamp,
    lastSeq: 0,
    eventLog: {
      active_path: `.stream.ndjson`,
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: overrides.lastUsedAt ?? timestamp,
      last_write_error: null,
    },
    closed: overrides.closed ?? false,
    closedAt: overrides.closedAt,
    subagents: overrides.subagents,
    title: null,
    messages: [],
    updated_at: overrides.updated_at ?? overrides.lastUsedAt ?? timestamp,
    cumulative_token_usage: {},
    request_token_usage: {},
  };
}

async function seedSessionJson(homeDir: string, record: SessionRecord): Promise<void> {
  const filePath = sessionFilePath(homeDir, record.acpxRecordId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`,
    "utf8",
  );
}

async function writeMockAgentConfig(homeDir: string): Promise<void> {
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({ agents: { codex: { command: MOCK_AGENT_COMMAND } } }, null, 2)}\n`,
    "utf8",
  );
}

// ───────────────────────────── PART 3 — the text ─────────────────────────────

test("SESSION_CLOSED names the reopen routes that EXIST and not the removed one", () => {
  const error = new SessionClosedError("rec-1234", "my-session");

  assert.match(error.message, /'my-session'/);
  // The CLI route an operator can run from the shell that printed this.
  assert.match(error.message, /acpx sessions reopen rec-1234/);
  // The agent route. `--reopen` is REQUIRED and was never mentioned before.
  assert.match(error.message, /--reopen/);
  // The human route.
  assert.match(error.message, /acpx-ui/i);
  // The removed promise must not come back: a plain delivery does NOT
  // reopen-and-deliver, it is rejected 409.
  assert.doesNotMatch(error.message, /reopen-and-deliver/);
  assert.match(error.message, /409/);

  assert.equal(error.detailCode, "SESSION_CLOSED");
  assert.equal(error.outputCode, "RUNTIME");

  const withoutName = new SessionClosedError("raw-id", undefined);
  assert.match(withoutName.message, /'raw-id'/);
  assert.match(withoutName.message, /acpx sessions reopen raw-id/);
});

// STRUCTURAL, not textual: every `acpx sessions <verb>` the refusal names is
// read out of the message itself and looked up in the CLI's OWN help output.
// A hand-listed verb check would survive its own violation — this one cannot
// name a verb the CLI does not have, and cannot be satisfied by a stale list.
test("every `sessions <verb>` the SESSION_CLOSED text names exists in the CLI", async () => {
  await withTempHome(async (homeDir) => {
    await writeMockAgentConfig(homeDir);
    const help = await runCli(["codex", "sessions", "--help"], homeDir);
    assert.equal(help.code, 0, help.stderr);

    const message = new SessionClosedError("rec-1234", "my-session").message;
    const named = [...message.matchAll(/acpx sessions ([a-z][a-z-]*)/g)].map((m) => m[1]);
    assert.ok(named.length > 0, "the refusal must name at least one CLI verb");

    for (const verb of named) {
      assert.match(
        help.stdout,
        new RegExp(`^\\s*${verb}\\b`, "m"),
        `SESSION_CLOSED names \`acpx sessions ${verb}\`, which \`sessions --help\` does not list:\n${help.stdout}`,
      );
    }
  });
});

// ──────────────────────────── PART 1 — the verb ─────────────────────────────

test("sessions reopen flips a closed record open, proven by reading the record back", async () => {
  await withTempHome(async (homeDir) => {
    await writeMockAgentConfig(homeDir);
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const created = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "-s", "worker"],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const id = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;

    const closed = await runCli(
      ["--format", "json", "codex", "sessions", "close", "--session-id", id],
      homeDir,
      { cwd },
    );
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal(
      (await readRecordJson(homeDir, id)).closed,
      true,
      "precondition: record is closed",
    );

    const reopened = await runCli(
      ["--format", "json", "codex", "sessions", "reopen", id],
      homeDir,
      { cwd },
    );
    assert.equal(reopened.code, 0, reopened.stderr);
    const payload = JSON.parse(reopened.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.action, "session_reopened");
    assert.equal(payload.reopened, true);
    assert.equal(payload.acpxRecordId, id);

    // The outcome, not the success line: the record on disk.
    const after = await readRecordJson(homeDir, id);
    assert.equal(after.closed, false, "sessions reopen must persist closed=false");
    assert.equal(after.closed_at ?? null, null, "closed_at must be cleared");
  });
});

test("sessions reopen is idempotent on an already-open session", async () => {
  await withTempHome(async (homeDir) => {
    await writeMockAgentConfig(homeDir);
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const created = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "-s", "worker"],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const id = (JSON.parse(created.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;

    const again = await runCli(["--format", "json", "codex", "sessions", "reopen", id], homeDir, {
      cwd,
    });
    assert.equal(again.code, 0, again.stderr);
    const payload = JSON.parse(again.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.reopened, false, "already-open must report reopened=false, not a failure");
    assert.equal((await readRecordJson(homeDir, id)).closed, false);
  });
});

// `closeSession` cascades closed to subagents because a close tears down live
// processes. Reopening ONE session is not a request to write records the
// operator never named — pinned so a future "symmetry" change is caught.
test("reopen does not cascade to subagents", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "repo");
    await seedSessionJson(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "parent-1",
        acpSessionId: "parent-1",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-04-20T10:00:00.000Z",
        subagents: [{ acpxRecordId: "child-1", name: "child", spawnedAt: "2026-04-20T09:00:00Z" }],
      }),
    );
    await seedSessionJson(
      homeDir,
      makeSessionRecord({
        acpxRecordId: "child-1",
        acpSessionId: "child-1",
        agentCommand: "agent-a",
        cwd,
        closed: true,
        closedAt: "2026-04-20T10:00:00.000Z",
      }),
    );

    const result = await reopenSession("parent-1");
    assert.equal(result.reopened, true);
    assert.equal((await readRecordJson(homeDir, "parent-1")).closed, false);
    assert.equal(
      (await readRecordJson(homeDir, "child-1")).closed,
      true,
      "a subagent must stay closed — reopen writes only the session it was given",
    );
  });
});

// ───────────────────── PART 2 — ensure over a closed session ─────────────────

test("sessions ensure over a CLOSED same-name session creates AND says so", async () => {
  await withTempHome(async (homeDir) => {
    await writeMockAgentConfig(homeDir);
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const first = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "-s", "worker"],
      homeDir,
    );
    assert.equal(first.code, 0, first.stderr);
    const firstId = (JSON.parse(first.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;

    const closed = await runCli(
      ["--format", "json", "codex", "sessions", "close", "--session-id", firstId],
      homeDir,
      { cwd },
    );
    assert.equal(closed.code, 0, closed.stderr);

    const before = await countRecords(homeDir);
    const second = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "-s", "worker"],
      homeDir,
    );
    assert.equal(second.code, 0, second.stderr);

    // (1) It still creates — the nightly intaker re-bake depends on exactly this.
    const after = await countRecords(homeDir);
    assert.equal(after, before + 1, "ensure must still create a fresh session");
    const payload = JSON.parse(second.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.created, true);
    assert.notEqual(payload.acpxRecordId, firstId, "the new session is not the closed one");

    // (2) The additive machine-readable signal.
    const signal = payload.createdBecauseClosed as Record<string, unknown> | undefined;
    assert.ok(signal, "created-over-closed must be reported in the JSON result");
    assert.equal(signal.count, 1);
    assert.equal(signal.nearestRecordId, firstId);
    assert.equal(signal.nearestName, "worker");

    // (3) The human signal — on STDERR, naming what happened, that the history
    //     is NOT carried over, and only routes that exist.
    assert.match(second.stderr, /NEW EMPTY session/);
    assert.match(second.stderr, /history is NOT carried over/i);
    assert.match(second.stderr, new RegExp(`acpx sessions reopen ${firstId}`));
    assert.match(second.stderr, /--reopen/);
  });
});

// THE HARD CONSTRAINT. The caller this warning protects (`sessions ensure
// -s tmpl:intaker-bake --format json`, nightly) PARSES STDOUT. A warning on
// stdout would break the legitimate caller in the name of protecting the
// accidental one, so stdout must stay a single parseable JSON document.
test("the create-over-closed warning never contaminates stdout under --format json", async () => {
  await withTempHome(async (homeDir) => {
    await writeMockAgentConfig(homeDir);
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const first = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "-s", "bake"],
      homeDir,
    );
    assert.equal(first.code, 0, first.stderr);
    const firstId = (JSON.parse(first.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;
    await runCli(
      ["--format", "json", "codex", "sessions", "close", "--session-id", firstId],
      homeDir,
      { cwd },
    );

    const second = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "-s", "bake"],
      homeDir,
    );
    assert.equal(second.code, 0, second.stderr);
    assert.ok(second.stderr.includes("NEW EMPTY session"), "precondition: the warning did fire");

    // jq -e . would accept nothing less; neither does this.
    const parsed = JSON.parse(second.stdout.trim()) as Record<string, unknown>;
    assert.equal(parsed.action, "session_ensured");
    assert.doesNotMatch(second.stdout, /NEW EMPTY session/);
    assert.doesNotMatch(second.stdout, /⚠/);
  });
});

// The intaker shape: a fixed name whose closed records accumulate. Measured
// 2026-09-05 at 38 closed / 0 open. Many closed matches must NOT read as an
// ambiguity — throwing here would abort that job every night.
test("many closed same-name matches still create, and are counted not refused", async () => {
  await withTempHome(async (homeDir) => {
    await writeMockAgentConfig(homeDir);
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const run = await runCli(
        ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "-s", "nightly"],
        homeDir,
      );
      assert.equal(run.code, 0, run.stderr);
      const id = (JSON.parse(run.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;
      ids.push(id);
      const closed = await runCli(
        ["--format", "json", "codex", "sessions", "close", "--session-id", id],
        homeDir,
        { cwd },
      );
      assert.equal(closed.code, 0, closed.stderr);
    }
    assert.equal(new Set(ids).size, 4, "each night must have produced a distinct record");

    const run = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "-s", "nightly"],
      homeDir,
    );
    assert.equal(run.code, 0, run.stderr);
    const payload = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.created, true);
    const signal = payload.createdBecauseClosed as Record<string, unknown>;
    assert.equal(signal.count, 4);
    assert.match(run.stderr, /4 closed matches/);
  });
});

// CONTROL for the two assertions above: an ensure with NO closed match must
// produce NEITHER the warning NOR the JSON key. Without this, a warning that
// always fired would pass every test above.
test("no closed match ⇒ no warning and no createdBecauseClosed key", async () => {
  await withTempHome(async (homeDir) => {
    await writeMockAgentConfig(homeDir);
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const created = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "-s", "fresh"],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const payload = JSON.parse(created.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.created, true);
    assert.equal(payload.createdBecauseClosed, undefined);
    assert.doesNotMatch(created.stderr, /NEW EMPTY session/);

    // And the reuse path (an OPEN match) neither creates nor warns.
    const reused = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "ensure", "-s", "fresh"],
      homeDir,
    );
    assert.equal(reused.code, 0, reused.stderr);
    const reusedPayload = JSON.parse(reused.stdout.trim()) as Record<string, unknown>;
    assert.equal(reusedPayload.created, false);
    assert.equal(reusedPayload.createdBecauseClosed, undefined);
    assert.doesNotMatch(reused.stderr, /NEW EMPTY session/);
  });
});
