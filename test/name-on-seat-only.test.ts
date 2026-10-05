import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import { toSessionIndexEntry, writeSessionIndex } from "../src/session/persistence/index.js";
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
const RECORD_ISH =
  "record|rec|raw|current|updated|source|target|resolved|loaded|persisted|fresh|canonical|session|sessionRecord|indexEntry|entry|member|holder|parsed|payload|diskRecord|existing";
const RECORD_NAME_READ = new RegExp(
  [
    `\\b(?:${RECORD_ISH})\\??\\.name\\b`, // record.name / entry.name / entry?.name
    `\\[["']name["']\\]`, // bracket access
    `\\)\\.name\\b`, // (await load()).name
    `Object\\.hasOwn\\([^)]*["']name["']\\)`, // a raw `name` key probe
    `\\{[^}]*\\bname\\b[^}]*\\}\\s*=\\s*(?:await\\s+)?(?:${RECORD_ISH})\\b`, // const { name } = record
  ].join("|"),
  "g",
);
const LEGACY_CARRIER = /\blegacyName\b/g;

const ALLOWED_NAME_READS: ReadonlyMap<string, { count: number; why: string }> = new Map([
  [
    "session/seat-backfill.ts",
    {
      count: 4,
      why: "the strip step: the ONE reader left of the record's on-disk `name` — raw JSON, to move it to the seat and delete it (and to list the unparseable residual) — plus the index entry's current name, compared with the seat's to count what the re-projection will change",
    },
  ],
  [
    "session/persistence/index.ts",
    {
      count: 7,
      why: "the index's own plumbing: parseIndexEntry preserves the projected `name` when present (3 reads of the raw entry's key), the seat-name projection compares it (1), and three fs Dirent names in the record-file enumeration",
    },
  ],
  [
    "session/persistence/seat-store.ts",
    {
      count: 4,
      why: "the seat store's raw index patch that PROJECTS a changed seat name onto its holders' entries (the writer, not a read of a session's own name)",
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
    "cli/archive-command.ts",
    { count: 1, why: "prints an ARCHIVE index row's name, same exemption" },
  ],
  ["session/archive/operations.ts", { count: 1, why: "an fs Dirent name in the archive sweep" }],
  ["session/archive/retention.ts", { count: 2, why: "fs Dirent names in the retention sweep" }],
  [
    "session/persistence/parse.ts",
    {
      count: 2,
      why: "a SUBAGENT REF's `name` inside a parent record (the adapter's subagent label), not a session name",
    },
  ],
  [
    "prompt-content.ts",
    { count: 4, why: "a prompt content block's `name` (resource/tool blocks), not a session name" },
  ],
  ["errors.ts", { count: 1, why: "`new.target.name` — an Error subclass's own class name" }],
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
  ["models/matcher.ts", { count: 1, why: "a model row's `name`" }],
  ["config/providers.ts", { count: 2, why: "a provider entry's `name`" }],
  ["mcp-servers.ts", { count: 1, why: "an MCP server entry's `name`" }],
  ["acp/terminal-manager.ts", { count: 1, why: "an env var entry's `name`" }],
  ["acp/harness-config-dir.ts", { count: 3, why: "fs Dirent names" }],
  ["cli/output/output.ts", { count: 1, why: "a function value's `name` in a log renderer" }],
  ["cli/session/agent-folders-migrate.ts", { count: 10, why: "fs Dirent names" }],
  ["session/conversation-model.ts", { count: 1, why: "a tool entry's `name`" }],
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
    "const label = entry.name;",
    "const label = entry?.name;",
    "const label = indexEntry?.name ?? entry.title;",
    "const { name } = record;",
    "const { id, name: label } = entry;",
    "const { name } = await resolve(entry);".replace("await resolve(entry)", "entry"),
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
  const persisted = serializeSessionRecordForDisk(record);
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

test("the entry BUILT from a record carries no `name`: nothing the record has is a name", () => {
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

// ───────────── the index entry's `name` is PROJECTED FROM THE SEAT (spec §1) ─────────────

type RawEntry = Record<string, unknown>;

async function readRawIndexEntries(homeDir: string): Promise<Map<string, RawEntry>> {
  const payload = JSON.parse(
    await fs.readFile(path.join(homeDir, ".acpx", "sessions", "index.json"), "utf8"),
  ) as { entries: RawEntry[] };
  return new Map(payload.entries.map((entry) => [String(entry.file), entry]));
}

function entryFor(id: string, seatId: string | undefined, name?: string) {
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: "node agent.js",
    cwd: "/tmp/ns",
    seatId,
    holderOrdinal: seatId === undefined ? undefined : 1,
    holderActive: seatId === undefined ? undefined : true,
  });
  return { ...toSessionIndexEntry(record, `${id}.json`), ...(name === undefined ? {} : { name }) };
}

test("every index write projects the SEAT's name onto its seated entries; a seat-less entry carries none", async () => {
  await withTempHome("acpx-name-on-seat-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await seedSeat(homeDir, "seat-a", "alpha-seat");
    await seedSeat(homeDir, "seat-nameless", undefined);
    await writeSessionIndex(dir, {
      files: ["a.json", "n.json", "none.json", "orphan.json", "stale.json"],
      entries: [
        entryFor("a", "seat-a"),
        entryFor("n", "seat-nameless", "STALE"), // a nameless seat: the stale key is removed
        entryFor("none", undefined, "STALE"), // seat-less: no `name` key at all
        entryFor("orphan", "seat-without-row", "STALE"), // a seat with no row: none either
        entryFor("stale", "seat-a", "WRONG"), // a differing name is overwritten by the seat's
      ],
    });
    const entries = await readRawIndexEntries(homeDir);
    assert.equal(entries.get("a.json")?.name, "alpha-seat");
    assert.equal(entries.get("stale.json")?.name, "alpha-seat");
    for (const file of ["n.json", "none.json", "orphan.json"]) {
      assert.equal(Object.hasOwn(entries.get(file) ?? {}, "name"), false, file);
    }
  });
});

test("a seat-store write that changes a seat's name re-projects its entries (rename, mint, fill)", async () => {
  await withTempHome("acpx-name-on-seat-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    const { withSeatStoreWrite, fillSeatName } =
      await import("../src/session/persistence/seat-store.js");
    await seedSeat(homeDir, "seat-a", "before");
    await seedSeat(homeDir, "seat-b", undefined);
    await writeSessionIndex(dir, {
      files: ["a.json", "b.json"],
      entries: [entryFor("a", "seat-a"), entryFor("b", "seat-b")],
    });
    assert.equal((await readRawIndexEntries(homeDir)).get("a.json")?.name, "before");

    await withSeatStoreWrite(dir, (store) => {
      const row = store.seats.get("seat-a");
      assert.ok(row);
      return {
        mutation: {
          kind: "write" as const,
          seats: new Map(store.seats).set("seat-a", { ...row, name: "after" }),
        },
        result: undefined,
      };
    });
    assert.equal((await readRawIndexEntries(homeDir)).get("a.json")?.name, "after", "rename");

    assert.equal(await fillSeatName(dir, "seat-b", "filled"), "filled");
    assert.equal((await readRawIndexEntries(homeDir)).get("b.json")?.name, "filled", "fill");
    assert.equal((await readRawIndexEntries(homeDir)).get("a.json")?.name, "after", "untouched");
  });
});

test("an unreadable seat store leaves the index's names exactly as they stand", async () => {
  await withTempHome("acpx-name-on-seat-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await seedSeat(homeDir, "seat-a", "alpha-seat");
    await writeSessionIndex(dir, { files: ["a.json"], entries: [entryFor("a", "seat-a")] });
    await fs.writeFile(path.join(dir, "seats.json"), "{ not json", "utf8");
    await writeSessionIndex(dir, {
      files: ["a.json"],
      entries: [entryFor("a", "seat-a", "alpha-seat")],
    });
    assert.equal((await readRawIndexEntries(homeDir)).get("a.json")?.name, "alpha-seat");
  });
});
