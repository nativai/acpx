import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  readSeatStore,
  resolveSessionRecord,
  seatFromStore,
  withSeatStoreWrite,
  writeSessionRecordAuthorizingSeatHolderWithoutIndex,
  type SeatRecord,
} from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// THE SUCCESSION WRITE — `ACTIVATION-PROTOCOL.md` §2.7, brick b64dfbb3 (B2).
//
// 🔑 EVERY REFUSAL HERE HAS A PAIRED ROW PROVING THE LEGITIMATE CASE STILL PASSES.
// That rule is not decoration: D11's "seat not in the store" refusal was tested and
// phase 0.2's was tested, and BECAUSE NEITHER GOT ITS PAIR, every seat the system
// created was un-joinable and un-succeedable for a while with the suite fully green.
// A refusal tested alone proves the door is locked; it says nothing about whether
// anyone can still get in. So the happy path is asserted FIRST, and each refusal row
// below names the positive row it is paired with.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const SEAT_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    // Same scrub `session-reparent.test.ts` documents: a fixture built without it can
    // silently acquire the TEST RUNNER's own session as ambient context.
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
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  return withTempHomeFixture("acpx-seat-activate-", run);
}

function sessionDirOf(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

async function readRecordJson(homeDir: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(sessionDirOf(homeDir), `${id}.json`), "utf8"),
  ) as Record<string, unknown>;
}

async function seedHolder(
  homeDir: string,
  id: string,
  over: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  const record = makeSessionRecordFixture({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand: "node mock",
    agentName: "claude",
    cwd: path.join(homeDir, "workspace"),
    name: id,
    seatId: SEAT_A,
    ...over,
  });
  await writeSessionRecordFile(homeDir, record);
  return record;
}

/** Plant a seat row directly through the store's own writer. */
async function seedSeat(homeDir: string, over: Partial<SeatRecord> = {}): Promise<SeatRecord> {
  const row: SeatRecord = {
    seatId: SEAT_A,
    createdAt: "2026-09-28T00:00:00.000Z",
    activeHolderId: "holder-one",
    nextOrdinal: 2,
    closedAt: null,
    name: "the seat",
    brickId: undefined,
    ...over,
  };
  await withSeatStoreWrite(sessionDirOf(homeDir), (store) => {
    const seats = new Map(store.seats);
    seats.set(row.seatId, row);
    return { mutation: { kind: "write", seats }, result: undefined };
  });
  return row;
}

/** A seat with holder-one ACTIVE (ordinal 1) and holder-two PREPARED (no ordinal) —
 * exactly the state `sessions new --seat` leaves behind. */
async function seedSuccession(homeDir: string): Promise<void> {
  await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
  await seedHolder(homeDir, "holder-one", { holderActive: true, holderOrdinal: 1 });
  await seedHolder(homeDir, "holder-two", { holderActive: false });
  await seedSeat(homeDir);
}

function activate(homeDir: string, seat = SEAT_A, successor = "holder-two"): Promise<CliResult> {
  return runCli(
    ["--agent", MOCK_AGENT_COMMAND, "--format", "json", "sessions", "activate", seat, successor],
    homeDir,
  );
}

// ─── 1 · THE HAPPY PATH — the paired row every refusal below leans on ─────────

test("a succession retires the predecessor, points the seat, and draws the ordinal", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.ok, true);
    assert.equal(payload.outcome, "activated");
    assert.equal(payload.holderOrdinal, 2, "the successor must take next_ordinal (2), not 1");

    // The SEAT ROW is the authority — assert it from disk.
    const store = await readSeatStore(sessionDirOf(homeDir));
    const row = seatFromStore(store, SEAT_A);
    assert.equal(row?.activeHolderId, "holder-two", "the seat still names the old holder");
    assert.equal(row?.nextOrdinal, 3, "next_ordinal must advance exactly once per activation");

    // The MIRROR on both records follows.
    const predecessor = await readRecordJson(homeDir, "holder-one");
    const successor = await readRecordJson(homeDir, "holder-two");
    assert.equal(predecessor.holder_active, false, "the predecessor was not retired");
    assert.equal(successor.holder_active, true, "the successor was not activated");
    assert.equal(successor.holder_ordinal, 2);

    // 🛑 RETIREMENT IS NOT A CLOSE. The old address must still RESOLVE so a sender can
    // be WARNED rather than getting a bare closed error — a closed-check would reject
    // first. This is the assertion that catches an "automatic close" being added.
    assert.notEqual(
      predecessor.closed,
      true,
      "the predecessor was CLOSED by activate — retirement is not a close, and closing it " +
        "collapses vacant into closed and makes the old address unresolvable",
    );
  });
});

