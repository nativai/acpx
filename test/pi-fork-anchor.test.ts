import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ForkCutUnresolvedError } from "../src/acp/claude-fork-anchor.js";
import {
  PI_CUT_REFUSALS,
  type PiForkCut,
  proveLogIndexPiCut,
  resolvePiForkCutByRecord,
} from "../src/acp/pi-fork-anchor.js";
import { SourceTranscriptMissingError } from "../src/errors.js";
import {
  type Answer,
  type Fixture,
  agentText,
  agentTool,
  cutAt,
  loadFixture,
  loadFixtures,
  piFile,
  toJsonl,
  totalViolations,
  user,
  violations,
} from "./pi-cut-helpers.js";

// brick 4bf088a7 (TEST-PLAN §2.1, lane A) — the proof that picks the pi entry a Pi fork keeps up to.
//
// Three kinds of evidence, none of them a hand-written positive alone:
//   1. DERIVED FIXTURES of real records (`scripts/derive-pi-cut-fixture.mjs`): each fixture stores the
//      answers the REAL record gave on every cut, and the deriver refused to write a record whose
//      derived copy answered differently — so "derived == real" is re-proved here, forever, without a
//      raw record in git. The real records themselves run in `pi-cut-real-records.integration.ts`.
//   2. An INDEPENDENT checker (`pi-cut-helpers.ts`, shares no code with the proof) over every cut.
//   3. Hand-built shapes, one negative per named refusal.

function prove(fixture: Fixture, n: number, entries = fixture.entries, pi = fixture.pi): PiForkCut {
  return resolvePiForkCutByRecord(toJsonl(pi), cutAt(fixture, n, entries));
}

function proveOrRefusal(fixture: Fixture, n: number): Answer {
  try {
    const cut = prove(fixture, n);
    return {
      n,
      entryId: cut.entryId,
      line: cut.line,
      ...(cut.contextEndLogIndex === undefined
        ? {}
        : { contextEndLogIndex: cut.contextEndLogIndex }),
    };
  } catch (error) {
    assert.ok(error instanceof ForkCutUnresolvedError, String(error));
    return { n, refused: (JSON.parse(error.message) as { reason: string }).reason };
  }
}

const withoutIndexLine = ({ indexCutLine: _ignored, ...answer }: Answer): Answer => answer;

function refusalOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ForkCutUnresolvedError, `a coded refusal, got ${String(error)}`);
    assert.equal(error.detailCode, "FORK_CUT_UNRESOLVED");
    assert.equal(error.stderrLine, error.message, "the message IS the stderr JSON line");
    return (JSON.parse(error.message) as { reason: string }).reason;
  }
  return assert.fail("expected a FORK_CUT_UNRESOLVED refusal, the proof resolved a cut");
}

// ── A1: every cut of every derived real record ────────────────────────────────────────────────

const FIXTURES = loadFixtures();
const COMMITTED_IDS = [
  "01a0875c",
  "01a09f26",
  "01a09f31",
  "01a0a55f",
  "01a11764",
  "565eff19",
  "59f799ee",
  "907cc57e",
  "cf704e76",
];

test("A1: the fixture set is the committed one — a partial checkout cannot shrink the denominator", () => {
  assert.deepEqual(
    FIXTURES.map((f) => f.id.slice(0, 8)),
    COMMITTED_IDS,
  );
  const cuts = FIXTURES.reduce((sum, f) => sum + f.answers.length, 0);
  assert.equal(cuts, 12 + 42 + 6 + 44 + 6 + 66 + 22 + 4 + 4, "cuts evaluated across the fixtures");
});

test("A1: EVERY cut of every derived record gives the answer the REAL record gave (entry, line, context end, refusal)", () => {
  let evaluated = 0;
  for (const fixture of FIXTURES) {
    for (const expected of fixture.answers) {
      assert.deepEqual(
        proveOrRefusal(fixture, expected.n),
        withoutIndexLine(expected),
        `${fixture.id.slice(0, 8)} n=${expected.n}`,
      );
      evaluated += 1;
    }
  }
  assert.equal(evaluated, 206);
});

