/**
 * Bind authorisation (brick 42b4fb28): an outbox under a HOME may only carry that HOME's own
 * admitted instance identity.
 *
 * WHAT THIS DEFENDS. On 2026-09-15 an acpx-ui test booted a real trigger owner without isolating
 * its HOME, and `bindIdentity` — which refused only when a DIFFERENT id was already bound — wrote
 * the fixture identity `i-twin0000001` / `f32-twin` / `https://fixture.invalid` into devbox's real
 * `~/.acpx/brick-outbox.db`. Every session-mutating operation on the box then failed for ~80
 * minutes with `identity binding differs from instance.json` (bricks 507a1c38 / 42b4fb28).
 *
 * ⚠️ EVERY ROW BELOW IS AN OBSERVATION OF THE OUTBOX'S META, NEVER OF AN EXIT CODE. The poisoning
 * moved nothing about the twin's verdict — it exited 1 before and after — so a test that reads a
 * status cannot see this defect at all. Each row runs the probe in a scratch HOME with an
 * explicit, non-inherited environment (`env` is built, not spread: the `env -i` shape) and then
 * reads the meta rows back through an INDEPENDENT sqlite connection.
 *
 * ⚠️ THE RED ARM LIVES OUTSIDE THIS FILE, ON PURPOSE. `test/fixtures/bind-guard-worker.ts` imports
 * `src/` and nothing else, so the identical file runs against a PRE-GUARD checkout and shows every
 * refusal below succeeding silently. Re-measure it after any change that could short-circuit a
 * refusal — a red arm goes stale against its own later hardening. Procedure and the measured
 * pre-guard output: this brick's `conception/TESTPLAN.md`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const PROBE_ROOT = "/workspace/bind-guard-probe";

interface Observation {
  scenario: string;
  threw: boolean;
  code: string | null;
  message: string;
  meta: { instance_id: string | null; projection_identity: string | null };
  ordinary_key: string | null;
  reentry_refused: boolean | null;
  reentry_code: string | null;
  db: string;
}

function probe(scenario: string): Observation {
  fs.mkdirSync(PROBE_ROOT, { recursive: true });
  const home = fs.mkdtempSync(path.join(PROBE_ROOT, `${scenario}-`));
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "test/fixtures/bind-guard-worker.ts", scenario],
    {
      cwd: process.cwd(),
      // Built, not spread: the child inherits nothing, so no knob of this suite's environment can
      // reach the guard. An inherited flag that could relax a check is the defect class this
      // brick exists to close (brick 507a1c38 — "no environment variable may select permissive
      // behaviour"), and a probe that inherits one cannot detect it.
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

test("42b4fb28 bind: this HOME's own admitted identity is accepted (production shape)", () => {
  // The id handed to bindIdentity is READ BACK from the minted instance.json, exactly as
  // acpx-ui sources it (bootInstanceRecord() -> openOrMintInstanceRecord() against the server's
  // real homedir). Nothing is injected into the guard: both sides derive from os.homedir().
  const observed = probe("local-bind");
  assert.equal(observed.threw, false, observed.message);
  assert.equal(observed.meta.instance_id, "i-aaaaaaaaaaaa");
  assert.equal(
    JSON.parse(String(observed.meta.projection_identity)).public_base_url,
    "https://atrium.devbox.nativai.de",
  );
});

test("42b4fb28 bind: a foreign identity is refused and NOTHING is written", () => {
  const observed = probe("foreign-bind");
  assert.equal(observed.threw, true);
  assert.equal(observed.code, "outbox-foreign-bind");
  // The refusal message must name the file a reader has to go look at. A refusal that fires but
  // reads wrong sends the next person to the wrong place.
  assert.match(observed.message, /instance\.json/);
  assert.equal(observed.meta.instance_id, null);
  assert.equal(observed.meta.projection_identity, null);
});

test("42b4fb28 bind: a HOME with no instance.json admits nothing", () => {
  // devbox-staging's workbench is exactly this state — no outbox and no instance.json — and is
  // the fleet's most capturable pod. Absence is a REFUSAL, never a permit.
  const observed = probe("unadmitted-home");
  assert.equal(observed.threw, true);
  assert.equal(observed.code, "outbox-home-unadmitted");
  assert.equal(observed.meta.instance_id, null);
  assert.equal(observed.meta.projection_identity, null);
});

test("42b4fb28 bind: an already-captured outbox cannot re-affirm its capture", () => {
  // bindIdentity's own previous-vs-new check PASSES here (they are equal), so this row can only
  // go green because the identity was checked against instance.json.
  const observed = probe("rebind-poisoned");
  assert.equal(observed.threw, true);
  assert.equal(observed.code, "outbox-foreign-bind");
  assert.equal(observed.meta.projection_identity, null);
});

test("42b4fb28 bind: the SECOND writer — public prepareProjection — is admitted too", () => {
  // checkProjectionInstance writes meta.instance_id from prepareProjection's caller-supplied
  // identity without ever calling bindIdentity. Guarding bindIdentity alone would guard the
  // IDENTIFIER and leave this route open.
  const observed = probe("prepare-projection-foreign");
  assert.equal(observed.threw, true);
  assert.equal(observed.code, "outbox-foreign-bind");
  assert.equal(observed.meta.instance_id, null);
});

test("42b4fb28 bind: the identity meta rows refuse a writer that names neither method", () => {
  // The probe reaches the private writer directly, with a COMPUTED key, so no textual check on
  // the literal could see it. The capability refuses by construction rather than by anyone
  // remembering to route through the guard.
  const observed = probe("setmeta-bypass");
  assert.equal(observed.threw, true);
  assert.equal(observed.code, "outbox-identity-meta-bypass");
  assert.equal(observed.meta.instance_id, null);
});

test("42b4fb28 bind: the SERIALISED identity is checked, not the argument", () => {
  // `projection_identity` — not the scalar — is the row `identityForRecord` compares against
  // instance.json, so it is the row whose poisoning wedges the box. Here the scalar is LOCAL and
  // passes honestly, while `toJSON` returns the 2026-09-15 fixture identity: the argument and the
  // bytes disagree. Measured at acpx 6a0ab15 (before this check) the bind SUCCEEDED, the row held
  // i-twin0000001, and the next identityForRecord threw "identity binding differs from
  // instance.json" — the outage error, straight through the guard.
  //
  // ⚠️ DO NOT "SIMPLIFY" THE PRODUCTION CHECK TO `projection.instance_id`. That is the argument
  // again, and it is the bug this row exists to catch.
  const observed = probe("tojson-payload-swap");
  assert.equal(observed.threw, true);
  assert.equal(observed.code, "outbox-foreign-bind");
  assert.equal(observed.meta.instance_id, null);
  assert.equal(observed.meta.projection_identity, null);
});

test("42b4fb28 bind: caller code cannot re-enter the admission window", () => {
  // The window is a per-instance boolean, so anything that runs CALLER CODE while it is open can
  // write an unchecked identity. `JSON.stringify(projection)` was that: `toJSON` is caller code.
  // The bind's own identity is LOCAL here, so the check passes and the window genuinely opens —
  // only the ORDER of the serialisation decides whether the re-entrant write lands.
  //
  // ⚠️ DO NOT MOVE THE `JSON.stringify` BACK INSIDE THE `try`. It reads as a harmless tidy-up and
  // it re-opens this exact hole: measured at acpx 4c2f5e5, the re-entrant write SUCCEEDED and the
  // outbox ended up carrying `i-twin0000001` — the 2026-09-15 outage identity — while the bind
  // itself reported success.
  const observed = probe("reentrant-tojson");
  assert.equal(observed.threw, false, observed.message);
  assert.equal(observed.reentry_refused, true);
  assert.equal(observed.reentry_code, "outbox-identity-meta-bypass");
  assert.equal(observed.meta.instance_id, "i-aaaaaaaaaaaa");
});

test("42b4fb28 bind: BOUNDARY — a FORGED instance.json in the target HOME is permitted", () => {
  // ⚠️ THIS ROW PINS A NON-GUARANTEE, and it is green on purpose. The guard's whole comparison is
  // against `<HOME>/.acpx/instance.json`, so anything that WRITES that file and then binds a
  // matching identity is admitted. That is a strictly worse and different attack — it corrupts
  // the box's own identity record, which every projection afterwards reads — and brick 42b4fb28
  // does not defend against it. If this row ever goes red, the guard's scope GREW; find out why
  // before changing the row, because a reader is relying on this boundary being where it says.
  const observed = probe("forged-instance-record");
  assert.equal(observed.threw, false, observed.message);
  assert.equal(observed.meta.instance_id, "i-bbbbbbbbbbbb");
});

test("42b4fb28 bind: a COPIED instance.json from another HOME is refused", () => {
  // The near neighbour of the row above, and the reason that boundary is narrower than it looks:
  // a record copied rather than forged still carries the ORIGINAL `home`, and readLocalIdentity
  // refuses on it. The forgery has to be deliberate, not a stray `cp -r`. The id here is
  // well-formed, so this refusal is attributable to the HOME and to nothing else.
  const observed = probe("copied-instance-record");
  assert.equal(observed.threw, true);
  assert.equal(observed.code, "instance-identity-moved");
  assert.equal(observed.meta.instance_id, null);
});

test("42b4fb28 bind: the outage's own identity cannot be laundered through a forgery", () => {
  // `i-twin0000001` is not `i-` + 12 hex, so readLocalIdentity refuses the RECORD before the
  // comparison happens. This row is also the discriminator for the boundary row above: without
  // it, that row's first version read a shape refusal as evidence about the forgery boundary.
  const observed = probe("malformed-instance-record");
  assert.equal(observed.threw, true);
  assert.equal(observed.code, "instance-identity-moved");
  assert.equal(observed.meta.instance_id, null);
});

test("42b4fb28 bind: CONTROL — an ordinary meta key is still writable", () => {
  // Without this row, the refusal above would be consistent with a guard that refuses every
  // setMeta call, i.e. with a probe that proves nothing about the identity rows specifically.
  const observed = probe("setmeta-ordinary-key");
  assert.equal(observed.threw, false, observed.message);
  assert.equal(observed.ordinary_key, "written");
  assert.equal(observed.meta.instance_id, null);
});
