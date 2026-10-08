// Brick b40a9a5d — `sessions new` creates AND enqueues the first turn in one call
// (`--prompt` / `--prompt-file`), `--no-parent` makes a top-level session, `--favorite` stars
// the new seat, and `sessions set-parent --no-parent` clears one session's parent.
//
// Every row drives the REAL compiled CLI against the mock agent in an isolated home and reads
// the result back from DISK (records, `index.json`, `seats.json`, the message ledger, the
// adapter's own env dump). Each published guarantee has its negative row: a refusal must leave
// ZERO new records and ZERO new seat rows, counted before and after.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { MessageLedgerLine } from "../src/cli/message-ledger.js";
import { withTempHome } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
// `--supports-fork-session`: `--from-template` refuses an agent without it.
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-fork-session`;
const UI_BASE = "https://ui.example.test";
// Every spawned queue owner dies at once: the session is created, its first turn cannot be.
const DEAD_OWNER_ARGS = JSON.stringify(["-e", "process.exit(3)"]);

// The suite itself runs inside an agent session; its identity must never leak into a row.
const IDENTITY_KEYS = [
  "ACPX_SESSION_URL",
  "ACPX_SEAT_URL",
  "ACPX_SESSION_RECORD_ID",
  "ACPX_SESSION_NAME",
  "ACPX_PARENT_SESSION_URL",
  "ACPX_PARENT_SEAT_URL",
  "ACPX_BRICK",
  "ACPX_BRICK_PATH",
  "ACPX_OWNER_LOG",
  "ACPX_QUEUE_OWNER_ARGS",
] as const;

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], env: NodeJS.ProcessEnv, stdin = ""): Promise<CliResult> {
  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ACPX_UI_BASE_URL: UI_BASE };
    delete childEnv.ACPX_STATE_HOME;
    for (const key of IDENTITY_KEYS) {
      delete childEnv[key];
    }
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end(stdin);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

type Rig = {
  stateHome: string;
  cwd: string;
  /** Global flags naming the mock agent explicitly. */
  base: string[];
  cli: (args: string[], env?: NodeJS.ProcessEnv, stdin?: string) => Promise<CliResult>;
  /** `sessions new` + extra flags, asserted rc 0; returns the parsed JSON result line. */
  create: (extra?: string[], env?: NodeJS.ProcessEnv) => Promise<Record<string, unknown>>;
  onDisk: (id: string) => Promise<Record<string, unknown>>;
  indexEntry: (id: string) => Promise<Record<string, unknown>>;
  seatRow: (seatId: string) => Promise<Record<string, unknown>>;
  /** Session records and seat rows on disk — the "nothing was created" denominator. */
  census: () => Promise<{ records: number; seats: number }>;
  /** The env of an agent caller: a real session of this home, and its seat. */
  agentEnv: (caller: string) => Promise<NodeJS.ProcessEnv>;
  ledger: () => Promise<MessageLedgerLine[]>;
  previews: (id: string) => Promise<string[]>;
  closeAll: () => Promise<void>;
};

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  await withTempHome("acpx-new-first-turn-", async (root) => {
    const home = path.join(root, "home");
    const stateHome = path.join(root, "state");
    const cwd = path.join(root, "workspace");
    await Promise.all([home, stateHome, cwd].map((dir) => fs.mkdir(dir, { recursive: true })));
    const sessionsDir = path.join(stateHome, ".acpx", "sessions");
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all"];
    const cli = (args: string[], env: NodeJS.ProcessEnv = {}, stdin = "") =>
      runCli(args, { HOME: home, ACPX_STATE_HOME: stateHome, ...env }, stdin);
    const readJson = async (file: string) =>
      JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    const onDisk = async (id: string) => await readJson(path.join(sessionsDir, `${id}.json`));
    const create = async (extra: string[] = [], env: NodeJS.ProcessEnv = {}) => {
      const result = await cli([...base, "--format", "json", "sessions", "new", ...extra], env);
      assert.equal(result.code, 0, `sessions new ${extra.join(" ")}: ${result.stderr}`);
      return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    };
    const indexEntry = async (id: string) => {
      const index = (await readJson(path.join(sessionsDir, "index.json"))) as {
        entries: Array<Record<string, unknown>>;
      };
      const entry = index.entries.find((candidate) => candidate.acpxRecordId === id);
      assert.ok(entry, `no index entry for ${id}`);
      return entry;
    };
    const seatRows = async () =>
      (await readJson(path.join(sessionsDir, "seats.json")).catch(() => ({}))) as Record<
        string,
        Record<string, unknown>
      >;
    const seatRow = async (seatId: string) => {
      const row = (await seatRows())[seatId];
      assert.ok(row, `no seat row for ${seatId}`);
      return row;
    };
    const census = async () => {
      const names = await fs.readdir(sessionsDir).catch(() => [] as string[]);
      return {
        records: names.filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).length,
        seats: Object.keys(await seatRows()).length,
      };
    };
    const agentEnv = async (caller: string) => ({
      ACPX_SESSION_URL: `${UI_BASE}/?session=${caller}`,
      ACPX_SEAT_URL: `${UI_BASE}/?seat=${String((await onDisk(caller)).seat_id)}`,
    });
    const ledger = async () => await readLedger(path.join(stateHome, ".acpx", "message-ledger"));
    const previews = async (id: string) => {
      const read = await cli([...base, "--format", "json", "sessions", "read", "--session-id", id]);
      if (read.code !== 0) {
        return [];
      }
      const parsed = JSON.parse(read.stdout.trim()) as {
        entries?: Array<{ textPreview?: unknown }>;
      };
      return (parsed.entries ?? []).map((entry) => String(entry.textPreview));
    };
    const closeAll = async () => {
      const names = await fs.readdir(sessionsDir).catch(() => [] as string[]);
      for (const name of names.filter((entry) => /^[0-9a-f-]{36}\.json$/.test(entry))) {
        await cli([...base, "sessions", "close", "--session-id", name.slice(0, 36)]);
      }
    };
    try {
      await run({
        stateHome,
        cwd,
        base,
        cli,
        create,
        onDisk,
        indexEntry,
        seatRow,
        census,
        agentEnv,
        ledger,
        previews,
        closeAll,
      });
    } finally {
      await closeAll();
    }
  });
}

async function readLedger(dir: string): Promise<MessageLedgerLine[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const lines: MessageLedgerLine[] = [];
  for (const name of names.toSorted()) {
    const raw = await fs.readFile(path.join(dir, name), "utf8");
    for (const line of raw.split("\n").filter((entry) => entry.length > 0)) {
      lines.push(JSON.parse(line) as MessageLedgerLine);
    }
  }
  return lines;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function writePromptFile(dir: string, text: string): Promise<string> {
  const file = path.join(dir, `prompt-${randomUUID()}.md`);
  await fs.writeFile(file, text, "utf8");
  return file;
}

async function waitForPreview(rig: Rig, id: string, marker: string): Promise<string[]> {
  return await waitFor(async () => {
    const previews = await rig.previews(id);
    return previews.includes(marker) ? previews : undefined;
  }, 20_000);
}

// ─── the goal: one call creates the session AND its first turn runs ─────────────────────────

test("new --prompt-file: one call creates the session, queues the file as its first turn, and the agent runs it", async () => {
  await withRig(async (rig) => {
    const file = await writePromptFile(rig.cwd, "echo first-turn-marker-7f3\n");
    const payload = await rig.create(["--prompt-file", file]);

    assert.equal(payload.action, "session_ensured");
    assert.equal(payload.created, true);
    assert.equal(payload.promptQueued, true);
    assert.equal(Object.hasOwn(payload, "promptError"), false);
    const id = String(payload.acpxRecordId);
    assert.match(String(payload.sessionUrl), new RegExp(`\\?session=${id}$`));
    assert.match(String(payload.seatUrl), /\?seat=[0-9a-f-]{36}$/);

    const previews = await waitForPreview(rig, id, "first-turn-marker-7f3");
    assert.ok(
      previews.includes("echo first-turn-marker-7f3"),
      `the file's text was the first turn: ${JSON.stringify(previews)}`,
    );
  });
});

