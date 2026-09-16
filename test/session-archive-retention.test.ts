import assert from "node:assert/strict";
import test from "node:test";
import { projectArchiveRecord } from "../src/session/archive/record-view.js";
import {
  anchorIdFor,
  orderForApply,
  resolveBoundaries,
  retentionMtimeAnchorMs,
  staticBlockerFor,
  tierFor,
  type ArchiveCandidate,
  type PlannedArchive,
} from "../src/session/archive/retention.js";

/**
 * Cold-archive tier — the retention predicate (BRIEF §6, as corrected by
 * Amendment A3).
 *
 * ⚠️ AMENDMENT A3 IS THE REASON THIS FILE EXISTS. BRIEF §6.4 originally made age
 * an AND over `max(mtime over the WHOLE file set)` and the record field. That was
 * measured wrong off the real manifest: of wave 2's 275 not-closed ids, 170 had a
 * file newer than the cutoff — the young file being the RECORD `<id>.json` in 167
 * cases and a transcript sidecar in ZERO. The leg measured "did acpx-ui rewrite
 * this record", not "was this session used", and since records keep being
 * rewritten those ids would NEVER age out.
 *
 * So: **T1/T2/T3 have NO mtime leg. T4 has one and ONLY T4**, because an orphan
 * has no record field to read instead. The four AC-18 limbs below are the sharpest
 * statement of that split, and (b) is the anti-regression guard — it fails a build
 * that "helpfully" re-adds a transcript-mtime check for record tiers, which is the
 * most plausible way the defect returns.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const BOUNDARIES = resolveBoundaries(NOW);

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

type CandidateSpec = {
  id?: string;
  /** Absent ⇒ an ORPHAN (T4) — no record anywhere. */
  record?: Record<string, unknown>;
  /** file basename (without the id prefix) → age in ms. Omit for ordering tests. */
  files?: Record<string, number>;
};

function candidate(spec: CandidateSpec): ArchiveCandidate {
  const id = spec.id ?? "0027b16c-7b7a-4e26-a50f-381299ff59ba";
  const fileMtimes = new Map<string, number>();
  for (const [suffix, ageMs] of Object.entries(spec.files ?? {})) {
    fileMtimes.set(`${id}${suffix}`, NOW - ageMs);
  }
  const view = spec.record
    ? projectArchiveRecord({ acpx_record_id: id, ...spec.record })
    : undefined;
  return {
    id,
    safeId: id,
    files: [...fileMtimes.keys()],
    bytes: 1024,
    fileMtimes,
    // `Math.max()` of nothing is -Infinity, which would read as "touched in 1970"
    // rather than "no files" — 0 is what the scan itself produces for that case.
    newestMtimeMs: fileMtimes.size === 0 ? 0 : Math.max(...fileMtimes.values()),
    record: view,
    recordStatus: view ? "ok" : "absent",
  };
}

function planned(id: string, tier: PlannedArchive["tier"], reason: string): PlannedArchive {
  return { candidate: candidate({ id }), tier, reason };
}

// ── AC-18: the four tier-explicit limbs ─────────────────────────────────────────

test("AC-18(a) T1: the RECORD rewritten yesterday is still archived", () => {
  // The dominant real-world shape: 167 of wave 2's 170 "young" ids were young
  // only because acpx-ui rewrote `<id>.json`.
  const c = candidate({
    record: { closed: true, closed_at: iso(60 * DAY) },
    files: { ".json": 1 * DAY, ".messages.ndjson": 60 * DAY },
  });
  assert.equal(staticBlockerFor(c, BOUNDARIES), undefined);
  assert.equal(tierFor(c, BOUNDARIES, false)?.tier, "closed");
});

test("AC-18(b) T1: a TRANSCRIPT written yesterday is ALSO still archived", () => {
  // ⚠️ THE ANTI-REGRESSION GUARD. This is the case a well-meaning "but surely a
  // recent transcript means it is in use" change would break — and that change
  // reintroduces A3's defect in a narrower, far more plausible-looking form.
  // For T1-T3 there is NO content-mtime test of any kind.
  const c = candidate({
    record: { closed: true, closed_at: iso(60 * DAY) },
    files: { ".json": 60 * DAY, ".messages.ndjson": 1 * DAY },
  });
  assert.equal(staticBlockerFor(c, BOUNDARIES), undefined);
  assert.equal(tierFor(c, BOUNDARIES, false)?.tier, "closed");
  assert.equal(
    retentionMtimeAnchorMs(c),
    undefined,
    "a record tier must never consult the mtime anchor at all",
  );
});

test("AC-18(c) T4: an orphan with a young transcript is NOT archived", () => {
  // ⚠️ SAME FILE CLASS, OPPOSITE VERDICT FROM (b) — because the TIER decides which
  // clock runs. (b) and (c) together are the sharpest test of Amendment 3, and a
  // build that gets both right cannot be running one rule for both tiers.
  const c = candidate({ files: { ".messages.ndjson": 1 * DAY, ".stream.ndjson": 60 * DAY } });
  assert.equal(staticBlockerFor(c, BOUNDARIES), undefined);
  assert.equal(tierFor(c, BOUNDARIES, true), undefined, "T4's anchor IS mtime, and it is young");
});

