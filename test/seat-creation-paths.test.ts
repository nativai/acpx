import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AcpClient } from "../src/acp/client.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { textPrompt } from "../src/prompt-content.js";
import {
  readSeatStore,
  resolveSessionRecord,
  seatFromStore,
  withSeatStoreWrite,
} from "../src/session/persistence.js";
import type { SessionNotification, SessionRecord } from "../src/types.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// Brick 5ad22d5d, GATE-B1-FALSIFIABILITY §G2 — "Any path yields a record read
// back from disk with seat_id absent/empty" is the falsifying observation, and
// THREE SEPARATE tests are required: a shared test exercising one path is
// exactly the failure mode D-B1-7 warns about — path 3 (runtime.ts
// teammate_spawned) is the one a createSessionRecordWithClient-level fix
// misses silently, because it is the only path not reached through it.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type CliResult = { code: number | null; stdout: string; stderr: string };

// Modelled directly on session-reparent.test.ts's runCli — same scrub list
// (a fixture built without it can silently acquire the TEST RUNNER's own
// session as ambient context) plus the same real-compiled-CLI rationale: the
// failure this feature is exposed to is a field dropped by one of the
// field-by-field persistence transforms, and every one of those legs is
// green under a unit call on the mutator alone.
function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
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

function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  return withTempHomeFixture("acpx-seat-creation-paths-", run);
}

async function readRecordJson(homeDir: string, id: string): Promise<Record<string, unknown>> {
  const file = path.join(homeDir, ".acpx", "sessions", `${id}.json`);
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}

// ─── Path 1 — normal create ─────────────────────────────────────────────────

test("G2/path 1 · `sessions new` mints a fresh seat, read back from DISK", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const created = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "-s",
        "path1",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    // Read back from DISK, not the CLI's own stdout echo — the falsifying
    // observation is specifically about what a REAL FILE READ finds.
    const onDisk = await readRecordJson(homeDir, id);
    assert.equal(
      typeof onDisk.seat_id === "string" && onDisk.seat_id.length > 0,
      true,
      "path 1: seat_id absent/empty on the record read back from disk",
    );
    assert.equal(onDisk.holder_ordinal, 1);
    assert.equal(onDisk.holder_active, true);
  });
});

// ─── Path 2 — fork / copy ───────────────────────────────────────────────────
//
// RESTORED 2026-09-28 by B2 (brick b64dfbb3), having been removed by `e071ad9`
// under Daniel's ruling of the same day — *"if this Test is doing trouble then
// completely remove it please"* (brick 8bc0cbb4 / d9ba2870).
//
// 🔑 WHY RESTORING IT IS NOT DEFYING THAT RULING. The instruction was about a
// TROUBLESOME ROW, not a decision to stop protecting the PROPERTY — and the
// property is Daniel's own binding ruling from six days earlier: every fork
// mints a NEW seat, no exceptions (2026-09-22, topic 1). Removing the row left
// that property undefended at exactly the moment the block most likely to break
// it began work: B2/D11 adds `--seat`, whose naive implementation on the SHARED
// mint seam (`seatId: options.seatId ?? crypto.randomUUID()`) would make a fork
// silently inherit a seat. ⇒ THIS ROW IS NOW D11's REGRESSION GUARD, not
// housekeeping.
//
// THE FLAKE'S KNOWN CAUSE WAS A FIXTURE DEFECT AND IT IS REPAIRED ON THIS
// BRANCH. `sessions new`/`copy` intentionally leave a detached `__queue-owner`
// daemon running past the CLI call's exit (`queue-owner-process.ts`,
// `detached: true` by design), and it can still be writing under
// `<tempHome>/.acpx/sessions/` when `withTempHome` tears the dir down —
// `force` suppresses ENOENT, not ENOTEMPTY. `runtime-test-helpers.ts` now
// passes `{ maxRetries: 5, retryDelay: 100 }`, shared by 65 test files.
// ⚠️ READ THAT AT EXACTLY ITS WIDTH: it is evidence about the FIXTURE, not
// about this row. The commit's 45/45 is `withTempHome`'s number, and this row
// is a NEW SUBJECT. Its own stability is measured separately and cited in the
// commit message, under real box load, because the original row's defect WAS
// intermittency — a row reinstated on "the flake is fixed" is precisely the row
// whose stability must be measured rather than argued, and this slot gets one
// credible restoration.