test("new --prompt-file - reads the first turn from stdin", async () => {
  await withRig(async (rig) => {
    const result = await rig.cli(
      [...rig.base, "--format", "json", "--ttl", "1", "sessions", "new", "--prompt-file", "-"],
      {},
      "echo stdin-marker-21c\n",
    );
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.promptQueued, true);
    await waitForPreview(rig, String(payload.acpxRecordId), "stdin-marker-21c");
  });
});

test("new --prompt: an agent caller's first turn is recorded in the message ledger as a send to the new session", async () => {
  await withRig(async (rig) => {
    const caller = String((await rig.create()).acpxRecordId);
    const payload = await rig.create(
      ["--prompt", "echo ledger-marker"],
      await rig.agentEnv(caller),
    );
    const id = String(payload.acpxRecordId);
    const lines = (await rig.ledger()).filter((line) => line.to.session === id);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].kind, "prompt");
    assert.equal(lines[0].outcome, "accepted");
    assert.equal(lines[0].from.session, caller);
    assert.equal(lines[0].to.seat, payload.seatId);
    assert.equal(lines[0].text, "echo ledger-marker");
  });
});

test("new without a first turn prints no promptQueued key at all (the result line is unchanged)", async () => {
  await withRig(async (rig) => {
    const payload = await rig.create();
    assert.equal(Object.hasOwn(payload, "promptQueued"), false);
    assert.equal(Object.hasOwn(payload, "promptError"), false);
  });
});

