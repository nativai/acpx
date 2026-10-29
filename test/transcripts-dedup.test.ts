import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TOP_LEVEL_VERBS } from "../src/cli-core.js";
import {
  formatDedupFinalLine,
  renderDedupJson,
  restoreExitTail,
  runTranscriptsDedup,
  TranscriptRestoreError,
  TranscriptsUsageError,
  type DedupReport,
} from "../src/cli/transcripts-dedup.js";
import { transcriptCwdHash } from "../src/config/subscription-transcript.js";
import { reduceToExitTail } from "../src/config/transcript-dedup.js";
import { withTempHome } from "./temp-home.js";
import {
  ageFile,
  conversation,
  exists,
  exitLine,
  jsonl,
  queueOperationLine,
  sessionIdFor,
  sha256File,
  writeFileAt,
  writeRecordFixture,
  writeRegistry,
} from "./transcript-fixture-test-helpers.js";

// Matrix E (+ restore rows A11–A14, A18) of brick 81433524's TEST-PLAN: the verbs on
// a fixture tree built from Part 2's real shapes, in an isolated HOME.

const CWD = "/work/dedup";
const SLUG = transcriptCwdHash(CWD);
const TWO_HOURS = 2 * 60 * 60_000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  await withTempHome("acpx-transcripts-", async (home) => {
    await writeRegistry(home, ["subA", "subB", "subC"], "subA");
    await fs.mkdir(path.join(home, ".acpx", "subscriptions", "sub4"), { recursive: true });
    await run(home);
  });
}

function copyIn(home: string, sub: string, name: string): string {
  return path.join(home, ".acpx", "subscriptions", sub, "projects", SLUG, name);
}

function bodies(id: string) {
  const p = conversation(id, { pairs: 16 });
  const newer = conversation(id, { pairs: 3, seed: "newer", startMinute: 200, parent: p.lastUuid });
  const leaf = p.lastUuid;
  return { p, leaf, pText: jsonl(p.lines), full: jsonl(p.lines) + jsonl(newer.lines) };
}

type Tree = {
  ids: Record<string, string>;
  /** Paths the plan must delete / reduce. */
  deletes: string[];
  reduces: string[];
  /** Every file the run must leave byte-identical. */
  untouched: string[];
  liveOwnerRecord: string;
};

/**
 * One id per shape (TEST-PLAN §1). Every copy is aged 2 h unless the shape says
 * otherwise; every shape but S13 has a record bound to subB (its active copy).
 */