test("G2/path 2 · `sessions copy` mints a NEW seat and never inherits the source's", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    // ⚠️ THE SOURCE MUST BE CREATED WITH A FORK-CAPABLE AGENT, and this is the one
    // fixture detail the restoration has to get right: `sessions copy` refuses
    // outright unless the agent advertises `sessionCapabilities.fork`
    // (session-management.ts), so a plain MOCK_AGENT_COMMAND source makes the copy
    // exit 1 — which looks like the seat assertion failing and is not. Recovered
    // from the removed row in `e071ad9` rather than re-derived.
    const sourceAgent = `${MOCK_AGENT_COMMAND} --supports-fork-session`;
    const source = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        sourceAgent,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "-s",
        "path2-source",
      ],
      homeDir,
    );
    assert.equal(source.code, 0, source.stderr);
    const sourceId = String(
      (JSON.parse(source.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const sourceSeat = (await readRecordJson(homeDir, sourceId)).seat_id;
    assert.equal(
      typeof sourceSeat === "string" && sourceSeat.length > 0,
      true,
      "source precondition",
    );

    // `copy` inherits cwd and agent from the source record — as the original row did.
    const copied = await runCli(
      ["--format", "json", "sessions", "copy", "--from", sourceId, "--name", "path2-copy"],
      homeDir,
    );
    assert.equal(copied.code, 0, copied.stderr);
    const copyId = String(
      (JSON.parse(copied.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    // Read back from DISK — the falsifying observation is about what a real file
    // read finds, not what the CLI echoed.
    const copy = await readRecordJson(homeDir, copyId);
    assert.equal(
      typeof copy.seat_id === "string" && copy.seat_id.length > 0,
      true,
      "path 2: seat_id absent/empty on the copy read back from disk",
    );
    // 🛑 THE FALSIFIER. This is the assertion that goes red if the fork path is
    // ever changed to carry the source's seat — including by the naive `??`
    // spelling of D11's join on the shared mint seam.
    assert.notEqual(
      copy.seat_id,
      sourceSeat,
      "path 2: the copy INHERITED the source's seat — every fork must mint a new one (Daniel, 2026-09-22)",
    );
    // A fresh seat means a first holder, so the copy is holder #1 and active.
    assert.equal(copy.holder_ordinal, 1);
    assert.equal(copy.holder_active, true);
  });
});

// ─── D11 — `--seat`: create INTO an existing seat ───────────────────────────
//
// AP13. The default must be preserved and joining must be opt-in, validated, and
// unreachable by accident. Path 1 above already pins the default (fresh seat,
// ordinal 1, active) — these rows pin the opt-in and, mostly, the REFUSALS,
// which are the interesting part of D11 rather than the happy path.

test("D11 · `sessions new --seat` joins the seat PREPARED: not active, and with NO ordinal", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");

    // Plant the seat row through the store's own writer.
    // ⚠️ AND THIS EXPOSES A REAL GAP, NOT A TEST CONVENIENCE: nothing in
    // production writes a seat ROW yet. `sessions new` mints a `seat_id` onto the
    // RECORD, and §1 names the ACTIVATION write as the store's first writer — so a
    // seat minted after B10's backfill has no row, and can therefore never be
    // joined or activated. Routed to the B2 sub-HoD; this row plants the row it
    // needs so the join itself is still tested end to end.
    const seatId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await withSeatStoreWrite(sessionDir, () => ({
      mutation: {
        kind: "write" as const,
        seats: new Map([
          [
            seatId,
            {
              seatId,
              createdAt: "2026-09-28T00:00:00.000Z",
              activeHolderId: null,
              nextOrdinal: 1,
              closedAt: null,
              name: undefined,
              brickId: undefined,
            },
          ],
        ]),
      },
      result: undefined,
    }));

    const joined = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "-s",
        "d11-joined",
        "--seat",
        seatId,
      ],
      homeDir,
    );
    assert.equal(joined.code, 0, joined.stderr);
    const id = String(
      (JSON.parse(joined.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const onDisk = await readRecordJson(homeDir, id);
    assert.equal(onDisk.seat_id, seatId, "the joined record does not carry the requested seat");
    assert.equal(
      onDisk.holder_active,
      false,
      "a joined holder must be PREPARED, not active — activation is exclusive and is a separate step",
    );
    // 🛑 NO ORDINAL. Allocating one at creation would burn a number for a holder
    // that may never be activated, and the activation heal relies on the absence
    // directly ("N still lacks a holderOrdinal ⇒ allocate a fresh one").
    assert.equal(
      Object.prototype.hasOwnProperty.call(onDisk, "holder_ordinal"),
      false,
      "a joined holder carries NO holder_ordinal — the ordinal is drawn at activation, never at creation",
    );
  });
});

