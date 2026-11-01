import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  loadOrRebuildSessionIndex,
  readSessionIndex,
  reconcileSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
  type SessionIndexEntry,
} from "../src/session/persistence/index.js";
import { writeSessionRecord } from "../src/session/persistence/repository.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// P1-2 (TEST-PLAN): `principal_*` is projected onto the session index entry as `principal`, verbatim, on
// BOTH index legs — the change hazard of `index.ts`: a field missing from the parse leg is stripped from every
// untouched entry on the next rewrite of ANY other session. Shaped like session-index-started-by.test.ts.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// Deliberately NOT alphabetical: the projection keeps the record's key order.
const PRINCIPAL: Record<string, string> = {
  principal_via: "inherited",
  principal_name: "Daniel Laatz",
  principal_id: "p-fb566154c0bf245b7538",
  principal_from: "5727c06f-0000-4000-8000-000000000001",
};

function principalRecord(
  id: string,
  metadata: Record<string, string> | undefined,
  lastUsedAt = "2026-06-01T00:00:00.000Z",
): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: "agent",
    cwd: "/tmp/principal",
    lastUsedAt,
    metadata,
  });
}

async function withSessionDir<T>(run: (sessionDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-index-principal-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeRecordFile(sessionDir: string, record: SessionRecord): Promise<string> {
  const fileName = `${encodeURIComponent(record.acpxRecordId)}.json`;
  await fs.writeFile(
    path.join(sessionDir, fileName),
    `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
    "utf8",
  );
  return fileName;
}

test("toSessionIndexEntry projects exactly the principal_* metadata, verbatim, in key order", () => {
  const entry = toSessionIndexEntry(
    principalRecord("pr-1", {
      brick: "11111111-2222-3333-4444-555555555555",
      ...PRINCIPAL,
      started_by_name: "Ada",
      infra: "1",
    }),
    "pr-1.json",
  );
  assert.deepEqual(entry.principal, PRINCIPAL);
  assert.deepEqual(Object.keys(entry.principal ?? {}), Object.keys(PRINCIPAL));
});

test("a record without principal_* gets no principal, and other metadata (incl. started_by_*) never leaks in", () => {
  const without = toSessionIndexEntry(principalRecord("pr-2", undefined), "pr-2.json");
  assert.equal(without.principal, undefined);
  assert.equal(JSON.stringify(without).includes('"principal"'), false);

  const unrelated = toSessionIndexEntry(
    principalRecord("pr-3", {
      started_by_name: "Ada",
      // near-misses: wrong prefix, wrong case, prefix not at the start
      Principal_via: "x",
      not_principal_via: "x",
      principal: "x",
    }),
    "pr-3.json",
  );
  assert.equal(unrelated.principal, undefined);
  assert.equal(JSON.stringify(unrelated).includes('"principal"'), false);
});

test("principal round-trips index.json write → parseIndexEntry → rewrite byte-identically", async () => {
  await withSessionDir(async (sessionDir) => {
    const entry = toSessionIndexEntry(principalRecord("pr-5", PRINCIPAL), "pr-5.json");
    await writeSessionIndex(sessionDir, { files: ["pr-5.json"], entries: [entry] });
    const firstBytes = await fs.readFile(path.join(sessionDir, "index.json"), "utf8");
    assert.ok(firstBytes.includes('"principal"'), "principal reached index.json");

    const parsed = await readSessionIndex(sessionDir);
    assert.ok(parsed);
    assert.deepEqual(parsed.entries[0]?.principal, PRINCIPAL);

    await writeSessionIndex(sessionDir, { files: parsed.files, entries: parsed.entries });
    const secondBytes = await fs.readFile(path.join(sessionDir, "index.json"), "utf8");
    assert.equal(secondBytes, firstBytes);
  });
});

test("parseIndexEntry drops non-string principal values, foreign keys, and an empty or non-object principal", async () => {
  await withSessionDir(async (sessionDir) => {
    const good = toSessionIndexEntry(principalRecord("pr-6", PRINCIPAL), "pr-6.json");
    const variant = (n: number, principal: unknown): SessionIndexEntry =>
      ({
        ...good,
        file: `pr-${n}.json`,
        acpxRecordId: `pr-${n}`,
        principal,
      }) as unknown as SessionIndexEntry;
    await writeSessionIndex(sessionDir, {
      files: ["pr-6.json", "pr-7.json", "pr-8.json", "pr-9.json", "pr-10.json"],
      entries: [
        good,
        variant(7, { principal_via: "started", principal_n: 7, principal_ok: true }),
        variant(8, { principal_n: 7 }),
        variant(9, "Ada"),
        variant(10, { principal_via: "started", other: "x" }),
      ],
    });
    const parsed = await readSessionIndex(sessionDir);
    assert.ok(parsed, "index still parses");
    const byFile = new Map(parsed.entries.map((entry) => [entry.file, entry]));
    assert.deepEqual(byFile.get("pr-6.json")?.principal, PRINCIPAL);
    assert.deepEqual(byFile.get("pr-7.json")?.principal, { principal_via: "started" });
    assert.equal(byFile.get("pr-8.json")?.principal, undefined);
    assert.equal(byFile.get("pr-9.json")?.principal, undefined);
    assert.deepEqual(byFile.get("pr-10.json")?.principal, { principal_via: "started" });
  });
});

test("an untouched entry keeps principal through an incremental reconcile rewrite (the parse leg)", async () => {
  await withSessionDir(async (sessionDir) => {
    const a = principalRecord("pr-a", PRINCIPAL);
    const fileA = await writeRecordFile(sessionDir, a);
    // The entry carries a marker the on-disk record lacks: incremental reconcile writes it back as
    // parsed, so the marker AND principal survive only through parseIndexEntry.
    const markedA = { ...toSessionIndexEntry(a, fileA), agentName: "marker-not-on-disk" };
    await writeSessionIndex(sessionDir, { files: [fileA], entries: [markedA] });

    const b = principalRecord("pr-b", undefined, "2026-06-02T00:00:00.000Z");
    const fileB = await writeRecordFile(sessionDir, b);

    const { index, drift } = await reconcileSessionIndex(sessionDir);
    assert.equal(drift, true);
    await writeSessionIndex(sessionDir, index);

    const reread = await readSessionIndex(sessionDir);
    assert.ok(reread);
    const entryA = reread.entries.find((entry) => entry.file === fileA);
    const entryB = reread.entries.find((entry) => entry.file === fileB);
    assert.equal(entryA?.agentName, "marker-not-on-disk");
    assert.deepEqual(entryA?.principal, PRINCIPAL);
    assert.equal(entryB?.principal, undefined);
  });
});

test("a full index rebuild projects principal from the record on disk (the projection leg)", async () => {
  await withSessionDir(async (sessionDir) => {
    const withPrincipal = principalRecord("pr-r1", PRINCIPAL);
    const without = principalRecord("pr-r2", { brick: "b" }, "2026-06-02T00:00:00.000Z");
    const fileWith = await writeRecordFile(sessionDir, withPrincipal);
    const fileWithout = await writeRecordFile(sessionDir, without);

    const index = await loadOrRebuildSessionIndex(sessionDir);
    assert.deepEqual(index.entries.find((entry) => entry.file === fileWith)?.principal, PRINCIPAL);
    assert.equal(index.entries.find((entry) => entry.file === fileWithout)?.principal, undefined);
  });
});

function runReindex(homeDir: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    const child = spawn(process.execPath, [CLI_PATH, "sessions", "reindex"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

test("P1-2: S is untouched across three rewrites by the OTHER leg and keeps its principal in the index (the hazard itself)", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-index-principal-home-"));
  const savedHome = process.env.HOME;
  const savedState = process.env.ACPX_STATE_HOME;
  process.env.HOME = home;
  process.env.ACPX_STATE_HOME = home;
  try {
    const sessionDir = path.join(home, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    const s = principalRecord("pr-s", PRINCIPAL);
    const other = principalRecord(
      "pr-other",
      { principal_via: "none" },
      "2026-06-02T00:00:00.000Z",
    );
    const fileS = await writeRecordFile(sessionDir, s);
    await writeRecordFile(sessionDir, other);
    await writeSessionIndex(sessionDir, await loadOrRebuildSessionIndex(sessionDir));

    const principalOfS = async (): Promise<Record<string, string> | undefined> =>
      (await readSessionIndex(sessionDir))?.entries.find((entry) => entry.file === fileS)
        ?.principal;
    assert.deepEqual(await principalOfS(), PRINCIPAL, "control: S carries it before any rewrite");

    // rewrite 1 — the daemon's per-update leg: ANOTHER session's record is written
    await writeSessionRecord({ ...other, lastUsedAt: "2026-06-03T00:00:00.000Z" });
    assert.deepEqual(await principalOfS(), PRINCIPAL, "after another session's update");

    // rewrite 2 — a brand-new session joins and the index reconciles
    await writeSessionRecord(principalRecord("pr-new", undefined, "2026-06-04T00:00:00.000Z"));
    assert.deepEqual(await principalOfS(), PRINCIPAL, "after a new session was added");

    // rewrite 3 — `acpx sessions reindex`, the real binary
    const reindex = await runReindex(home);
    assert.equal(reindex.code, 0, reindex.stderr);
    assert.deepEqual(await principalOfS(), PRINCIPAL, "after `sessions reindex`");
  } finally {
    process.env.HOME = savedHome;
    if (savedState === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = savedState;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
});
