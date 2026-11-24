import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ForkCutUnresolvedError } from "../src/acp/claude-fork-anchor.js";
import { locatePiSessionTranscript } from "../src/acp/harness-config-dir.js";
import { resolvePiForkCutByRecord } from "../src/acp/pi-fork-anchor.js";
import {
  readFullSourceHistory,
  resolveForkCutIndex,
} from "../src/cli/session/fork-at-log-index.js";
import { resolveSessionRecord } from "../src/session/persistence/repository.js";
import { indexCutLineOf, totalViolations, violationsOf } from "./pi-cut-helpers.js";

// brick 4bf088a7 (DESIGN Q1, TEST-PLAN §1 (i)) — the REAL records, run as their own target.
//
// The affected records hold the owner's messages, so they are never in git: the lane froze them as a
// read-only snapshot (`scripts/freeze-pi-cut-records.mjs`: 0444, sha256 MANIFEST) outside every repo.
// This file runs the proof over EVERY cut of them and compares with the conception prototype's oracle
// (`test/fixtures/pi-fork-anchor-oracle.json`: a different implementation, ids and lines only).
//
// NOT part of `pnpm test` (its name is `*.integration.ts`, outside the `*.test.js` glob), so the main
// suite stays skip-free. Invoked on purpose it FAILS — it never skips — when the snapshot is absent or
// does not verify. (The name avoids the `ACPX_PI_` prefix on purpose: `test/box-env-scrub.ts` sweeps
// every `ACPX_PI_*` variable at test start, which silently removed the first spelling.)
//   ACPX_REAL_PICUT_SNAPSHOT=/workspace/fixtures/4bf088a7-pi-cut pnpm run test:pi-cut-real

const SNAPSHOT = process.env.ACPX_REAL_PICUT_SNAPSHOT;
const PI_COMMAND = "node /opt/pi-acp/dist/index.js";
const CONTROLS = [
  "cf704e76-7e63-46c1-bc71-a293a3f6a957",
  "565eff19-d631-4630-adb2-9ad8e87e0f11",
  "907cc57e-1f73-4575-9b30-63b066047716",
];

type OracleCut = [number, string | { refused: string }, number?, number?];
type Oracle = { records: { id: string; cuts: OracleCut[] }[] };
const ORACLE = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "test", "fixtures", "pi-fork-anchor-oracle.json"),
    "utf8",
  ),
) as Oracle;

function snapshotDir(): string {
  assert.ok(
    SNAPSHOT && fs.existsSync(SNAPSHOT),
    "ACPX_REAL_PICUT_SNAPSHOT must name the frozen snapshot directory (this target never skips)",
  );
  return SNAPSHOT;
}

/** A writable state home whose files are SYMLINKS into the snapshot: the index rebuild writes here, not there. */
function stateHomeOver(snapshot: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-pi-cut-real-"));
  const source = path.join(snapshot, "state", ".acpx");
  for (const dir of fs.readdirSync(source)) {
    fs.mkdirSync(path.join(home, ".acpx", dir), { recursive: true });
    for (const name of fs.readdirSync(path.join(source, dir))) {
      fs.symlinkSync(path.join(source, dir, name), path.join(home, ".acpx", dir, name));
    }
  }
  return home;
}