test("A1 safety: on every resolved cut the independent checker finds nothing later and nothing missing", () => {
  let resolved = 0;
  let short = 0;
  for (const fixture of FIXTURES) {
    for (const answer of fixture.answers.filter((a) => a.line !== undefined)) {
      const found = violations(fixture, answer.n, answer.line as number, answer.contextEndLogIndex);
      assert.equal(
        totalViolations(found),
        0,
        `${fixture.id.slice(0, 8)} n=${answer.n}: ${JSON.stringify(found)}`,
      );
      resolved += 1;
      short += answer.contextEndLogIndex === undefined ? 0 : 1;
    }
  }
  assert.equal(resolved, 206, "no committed cut is a refusal");
  assert.equal(
    short,
    6,
    "the shortfalls: steers that pi delivered after tool work acpx files later",
  );
});

test("A1 positive control: the same checker FINDS the defect in today's index cut (the steered cuts leak)", () => {
  // The checker is not vacuous: run on the line pi-acp's `forkAtMessageIndex = n` ends at, it flags
  // the cuts the incident is about, and 0 of them on the proof's own line.
  const leaking = new Map<string, number[]>();
  for (const fixture of FIXTURES) {
    for (const answer of fixture.answers) {
      const atIndexLine = violations(fixture, answer.n, answer.indexCutLine as number);
      if (atIndexLine.a + atIndexLine.b > 0) {
        leaking.set(fixture.id.slice(0, 8), [
          ...(leaking.get(fixture.id.slice(0, 8)) ?? []),
          answer.n,
        ]);
      }
    }
  }
  assert.deepEqual(
    leaking.get("59f799ee"),
    [18, 19, 20, 21],
    "the steered stretch of the incident record",
  );
  assert.ok([...leaking.values()].flat().length >= 4);
  assert.equal(leaking.has("565eff19"), false, "an aligned control never leaks");
  assert.equal(leaking.has("cf704e76"), false);
  assert.equal(leaking.has("907cc57e"), false);
});

// ── A2–A5: the incident record, cut by cut ────────────────────────────────────────────────────

const INCIDENT = loadFixture("59f799ee");
const answerFor = (fixture: Fixture, n: number): Answer =>
  fixture.answers.find((a) => a.n === n) as Answer;

test("A2: a cut before a steer (n=18) forks after the last tool result before it, NOT at the steer today's index lands on", () => {
  const cut = prove(INCIDENT, 18);
  assert.deepEqual(
    { entryId: cut.entryId, line: cut.line, contextEndLogIndex: cut.contextEndLogIndex },
    { entryId: "3def8d5c", line: 79, contextEndLogIndex: undefined },
  );
  assert.equal(
    answerFor(INCIDENT, 18).indexCutLine,
    83,
    "today's index lands on the steer itself (L83)",
  );
});

test("A3: right after the steer (n=19) the fork still ends before it, and says where the agent's context ends", () => {
  const cut = prove(INCIDENT, 19);
  assert.equal(cut.entryId, "3def8d5c");
  assert.equal(
    cut.contextEndLogIndex,
    18,
    "pi delivered the steer after tool work acpx files after the cut",
  );
});

test("A4: n=20 and n=21 fork after the reply entries, with no context end", () => {
  assert.deepEqual(
    [20, 21].map((n) => {
      const cut = prove(INCIDENT, n);
      return [cut.entryId, cut.line, cut.contextEndLogIndex];
    }),
    [
      ["25098512", 100, undefined],
      ["aece0a2c", 101, undefined],
    ],
  );
});

test("A5: the aligned stretch (n=16, n=17) forks at exactly the lines today's index gives", () => {
  for (const [n, entryId, line] of [
    [16, "dd600183", 71],
    [17, "b4679f6b", 72],
  ] as const) {
    const cut = prove(INCIDENT, n);
    assert.deepEqual([cut.entryId, cut.line], [entryId, line], `n=${n}`);
    assert.equal(answerFor(INCIDENT, n).indexCutLine, line, `the index agrees at n=${n}`);
  }
});