async function buildTree(home: string): Promise<Tree> {
  const tree: Tree = { ids: {}, deletes: [], reduces: [], untouched: [], liveOwnerRecord: "" };
  const add = async (
    shape: string,
    files: Array<{
      sub: string;
      name?: string;
      body: string;
      expect: "delete" | "reduce" | "keep";
    }>,
    record: { profile?: string; pid?: number } | null = {},
  ) => {
    const id = sessionIdFor(shape);
    tree.ids[shape] = id;
    for (const file of files) {
      const filePath = await writeFileAt(
        copyIn(home, file.sub, file.name ?? `${id}.jsonl`),
        file.body,
      );
      await ageFile(filePath, TWO_HOURS);
      const bucket =
        file.expect === "delete"
          ? tree.deletes
          : file.expect === "reduce"
            ? tree.reduces
            : tree.untouched;
      bucket.push(filePath);
    }
    if (record) {
      await writeRecordFixture(home, {
        recordId: `rec-${shape}`,
        acpSessionId: id,
        cwd: CWD,
        profile: record.profile ?? "subB",
        pid: record.pid,
      });
    }
    return id;
  };
  const shape = (label: string) => bodies(sessionIdFor(label));

  let b = shape("S1");
  await add("S1", [
    { sub: "subB", body: b.full, expect: "keep" },
    {
      sub: "subB",
      name: `${sessionIdFor("S1")}.superseded-2026-10-01T00-00-00.000Z.jsonl`,
      body: b.pText,
      expect: "delete",
    },
  ]);
  b = shape("S2");
  const s2 = await add("S2", [
    { sub: "subB", body: b.full, expect: "keep" },
    { sub: "subA", body: b.pText, expect: "delete" },
    {
      sub: "subA",
      name: `${sessionIdFor("S2")}.jsonl.acpx-port-123-abcd1234.tmp`,
      body: b.pText,
      expect: "delete",
    },
  ]);
  // A young port temp (may be in flight) and an existing tail file: never touched.
  const youngTemp = await writeFileAt(
    copyIn(home, "subB", `${s2}.jsonl.acpx-port-9-feedbeef.tmp`),
    b.pText,
  );
  await ageFile(youngTemp, 10 * 60_000);
  tree.untouched.push(youngTemp);
  tree.untouched.push(
    await writeFileAt(
      copyIn(home, "subB", `${s2}.exit-tail-2026-01-01T00-00-00.000Z.acpx`),
      "{}\n",
    ),
  );
  b = shape("S3");
  await add("S3", [
    { sub: "subB", body: b.full, expect: "keep" },
    { sub: "subA", body: b.full, expect: "delete" },
  ]);
  for (const [label, types] of [
    ["S4a", ["last-prompt"]],
    ["S4b", ["cost-state", "last-prompt"]],
    ["S4c", ["cost-state"]],
  ] as const) {
    b = shape(label);
    const id = sessionIdFor(label);
    await add(label, [
      { sub: "subB", body: b.full, expect: "keep" },
      {
        sub: "subA",
        body: b.pText + jsonl(types.map((t) => exitLine(t, id, b.leaf))),
        expect: "reduce",
      },
    ]);
  }
  b = shape("S5");
  const s5 = sessionIdFor("S5");
  await add("S5", [
    { sub: "subB", body: b.full, expect: "keep" },
    {
      sub: "subA",
      body:
        b.pText +
        jsonl(
          ["last-prompt", "ai-title", "mode", "atis-latch", "cost-state"].map((t) =>
            exitLine(t as "mode", s5, b.leaf),
          ),
        ),
      expect: "reduce",
    },
    {
      sub: "subC",
      body:
        b.pText +
        jsonl(["ai-title", "mode", "atis-latch"].map((t) => exitLine(t as "mode", s5, b.leaf))),
      expect: "reduce",
    },
  ]);
  b = shape("S6");
  const s6 = sessionIdFor("S6");
  await add("S6", [
    { sub: "subB", body: b.full, expect: "keep" },
    {
      sub: "subB",
      name: `${s6}.superseded-2026-10-02T00-00-00.000Z.jsonl`,
      body:
        b.pText + jsonl([exitLine("cost-state", s6, b.leaf), exitLine("last-prompt", s6, b.leaf)]),
      expect: "reduce",
    },
  ]);
  b = shape("S7");
  const s7 = sessionIdFor("S7");
  await add("S7", [
    { sub: "subB", body: b.full, expect: "keep" },
    {
      sub: "subA",
      body: b.pText + jsonl([exitLine("last-prompt", s7, b.leaf), queueOperationLine(s7, 999)]),
      expect: "keep",
    },
  ]);
  b = shape("S8");
  const branch = conversation(sessionIdFor("S8"), {
    pairs: 2,
    seed: "branch",
    startMinute: 90,
    parent: b.leaf,
  });
  await add("S8", [
    { sub: "subB", body: b.full, expect: "keep" },
    { sub: "subA", body: b.pText + jsonl(branch.lines), expect: "keep" },
  ]);
  b = shape("S9");
  const s9 = sessionIdFor("S9");
  await add("S9", [
    { sub: "subB", body: b.pText + jsonl([exitLine("last-prompt", s9, b.leaf)]), expect: "keep" },
    { sub: "subA", body: b.full, expect: "keep" },
  ]);
  b = shape("S10");
  await add("S10", [
    { sub: "subB", body: b.full, expect: "keep" },
    { sub: "sub4", body: b.pText, expect: "delete" },
  ]);
  b = shape("S10m");
  const s10m = sessionIdFor("S10m");
  await add("S10m", [
    { sub: "subB", body: b.full, expect: "keep" },
    {
      sub: "sub4",
      body: b.pText + jsonl([exitLine("cost-state", s10m, b.leaf)]),
      expect: "reduce",
    },
  ]);
  b = shape("S11");
  await add("S11", [
    { sub: "subB", body: b.full, expect: "keep" },
    { sub: "subA", body: `${b.full}x`, expect: "keep" },
  ]);
  b = shape("S13");
  const s13 = sessionIdFor("S13");
  await add(
    "S13",
    [
      {
        sub: "subA",
        body: b.pText + jsonl([exitLine("last-prompt", s13, b.leaf)]),
        expect: "reduce",
      },
      {
        sub: "subB",
        body:
          b.pText +
          jsonl([exitLine("cost-state", s13, b.leaf), exitLine("last-prompt", s13, b.leaf)]),
        expect: "keep",
      },
    ],
    null,
  );
  // Guarded ids: their (otherwise deletable) copies must be untouched.
  b = shape("live-owner");
  await add("live-owner", [
    { sub: "subB", body: b.full, expect: "keep" },
    { sub: "subA", body: b.pText, expect: "keep" },
  ]);
  tree.liveOwnerRecord = "rec-live-owner";
  b = shape("live-pid");
  await add(
    "live-pid",
    [
      { sub: "subB", body: b.full, expect: "keep" },
      { sub: "subA", body: b.pText, expect: "keep" },
    ],
    { pid: process.pid },
  );
  b = shape("recent");
  await add("recent", [
    { sub: "subB", body: b.full, expect: "keep" },
    { sub: "subA", body: b.pText, expect: "keep" },
  ]);
  await ageFile(copyIn(home, "subA", `${sessionIdFor("recent")}.jsonl`), 5 * 60_000);
  return tree;
}

