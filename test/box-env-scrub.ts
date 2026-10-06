// brick://3b1ec678 — the suite must measure THE CODE, not the box it runs on.
//
// WHAT WENT WRONG. `dev-server-platform`'s `entrypoint.sh` (argocd 6188bb4) began
// exporting `ACPX_PI_BOX_AGENT_DIR=/workspace/.runtime/pi-home/agent` into EVERY
// process on every rolled dev box — and appending it to `~/.ssh/environment`, so it
// reaches agent shells too. `resolveBoxPiAgentDir` (`src/acp/harness-config-dir.ts`)
// honours that variable at FIRST precedence, by design: it is the operator's escape
// hatch. So every test row that asserts the HOME-derived placement (`<HOME>/.pi/agent/
// …`) started measuring the box instead of the code, and `pnpm test` went red on
// origin/dev 5e9d5e5 — four pi REAL-SPAWN rows, three in `config-dir-terminal-close.
// test.ts` and one in `connect-load.test.ts` — with no repo change to blame it on.
//
// WHY A SCRUB AND NOT A PER-ROW `env -u`. The rows are not wrong: they exercise the
// documented default, and the default is what they must pin. What is wrong is the
// suite inheriting a BOX-level operator override at all — a row that wants it sets it
// explicitly (`harness-config-dir.test.ts` does exactly that for its own rows, saving
// and restoring `process.env.ACPX_PI_BOX_AGENT_DIR` around the block it belongs to).
// Scrubbing at the bootstrap makes the suite's starting environment a property of the
// repo rather than of whichever box the gate happens to run on.
//
// ⚠️ THE SWEEP IS BY PREFIX, NOT BY A LIST OF NAMES. A hand-maintained list would be
// correct today and silently incomplete the next time the platform exports one more
// `ACPX_PI_*` knob — and the failure would look exactly like this one did: a red the
// repo cannot explain. The prefix is the same one the product uses for its box-level
// pi overrides, so a new knob is scrubbed by construction.
//
// ⚠️ KNOWN RESIDUAL, NOT SCRUBBED. pi's OWN `PI_CODING_AGENT_DIR` is precedence 2 in
// `resolveBoxPiAgentDir`, so a box that exported it would skew the same rows. No box
// does today (measured on devbox 2026-09-10: the only ambient pi variable is
// `ACPX_PI_BOX_AGENT_DIR`), and widening the sweep onto pi-native names is a separate
// decision from removing acpx's own box overrides — so it is named here rather than
// done silently.
//
// brick c2df657e — SESSION-IDENTITY SCRUB, same mechanism, different category.
// `ACPX_SESSION_RECORD_ID` is set on every acpx-spawned agent (buildAgentEnvironment)
// and those agents run THIS suite through workbench-exec with their whole env — so
// once the OpenRouter sticky-routing extension ships, the handler rows that assert
// "payload untouched" would red on the box for an env the repo never wrote. Same
// poisoning-by-inheritance mechanism as the `ACPX_PI_*` sweep, so the same remedy.
// A list of one, by name: there is exactly one variable that changes test behaviour
// today, and the `ACPX_PI_` prefix cannot cover it.

/** The prefix every BOX-level acpx pi override shares. */
export const BOX_PI_ENV_PREFIX = "ACPX_PI_";

/** Session-identity variables the PRODUCT sets on agents that then run this suite. */
export const SESSION_IDENTITY_ENV = ["ACPX_SESSION_RECORD_ID"] as const;

/**
 * brick ecfb0461 — THE SUITE MUST NEVER SEND THE BOX'S OpenRouter KEY OVER THE WIRE.
 *
 * Same family as the two scrubs above (make the starting environment a property of
 * the repo, not of the box) but it SETS rather than deletes, because the hazard runs
 * the other way. `loadOpenRouterEntitlement` asks the key what it allows
 * (`GET /api/v1/models/user`), and any row reaching `loadCatalogue` **without** an
 * isolated `ACPX_STATE_HOME` would resolve devbox's real `providers.json`, find a
 * real credential and make a real authenticated call — slow, flaky, and a credential
 * leaving the box on every gate run.
 *
 * ⚠️ **THE PUBLIC CATALOGUE LOADER IS NOT THE PRECEDENT TO COPY HERE.** It has the
 * same cold-cache-fetches shape and the repo tolerates it — but it is *keyless*, so
 * the worst case is a wasted request. Adding a credential to that shape is a new
 * class of exposure, and it is not one to leave to "tests happen to isolate HOME":
 * the store guard in `runtime-test-helpers.ts` is opt-in per test, not global.
 *
 * With this set, a cold cache simply reads as UNKNOWN and the product fails open —
 * which is the production behaviour a test should be measuring anyway. A row that
 * genuinely wants a populated set injects one (`buildCatalogue`'s `entitlement`
 * option, or `entitlementCachePath` at a fixture).
 */
export const NO_ENTITLEMENT_FETCH_ENV = "ACPX_NO_OPENROUTER_ENTITLEMENT_FETCH";

/**
 * brick c85c42bf — `sessions activate` POSTs its notice to this box's acpx-ui. Same family as
 * the guard above (the suite must never touch the box), and it SETS: a dead port, so a row
 * that does not stub the origin gets a fast "unreachable" instead of reaching the real
 * acpx-ui through the namespace-derived cluster-internal URL. A row that wants a stub
 * overrides it in its own child env (`test/seat-activate-notice-delivery.test.ts`).
 */
export const NOTICE_DELIVERY_DEAD_ORIGIN = "http://127.0.0.1:9";

/**
 * Delete every box-level `ACPX_PI_*` override and every session-identity variable
 * from `env`, and set the no-network guards and the no-runtime-info seam above. Returns the names removed (sorted)
 * so a caller can assert on what actually happened rather than on the absence of a
 * complaint.
 *
 * Called once from the `--import` bootstrap (`install-owner-reaper.ts`), before any
 * test module body runs and therefore before any row spawns a CLI child — the children
 * are spawned from `process.env`, so a change here reaches them too.
 */
/**
 * brick ebfe4c3c — the Claude model-advertisement cache is KEYED by the deployed
 * adapter's sha, read from `/workspace/.runtime/info.json`. That is box state: a
 * row reading it would key on whatever this box happens to have deployed, and flip
 * between boxes and across every refresh. So the suite points the seam at a path
 * that does not exist, and the key degrades to `{adapterSha: null, …}` — the same
 * shape a non-box install produces. A row that wants a sha writes its own fixture
 * info.json and passes it explicitly.
 */
export const RUNTIME_INFO_PATH_ENV = "ACPX_RUNTIME_INFO_PATH";
export const NO_RUNTIME_INFO_PATH = "/nonexistent/acpx-test/runtime-info.json";

export function scrubBoxHarnessEnvOverrides(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (
      name.startsWith(BOX_PI_ENV_PREFIX) ||
      (SESSION_IDENTITY_ENV as readonly string[]).includes(name)
    ) {
      delete env[name];
      removed.push(name);
    }
  }
  env[NO_ENTITLEMENT_FETCH_ENV] = "1";
  env.ACPX_UI_INTERNAL_URL = NOTICE_DELIVERY_DEAD_ORIGIN;
  env[RUNTIME_INFO_PATH_ENV] = NO_RUNTIME_INFO_PATH;
  return removed.toSorted();
}