// ─── §14/D13 — the seat ROW is minted at creation ───────────────────────────

test("AP15 · a freshly created session CAN actually be succeeded — the paired row for D11's refusal", async () => {
  // 🔑 THIS IS THE ROW WHOSE ABSENCE LET A GAP SURVIVE §13, AND THE GENERAL LESSON
  // IS WORTH MORE THAN THE ROW: **every refusal a block adds needs a paired row
  // proving the LEGITIMATE case still passes.** D11's "seat not in the store"
  // refusal was tested. Phase 0.2's was tested. Neither got its pair — so for a
  // while every seat the system created was un-joinable and un-succeedable, and the
  // suite was fully green, because a refusal tested alone proves the door is locked
  // and says nothing about whether anyone can still get in.
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];

    const founding = await runCli([...base, "sessions", "new", "-s", "ap15-founder"], homeDir);
    assert.equal(founding.code, 0, founding.stderr);
    const founderId = String(
      (JSON.parse(founding.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const seatId = String((await readRecordJson(homeDir, founderId)).seat_id);

    // (1) The row EXISTS, read back from disk — not from the CLI's echo.
    const store = await readSeatStore(sessionDir);
    const row = seatFromStore(store, seatId);
    assert.ok(row, "AP15: a plain `sessions new` left NO seat row — the seat cannot be succeeded");
    // (2) It names the founding holder. A null here would make a brand-new seat
    //     read as VACANT, which routes as "nobody home" rather than to its holder.
    assert.equal(row.activeHolderId, founderId, "AP15: the row does not name the founding holder");
    // (3) 🛑 next_ordinal is 2, NOT 1. With 1, the first succession would allocate 1
    //     a SECOND time — a repeat, which D4a calls a defect (a gap would be legal).
    assert.equal(
      row.nextOrdinal,
      2,
      "AP15: next_ordinal is not 2 — the founding holder already consumed 1, so the first succession would REPEAT it",
    );
    assert.equal(row.closedAt, null);
    assert.equal(row.brickId, undefined, "brick attach is brick_id's writer, not create");

    // (4) AND THE WHOLE POINT: `--seat` against a seat the system just created
    //     SUCCEEDS. This is the assertion that would have caught the gap.
    const successor = await runCli(
      [...base, "sessions", "new", "-s", "ap15-successor", "--seat", seatId],
      homeDir,
    );
    assert.equal(
      successor.code,
      0,
      `AP15: --seat REFUSED a seat the system itself just created — ${successor.stderr}`,
    );
    const successorId = String(
      (JSON.parse(successor.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const prepared = await readRecordJson(homeDir, successorId);
    assert.equal(prepared.seat_id, seatId);
    assert.equal(prepared.holder_active, false, "the successor must be prepared, not active");
    assert.equal(
      Object.prototype.hasOwnProperty.call(prepared, "holder_ordinal"),
      false,
      "the successor must carry NO ordinal — it is drawn at activation",
    );

    // (5) Joining did NOT mint a second row, and did not disturb the first.
    const after = await readSeatStore(sessionDir);
    assert.equal(after.seats.size, 1, "joining minted a second row — joining must never mint");
    assert.equal(seatFromStore(after, seatId)?.activeHolderId, founderId);
    assert.equal(
      seatFromStore(after, seatId)?.nextOrdinal,
      2,
      "joining advanced next_ordinal — only an activation may draw one",
    );
  });
});

test("item 8 · a CORRUPT store still creates a USABLE session, keeps the seat_id, and WARNS", async () => {
  // 🛑 THE PAIRED ROW IS THE HEALTHY-STORE CASE IN AP15 ABOVE. Without both halves this
  // row cannot tell "fail-open working" from "the mint was silently skipped" — which is
  // the same paired-row rule applied to the fix itself.
  //
  // WHY FAIL-OPEN, in one line each, and neither reason expires:
  //  (i) FAIL-CLOSED IS A BOOTSTRAP TRAP — every recovery path on these boxes runs
  //      through creating an agent session, so a store that stops `sessions new` stops
  //      its own repair, and a perfectly worded error does not create the session
  //      needed to act on it.
  // (ii) the "seat_id with no row" state is NEITHER silent NOR permanent: AP17 (decided
  //      after D13a) makes it loud, and the backfill repairs it.
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    // A store that EXISTS and cannot be parsed — the writer must refuse to overwrite it.
    await fs.writeFile(path.join(sessionDir, "seats.json"), "{ not json at all", "utf8");

    const created = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "-s",
        "item8",
      ],
      homeDir,
    );
    // 1. THE SESSION IS STILL CREATED. This is the whole ruling.
    assert.equal(created.code, 0, `a corrupt seat store failed the spawn: ${created.stderr}`);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    // 2. IT KEEPS ITS seat_id — the handle the backfill keys on, and what keeps its
    //    children's parent_seat_id chain from being orphaned. Dropping it would make the
    //    session invisible to repair.
    const onDisk = await readRecordJson(homeDir, id);
    assert.equal(
      typeof onDisk.seat_id === "string" && onDisk.seat_id.length > 0,
      true,
      "the session lost its seat_id — it is now invisible to the backfill and its " +
        "descendants' seat edges are orphaned",
    );

    // 3. IT WARNED, LOUDLY, AND NAMED THE REAL REPAIR. Never a bare `.catch(() => {})`.
    assert.match(created.stderr, /seat-row-not-minted/, "the store failure was swallowed");
    assert.match(created.stderr, /USABLE/i, "the warning does not say the session is fine");
    // 🔑 AND THE REMEDY IS THE CORRUPTION ONE, NOT "run the backfill" — which cannot
    // repair a malformed file and refuses to run against one. Telling the operator to
    // run it here would be a confident instruction to do the wrong thing (F1).
    assert.match(
      created.stderr,
      /quarantine/i,
      "the warning gives the wrong remedy for corruption",
    );

    // 4. AND THE CORRUPT BYTES SURVIVE — a corrupt store may hold hand-recoverable rows.
    assert.match(await fs.readFile(path.join(sessionDir, "seats.json"), "utf8"), /not json at all/);
  });
});