test("the verb tells the caller closing the predecessor is THEIR duty, with the command", async () => {
  // D7 — the duty is a documented step with a named owner, not a mechanism. Nothing
  // else in the system will ever close the retired holder, so if this output stops
  // saying so, "retired but open" silently becomes a resting state.
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const result = await runCli(
      ["--agent", MOCK_AGENT_COMMAND, "sessions", "activate", SEAT_A, "holder-two"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Retired \(NOT closed\)/i);
    assert.match(result.stdout, /duty/i, "the output does not say whose duty the close is");
    assert.match(
      result.stdout,
      /acpx sessions close holder-one/,
      "the output does not give the exact command to discharge the duty",
    );
  });
});

// ─── 2 · AP4 — two concurrent activations ────────────────────────────────────

test("AP4 · two concurrent activations do NOT both take the same ordinal", async () => {
  // ⚠️ DRIVEN IN-PROCESS, AND THAT IS THE WHOLE POINT OF THE ROW. Two CLI
  // SUBPROCESSES cannot be made to overlap: `Promise.all` over two spawns only
  // guarantees both are started, and if the first finishes before the second reads the
  // seat row, the second is a perfectly legitimate SECOND SUCCESSION
  // (holder-two → holder-three) which correctly exits 0. My first version of this row
  // did exactly that and read `[0,0]` — it was measuring sequential successions, not a
  // race, and would have gone green against a verb with NO compare-and-swap at all.
  // In-process, both calls share one event loop: both complete phase 0 against the same
  // pre-state before either reaches phase 2, which is the interleaving the CAS exists
  // for.
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", { holderActive: true, holderOrdinal: 1 });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    await seedHolder(homeDir, "holder-three", { holderActive: false });
    await seedSeat(homeDir);

    const { activateSeatHolder, SeatActivationRefusalError } =
      await import("../src/cli/session/seat-activate.js");
    const settled = await Promise.allSettled([
      activateSeatHolder(SEAT_A, "holder-two"),
      activateSeatHolder(SEAT_A, "holder-three"),
    ]);
    const won = settled.filter((r) => r.status === "fulfilled");
    const lost = settled.filter((r) => r.status === "rejected");
    assert.equal(
      won.length,
      1,
      `exactly one activation must win — ${won.length} did. ${JSON.stringify(settled.map((r) => r.status))}`,
    );
    assert.equal(lost.length, 1, "exactly one activation must refuse");

    // 🔑 The loser must refuse on the COMPARE-AND-SWAP by name, not fail some other way
    // that happens to reject. A lost CAS is a RACE, not a divergence, and is reported as
    // its own condition.
    const reason: unknown = lost[0].reason;
    assert.ok(
      reason instanceof SeatActivationRefusalError && reason.code === "CONCURRENT_ACTIVATION",
      `the loser did not refuse on the compare-and-swap: ${String(reason)}`,
    );

    // The counter advanced EXACTLY ONCE, so no ordinal was issued twice — D4a's
    // guarantee is that a number is never RE-ISSUED.
    const store = await readSeatStore(sessionDirOf(homeDir));
    assert.equal(
      seatFromStore(store, SEAT_A)?.nextOrdinal,
      3,
      "next_ordinal advanced more than once — two activations drew from the same counter",
    );
    // …and exactly one holder ended up active on the seat row itself.
    const winner = (won[0] as PromiseFulfilledResult<{ successorId: string; ordinal: number }>)
      .value;
    assert.equal(seatFromStore(store, SEAT_A)?.activeHolderId, winner.successorId);
    assert.equal(winner.ordinal, 2, "the winner did not take next_ordinal");
  });
});

// ─── 3 · AP6 — D4's heal, and the no-op that must NOT burn an ordinal ─────────

test("AP6 · a re-run after the pointer moved HEALS, and does not re-draw the ordinal", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    // The torn state a kill between phases 2 and 3 leaves: the seat row already names
    // holder-two, holder-one is retired, and holder-two has NO ordinal and is not active.
    await seedHolder(homeDir, "holder-one", { holderActive: false, holderOrdinal: 1 });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    await seedSeat(homeDir, { activeHolderId: "holder-two", nextOrdinal: 2 });

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.outcome, "resumed", "the heal did not identify itself as a resumption");

    const successor = await readRecordJson(homeDir, "holder-two");
    assert.equal(successor.holder_active, true, "the heal did not activate the successor");
    // 🔑 D4a — GAPS ARE LEGAL, REPEATS ARE DEFECTS. The crashed run's ordinal is BURNED
    // rather than recovered: deriving it as `next_ordinal - 1` would be wrong the moment
    // any other activation interleaved.
    assert.equal(successor.holder_ordinal, 2);
    const store = await readSeatStore(sessionDirOf(homeDir));
    assert.equal(seatFromStore(store, SEAT_A)?.nextOrdinal, 3);
    // 🛑 AND THE HEAL MUST NOT HAVE COUNTED A DIVERGENCE. The torn state it repairs has
    // the seat and the mirror legitimately disagreeing; counting that would measure
    // crashes rather than the two-source ambiguity. The exclusion is structural — the
    // resumption branch never reaches the observer.
    assert.equal(payload.mirrorDivergence, null, "the heal reported a divergence");
  });
});

