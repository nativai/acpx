// brick://16712ece — a closed session's refusal must print advice an operator
// can actually EXECUTE.
//
// Two groups of tests remain. (PART 2 — `sessions ensure` over a closed session — was
// retired with `sessions ensure` itself: D-IDENTITY, brick 61dc1302.)
//
//   PART 1 — NO VERB REOPENED A CLOSED SESSION. `sessions recover` returns rc=0
//     with `{"ownerFound":false,"state":"no_owner"}` and leaves `closed` true
//     (it un-wedges a queue OWNER, a different problem). `sessions reopen` is
//     the lifecycle inverse of `sessions close`; these tests read the RECORD
//     BACK, because a command's success line is intent, not outcome.
//
//   PART 3 — THE `SESSION_CLOSED` TEXT PROMISED A REMOVED BEHAVIOUR
//     ("reopen-and-deliver" on a plain delivery). It recurred because nothing
//     tested the text — and the one assertion that touched it pinned the OLD
//     reality (`doesNotMatch(/sessions reopen/)`). The text is now asserted
//     directly, AND checked structurally against `sessions --help` so the CLI
//     and its own error text cannot drift apart again.

// brick://4271b338 — install the owner reaper FROM THIS FILE, not only from the
// launcher. This file reaches the real CLI, which spawns `__queue-owner` daemons;
// `scripts/run-tests.mjs` reaps them via `--import`, but a bare `node --test
// <file>` — the targeted run our own briefs sanction — passes no preload, so every
// owner is orphaned to ppid 1 and lives out the PRODUCTION 30-minute idle release
// while the run reports green. Idempotent beside the preload; enforced by
// `owner-reaper-coverage.test.ts`.
import "./install-owner-reaper.js";
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
  const error = new SessionClosedError("rec-1234");

  assert.match(error.message, /'rec-1234'/);
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

  // CROSS-REPO GUARD. acpx-ui's `isTerminalEnqueueFailure`
  // (acpx-ui server/delivery-runner.ts:109-114) lower-cases the failure text and
  // classifies it TERMINAL if it contains "session is closed", "read-only" or
  // "template". This message is classified by its `detailCode`, NOT by those
  // substrings — measured 2026-09-05, neither the old nor the new text contains
  // any of them, so this edit changed no classification. Acquiring one by
  // accident in a later reword would silently reroute delivery retries, and
  // nothing in THIS repo would notice. Note the substring is "session is closed"
  // with no name between the words — this message always has one, which is
  // exactly why it never matched. (Since D-IDENTITY the label is the id.)
  const normalized = error.message.toLowerCase();
  assert.doesNotMatch(normalized, /session is closed/);
  assert.doesNotMatch(normalized, /read-only/);
  assert.doesNotMatch(normalized, /template/);

  // The refusal labels the session by its id — a session has no name (D-IDENTITY).
  const other = new SessionClosedError("raw-id");
  assert.match(other.message, /'raw-id'/);
  assert.match(other.message, /acpx sessions reopen raw-id/);
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

    const message = new SessionClosedError("rec-1234").message;
    const named = [...message.matchAll(/acpx sessions ([a-z][a-z-]*)/g)].map((m) => m[1]);
    assert.ok(named.length > 0, "the refusal must name at least one CLI verb");

    for (const verb of named) {
      // ⚠️ THE VERB MUST BE FOLLOWED BY WHITESPACE OR END-OF-LINE, NOT MERELY A
      // WORD BOUNDARY. This assertion first read `^\\s*${verb}\\b`, and `\\b`
      // matches before a hyphen — so a CLI listing `reopen-DISABLED` satisfied a
      // message naming `reopen`. Measured: mutation m2 renamed
      // `.command("reopen")` to `.command("reopen-DISABLED")` and THIS TEST STAYED
      // GREEN (the behavioural tests caught it instead). The discriminator fired
      // on a verb REMOVED but not on a verb RENAMED to a prefix-extension, which
      // is weaker than the guarantee this test's name claims.
      //
      // The general form, and the reason this comment is long: a probe whose
      // negative control you never ran is not a probe. m2 WAS the negative
      // control for this assertion; it went red on two other tests, and reading
      // "m2 is red" instead of "which tests did m2 red, and which SHOULD it have"
      // is what hid this for a whole gate cycle.
      assert.match(
        help.stdout,
        new RegExp(`^\\s+${verb}(\\s|$)`, "m"),
        `SESSION_CLOSED names \`acpx sessions ${verb}\`, which \`sessions --help\` does not list as a verb of exactly that name:\n${help.stdout}`,
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
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "-s", "worker"],
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
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "-s", "worker"],
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