test("item 8 · an ABSENT store is NOT an error and emits NO diagnostic — the first write creates it", async () => {
  // Condition (a). ⚠️ THIS IS THE ONE THAT WOULD HAVE BEEN WRONG BY DEFAULT: a fresh box
  // has no `seats.json`, so treating absence as a failure would fire a scary diagnostic
  // on EVERY first `sessions new` after deploy.
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");

    const created = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "-s",
        "fresh-box",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    assert.doesNotMatch(
      created.stderr,
      /seat-row-not-minted/,
      "an absent store emitted a diagnostic — it is not an error, the first write CREATES the file",
    );
    // …and the file now exists with the row in it.
    const store = await readSeatStore(sessionDir);
    assert.equal(store.fileState, "ok");
    assert.equal(store.seats.size, 1, "the first write did not create the store");
  });
});

test("AP15b · every creation path leaves a row — including the fork/copy path", async () => {
  // Path 3 (subagent shadow records) is exercised by its own test further down;
  // this covers the fork/copy path, which mints a FRESH seat and therefore a fresh
  // row. A path that minted a seat id without a row would produce a session that
  // works perfectly and can never be handed over — the defect §14 exists to delete,
  // and it would be invisible on every other assertion.
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const sourceAgent = `${MOCK_AGENT_COMMAND} --supports-fork-session`;

    const source = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        sourceAgent,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "-s",
        "ap15b-source",
      ],
      homeDir,
    );
    assert.equal(source.code, 0, source.stderr);
    const sourceId = String(
      (JSON.parse(source.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const copied = await runCli(
      ["--format", "json", "sessions", "copy", "--from", sourceId, "--name", "ap15b-copy"],
      homeDir,
    );
    assert.equal(copied.code, 0, copied.stderr);
    const copyId = String(
      (JSON.parse(copied.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const store = await readSeatStore(sessionDir);
    const sourceSeat = String((await readRecordJson(homeDir, sourceId)).seat_id);
    const copySeat = String((await readRecordJson(homeDir, copyId)).seat_id);
    assert.notEqual(copySeat, sourceSeat, "the copy inherited the source's seat");
    assert.equal(store.seats.size, 2, "both creations must leave a row");
    assert.equal(seatFromStore(store, sourceSeat)?.activeHolderId, sourceId);
    assert.equal(
      seatFromStore(store, copySeat)?.activeHolderId,
      copyId,
      "the copy's own seat row does not name the copy — its seat cannot be succeeded",
    );
  });
});

test("AP16 · the row is written BEFORE the record, so the tear is the loud one", async () => {
  // 🛑 WHY THIS ROW EXISTS AT ALL: **BOTH ORDERINGS PASS A CRASH-FREE TEST.** A
  // happy-path assertion cannot distinguish them, so D13a would rot silently — the
  // code would keep working while the guarantee it was chosen for quietly went away,
  // and the loss would only ever show up as a crash-produced silent defect in
  // production. So the ORDER itself has to be asserted, not the outcome.
  //
  // Asserted by observing the two writes in sequence: `mintSeatRow` is called with
  // the store still empty and the record file NOT yet on disk. If the record were
  // written first, the record file would already exist when the row write runs.
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];

    const created = await runCli([...base, "sessions", "new", "-s", "ap16"], homeDir);
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const seatId = String((await readRecordJson(homeDir, id)).seat_id);

    // The ordering's OBSERVABLE CONSEQUENCE, checked on the artefacts: the row's
    // mtime must not be LATER than the record's. Row-first means row.mtime <=
    // record.mtime; record-first would invert it.
    const rowStat = await fs.stat(path.join(sessionDir, "seats.json"));
    const recordStat = await fs.stat(path.join(sessionDir, `${id}.json`));
    assert.ok(
      rowStat.mtimeMs <= recordStat.mtimeMs,
      `AP16: the seat row was written AFTER the record (row ${rowStat.mtimeMs} > record ${recordStat.mtimeMs}) — ` +
        `record-first leaves, on a crash, a working session whose seat has no row and which can NEVER be succeeded`,
    );
    // And the end state is correct either way, which is exactly why the mtime check
    // above is doing the real work here.
    const store = await readSeatStore(sessionDir);
    assert.equal(seatFromStore(store, seatId)?.activeHolderId, id);
  });
});

