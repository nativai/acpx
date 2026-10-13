import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bywayCloseRefusal } from "../src/cli/session/byway-close-guard.js";
import { projectArchiveRecord } from "../src/session/archive/record-view.js";
import { isBywaySessionRecord } from "../src/session/byway.js";
import { parseSessionRecord } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// Brick 6867bbfc — keep by-the-way side-threads ("byways": a human's side conversation, opened
// from another session's transcript) out of agents' hands. CONCEPTION §11, the acpx rows:
// the close guard (D6), the stamp skip (§5.7), the set-parent refusal (D8) and
// `sessions list --local` (§5.9). Every guarantee carries a committed NEGATIVE case.
//
// Driven as the REAL compiled CLI against a temp HOME. Byways are created the way atrium creates
// them — `sessions copy --from <src> --ephemeral --parent-id <src>` — never written by hand,
// except for the two REAL records below.
//
// REAL RECORDS (acpx PROJECT adapter-fixture rule): sampled read-only from devbox
// `~/.acpx/sessions/` on 2026-10-13 and frozen under `test/fixtures/byway-records/`:
//   - `02d69833-fce5-4a19-983a-0152aa53ec97` — a real open byway (claude-agent-acp);
//   - `3a241311-4a19-4f36-b9df-f1d290bc3cac` — a real NON-byway FORK, the nearest look-alike:
//     it too carries `parent_session_id` = `forked_from_session_id` and a brick.
// Only the two free-text byway fields (`byway_first_question`, `byway_text_anchor`) were
// redacted and the pid fields dropped; every key and every other value is as found.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-fork-session`;
const BRICK_SHIM_DIR = path.join(process.cwd(), "test", "fixtures", "brick-shim");
const REAL_FIXTURE_DIR = path.join(process.cwd(), "test", "fixtures", "byway-records");
const REAL_BYWAY_ID = "02d69833-fce5-4a19-983a-0152aa53ec97";
const REAL_FORK_ID = "3a241311-4a19-4f36-b9df-f1d290bc3cac";
const UI_BASE = "https://ui.example.test";
const BRICK_X = "11111111-2222-3333-4444-555555555555";
/** Some OTHER agent — never the byway, never its source. */
const OTHER_AGENT = "aaaaaaaa-1111-4222-8333-444455556666";

/** Every variable atrium strips (acpx-ui `isCallerIdentityVar`) plus the parent/brick ones a
 *  test runner inherits. Scrubbed on EVERY run; a row adds back only what it names. */
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

function runCli(args: string[], homeDir: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return new Promise<CliResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ACPX_UI_BASE_URL: UI_BASE,
      ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    };
    delete env.ACPX_STATE_HOME;
    for (const key of SCRUBBED_ENV) {
      delete env[key];
    }
    Object.assign(env, extraEnv);
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

type Rig = {
  homeDir: string;
  base: string[];
  cli: (args: string[], extraEnv?: NodeJS.ProcessEnv) => Promise<CliResult>;
  recordPath: (id: string) => string;
  onDisk: (id: string) => Promise<Record<string, unknown>>;
  create: (name: string) => Promise<string>;
  /** atrium's byway: `sessions copy --from <src> --ephemeral --parent-id <src>`. */
  byway: (sourceId: string, extraEnv?: NodeJS.ProcessEnv) => Promise<string>;
};

function createdId(result: CliResult, what: string): string {
  assert.equal(result.code, 0, `${what}: ${result.stderr}`);
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  return String((JSON.parse(line) as { acpxRecordId?: unknown }).acpxRecordId);
}

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  await withTempHome("acpx-byway-guard-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all"];
    const cli = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
      runCli(args, homeDir, extraEnv);
    const recordPath = (id: string) => path.join(homeDir, ".acpx", "sessions", `${id}.json`);
    const onDisk = async (id: string) =>
      JSON.parse(await fs.readFile(recordPath(id), "utf8")) as Record<string, unknown>;
    const create = async (name: string) =>
      createdId(
        await cli([...base, "--format", "json", "sessions", "new", "-s", name]),
        `sessions new ${name}`,
      );
    const byway = async (sourceId: string, extraEnv: NodeJS.ProcessEnv = {}) =>
      createdId(
        await cli(
          [
            ...base,
            "--format",
            "json",
            "sessions",
            "copy",
            "--from",
            sourceId,
            "--ephemeral",
            "--parent-id",
            sourceId,
          ],
          extraEnv,
        ),
        "sessions copy --ephemeral",
      );
    await run({ homeDir, base, cli, recordPath, onDisk, create, byway });
  });
}