test("activating the holder that is ALREADY active is a no-op that burns no ordinal", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", { holderActive: true, holderOrdinal: 1 });
    await seedSeat(homeDir, { activeHolderId: "holder-one", nextOrdinal: 2 });

    const result = await activate(homeDir, SEAT_A, "holder-one");
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.outcome, "already-active");
    const store = await readSeatStore(sessionDirOf(homeDir));
    assert.equal(
      seatFromStore(store, SEAT_A)?.nextOrdinal,
      2,
      "a no-op burned an ordinal — the counter must not move when nothing happened",
    );
  });
});

// ─── 4 · D10 — the divergence line, and what must NOT produce one ────────────

test("D10 · a FALSIFIED predecessor mirror produces EXACTLY ONE divergence line", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    // The §3.4 clobber signature: the seat names holder-one active, while holder-one's
    // own mirror says otherwise — which is what a close landing on the flip produces.
    await seedHolder(homeDir, "holder-one", { holderActive: false, holderOrdinal: 1 });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    await seedSeat(homeDir, { activeHolderId: "holder-one", nextOrdinal: 2 });

    const result = await activate(homeDir);
    assert.equal(result.code, 0, `${result.stderr}${result.stdout}`);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const divergence = payload.mirrorDivergence as Record<string, unknown> | null;
    assert.ok(divergence, "a falsified mirror produced NO divergence report");
    assert.equal(divergence.seatId, SEAT_A);
    assert.equal(divergence.predecessorId, "holder-one");
    // 🔑 EXACTLY ONE, not "at least one". Exactness is what makes a future double-report
    // visible AS TWO rather than blending in.
    const lines = result.stderr
      .split("\n")
      .filter((line) => line.includes("seat-mirror-divergence"));
    assert.equal(lines.length, 1, `expected exactly one divergence line, got ${lines.length}`);
    assert.match(lines[0], /seat=aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/);
    assert.match(lines[0], /predecessor=holder-one/);
  });
});

test("D10 · a CLEAN succession reports NO divergence — the paired row", async () => {
  // 🛑 WITHOUT THIS THE ROW ABOVE CANNOT DISTINGUISH "detects divergence" from "reports
  // one on every activation". Phase 1 retires P BEFORE phase 2 reads the seat row, so a
  // comparison taken at the wrong point would fire on EVERY healthy succession — and the
  // row above would pass just as happily.
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const result = await activate(homeDir);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(
      payload.mirrorDivergence,
      null,
      "a healthy succession reported a divergence — the observation is reading the mirror " +
        "AFTER phase 1 retired it, so it is seeing a disagreement the verb itself created",
    );
    assert.equal(
      result.stderr.includes("seat-mirror-divergence"),
      false,
      "a healthy succession emitted a divergence line",
    );
  });
});

// ─── 5 · PHASE 0's REFUSALS — each paired with the positive row above ─────────

test("phase 0 · a successor that belongs to ANOTHER seat is refused — activate never re-seats", async () => {
  // PAIRED WITH: "a succession retires the predecessor…" above, which proves a successor
  // that IS in the seat succeeds. Without that pair this row could pass against a verb
  // that refuses everything.
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    await seedHolder(homeDir, "outsider", {
      holderActive: false,
      seatId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    });

    const result = await activate(homeDir, SEAT_A, "outsider");
    assert.notEqual(result.code, 0, "a session from another seat was activated");
    assert.match(`${result.stdout}${result.stderr}`, /SUCCESSOR_NOT_IN_SEAT/);
    // Nothing moved.
    const store = await readSeatStore(sessionDirOf(homeDir));
    assert.equal(seatFromStore(store, SEAT_A)?.activeHolderId, "holder-one");
    assert.equal(seatFromStore(store, SEAT_A)?.nextOrdinal, 2, "a refusal burned an ordinal");
  });
});

