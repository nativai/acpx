import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsSync from "node:fs";
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
// Same fixture `cli.test.ts` / `client.test.ts` use to resolve `--brick` without
// the real 3 s-timeout `brick show` round trip: prepended onto PATH, it makes
// `resolveBrickFlagRef`'s `execFile("brick", …)` find this fake binary instead
// of the box's real `/home/node/.local/bin/brick` — load-bearing, because the
// real one would shell out against bricks this suite never created.
const BRICK_SHIM_DIR = path.join(process.cwd(), "test", "fixtures", "brick-shim");

type CliResult = { code: number | null; stdout: string; stderr: string };

// Modelled directly on session-reparent.test.ts's runCli — same scrub list
// (a fixture built without it can silently acquire the TEST RUNNER's own
// session as ambient context) plus the same real-compiled-CLI rationale: the
// failure this feature is exposed to is a field dropped by one of the
// field-by-field persistence transforms, and every one of those legs is
// green under a unit call on the mutator alone.
// `extraEnv` — F2 fixtures (brick 3dff714d) need to simulate a SPAWNING session
// with its own ambient brick (`ACPX_SESSION_URL` pointing at a planted parent
// record) without that key falling to the scrub loop below, same pattern as
// `cli.test.ts`'s `runCli(..., { env })`: any key present in `extraEnv` is
// exempt from the delete, everything else is scrubbed exactly as before.
function runCli(
  args: string[],
  homeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ...extraEnv };
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
              favorite: false,
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
    //     read as VACANT, which routes as "vacant" rather than to its holder.
    assert.equal(row.activeHolderId, founderId, "AP15: the row does not name the founding holder");
    // (3) 🛑 next_ordinal is 2, NOT 1. With 1, the first succession would allocate 1
    //     a SECOND time — a repeat, which D4a calls a defect (a gap would be legal).
    assert.equal(
      row.nextOrdinal,
      2,
      "AP15: next_ordinal is not 2 — the founding holder already consumed 1, so the first succession would REPEAT it",
    );
    assert.equal(row.closedAt, null);
    // F1 fix (brick 3dff714d): `sessions new` now writes the SEAT's brick_id too,
    // from whatever `--brick` resolves to — this fixture passed none, so still
    // `undefined`. See "F1 · sessions new --brick writes the SEAT's brick_id" below
    // for the case where a brick IS resolved.
    assert.equal(row.brickId, undefined, "no --brick was passed to this fixture's spawn");

    // (4) AND THE WHOLE POINT: `--seat` against a seat the system just created
    //     SUCCEEDS. This is the assertion that would have caught the gap.
    const successor = await runCli([...base, "sessions", "new", "--seat", seatId], homeDir);
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

test("B2c product-entered · a real `acpx seats close` refuses `sessions new --seat` (R4), with the open-seat pair", async () => {
  // PRODUCT-ENTERED, per B2c PLAN.md §3 row R4. Sequence: mint a founding holder
  // (open seat), close IT, close the SEAT for real, then attempt to join it —
  // assert the refusal, and pair it with the SAME seat accepting a join BEFORE it
  // was closed (the AP15 test above already proves that; this row's own pair is the
  // founding holder's creation into the FRESH, still-open seat one line earlier in
  // this same test, which is exactly the create-into-seat path R4 is about).
  //
  // 🔑 R4's refusal is coded `SEAT_CLOSED` — same code `sessions activate` uses for
  // the identical fact (overrule, L0, 2026-09-29: callers branch on the CODE, never
  // on prose). The COMMAND under test (`sessions new --seat`, not `sessions
  // activate`) is what discriminates this row from the seat-activate.test.ts row
  // asserting the same code.
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];

    const founding = await runCli([...base, "sessions", "new", "-s", "r4-founder"], homeDir);
    assert.equal(founding.code, 0, founding.stderr);
    const founderId = String(
      (JSON.parse(founding.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const seatId = String((await readRecordJson(homeDir, founderId)).seat_id);

    // AP15 pair, restated for THIS seat: while still open, a join succeeds.
    const joinedWhileOpen = await runCli([...base, "sessions", "new", "--seat", seatId], homeDir);
    assert.equal(
      joinedWhileOpen.code,
      0,
      `AP15 pair: --seat refused a seat that is NOT closed — ${joinedWhileOpen.stderr}`,
    );

    // `--session-id`, NOT the positional `[name]` arg — that resolves by SESSION
    // NAME, not by record id (`session-selector.ts`: only `--session-id`/
    // `--session-url` reach `resolveExplicitSessionRecord`).
    const closedHolder = await runCli(
      [...base, "sessions", "close", "--session-id", founderId],
      homeDir,
    );
    assert.equal(closedHolder.code, 0, closedHolder.stderr);

    const closedSeat = await runCli([...base, "seats", "close", seatId], homeDir);
    assert.equal(
      closedSeat.code,
      0,
      `fixture precondition: acpx seats close must succeed once the active holder is closed — ${closedSeat.stdout}${closedSeat.stderr}`,
    );
    const closedAt = (JSON.parse(closedSeat.stdout.trim()) as { closedAt?: string }).closedAt;
    assert.ok(closedAt, "fixture precondition: the real close returned a timestamp");

    const refused = await runCli([...base, "sessions", "new", "--seat", seatId], homeDir);
    assert.notEqual(refused.code, 0, "a seat closed by the REAL verb still accepted a join");
    const said = `${refused.stdout}${refused.stderr}`;
    assert.match(said, /SEAT_CLOSED/, "the refusal must carry the SEAT_CLOSED code");
    // 🛑 F4 (independent TE finding, 2026-09-29): AC16's `Fails if:` clause is
    // explicit — "refuses either without naming the seat and its closed_at". The
    // product does this correctly, but a message reword could drop it silently
    // and greenly with no assertion here to catch it.
    assert.match(said, new RegExp(seatId), "the refusal must name the SEAT");
    assert.match(said, new RegExp(closedAt), "the refusal must name its closed_at TIMESTAMP");
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

    // 5. 🛑 AND IT REACHED THE DURABLE LEG — the SESSION STREAM, not only stderr (F8).
    // The ruling is "stderr AND the stream, never a silent catch", and assertion 3 above
    // passed for weeks while the stream half did not exist: a terminal line lives exactly
    // as long as the scrollback of whoever happened to be watching the spawn.
    // From the sidecar (`<id>.messages.ndjson`) — a boundary write leaves the record's
    // inline `messages` empty by design, so `<id>.json` is the wrong file to look in.
    const sidecar = await fs
      .readFile(path.join(sessionDir, `${id}.messages.ndjson`), "utf8")
      .catch(() => "");
    assert.match(
      sidecar,
      /seat-row-not-minted/,
      "the warning is NOT on the session record — it exists only in the operator's terminal",
    );
    assert.match(
      sidecar,
      /"synthetic":true/,
      "the warning was appended as a real turn; unmarked it counts as irreplaceable history " +
        "in the resume fallback gate and can make the session permanently unpromptable",
    );
  });
});