/** An agent's shell, as acpx sets it on every agent it runs. */
function agentEnv(sessionId = OTHER_AGENT): NodeJS.ProcessEnv {
  return {
    ACPX_SESSION_URL: `${UI_BASE}/?session=${sessionId}`,
    ACPX_SEAT_URL: `${UI_BASE}/?seat=bbbbbbbb-1111-4222-8333-444455556666`,
  };
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readRealFixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(REAL_FIXTURE_DIR, name), "utf8")) as Record<
    string,
    unknown
  >;
}

/** A REAL record placed in the temp store exactly as found (raw on-disk bytes, not re-serialised). */
async function plantRealRecord(
  rig: Rig,
  name: string,
  edit: (raw: Record<string, unknown>) => void = () => {},
): Promise<void> {
  const raw = await readRealFixture(name);
  edit(raw);
  const id = String(raw.acpx_record_id);
  await fs.mkdir(path.dirname(rig.recordPath(id)), { recursive: true });
  await fs.writeFile(rig.recordPath(id), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

// ─── D1 — the predicate ──────────────────────────────────────────────────────

test("D1 · isBywaySessionRecord recognises the flag and a REAL byway; a REAL fork and a plain record are not byways", async () => {
  assert.equal(isBywaySessionRecord({ metadata: { byway: "1" } }), true);
  assert.equal(isBywaySessionRecord({}), false);
  assert.equal(isBywaySessionRecord({ metadata: { brick: BRICK_X } }), false);

  const realByway = parseSessionRecord(await readRealFixture("real-byway-02d69833.json"));
  const realFork = parseSessionRecord(await readRealFixture("real-fork-3a241311.json"));
  assert.ok(realByway && realFork, "a sampled real record no longer parses");
  assert.equal(realByway.acpxRecordId, REAL_BYWAY_ID);
  assert.equal(isBywaySessionRecord(realByway), true, "the REAL byway was not recognised");
  // The look-alike: a real fork whose parent IS its fork source, carrying a brick.
  assert.equal(realFork.acpxRecordId, REAL_FORK_ID);
  assert.equal(realFork.parentSessionId, realFork.forkedFromSessionId);
  assert.equal(isBywaySessionRecord(realFork), false, "a REAL non-byway fork read as a byway");
});

test("D1 · NEGATIVE — the predicate is a SUPERSET on the flag: a non-'1' value still counts (narrowing it to === '1' fails here)", () => {
  for (const value of ["0", "true", ""]) {
    assert.equal(isBywaySessionRecord({ metadata: { byway: value } }), true, `byway=${value}`);
  }
});

test("D1 · the archive's companion rule uses the SAME predicate (one definition per repo)", async () => {
  const view = projectArchiveRecord(await readRealFixture("real-byway-02d69833.json"));
  assert.equal(view?.isByway, true);
  const fork = projectArchiveRecord(await readRealFixture("real-fork-3a241311.json"));
  assert.equal(fork?.isByway, false);
  const nonOne = projectArchiveRecord({ acpx_record_id: "x", metadata: { byway: "0" } });
  assert.equal(nonOne?.isByway, true, "the archive narrowed its byway rule");
});

// ─── D6 — the refusal predicate, pure ────────────────────────────────────────

function bywayFixture(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "cccccccc-1111-4222-8333-444455556666",
    acpSessionId: "acp-byway",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/tmp/acpx-byway-guard",
    seatId: "dddddddd-1111-4222-8333-444455556666",
    parentSessionId: "eeeeeeee-1111-4222-8333-444455556666",
    metadata: {
      byway: "1",
      byway_parent: "eeeeeeee-1111-4222-8333-444455556666",
      byway_first_question: `why ${"x".repeat(200)}`,
    },
    ...overrides,
  });
}