test("phase 0 · a CLOSED successor is refused, while an OPEN one succeeds", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const closedSuccessor = await seedHolder(homeDir, "holder-closed", {
      holderActive: false,
      closed: true,
    });
    assert.equal(closedSuccessor.closed, true, "fixture precondition");

    const refused = await activate(homeDir, SEAT_A, "holder-closed");
    assert.notEqual(refused.code, 0, "a closed session became a seat's active holder");
    assert.match(`${refused.stdout}${refused.stderr}`, /SUCCESSOR_CLOSED/);

    // PAIRED HALF, in the same test so the refusal cannot be satisfied by a verb that
    // refuses every successor: the open one still activates.
    const allowed = await activate(homeDir, SEAT_A, "holder-two");
    assert.equal(allowed.code, 0, `${allowed.stderr}${allowed.stdout}`);
  });
});

test("phase 0 · a CLOSED SEAT is refused, while a VACANT seat still accepts a holder", async () => {
  // 🔑 THE PAIR HERE IS THE POINT, because the two states are easy to conflate: a CLOSED
  // seat is abolished and takes no holders; a VACANT seat (no active holder) is a
  // first-class resting state that must still accept one. A verb that refused both
  // would pass a closed-seat row alone.
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    await seedSeat(homeDir, { activeHolderId: null, closedAt: "2026-09-28T09:00:00.000Z" });

    const refused = await activate(homeDir);
    assert.notEqual(refused.code, 0, "a closed seat accepted a holder");
    assert.match(`${refused.stdout}${refused.stderr}`, /SEAT_CLOSED/);

    // Re-open the office by clearing `closed_at`, leaving it VACANT, and the same
    // activation must now succeed.
    await withSeatStoreWrite(sessionDirOf(homeDir), (store) => {
      const row = seatFromStore(store, SEAT_A);
      assert.ok(row);
      const seats = new Map(store.seats);
      seats.set(SEAT_A, { ...row, closedAt: null });
      return { mutation: { kind: "write", seats }, result: undefined };
    });
    const allowed = await activate(homeDir);
    assert.equal(
      allowed.code,
      0,
      `a VACANT seat refused a holder — vacancy is a resting state, not an error: ${allowed.stderr}`,
    );
    const payload = JSON.parse(allowed.stdout.trim()) as Record<string, unknown>;
    assert.equal(payload.predecessorId, null, "a vacant seat reported a predecessor");
  });
});

test("phase 0 · a seat with NO ROW is refused with the cause and the remedy (AP17)", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-two", { holderActive: false });
    // No seat row planted at all.
    const result = await activate(homeDir);
    assert.notEqual(result.code, 0);
    const said = `${result.stdout}${result.stderr}`;
    assert.match(said, /SEAT_ROW_MISSING/);
    assert.match(said, /predates the seat store/i, "the refusal does not name the cause");
    assert.match(said, /backfill/i, "the refusal does not name the remedy");
  });
});

test("phase 0 · a malformed seat REFERENCE is rejected, not repaired (D8)", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    // Each is a different one of the three states D8 refuses to collapse. The uppercase
    // and leading-space forms are the ones a `trim().toLowerCase()` would let through —
    // and a value stored differently from how it was submitted is exactly what makes the
    // layers downstream disagree about whether it is absent, malformed or valid.
    for (const bad of ["   ", "not-a-uuid", SEAT_A.toUpperCase(), ` ${SEAT_A}`]) {
      const result = await activate(homeDir, bad);
      assert.notEqual(result.code, 0, `seat ref ${JSON.stringify(bad)} was accepted`);
    }
    // PAIRED HALF: the exact same seat id, unmodified, works.
    const ok = await activate(homeDir, SEAT_A);
    assert.equal(ok.code, 0, `${ok.stderr}${ok.stdout}`);
  });
});

test("phase 0 · a successor of a DIFFERENT kind is refused (B1 ruling 4)", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await seedHolder(homeDir, "holder-one", { holderActive: true, holderOrdinal: 1 });
    await seedHolder(homeDir, "holder-sub", { holderActive: false, kind: "subagent" });
    await seedSeat(homeDir);

    const result = await activate(homeDir, SEAT_A, "holder-sub");
    assert.notEqual(result.code, 0, "a subagent was activated into a session seat");
    assert.match(`${result.stdout}${result.stderr}`, /KIND_MISMATCH/);
  });
});

// ─── 6 · THE NOTICE (D6) — what it must and must not say ─────────────────────

