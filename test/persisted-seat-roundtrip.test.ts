import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  readSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
  type SessionIndexEntry,
} from "../src/session/persistence/index.js";
import {
  PERSISTED_SEAT_SENTINEL,
  type PersistedSeatFields,
} from "../src/session/persistence/persisted-seat-contract.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Brick 5ad22d5d — THE MECHANICAL GUARD for the seat/holder TOP-LEVEL record
// fields (C2). Sibling of `persisted-allowlist-roundtrip.test.ts`, same
// mechanism, scoped to `record.seatId` / `holderOrdinal` / `holderActive` /
// `parentSeatId` — see `persisted-seat-contract.ts`'s header for why this is
// a separate file rather than an extension of the `acpx.*` one.
//
// The rows below drive each transform with `PERSISTED_SEAT_SENTINEL` — which
// the COMPILER forces to carry every key of `PersistedSeatFields` — and
// assert key by key, so a field missing from a transform's allowlist reds
// the row BY NAME.

/** Every key the contract registers — the population under test, not a hand list. */
const SEAT_KEYS = Object.keys(PERSISTED_SEAT_SENTINEL) as (keyof PersistedSeatFields)[];

/** Keys projected onto the index entry — currently ALL of SEAT_KEYS.
 * `parentSeatId` joined this set so the F4 divergence-healing mechanism in
 * session-reparent.ts (which compares the record's parentSessionId against
 * the index entry's) has a parentSeatId to compare too — see its own doc
 * comment on SessionIndexEntry.parentSeatId in index.ts. */
const INDEXED_SEAT_KEYS = ["seatId", "holderOrdinal", "holderActive", "parentSeatId"] as const;

function sentinelRecord(): SessionRecord {
  return {
    ...makeSessionRecord({
      acpxRecordId: "seat-guard-1",
      acpSessionId: "acp-seat-guard-1",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace/x",
    }),
    ...structuredClone(PERSISTED_SEAT_SENTINEL),
  };
}

/** Assert per key, so the failure message names the field that was dropped. */
function assertEverySeatKeySurvived(actual: SessionRecord | undefined | null, via: string): void {
  assert.ok(actual, `${via}: the whole record is gone`);
  const missing: string[] = [];
  for (const key of SEAT_KEYS) {
    if (actual[key] === undefined) {
      missing.push(key);
      continue;
    }
    assert.deepEqual(
      actual[key],
      PERSISTED_SEAT_SENTINEL[key],
      `${via}: ${key} came back changed — a transform is rewriting it`,
    );
  }
  assert.deepEqual(
    missing,
    [],
    `${via} DROPPED ${missing.length} persisted seat field(s): ${missing.join(", ")}. ` +
      `That transform is an allowlist — add the field to it (types.ts, parse.ts, ` +
      `serialize.ts, and — for seatId/holderOrdinal/holderActive — index.ts's ` +
      `toSessionIndexEntry/parseIndexEntry too).`,
  );
}

function assertEveryIndexedSeatKeySurvived(
  actual: SessionIndexEntry | undefined,
  via: string,
): void {
  assert.ok(actual, `${via}: the whole index entry is gone`);
  const missing: string[] = [];
  for (const key of INDEXED_SEAT_KEYS) {
    if (actual[key] === undefined) {
      missing.push(key);
      continue;
    }
    assert.deepEqual(
      actual[key],
      PERSISTED_SEAT_SENTINEL[key],
      `${via}: index entry ${key} came back changed`,
    );
  }
  assert.deepEqual(
    missing,
    [],
    `${via} DROPPED index-projected seat field(s): ${missing.join(", ")}. Both legs ` +
      `required — toSessionIndexEntry AND parseIndexEntry — or a daemon rewrite of one ` +
      `entry strips the field off every OTHER entry in index.json.`,
  );
}