test("D6 · refusal predicate: an agent caller on a byway is refused; message names source, clamped question and the human's route — and NO workaround", () => {
  const refusal = bywayCloseRefusal(bywayFixture(), agentEnv());
  assert.ok(refusal, "an agent closing a byway was not refused");
  assert.equal(refusal.code, "BYWAY_CLOSE_REFUSED");
  assert.equal(refusal.sourceSessionId, "eeeeeeee-1111-4222-8333-444455556666");
  assert.match(refusal.message, /by-the-way side-thread/);
  assert.match(refusal.message, /agents cannot close it/);
  assert.match(refusal.message, /they close it in atrium themselves/);
  assert.match(refusal.message, /promote it there first/);
  // NEGATIVE — the refusal must hand an agent no way round it: no flag, no env variable.
  // (The first version said "re-run with --allow-byway"; an agent did, on another agent's order.)
  assert.doesNotMatch(refusal.message, /--[a-z]/, "the refusal names a flag");
  assert.doesNotMatch(refusal.message, /ACPX_|env/i, "the refusal names an env trick");
  const quoted = /\("([^"]*)"\)/.exec(refusal.message)?.[1] ?? "";
  assert.equal(quoted.length, 80, "the first question is not clamped to 80 chars");
});

test("D6 · detection breadth — NEGATIVE: any ONE identity var is an agent, including a URL that does not parse (fail closed, never open)", () => {
  for (const env of [
    { ACPX_SEAT_URL: `${UI_BASE}/?seat=bbbbbbbb-1111-4222-8333-444455556666` },
    { ACPX_SESSION_URL: "session-url-in-an-odd-form" },
    { ACPX_SESSION_URL: `${UI_BASE}/?session=not-a-uuid` },
    { ACPX_SESSION_RECORD_ID: OTHER_AGENT },
  ]) {
    assert.ok(bywayCloseRefusal(bywayFixture(), env), `fail-open on ${JSON.stringify(env)}`);
  }
});

test("D6 · NEGATIVE — no identity env (a human shell, atrium's stripped spawn) is never refused; blank values are not identity", () => {
  assert.equal(bywayCloseRefusal(bywayFixture(), {}), undefined);
  assert.equal(
    bywayCloseRefusal(bywayFixture(), { ACPX_SESSION_URL: "  ", ACPX_SEAT_URL: "" }),
    undefined,
  );
});

test("D6 · self-close is exempt by session and by seat; a plain child is never refused", () => {
  const target = bywayFixture();
  assert.equal(bywayCloseRefusal(target, agentEnv(target.acpxRecordId)), undefined);
  assert.equal(
    bywayCloseRefusal(target, {
      ACPX_SESSION_URL: `${UI_BASE}/?session=${OTHER_AGENT}`,
      ACPX_SEAT_URL: `${UI_BASE}/?seat=${target.seatId}`,
    }),
    undefined,
  );
  assert.equal(bywayCloseRefusal(bywayFixture({ metadata: {} }), agentEnv()), undefined);
});

// ─── D6 — `sessions close` through the real CLI ──────────────────────────────

test("close guard · an agent's `sessions close` on a byway is REFUSED (exit 1, BYWAY_CLOSE_REFUSED) and the record is byte-identical", async () => {
  await withRig(async (rig) => {
    const source = await rig.create("source");
    const byway = await rig.byway(source);
    assert.equal((await rig.onDisk(byway)).parent_session_id, source);
    const before = await fs.readFile(rig.recordPath(byway), "utf8");

    const text = await rig.cli(["sessions", "close", "--session-id", byway], agentEnv());
    assert.equal(text.code, 1, text.stderr);
    assert.match(text.stderr, /BYWAY_CLOSE_REFUSED/);
    assert.ok(text.stderr.includes(source), "the refusal does not name the source session");

    const json = await rig.cli(
      ["--format", "json", "sessions", "close", "--session-id", byway],
      agentEnv(),
    );
    assert.equal(json.code, 1, json.stderr);
    const payload = jsonLines(json.stdout).at(-1);
    assert.deepEqual(
      { ok: payload?.ok, code: payload?.code, sessionId: payload?.sessionId },
      { ok: false, code: "BYWAY_CLOSE_REFUSED", sessionId: byway },
    );
    assert.equal(payload?.sourceSessionId, source);
    assert.equal(typeof payload?.error, "string");

    assert.equal(await fs.readFile(rig.recordPath(byway), "utf8"), before, "the record moved");
    assert.notEqual((await rig.onDisk(byway)).closed, true);
  });
});