test("D6 · the notice orients and does NOT brief, claim inherited context, or say P is closed", async () => {
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const result = await activate(homeDir);
    assert.equal(result.code, 0, result.stderr);
    const notice = String(
      (JSON.parse(result.stdout.trim()) as { activationNotice?: unknown }).activationNotice,
    );

    // The sentinel is first, on its own line, and keyed on as a STRING — never prose.
    assert.ok(notice.startsWith("⟦SEAT-ACTIVATION⟧\n"), "the sentinel is not the first line");
    // What it MUST claim.
    assert.match(notice, /active holder/i);
    assert.match(notice, /holder #2/);
    assert.match(notice, /holder-one/, "the notice does not name the predecessor");
    assert.match(notice, /retired/i);
    assert.match(notice, /arrives here/i, "the notice does not say mail now arrives here");

    // 🛑 WHAT IT MUST NOT CLAIM — the load-bearing half.
    assert.doesNotMatch(
      notice,
      /\bclosed\b/i,
      "the notice says the predecessor is CLOSED — retirement is not a close, and that duty " +
        "may be undischarged, so the notice must not assert an act that has not happened",
    );
    // ⚠️ THE ASSERTION IS ON AN AFFIRMATIVE INSTRUCTION, NOT ON THE WORD. A bare
    // /resume/ is wrong here and my first version of this row used it: the notice
    // legitimately says "Nothing is waiting for you to resume", which is the NEGATION —
    // exactly the sentence D6 wants. Forbidding the word would push the notice into
    // saying LESS about the thing it most needs to be explicit about.
    assert.doesNotMatch(
      notice,
      /\bresume (your|the|this|where)|you (can|should|may|must) resume|continue where|pick up where/i,
      "the notice INSTRUCTS the successor to resume — it is a FRESH session and carries none " +
        "of the predecessor's transcript, so this would send it looking for one it does not have",
    );
    // …and the positive half, because "does not instruct resumption" is satisfied by
    // saying nothing at all. D6 requires the notice to be EXPLICIT that there is no
    // inherited context — silence would leave the successor to assume there is.
    assert.match(
      notice,
      /no inherited context/i,
      "the notice does not state that the successor has NO inherited context",
    );
    assert.doesNotMatch(
      notice,
      /your (task|job|duties|responsibilities) (is|are)|you should now/i,
      "the notice briefs the successor — it tells it what it IS, never what to DO; a notice " +
        "that summarises duties has become the seat description Daniel struck",
    );
    assert.doesNotMatch(
      notice,
      /will be forwarded|forwarded to you|follow you/i,
      "the notice claims mail to the old address follows — it does not",
    );
  });
});

// ─── 7 · the index projection lands for BOTH records ─────────────────────────

test("both records reach the INDEX in one projection, agreeing with their records", async () => {
  // The index is what acpx-ui's hot path reads; a mirror that stopped at the record
  // would be a routing failure rather than a cosmetic one.
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    assert.equal((await activate(homeDir)).code, 0);

    const index = JSON.parse(
      await fs.readFile(path.join(sessionDirOf(homeDir), "index.json"), "utf8"),
    ) as { entries?: { acpxRecordId?: string; holderActive?: boolean; holderOrdinal?: number }[] };
    const entryFor = (id: string) => (index.entries ?? []).find((e) => e.acpxRecordId === id);
    assert.equal(entryFor("holder-one")?.holderActive, false, "the index still shows P active");
    assert.equal(entryFor("holder-two")?.holderActive, true);
    assert.equal(entryFor("holder-two")?.holderOrdinal, 2);
  });
});

// ─── 8 · the preserve and the activation, together on the real verb ──────────

test("a stale privileged write after the flip cannot revive the retired holder", async () => {
  // AP1's record half against the REAL activate verb rather than a hand-built write:
  // hold a record read BEFORE the flip (which is what `closeSession` does across its
  // drain), then write it privileged afterwards, and require the flip to survive.
  await withTempHome(async (homeDir) => {
    await seedSuccession(homeDir);
    const persistence = await import("../src/session/persistence.js");
    const stale = await resolveSessionRecord("holder-one");
    assert.equal(stale.holderActive, true, "fixture precondition");

    assert.equal((await activate(homeDir)).code, 0);

    stale.closed = true;
    stale.closedAt = new Date().toISOString();
    await persistence.writeSessionRecordAtBoundaryWithLifecycle(stale);

    const after = await readRecordJson(homeDir, "holder-one");
    assert.equal(
      after.holder_active,
      false,
      "a stale privileged write revived the retired holder — the seat now mirrors the wrong holder",
    );
    assert.equal(after.closed, true, "the close itself must still have landed");
    void writeSessionRecordAuthorizingSeatHolderWithoutIndex;
  });
});
