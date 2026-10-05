import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import { toSessionIndexEntry } from "../src/session/persistence/index.js";
import { parseSessionRecord } from "../src/session/persistence/parse.js";
import { seatDisplayName } from "../src/session/seat-display-name.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

/**
 * D-NAME-HARD-MIGRATION (brick 15f4ad42, spec AMENDMENT-2026-10-05-NAME-ON-SEAT-ONLY §1/§4):
 * the NAME lives on the SEAT only. The session record has no `name`, no writer sets one, and the
 * index entry carries none. These rows hold that line; the migration itself is rowed in
 * `seat-backfill.test.ts` (N1–N5) and the outbox projection in `brick-outbox.test.ts`.
 */

// Tests run compiled from dist-test/test, so the REAL sources are two levels up.
const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

// ───────────── THE GUARD: a record/index `name` read as the session's own name ─────────────
//
// Grep-shaped, by discovery, over every file in src/. Two patterns:
//   • `legacyName` — the old in-memory carrier of the record's name — appears NOWHERE;
//   • a RECORD-ISH identifier's `.name` (or a `name` key probed on a raw object) — allowed only at
//     the sites below, each of which is NOT the session's own name, with the exact count and the
//     reason. A new hit, or a changed count, fails here and says which file.
const RECORD_NAME_READ =
  /\b(?:record|rec|raw|current|updated|source|target|resolved|loaded|persisted|fresh|canonical|session|sessionRecord|indexEntry|member|holder|parsed|payload|diskRecord|existing)\??\.name\b|\[["']name["']\]|\)\.name\b|Object\.hasOwn\([^)]*["']name["']\)/g;
const LEGACY_CARRIER = /\blegacyName\b/g;

const ALLOWED_NAME_READS: ReadonlyMap<string, { count: number; why: string }> = new Map([
  [
    "session/seat-backfill.ts",
    {
      count: 4,
      why: "the strip step: the ONE reader left of the record's on-disk `name` — raw JSON, to move it to the seat and delete it (and to list the unparseable residual)",
    },
  ],
  [
    "session/archive/record-view.ts",
    {
      count: 1,
      why: "the ARCHIVE tier (cold store) is outside the seat model and untouched (B9 discarded)",
    },
  ],
  [
    "session/archive/archive-index.ts",
    { count: 1, why: "the ARCHIVE tier's own index row, same exemption" },
  ],
  [
    "session/persistence/parse.ts",
    {
      count: 2,
      why: "a SUBAGENT REF's `name` inside a parent record (the adapter's subagent label), not a session name",
    },
  ],
  ["prompt-content.ts", { count: 2, why: "a prompt content block's `name`, not a session name" }],
  ["session/messages-log.ts", { count: 1, why: "a tool-use block's `name`" }],
  ["runtime/public/events.ts", { count: 1, why: "a content block's `name`" }],
  [
    "runtime/public/handle-state.ts",
    {
      count: 1,
      why: "the embedded runtime HANDLE's own key (the caller's sessionKey), not a record name",
    },
  ],
  ["agent-registry.ts", { count: 1, why: "an npm package.json `name`" }],
  ["models/catalogue.ts", { count: 1, why: "a model catalogue row's `name`" }],
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

async function readSources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const full of await sourceFiles(SRC_DIR)) {
    files.set(
      path.relative(SRC_DIR, full).split(path.sep).join("/"),
      await fs.readFile(full, "utf8"),
    );
  }
  return files;
}

/** Every deviation from the allowlist, as a printable line; empty when the tree is clean. */
function nameReadViolations(files: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const [file, text] of [...files].toSorted(([a], [b]) => a.localeCompare(b))) {
    const carriers = text.match(LEGACY_CARRIER)?.length ?? 0;
    if (carriers > 0) {
      violations.push(`${file}: ${carriers} × legacyName (the carrier is gone)`);
    }
    const reads = text.match(RECORD_NAME_READ)?.length ?? 0;
    const allowed = ALLOWED_NAME_READS.get(file)?.count ?? 0;
    if (reads !== allowed) {
      violations.push(`${file}: ${reads} record-ish name read(s), allowlist says ${allowed}`);
    }
  }
  for (const file of ALLOWED_NAME_READS.keys()) {
    if (!files.has(file)) {
      violations.push(`${file}: on the allowlist but not in src/ — prune the entry`);
    }
  }
  return violations;
}

test("GUARD: no record/index `name` is read as the session's own name (allowlist exact; negative control)", async () => {
  const files = await readSources();
  // The scan is alive: it sees the allowlisted sites (positive control)…
  for (const [file, { count }] of ALLOWED_NAME_READS) {
    assert.equal(
      files.get(file)?.match(RECORD_NAME_READ)?.length ?? 0,
      count,
      `the scan did not see the ${count} allowlisted read(s) in ${file}`,
    );
  }
  assert.deepEqual(nameReadViolations(files), []);
  // …and it FLAGS planted reads in a file nobody registered (negative controls, three shapes).
  for (const planted of [
    "const label = record.name;",
    'const label = parsed["name"];',
    "const label = (await load()).name;",
    "const legacy = record.legacyName;",
  ]) {
    const withIntruder = new Map(files).set("cli/session-routing.ts", planted);
    assert.notDeepEqual(nameReadViolations(withIntruder), [], `the guard missed: ${planted}`);
  }
});

// ───────────── the record, the writer and the index carry no name ─────────────

function recordFixture() {
  return makeSessionRecord({
    acpxRecordId: "ns-1",
    acpSessionId: "acp-ns-1",
    agentCommand: "node agent.js",
    cwd: "/tmp/ns",
  });
}

test("the persisted record carries no `name` key, and a `name` on disk is not parsed back", () => {
  const record = recordFixture();
  const persisted = serializeSessionRecordForDisk(record) as Record<string, unknown>;
  assert.equal(Object.hasOwn(persisted, "name"), false);
  assert.equal(Object.hasOwn(record, "name"), false);

  const aged = { ...persisted, name: "an older acpx wrote this" };
  const parsed = parseSessionRecord(aged);
  assert.ok(parsed, "an aged record still parses");
  assert.equal(Object.hasOwn(parsed, "name"), false);
  assert.equal(
    Object.hasOwn(serializeSessionRecordForDisk(parsed) as object, "name"),
    false,
    "a rewrite of an aged record carried the name forward",
  );
});

test("the index entry carries no `name`: it is projected from nothing the record has", () => {
  const entry = toSessionIndexEntry(recordFixture(), "ns-1.json") as Record<string, unknown>;
  assert.equal(Object.hasOwn(entry, "name"), false);
});

// ───────────── every display derives from the seat ─────────────

async function seedSeat(homeDir: string, seatId: string, name: string | undefined) {
  const { backfillSeatRow } = await import("../src/session/persistence/seat-store.js");
  await fs.mkdir(path.join(homeDir, ".acpx", "sessions"), { recursive: true });
  await backfillSeatRow(path.join(homeDir, ".acpx", "sessions"), {
    seatId,
    createdAt: "2026-01-01T00:00:00.000Z",
    activeHolderId: "ns-1",
    nextOrdinal: 2,
    closedAt: null,
    name,
    brickId: undefined,
    favorite: false,
  });
}

test("seatDisplayName: the seat's name, or nothing — never a record-side fallback", async () => {
  await withTempHome("acpx-name-on-seat-", async (homeDir) => {
    await seedSeat(homeDir, "seat-named", "the-seat-name");
    await seedSeat(homeDir, "seat-nameless", undefined);
    assert.equal(await seatDisplayName({ seatId: "seat-named" }), "the-seat-name");
    assert.equal(await seatDisplayName({ seatId: "seat-nameless" }), undefined);
    assert.equal(await seatDisplayName({ seatId: "seat-absent" }), undefined);
    assert.equal(await seatDisplayName({ seatId: undefined }), undefined, "seat-less ⇒ uuid8");
    // A stray record-side name is invisible to the helper by construction.
    const stray = { seatId: "seat-nameless", name: "stray" };
    assert.equal(await seatDisplayName(stray), undefined);
  });
});