// ─── decision 1: validate first — every refusal leaves NOTHING behind ───────────────────────

test("new refuses every invalid first-turn / parent combination before creating anything", async () => {
  await withRig(async (rig) => {
    const existing = await rig.create();
    const existingId = String(existing.acpxRecordId);
    const existingSeat = String(existing.seatId);
    const good = await writePromptFile(rig.cwd, "echo fine\n");
    const empty = await writePromptFile(rig.cwd, "");
    const blank = await writePromptFile(rig.cwd, "  \n\n\t\n");
    const cases: Array<{ flags: string[]; error: RegExp }> = [
      {
        flags: ["--prompt", "echo a", "--prompt-file", good],
        error: /Use only one of --prompt or --prompt-file/,
      },
      {
        flags: ["--prompt-file", path.join(rig.cwd, "missing.md")],
        error: /--prompt-file ".*missing\.md" cannot be read \(ENOENT\)/,
      },
      { flags: ["--prompt-file", rig.cwd], error: /cannot be read \(EISDIR\)/ },
      { flags: ["--prompt-file", empty], error: /--prompt-file ".*" is empty/ },
      { flags: ["--prompt-file", blank], error: /--prompt-file ".*" is empty/ },
      { flags: ["--prompt", ""], error: /Prompt must not be empty/ },
      { flags: ["--prompt", "   "], error: /Prompt must not be empty/ },
      { flags: ["--prompt", "echo a", "--no-prompt"], error: /--no-prompt cannot be combined/ },
      { flags: ["--no-prompt", "--prompt", "echo a"], error: /--no-prompt cannot be combined/ },
      { flags: ["--no-prompt", "--prompt-file", good], error: /--no-prompt cannot be combined/ },
      {
        flags: ["--prompt", "echo a", "--seat", existingSeat],
        error: /cannot be combined with --seat: .*sessions activate/,
      },
      {
        flags: ["--prompt-file", good, "--from", existingId],
        error: /cannot be combined with --from: .*sessions handover --brief/,
      },
      {
        flags: ["--no-parent", "--parent-id", existingId],
        error: /--no-parent cannot be combined/,
      },
      { flags: ["--no-parent", "--parent-seat", existingSeat], error: /--no-parent cannot be/ },
      {
        flags: ["--no-parent", "--parent-session-url", `${UI_BASE}/?session=${existingId}`],
        error: /--no-parent cannot be combined/,
      },
      { flags: ["--favorite", "--seat", existingSeat], error: /--favorite cannot be combined/ },
    ];
    for (const { flags, error } of cases) {
      const before = await rig.census();
      const result = await rig.cli([...rig.base, "sessions", "new", ...flags]);
      assert.notEqual(result.code, 0, `${flags.join(" ")} must be refused`);
      assert.match(`${result.stderr}${result.stdout}`, error, flags.join(" "));
      assert.deepEqual(await rig.census(), before, `${flags.join(" ")} created something`);
    }
  });
});

