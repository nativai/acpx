import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { composeForkDivergenceNotice } from "../src/cli/session/fork-handoff.js";
import { SEAT_STORE_NO_CHANGE, withSeatStoreWrite } from "../src/session/persistence.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// Brick 155e1d8a (V1, P5-SEAT-VERIFY holes #1 #2 #4 #5 #7 #16 #18 + F6): every acpx CLI
// surface where an agent names or reads another agent is seat-first. Every row drives the
// REAL compiled CLI against the mock agent and reads the outcome back from the record on
// DISK — the defect class here (#1) is a flag accepted rc 0 and silently replaced, which an
// echo of the CLI's own output cannot see.
//
// 🔑 THE FIXTURE SEAT IS ALWAYS ONE WHOSE ACTIVE HOLDER IS NOT THE CALLER, and the caller
// always HAS an ambient `ACPX_SESSION_URL`. The verifier's first probe used its own seat and
// could not tell "resolved the seat" from "fell back to env" (SEAT-FIRST-VERIFICATION.md,
// instrument note 2); with a distinct holder and a live env fallback the two predict
// different parents.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const UI_BASE = "https://ui.example.test";

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(
  args: string[],
  homeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ACPX_UI_BASE_URL: UI_BASE,
      ...extraEnv,
    };
    delete env.ACPX_STATE_HOME;
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_PARENT_SEAT_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
    ]) {
      if (!Object.prototype.hasOwnProperty.call(extraEnv, key)) {
        delete env[key];
      }
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

type Rig = {
  homeDir: string;
  sessionDir: string;
  base: string[];
  cli: (args: string[], extraEnv?: NodeJS.ProcessEnv) => Promise<CliResult>;
  create: (extra?: string[], extraEnv?: NodeJS.ProcessEnv) => Promise<string>;
  onDisk: (id: string) => Promise<Record<string, unknown>>;
};

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  await withTempHome("acpx-seat-first-cli-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all"];
    const cli = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
      runCli(args, homeDir, extraEnv);
    const onDisk = async (id: string) =>
      JSON.parse(
        await fs.readFile(path.join(homeDir, ".acpx", "sessions", `${id}.json`), "utf8"),
      ) as Record<string, unknown>;
    const create = async (extra: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) => {
      const result = await cli(
        [...base, "--format", "json", "sessions", "new", ...extra],
        extraEnv,
      );
      assert.equal(result.code, 0, `sessions new ${extra.join(" ")}: ${result.stderr}`);
      return String((JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId);
    };
    await run({
      homeDir,
      sessionDir: path.join(homeDir, ".acpx", "sessions"),
      base,
      cli,
      create,
      onDisk,
    });
  });
}

/**
 * A seat that has been through ONE succession: `founder` (holder #1, retired, still open)
 * and `successor` (holder #2, ACTIVE). A resolver that reads the founder — the seat's
 * first holder, or the session the caller happened to remember — is wrong, and only the
 * successor is right.
 */
async function succeededSeat(
  rig: Rig,
  name: string,
): Promise<{ seatId: string; founder: string; successor: string }> {
  const founder = await rig.create(["-s", name]);
  const seatId = String((await rig.onDisk(founder)).seat_id);
  const successor = await rig.create(["--from", founder]);
  const activated = await rig.cli(["sessions", "activate", seatId, successor, "--no-notify"]);
  assert.equal(activated.code, 0, `activate: ${activated.stderr}`);
  assert.equal((await rig.onDisk(successor)).holder_active, true, "precondition: successor active");
  return { seatId, founder, successor };
}

async function sessionCount(sessionDir: string): Promise<number> {
  const names = await fs.readdir(sessionDir);
  return names.filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).length;
}

// ─── #1 — the parent flag honours a seat (THE SILENT DEFECT) ────────────────

test("#1 · `--parent-session-url <?seat=S>` records S's ACTIVE holder and S — never the caller's env", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create(["-s", "caller"]);
    const { seatId, successor } = await succeededSeat(rig, "parent-seat");
    const callerEnv = { ACPX_SESSION_URL: `${UI_BASE}/?session=${caller}` };

    const child = await rig.create(
      ["--parent-session-url", `${UI_BASE}/?seat=${seatId}`],
      callerEnv,
    );
    const record = await rig.onDisk(child);
    assert.notEqual(record.parent_session_id, caller, "fell back to the caller's ACPX_SESSION_URL");
    assert.equal(record.parent_session_id, successor, "parent is not the seat's ACTIVE holder");
    assert.equal(record.parent_seat_id, seatId, "the parent SEAT is not recorded beside it");
  });
});