test("the shortfall is the FIRST missing entry, not the last present one", () => {
  // n=19: the steer (entry 18) is missing from the fork, but entries AFTER it (the tool results
  // acpx files later) are present. A 'last present entry' rule would report 19 and hide the steer.
  const cut = prove(INCIDENT, 19);
  assert.equal(cut.contextEndLogIndex, 18);
  assert.notEqual(cut.contextEndLogIndex, 19);
});

// ── the other real shapes ─────────────────────────────────────────────────────────────────────

test("A6: a repeated user text is placed by ORDINAL, only while the record's deliveries equal pi's records", () => {
  const fixture = loadFixture("01a0a55f"); // a short user text delivered more than once
  const texts = fixture.entries.map((entry) =>
    entry !== "Resume" && "User" in entry
      ? (entry.User.content[0] as { Text: string }).Text
      : undefined,
  );
  const repeated = texts.find((t, i) => t !== undefined && texts.indexOf(t) !== i);
  assert.ok(repeated, "the record repeats a user text");
  const at = texts.flatMap((t, i) => (t === repeated ? [i] : []));
  assert.ok(at.length >= 3, `delivered ${at.length}x`);
  for (const i of at) {
    assert.equal(
      proveOrRefusal(fixture, i + 2).refused,
      undefined,
      `n=${i + 2} resolves by ordinal`,
    );
  }
  // NEGATIVE: drop one pi record carrying that text → deliveries ≠ pi records → the same cuts refuse R3.
  const victim = fixture.pi.find(
    (l) =>
      typeof l !== "string" && JSON.stringify(l.message ?? "").includes(`"text":"${repeated}"`),
  ) as { id: string };
  assert.ok(victim, "pi carries the repeated text as a user record");
  const shortened = dropPiEntry(fixture.pi, victim);
  const reasons = at.map((i) => {
    try {
      prove(fixture, i + 2, fixture.entries, shortened);
      return "resolved";
    } catch (error) {
      return error instanceof ForkCutUnresolvedError ? error.message : String(error);
    }
  });
  assert.ok(
    reasons.some((m) =>
      m.includes(`${at.length} deliveries in the record but ${at.length - 1} pi user records`),
    ),
    `a count mismatch refuses: ${JSON.stringify(reasons)}`,
  );
});

/** A pi file without one entry: its children now hang off its parent (the chain stays whole). */
function dropPiEntry(pi: Fixture["pi"], victim: { id: string }): Fixture["pi"] {
  const entry = pi.find((l) => typeof l !== "string" && l.id === victim.id) as {
    parentId: string | null;
  };
  const kept = structuredClone(pi).filter((l) => typeof l === "string" || l.id !== victim.id);
  for (const l of kept) {
    if (typeof l !== "string" && l.parentId === victim.id) {
      l.parentId = entry.parentId;
    }
  }
  return kept;
}

test("A10: a killed turn (a tool call pi never answered, L477) does not freeze the cut before it", () => {
  const fixture = loadFixture("01a09f26");
  const dangling = findDanglingCall(fixture);
  assert.equal(dangling?.line, 477, "the record carries a toolCall pi never answered at L477");
  const cuts = fixture.answers.filter((a) => a.n >= 8 && a.n <= 14);
  assert.equal(cuts.length, 7);
  // X sits ON the unanswered call (n=8) and moves past it for every later cut — never held at L476.
  assert.deepEqual(
    cuts.map((a) => proveOrRefusal(fixture, a.n).line),
    [477, 478, 487, 488, 489, 490, 491],
  );
});

function findDanglingCall(fixture: Fixture): { line: number } | undefined {
  const answered = new Set<string>();
  const calls: { id: string; line: number }[] = [];
  fixture.pi.forEach((l, i) => {
    if (typeof l === "string") {
      return;
    }
    const message = l.message as
      | { role?: string; toolCallId?: string; content?: { type?: string; id?: string }[] }
      | undefined;
    if (message?.toolCallId) {
      answered.add(message.toolCallId);
    }
    for (const part of message?.content ?? []) {
      if (part.type === "toolCall" && part.id) {
        calls.push({ id: part.id, line: i + 1 });
      }
    }
  });
  return calls.find((c) => !answered.has(c.id));
}