// ─── decision 3: created, but the enqueue failed ────────────────────────────────────────────

test("new --prompt whose enqueue fails: non-zero, ONE result line with promptQueued:false + error, the session kept and named", async () => {
  await withRig(async (rig) => {
    const before = await rig.census();
    const result = await rig.cli(
      [...rig.base, "--format", "json", "sessions", "new", "--prompt", "echo never"],
      { ACPX_QUEUE_OWNER_ARGS: DEAD_OWNER_ARGS },
    );
    assert.equal(result.code, 1, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `exactly one stdout line: ${result.stdout}`);
    const payload = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(payload.created, true);
    assert.equal(payload.promptQueued, false);
    const promptError = payload.promptError as { code?: unknown; message?: unknown };
    assert.match(String(promptError.message), /queue owner failed to start/);
    assert.equal(typeof promptError.code, "string");
    const id = String(payload.acpxRecordId);
    const seatUrl = payload.seatUrl;
    const sessionUrl = payload.sessionUrl;
    assert.ok(typeof seatUrl === "string" && typeof sessionUrl === "string", "names both");

    // Kept, open, and named on stderr with both ways forward.
    assert.deepEqual(await rig.census(), {
      records: before.records + 1,
      seats: before.seats + 1,
    });
    assert.notEqual((await rig.onDisk(id)).closed, true);
    assert.match(result.stderr, /first turn was NOT queued/);
    assert.ok(result.stderr.includes(seatUrl), result.stderr);
    assert.ok(result.stderr.includes(sessionUrl), result.stderr);
    assert.ok(result.stderr.includes(`sessions close --session-id ${id}`), result.stderr);
  });
});

// ─── HoD rule 3: the first turn takes the ordinary turn path — a cancel at its start holds ──