test("#1 · `--parent-seat <uuid>` and `--parent-seat <?seat= url>` both resolve to the ACTIVE holder", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create(["-s", "caller"]);
    const { seatId, successor } = await succeededSeat(rig, "parent-seat");
    const callerEnv = { ACPX_SESSION_URL: `${UI_BASE}/?session=${caller}` };

    for (const value of [seatId, `${UI_BASE}/?seat=${seatId}`]) {
      const child = await rig.create(["--parent-seat", value], callerEnv);
      const record = await rig.onDisk(child);
      assert.equal(record.parent_session_id, successor, `--parent-seat ${value}`);
      assert.equal(record.parent_seat_id, seatId, `--parent-seat ${value}`);
    }
  });
});

test("#1 · an UNRESOLVABLE seat is REFUSED (rc ≠ 0, cause named) and creates nothing", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create(["-s", "caller"]);
    const callerEnv = { ACPX_SESSION_URL: `${UI_BASE}/?session=${caller}` };
    const unknownSeat = "0f0f0f0f-1111-4222-8333-444455556666";
    const before = await sessionCount(rig.sessionDir);

    for (const flags of [
      ["--parent-seat", unknownSeat],
      ["--parent-session-url", `${UI_BASE}/?seat=${unknownSeat}`],
    ]) {
      const result = await rig.cli([...rig.base, "sessions", "new", ...flags], callerEnv);
      assert.notEqual(result.code, 0, `${flags.join(" ")} was accepted: ${result.stderr}`);
      assert.match(
        result.stderr,
        /seat/i,
        `${flags.join(" ")}: the refusal does not name the seat`,
      );
      assert.ok(result.stderr.includes(unknownSeat), result.stderr);
    }
    assert.equal(
      await sessionCount(rig.sessionDir),
      before,
      "a refused create still wrote a record",
    );
  });
});

test("#1 · a `--parent-session-url` naming NEITHER ?session= nor ?seat= is REFUSED, never replaced by env", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create(["-s", "caller"]);
    const before = await sessionCount(rig.sessionDir);
    const result = await rig.cli(
      [...rig.base, "sessions", "new", "--parent-session-url", `${UI_BASE}/?tab=board`],
      { ACPX_SESSION_URL: `${UI_BASE}/?session=${caller}` },
    );
    assert.notEqual(result.code, 0, `accepted: ${result.stderr}`);
    assert.match(result.stderr, /--parent-session-url/);
    assert.equal(await sessionCount(rig.sessionDir), before);
  });
});

test("#1 · `--parent-seat` together with a session-form parent flag is refused as ambiguous", async () => {
  await withRig(async (rig) => {
    const { seatId, founder } = await succeededSeat(rig, "parent-seat");
    const result = await rig.cli([
      ...rig.base,
      "sessions",
      "new",
      "--parent-seat",
      seatId,
      "--parent-id",
      founder,
    ]);
    assert.notEqual(result.code, 0, result.stderr);
    assert.match(result.stderr, /--parent-seat/);
  });
});

test("#1 pair · the session forms still work unchanged: `--parent-session-url ?session=` and `--parent-id`", async () => {
  await withRig(async (rig) => {
    const { seatId, founder } = await succeededSeat(rig, "parent-seat");
    const viaUrl = await rig.create(["--parent-session-url", `${UI_BASE}/?session=${founder}`]);
    const viaId = await rig.create(["--parent-id", founder]);
    for (const id of [viaUrl, viaId]) {
      const record = await rig.onDisk(id);
      // The deliberate SESSION form names a session, so it records THAT session — the
      // retired founder — and does not silently redirect to the seat's successor.
      assert.equal(record.parent_session_id, founder);
      assert.equal(record.parent_seat_id, seatId);
    }
  });
});

// ─── #2 — set-parent seat form ──────────────────────────────────────────────

