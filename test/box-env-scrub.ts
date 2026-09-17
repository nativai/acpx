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
 * Delete every box-level `ACPX_PI_*` override and every session-identity variable
 * from `env`, returning the names removed (sorted) so a caller can assert on what
 * actually happened rather than on the absence of a complaint.
 *
 * Called once from the `--import` bootstrap (`install-owner-reaper.ts`), before any
 * test module body runs and therefore before any row spawns a CLI child — the children
 * are spawned from `process.env`, so removing it here removes it from them too.
 */
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
  return removed.toSorted();
}