test("A9 / failed delivery + batch (01a0875c): every cut resolves; none reports a shortfall for a never-delivered entry", () => {
  const fixture = loadFixture("01a0875c");
  for (const answer of fixture.answers) {
    assert.equal(proveOrRefusal(fixture, answer.n).refused, undefined, `n=${answer.n}`);
  }
});

test("a trimmed first message (01a09f26, 8,000 chars) still anchors: the first cuts resolve", () => {
  const fixture = loadFixture("01a09f26");
  const first = fixture.entries[0];
  assert.ok(first !== "Resume" && "User" in first);
  const text = (first.User.content[0] as { Text: string }).Text;
  assert.equal(text.length, 8000);
  assert.ok(text.endsWith("..."), "acpx stored it trimmed");
  assert.equal(proveOrRefusal(fixture, 1).refused, undefined);
});

// ── the named refusals (one negative each; hand-built, the smallest input that triggers it) ───

const reasonOf = (
  entries: ReturnType<typeof user>[],
  afterEntries: ReturnType<typeof user>[],
  pi: string,
) =>
  refusalOf(() =>
    resolvePiForkCutByRecord(pi, {
      atLogIndex: entries.length,
      window: entries,
      before: entries,
      after: afterEntries,
    }),
  );

test("R1: no user message of the window can be placed in pi's file", () => {
  assert.equal(
    reasonOf([user("u1", "hello world")], [], piFile([{ user: "something else entirely" }])),
    PI_CUT_REFUSALS.noUserPlaced,
  );
});

test("R2: a user message that pi never received, followed by a reply, cannot be placed", () => {
  const before = [user("u1", "never delivered"), agentText("a reply that exists")];
  assert.equal(
    reasonOf(before, [], piFile([{ user: "different" }, { assistant: "x" }])),
    PI_CUT_REFUSALS.userNotPlaced,
  );
});

test("R3: the anchoring text is more deliveries in the record than pi user records", () => {
  const before = [user("u1", "go on"), agentText("first"), user("u2", "go on")];
  assert.equal(
    reasonOf(before, [], piFile([{ user: "go on" }, { assistant: "first" }])),
    PI_CUT_REFUSALS.anchorCount(2, 1),
  );
});

test("R4: the user message before the anchor differs between the record and pi's file", () => {
  const before = [user("u1", "alpha question"), agentText("a1"), user("u2", "beta question")];
  assert.equal(
    reasonOf(
      before,
      [],
      piFile([{ user: "gamma question" }, { assistant: "a1" }, { user: "beta question" }]),
    ),
    PI_CUT_REFUSALS.previousUserDiffers,
  );
});

test("R5: a reply cut whose anchor lies after an entry only the parent's later entries carry", () => {
  const before = [user("u1", "first question"), agentText("the reply")];
  const after = [agentTool("only-later")];
  const pi = piFile([
    { call: "only-later" },
    { user: "first question" },
    { assistant: "the reply" },
  ]);
  assert.equal(
    refusalOf(() => resolvePiForkCutByRecord(pi, { atLogIndex: 2, window: before, before, after })),
    PI_CUT_REFUSALS.replyNotProven,
  );
});

test("R6: nothing in pi's file can be kept — every entry before the cut separates a tool call from its result", () => {
  const before = [user("u1", "the question")];
  const pi = piFile([{ call: "c1" }, { user: "the question" }, { result: "c1" }]);
  assert.equal(
    refusalOf(() =>
      resolvePiForkCutByRecord(pi, { atLogIndex: 1, window: before, before, after: [] }),
    ),
    PI_CUT_REFUSALS.nothingPrecedes,
  );
});