test("close guard · detection breadth through the CLI — NEGATIVE: ACPX_SEAT_URL alone, or an odd-form ACPX_SESSION_URL, still refuses", async () => {
  await withRig(async (rig) => {
    const byway = await rig.byway(await rig.create("source"));
    for (const env of [
      { ACPX_SEAT_URL: `${UI_BASE}/?seat=bbbbbbbb-1111-4222-8333-444455556666` },
      { ACPX_SESSION_URL: `${UI_BASE}/sessions/${OTHER_AGENT}` },
    ]) {
      const result = await rig.cli(["sessions", "close", "--session-id", byway], env);
      assert.equal(result.code, 1, `closed under ${JSON.stringify(env)}: ${result.stderr}`);
      assert.match(result.stderr, /BYWAY_CLOSE_REFUSED/);
    }
    assert.notEqual((await rig.onDisk(byway)).closed, true);
  });
});

test("close guard · NEGATIVE — with NO identity env (atrium's UI close, a human shell) the byway closes", async () => {
  await withRig(async (rig) => {
    const byway = await rig.byway(await rig.create("source"));
    const result = await rig.cli(["sessions", "close", "--session-id", byway]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await rig.onDisk(byway)).closed, true, "a human close of a byway was refused");
  });
});

test("close guard · NEGATIVE — there is NO override: `--allow-byway` (the removed flag) is an unknown option and the byway stays open", async () => {
  await withRig(async (rig) => {
    const byway = await rig.byway(await rig.create("source"));
    const before = await fs.readFile(rig.recordPath(byway), "utf8");
    for (const env of [agentEnv(), {}]) {
      const result = await rig.cli(
        ["sessions", "close", "--session-id", byway, "--allow-byway"],
        env,
      );
      assert.notEqual(result.code, 0, `--allow-byway was accepted: ${result.stdout}`);
      assert.match(result.stderr, /unknown option '--allow-byway'/);
    }
    assert.equal(await fs.readFile(rig.recordPath(byway), "utf8"), before, "the byway moved");
    assert.notEqual((await rig.onDisk(byway)).closed, true);
  });
});

test("close guard · NEGATIVE — `sessions close --help` and its usage-error help never mention byways (nothing to discover)", async () => {
  await withRig(async (rig) => {
    const help = await rig.cli(["sessions", "close", "--help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /--session-id/, "precondition: this is the close help");
    // The specimen: a usage error made commander print the whole close help, and the override
    // the agent then used was in it. Both outputs must carry no byway wording at all.
    const usage = await rig.cli(["sessions", "close", "a", "b", "c"], agentEnv());
    assert.notEqual(usage.code, 0);
    for (const text of [help.stdout, help.stderr, usage.stdout, usage.stderr]) {
      assert.doesNotMatch(text, /byway|by-the-way|side-thread/i, text);
    }
  });
});

test("close guard · a byway may close ITSELF — by its session, and by its seat", async () => {
  await withRig(async (rig) => {
    const source = await rig.create("source");
    const bySession = await rig.byway(source);
    const closedBySession = await rig.cli(
      ["sessions", "close", "--session-id", bySession],
      agentEnv(bySession),
    );
    assert.equal(closedBySession.code, 0, closedBySession.stderr);
    assert.equal((await rig.onDisk(bySession)).closed, true);

    const bySeat = await rig.byway(source);
    const seatId = String((await rig.onDisk(bySeat)).seat_id);
    const closedBySeat = await rig.cli(["sessions", "close", "--session-id", bySeat], {
      ACPX_SESSION_URL: `${UI_BASE}/?session=${OTHER_AGENT}`,
      ACPX_SEAT_URL: `${UI_BASE}/?seat=${seatId}`,
    });
    assert.equal(closedBySeat.code, 0, closedBySeat.stderr);
    assert.equal((await rig.onDisk(bySeat)).closed, true);
  });
});

test("close guard · NEGATIVE — an agent closing a PLAIN child is unchanged (not refused)", async () => {
  await withRig(async (rig) => {
    const child = await rig.create("plain-child");
    const result = await rig.cli(["sessions", "close", "--session-id", child], agentEnv());
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await rig.onDisk(child)).closed, true, "a plain child's close was refused");
  });
});