test("AC-18(d) T4: an orphan whose only young file is `.delivery.json` IS archived", () => {
  // The delivery family is excluded from T4's anchor, so it cannot confer youth.
  // Letting it both block and confer youth would double-count one fact through
  // two mechanisms.
  const c = candidate({
    files: { ".delivery.json": 1 * DAY, ".messages.ndjson": 60 * DAY, ".stream.ndjson": 60 * DAY },
  });
  assert.equal(staticBlockerFor(c, BOUNDARIES), undefined);
  assert.equal(tierFor(c, BOUNDARIES, true)?.reason, "orphan-sidecars");
});

test("T4's anchor also excludes record-write temps — an allowlist misses these by omission", () => {
  // 49 real orphan ids carry `<id>.json.<pid>.<ts>.tmp`. They are record machinery
  // with record-like mtimes; an exclusion catches them, a transcript allowlist
  // does not.
  const c = candidate({
    files: { ".json.4242.1757000000000.tmp": 1 * DAY, ".messages.ndjson": 60 * DAY },
  });
  assert.equal(tierFor(c, BOUNDARIES, true)?.reason, "orphan-sidecars");
});

// ── the delivery carve-out, at the blocker ──────────────────────────────────────

test("delivery blocks T1-T3 on PRESENCE alone, regardless of its mtime", () => {
  const c = candidate({
    record: { closed: true, closed_at: iso(60 * DAY) },
    files: { ".json": 60 * DAY, ".delivery.json": 60 * DAY },
  });
  assert.equal(staticBlockerFor(c, BOUNDARIES)?.blocker, "active-delivery-sidecar");
});

test("delivery NEVER blocks T4 — 113 real orphans would otherwise be unarchivable forever", () => {
  // ⚠️ An orphan has no record, so nothing can ever deliver to it: a
  // `.delivery.json` there is reseeding something unresumable. Blocking on it —
  // which is what §6.3 originally said AND what the obvious code does — makes
  // those ids permanently unarchivable. This is the case where the spec text and
  // the natural implementation agree with each other and are both wrong.
  const c = candidate({ files: { ".delivery.json": 60 * DAY, ".messages.ndjson": 60 * DAY } });
  assert.equal(staticBlockerFor(c, BOUNDARIES), undefined);
  assert.equal(tierFor(c, BOUNDARIES, true)?.reason, "orphan-sidecars");
});

// ── the tiers themselves ────────────────────────────────────────────────────────

test("T3's boundary is 45 days, and wiring it to T1's 14 is caught only here", () => {
  // The not-closed histogram has a cliff: [30,45) = 47 sessions, then [45,60) =
  // 385. A not-closed session 25 days old must be KEPT.
  const young = candidate({
    record: { closed: false, last_used_at: iso(25 * DAY) },
    files: { ".json": 25 * DAY },
  });
  assert.equal(tierFor(young, BOUNDARIES, false), undefined);

  const old = candidate({
    record: { closed: false, last_used_at: iso(60 * DAY) },
    files: { ".json": 60 * DAY },
  });
  assert.equal(tierFor(old, BOUNDARIES, false)?.tier, "stale");
});

test("age comes from the RECORD's closed_at, not from an index-style lastUsedAt", () => {
  // ⚠️ `index.json` does NOT project `closed_at` — it is null even on closed:true
  // rows — so an implementation ageing off the index silently ages by
  // `lastUsedAt`. Here the two sit on OPPOSITE sides of the boundary, so the
  // substitution flips the verdict rather than merely shifting it.
  const coldCloseHotUse = candidate({
    record: { closed: true, closed_at: iso(60 * DAY), last_used_at: iso(1 * DAY) },
    files: { ".json": 60 * DAY },
  });
  assert.equal(tierFor(coldCloseHotUse, BOUNDARIES, false)?.tier, "closed");

  const hotCloseColdUse = candidate({
    record: { closed: true, closed_at: iso(1 * DAY), last_used_at: iso(60 * DAY) },
    files: { ".json": 60 * DAY },
  });
  assert.equal(tierFor(hotCloseColdUse, BOUNDARIES, false), undefined);
});

test("a record with no usable timestamp is NOT old — unknown age is not old age", () => {
  const c = candidate({ record: { closed: true }, files: { ".json": 60 * DAY } });
  assert.equal(tierFor(c, BOUNDARIES, false), undefined);
});

test("the quiet window counts EVERY file including the record — a different question from age", () => {
  // Deliberately NOT folded into the mtime anchor: "has anything touched this id
  // in the last hour" is a claim about the process, while the age anchor is a
  // claim about the user. Safe at 60 minutes where it was not at 45 days:
  // contamination costs a deferral re-evaluated next run, never a permanent one.
  const c = candidate({
    record: { closed: true, closed_at: iso(60 * DAY) },
    files: { ".json": 60 * DAY, ".stream.ndjson": 5 * 60 * 1000 },
  });
  assert.equal(staticBlockerFor(c, BOUNDARIES)?.blocker, "touched-recently");
});

