import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  persistSessionOptions,
  SESSION_OPTION_BREADCRUMB_KEYS,
} from "../src/runtime/engine/session-options.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  readSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
import { PERSISTED_ACPX_SENTINEL } from "../src/session/persistence/persisted-acpx-contract.js";
import type { SessionAcpxState, SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Brick 576d8090 — THE MECHANICAL GUARD against the persistence allowlist family.
//
// 🛑 FOUR PERSISTED FIELDS HAVE BEEN SILENTLY DROPPED BY THESE TRANSFORMS, EVERY
// ONE FOUND IN PRODUCTION AND NONE BY THIS SUITE:
//
//   applied_output_style  (874fee67)   served (07dd62c9)
//   depth_projection      (B3)         last_turn_provider (4c272cab PM-1)
//
// The reason a write-only test cannot see it: `serializeSessionRecordForDisk`
// passes `acpx` through WHOLESALE, while every READER rebuilds it key by key. So
// the writer's own object round-trips in memory and passes, and in production the
// next reader drops the field and the next writer persists the loss. **Writes are
// total; reads are allowlists.**
//
// The rows below drive each transform with `PERSISTED_ACPX_SENTINEL` — which the
// COMPILER forces to carry every key of `SessionAcpxState` — and assert key by
// key, so a field missing from an allowlist reds the row BY NAME.
//
// WHICH GUARD WOULD HAVE CAUGHT WHICH LOSS:
//   applied_output_style  → row 1 (parse) — it was the parse leg that was missing
//   served                → rows 1 and 2 (parse + clone)
//   depth_projection      → rows 1, 2 and 4 (parse, clone, index projection)
//   last_turn_provider    → row 1 (parse) — exactly the leg PM-1 found missing
// All four are `acpx.*` fields, so all four are covered by row 1 alone; rows 2–5
// exist because a field can be present in parse and dropped by a sibling
// transform, which is how `served` and `depth_projection` were lost.

/** Every key the contract registers — the population under test, not a hand list. */
const ACPX_KEYS = Object.keys(PERSISTED_ACPX_SENTINEL) as (keyof SessionAcpxState)[];

function sentinelRecord(): SessionRecord {
  return {
    ...makeSessionRecord({
      acpxRecordId: "allowlist-guard-1",
      acpSessionId: "acp-allowlist-guard-1",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace/x",
    }),
    acpx: structuredClone(PERSISTED_ACPX_SENTINEL) as SessionAcpxState,
  };
}

/**
 * Keys a given transform is ALLOWED to drop — each with the reason it is not a
 * defect.
 *
 * ⚠️ **AN EXEMPTION IS A DECISION, NOT A SHRUG.** Anything listed here is a field
 * whose absence after that transform is CORRECT; if you find yourself adding one
 * to make a red go away, you are re-creating the bug this file exists to catch.
 * The rows below also assert that every exemption is still USED, so an exemption
 * that stops being true is itself a failure rather than quiet dead weight.
 */
const EXEMPT: Record<string, Partial<Record<keyof SessionAcpxState, string>>> = {
  parseSessionRecord: {
    progress:
      "LIVE turn state (phase thinking/responding, token counts). Restoring it from " +
      "disk would assert a session is mid-turn when nothing is running — it is " +
      "deliberately not round-tripped, and it IS carried by the in-memory clone.",
  },
};

/** Assert per key, so the failure message names the field that was dropped. */
function assertEveryKeySurvived(actual: SessionAcpxState | undefined, via: string): void {
  assert.ok(actual, `${via}: the whole acpx block is gone`);
  const exempt = EXEMPT[via] ?? {};
  const staleExemptions: string[] = [];
  const missing: string[] = [];
  for (const key of ACPX_KEYS) {
    if (exempt[key] !== undefined) {
      if (actual[key] !== undefined) {
        staleExemptions.push(key);
      }
      continue;
    }
    if (actual[key] === undefined) {
      missing.push(key);
      continue;
    }
    assert.deepEqual(
      actual[key],
      PERSISTED_ACPX_SENTINEL[key],
      `${via}: acpx.${key} came back changed — a transform is rewriting it`,
    );
  }
  assert.deepEqual(
    staleExemptions,
    [],
    `${via}: field(s) ${staleExemptions.join(", ")} now survive but are still listed as ` +
      `EXEMPT. Remove the exemption — a stale one hides a real regression later.`,
  );
  assert.deepEqual(
    missing,
    [],
    `${via} DROPPED ${missing.length} persisted field(s): ${missing.join(", ")}. ` +
      `That transform is an allowlist — add the field to it. This is the defect that ` +
      `has cost four fields (applied_output_style, served, depth_projection, last_turn_provider).`,
  );
}

test("guard 1 · serialize → parse keeps every acpx.* field (the leg that lost all four)", () => {
  const onDisk = JSON.parse(JSON.stringify(serializeSessionRecordForDisk(sentinelRecord())));
  assertEveryKeySurvived(parseSessionRecord(onDisk)?.acpx, "parseSessionRecord");
});

test("guard 2 · a SECOND round trip keeps them — the write-back that persists a loss", () => {
  // One pass can hide the defect: the loss becomes permanent only when a reader's
  // record goes back to a writer, which is exactly what every daemon write does.
  const first = parseSessionRecord(
    JSON.parse(JSON.stringify(serializeSessionRecordForDisk(sentinelRecord()))),
  );
  assert.ok(first);
  const second = parseSessionRecord(
    JSON.parse(JSON.stringify(serializeSessionRecordForDisk(first))),
  );
  assertEveryKeySurvived(second?.acpx, "parseSessionRecord");
});

test("guard 3 · cloneSessionAcpxState keeps every acpx.* field (the turn path)", () => {
  // The turn path re-bases `record.acpx` off this clone, so a field missing here
  // is present at `sessions new` and NULL AFTER ONE PROMPT — with the whole suite
  // green, because no in-memory test takes that leg.
  assertEveryKeySurvived(
    cloneSessionAcpxState(structuredClone(PERSISTED_ACPX_SENTINEL) as SessionAcpxState),
    "cloneSessionAcpxState",
  );
});

test("guard 4 · persistSessionOptions keeps every declared BREADCRUMB (the respawn leg)", () => {
  // ⚠️ SCOPED TO BREADCRUMBS, AND THE FIRST VERSION OF THIS ROW WAS WRONG.
  // `persistSessionOptions` REBUILDS session_options from the agent options it is
  // handed, so `allowed_tools`/`max_turns`/`system_prompt`/`subscription`/`profile`
  // legitimately disappear when the caller does not supply them — that is the
  // function's contract, not a loss. What it must NEVER drop is a BREADCRUMB: a
  // record-only fact no caller supplies, which is exactly what would be erased by
  // the next spawn.
  //
  // The subject list is READ FROM `SESSION_OPTION_BREADCRUMB_KEYS`, which the
  // compiler forces to cover `keyof SessionOptionBreadcrumbs` — so a new
  // breadcrumb joins this row automatically. A hand list here is what the whole
  // brick exists to replace.
  const record = sentinelRecord();
  persistSessionOptions(record, { model: "sentinel-option-model" });
  const after = record.acpx?.session_options;
  assert.ok(after);

  const persistedKeys = Object.values(SESSION_OPTION_BREADCRUMB_KEYS);
  const dropped = persistedKeys.filter((key) => after[key] === undefined);
  assert.deepEqual(
    dropped,
    [],
    `persistSessionOptions DROPPED breadcrumb(s): ${dropped.join(", ")}. ` +
      `Add them to sessionOptionBreadcrumbs AND assignBreadcrumbs — both legs — or ` +
      `the next spawn erases them.`,
  );
});

test("guard 5 · every field the index entry PROJECTS survives its own parser", async () => {
  // The index entry is deliberately PARTIAL — it is a hot-path projection, not a
  // copy — so the property is not "every acpx field appears" but "nothing the
  // projection emits is stripped when the daemon reads the index back". A field
  // missing from `parseIndexEntry` is stripped off EVERY entry on the next
  // rewrite, which is the brick://874fee67 both-legs rule.
  const entry = toSessionIndexEntry(sentinelRecord(), "allowlist-guard-1.json");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-allowlist-guard-"));
  try {
    await writeSessionIndex(dir, { files: ["allowlist-guard-1.json"], entries: [entry] });
    const reloaded = await readSessionIndex(dir);
    const back = reloaded?.entries[0];
    assert.ok(back, "the index must reload");

    const stripped = Object.entries(entry)
      .filter(([, value]) => value !== undefined)
      .filter(([key]) => back[key as keyof typeof back] === undefined)
      .map(([key]) => key);
    assert.deepEqual(
      stripped,
      [],
      `the index parser STRIPPED projected field(s): ${stripped.join(", ")}. ` +
        `Both legs are required — projection AND parseIndexEntry — or a daemon rewrite ` +
        `of one entry strips the field off all the others.`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("guard 6 · the contract itself is non-trivial — every sentinel is DISTINCT", () => {
  // An equality guard over identical placeholders passes on a crossed wire: a
  // transform that copied `served.model` into `current_model_id` would be
  // invisible. This row is the guard on the guard.
  const strings = JSON.stringify(PERSISTED_ACPX_SENTINEL).match(/"sentinel-[^"]+"/g) ?? [];
  assert.ok(strings.length > 20, `expected many sentinels, found ${strings.length}`);
  assert.equal(
    new Set(strings).size,
    strings.length,
    "two fields share a sentinel value — a transform crossing them would pass unnoticed",
  );
});

test("guard 7 · the contract covers every key of SessionAcpxState", () => {
  // Belt for the compile-time half: `satisfies Required<SessionAcpxState>` already
  // makes a missing key a TYPE error, so this row can only fail if someone widens
  // the annotation. It states the count so a silent shrink is visible in a diff.
  assert.equal(
    ACPX_KEYS.length,
    26,
    `SessionAcpxState has ${ACPX_KEYS.length} persisted keys, the contract expected 26. ` +
      `If you added one: give it a sentinel, then run the rows above and add it to every ` +
      `allowlist they name. If you removed one: update this count deliberately.`,
  );
});