test("close guard · `--seat <byway seat>` from an agent shell is refused too (the check runs after seat resolution)", async () => {
  await withRig(async (rig) => {
    const byway = await rig.byway(await rig.create("source"));
    const seatId = String((await rig.onDisk(byway)).seat_id);
    const result = await rig.cli(["sessions", "close", "--seat", seatId], agentEnv());
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /BYWAY_CLOSE_REFUSED/);
    assert.notEqual((await rig.onDisk(byway)).closed, true);
  });
});

test("close guard · REAL records — the sampled real byway is refused from an agent shell; the sampled real fork closes", async () => {
  await withRig(async (rig) => {
    await plantRealRecord(rig, "real-byway-02d69833.json");
    const before = await fs.readFile(rig.recordPath(REAL_BYWAY_ID), "utf8");
    const refused = await rig.cli(["sessions", "close", "--session-id", REAL_BYWAY_ID], agentEnv());
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /BYWAY_CLOSE_REFUSED/);
    assert.equal(await fs.readFile(rig.recordPath(REAL_BYWAY_ID), "utf8"), before);

    await plantRealRecord(rig, "real-fork-3a241311.json", (raw) => {
      raw.closed = false;
      delete raw.closed_at;
    });
    const closed = await rig.cli(["sessions", "close", "--session-id", REAL_FORK_ID], agentEnv());
    assert.equal(closed.code, 0, `a real non-byway fork was refused: ${closed.stderr}`);
    assert.equal((await rig.onDisk(REAL_FORK_ID)).closed, true);
  });
});

// ─── §5.7 — no `session-started` stamp for a byway ───────────────────────────

async function readStampCalls(logPath: string): Promise<string[][]> {
  const raw = await fs.readFile(logPath, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as string[])
    .filter((call) => call[0] === "stamp");
}

