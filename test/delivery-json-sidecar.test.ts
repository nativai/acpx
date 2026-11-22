import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadWakeupLiveness } from "../src/session/archive/liveness.js";
import { createContext, planArchiveRun } from "../src/session/archive/operations.js";
import { resolveBoundaries, scanSessionDir } from "../src/session/archive/retention.js";
import {
  projectRecordFilesIntoIndex,
  reconcileSessionIndexFromDisk,
} from "../src/session/persistence/index-update-queue.js";
import { rebuildSessionIndex, listSessionRecordFiles } from "../src/session/persistence/index.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { runSeatBackfill } from "../src/session/seat-backfill.js";
import { makeSessionRecord, withTempDir } from "./runtime-test-helpers.js";

// brick 99bf1c0d (atrium O8-1): `<id>.delivery.json` — acpx-ui's delivery sidecar, 390 of them on devbox —
// ends in `.json`, so every `endsWith(".json")` enumerator of the sessions directory counted it as a session
// record. Each row below is a NEGATIVE CASE per enumeration: a sidecar, well-formed JSON, beside real
// records, that must never become an index member, a listed session, an archive candidate or a backfill error.
// Two sidecar shapes: the REAL one (`{items, paused}`) and a RECORD-SHAPED one (a copy of the record) — the
// second is what turns a counted file into a phantom session `<id>.delivery`, so it is the sharper probe.
// Every row ran RED on fab24ef0 (the unfixed tree) — see verification/PLAN.md.

const UUID_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const UUID_B = "22222222-bbbb-4bbb-8bbb-222222222222";
const SES = "ses_f84bb7041ffeOayX6OGKPn4Elu"; // a real opaque (non-uuid) id shape on devbox
const OLD_MS = 30 * 24 * 60 * 60 * 1000;
const DELIVERY = JSON.stringify({
  items: [{ id: "d1", state: "failed", text: "hi" }],
  paused: false,
});

async function writeRecord(dir: string, id: string): Promise<string> {
  const closedAt = new Date(Date.now() - OLD_MS).toISOString();
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    closed: true,
    closedAt,
    lastUsedAt: closedAt,
  });
  const body = JSON.stringify(serializeSessionRecordForDisk(record));
  const file = path.join(dir, `${encodeURIComponent(id)}.json`);
  await fs.writeFile(file, body, "utf8");
  const old = new Date(Date.now() - OLD_MS);
  await fs.utimes(file, old, old);
  return body;
}

type Store = { dir: string; bodies: Map<string, string>; sidecars: string[] };

/** Three real records (two uuid, one `ses_`), each with a sidecar of the given shape beside it. */
async function store(
  dir: string,
  shape: "real" | "record-shaped",
  withSidecars = true,
): Promise<Store> {
  const bodies = new Map<string, string>();
  const sidecars: string[] = [];
  for (const id of [UUID_A, UUID_B, SES]) {
    const body = await writeRecord(dir, id);
    bodies.set(id, body);
    if (withSidecars) {
      const sidecar = path.join(dir, `${id}.delivery.json`);
      await fs.writeFile(sidecar, shape === "real" ? DELIVERY : body, "utf8");
      const old = new Date(Date.now() - OLD_MS);
      await fs.utimes(sidecar, old, old);
      sidecars.push(path.basename(sidecar));
    }
  }
  return { dir, bodies, sidecars };
}

const recordNames = [`${UUID_A}.json`, `${UUID_B}.json`, `${SES}.json`].toSorted();