test("#2 · `sessions set-parent --parent-seat S` re-parents onto S's ACTIVE holder and records S", async () => {
  await withRig(async (rig) => {
    const { seatId, successor } = await succeededSeat(rig, "new-parent");
    for (const flags of [
      ["--parent-seat", seatId],
      ["--parent-session-url", `${UI_BASE}/?seat=${seatId}`],
    ]) {
      const child = await rig.create(["-s", "child"]);
      const result = await rig.cli(["sessions", "set-parent", "--session-id", child, ...flags]);
      assert.equal(result.code, 0, `${flags.join(" ")}: ${result.stderr}`);
      const record = await rig.onDisk(child);
      assert.equal(record.parent_session_id, successor, flags.join(" "));
      assert.equal(record.parent_seat_id, seatId, flags.join(" "));
    }
  });
});

test("#2 · set-parent's refusals name the REAL cause: an unknown seat, and the seat form among the options", async () => {
  await withRig(async (rig) => {
    const child = await rig.create(["-s", "child"]);
    const unknownSeat = "0f0f0f0f-1111-4222-8333-444455556666";
    const viaUrl = await rig.cli([
      "sessions",
      "set-parent",
      "--session-id",
      child,
      "--parent-session-url",
      `${UI_BASE}/?seat=${unknownSeat}`,
      "--dry-run",
    ]);
    assert.notEqual(viaUrl.code, 0);
    // The verifier's row 4f: the flag WAS passed and the old refusal said it was not.
    assert.doesNotMatch(viaUrl.stderr, /requires exactly one of/);
    assert.ok(viaUrl.stderr.includes(unknownSeat), viaUrl.stderr);
    assert.match(viaUrl.stderr, /seat/i);

    const none = await rig.cli(["sessions", "set-parent", "--session-id", child, "--dry-run"]);
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /--parent-seat/, "the usage refusal does not offer the seat form");
  });
});

// ─── #4 — sessions show (text) ──────────────────────────────────────────────

test("#4 · `sessions show` TEXT carries the seat, the holder line and the parent seat", async () => {
  await withRig(async (rig) => {
    const parent = await rig.create(["-s", "show-parent"]);
    const parentSeat = String((await rig.onDisk(parent)).seat_id);
    const child = await rig.create(["--parent-id", parent]);
    const childSeat = String((await rig.onDisk(child)).seat_id);
    const shown = await rig.cli(["sessions", "show", "--session-id", child]);
    assert.equal(shown.code, 0, shown.stderr);
    const lines = shown.stdout.split("\n");
    assert.ok(lines.includes(`seat: ${childSeat}`), shown.stdout);
    assert.ok(lines.includes(`seatUrl: ${UI_BASE}/?seat=${childSeat}`), shown.stdout);
    assert.ok(lines.includes("holder: #1 (active)"), shown.stdout);
    assert.ok(lines.includes(`parentSession: ${parent}`), shown.stdout);
    assert.ok(lines.includes(`parentSeat: ${parentSeat}`), shown.stdout);
  });
});

// ─── #5 — the sessions new banner ───────────────────────────────────────────

test("#5 · the `sessions new` stderr banner opens with the ?seat= URL; the ?session= URL is detail after it", async () => {
  await withRig(async (rig) => {
    const result = await rig.cli([...rig.base, "sessions", "new", "-s", "banner"]);
    assert.equal(result.code, 0, result.stderr);
    const id = result.stdout.split("\n")[0];
    const seatId = String((await rig.onDisk(id)).seat_id);
    // The banner proper — a first run on a fresh store prints an unrelated index-rebuild
    // notice ABOVE it, so "first stderr line" is not the banner's first line.
    const lines = result.stderr.split("\n").filter((line) => line.length > 0);
    const seatLine = lines.indexOf(`[acpx] seat url: ${UI_BASE}/?seat=${seatId}`);
    const createdLine = lines.indexOf(`[acpx] created session ${id}`);
    const sessionLine = lines.findIndex((line) => line.includes(`?session=${id}`));
    assert.ok(seatLine >= 0, result.stderr);
    assert.ok(seatLine < createdLine, `the seat is not first in the banner:\n${result.stderr}`);
    assert.ok(createdLine < sessionLine, result.stderr);
  });
});

// ─── #7 — sessions list --local ─────────────────────────────────────────────

test("#7 · `sessions list --local` carries a seat column (seat8 + name) by default", async () => {
  await withRig(async (rig) => {
    const id = await rig.create(["-s", "listed-seat"]);
    const seatId = String((await rig.onDisk(id)).seat_id);
    const listed = await rig.cli([...rig.base, "sessions", "list", "--local"]);
    assert.equal(listed.code, 0, listed.stderr);
    const row = listed.stdout.split("\n").find((line) => line.startsWith(id));
    assert.ok(row, listed.stdout);
    assert.ok(row.includes(`seat ${seatId.slice(0, 8)} listed-seat`), row);
  });
});

