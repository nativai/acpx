/**
 * Minimal, deterministic reproduction of brick 3d213c33's mechanism: a test whose
 * returned/awaited promise never settles. Run directly via `node --test <this file>`
 * (never through `scripts/run-tests.mjs`'s own glob — this file does not end in
 * `.test.js`/`.test.ts` and lives under `test/fixtures/`, so `pnpm test`'s
 * `dist-test/test/*.test.js` glob never picks it up; it would otherwise be a
 * permanent, deliberate red in the mandatory gate).
 *
 * Verified on node v22.23.2: this produces TWO `not ok` rows, both
 * `failureType: 'cancelledByParent'`, with the EXACT error string from the real
 * incident ("Promise resolution is still pending but the event loop has already
 * resolved") — and tallies them under `# cancelled`, never `# fail`.
 */
import test from "node:test";

test("ok before the leak", () => {});

test("leaks a never-resolving promise", async () => {
  await new Promise(() => {});
});

test("ok after the leak — cascades to cancelled too", () => {});