test("R7: a pi entry whose parent is missing refuses; so does a parent cycle", () => {
  const before = [user("u1", "the question")];
  const cut = { atLogIndex: 1, window: before, before, after: [] };
  const orphan = piFile([
    {
      raw: {
        type: "message",
        id: "e1",
        parentId: "ghost",
        message: { role: "user", content: [{ type: "text", text: "the question" }] },
      },
    },
  ]);
  assert.equal(
    refusalOf(() => resolvePiForkCutByRecord(orphan, cut)),
    PI_CUT_REFUSALS.brokenChain,
  );
  const message = { role: "user", content: [{ type: "text", text: "the question" }] };
  const cycle = piFile([
    { raw: { type: "message", id: "e1", parentId: "e2", message } },
    { raw: { type: "message", id: "e2", parentId: "e1", message } },
  ]);
  assert.equal(
    refusalOf(() => resolvePiForkCutByRecord(cycle, cut)),
    PI_CUT_REFUSALS.brokenChain,
  );
});

test("A15: corrupting one parentId of a REAL-shaped file refuses R7 on every cut after it", () => {
  const fixture = INCIDENT;
  const broken = fixture.pi.map((l, i) =>
    typeof l !== "string" && i === 40 ? { ...l, parentId: "deadbeef" } : l,
  );
  assert.ok(typeof fixture.pi[40] !== "string", "line 41 is an entry");
  // the leaf chain no longer reaches the root: the path is unreadable for EVERY cut
  const reasons = [10, 18, 22].map((n) =>
    refusalOf(() => prove(fixture, n, fixture.entries, broken)),
  );
  assert.deepEqual(new Set(reasons), new Set([PI_CUT_REFUSALS.brokenChain]));
});

// ── the shapes the incident is made of, small enough to read ──────────────────────────────────

// The incident, minimal: acpx files the steer (u2) at SEND time, right after the turn's first Agent entry;
// pi delivers it only after the running step's NEXT tool work (t2), so the two files disagree on order.
const STEER_HISTORY = [
  user("u1", "start the long job"), // 0
  agentTool("t1", "running the first step"), // 1  closed by the steer
  user("u2", "also remember CHARLIE"), // 2  the steer, filed at SEND time
  agentTool("t2", "second step, done after the steer arrived"), // 3  the work pi did BEFORE injecting it
  agentText("finished, and noted CHARLIE"), // 4
];
const STEER_PI = piFile([
  { user: "start the long job" }, // e1
  { call: "t1", text: "running the first step" }, // e2
  { result: "t1" }, // e3
  { call: "t2", text: "second step, done after the steer arrived" }, // e4
  { result: "t2" }, // e5
  { user: "also remember CHARLIE" }, // e6  pi filed the steer AFTER t2's result
  { assistant: "finished, and noted CHARLIE" }, // e7
]);

const steerCut = (n: number) =>
  resolvePiForkCutByRecord(STEER_PI, {
    atLogIndex: n,
    window: STEER_HISTORY.slice(0, n),
    before: STEER_HISTORY.slice(0, n),
    after: STEER_HISTORY.slice(n),
  });

test("a cut BEFORE a mid-turn steer keeps exactly what the copy has and nothing later (the incident, minimal)", () => {
  const cut = steerCut(2);
  assert.equal(cut.entryId, "e3", "the tool result that closes the first step");
  assert.equal(cut.contextEndLogIndex, undefined);
  // today's rule — keep through the 2nd client-visible record (a user, or an assistant record with no
  // tool call) — ends at e6, the steer: the defect this lane removes.
  const visible = ["e1", "e6", "e7"];
  assert.equal(visible[2 - 1], "e6");
  assert.notEqual(cut.entryId, visible[2 - 1]);
});

test("a cut right after the steer forks BEFORE it and reports where the agent's context ends", () => {
  const cut = steerCut(3);
  assert.equal(
    cut.entryId,
    "e3",
    "the steer's record in pi comes after t2, which the copy does not have yet",
  );
  assert.equal(cut.contextEndLogIndex, 2, "the steer (entry 2) is not in the fork's context");
});

test("a cut after the second step keeps the steer once pi delivered it, with no shortfall", () => {
  assert.deepEqual(
    [steerCut(4), steerCut(5)].map((cut) => [cut.entryId, cut.contextEndLogIndex]),
    [
      ["e6", undefined],
      ["e7", undefined],
    ],
  );
});