test("protected classes are blocked at any age", () => {
  const base = { closed: true, closed_at: iso(60 * DAY) };
  const files = { ".json": 60 * DAY };
  const blocker = (record: Record<string, unknown>): string | undefined =>
    staticBlockerFor(candidate({ record, files }), BOUNDARIES)?.blocker;

  assert.equal(blocker({ ...base, template: { enabled: true } }), "template");
  // Soft-retracted: still `!= null`, so testing `.enabled` truthiness archives it.
  assert.equal(blocker({ ...base, template: { enabled: false } }), "template");
  assert.equal(blocker({ ...base, favorite: true }), "favorite");
});

test("an unreadable record blocks — the error path IS the guard", () => {
  // Fail closed toward preservation, inheriting acpx's prune doctrine verbatim. A
  // transient EIO must read as "possibly protected, skip", never "safe to move".
  const c: ArchiveCandidate = {
    ...candidate({ files: { ".json": 60 * DAY } }),
    recordStatus: "unreadable",
  };
  assert.equal(staticBlockerFor(c, BOUNDARIES)?.blocker, "record-unparseable");
});

test("a hostile filename blocks the whole id — refused, never escaped", () => {
  const c = candidate({
    record: { closed: true, closed_at: iso(60 * DAY) },
    files: { ".json": 60 * DAY, ".mess\tages.ndjson": 60 * DAY },
  });
  assert.equal(staticBlockerFor(c, BOUNDARIES)?.blocker, "hostile-filename");
});

test("a recently-restored id is protected — without this a restore is undone in 60 minutes", () => {
  // A restored session is still closed:true and its end-of-life anchor is the
  // manifest's immutable original, so the moment its files leave the quiet window
  // it qualifies for T1 again.
  const c = candidate({
    record: { closed: true, closed_at: iso(60 * DAY) },
    files: { ".json": 2 * DAY },
  });
  const manifest = {
    endOfLifeById: new Map(),
    lastRestoredAtById: new Map([[c.id, iso(2 * DAY)]]),
  };
  assert.equal(staticBlockerFor(c, BOUNDARIES, manifest)?.blocker, "recently-restored");
  // Outside the 7-day grace it becomes eligible again.
  const old = { endOfLifeById: new Map(), lastRestoredAtById: new Map([[c.id, iso(30 * DAY)]]) };
  assert.equal(staticBlockerFor(c, BOUNDARIES, old), undefined);
});

// ── companions ──────────────────────────────────────────────────────────────────

test("a byway's anchor resolves via `byway_parent` FIRST, then `forked_from_session_id`", () => {
  // ⚠️ In every live specimen the two fields AGREE, so production cannot
  // discriminate the order at all. Only a disagreeing pair can — and getting it
  // backwards points companion closure at the wrong parent.
  const disagreeing = projectArchiveRecord({
    acpx_record_id: "byway-1",
    kind: "byway",
    forked_from_session_id: "hot-parent",
    metadata: { byway_parent: "cold-parent" },
  });
  assert.ok(disagreeing);
  assert.equal(anchorIdFor(disagreeing), "cold-parent");

  const forkedOnly = projectArchiveRecord({
    acpx_record_id: "byway-2",
    kind: "byway",
    forked_from_session_id: "hot-parent",
  });
  assert.ok(forkedOnly);
  assert.equal(anchorIdFor(forkedOnly), "hot-parent");

  // A subagent anchors on its parent, not on a fork pointer.
  const subagent = projectArchiveRecord({
    acpx_record_id: "sub-1",
    kind: "subagent",
    parent_session_id: "parent-1",
    forked_from_session_id: "somewhere-else",
  });
  assert.ok(subagent);
  assert.equal(anchorIdFor(subagent), "parent-1");
});

test("🛑 companions are ordered BEFORE their anchor — the primary defence, not --repair", () => {
  // The anchor's DEPARTURE is what arms acpx-ui's 5-minute `sweepOrphanByways`
  // hard-delete, so it must be the last event in the group. Reverse the order and
  // a crash between the two leaves a byway hot with a vanished anchor, which is
  // destroyed within five minutes. `--repair` widens the window; only the ordering
  // closes it.
  const group = [
    planned("anchor", "closed", "closed-before-x"),
    planned("byway", "companion", "byway-of-anchor"),
  ];

  const ordered = orderForApply(group, new Map([["anchor", ["byway"]]]));
  assert.deepEqual(
    ordered.map((entry) => entry.candidate.id),
    ["byway", "anchor"],
    "the companion must be emitted first even though the anchor was listed first",
  );
});

test("companion ordering terminates on a cycle rather than recursing forever", () => {
  const group = ["a", "b"].map((id) => planned(id, "companion", `byway-of-${id}`));
  const ordered = orderForApply(
    group,
    new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]),
  );
  assert.equal(ordered.length, 2);
  assert.deepEqual(ordered.map((entry) => entry.candidate.id).toSorted(), ["a", "b"]);
});