test("the snapshot verifies against its MANIFEST (no file edited, none missing)", () => {
  const dir = snapshotDir();
  const lines = fs
    .readFileSync(path.join(dir, "MANIFEST.sha256"), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.equal(lines.length, 161, "files in the manifest");
  for (const line of lines) {
    const [sha, file] = [line.slice(0, 64), line.slice(66)];
    const actual = createHash("sha256")
      .update(fs.readFileSync(path.join(dir, file)))
      .digest("hex");
    assert.equal(actual, sha, file);
    assert.equal(fs.statSync(path.join(dir, file)).mode & 0o222, 0, `${file} is read-only`);
  }
});

type Outcome = { entryId?: string; line?: number; contextEnd?: number; refused?: string };

async function cutsOf(id: string): Promise<{
  cuts: {
    n: number;
    outcome: Outcome;
    violations: number;
    indexLeaks: number;
    indexLine?: number;
  }[];
}> {
  const record = await resolveSessionRecord(id);
  const history = await readFullSourceHistory(record);
  const located = locatePiSessionTranscript({ cwd: record.cwd, acpSessionId: record.acpSessionId });
  assert.ok(located, `the pi file of ${id} is in the snapshot's box store`);
  const content = fs.readFileSync(located.path, "utf8");
  const cuts = [];
  for (let n = history.baseIndex + 1; n <= history.baseIndex + history.messages.length; n += 1) {
    if (resolveForkCutIndex(PI_COMMAND, history.messages, n, history.baseIndex) !== n) {
      continue;
    }
    const end = n - history.baseIndex;
    const input = {
      before: history.messages.slice(0, end),
      after: history.messages.slice(end),
      baseIndex: history.baseIndex,
      piContent: content,
    };
    const indexLine = indexCutLineOf(content, n);
    const index = indexLine === undefined ? { a: 0, b: 0, c: 0 } : violationsOf(input, indexLine);
    let outcome: Outcome;
    let found = 0;
    try {
      const cut = resolvePiForkCutByRecord(content, {
        atLogIndex: n,
        window: history.messages.slice(Math.max(0, end - 200), end),
        before: input.before,
        after: input.after,
      });
      outcome = { entryId: cut.entryId, line: cut.line, contextEnd: cut.contextEndLogIndex };
      found = totalViolations(violationsOf(input, cut.line, cut.contextEndLogIndex));
    } catch (error) {
      assert.ok(error instanceof ForkCutUnresolvedError, String(error));
      outcome = { refused: (JSON.parse(error.message) as { reason: string }).reason };
    }
    cuts.push({
      n,
      outcome,
      violations: found,
      indexLeaks: index.a + index.b > 0 ? 1 : 0,
      indexLine,
    });
  }
  return { cuts };
}

test("the 18 affected records: EVERY cut equals the prototype oracle; 925 exact, 42 short, 6 refused; 0 violations", async () => {
  const snapshot = snapshotDir();
  const home = stateHomeOver(snapshot);
  process.env.ACPX_STATE_HOME = home;
  process.env.ACPX_PI_BOX_AGENT_DIR = path.join(snapshot, "pi-agent");
  const totals = { cuts: 0, exact: 0, short: 0, refused: 0, violations: 0, indexLeaks: 0 };
  for (const record of ORACLE.records) {
    const { cuts } = await cutsOf(record.id);
    assert.equal(cuts.length, record.cuts.length, `${record.id.slice(0, 8)}: cuts evaluated`);
    for (const [expected, got] of record.cuts.map((o, i) => [o, cuts[i]] as const)) {
      assert.equal(got.n, expected[0], `${record.id.slice(0, 8)}: cut order`);
      const want =
        typeof expected[1] === "string"
          ? { entryId: expected[1], line: expected[2], contextEnd: expected[3] }
          : { refused: expected[1].refused };
      assert.deepEqual(got.outcome, want, `${record.id.slice(0, 8)} n=${got.n}`);
    }
    for (const cut of cuts) {
      totals.cuts += 1;
      totals.violations += cut.violations;
      totals.indexLeaks += cut.indexLeaks;
      if (cut.outcome.refused !== undefined) {
        totals.refused += 1;
      } else if (cut.outcome.contextEnd === undefined) {
        totals.exact += 1;
      } else {
        totals.short += 1;
      }
    }
  }
  console.log(`# real-record totals: ${JSON.stringify(totals)}`);
  assert.deepEqual(
    {
      cuts: totals.cuts,
      exact: totals.exact,
      short: totals.short,
      refused: totals.refused,
      violations: totals.violations,
    },
    { cuts: 973, exact: 925, short: 42, refused: 6, violations: 0 },
  );
  // The same checker run on the line today's `forkAtMessageIndex = n` ends at: it finds the defect on 650
  // of the 973 cuts (the prototype's richer classifier counted 654; 17 of the 18 records leak).
  assert.equal(totals.indexLeaks, 650);
});

test("the 3 aligned controls: every cut resolves at exactly the line today's index gives, with no shortfall", async () => {
  const snapshot = snapshotDir();
  process.env.ACPX_STATE_HOME = stateHomeOver(snapshot);
  process.env.ACPX_PI_BOX_AGENT_DIR = path.join(snapshot, "pi-agent");
  let evaluated = 0;
  for (const id of CONTROLS) {
    const { cuts } = await cutsOf(id);
    for (const cut of cuts) {
      assert.equal(cut.outcome.refused, undefined, `${id.slice(0, 8)} n=${cut.n}`);
      assert.equal(cut.outcome.contextEnd, undefined);
      assert.equal(
        cut.outcome.line,
        cut.indexLine,
        `${id.slice(0, 8)} n=${cut.n}: the index is right here`,
      );
      assert.equal(cut.violations, 0);
      evaluated += 1;
    }
  }
  assert.equal(evaluated, 74, "cuts evaluated across the controls (4 + 66 + 4)");
});
