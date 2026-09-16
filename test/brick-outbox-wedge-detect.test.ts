/**
 * An `instance.json` re-mint permanently wedges a bound outbox (brick 7d03eca1).
 *
 * WHAT THIS DEFENDS. If a HOME's `~/.acpx/instance.json` identity changes while that HOME's
 * `brick-outbox.db` is still bound to the previous one — a HOME wipe, a restore from a mismatched
 * backup, or a re-provisioned PVC that already carries an outbox — every session-mutating
 * operation on the box fails with `outbox-instance-mismatch`. That is character-for-character the
 * failure that wedged devbox for ~80 minutes on 2026-09-15 (bricks 507a1c38 / 42b4fb28). This
 * brick does not change WHETHER the operation refuses (`42b4fb28` owns the judgement of whether a
 * re-provisioned box should be trusted) — it only makes the refusal name the mismatch and point at
 * the documented remedy, instead of a bare "identity binding differs from instance.json".
 *
 * ⚠️ `norotate-save-record` IS A POSITIVE CONTROL, NOT FILLER. It proves `saveRecord` genuinely
 * reaches `identityForRecord` (via the projection path) rather than short-circuiting to the
 * unguarded `writeOwnedRecord` fast path — without it, `rotate-save-record` throwing would not be
 * attributable to the rotation at all (brick 7d03eca1's own measurement matrix makes the same
 * point about its `norotate-save-record` row).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const PROBE_ROOT = "/workspace/wedge-detect-probe";

interface Observation {
  scenario: string;
  threw: boolean;
  code: string | null;
  message: string;
  outbox_rows: number;
  db: string;
}

function probe(scenario: string): Observation {
  fs.mkdirSync(PROBE_ROOT, { recursive: true });
  const home = fs.mkdtempSync(path.join(PROBE_ROOT, `${scenario}-`));
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "test/fixtures/wedge-detect-worker.ts", scenario],
    {
      cwd: process.cwd(),
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  const line = (result.stdout ?? "").split("\n").find((entry) => entry.startsWith("OBS "));
  assert.ok(
    line,
    `EXAMINED NOTHING: the ${scenario} probe produced no observation\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return JSON.parse(line.slice(4)) as Observation;
}

test("7d03eca1 wedge: POSITIVE CONTROL — an unrotated identity saves through the projection path", () => {
  const observed = probe("norotate-save-record");
  assert.equal(observed.threw, false, observed.message);
  assert.equal(observed.outbox_rows, 1);
});

test("7d03eca1 wedge: a re-minted instance.json under a bound outbox throws a NAMED, ACTIONABLE error", () => {
  const observed = probe("rotate-save-record");
  assert.equal(observed.threw, true);
  assert.equal(observed.code, "outbox-instance-mismatch");
  assert.equal(observed.outbox_rows, 0);
  // Names both identities involved, not just "differs from instance.json" — a reader can tell
  // WHICH id is stale and which is live without opening the db.
  assert.match(observed.message, /i-aaaaaaaaaaaa/);
  assert.match(observed.message, /i-bbbbbbbbbbbb/);
  // Points at the actual remedy — the exact SQL a reader needs, inline, not just a pointer.
  assert.match(
    observed.message,
    /DELETE FROM meta WHERE key IN \('instance_id','projection_identity'\)/,
  );
  // And at the durable, discoverable home for the full procedure — reachable without already
  // knowing this brick exists.
  assert.match(observed.message, /acpx skill/i);
  assert.match(observed.message, /brick 7d03eca1/);
});