test("new --prompt: a cancel issued at the very start of the first turn cancels it (bf3a4533 path)", async () => {
  await withRig(async (rig) => {
    const payload = await rig.create(["--prompt", "sleep 5000"]);
    const id = String(payload.acpxRecordId);
    let cancelled = false;
    for (let attempt = 0; attempt < 80 && !cancelled; attempt += 1) {
      const cancel = await rig.cli([...rig.base, "--format", "json", "cancel", "--session-id", id]);
      assert.equal(cancel.code, 0, cancel.stderr);
      cancelled = (JSON.parse(cancel.stdout.trim()) as { cancelled?: unknown }).cancelled === true;
      if (!cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.equal(cancelled, true, "the cancel never reached the first turn");
    // Turns serialise: had the cancel been accepted and dropped, the 5 s turn would finish
    // first and leave its reply ahead of this one.
    const after = await rig.cli([
      ...rig.base,
      "--format",
      "json",
      "prompt",
      "--session-id",
      id,
      "echo after-cancel",
    ]);
    assert.equal(after.code, 0, after.stderr);
    const previews = await waitForPreview(rig, id, "after-cancel");
    assert.equal(previews.includes("slept 5000ms"), false, JSON.stringify(previews));
  });
});

// ─── --from-template: the first turn replaces the stored auto-prompt (HoD ruling R2) ────────

async function makeTemplate(rig: Rig, autoPrompt: string): Promise<string> {
  const id = String((await rig.create()).acpxRecordId);
  const enable = await rig.cli([
    ...rig.base,
    "sessions",
    "template",
    id,
    "--enable",
    "--slug",
    `tmpl-${id.slice(0, 8)}`,
    "--auto-prompt",
    autoPrompt,
  ]);
  assert.equal(enable.code, 0, enable.stderr);
  const close = await rig.cli([...rig.base, "sessions", "close", "--session-id", id]);
  assert.equal(close.code, 0, close.stderr);
  return id;
}

test("new --from-template --prompt-file: the file REPLACES the stored auto-prompt, said on stderr; promptQueued on the result", async () => {
  await withRig(async (rig) => {
    const template = await makeTemplate(rig, "echo stored-auto-prompt");
    const file = await writePromptFile(rig.cwd, "echo override-marker-55\n");
    const result = await rig.cli([
      ...rig.base,
      "--format",
      "json",
      "--ttl",
      "1",
      "sessions",
      "new",
      "--from-template",
      template,
      "--prompt-file",
      file,
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.action, "session_copied");
    assert.equal(payload.promptQueued, true);
    assert.match(result.stderr, /stored auto-prompt was REPLACED/);
    const previews = await waitForPreview(rig, String(payload.acpxRecordId), "override-marker-55");
    assert.equal(previews.includes("stored-auto-prompt"), false, JSON.stringify(previews));
  });
});

test("new --from-template without a prompt still fires the stored auto-prompt, with no replacement note", async () => {
  await withRig(async (rig) => {
    const template = await makeTemplate(rig, "echo stored-fires-31");
    const result = await rig.cli([
      ...rig.base,
      "--format",
      "json",
      "--ttl",
      "1",
      "sessions",
      "new",
      "--from-template",
      template,
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.promptQueued, true);
    assert.doesNotMatch(result.stderr, /REPLACED/);
    await waitForPreview(rig, String(payload.acpxRecordId), "stored-fires-31");
  });
});

// ─── --no-parent (HoD ruling R1): only the EDGE is dropped ──────────────────────────────────

test("new --no-parent: no parent session and no parent seat on record or index, and the agent gets no ACPX_PARENT_* — control: the same call without it", async () => {
  await withRig(async (rig) => {
    const caller = String((await rig.create()).acpxRecordId);
    const callerEnv = await rig.agentEnv(caller);
    const envDump = path.join(rig.cwd, `env-${randomUUID()}.json`);
    const dumpingBase = [
      "--cwd",
      rig.cwd,
      "--agent",
      `${MOCK_AGENT_COMMAND} --env-dump-file ${JSON.stringify(envDump)}`,
      "--approve-all",
    ];
    const spawnChild = async (extra: string[]) => {
      await fs.rm(envDump, { force: true });
      const result = await rig.cli(
        [...dumpingBase, "--format", "json", "--ttl", "1", "sessions", "new", ...extra],
        callerEnv,
      );
      assert.equal(result.code, 0, result.stderr);
      const id = String(
        (JSON.parse(result.stdout.trim()) as { acpxRecordId: unknown }).acpxRecordId,
      );
      // The dump the FIRST TURN's adapter wrote — the env the working agent runs with.
      await waitForPreview(rig, id, "env-check");
      const env = JSON.parse(await fs.readFile(envDump, "utf8")) as Record<string, string>;
      return { id, env };
    };

    const control = await spawnChild(["--prompt", "echo env-check"]);
    assert.equal((await rig.onDisk(control.id)).parent_session_id, caller);
    assert.equal(typeof (await rig.onDisk(control.id)).parent_seat_id, "string");
    assert.equal(control.env.ACPX_PARENT_SESSION_URL, `${UI_BASE}/?session=${caller}`);
    assert.match(control.env.ACPX_PARENT_SEAT_URL ?? "", /\?seat=/);

    const top = await spawnChild(["--no-parent", "--prompt", "echo env-check"]);
    const record = await rig.onDisk(top.id);
    assert.equal(Object.hasOwn(record, "parent_session_id"), false);
    assert.equal(Object.hasOwn(record, "parent_seat_id"), false);
    assert.equal(Object.hasOwn(record, "parent_session_url"), false);
    const entry = await rig.indexEntry(top.id);
    assert.equal(entry.parentSessionId, undefined);
    assert.equal(entry.parentSeatId, undefined);
    assert.equal(Object.hasOwn(top.env, "ACPX_PARENT_SESSION_URL"), false);
    assert.equal(Object.hasOwn(top.env, "ACPX_PARENT_SEAT_URL"), false);
    // Its own identity is still composed — the dump is not merely empty.
    assert.equal(top.env.ACPX_SESSION_URL, `${UI_BASE}/?session=${top.id}`);
  });
});

test("new --no-parent still inherits the agent and the brick from the caller (only the edge is dropped)", async () => {
  await withRig(async (rig) => {
    const brick = randomUUID();
    const callerResult = await rig.create();
    const caller = String(callerResult.acpxRecordId);
    const setBrick = await rig.cli(["seats", "set-brick", String(callerResult.seatId), brick]);
    assert.equal(setBrick.code, 0, setBrick.stderr);
    const callerRecord = await rig.onDisk(caller);
    // NO explicit agent: the compiled-in default would be codex; inheritance gives the caller's.
    const result = await rig.cli(
      ["--cwd", rig.cwd, "--approve-all", "--format", "json", "sessions", "new", "--no-parent"],
      await rig.agentEnv(caller),
    );
    assert.equal(result.code, 0, result.stderr);
    const id = String((JSON.parse(result.stdout.trim()) as { acpxRecordId: unknown }).acpxRecordId);
    const child = await rig.onDisk(id);
    assert.equal(child.agent_command, callerRecord.agent_command);
    assert.equal(Object.hasOwn(child, "parent_session_id"), false);
    assert.equal((child.metadata as Record<string, unknown> | undefined)?.brick, brick);
  });
});

test("new --from-template --no-parent: the template child records no parent edge", async () => {
  await withRig(async (rig) => {
    const template = await makeTemplate(rig, "");
    const caller = String((await rig.create()).acpxRecordId);
    const env = await rig.agentEnv(caller);
    const spawnFromTemplate = async (extra: string[]) => {
      const result = await rig.cli(
        [...rig.base, "--format", "json", "sessions", "new", "--from-template", template, ...extra],
        env,
      );
      assert.equal(result.code, 0, result.stderr);
      return await rig.onDisk(
        String((JSON.parse(result.stdout.trim()) as { acpxRecordId: unknown }).acpxRecordId),
      );
    };
    assert.equal((await spawnFromTemplate([])).parent_session_id, caller, "control");
    const top = await spawnFromTemplate(["--no-parent"]);
    assert.equal(Object.hasOwn(top, "parent_session_id"), false);
    assert.equal(Object.hasOwn(top, "parent_seat_id"), false);
  });
});

// ─── HoD ruling R4: `--from` never adopts the caller through the env fallback ───────────────

test("new --from a PARENTLESS seat-less session: the new session is parentless, not the caller's child", async () => {
  await withRig(async (rig) => {
    const caller = String((await rig.create()).acpxRecordId);
    const legacy = String((await rig.create()).acpxRecordId);
    // A pre-seat record: no seat, so `--from` mints a fresh seat (not a succession).
    const file = path.join(rig.stateHome, ".acpx", "sessions", `${legacy}.json`);
    const record = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    delete record.seat_id;
    delete record.holder_ordinal;
    delete record.holder_active;
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    const reindex = await rig.cli([...rig.base, "sessions", "reindex"]);
    assert.equal(reindex.code, 0, reindex.stderr);

    const payload = await rig.create(["--from", legacy], await rig.agentEnv(caller));
    const created = await rig.onDisk(String(payload.acpxRecordId));
    assert.notEqual(created.seat_id, undefined, "a fresh seat was minted");
    assert.equal(Object.hasOwn(created, "parent_session_id"), false, JSON.stringify(created));
    assert.equal(Object.hasOwn(created, "parent_seat_id"), false);
  });
});

// ─── --favorite: the SEAT row is starred (D-STAR) ───────────────────────────────────────────

test("new --favorite mints the seat starred — the seat row, never a record field; control: without it the row is unstarred", async () => {
  await withRig(async (rig) => {
    const starred = await rig.create(["--favorite"]);
    assert.equal((await rig.seatRow(String(starred.seatId))).favorite, true);
    const record = await rig.onDisk(String(starred.acpxRecordId));
    assert.equal(Object.hasOwn(record, "favorite"), false);

    const plain = await rig.create();
    assert.equal((await rig.seatRow(String(plain.seatId))).favorite, false);

    const shown = await rig.cli([
      ...rig.base,
      "--format",
      "json",
      "seats",
      "show",
      String(starred.seatId),
    ]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal((JSON.parse(shown.stdout.trim()) as { favorite?: unknown }).favorite, true);
  });
});

test("new --from-template --favorite stars the template child's new seat", async () => {
  await withRig(async (rig) => {
    const template = await makeTemplate(rig, "");
    const result = await rig.cli([
      ...rig.base,
      "--format",
      "json",
      "sessions",
      "new",
      "--from-template",
      template,
      "--favorite",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal((await rig.seatRow(String(payload.seatId))).favorite, true);
  });
});

// ─── set-parent --no-parent: clear one session's parent ─────────────────────────────────────

test("set-parent --no-parent clears parent session, parent seat, url and set-at on record AND index; spawned_by survives", async () => {
  await withRig(async (rig) => {
    const parent = String((await rig.create()).acpxRecordId);
    const child = String((await rig.create([], await rig.agentEnv(parent))).acpxRecordId);
    assert.equal((await rig.onDisk(child)).parent_session_id, parent, "precondition");
    assert.equal(typeof (await rig.onDisk(child)).parent_seat_id, "string", "precondition");

    const result = await rig.cli([
      ...rig.base,
      "--format",
      "json",
      "sessions",
      "set-parent",
      "--session-id",
      child,
      "--no-parent",
    ]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as {
      parent: unknown;
      moved: Array<Record<string, unknown>>;
    };
    assert.equal(payload.parent, null);
    assert.equal(payload.moved.length, 1);
    assert.equal(payload.moved[0].previousParentSessionId, parent);

    const record = await rig.onDisk(child);
    for (const key of [
      "parent_session_id",
      "parent_seat_id",
      "parent_session_url",
      "parent_set_at",
    ]) {
      assert.equal(Object.hasOwn(record, key), false, `record still carries ${key}`);
    }
    assert.equal(record.spawned_by_session_id, parent);
    const entry = await rig.indexEntry(child);
    assert.equal(entry.parentSessionId, undefined);
    assert.equal(entry.parentSeatId, undefined);
    assert.equal(entry.parentSetAt, undefined);
    assert.equal(entry.spawnedBySessionId, parent);
  });
});

test("set-parent --no-parent --dry-run writes nothing; a fork is warned about", async () => {
  await withRig(async (rig) => {
    const parent = String((await rig.create()).acpxRecordId);
    const child = String((await rig.create([], await rig.agentEnv(parent))).acpxRecordId);
    const before = await rig.onDisk(child);
    const dry = await rig.cli([
      ...rig.base,
      "sessions",
      "set-parent",
      "--session-id",
      child,
      "--no-parent",
      "--dry-run",
    ]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Would clear the parent of 1 session/);
    assert.deepEqual(await rig.onDisk(child), before);

    const fork = await rig.cli(
      [...rig.base, "--format", "json", "sessions", "fork", "--from", parent],
      await rig.agentEnv(parent),
    );
    assert.equal(fork.code, 0, fork.stderr);
    const forkId = String(
      (JSON.parse(fork.stdout.trim()) as { acpxRecordId: unknown }).acpxRecordId,
    );
    const cleared = await rig.cli([
      ...rig.base,
      "--format",
      "json",
      "sessions",
      "set-parent",
      "--session-id",
      forkId,
      "--no-parent",
    ]);
    assert.equal(cleared.code, 0, cleared.stderr);
    const warnings = (JSON.parse(cleared.stdout.trim()) as { warnings: string[] }).warnings;
    assert.ok(
      warnings.some((warning) => warning.includes(`was forked from ${parent}`)),
      JSON.stringify(warnings),
    );
  });
});

test("set-parent --no-parent refuses --children-of, any --parent-* flag, and an empty parent is still not a clear", async () => {
  await withRig(async (rig) => {
    const parent = String((await rig.create()).acpxRecordId);
    const child = String((await rig.create([], await rig.agentEnv(parent))).acpxRecordId);
    const before = await rig.onDisk(child);
    const cases: Array<{ flags: string[]; code: string }> = [
      { flags: ["--children-of", parent, "--no-parent"], code: "USAGE" },
      { flags: ["--session-id", child, "--no-parent", "--parent-id", parent], code: "USAGE" },
      { flags: ["--session-id", child, "--no-parent", "--parent-id", ""], code: "USAGE" },
      { flags: ["--session-id", child, "--parent-id", ""], code: "PARENT_DETACH_UNSUPPORTED" },
    ];
    for (const { flags, code } of cases) {
      const result = await rig.cli([
        ...rig.base,
        "--format",
        "json",
        "sessions",
        "set-parent",
        ...flags,
      ]);
      assert.equal(result.code, 2, `${flags.join(" ")}: ${result.stdout}${result.stderr}`);
      assert.equal((JSON.parse(result.stdout.trim()) as { code?: unknown }).code, code);
      assert.deepEqual(await rig.onDisk(child), before, `${flags.join(" ")} wrote the record`);
    }
  });
});

// ─── decision 5: --resume-session + a first turn is allowed (a normal active holder) ────────

test("new --resume-session --prompt: the resumed session is created and its first turn runs", async () => {
  await withRig(async (rig) => {
    const loadable = `${MOCK_AGENT_COMMAND} --supports-load-session`;
    const base = ["--cwd", rig.cwd, "--agent", loadable, "--approve-all", "--format", "json"];
    const first = await rig.cli([...base, "sessions", "new"]);
    assert.equal(first.code, 0, first.stderr);
    const original = String(
      (JSON.parse(first.stdout.trim()) as { acpxRecordId: unknown }).acpxRecordId,
    );
    const acpSessionId = String((await rig.onDisk(original)).acp_session_id);
    const close = await rig.cli([...rig.base, "sessions", "close", "--session-id", original]);
    assert.equal(close.code, 0, close.stderr);

    const resumed = await rig.cli([
      ...base,
      "sessions",
      "new",
      "--resume-session",
      acpSessionId,
      // A fresh local record: without it the record id defaults to the ACP session id, i.e.
      // the CLOSED original's file, and the first turn is (rightly) refused as closed.
      "--record-id",
      randomUUID(),
      "--prompt",
      "echo resumed-marker-9d",
    ]);
    assert.equal(resumed.code, 0, resumed.stderr);
    const payload = JSON.parse(resumed.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.promptQueued, true);
    await waitForPreview(rig, String(payload.acpxRecordId), "resumed-marker-9d");
  });
});

// ─── --from-template honours --parent-seat (it was silently dropped before b40a9a5d) ────────

test("new --from-template --parent-seat records that seat's holder as parent, not the env caller", async () => {
  await withRig(async (rig) => {
    const template = await makeTemplate(rig, "");
    const envCaller = String((await rig.create()).acpxRecordId);
    const seatParent = await rig.create();
    const result = await rig.cli(
      [
        ...rig.base,
        "--format",
        "json",
        "sessions",
        "new",
        "--from-template",
        template,
        "--parent-seat",
        String(seatParent.seatId),
      ],
      await rig.agentEnv(envCaller),
    );
    assert.equal(result.code, 0, result.stderr);
    const child = await rig.onDisk(
      String((JSON.parse(result.stdout.trim()) as { acpxRecordId: unknown }).acpxRecordId),
    );
    assert.equal(child.parent_session_id, seatParent.acpxRecordId);
    assert.equal(child.parent_seat_id, seatParent.seatId);
  });
});