test("a long text carried only as a TRIMMED prefix (8,000 chars ending '...') still matches pi's full text", () => {
  const full = `${Array.from({ length: 1700 }, (_, i) => `w${i}x`).join(" ")} END`; // > 8,000 chars, no period
  const stored = `${full.slice(0, 7997)}...`;
  assert.equal(stored.length, 8000);
  assert.ok(full.length > 8000);
  const before = [user("u1", stored), agentText("ok")];
  const pi = piFile([{ user: full }, { assistant: "ok" }]);
  const cut = resolvePiForkCutByRecord(pi, { atLogIndex: 2, window: before, before, after: [] });
  assert.equal(cut.entryId, "e2");
  // NEGATIVE: a text that differs inside the stored prefix is not found
  const other = piFile([{ user: `${full.slice(0, 100)}X${full.slice(101)}` }, { assistant: "ok" }]);
  assert.equal(
    refusalOf(() =>
      resolvePiForkCutByRecord(other, { atLogIndex: 2, window: before, before, after: [] }),
    ),
    PI_CUT_REFUSALS.userNotPlaced,
  );
});

test("whitespace is ignored on both sides: pi joins prompt blocks with no separator", () => {
  const before = [user("u1", "first part\n\nsecond   part"), agentText("fine")];
  const cut = resolvePiForkCutByRecord(
    piFile([{ user: "first partsecond part" }, { assistant: "fine" }]),
    {
      atLogIndex: 2,
      window: before,
      before,
      after: [],
    },
  );
  assert.equal(cut.entryId, "e2");
});

// ── A12, A13, A14: a source that is running, missing, or shorter than its record ──────────────

test("A12: a RUNNING source — the pi tail holds tool records the record's checkpoint has not caught up with — stops before them", () => {
  const before = [user("u1", "do the long thing"), agentTool("t1", "step one")];
  const pi = piFile([
    { user: "do the long thing" },
    { call: "t1", text: "step one" },
    { result: "t1" },
    { call: "t2", text: "step two, not yet in the record" },
    { result: "t2" },
  ]);
  const cut = resolvePiForkCutByRecord(pi, { atLogIndex: 2, window: before, before, after: [] });
  assert.equal(cut.entryId, "e3", "the first step's result: the unaccounted records are not kept");
});

test("A13: a source whose pi file is nowhere on the box is SOURCE_TRANSCRIPT_MISSING, before any adapter is asked", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-pi-missing-"));
  await assert.rejects(
    proveLogIndexPiCut({
      cwd: "/workspace",
      acpSessionId: "no-such-session",
      env: { ...process.env, ACPX_PI_BOX_AGENT_DIR: empty, HOME: empty },
      cut: cutAt(INCIDENT, 18),
    }),
    (error: Error & { detailCode?: string }) =>
      error instanceof SourceTranscriptMissingError &&
      error.detailCode === "SOURCE_TRANSCRIPT_MISSING",
  );
  fs.rmSync(empty, { recursive: true });
});

test("A14: a pi file SHORTER than the record never yields a cut beyond what it holds", () => {
  const upTo = 79; // the last line of the first part of the incident record
  const shortened = INCIDENT.pi.slice(0, upTo);
  for (const n of [18, 19, 20, 21, 22]) {
    try {
      const cut = prove(INCIDENT, n, INCIDENT.entries, shortened);
      assert.ok(cut.line <= upTo, `n=${n} cut at L${cut.line} beyond the file's ${upTo} lines`);
    } catch (error) {
      assert.ok(error instanceof ForkCutUnresolvedError, `n=${n}: ${String(error)}`);
    }
  }
  // and NEGATIVE: the tail really is needed — the full file resolves n=22 at L114
  assert.equal(prove(INCIDENT, 22).line, 114);
  assert.ok(
    refusalOf(() => prove(INCIDENT, 22, INCIDENT.entries, shortened)).length > 0,
    "the last user message of the record is not in the shortened file",
  );
});

test("a half-written last line of pi's file is skipped, as pi skips it", () => {
  const withTorn = `${toJsonl(INCIDENT.pi)}\n{"type":"message","id":"zz`;
  const cut = resolvePiForkCutByRecord(withTorn, cutAt(INCIDENT, 18));
  assert.equal(cut.entryId, "3def8d5c");
});