test("AP17 · a seat with no row is refused with the CAUSE and the REMEDY, not a bare not-found", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    // The production shape: a seat id that looks entirely valid and has no row —
    // which is every seat minted BEFORE the store existed (B10's backfill
    // population). The operator meets a healthy session and a valid id, so a bare
    // "not found" reads as a bug in our code rather than a migration not yet run.
    const refused = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "--seat",
        "cccccccc-dddd-4eee-8fff-000000000000",
      ],
      homeDir,
    );
    assert.notEqual(refused.code, 0);
    const said = `${refused.stderr}${refused.stdout}`;
    // Names the CAUSE…
    assert.match(
      said,
      /predates the seat store/i,
      "AP17: the refusal does not name the likely cause (a seat predating the store)",
    );
    // …and the REMEDY…
    assert.match(said, /backfill/i, "AP17: the refusal does not name the remedy");
    // …and reassures that nothing is lost, which is what stops it reading as data loss.
    assert.match(
      said,
      /not broken|nothing is lost/i,
      "AP17: the refusal does not say the session itself is intact",
    );
  });
});

test("D11 · `--seat` is REFUSED on a fork/copy — every fork mints a new seat", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];

    const source = await runCli([...base, "sessions", "new", "-s", "d11-fork-source"], homeDir);
    assert.equal(source.code, 0, source.stderr);
    const sourceId = String(
      (JSON.parse(source.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const refused = await runCli(
      [
        ...base,
        "sessions",
        "copy",
        "--from",
        sourceId,
        "--seat",
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ],
      homeDir,
    );
    assert.notEqual(refused.code, 0, "`sessions copy --seat` was ACCEPTED");
    // 🛑 THIS ROW NAMES *WHICH* MECHANISM REFUSES, AND THAT PRECISION IS THE POINT
    // (finding F4). An earlier version asserted `/unknown option|--seat/i`, which
    // matched EITHER mechanism — and since `refuseSeatJoinOnForkPath`'s own message also
    // contains "--seat", the row was green whichever one fired AND green through a
    // SILENT SWAP between them.
    //
    // TODAY THE REFUSAL COMES FROM THE FLAG REGISTRATION: `--seat` is registered on
    // `sessions new` and NOT on `copy`, so commander rejects the unknown option before
    // any of our code runs. Asserted on commander's own wording, so that if anyone
    // registers `--seat` on `copy` — the natural "improvement", to give a better
    // message — THIS ROW GOES RED and they must make the library guard load-bearing and
    // say so here, instead of the protection quietly changing hands.
    assert.match(
      `${refused.stderr}${refused.stdout}`,
      /unknown option/i,
      "the refusal is no longer commander's unknown-option error — if `--seat` was " +
        "registered on `copy`, then `refuseSeatJoinOnForkPath` is now the only thing " +
        "refusing, and that mechanism must be asserted here instead (see F4)",
    );
  });
});