const liveOwnerDeps = (liveRecords: Set<string>) => ({
  ownerPossiblyAlive: async (recordId: string) => liveRecords.has(recordId),
});

async function snapshot(
  home: string,
): Promise<Map<string, { sha: string; mtimeMs: number; size: number }>> {
  const out = new Map<string, { sha: string; mtimeMs: number; size: number }>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && !full.includes(`${path.sep}sessions`)) {
        const info = await fs.stat(full);
        out.set(full, { sha: await sha256File(full), mtimeMs: info.mtimeMs, size: info.size });
      }
    }
  };
  await walk(path.join(home, ".acpx", "subscriptions"));
  return out;
}

function plannedPaths(report: DedupReport, kind: "delete" | "reduce"): string[] {
  return report.actions
    .filter((action) => action.action === kind)
    .map((action) => action.path)
    .toSorted();
}

test("§0.1 isolation control: an empty fixture HOME reports ids=0", async () => {
  await withHome(async (home) => {
    const report = await runTranscriptsDedup({ apply: false, stateHome: home, userHome: home });
    assert.equal(report.ids, 0);
    assert.match(
      formatDedupFinalLine(report),
      /^transcripts dedup DRY-RUN box=\S+ ids=0 copies=0 /,
    );
  });
});

test("E1 / E2: the dry run plans exactly the eligible set and changes no byte", async () => {
  await withHome(async (home) => {
    const tree = await buildTree(home);
    const before = await snapshot(home);
    const report = await runTranscriptsDedup({
      apply: false,
      stateHome: home,
      userHome: home,
      deps: liveOwnerDeps(new Set([tree.liveOwnerRecord])),
    });
    assert.deepEqual(await snapshot(home), before, "a dry run changes nothing, not even an mtime");
    assert.deepEqual(plannedPaths(report, "delete"), tree.deletes.toSorted());
    assert.deepEqual(plannedPaths(report, "reduce"), tree.reduces.toSorted());
    assert.deepEqual(report.keptByReason, {
      active: 14,
      branch: 2,
      "exit-block-not-eligible": 2,
      other: 1,
    });
    assert.deepEqual(report.skippedIds.map((entry) => entry.reason).toSorted(), [
      "live-owner",
      "live-pid",
      "recent",
    ]);
    // E2: the JSON carries the same actions and totals as the final line.
    const json = JSON.parse(renderDedupJson(report)) as {
      totals: { deleted: number; reduced: number; freed_bytes: number };
      actions: Array<{ path: string }>;
      skipped_ids: Array<{ reason: string }>;
    };
    assert.equal(json.actions.length, tree.deletes.length + tree.reduces.length);
    const line = formatDedupFinalLine(report);
    assert.match(line, new RegExp(`deleted=${json.totals.deleted}/`));
    assert.match(line, new RegExp(`reduced=${json.totals.reduced}/`));
    assert.match(line, new RegExp(`freed=${json.totals.freed_bytes}B`));
    assert.match(
      line,
      /skipped-ids: live-owner=1 live-pid=1 recent=1 ambiguous=0 \| recheck-failed=0$/,
    );
  });
});

