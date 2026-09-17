// brick://3b1ec678 — the two halves of "this suite measures the code, not the box".
//
// ⚠️ THE SECOND ROW IS VACUOUS ON A BOX THAT NEVER SET THE VARIABLE, AND THAT IS WHY
// THE FIRST ONE EXISTS. "no `ACPX_PI_*` in `process.env`" is exactly as green on a box
// with no override as it is on a box whose override was scrubbed — a check that
// survives its own violation. So the scrub itself is proven behaviourally, against an
// env object that provably HAS the override, with a negative control that must survive.
// The second row then reports the one thing the first cannot: whether the bootstrap
// actually ran in THIS process.
//
// This file deliberately does NOT import `./install-owner-reaper.js`. Importing it
// would scrub `process.env` here and make the second row assert its own import rather
// than the suite's bootstrap wiring. Under `pnpm test` the `--import` preload covers
// it; a bare `node --test dist-test/test/box-env-scrub.test.js` on a box that exports
// `ACPX_PI_BOX_AGENT_DIR` reds this row truthfully — that run is unscrubbed.

import assert from "node:assert/strict";
import test from "node:test";
import { BOX_PI_ENV_PREFIX, scrubBoxHarnessEnvOverrides } from "./box-env-scrub.js";

test("3b1ec678: the scrub removes every ACPX_PI_* override and leaves the rest alone", () => {
  const env: NodeJS.ProcessEnv = {
    ACPX_PI_BOX_AGENT_DIR: "/workspace/.runtime/pi-home/agent",
    ACPX_PI_EXTENSIONS_SEED: "off",
    ACPX_SESSION_URL: "https://acpx.devbox.nativai.de/?session=fixture",
    HOME: "/home/node",
  };

  const removed = scrubBoxHarnessEnvOverrides(env);

  assert.deepEqual(removed, ["ACPX_PI_BOX_AGENT_DIR", "ACPX_PI_EXTENSIONS_SEED"]);
  // The negative control: a sweep that emptied the environment would satisfy the
  // assertion above just as well as the correct one.
  assert.deepEqual(Object.keys(env).toSorted(), ["ACPX_SESSION_URL", "HOME"]);
});

test("c2df657e: the scrub removes ACPX_SESSION_RECORD_ID (product-set session identity)", () => {
  const env: NodeJS.ProcessEnv = {
    ACPX_SESSION_RECORD_ID: "11111111-2222-3333-4444-555555555555",
    ACPX_SESSION_URL: "https://acpx.devbox.nativai.de/?session=fixture",
    HOME: "/home/node",
  };

  const removed = scrubBoxHarnessEnvOverrides(env);

  assert.deepEqual(removed, ["ACPX_SESSION_RECORD_ID"]);
  assert.deepEqual(Object.keys(env).toSorted(), ["ACPX_SESSION_URL", "HOME"]);
});

test("c2df657e: the suite starts with no ACPX_SESSION_RECORD_ID in process.env", () => {
  // The sticky-routing extension reads this var per request; an inherited value
  // would flip the "payload untouched" handler rows on a box where the suite runs
  // inside an acpx agent that carries it.
  assert.equal(
    process.env.ACPX_SESSION_RECORD_ID,
    undefined,
    "the suite's bootstrap must scrub the product-set session-identity variable",
  );
});

test("3b1ec678: the suite starts with no box-level ACPX_PI_* override in process.env", () => {
  const leaked = Object.keys(process.env)
    .filter((name) => name.startsWith(BOX_PI_ENV_PREFIX))
    .toSorted();

  assert.deepEqual(
    leaked,
    [],
    `this test process inherited box-level pi override(s) — ${leaked.join(", ")} — so any row ` +
      `asserting the HOME-derived pi agent dir is measuring the box, not the code. The suite's ` +
      `bootstrap (test/install-owner-reaper.ts, loaded by scripts/run-tests.mjs via --import) ` +
      `is supposed to have removed them; either it did not run (a bare \`node --test <file>\`) ` +
      `or it stopped scrubbing.`,
  );
});