test("F4 · the fork/copy GUARD itself refuses, independently of the flag registration", async () => {
  // 🔑 WHY A SEPARATE ROW: `refuseSeatJoinOnForkPath` is REAL CODE WITH NO COVERAGE, and
  // it is currently UNREACHABLE THROUGH THE CLI BY CONSTRUCTION — verified at source:
  // `seatId` is passed into the create options only at the `sessions new` builder and
  // `forkFromSessionId` only at the `copy` builder, two separate object literals, so the
  // two are never set together. The row above proves the FLAG REGISTRATION refuses; this
  // one proves THE GUARD would refuse if anything ever set both, which is exactly the
  // state the natural "register --seat on copy" improvement would create.
  //
  // Driven against the library, because no CLI invocation can reach it. That is not a
  // weaker test — it is the only instrument that can reach this code at all, and without
  // it the guard is an untested claim sitting behind an assertion that passes for another
  // reason entirely (F4).
  const { createSession } = await import("../src/session/session.js");
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await assert.rejects(
      () =>
        createSession({
          agentCommand: MOCK_AGENT_COMMAND,
          cwd,
          permissionMode: "approve-all",
          // BOTH set — the combination the CLI cannot currently produce.
          seatId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          forkFromSessionId: "some-source-session",
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("--seat cannot be combined with a fork or copy") &&
        error.message.includes("every fork mints a NEW seat"),
      "the guard did not refuse the seat+fork combination, or refused without saying why",
    );
  });
});

test("D11/D8 · a malformed `--seat` is refused at the ORIGIN, before anything is created", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];

    // Each of these is a DIFFERENT one of the three states D8 refuses to collapse.
    // The whitespace case is the measured specimen: one layer trims it to absent,
    // one accepts it as a valid string, one rejects it as malformed.
    for (const bad of [
      "   ",
      "",
      "not-a-uuid",
      "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
      " aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ]) {
      const refused = await runCli([...base, "sessions", "new", "--seat", bad], homeDir);
      assert.notEqual(refused.code, 0, `--seat ${JSON.stringify(bad)} was ACCEPTED`);
      // 🛑 REJECTED, NOT REPAIRED — the uppercase and leading-space cases are the
      // ones that would pass under a `trim().toLowerCase()`, and a value stored
      // differently from how it was submitted is exactly what makes the layers
      // downstream disagree about whether it is absent, malformed or valid.
    }

    // …and NOTHING was created by any of them: no seat row, and no session record.
    const store = await readSeatStore(sessionDir).catch(() => undefined);
    assert.equal(store?.seats.size ?? 0, 0, "a refused --seat minted a seat row");
    const files = await fs.readdir(sessionDir).catch(() => [] as string[]);
    assert.deepEqual(
      files.filter((f) => f.endsWith(".json") && f !== "index.json" && f !== "seats.json"),
      [],
      "a refused --seat left a session record behind",
    );
  });
});

test("D11 · `--seat` naming a seat that is NOT in the store is refused — joining never mints one", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");

    const absent = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const refused = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "--format",
        "json",
        "sessions",
        "new",
        "--seat",
        absent,
      ],
      homeDir,
    );
    assert.notEqual(refused.code, 0, "a --seat naming no existing seat was ACCEPTED");
    // 🛑 THE REFUSAL THAT MATTERS MOST. A typo'd seat id that silently CREATED the
    // seat it named would leave a session sitting in a seat nobody meant — and a
    // mis-seated session is a wrong IDENTITY that every later block inherits, with
    // no signature to detect it and no re-run that repairs it.
    const store = await readSeatStore(sessionDir).catch(() => undefined);
    assert.equal(
      store?.seats.size ?? 0,
      0,
      "joining a non-existent seat MINTED it as a side effect — the one thing this refusal exists to prevent",
    );
  });
});