test("E3: --apply without --manifest is refused and changes nothing", async () => {
  await withHome(async (home) => {
    await buildTree(home);
    const before = await snapshot(home);
    await assert.rejects(
      async () => await runTranscriptsDedup({ apply: true, stateHome: home, userHome: home }),
      TranscriptsUsageError,
    );
    assert.deepEqual(await snapshot(home), before);
  });
});

test("E4 / E5 / E13: --apply removes exactly the plan, every reduction restores, a rerun is a no-op", async () => {
  await withHome(async (home) => {
    const tree = await buildTree(home);
    const deps = liveOwnerDeps(new Set([tree.liveOwnerRecord]));
    const before = await snapshot(home);
    const manifest = path.join(home, "manifest.jsonl");
    const report = await runTranscriptsDedup({
      apply: true,
      manifest,
      stateHome: home,
      userHome: home,
      deps,
    });
    assert.equal(report.recheckFailed, 0, JSON.stringify(report.keptFiles));
    for (const removed of [...tree.deletes, ...tree.reduces]) {
      assert.equal(await exists(removed), false, removed);
    }
    for (const kept of tree.untouched) {
      assert.equal(await sha256File(kept), before.get(kept)?.sha, kept);
    }
    // Every reduction rebuilds its original, bit for bit.
    const scratch = path.join(home, "scratch");
    for (const action of report.actions.filter((a) => a.action === "reduce")) {
      assert.ok(action.tailFile);
      const to = path.join(scratch, path.basename(action.path));
      const restored = await restoreExitTail(action.tailFile, {
        to,
        stateHome: home,
        userHome: home,
      });
      assert.equal(await sha256File(to), before.get(action.path)?.sha, action.path);
      assert.equal(restored.sha256, before.get(action.path)?.sha);
      await fs.rm(to);
    }
    // E13: of the mutual pair exactly ONE was reduced, against the other (kept).
    const s13 = report.actions.filter((a) => a.sessionId === tree.ids.S13);
    assert.equal(s13.length, 1);
    assert.equal(await exists(s13[0]?.witness ?? ""), true);
    // The manifest: one intent line per action, each BEFORE its outcome line.
    const lines = (await fs.readFile(manifest, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, string>);
    const intents = lines.filter((l) => l.action);
    const outcomes = lines.filter((l) => l.outcome);
    assert.equal(intents.length, report.actions.length);
    assert.equal(outcomes.filter((l) => l.outcome === "deleted").length, tree.deletes.length);
    assert.equal(outcomes.filter((l) => l.outcome === "reduced").length, tree.reduces.length);
    for (const intent of intents) {
      const outcomeIndex = lines.findIndex((l) => l.outcome && l.path === intent.path);
      assert.ok(lines.indexOf(intent) < outcomeIndex, intent.path);
    }
    // freed = deleted + reduced − tail-file bytes = the measured change on disk.
    const after = await snapshot(home);
    const total = (snap: typeof before) => [...snap.values()].reduce((sum, f) => sum + f.size, 0);
    const freed = Number(/freed=(\d+)B/.exec(formatDedupFinalLine(report))?.[1]);
    assert.equal(total(before) - total(after), freed);
    assert.match(formatDedupFinalLine(report), /^transcripts dedup APPLIED /);

    const rerun = await runTranscriptsDedup({
      apply: true,
      manifest,
      stateHome: home,
      userHome: home,
      deps,
    });
    assert.equal(rerun.actions.length, 0, "idempotent");
    // Ids that now hold ONE copy drop out of the plan; what is left multi-copy is exactly
    // the four ids whose second copy is legitimately kept (S7, S8, S9, S11).
    assert.deepEqual(rerun.keptByReason, {
      active: 4,
      branch: 2,
      "exit-block-not-eligible": 2,
      other: 0,
    });
  });
});

test("E6: an id that turns live between the plan and the act is skipped at act time", async () => {
  await withHome(async (home) => {
    const tree = await buildTree(home);
    const live = new Set([tree.liveOwnerRecord]);
    const s2Copy = copyIn(home, "subA", `${tree.ids.S2}.jsonl`);
    const report = await runTranscriptsDedup({
      apply: true,
      manifest: path.join(home, "m.jsonl"),
      stateHome: home,
      userHome: home,
      deps: liveOwnerDeps(live),
      hooks: { afterPlan: () => void live.add("rec-S2") },
    });
    assert.equal(await exists(s2Copy), true);
    assert.ok(
      report.skippedIds.some(
        (entry) => entry.sessionId === tree.ids.S2 && entry.reason === "live-owner",
      ),
    );
    assert.equal(
      report.actions.some((a) => a.sessionId === tree.ids.S2),
      false,
    );
  });
});

test("E7: a witness deleted between plan and act keeps the copy (witness-missing, recheck-failed=1)", async () => {
  await withHome(async (home) => {
    const tree = await buildTree(home);
    const witness = copyIn(home, "subB", `${tree.ids.S1}.jsonl`);
    const sidecar = copyIn(
      home,
      "subB",
      `${tree.ids.S1}.superseded-2026-10-01T00-00-00.000Z.jsonl`,
    );
    const report = await runTranscriptsDedup({
      apply: true,
      manifest: path.join(home, "m.jsonl"),
      stateHome: home,
      userHome: home,
      deps: liveOwnerDeps(new Set([tree.liveOwnerRecord])),
      hooks: { afterPlan: async () => await fs.rm(witness) },
    });
    assert.equal(await exists(sidecar), true);
    assert.equal(report.recheckFailed, 1);
    assert.deepEqual(report.keptFiles, [{ path: sidecar, reason: "witness-missing" }]);
    assert.match(formatDedupFinalLine(report), /recheck-failed=1$/);
  });
});

test("E8: --session limits the run to that id", async () => {
  await withHome(async (home) => {
    const tree = await buildTree(home);
    const report = await runTranscriptsDedup({
      apply: false,
      sessions: [tree.ids.S4b],
      stateHome: home,
      userHome: home,
    });
    assert.deepEqual(
      report.actions.map((a) => a.sessionId),
      [tree.ids.S4b],
    );
    assert.equal(report.ids, 1);
  });
});

test("an archived record still defines its id's active path", async () => {
  await withHome(async (home) => {
    const id = sessionIdFor("archived");
    const b = bodies(id);
    // Active (archived record → subA); the subB copy is the left-behind prefix.
    await writeFileAt(copyIn(home, "subA", `${id}.jsonl`), b.full);
    await writeFileAt(copyIn(home, "subB", `${id}.jsonl`), b.pText);
    await ageFile(copyIn(home, "subA", `${id}.jsonl`), TWO_HOURS);
    await ageFile(copyIn(home, "subB", `${id}.jsonl`), TWO_HOURS);
    await writeRecordFixture(home, {
      recordId: "rec-arch",
      acpSessionId: id,
      cwd: CWD,
      profile: "subA",
      archived: true,
    });
    const report = await runTranscriptsDedup({ apply: false, stateHome: home, userHome: home });
    assert.deepEqual(plannedPaths(report, "delete"), [copyIn(home, "subB", `${id}.jsonl`)]);
    assert.equal(report.keptByReason.active, 1);
  });
});

test("two records naming different active paths skip the id (ambiguous)", async () => {
  await withHome(async (home) => {
    const id = sessionIdFor("ambiguous");
    const b = bodies(id);
    await writeFileAt(copyIn(home, "subA", `${id}.jsonl`), b.full);
    await writeFileAt(copyIn(home, "subB", `${id}.jsonl`), b.pText);
    await ageFile(copyIn(home, "subA", `${id}.jsonl`), TWO_HOURS);
    await ageFile(copyIn(home, "subB", `${id}.jsonl`), TWO_HOURS);
    await writeRecordFixture(home, {
      recordId: "rec-x",
      acpSessionId: id,
      cwd: CWD,
      profile: "subA",
    });
    await writeRecordFixture(home, {
      recordId: "rec-y",
      acpSessionId: id,
      cwd: CWD,
      profile: "subB",
    });
    const report = await runTranscriptsDedup({ apply: false, stateHome: home, userHome: home });
    assert.deepEqual(report.skippedIds, [{ sessionId: id, reason: "ambiguous" }]);
    assert.equal(report.actions.length, 0);
  });
});

// --- restore ---------------------------------------------------------------

async function reducedS4b(home: string) {
  const id = sessionIdFor("restore");
  const b = bodies(id);
  const witness = await writeFileAt(copyIn(home, "subB", `${id}.jsonl`), b.full);
  const original = await writeFileAt(
    copyIn(home, "subA", `${id}.jsonl`),
    b.pText + jsonl([exitLine("cost-state", id, b.leaf), exitLine("last-prompt", id, b.leaf)]),
  );
  const sha = await sha256File(original);
  // Whole ms from the NANOSECOND mtime, as the header stores it (a float mtimeMs can round up).
  const mtimeMs = Number((await fs.stat(original, { bigint: true })).mtimeNs / 1_000_000n);
  const outcome = await reduceToExitTail(original, witness, { reducedBy: "transcripts-dedup" });
  assert.equal(outcome.action, "reduced");
  const tailFile = outcome.action === "reduced" ? outcome.tailFile : "";
  return { id, b, witness, original, sha, mtimeMs, tailFile };
}

test("A11: restore rebuilds the original at its path, sha256 and mtime equal, tail file kept", async () => {
  await withHome(async (home) => {
    const { original, sha, mtimeMs, tailFile } = await reducedS4b(home);
    const result = await restoreExitTail(tailFile, { stateHome: home, userHome: home });
    assert.equal(result.restored, original);
    assert.equal(await sha256File(original), sha);
    assert.equal(Number((await fs.stat(original, { bigint: true })).mtimeNs / 1_000_000n), mtimeMs);
    assert.equal(await exists(tailFile), true);
  });
});

test("A12 / E12: restore never overwrites an existing file", async () => {
  await withHome(async (home) => {
    const { original, tailFile } = await reducedS4b(home);
    await writeFileAt(original, "something else\n");
    await assert.rejects(
      async () => await restoreExitTail(tailFile, { stateHome: home, userHome: home }),
      (error: unknown) => error instanceof TranscriptRestoreError && error.code === "target-exists",
    );
    assert.equal(await fs.readFile(original, "utf8"), "something else\n");
    const elsewhere = await writeFileAt(path.join(home, "taken.jsonl"), "x\n");
    await assert.rejects(
      async () =>
        await restoreExitTail(tailFile, { to: elsewhere, stateHome: home, userHome: home }),
    );
    assert.equal(await fs.readFile(elsewhere, "utf8"), "x\n");
  });
});

test("A13: the witness is found by its prefix hash after it was renamed to a sidecar", async () => {
  await withHome(async (home) => {
    const { id, witness, original, sha, tailFile } = await reducedS4b(home);
    const sidecar = path.join(
      path.dirname(witness),
      `${id}.superseded-2026-10-03T00-00-00.000Z.jsonl`,
    );
    await fs.rename(witness, sidecar);
    await writeFileAt(
      witness,
      jsonl([JSON.stringify({ type: "user", uuid: "other", timestamp: "2026-10-03T00:00:00Z" })]),
    );
    const result = await restoreExitTail(tailFile, { stateHome: home, userHome: home });
    assert.equal(result.witness, sidecar);
    assert.equal(await sha256File(original), sha);
  });
});

test("A14: no copy holding the prefix → witness-not-found, nothing written", async () => {
  await withHome(async (home) => {
    const { witness, original, tailFile } = await reducedS4b(home);
    await fs.rm(witness);
    await assert.rejects(
      async () => await restoreExitTail(tailFile, { stateHome: home, userHome: home }),
      (error: unknown) =>
        error instanceof TranscriptRestoreError && error.code === "witness-not-found",
    );
    assert.equal(await exists(original), false);
    assert.deepEqual(
      (await fs.readdir(path.dirname(original))).filter((n) => n.includes("restore")),
      [],
    );
  });
});

test("A18: restore is transitive through another tail file", async () => {
  await withHome(async (home) => {
    const id = sessionIdFor("chain");
    const pw = conversation(id, { pairs: 16 });
    const bw = jsonl([exitLine("cost-state", id, pw.lastUuid)]);
    const bx = jsonl([exitLine("last-prompt", id, pw.lastUuid)]);
    const later = conversation(id, { pairs: 3, seed: "v", startMinute: 300, parent: pw.lastUuid });
    const wBody = jsonl(pw.lines) + bw;
    const w = await writeFileAt(copyIn(home, "subB", `${id}.jsonl`), wBody);
    const x = await writeFileAt(copyIn(home, "subA", `${id}.jsonl`), wBody + bx);
    const v = await writeFileAt(
      copyIn(home, "subC", `${id}.jsonl`),
      jsonl(pw.lines) + jsonl(later.lines),
    );
    const xSha = await sha256File(x);
    // X's prefix reaches INTO W's exit block; then W itself is reduced against V.
    const xReduced = await reduceToExitTail(x, w, { reducedBy: "transcripts-dedup" });
    assert.equal(xReduced.action, "reduced");
    const wReduced = await reduceToExitTail(w, v, { reducedBy: "transcripts-dedup" });
    assert.equal(wReduced.action, "reduced");
    const xTail = xReduced.action === "reduced" ? xReduced.tailFile : "";
    const to = path.join(home, "rebuilt-x.jsonl");
    const result = await restoreExitTail(xTail, { to, stateHome: home, userHome: home });
    assert.equal(result.transitive, true);
    assert.equal(await sha256File(to), xSha);
    // The intermediate (W) was rebuilt in memory only.
    assert.equal(await exists(w), false);
  });
});

// --- the verb's registration and its "never automatic" pin -------------------

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], home: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ACPX_STATE_HOME: home };
    for (const key of ["ACPX_SESSION_URL", "ACPX_SEAT_URL", "ACPX_BRICK", "ACPX_BRICK_PATH"]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, "--cwd", home, ...args], {
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

test("E9: `transcripts` is a REAL top-level verb — a bogus subverb is an error, never an agent prompt", async () => {
  assert.equal(TOP_LEVEL_VERBS.has("transcripts"), true);
  await withHome(async (home) => {
    for (const args of [
      ["transcripts", "bogus"],
      ["transcripts", "dedup", "extra-arg"],
    ]) {
      const result = await runCli(args, home);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.doesNotMatch(output, /No acpx session found/, output);
      assert.match(output, /too many arguments|unknown command/, output);
      assert.equal(result.code, 1, output);
    }
    const noManifest = await runCli(["transcripts", "dedup", "--apply"], home);
    assert.match(noManifest.stderr, /--apply requires --manifest/);
    assert.equal(noManifest.code, 2);
    const dry = await runCli(["transcripts", "dedup"], home);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /^transcripts dedup DRY-RUN box=\S+ ids=0 copies=0 /m);
  });
});