// ─── #16 — the fork notice ──────────────────────────────────────────────────

test("#16 · the ⟦FORK-NOTICE⟧ names the fork's NEW seat and $ACPX_SEAT_URL, and never advises `printenv`", () => {
  const previous = process.env.ACPX_UI_BASE_URL;
  process.env.ACPX_UI_BASE_URL = UI_BASE;
  try {
    const fork = makeSessionRecord({
      acpxRecordId: "11111111-2222-4333-8444-555555555555",
      acpSessionId: "11111111-2222-4333-8444-555555555555",
      agentCommand: "agent",
      cwd: "/tmp",
      seatId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    });
    const notice = composeForkDivergenceNotice(fork, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
    assert.ok(notice.includes(`${UI_BASE}/?seat=${fork.seatId}`), notice);
    assert.ok(notice.includes("$ACPX_SEAT_URL"), notice);
    assert.match(notice, /NEW seat/);
    // `printenv | grep ACPX_` puts every ACPX_* value — credentials included — into the
    // transcript, where it is re-sent on every later turn.
    assert.doesNotMatch(notice, /printenv/);
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_UI_BASE_URL;
    } else {
      process.env.ACPX_UI_BASE_URL = previous;
    }
  }
});

test("#16 · the notice names the SOURCE's seat as the source's; a seat-less record still gets no env dump", () => {
  const previous = process.env.ACPX_UI_BASE_URL;
  process.env.ACPX_UI_BASE_URL = UI_BASE;
  try {
    const sourceSeat = "cccccccc-dddd-4eee-8fff-000000000000";
    const fork = makeSessionRecord({
      acpxRecordId: "11111111-2222-4333-8444-555555555555",
      acpSessionId: "11111111-2222-4333-8444-555555555555",
      agentCommand: "agent",
      cwd: "/tmp",
      seatId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    });
    const notice = composeForkDivergenceNotice(
      fork,
      "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
      sourceSeat,
    );
    assert.ok(
      notice.includes(`(seat ${sourceSeat}) — that seat is the SOURCE's, not yours`),
      notice,
    );

    const seatless = makeSessionRecord({
      acpxRecordId: "11111111-2222-4333-8444-555555555555",
      acpSessionId: "11111111-2222-4333-8444-555555555555",
      agentCommand: "agent",
      cwd: "/tmp",
    });
    const legacy = composeForkDivergenceNotice(seatless, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
    assert.ok(legacy.includes(`${UI_BASE}/?session=${seatless.acpxRecordId}`), legacy);
    assert.doesNotMatch(legacy, /\?seat=|printenv/);
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_UI_BASE_URL;
    } else {
      process.env.ACPX_UI_BASE_URL = previous;
    }
  }
});

// ─── #18 — the caller-side resolver on prompt / status / cancel / close ─────

test("#18 · `status --seat S` and `status --session-url ?seat=S` address the ACTIVE holder after a succession", async () => {
  await withRig(async (rig) => {
    const { seatId, successor } = await succeededSeat(rig, "addressed");
    for (const flags of [
      ["--seat", seatId],
      ["--seat", `${UI_BASE}/?seat=${seatId}`],
      ["--session-url", `${UI_BASE}/?seat=${seatId}`],
    ]) {
      const result = await rig.cli([...rig.base, "--format", "json", "status", ...flags]);
      assert.equal(result.code, 0, `${flags.join(" ")}: ${result.stderr}`);
      const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      assert.equal(payload.acpxRecordId ?? payload.sessionId, successor, flags.join(" "));
    }
  });
});