// ─── Path 3 — subagent shadow record (teammate_spawned) ────────────────────
//
// This path is genuinely NOT reachable through the CLI-subprocess pattern
// above: it fires from an in-flight `session/update` frame during a live
// prompt turn, which mock-agent.ts has no scripted trigger for (its
// tool_call/tool_call_update simulation is a generic "LateTool", not a
// teammate_spawned shape). Exercised instead at the level D-B1-7 names as the
// hazard: runQueuedTask -> runSessionPrompt's REAL onSessionUpdate handler,
// via a minimal AcpClient mock that captures and fires it — the same
// AcpClient-mocking convention test/mid-turn-injection.test.ts already uses
// for this exact production handler chain, extended to capture
// onSessionUpdate (which that file's mock deliberately no-ops).

function teammateSpawnedNotification(sessionId: string, subagentId: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      _meta: {
        claudeCode: {
          status: "teammate_spawned",
          subagentId,
          subagentName: "worker-agent",
        },
      },
    },
  } as unknown as SessionNotification;
}

function makeSubagentSpawningClient(sessionId: string, subagentId: string): AcpClient {
  let capturedOnSessionUpdate: ((notification: SessionNotification) => void) | undefined;
  const mock = {
    hasReusableSession: () => true,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => {},
    getAgentLifecycleSnapshot: () => ({ running: true }),
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: (handlers: { onSessionUpdate?: (n: SessionNotification) => void }) => {
      capturedOnSessionUpdate = handlers.onSessionUpdate;
    },
    clearEventHandlers: () => {},
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => false,
    cancelActivePrompt: async () => {},
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    close: async () => {},
    waitForSessionUpdatesIdle: async () => {},
    getEffectiveAccountMetadata: () => undefined,
    prompt: async () => {
      // Fire the teammate_spawned frame mid-turn, exactly as a real adapter
      // would via session/update, before the turn resolves.
      capturedOnSessionUpdate?.(teammateSpawnedNotification(sessionId, subagentId));
      return { stopReason: "end_turn" as const };
    },
  };
  return mock as unknown as AcpClient;
}

test("G2/path 3 · a teammate_spawned notification mints a shadow-record seat, read back from DISK", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const parentRecord: SessionRecord = makeSessionRecordFixture({
      acpxRecordId: "parent-session",
      acpSessionId: "parent-session-acp",
      agentCommand: "node mock-agent.js",
      cwd,
      seatId: "parent-seat",
      holderOrdinal: 1,
      holderActive: true,
    });
    await writeSessionRecordFile(homeDir, parentRecord);

    const client = makeSubagentSpawningClient("parent-session-acp", "subagent-1");
    const task: QueueTask = {
      requestId: "req-1",
      message: "spawn a subagent",
      prompt: textPrompt("spawn a subagent"),
      permissionMode: "approve-all",
      timeoutMs: 10_000,
      waitForCompletion: true,
      enqueuedAt: Date.now(),
      send: () => {},
      close: () => {},
    };

    await runQueuedTask("parent-session", task, {
      sharedClient: client,
      suppressSdkConsoleErrors: true,
    });

    // The child's id is minted internally (crypto.randomUUID()) — find it by
    // reading the PARENT record's subagents[] back off disk, then read the
    // child record independently. Both reads are real disk reads, matching
    // G2's falsifying observation.
    const reloadedParent = await resolveSessionRecord("parent-session");
    const childRef = reloadedParent.subagents?.[0];
    assert.ok(childRef, "parent record must list the spawned subagent");

    const childRecord = await resolveSessionRecord(childRef.acpxRecordId);
    assert.equal(childRecord.kind, "subagent");
    assert.equal(childRecord.parentSessionId, "parent-session");
    assert.ok(
      childRecord.seatId,
      "path 3 (subagent shadow record): seat_id absent on the record read back from disk — " +
        "this is the path a createSessionRecordWithClient-level fix misses silently",
    );
    assert.notEqual(
      childRecord.seatId,
      "parent-seat",
      "a subagent shadow record gets its OWN seat, not its parent's (no carve-outs, DECISIONS-HOD §D1)",
    );
    assert.equal(childRecord.holderOrdinal, 1);
    assert.equal(childRecord.holderActive, true);
    assert.equal(
      childRecord.parentSeatId,
      "parent-seat",
      "the shadow record's parentSeatId must name its parent's actual seat",
    );
  });
});