test("E11: the planner is reachable ONLY from the command registration (never automatic)", async () => {
  const importers = new Map<string, string[]>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) {
        continue;
      }
      const text = await fs.readFile(full, "utf8");
      for (const match of text.matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)) {
        const target = path.resolve(path.dirname(full), match[1].replace(/\.js$/, ".ts"));
        importers.set(target, [...(importers.get(target) ?? []), path.relative(REPO_ROOT, full)]);
      }
    }
  };
  await walk(path.join(REPO_ROOT, "src"));
  const of = (file: string) =>
    [...new Set(importers.get(path.join(REPO_ROOT, file)) ?? [])].toSorted();
  assert.deepEqual(of("src/cli/transcripts-dedup.ts"), ["src/cli/transcripts-command.ts"]);
  assert.deepEqual(of("src/cli/transcripts-command.ts"), ["src/cli/command-registration.ts"]);
  // Positive control: the scan does see ordinary imports.
  assert.ok(of("src/config/transcript-dedup.ts").includes("src/cli/transcripts-dedup.ts"));
  // And the dynamic form is what the command uses.
  const command = await fs.readFile(path.join(REPO_ROOT, "src/cli/transcripts-command.ts"), "utf8");
  assert.match(command, /await import\("\.\/transcripts-dedup\.js"\)/);
  assert.doesNotMatch(command, /from "\.\/transcripts-dedup\.js"/);
});

test("the tail-file and temp names are never transcripts to any `*.jsonl` reader", () => {
  const id = sessionIdFor("names");
  for (const name of [
    `${id}.exit-tail-2026-10-29T20-00-00.000Z.acpx`,
    `${id}.jsonl.acpx-port-1-abcd.tmp`,
  ]) {
    assert.equal(name.endsWith(".jsonl"), false, name);
  }
  assert.equal(createHash("sha256").update("x").digest("hex").length, 64);
});