for (const shape of ["real", "record-shaped"] as const) {
  test(`listSessionRecordFiles (${shape} sidecar): only the records, the \`ses_\` one included`, async () => {
    await withTempDir("acpx-dj-list-", async (dir) => {
      await store(dir, shape);
      assert.deepEqual(await listSessionRecordFiles(dir), recordNames);
    });
  });

  test(`index rebuild (${shape} sidecar): no sidecar in \`files\`, none with an entry — and no phantom session`, async () => {
    await withTempDir("acpx-dj-rebuild-", async (dir) => {
      await store(dir, shape);
      const index = await rebuildSessionIndex(dir, "dj-test");
      assert.deepEqual(index.files, recordNames);
      assert.deepEqual(index.entries.map((entry) => entry.file).toSorted(), recordNames);
      assert.deepEqual(
        index.entries.map((entry) => entry.acpxRecordId).toSorted(),
        [UUID_A, UUID_B, SES].toSorted(),
        "three sessions, however many sidecars",
      );
    });
  });

  test(`reconcile (${shape} sidecar): a sidecar that appears or goes is NOT drift and does not rewrite the index`, async () => {
    await withTempDir("acpx-dj-reconcile-", async (dir) => {
      await store(dir, shape, false);
      await rebuildSessionIndex(dir, "dj-test");
      const indexFile = path.join(dir, "index.json");
      const before = await fs.readFile(indexFile, "utf8");
      const sidecar = path.join(dir, `${UUID_A}.delivery.json`);
      await fs.writeFile(sidecar, shape === "real" ? DELIVERY : "{}", "utf8");
      assert.equal((await reconcileSessionIndexFromDisk(dir)).drift, false, "a sidecar appeared");
      await fs.rm(sidecar);
      assert.equal((await reconcileSessionIndexFromDisk(dir)).drift, false, "and went");
      assert.equal(await fs.readFile(indexFile, "utf8"), before, "index.json untouched");
      // positive control: a REAL new record is drift
      await writeRecord(dir, "33333333-cccc-4ccc-8ccc-333333333333");
      assert.equal((await reconcileSessionIndexFromDisk(dir)).drift, true);
    });
  });

  test(`named projection (${shape} sidecar): naming a sidecar projects nothing`, async () => {
    await withTempDir("acpx-dj-project-", async (dir) => {
      await store(dir, shape);
      await rebuildSessionIndex(dir, "dj-test");
      const before = await fs.readFile(path.join(dir, "index.json"), "utf8");
      const result = await projectRecordFilesIntoIndex(dir, [`${UUID_A}.delivery.json`]);
      assert.deepEqual(result, { files: 0 });
      assert.equal(await fs.readFile(path.join(dir, "index.json"), "utf8"), before);
      // twin: naming the record itself is projected
      assert.deepEqual(await projectRecordFilesIntoIndex(dir, [`${UUID_A}.json`]), { files: 1 });
    });
  });

  test(`archive scan (${shape} sidecar beside its record): rides in the record's file set — never a candidate or an orphan of its own`, async () => {
    await withTempDir("acpx-dj-scan-", async (dir) => {
      await store(dir, shape);
      const scan = await scanSessionDir(dir);
      assert.deepEqual(
        scan.candidates.map((c) => c.id).toSorted(),
        [UUID_A, UUID_B, SES].toSorted(),
      );
      assert.deepEqual(scan.orphans, []);
      for (const candidate of scan.candidates) {
        assert.deepEqual(
          candidate.files.toSorted(),
          [`${candidate.safeId}.delivery.json`, `${candidate.safeId}.json`].toSorted(),
          "the sidecar moves WITH its session",
        );
      }
    });
  });
}

test("archive plan with a record-shaped sidecar: no `<id>.delivery` candidate, and each session is held by its sidecar (`active-delivery-sidecar`) — as with a real one", async () => {
  for (const shape of ["record-shaped", "real"] as const) {
    await withTempDir("acpx-dj-plan-", async (dir) => {
      await store(dir, shape);
      const context = createContext(dir, "dj");
      const plan = await planArchiveRun(context, resolveBoundaries(context.nowMs), {
        includeOrphans: true,
        liveness: { primary: undefined, wakeups: await loadWakeupLiveness(dir) },
      });
      const ids = [
        ...plan.selected.map((s) => s.candidate.id),
        ...plan.blocked.map((b) => b.candidate.id),
      ];
      assert.deepEqual(
        ids.toSorted(),
        [UUID_A, UUID_B, SES].toSorted(),
        `${shape}: three sessions, no sidecar token`,
      );
      assert.deepEqual(
        plan.selected,
        [],
        `${shape}: nothing archived while a sidecar holds undelivered work`,
      );
      assert.deepEqual(
        plan.blocked.map((b) => b.blocker),
        ["active-delivery-sidecar", "active-delivery-sidecar", "active-delivery-sidecar"],
      );
      assert.deepEqual(plan.loneSpawnStates, []);
    });
  }
});

test("archive scan: a LONE sidecar (its record gone) stays what it always was — an orphan id's file, by the existing orphan rule", async () => {
  await withTempDir("acpx-dj-lone-", async (dir) => {
    await store(dir, "real", false);
    await fs.writeFile(
      path.join(dir, "99999999-9999-4999-8999-999999999999.delivery.json"),
      DELIVERY,
    );
    const scan = await scanSessionDir(dir);
    assert.deepEqual(
      scan.orphans.map((o) => o.files),
      [["99999999-9999-4999-8999-999999999999.delivery.json"]],
    );
  });
});

test("seat backfill (dry run, real sidecars): zero `parse` errors for them (it used to file one per sidecar)", async () => {
  await withTempDir("acpx-dj-backfill-", async (dir) => {
    await store(dir, "real");
    const report = await runSeatBackfill({ sessionDir: dir, apply: false });
    assert.deepEqual(
      report.errors.filter((error) => error.file.includes(".delivery.")),
      [],
    );
  });
});