test("guard 1 · serialize → parse keeps every seat field", () => {
  const onDisk = JSON.parse(JSON.stringify(serializeSessionRecordForDisk(sentinelRecord())));
  assertEverySeatKeySurvived(parseSessionRecord(onDisk), "parseSessionRecord");
});

test("guard 2 · a SECOND round trip keeps them — the write-back that persists a loss", () => {
  const first = parseSessionRecord(
    JSON.parse(JSON.stringify(serializeSessionRecordForDisk(sentinelRecord()))),
  );
  assert.ok(first);
  const second = parseSessionRecord(
    JSON.parse(JSON.stringify(serializeSessionRecordForDisk(first))),
  );
  assertEverySeatKeySurvived(second, "parseSessionRecord (2nd pass)");
});

test("guard 3 · the persisted keys are snake_case (D-B1-4) — serialize does not throw", () => {
  // assertPersistedKeyPolicy (serialize.ts) throws on a non-snake_case persisted
  // key. A throw here means seat_id/holder_ordinal/holder_active/parent_seat_id
  // were spelled wrong — this row exists so that failure surfaces HERE, by name,
  // rather than as an opaque throw the first time any test happens to serialize
  // a seat-bearing record.
  assert.doesNotThrow(() => serializeSessionRecordForDisk(sentinelRecord()));
});

test("guard 4 · every seat field the index entry PROJECTS survives its own parser", async () => {
  const entry = toSessionIndexEntry(sentinelRecord(), "seat-guard-1.json");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-seat-guard-"));
  try {
    await writeSessionIndex(dir, { files: ["seat-guard-1.json"], entries: [entry] });
    const reloaded = await readSessionIndex(dir);
    const back = reloaded?.entries[0];
    assertEveryIndexedSeatKeySurvived(back, "index round trip");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("guard 5 · every seat field the RECORD carries also survives via the index-entry legs (guard 4's full population)", () => {
  // guard 4 already proves this for the fields toSessionIndexEntry projects —
  // this row is the belt: SEAT_KEYS and INDEXED_SEAT_KEYS must agree, so a
  // future field added to one without the other is caught HERE by name,
  // rather than discovered later as a silent gap in guard 4's coverage.
  assert.deepEqual(
    [...SEAT_KEYS].toSorted(),
    [...INDEXED_SEAT_KEYS].toSorted(),
    "SEAT_KEYS and INDEXED_SEAT_KEYS have diverged — every seat field is " +
      "currently expected on both the record AND the index entry (per " +
      "SessionIndexEntry.parentSeatId's doc comment in index.ts); if a NEW " +
      "seat field genuinely has no index leg, narrow INDEXED_SEAT_KEYS " +
      "deliberately and say why in persisted-seat-contract.ts's header.",
  );
});

test("guard 6 · the contract itself is non-trivial — every sentinel is DISTINCT", () => {
  const strings: string[] = Object.values<string | number | boolean>(
    PERSISTED_SEAT_SENTINEL,
  ).filter((v) => typeof v === "string");
  assert.ok(strings.length >= 2, `expected at least 2 string sentinels, found ${strings.length}`);
  assert.equal(
    new Set(strings).size,
    strings.length,
    "two string fields share a sentinel value — a transform crossing them would pass unnoticed",
  );
});

test("guard 7 · the contract covers every key of PersistedSeatFields", () => {
  // Belt for the compile-time half: `satisfies Required<PersistedSeatFields>`
  // already makes a missing key a TYPE error, so this row can only fail if
  // someone widens the Pick in persisted-seat-contract.ts. States the count so
  // a silent shrink is visible in a diff.
  assert.equal(
    SEAT_KEYS.length,
    4,
    `PersistedSeatFields has ${SEAT_KEYS.length} keys, this test expected 4. If you added ` +
      `one: give it a sentinel in persisted-seat-contract.ts, then run the rows above and ` +
      `add it to every allowlist they name. If you removed one: update this count deliberately.`,
  );
});