test("#18 · `prompt --seat S` drives the SUCCESSOR, not the retired founder", async () => {
  await withRig(async (rig) => {
    const { seatId, founder, successor } = await succeededSeat(rig, "prompted");
    const result = await rig.cli([
      ...rig.base,
      "--ttl",
      "1",
      "prompt",
      "--seat",
      seatId,
      "echo seat-addressed",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /seat-addressed/);
    assert.ok(result.stderr.includes(`[acpx] session ${successor}`), result.stderr);
    assert.equal(
      (await rig.onDisk(founder)).last_prompt_at ?? null,
      null,
      "the founder was prompted",
    );
  });
});

test("#18 · `cancel --seat S` and `sessions close --seat S` act on the ACTIVE holder", async () => {
  await withRig(async (rig) => {
    const { seatId, founder, successor } = await succeededSeat(rig, "closed-by-seat");
    const cancelled = await rig.cli([...rig.base, "--format", "json", "cancel", "--seat", seatId]);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.ok(cancelled.stdout.includes(successor), cancelled.stdout);

    const closed = await rig.cli(["sessions", "close", "--seat", seatId]);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal((await rig.onDisk(successor)).closed, true, "the active holder was not closed");
    assert.notEqual((await rig.onDisk(founder)).closed, true, "the retired founder was closed");
  });
});

test("#18 · an unknown seat, a CLOSED seat and a VACANT seat are each refused with their own cause", async () => {
  await withRig(async (rig) => {
    const unknownSeat = "0f0f0f0f-1111-4222-8333-444455556666";
    const unknown = await rig.cli([...rig.base, "status", "--seat", unknownSeat]);
    assert.notEqual(unknown.code, 0);
    assert.ok(unknown.stderr.includes(unknownSeat), unknown.stderr);
    assert.match(unknown.stderr, /not in this box's seat store/);

    const closedHolder = await rig.create(["-s", "abolished"]);
    const closedSeat = String((await rig.onDisk(closedHolder)).seat_id);
    const vacantHolder = await rig.create(["-s", "vacant"]);
    const vacantSeat = String((await rig.onDisk(vacantHolder)).seat_id);
    await withSeatStoreWrite(rig.sessionDir, (store) => {
      const seats = new Map(store.seats);
      const closedRow = seats.get(closedSeat);
      const vacantRow = seats.get(vacantSeat);
      if (!closedRow || !vacantRow) {
        return { mutation: SEAT_STORE_NO_CHANGE, result: undefined };
      }
      seats.set(closedSeat, { ...closedRow, closedAt: "2026-10-06T00:00:00.000Z" });
      seats.set(vacantSeat, { ...vacantRow, activeHolderId: null });
      return { mutation: { kind: "write", seats }, result: undefined };
    });

    const closed = await rig.cli([...rig.base, "status", "--seat", closedSeat]);
    assert.notEqual(closed.code, 0);
    assert.match(closed.stderr, /seat .* is closed/);

    const vacant = await rig.cli([...rig.base, "status", "--seat", vacantSeat]);
    assert.notEqual(vacant.code, 0);
    assert.match(vacant.stderr, /no active holder/);
  });
});

test("#18 · `--seat` with `--session-id` is refused; `--session-id` stays the deliberate session form", async () => {
  await withRig(async (rig) => {
    const { seatId, founder } = await succeededSeat(rig, "exception");
    const both = await rig.cli([...rig.base, "status", "--seat", seatId, "--session-id", founder]);
    assert.notEqual(both.code, 0);
    assert.match(both.stderr, /--seat/);

    // The deliberate exception: a session id names THAT session, retired or not.
    const direct = await rig.cli([
      ...rig.base,
      "--format",
      "json",
      "status",
      "--session-id",
      founder,
    ]);
    assert.equal(direct.code, 0, direct.stderr);
    const payload = JSON.parse(direct.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.acpxRecordId ?? payload.sessionId, founder);
  });
});

// ─── F6 — the copy/fork JSON is seat-blind ──────────────────────────────────

test("F6 · `sessions copy --format json` carries the copy's NEW seatId and seatUrl", async () => {
  await withRig(async (rig) => {
    const forkable = await rig.cli([
      "--cwd",
      rig.base[1],
      "--agent",
      `${MOCK_AGENT_COMMAND} --supports-fork-session`,
      "--approve-all",
      "--format",
      "json",
      "sessions",
      "new",
      "-s",
      "fork-source",
    ]);
    assert.equal(forkable.code, 0, forkable.stderr);
    const sourceId = String(
      (JSON.parse(forkable.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const copied = await rig.cli(["--format", "json", "sessions", "copy", "--from", sourceId]);
    assert.equal(copied.code, 0, copied.stderr);
    const json = JSON.parse(copied.stdout.trim()) as {
      acpxRecordId: string;
      seatId?: string;
      seatUrl?: string;
    };
    const copySeat = String((await rig.onDisk(json.acpxRecordId)).seat_id);
    assert.equal(json.seatId, copySeat);
    assert.equal(json.seatUrl, `${UI_BASE}/?seat=${copySeat}`);
  });
});