test("stamp · a byway inheriting its source's brick never calls `brick stamp`; NEGATIVE — a plain copy of the same source still stamps", async () => {
  await withRig(async (rig) => {
    const source = await rig.create("source");
    const raw = await rig.onDisk(source);
    raw.metadata = { ...(raw.metadata as Record<string, unknown> | undefined), brick: BRICK_X };
    await fs.writeFile(rig.recordPath(source), `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const brickLog = path.join(rig.homeDir, "brick.log");
    const shimEnv = {
      PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
      BRICK_SHIM_MODE: "ok",
      BRICK_SHIM_ID: BRICK_X,
      BRICK_SHIM_LOG: brickLog,
    };

    const byway = await rig.byway(source, shimEnv);
    const bywayRecord = await rig.onDisk(byway);
    const metadata = bywayRecord.metadata as Record<string, unknown>;
    assert.equal(metadata.byway, "1");
    // KEPT: `$ACPX_BRICK` inside the byway still resolves (D9c).
    assert.equal(metadata.brick, BRICK_X, "the byway lost its inherited brick link");
    assert.deepEqual(await readStampCalls(brickLog), [], "a byway stamped session-started");

    const plain = createdId(
      await rig.cli(
        [
          ...rig.base,
          "--format",
          "json",
          "sessions",
          "copy",
          "--from",
          source,
          "--parent-id",
          source,
        ],
        shimEnv,
      ),
      "plain sessions copy",
    );
    assert.deepEqual(await readStampCalls(brickLog), [
      ["stamp", BRICK_X, "session-started", "--by", `session:${plain}`],
    ]);
  });
});

// ─── D8 — set-parent refuses / skips a byway ─────────────────────────────────

test("set-parent · `--session-id <byway>` is refused BYWAY_PARENT_IMMUTABLE (exit 2) — also with --no-parent — and the record is byte-identical", async () => {
  await withRig(async (rig) => {
    const source = await rig.create("source");
    const other = await rig.create("other");
    const byway = await rig.byway(source);
    const before = await fs.readFile(rig.recordPath(byway), "utf8");

    for (const flags of [["--parent-id", other], ["--no-parent"]]) {
      const result = await rig.cli([
        "--format",
        "json",
        "sessions",
        "set-parent",
        "--session-id",
        byway,
        ...flags,
      ]);
      assert.equal(result.code, 2, `${flags.join(" ")}: ${result.stderr}`);
      assert.equal(jsonLines(result.stdout).at(-1)?.code, "BYWAY_PARENT_IMMUTABLE");
    }
    assert.equal(await fs.readFile(rig.recordPath(byway), "utf8"), before, "the byway moved");
  });
});

test("set-parent · `--children-of` moves the plain child and SKIPS the byway (parent, parent seat and byway_parent untouched); --dry-run lists it", async () => {
  await withRig(async (rig) => {
    const source = await rig.create("source");
    const adopter = await rig.create("adopter");
    const byway = await rig.byway(source);
    const child = createdId(
      await rig.cli([...rig.base, "--format", "json", "sessions", "new", "--parent-id", source]),
      "plain child",
    );
    const before = await fs.readFile(rig.recordPath(byway), "utf8");

    const dry = await rig.cli([
      "sessions",
      "set-parent",
      "--children-of",
      source,
      "--parent-id",
      adopter,
      "--dry-run",
    ]);
    // Text names the skipped byway (short id) with its reason; the CODE rides in JSON (below),
    // exactly as every other set-parent skip renders.
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Skipped 1:/);
    assert.ok(dry.stdout.includes(byway.slice(0, 8)), dry.stdout);
    assert.match(dry.stdout, /by-the-way side-thread; it stays with the conversation/);
    const dryJson = await rig.cli([
      "--format",
      "json",
      "sessions",
      "set-parent",
      "--children-of",
      source,
      "--parent-id",
      adopter,
      "--dry-run",
    ]);
    assert.equal(dryJson.code, 0, dryJson.stderr);
    const drySkipped = jsonLines(dryJson.stdout).at(-1)?.skipped as { code: string }[] | undefined;
    assert.deepEqual(
      drySkipped?.map((entry) => entry.code),
      ["BYWAY_PARENT_IMMUTABLE"],
    );

    const moved = await rig.cli([
      "--format",
      "json",
      "sessions",
      "set-parent",
      "--children-of",
      source,
      "--parent-id",
      adopter,
    ]);
    assert.equal(moved.code, 0, moved.stderr);
    const result = jsonLines(moved.stdout).at(-1) as {
      moved: { acpxRecordId: string }[];
      skipped: { acpxRecordId: string; code: string }[];
    };
    assert.deepEqual(
      result.moved.map((entry) => entry.acpxRecordId),
      [child],
    );
    assert.deepEqual(
      result.skipped.map((entry) => [entry.acpxRecordId, entry.code]),
      [[byway, "BYWAY_PARENT_IMMUTABLE"]],
    );
    assert.equal((await rig.onDisk(child)).parent_session_id, adopter);
    assert.equal(await fs.readFile(rig.recordPath(byway), "utf8"), before, "the byway was moved");
    const bywayRecord = await rig.onDisk(byway);
    assert.equal(bywayRecord.parent_session_id, source);
    assert.equal((bywayRecord.metadata as Record<string, unknown>).byway_parent, source);
  });
});

// ─── §5.9 — `sessions list --local` hides byways ─────────────────────────────

test("list --local · a byway is hidden by default and listed with --include-byways; its source is listed either way", async () => {
  await withRig(async (rig) => {
    const source = await rig.create("source");
    const byway = await rig.byway(source);
    const listed = async (extra: string[]) => {
      const result = await rig.cli([
        ...rig.base,
        "--format",
        "json",
        "sessions",
        "list",
        "--local",
        ...extra,
      ]);
      assert.equal(result.code, 0, result.stderr);
      return result.stdout;
    };

    const hidden = await listed([]);
    assert.ok(hidden.includes(source), "the source session is missing");
    assert.ok(!hidden.includes(byway), "a byway was listed by default");

    const shown = await listed(["--include-byways"]);
    assert.ok(shown.includes(source));
    assert.ok(shown.includes(byway), "--include-byways did not list the byway");
  });
});