// ─── THE THIRD PAIRED SET — fork/copy, which shares the mint CALL SITE with the row above
//     and yet is a SEPARATE REACHABLE PATH: it writes through
//     `writeSessionRecordAtBoundary`, the plain create through `writeSessionRecord`.
//
// 🔑 WHY THIS ROW EXISTS AT ALL, and it is the most reusable thing in this file: the unit of
// coverage is THE REACHABLE PATH, NOT THE CALL SITE. The reorder this pass landed had to move
// the mint below BOTH legs of `if (forkContext) … else …`; a version that moved it under only
// one would leave copy/fork on the old ordering AND LOOK DONE, because the row for the plain
// path would be green. Three times in one evening the accounting unit was one level too
// coarse — the measured instance, then the call site, then the leg. **Count the branches the
// fix must move PAST, not the call sites it must move WITHIN.**
// Its paired healthy-store half is AP15b below (the copy path mints a row naming the copy).
test("item 8 / fork-copy · a CORRUPT store still produces a USABLE COPY, keeps the seat_id, and WARNS", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    // The SOURCE is created against a HEALTHY store — the fault is injected after it, so
    // this row isolates the copy path instead of testing two failures at once.
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
        "fc-source",
      ],
      homeDir,
    );
    assert.equal(source.code, 0, source.stderr);
    const sourceId = String(
      (JSON.parse(source.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const sourceSeat = String((await readRecordJson(homeDir, sourceId)).seat_id);

    // NOW corrupt it, so the COPY's mint is the one that fails.
    await fs.writeFile(path.join(sessionDir, "seats.json"), "{ not json at all", "utf8");

    const copied = await runCli(
      ["--format", "json", "sessions", "copy", "--from", sourceId, "--name", "fc-copy"],
      homeDir,
    );
    assert.equal(copied.code, 0, `a corrupt seat store failed the COPY: ${copied.stderr}`);
    const copyId = String(
      (JSON.parse(copied.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const copy = await readRecordJson(homeDir, copyId);
    assert.equal(
      typeof copy.seat_id === "string" && copy.seat_id.length > 0,
      true,
      "the copy lost its seat_id — invisible to the backfill, and its descendants' seat edges orphaned",
    );
    // 🛑 AND STILL NOT THE SOURCE'S SEAT. A degraded path is exactly where a fallback to
    // "inherit the source's seat" would look reasonable, and it is forbidden unconditionally.
    assert.notEqual(
      copy.seat_id,
      sourceSeat,
      "the copy inherited the SOURCE's seat under a store failure — every fork mints a new one",
    );
    assert.match(copied.stderr, /seat-row-not-minted/, "the copy path swallowed the store failure");
    assert.match(
      copied.stderr,
      /quarantine/i,
      "the copy path gave the wrong remedy for corruption",
    );
    const sidecar = await fs
      .readFile(path.join(sessionDir, `${copyId}.messages.ndjson`), "utf8")
      .catch(() => "");
    assert.match(
      sidecar,
      /seat-row-not-minted/,
      "the copy path's warning never reached the session stream — stderr only (F8)",
    );
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

// ─── AP16 — ⛔ RETIRED AS WRITTEN, AND IT WAS A BLIND INSTRUMENT, NOT JUST A STALE ONE ──
//
// AP16 asserted `row.mtime <= record.mtime` to defend D13a's ROW-FIRST ordering. Two things
// happened to it, and the second is the one worth carrying:
//
// 1. **ITS SUBJECT WAS REVERSED.** The ruling of 2026-09-28 (SEAT-STORE.md item 8) makes
//    every creation path **RECORD FIRST, THEN THE ROW**. A row defending row-first now
//    defends a retired contract.
// 2. 🛑 **IT NEVER DISCRIMINATED THE TWO ORDERINGS AT ALL — MEASURED.** After the reorder it
//    kept PASSING. Measured at the same tip: `row.mtimeNs - record.mtimeNs = −24.0 ms`, i.e.
//    the row is still older than the record **under record-first**, because the record is
//    written AGAIN ~24 ms after the mint by the rest of the create. So `row <= record` holds
//    in BOTH regimes and always did. Its own comment said *"both orderings pass a crash-free
//    test, so the ORDER itself has to be asserted"* — and then asserted a proxy that could
//    not see the order. **A row whose comment names the trap is not thereby out of it.**
//    (Fourth instrument defect of this family on this block, all mine.)
//
// ⚠️ **AND THE ORDER ON THE TWO CLI PATHS IS NOW NOT ASSERTED. Stated as a gap, not papered
// over.** No post-hoc on-disk observation distinguishes the orderings there: the happy-path
// end state is identical and the record's mtime is overwritten afterwards. I tried to induce
// the discriminating fault — a read-only sessions dir with a valid store pre-seeded, where
// record-first must emit NO mint diagnostic and row-first must emit one — and it is
// **VACUOUS**: the run dies with `EACCES … index.json.<pid>.tmp` before either ordering
// reaches the mint, so both arms print nothing. Evidence recorded here so nobody re-derives
// it. What DOES defend the property the ordering exists for is the item-8 fault row on each
// of the three reachable paths: a store failure cannot cost a session.
// The one place the order IS directly observable is path 3 (in-process, so fs calls can be
// sequenced) — that is the row at the end of this file.

test("AP17 · a seat with no row is refused with the CAUSE and the REMEDY, not a bare not-found", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    // The production shape: a seat that was minted BEFORE the store existed — a hot-tier
    // record carrying `seat_id`, and no row (B10's backfill population). Entered by the
    // product (a real founding `sessions new`) with ONLY its row then removed. An id no
    // record carries is the OTHER origin (a typo) and gets the opposite advice — that
    // pair is `seat-store-refusals.test.ts`'s (brick `bf454a2c`).
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];
    const founding = await runCli([...base, "sessions", "new", "-s", "ap17-founder"], homeDir);
    assert.equal(founding.code, 0, founding.stderr);
    const founderId = String(
      (JSON.parse(founding.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const founderSeatId = String((await readRecordJson(homeDir, founderId)).seat_id);
    const storeFile = path.join(homeDir, ".acpx", "sessions", "seats.json");
    const rows = JSON.parse(await fs.readFile(storeFile, "utf8")) as Record<string, unknown>;
    assert.ok(rows[founderSeatId], "fixture precondition: the product minted a row to remove");
    delete rows[founderSeatId];
    await fs.writeFile(storeFile, `${JSON.stringify(rows)}\n`, "utf8");
    const refused = await runCli([...base, "sessions", "new", "--seat", founderSeatId], homeDir);
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

/**
 * 🛑 THE SHARED PRECONDITION OF ALL THREE PATH-3 ROWS, NAMED — so that a miss reads as
 * "the child shadow-record write did not land" and NEVER as a defect in the row's own
 * mechanism.
 *
 * All three path-3 rows (item 8, G2, AP16) must first observe the child shadow record
 * appear in the parent's `subagents[]`. That step is NOT any row's own criterion: it is a
 * write through the session outbox, and it is the step that has failed under contention.
 * Left inline, its failure presented as "the unwritable store cost the record" (item 8),
 * "the parent does not list the subagent" (G2) or "there is no ordering to observe"
 * (AP16) — three different-looking reds with ONE cause. That misattribution has already
 * consumed TWO investigations (B2c's merge agent; B2c's independent test-engineer, round
 * two), which is why the precondition is separated from the criterion here.
 *
 * 🔑 The mechanism, established by reading at `ef794177` (brick 6b1e0038): the outbox holds
 * its exclusive SQLite lock ACROSS an `await` (`brick-outbox.ts` `withAsyncMutation`), while
 * the busy-retry waits with `Atomics.wait` — SYNCHRONOUSLY blocking the only thread. So a
 * second in-process write that overlaps the first cannot merely lose a lock race: it blocks
 * the very thread the holder needs to reach COMMIT, burns its whole 4 s budget and fails
 * terminally. Two overlapping in-process outbox writes LIVELOCK; the historical "1-in-6"
 * was the rate at which two writes OVERLAP, not the rate at which a lock fight was lost.
 *
 * 🛑 `outbox-busy` IS TERMINAL, NOT RETRYABLE — the name sounds transient and is not. A red
 * here is fixed by ORDERING or LOCKING, never by a retry or a poll: the write has already
 * exhausted its own 4 s budget by the time you see it.
 *
 * 🛑 DO NOT RE-RUN FOR GREEN. A wrong-value intermittent here fingerprints a REAL PRODUCT
 * RACE, never a flake, and a green re-run is the most dangerous outcome available.
 *
 * 🔑 A red here is also NOT the historical row-first defect returning. Arm B (no mint at
 * all) measured k=0 in N=18, so the intermittency was introduced by the row-first mint and
 * removed with it; it was never a property of these rows. See bricks b64dfbb3, 6b1e0038.
 */
async function requirePath3ShadowRecord(
  parentRecordId: string,
  rowCriterion: string,
): Promise<NonNullable<SessionRecord["subagents"]>[number]> {
  const reloadedParent = await resolveSessionRecord(parentRecordId);
  const childRef = reloadedParent.subagents?.[0];
  assert.ok(
    childRef,
    "PATH-3 SHARED PRECONDITION FAILED — THE CHILD SHADOW-RECORD WRITE DID NOT LAND.\n" +
      "This is NOT this row's own mechanism failing. The parent record carries no\n" +
      `subagents[0], so the row never reached what it actually tests:\n` +
      `    ${rowCriterion}\n` +
      "🛑 Suspect OUTBOX CONTENTION first: two overlapping in-process record writes\n" +
      "livelock on the one SQLite outbox DB and the loser fails `outbox-busy` after its\n" +
      "full 4 s budget, so the child record is never written and the parent never lists it.\n" +
      "Fix by ORDERING or LOCKING — never by a retry or a poll. See this helper's comment\n" +
      "for the measured mechanism, and brick 6b1e0038.",
  );
  return childRef;
}

test("item 8 / path 3 · an UNWRITABLE store still leaves a usable shadow record, no row, and a diagnostic", async () => {
  // 🔑 DETERMINISTIC IN THE FAULT IT INJECTS, NOT IN GETTING THERE. This row forces the
  // fault it cares about (a corrupt `seats.json`) rather than sampling for it, so steps 2-5
  // below are deterministic GIVEN step 1 lands. Same technique the test-engineer used to
  // induce a corrupt store.
  //
  // 🛑 STEP 1 IS NOT IMMUNE TO LOAD — A PRIOR VERSION OF THIS COMMENT CLAIMED "it can never
  // red under load"; THAT CLAIM IS FALSE AND WAS FALSIFIED BY OBSERVATION (brick 7c339fda,
  // 2026-09-30). Step 1 (`assert.ok(childRef, …)` below) depends on the child shadow-record
  // write landing, and that write contends with the parent turn's own writes on the SAME
  // outbox SQLite DB as the sampled `G2/path 3` row further down in this file
  // (`OutboxError: outbox-busy`, terminal, not retryable — see that row's comment for the
  // full mechanism and measured rates). This row and `AP16 (REVERSED)` below share that
  // identical step-1 precondition and both inherit the same residual; a production reorder
  // already bounded G2's rate from k=1-in-6 to k=0-in-24 WITHOUT eliminating it — A BOUND IS
  // NOT A FIX. The remaining repair (make the shared precondition a named fixture
  // precondition, distinct from this row's own mechanism assertions) is tracked separately,
  // not attempted here — see brick 6b1e0038 (successor of 7c339fda).
  //
  // The mint now runs AFTER the record write on path 3, so the fault that exercises item 8
  // here is a store the writer must REFUSE to touch — which is what a corrupt `seats.json`
  // produces (`SeatStoreUnwritableError`). This is AP15's pair for item 8 on path 3.
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    // EXISTS and does not parse — the writer refuses rather than destroying it.
    await fs.writeFile(path.join(sessionDir, "seats.json"), "{ not json at all", "utf8");

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

    // Capture the diagnostic: this path runs IN-PROCESS, so the warning goes to this
    // process's own stderr rather than a subprocess's.
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return (realWrite as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    try {
      await runQueuedTask(
        "parent-session",
        {
          requestId: "req-1",
          message: "spawn a subagent",
          prompt: textPrompt("spawn a subagent"),
          permissionMode: "approve-all",
          timeoutMs: 10_000,
          waitForCompletion: true,
          enqueuedAt: Date.now(),
          send: () => {},
          close: () => {},
        },
        {
          sharedClient: makeSubagentSpawningClient("parent-session-acp", "subagent-1"),
          suppressSdkConsoleErrors: true,
        },
      );
    } finally {
      process.stderr.write = realWrite;
    }

    // 1. THE SHADOW RECORD EXISTS — a store failure must not cost the subagent.
    //    Through the NAMED shared precondition, so an outbox-contention miss cannot be
    //    misread as "the unwritable store cost the record" — which is this row's subject.
    const childRef = await requirePath3ShadowRecord(
      "parent-session",
      "that an UNWRITABLE SEAT STORE still leaves a usable shadow record (item 8)",
    );
    const childRecord = await resolveSessionRecord(childRef.acpxRecordId);

    // 2. IT KEEPS ITS seat_id — the handle B10 repairs by, and what keeps any descendants'
    //    `parent_seat_id` chain from being orphaned.
    assert.ok(
      childRecord.seatId,
      "the shadow record lost its seat_id — it is now invisible to the backfill",
    );

    // 3. THE ROW IS ABSENT, and the corrupt bytes are untouched (a corrupt store may hold
    //    hand-recoverable rows, so the writer must never clear it to make itself work).
    const store = await readSeatStore(sessionDir);
    assert.equal(store.fileState, "malformed", "the store was overwritten or repaired");
    assert.match(await fs.readFile(path.join(sessionDir, "seats.json"), "utf8"), /not json at all/);

    // 4. THE DIAGNOSTIC WAS EMITTED AND NAMES THE REAL REMEDY. Never a bare catch — and for
    //    a CORRUPT store the remedy is quarantine-then-backfill, not "run the backfill",
    //    which cannot repair corruption and refuses to run against a malformed store.
    const diagnostics = written.filter((line) => line.includes("seat-row-not-minted"));
    assert.equal(
      diagnostics.length,
      1,
      `expected exactly one diagnostic, got ${diagnostics.length}`,
    );
    assert.match(diagnostics[0], /USABLE/i, "the diagnostic does not say the session is fine");
    assert.match(
      diagnostics[0],
      /quarantine/i,
      "the diagnostic gives the wrong remedy for corruption",
    );

    // 5. 🛑 AND THE DURABLE LEG (F8) — WHICH MATTERS MORE HERE THAN ON THE CLI PATHS, NOT
    //    LESS. There is no operator at a terminal watching a subagent spawn, so a
    //    stderr-only diagnostic is written to a stream nobody is reading and is simply gone.
    //    This site was a bare `process.stderr.write` until F8; the CLI site was fixed first
    //    and this one was missed — the same stop-at-the-first-site shape the reorder hit.
    //    ON THE CHILD's stream: the child is the record whose seat has no row, and it is the
    //    id B10 repairs by.
    const childSidecar = await fs
      .readFile(path.join(sessionDir, `${childRef.acpxRecordId}.messages.ndjson`), "utf8")
      .catch(() => "");
    assert.match(
      childSidecar,
      /seat-row-not-minted/,
      "path 3's warning never reached the session stream — and on this path there is no " +
        "terminal for the other leg to reach either, so the diagnostic reached nobody",
    );
    assert.match(
      childSidecar,
      /"synthetic":true/,
      "the warning was appended as a real turn — unmarked, it counts as irreplaceable " +
        "history in the resume fallback gate",
    );
  });
});

// ⚠️ THIS ROW'S GATE DISPOSITION IS AN OPEN QUESTION, ROUTED RATHER THAN DECIDED HERE.
//
// The standing rule is that a mandatory-suite row which reds only intermittently under box
// load is REMOVED, not carried — so a sampled detector cannot live in the mandatory gate.
// This row's residual is bounded (k=0 in N=24 post-reorder, from k=1-in-6) but NOT proven
// eliminated, and its fixture cannot control the outbox: the contention is between the
// parent turn's writes and the child write on one SQLite DB, and `outbox-busy` is terminal
// rather than retryable, so polling would not rescue it either.
//
// 🛑 BUT MOVING IT OUT OF THE GATE HAS A COST NOBODY HAS PRICED YET, WHICH IS WHY IT IS NOT
// DONE HERE: this is B1's GATE-B1-FALSIFIABILITY §G2 row for creation path 3 — the ONE path
// not reachable through `createSessionRecordWithClient`, and therefore the one a fix at that
// level misses silently. Its primary property (path 3 puts a `seat_id` on the record) is NOT
// intermittent; only its dependency on the child record write is. Taking it out of the
// mandatory suite would quietly remove B1's coverage of the path most in need of it.
//
// ⇒ Left in place, with the residual named in the ASSERTION's failure message so whoever
// meets the red gets the evidence and the instruction not to re-run for green. The
// deterministic `item 8 / path 3` row above now covers the MECHANISM independently of the
// rate, so the mechanism is protected either way.
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
    // Through the NAMED shared precondition (`requirePath3ShadowRecord`), which carries the
    // full outbox-contention warning. THE WARNING LIVES IN THE FAILURE MESSAGE, NOT ONLY IN
    // A COMMENT: whoever meets this red at 03:00 reads the failure output and nothing else.
    const childRef = await requirePath3ShadowRecord(
      "parent-session",
      "that a teammate_spawned notification MINTS A SHADOW-RECORD SEAT, read back from " +
        "disk (G2/path 3 — the path a createSessionRecordWithClient-level fix misses)",
    );

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

// ─── AP16 (REVERSED) · THE RECORD IS WRITTEN BEFORE THE ROW — asserted where the order
//     is actually observable ─────────────────────────────────────────────────────────────
//
// Path 3 runs IN-PROCESS, so the fs calls can be put in a single time-ordered sequence — the
// two CLI paths run as subprocesses and leave no surviving trace of the order (see the
// retired-AP16 block above for what was tried and why it is vacuous). So this is the ONE row
// on the block that sees the ordering directly, and it sits on the path where the defect the
// reorder fixes was actually MEASURED: mint first → the child record write loses the outbox
// → the shadow record is silently gone.
//
// 🛑 IT IS NOT A PROXY. It does not compare mtimes, it does not check the end state, and it
// does not read the source: it records the real write sequence and asserts the index of the
// first write touching the CHILD RECORD is lower than the index of the first write touching
// `seats.json`. Reverse the two statements in `runtime.ts` and this row goes red.
test("AP16 (REVERSED) · path 3 writes the RECORD before the ROW, observed in call order", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });

    const parentRecord: SessionRecord = makeSessionRecordFixture({
      acpxRecordId: "order-parent",
      acpSessionId: "order-parent-acp",
      agentCommand: "node mock-agent.js",
      cwd,
      seatId: "order-parent-seat",
      holderOrdinal: 1,
      holderActive: true,
    });
    await writeSessionRecordFile(homeDir, parentRecord);

    // The spy KEEPS the original behaviour — a real write to a real store, observed. One
    // shared array, because ordering across DIFFERENT apis is the whole point: a per-api
    // call log (what `seat-store-hold.test.ts` builds) cannot answer "which happened first".
    const sequence: string[] = [];
    const originalWriteFile = fs.writeFile;
    const originalRename = fs.rename;
    const observe = (target: unknown): void => {
      if (typeof target === "string") {
        sequence.push(target);
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- patching the shared
    // fs/promises namespace object is the documented technique here; the casts are the price
    // of assigning over its typed methods and are confined to these four lines.
    (fs as any).writeFile = (...args: unknown[]) => {
      observe(args[0]);
      return (originalWriteFile as (...a: unknown[]) => Promise<void>)(...args);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    (fs as any).rename = (...args: unknown[]) => {
      observe(args[1]);
      return (originalRename as (...a: unknown[]) => Promise<void>)(...args);
    };
    // 🛑 THE SYNC NAMESPACE TOO. The first version of this row watched only
    // `node:fs/promises` and its non-vacuity guard fired: the sequence held four
    // `index.json` writes and the seat row, and NO record file at all. Watching one
    // namespace is how an fs instrument goes blind while looking complete — the same hole
    // AP11's classifier had. `node:fs` and `node:fs/promises` are two objects.
    const originalWriteFileSync = fsSync.writeFileSync;
    const originalRenameSync = fsSync.renameSync;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    (fsSync as any).writeFileSync = (...args: unknown[]) => {
      observe(args[0]);
      return (originalWriteFileSync as (...a: unknown[]) => void)(...args);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    (fsSync as any).renameSync = (...args: unknown[]) => {
      observe(args[1]);
      return (originalRenameSync as (...a: unknown[]) => void)(...args);
    };
    try {
      await runQueuedTask(
        "order-parent",
        {
          requestId: "req-order",
          message: "spawn a subagent",
          prompt: textPrompt("spawn a subagent"),
          permissionMode: "approve-all",
          timeoutMs: 10_000,
          waitForCompletion: true,
          enqueuedAt: Date.now(),
          send: () => {},
          close: () => {},
        },
        {
          sharedClient: makeSubagentSpawningClient("order-parent-acp", "subagent-1"),
          suppressSdkConsoleErrors: true,
        },
      );
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore
      (fs as any).writeFile = originalWriteFile;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore
      (fs as any).rename = originalRename;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore
      (fsSync as any).writeFileSync = originalWriteFileSync;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore
      (fsSync as any).renameSync = originalRenameSync;
    }

    // Through the NAMED shared precondition, so an outbox-contention miss cannot be misread
    // as "there is no ordering to observe" — which would point the reader at this row's own
    // subject (the record-before-row ordering) rather than at the write that never landed.
    const childRef = await requirePath3ShadowRecord(
      "order-parent",
      "that path 3 writes the RECORD BEFORE THE ROW, observed in call order (AP16 REVERSED)",
    );
    const childId = childRef.acpxRecordId;

    const firstRecordWrite = sequence.findIndex((target) => target.includes(`${childId}.json`));
    const firstRowWrite = sequence.findIndex((target) => target.includes("seats.json"));
    // NON-VACUITY, BOTH HALVES. An instrument that observed neither write would satisfy any
    // `<` comparison between two `-1`s, and that is exactly how this family of row goes
    // quietly blind — which has happened four times on this block.
    assert.notEqual(
      firstRecordWrite,
      -1,
      `the instrument never saw the child record written at all — it is blind, not passing. ` +
        `sequence=${JSON.stringify(sequence.slice(0, 20))}`,
    );
    assert.notEqual(
      firstRowWrite,
      -1,
      `the instrument never saw the seat row written at all — it is blind, not passing. ` +
        `sequence=${JSON.stringify(sequence.slice(0, 20))}`,
    );
    assert.ok(
      firstRecordWrite < firstRowWrite,
      `path 3 wrote the seat ROW before the child RECORD (record@${firstRecordWrite}, ` +
        `row@${firstRowWrite}). That is the ordering whose mint SUCCEEDING made the record ` +
        `write fail outbox-busy after its full 4 s budget — 1 failure in 6 under load — and ` +
        `it loses the shadow record SILENTLY, because the enclosing catch is best-effort. ` +
        `Item 8 forbids creation depending on the store BY ERROR OR BY SIDE EFFECT, and no ` +
        `guard can catch a call that SUCCEEDS: only this ordering can.`,
    );
  });
});

// ─── F8's INVARIANT ITSELF: AN EMISSION ADDED TO OBSERVE A FAILURE JOINS THE CODE PATH IT
//     OBSERVES, AND INHERITS ITS INVARIANTS ───────────────────────────────────────────────
//
// 🔑 THE POINT THE SUB-HoD MADE THAT THIS ROW EXISTS FOR: the durable leg is a RECORD WRITE,
// so it can fail for exactly the reasons the thing it is reporting failed for. Two ways to
// get that wrong, and item 8 forbids both: **throwing** (the warning costs the session it was
// warning about) and **swallowing** (`.catch(() => {})`, so the operator believes a line is
// on the record when it is not). `runtime.ts:2381` is a verbatim
// `void writer.appendMessage(message).catch(() => {})` a few lines from path 3's mint — the
// nearest idiom is the forbidden one. It is PRE-EXISTING and not B2's to fix; it is B2's to
// not copy.
//
// This row drives the shared writer all three sites use, so it covers the plain-create path,
// the fork/copy path and path 3 in one place, at the layer where the guarantee lives.
test("F8 · when the DURABLE leg fails, the failure is ANNOUNCED — never swallowed, never thrown", async () => {
  await withTempHome(async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    const record: SessionRecord = makeSessionRecordFixture({
      acpxRecordId: "announce-subject",
      acpSessionId: "announce-subject-acp",
      agentCommand: "node mock-agent.js",
      cwd: path.join(homeDir, "workspace"),
      seatId: "announce-seat",
      holderOrdinal: 1,
      holderActive: true,
    });
    await writeSessionRecordFile(homeDir, record);

    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return (realWrite as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    // INDUCED, not sampled: a read-only session dir makes the boundary write fail
    // deterministically (it cannot create its temp file or its lock).
    await fs.chmod(sessionDir, 0o500);
    try {
      const { reportOperatorDiagnostic } = await import("../src/session/operator-diagnostic.js");
      // 🛑 MUST NOT THROW. If this rejects, a store diagnostic can fail a spawn — which is
      // the dependency item 8 deletes, reintroduced through the WARNING rather than the mint.
      await reportOperatorDiagnostic(record, "acpx seat-row-not-minted: INDUCED-FOR-TEST");
    } finally {
      process.stderr.write = realWrite;
      await fs.chmod(sessionDir, 0o700);
    }

    const all = written.join("");
    // 1. The terminal leg still fired — it goes FIRST precisely so a failing durable leg
    //    cannot take it down.
    assert.match(
      all,
      /INDUCED-FOR-TEST/,
      "the diagnostic itself was lost when the stream write failed",
    );
    // 2. AND THE FAILURE OF THE DURABLE LEG WAS ANNOUNCED. This is the assertion a
    //    `.catch(() => {})` fails: without it, an operator reads the warning and reasonably
    //    assumes it is on the record.
    assert.match(
      all,
      /NOT on the record/,
      "the durable leg failed SILENTLY — the operator is left believing the line is on the " +
        "record. This is the `.catch(() => {})` shape item 8 forbids by name",
    );
  });
});

// ─── THE CLI ORDERING ROW — THE ONE THE RETIRED AP16 BLOCK SAID COULD NOT BE WRITTEN ──────
//
// ⚠️ READ THE RETIRED-AP16 BLOCK ABOVE FIRST: it states that the two CLI paths' ordering is
// NOT asserted, and lists the faults that cannot assert it. **That paragraph is now WRONG in
// its conclusion and RIGHT in every particular**, and the difference is one fault it did not
// try. Kept as-is rather than rewritten, because the six vacuous candidates it and the
// test-engineer's sweep recorded are the expensive part and must not be re-derived.
//
// 🔑 THE OBSERVATION. Call order does not survive a subprocess; the END STATE does:
//        row-first    + a failed record write  ⇒  A SEAT ROW WITH NO RECORD
//        record-first + a failed record write  ⇒  NO ROW AT ALL
// So force the record write to fail, and ask whether an orphan row was left behind.
//
// 🔑 THE FAULT, AND IT IS ASYMMETRIC BY CONSTRUCTION — that is the whole trick. The record
// write runs under the record's own lock file, `<sessions>/<record-id>.json.lock`
// (`record-file-lock.ts`); the mint writes `seats.json` and never touches that path. So a
// DIRECTORY planted at `<record-id>.json.lock` (the run is pinned to that id with
// `--record-id`) makes the record write — and only the record write — wait out the lock budget
// and fail `record-lock-timeout`, while the seat store stays writable for the mint. (Until
// 2026-10-06 the fault was `chmod 555 ~/.acpx`, which stopped the SQLite OUTBOX creating its
// journal one directory above the store; ordinary record writes no longer open the outbox, so
// that fault stopped biting — HOD-R51.) A whole-tree fault blocks both and cannot
// discriminate — which is exactly why six other candidates are measured vacuous (see the
// retired-AP16 block and `verification/verification-evidence/RIG-ordering-discriminator.md`):
// a directory at `index.json` bites at an index write that PRECEDES the mint; a read-only
// sessions dir is SYMMETRIC; and `chmod` on either JSON file does not bite at all, because
// temp+rename needs no write permission on the TARGET.
//
// ⚠️ EACH ARM WAITS THE LOCK BUDGET (20 s) before the write fails — the price of a fault that
// bites at the record write and nowhere else.
//
// 🛑 THIS IS NOT E300's RETIRED DETECTOR, though the observation is identical. There the
// orphan row was a RATE PROBE whose subject the fix eliminates, so it expired with the fix.
// Here the orphan row's **ABSENCE is the assertion**, under a controlled fault. Same
// observation, OPPOSITE epistemic role — do not retire this as a duplicate of that.
//
// 🔑 AND IT IS CALIBRATED, NOT ARGUED — MEASURED A/B, BOTH DIRECTIONS (measured on the
// outbox-era fault; the lock-directory fault's red arm has not been re-measured):
//
//   | tree       | ordering      | plain leg        | fork/copy leg    |
//   |------------|---------------|------------------|------------------|
//   | `a3a6f41`  | row-first     | **RED** orphans=1 | **RED** orphans=1 |
//   | `28a17d6`  | record-first  | green orphans=0  | green orphans=0  |
//
// The red arm was produced by lifting THESE ROWS VERBATIM into a throwaway worktree at
// `a3a6f41` and running them there; C1 and C2 PASSED on that arm (the fault signature was
// `attempt to write a readonly database`, i.e. the record write), so the failure is the
// ordering assertion firing and not the rig collapsing.
//
// 🛑 WHY THAT SECOND STEP WAS NOT OPTIONAL. The test-engineer's probe 14 had already shown the
// MECHANISM discriminates. That is a different claim from "THIS ROW'S assertions fire on the
// ordering they detect" — this is new assertion code and could be vacuous in its own right.
// Three of this block's four instrument defects were exactly that: an assertion that looked
// like coverage and could not fail. **A rig proven to discriminate does not transfer its
// calibration to the row you write on top of it.**
// 🔑 AND BOTH LEGS WENT RED SEPARATELY, which is the part that proves the fork/copy row is not
// a duplicate of the plain one: if it were, it would have passed vacuously on the red arm.

type OrderingArm = { readonly orphans: number; readonly failure: string };

/**
 * Run the discriminator on one CLI leg and return what the end state shows.
 *
 * BOTH CONTROLS ARE IN HERE, NOT IN THE INVESTIGATION THAT FOUND THEM — a rig whose controls
 * live only in a scratch probe is a rig nobody can trust six months from now.
 */
async function runOrderingDiscriminator(homeDir: string, forkLeg: boolean): Promise<OrderingArm> {
  const acpxDir = path.join(homeDir, ".acpx");
  const sessionDir = path.join(acpxDir, "sessions");
  const cwd = path.join(homeDir, "work");
  await fs.mkdir(cwd, { recursive: true });
  const agent = forkLeg ? `${MOCK_AGENT_COMMAND} --supports-fork-session` : MOCK_AGENT_COMMAND;

  // 0 · RIG CONTROL — the UNFAULTED create must succeed, or nothing below means anything.
  const seed = await runCli(
    [
      "--cwd",
      cwd,
      "--agent",
      agent,
      "--approve-all",
      "--format",
      "json",
      "sessions",
      "new",
      "-s",
      "seed",
    ],
    homeDir,
  );
  assert.equal(
    seed.code,
    0,
    `rig control failed BEFORE the fault — non-result, not a red: ${seed.stderr}`,
  );
  const seedId = String(
    (JSON.parse(seed.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
  );
  const storePath = path.join(sessionDir, "seats.json");
  const before = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, unknown>;

  // 1 · THE FAULT.
  const faultedId = crypto.randomUUID();
  await fs.mkdir(path.join(sessionDir, `${faultedId}.json.lock`));
  let run: CliResult;
  let storeWritableUnderFault = false;
  {
    // The asymmetry itself, asserted rather than assumed.
    const stillWritable = await fs
      .access(sessionDir, fsSync.constants.W_OK)
      .then(() => true)
      .catch(() => false);
    assert.ok(
      stillWritable,
      "the fault is SYMMETRIC — it blocked the store as well as the record write, so a missing " +
        "row would prove nothing about ordering. This is the trap five other candidate faults fell into",
    );

    run = forkLeg
      ? await runCli(
          [
            "--format",
            "json",
            "sessions",
            "copy",
            "--from",
            seedId,
            "--name",
            "faulted",
            "--record-id",
            faultedId,
          ],
          homeDir,
        )
      : await runCli(
          [
            "--cwd",
            cwd,
            "--agent",
            agent,
            "--approve-all",
            "--format",
            "json",
            "sessions",
            "new",
            "-s",
            "faulted",
            "--record-id",
            faultedId,
          ],
          homeDir,
        );

    // C2 · THE STORE WAS WRITABLE AT THAT MOMENT — proven by planting a row through the
    // PRODUCT'S OWN writer, not by an fs permission check (which is what `access` above
    // already did, and which does not prove the writer would have succeeded).
    // 🛑 WITHOUT C2, "no orphan row" collapses to "the store was unwritable too".
    const { mintSeatRow } = await import("../src/session/persistence.js");
    const probeSeat = crypto.randomUUID();
    await mintSeatRow(sessionDir, {
      seatId: probeSeat,
      holderId: crypto.randomUUID(),
      name: "c2-probe",
      createdAt: new Date().toISOString(),
      brickId: undefined,
    });
    const afterProbe = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, unknown>;
    storeWritableUnderFault = Object.hasOwn(afterProbe, probeSeat);
    delete afterProbe[probeSeat];
    await fs.writeFile(storePath, `${JSON.stringify(afterProbe)}\n`, "utf8");
  }

  // C1 · THE FAULT FIRED AT THE RECORD WRITE — **and this is the control that must be
  // seam-specific rather than failure-generic.** "Did the run fail?" is not "did it fail at
  // the seam I aimed at?" The test-engineer's first candidate passed a failure-generic C1
  // while measuring nothing at all: it failed at a READ that happens BEFORE the mint, so
  // neither ordering could have reached the mint and both arms showed no orphan.
  // ⇒ A CONTROL CAN BE SATISFIED BY THE WRONG FAILURE.
  assert.notEqual(
    run.code,
    0,
    `the faulted run SUCCEEDED — the fault did not bite at all: ${run.stdout}`,
  );
  const both = run.stdout + run.stderr;
  assert.match(
    both,
    /session record lock|record-lock-timeout/i,
    `C1: the run failed, but NOT at the record write — so this arm proves nothing about ` +
      `ordering. Failure was: ${both.replace(/\s+/g, " ").slice(0, 300)}`,
  );
  assert.equal(
    /EISDIR.*read|record-id destination already exists/i.test(both),
    false,
    "C1: the fault fired at an EARLY READ, before the mint — the classic vacuous arm",
  );
  assert.ok(
    storeWritableUnderFault,
    "C2: the store was NOT writable while the fault was in place, so the absence of an orphan " +
      "row says only that nothing could be written — not that the mint never ran",
  );

  // 2 · THE OBSERVATION.
  const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
    string,
    { active_holder_id?: string } | undefined
  >;
  const files = new Set(await fs.readdir(sessionDir));
  let orphans = 0;
  for (const seatId of Object.keys(store)) {
    if (Object.hasOwn(before, seatId)) {
      continue;
    }
    const holder = store[seatId]?.active_holder_id;
    if (holder !== undefined && holder !== null && !files.has(`${holder}.json`)) {
      orphans += 1;
    }
  }
  return { orphans, failure: both.replace(/\s+/g, " ").slice(0, 200) };
}

const ORDERING_RED_MESSAGE =
  "THE CLI MINT ORDERING HAS BEEN REVERSED BACK TO ROW-FIRST. A seat row was minted and the " +
  "record write then failed, leaving a row that names a holder with no record — a seat that " +
  "can never be succeeded, belonging to a session that does not exist. Under record-first " +
  "this state is unreachable. Item 8 forbids creation depending on the store BY ERROR OR BY " +
  "SIDE EFFECT, and no guard can catch a mint that SUCCEEDS: only the ordering can. " +
  "DO NOT 'fix' this by deleting the orphan or by adding a retry — restore the ordering: the " +
  "mint goes BELOW the whole `if (forkContext) … else …`, after both record writes.";

test("ordering · PLAIN CREATE leaves NO orphan seat row when the record write fails", async () => {
  await withTempHome(async (homeDir) => {
    const arm = await runOrderingDiscriminator(homeDir, false);
    assert.equal(
      arm.orphans,
      0,
      `${ORDERING_RED_MESSAGE} (orphans=${arm.orphans}, fault=${arm.failure})`,
    );
  });
});

// THE SECOND LEG, AND IT IS NOT A DUPLICATE OF THE FIRST. `sessions copy` reaches the same
// call site through the OTHER branch of `if (forkContext) … else …` and writes through
// `writeSessionRecordAtBoundary` rather than `writeSessionRecord`. A reorder applied to one
// leg only would leave this one row-first AND LOOK DONE. The unit of coverage is the
// REACHABLE PATH, not the call site — counted wrong three times on this block before it stuck.
test("ordering · FORK/COPY leaves NO orphan seat row when the record write fails", async () => {
  await withTempHome(async (homeDir) => {
    const arm = await runOrderingDiscriminator(homeDir, true);
    assert.equal(
      arm.orphans,
      0,
      `${ORDERING_RED_MESSAGE} (orphans=${arm.orphans}, fault=${arm.failure})`,
    );
  });
});

// ─── brick 3dff714d — F1/F2/F3: the seat's brick_id on the DOMINANT creation
// path, and `seats set-brick --unset` ────────────────────────────────────────
//
// Daniel's own staging finding (Part 3, F1/F2/F3 — brick `0d2b83f0`'s
// `agents/67f2803e-…/staging-findings-1a5845c3-2026-10-01.md`), decided in
// `DECISIONS.md` on this brick. R10/R11: the value crosses CLI → seat-store →
// bricks-service, so every row below STARTS the value on the PRODUCING side (a
// real `runCli` spawn, or the store's own writer for a seat's PRE-EXISTING
// brick — never `mintSeatRow` called directly, which would be a unit test of
// the mutator, not coverage of the pipe) and ASSERTS it on the CONSUMING side
// (the record/seat read back from DISK, or a real `acpx seats show` /
// `seats set-brick` through `runCli` — the surface an operator and the
// acpx-ui attach route actually read).

// The findings' own two bricks (`staging-repro-…md`) — reused as fixed uuids
// rather than `crypto.randomUUID()` so a failing assertion's message is
// stable and greppable against the original finding.
const BRICK_A = "1a5845c3-a832-4370-b564-8ec5286bff79";
const BRICK_B = "1d459def-bbfd-44b6-8e14-9ad998f292d6";

function brickShimEnv(brickId: string): NodeJS.ProcessEnv {
  return {
    PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
    BRICK_SHIM_MODE: "ok",
    BRICK_SHIM_ID: brickId,
  };
}

// Plant a seat row directly through the store's OWN writer — the same
// `withSeatStoreWrite` call the "D11" test near the top of this file uses —
// so a row with a KNOWN, PRE-EXISTING brick_id exists without going through
// `sessions new --brick` (the thing F1 below is testing).
async function plantSeatRow(
  homeDir: string,
  seatId: string,
  overrides: { brickId?: string; brickValidated?: boolean; activeHolderId?: string | null } = {},
): Promise<void> {
  const sessionDir = path.join(homeDir, ".acpx", "sessions");
  await withSeatStoreWrite(sessionDir, () => ({
    mutation: {
      kind: "write" as const,
      seats: new Map([
        [
          seatId,
          {
            seatId,
            createdAt: "2026-09-28T00:00:00.000Z",
            activeHolderId: overrides.activeHolderId ?? null,
            nextOrdinal: 1,
            closedAt: null,
            name: undefined,
            // Brick `9984c510`: TYPE change on the existing slot. None of
            // this file's existing F2 join-truth-table callers assert
            // anything about validation state, so the default (`false`,
            // UNVALIDATED) is the conservative, never-validated-by-
            // assumption choice — a caller that needs VALIDATED passes
            // `brickValidated: true` explicitly.
            brickId:
              overrides.brickId === undefined
                ? undefined
                : { ref: overrides.brickId, validated: overrides.brickValidated ?? false },
            favorite: false,
          },
        ],
      ]),
    },
    result: undefined,
  }));
}

// ENOENT (the directory itself never got created) is an even STRONGER "nothing
// was written" than an empty listing — ROW A refuses before the sessions dir
// exists at all, which earlier refusal rows never hit (they at least planted a
// seat row first, via `plantSeatRow`, which creates the directory).
function sessionRecordFiles(sessionDir: string): Promise<string[]> {
  return fs
    .readdir(sessionDir)
    .then((names) =>
      names.filter(
        (name) => name.endsWith(".json") && name !== "index.json" && name !== "seats.json",
      ),
    )
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
}

test("F1 · `sessions new --brick` writes the SEAT's brick_id, not only the holder's own metadata", async () => {
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
        "f1-fresh",
        "--brick",
        BRICK_A,
      ],
      homeDir,
      brickShimEnv(BRICK_A),
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    // Consuming side (a) — the holder's OWN metadata, unaffected by this fix
    // (DECISIONS.md: "the holder's metadata.brick stays as the derived copy").
    const onDisk = await readRecordJson(homeDir, id);
    assert.equal(
      (onDisk.metadata as Record<string, unknown> | undefined)?.brick,
      BRICK_A,
      "the holder's own metadata.brick must still carry --brick",
    );
    const seatId = String(onDisk.seat_id);

    // Consuming side (b) — the SEAT's row, read back through the store.
    const store = await readSeatStore(sessionDir);
    const row = seatFromStore(store, seatId);
    assert.ok(row, "F1: the seat row is missing entirely");
    assert.equal(
      row.brickId?.ref,
      BRICK_A,
      "F1 (brick 3dff714d): `sessions new --brick` left the SEAT's brick_id unset — only " +
        "the holder's metadata.brick was written, which is the exact measured defect " +
        "(C4/Cluster A: the seat record's brick_id is the source of truth)",
    );

    // Consuming side (c) — the surface an operator and the acpx-ui attach route
    // actually read: a real `acpx seats show`, not a second store read.
    const shown = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "show", seatId],
      homeDir,
    );
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(
      (JSON.parse(shown.stdout.trim()) as { brickId?: unknown }).brickId,
      BRICK_A,
      "F1: `acpx seats show` does not report the brick the seat was created with",
    );
  });
});

// 🔑 ROW B OF THE VALIDATION-VS-NO-VALIDATION PAIR (paired with "ROW A" below).
// `resolveBrickFlagRef` falls back to `acceptUuidWhenBrickCliUnavailable`
// whenever `brick show` does not resolve — and multiple independent
// measurements on this box (this brick's own L0, the implementer, the TE, and
// a sibling lane reading real session records: 5 of 5 consecutive degraded
// spawns in one 24-minute window) agree that leg, not the `ok` one, is what a
// loaded box actually takes: `brick show` measured at 4972–7658 ms against the
// 3000 ms `BRICK_CLI_TIMEOUT_MS` budget — SUSTAINED windows, not run-to-run
// noise, so retrying past it is not reliable.
//
// 🛑 **THE REAL SEMANTIC THIS ROW PINS IS "accepted UNVALIDATED" — not just
// "the value survives".** The sibling lane's measurement is what makes this
// row's point sharp: on the degraded leg the write ever lands (all five of
// its spawns linked correctly) — **it is the CHECK that is dropped, not the
// link.** A typo'd or stale brick ref would be written here too, reported as
// SUCCESS, with the warning banner reading like a tolerated hiccup rather than
// "nothing validated this." **This row PINS today's behaviour; it is not an
// endorsement of it** — whether unvalidated-accept is the right product
// decision is outside this brick's mandate. Its job is to make a future
// change confront the fact rather than drift past it silently. See ROW A
// below for the healthy-validation path this is contrasted against: together
// they pin validation-vs-no-validation, which neither pins alone.
//
// The shim's `hang` mode (a 30 s sleep) makes the timeout fire deterministically
// rather than depending on real box load, so this row is reliable rather than a
// second flaky copy of the hazard it tests. No `timeoutMs` plumbing needed:
// `execFile`'s own `timeout` option already bounds the wait to
// `BRICK_CLI_TIMEOUT_MS` (~3 s), so this row costs seconds, not minutes.
test(
  "F1/fallback leg (ROW B) · --brick is ACCEPTED UNVALIDATED when `brick show` times out, and " +
    "still reaches BOTH the holder and the SEAT — pins today's behaviour, not an endorsement",
  async () => {
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
          "f1-fallback",
          "--brick",
          BRICK_A,
        ],
        homeDir,
        {
          PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
          BRICK_SHIM_MODE: "hang",
        },
      );
      assert.equal(created.code, 0, created.stderr);
      // Sanity: this row must actually TAKE the fallback leg, not the `ok` one
      // — otherwise it is a second copy of the F1 test above, not new coverage.
      assert.match(
        created.stderr,
        /brick CLI unavailable/,
        "this row did not take the degraded leg — the shim's `hang` mode did not time out as expected",
      );
      const id = String(
        (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
      );

      const onDisk = await readRecordJson(homeDir, id);
      assert.equal(
        (onDisk.metadata as Record<string, unknown> | undefined)?.brick,
        BRICK_A,
        "on the fallback leg, the holder's own metadata.brick must still carry --brick",
      );
      const seatId = String(onDisk.seat_id);

      const store = await readSeatStore(sessionDir);
      assert.equal(
        seatFromStore(store, seatId)?.brickId?.ref,
        BRICK_A,
        "F1 on the fallback leg: the SEAT's brick_id must still be written — " +
          "`acceptUuidWhenBrickCliUnavailable` returns the same uuid it was given, so the " +
          "degraded leg must reach the seat identically to the `ok` leg",
      );
    });
  },
);

// 🔑 ROW A OF THE VALIDATION-VS-NO-VALIDATION PAIR (paired with ROW B above).
// A row asserting "today's fallback is invariant — refused on BOTH the ok and
// hang legs" was this lane's own FIRST DRAFT, and it is a REJECTED SHAPE, not
// a rejected finding: a row that passes identically on the healthy and the
// broken path cannot fail when the thing it guards breaks. The redesign pins
// the two legs SEPARATELY instead — ROW A is `brick show` resolving cleanly
// to NOT-FOUND (the healthy validation path: a typo'd/stale brick ref is
// REFUSED), ROW B above is the same ref under `hang` (accepted unvalidated).
// Neither row alone states the real semantic; together they do. Both are
// deterministic — pinned by the shim's mode, never by real box load.
test(
  "F1/fallback leg (ROW A) · an UNKNOWN brick ref is REFUSED when `brick show` resolves " +
    "cleanly — the healthy validation path ROW B above is contrasted against",
  async () => {
    await withTempHome(async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const sessionDir = path.join(homeDir, ".acpx", "sessions");

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
          "-s",
          "row-a-not-found",
          "--brick",
          BRICK_A,
        ],
        homeDir,
        { PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`, BRICK_SHIM_MODE: "not-found" },
      );
      assert.notEqual(
        refused.code,
        0,
        "an unknown brick ref was ACCEPTED — `brick show` resolved cleanly to not-found, so " +
          "this is the HEALTHY validation leg and must refuse",
      );
      const said = `${refused.stdout}${refused.stderr}`;
      assert.match(
        said,
        /unknown brick/i,
        "the refusal must say the brick is UNKNOWN, not something else",
      );

      const files = await sessionRecordFiles(sessionDir);
      assert.deepEqual(
        files,
        [],
        "a session record was written despite the refusal, on the validation leg",
      );
    });
  },
);

// 🔑 THE TE's INDUCED-FAILURE SPECIMEN, brick 3dff714d item 3 — F1 widened what a
// failed mint costs (the canonical brick_id, not only the row), so the
// diagnostic on that path must name the consequence AND the remedy must be one
// an operator can actually EXECUTE from the state the failure leaves behind —
// never "set-brick now" (requires a row that does not exist after an atomic
// mint failure; naming it would be a second F4) and never a bare "run the
// backfill" that doesn't say a brick link is even at stake. This row does not
// stop at reading the message: it EXECUTES the printed advice and asserts the
// operator ends up recovered, which is the only way to know the advice works
// rather than merely reads well.
test(
  "F1 remedy · a CORRUPT store with --brick: the diagnostic names the brick consequence, and " +
    "EXECUTING its remedy (quarantine + backfill) actually restores the seat's brick_id",
  async () => {
    await withTempHome(async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const sessionDir = path.join(homeDir, ".acpx", "sessions");
      await fs.mkdir(sessionDir, { recursive: true });
      // Same induction as "item 8" above: a store that EXISTS and cannot be
      // parsed, so `withSeatStoreWrite` refuses to overwrite it (fail-closed)
      // while the create path itself fails OPEN (item 8's ruling).
      const storePath = path.join(sessionDir, "seats.json");
      await fs.writeFile(storePath, "{ not json at all", "utf8");

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
          "f1-remedy",
          "--brick",
          BRICK_A,
        ],
        homeDir,
        brickShimEnv(BRICK_A),
      );
      // 1. The session is still created and usable (item 8's ruling, unaffected).
      assert.equal(created.code, 0, `a corrupt seat store failed the spawn: ${created.stderr}`);
      const id = String(
        (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
      );
      const onDisk = await readRecordJson(homeDir, id);
      const seatId = String(onDisk.seat_id);
      assert.equal(
        (onDisk.metadata as Record<string, unknown> | undefined)?.brick,
        BRICK_A,
        "the holder's own metadata.brick must land even though the row-mint failed",
      );

      // 2. THE DIAGNOSTIC NAMES THE BRICK CONSEQUENCE — not only "no row".
      assert.match(
        created.stderr,
        /brick_id was NOT written/,
        "the diagnostic must say a brick link is at stake, not only that the row is missing",
      );
      assert.match(
        created.stderr,
        new RegExp(BRICK_A),
        "the diagnostic must name the brick that was lost from the canonical copy",
      );
      // 🛑 AND IT MUST NOT NAME `set-brick` AS A REMEDY HERE — no row exists yet
      // for this seat, so `set-brick` would refuse SEAT_ROW_MISSING; naming it
      // would be exactly the findings' F4 class this fix is supposed to avoid.
      assert.doesNotMatch(
        created.stderr,
        /seats set-brick/,
        "the diagnostic named a remedy the operator cannot yet execute — no row exists for " +
          "this seat, so `seats set-brick` would refuse SEAT_ROW_MISSING",
      );
      assert.match(created.stderr, /quarantine/i, "the remedy for CORRUPTION must still be named");

      // 3. EXECUTE THE PRINTED ADVICE, exactly as an operator would, and assert
      // recovery — never just that the message reads well.
      const quarantinePath = `${storePath}.corrupt-test`;
      await fs.rename(storePath, quarantinePath);
      const backfilled = await runCli(
        ["--cwd", cwd, "--format", "json", "seats", "backfill", "--apply"],
        homeDir,
      );
      assert.equal(backfilled.code, 0, backfilled.stderr);

      const store = await readSeatStore(sessionDir);
      const row = seatFromStore(store, seatId);
      assert.ok(row, "the operator followed the printed remedy and the seat STILL has no row");
      assert.equal(
        row.brickId?.ref,
        BRICK_A,
        "RECOVERY: after executing the diagnostic's own remedy, the seat's brick_id must be " +
          "restored — derived from the holder's metadata.brick, exactly as item (d) promises",
      );
    });
  },
);

test(
  "F2/leg 3 (THE MEASURED LEG) · join with NO --brick: the SEAT's brick wins, the spawner's " +
    "ambient brick is never consulted",
  async () => {
    await withTempHome(async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const sessionDir = path.join(homeDir, ".acpx", "sessions");

      // The SPAWNER — a session record carrying brick A as its OWN
      // metadata.brick, addressed via ACPX_SESSION_URL exactly as a real
      // handover spawn would be: `parentSessionRefFromEnv`
      // (command-handlers.ts) is the ONLY way `parent?.brick` is ever
      // populated for a bare `sessions new`, so simulating it any other way
      // would not be testing the real ambient-inheritance seam this bug lives
      // on.
      await writeSessionRecordFile(
        homeDir,
        makeSessionRecordFixture({
          acpxRecordId: "f2-spawner",
          acpSessionId: "acp-f2-spawner",
          agentCommand: MOCK_AGENT_COMMAND,
          cwd,
          metadata: { brick: BRICK_A },
        }),
      );

      // The SEAT — planted directly with brick B: THE DISCRIMINATOR. With the
      // seat and the spawner on the SAME brick, "holder inherits the seat"
      // and "holder inherits the spawner" are INDISTINGUISHABLE
      // (DECISIONS.md) — this is what splits the two hypotheses, reused from
      // the findings' own repro shape (seat on B, spawner on A).
      const seatId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
      await plantSeatRow(homeDir, seatId, { brickId: BRICK_B });

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
          "--seat",
          seatId,
          // 🛑 NO --brick AT ALL. This is leg 3 — the one that fired in
          // Daniel's measured F2 run: a real handover spawn never carries
          // --brick.
        ],
        homeDir,
        { ACPX_SESSION_URL: "https://test-ui.example/?session=f2-spawner" },
      );
      assert.equal(joined.code, 0, joined.stderr);
      const childId = String(
        (JSON.parse(joined.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
      );

      const onDisk = await readRecordJson(homeDir, childId);
      assert.equal(
        (onDisk.metadata as Record<string, unknown> | undefined)?.brick,
        BRICK_B,
        "F2/leg 3 (brick 3dff714d): the holder inherited the SPAWNER's brick A instead of " +
          "the SEAT's brick B — the exact measured defect, and DECISIONS.md's own naming of " +
          "the leg that fired in Daniel's real run",
      );

      // The seat itself must be untouched by the join — D13: joining never
      // mints or mutates the row it joins.
      const store = await readSeatStore(sessionDir);
      assert.equal(
        seatFromStore(store, seatId)?.brickId?.ref,
        BRICK_B,
        "the join must not have moved the seat's own brick_id",
      );
    });
  },
);

test(
  "F2/leg 1 · explicit --brick DISAGREEING with the seat is REFUSED at the origin, before " +
    "anything is created",
  async () => {
    await withTempHome(async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const sessionDir = path.join(homeDir, ".acpx", "sessions");

      const seatId = "cccccccc-dddd-4eee-8fff-000000000000";
      await plantSeatRow(homeDir, seatId, { brickId: BRICK_B });

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
          seatId,
          "--brick",
          BRICK_A,
        ],
        homeDir,
        brickShimEnv(BRICK_A),
      );
      assert.notEqual(
        refused.code,
        0,
        "an explicit --brick that disagrees with the seat's own brick was ACCEPTED",
      );
      const said = `${refused.stdout}${refused.stderr}`;
      assert.match(
        said,
        /SEAT_BRICK_MISMATCH/,
        "the refusal must carry the SEAT_BRICK_MISMATCH code",
      );
      assert.match(said, new RegExp(BRICK_A), "the refusal must name the EXPLICIT --brick");
      assert.match(said, new RegExp(BRICK_B), "the refusal must name the SEAT's own brick");
      assert.match(said, /seats set-brick/, "the refusal must name the remedy");

      // NOTHING WAS CREATED — the refusal fires before any write, the same
      // guarantee D11/D8's "a malformed --seat is refused at the origin,
      // before anything is created" gives the sibling refusal.
      const files = await sessionRecordFiles(sessionDir);
      assert.deepEqual(files, [], "a session record was written despite the refusal");

      // And the seat itself is UNCHANGED.
      const store = await readSeatStore(sessionDir);
      assert.equal(
        seatFromStore(store, seatId)?.brickId?.ref,
        BRICK_B,
        "the refused spawn must not have touched the seat's brick_id",
      );
    });
  },
);

test("F2/leg 2 · explicit --brick EQUAL to the seat's own brick is accepted, with no diagnostic", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");

    const seatId = "dddddddd-eeee-4fff-8000-111111111111";
    await plantSeatRow(homeDir, seatId, { brickId: BRICK_A });

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
        "--seat",
        seatId,
        "--brick",
        BRICK_A,
      ],
      homeDir,
      brickShimEnv(BRICK_A),
    );
    assert.equal(joined.code, 0, joined.stderr);
    assert.doesNotMatch(
      `${joined.stdout}${joined.stderr}`,
      /SEAT_BRICK_MISMATCH/,
      "leg 2 (X === Y) must accept with NO diagnostic, per DECISIONS.md",
    );
    const id = String(
      (JSON.parse(joined.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRecordJson(homeDir, id);
    assert.equal((onDisk.metadata as Record<string, unknown> | undefined)?.brick, BRICK_A);

    const store = await readSeatStore(sessionDir);
    assert.equal(
      seatFromStore(store, seatId)?.brickId?.ref,
      BRICK_A,
      "leg 2 must not change the seat's own brick_id",
    );
  });
});

// ─── DECISIONS.md AMENDMENT — the four rows the TE's S4a/S4b/S4c measured
// that the original three-leg ruling never addressed ──────────────────────

test("S4c · `--no-brick` against a seat that CARRIES a brick is REFUSED, same family as a disagreeing --brick", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");

    const seatId = "11111111-2222-4333-8444-555555555555";
    await plantSeatRow(homeDir, seatId, { brickId: BRICK_B });

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
        seatId,
        "--no-brick",
      ],
      homeDir,
    );
    assert.notEqual(
      refused.code,
      0,
      "--no-brick against a brick-carrying seat was ACCEPTED — S4a/S4c says this must refuse",
    );
    const said = `${refused.stdout}${refused.stderr}`;
    assert.match(
      said,
      /SEAT_BRICK_MISMATCH/,
      "the refusal must carry the SEAT_BRICK_MISMATCH code",
    );
    assert.match(said, new RegExp(seatId), "the refusal must name the seat");
    assert.match(said, new RegExp(BRICK_B), "the refusal must name the seat's own brick");

    const files = await sessionRecordFiles(sessionDir);
    assert.deepEqual(files, [], "a session record was written despite the refusal");
    const store = await readSeatStore(sessionDir);
    assert.equal(
      seatFromStore(store, seatId)?.brickId?.ref,
      BRICK_B,
      "the refused spawn must not touch the seat",
    );
  });
});

test("O2 · `--from <A> --no-brick` is refused with advice that does not name the --seat flag the caller never typed", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const shimEnv = {
      PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
      BRICK_SHIM_MODE: "ok",
      BRICK_SHIM_ID: BRICK_A,
    };
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];

    const first = await runCli([...base, "sessions", "new", "--brick", BRICK_A], homeDir, shimEnv);
    assert.equal(first.code, 0, first.stderr);
    const firstId = String(
      (JSON.parse(first.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const refused = await runCli(
      [...base, "sessions", "new", "--from", firstId, "--no-brick"],
      homeDir,
      shimEnv,
    );
    assert.notEqual(refused.code, 0, "--no-brick against a brick-carrying seat must refuse");
    const said = `${refused.stdout}${refused.stderr}`;
    assert.match(said, /SEAT_BRICK_MISMATCH/);
    assert.doesNotMatch(said, /omit --seat/, "the advice names a flag the caller did not type");
    assert.match(said, /seats set-brick \S+ --unset/, "the working remedy stays");
  });
});

test("S4a (1/3) · join a BRICK-LESS seat with explicit --brick A: accept, holder gets A, the SEAT IS NOT WRITTEN", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");

    const seatId = "22222222-3333-4444-8555-666666666666";
    await plantSeatRow(homeDir, seatId); // absent brick_id

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
        "--seat",
        seatId,
        "--brick",
        BRICK_A,
      ],
      homeDir,
      brickShimEnv(BRICK_A),
    );
    assert.equal(joined.code, 0, joined.stderr);
    const id = String(
      (JSON.parse(joined.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRecordJson(homeDir, id);
    assert.equal(
      (onDisk.metadata as Record<string, unknown> | undefined)?.brick,
      BRICK_A,
      "S4a: an explicit --brick against a brick-less seat must still reach the holder",
    );

    const store = await readSeatStore(sessionDir);
    assert.equal(
      seatFromStore(store, seatId)?.brickId,
      undefined,
      "S4a: the SEAT MUST NOT BE WRITTEN as a side effect of a join — joining never mints/mutates (D13)",
    );
  });
});

test("S4a (2/3) · join a BRICK-LESS seat with --no-brick: accept, holder gets nothing — agrees with the seat", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = path.join(homeDir, ".acpx", "sessions");

    const seatId = "33333333-4444-4555-8666-777777777777";
    await plantSeatRow(homeDir, seatId); // absent brick_id

    // The spawner has its OWN ambient brick A — --no-brick must suppress it,
    // same as it does for a fresh mint (withInheritedBrick's `blocked` leg).
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecordFixture({
        acpxRecordId: "s4a2-spawner",
        acpSessionId: "acp-s4a2-spawner",
        agentCommand: MOCK_AGENT_COMMAND,
        cwd,
        metadata: { brick: BRICK_A },
      }),
    );

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
        "--seat",
        seatId,
        "--no-brick",
      ],
      homeDir,
      { ACPX_SESSION_URL: "https://test-ui.example/?session=s4a2-spawner" },
    );
    assert.equal(joined.code, 0, joined.stderr);
    const id = String(
      (JSON.parse(joined.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRecordJson(homeDir, id);
    assert.equal(
      (onDisk.metadata as Record<string, unknown> | undefined)?.brick,
      undefined,
      "S4a: --no-brick against a brick-less seat must leave the holder with NO brick, " +
        "even though the spawner had one",
    );

    const store = await readSeatStore(sessionDir);
    assert.equal(seatFromStore(store, seatId)?.brickId, undefined, "the seat stays untouched");
  });
});

test(
  "S4a (3/3) · join a BRICK-LESS seat with NO --brick flag: holder gets the SPAWNER's ambient " +
    "brick — today's behaviour, deliberately preserved",
  async () => {
    await withTempHome(async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const sessionDir = path.join(homeDir, ".acpx", "sessions");

      const seatId = "44444444-5555-4666-8777-888888888888";
      await plantSeatRow(homeDir, seatId); // absent brick_id

      await writeSessionRecordFile(
        homeDir,
        makeSessionRecordFixture({
          acpxRecordId: "s4a3-spawner",
          acpSessionId: "acp-s4a3-spawner",
          agentCommand: MOCK_AGENT_COMMAND,
          cwd,
          metadata: { brick: BRICK_A },
        }),
      );

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
          "--seat",
          seatId,
          // NO --brick, NO --no-brick.
        ],
        homeDir,
        { ACPX_SESSION_URL: "https://test-ui.example/?session=s4a3-spawner" },
      );
      assert.equal(joined.code, 0, joined.stderr);
      const id = String(
        (JSON.parse(joined.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
      );
      const onDisk = await readRecordJson(homeDir, id);
      assert.equal(
        (onDisk.metadata as Record<string, unknown> | undefined)?.brick,
        BRICK_A,
        "S4a row 7: against a BRICK-LESS seat with no --brick, the holder must still inherit " +
          "the spawner's ambient brick — absence on the seat means UNKNOWN, not an instruction " +
          "to drop the ambient fallback",
      );

      const store = await readSeatStore(sessionDir);
      assert.equal(
        seatFromStore(store, seatId)?.brickId,
        undefined,
        "the seat must stay unwritten — this fallback must never heal a legacy seat as a side effect",
      );
    });
  },
);

test("S4b · THE BETTER DISCRIMINATOR — seat on B, spawner with NO brick at all, no --brick: holder gets B, not nothing", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    // No spawner record, no ACPX_SESSION_URL at all — there is NO competing
    // source of a brick anywhere. If the join path reads the seat's own
    // brick_id, the holder gets B; if it does not (the measured defect), the
    // holder gets nothing, which is a STRONGER falsifier than the A/B
    // fixture because there is nothing else it could have gotten instead.
    const seatId = "55555555-6666-4777-8888-999999999999";
    await plantSeatRow(homeDir, seatId, { brickId: BRICK_B });

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
    assert.equal(
      (onDisk.metadata as Record<string, unknown> | undefined)?.brick,
      BRICK_B,
      "S4b: with NO competing brick source anywhere, the holder still did not get the seat's " +
        "own brick — the join path never reads seat.brick_id at all, which is the actual defect",
    );
  });
});

test("F3 · `seats set-brick --unset` clears the seat's brick_id, read back through the CLI", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const base = ["--cwd", cwd, "--format", "json"];

    const seatId = "eeeeeeee-ffff-4000-8111-222222222222";
    await plantSeatRow(homeDir, seatId);

    const set = await runCli([...base, "seats", "set-brick", seatId, BRICK_A], homeDir);
    assert.equal(set.code, 0, set.stderr);
    assert.equal((JSON.parse(set.stdout.trim()) as { brickId?: unknown }).brickId, BRICK_A);

    const unset = await runCli([...base, "seats", "set-brick", seatId, "--unset"], homeDir);
    assert.equal(unset.code, 0, unset.stderr);
    const unsetPayload = JSON.parse(unset.stdout.trim()) as {
      brickId?: unknown;
      previousBrickId?: unknown;
    };
    assert.equal(unsetPayload.brickId, null, "--unset must report brickId: null");
    assert.equal(unsetPayload.previousBrickId, BRICK_A, "--unset must report what it cleared");

    const shown = await runCli([...base, "seats", "show", seatId], homeDir);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(
      (JSON.parse(shown.stdout.trim()) as { brickId?: unknown }).brickId,
      null,
      "F3 (brick 3dff714d): `seats show` still reports the OLD brick after --unset",
    );
  });
});

test(
  "F3 negative · `set-brick` refuses when given BOTH a brick and --unset, or NEITHER — " +
    "committed, not a mutation probe",
  async () => {
    await withTempHome(async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const base = ["--cwd", cwd, "--format", "json"];
      const seatId = "ffffffff-0000-4111-8222-333333333333";
      await plantSeatRow(homeDir, seatId);

      const both = await runCli(
        [...base, "seats", "set-brick", seatId, BRICK_A, "--unset"],
        homeDir,
      );
      assert.notEqual(both.code, 0, "passing a brick AND --unset together was accepted");
      assert.match(`${both.stdout}${both.stderr}`, /SEAT_BRICK_ARGS_INVALID/);

      const neither = await runCli([...base, "seats", "set-brick", seatId], homeDir);
      assert.notEqual(neither.code, 0, "passing neither a brick nor --unset was accepted");
      assert.match(`${neither.stdout}${neither.stderr}`, /SEAT_BRICK_ARGS_INVALID/);
    });
  },
);
