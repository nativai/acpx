// Box API credentials that never reach an agent (brick 1dc24c1c, Daniel 2026-10-24).
//
// WHY: an agent's environment is inherited by everything it runs — its shell, every
// `workbench-exec` command, every dev server it starts. `dotenv` and `@next/env` never
// override a variable that is already set, so a box credential in the agent env silently
// REPLACES the project's own `.env` value (labidio 2026-10-23: the box OpenRouter key
// overrode the project key and a guardrail 404 read as a broken staging chat).
//
// THE RULE: agent API access goes through Cardea, never an ambient variable. These names are
// either delivered some other way (`OPENROUTER_API_KEY` → pi's per-session `auth.json` file
// reference, see `writePiAuthFile`; the Claude OpenRouter shim takes the key as a parameter),
// replaced by a Cardea grant (`FAL_KEY` → Cardea `fal`), or read only by the acpx-ui SERVER,
// which keeps them in its own environment (`QDRANT_API_KEY`, `ACPX_EMBED_API_KEY`,
// `CLICKHOUSE_PASSWORD`).
//
// ⚠️ THIS IS A NAME LIST ON PURPOSE, NOT A `*_KEY` PATTERN. Non-secret environment stays
// generous, and `GITHUB_TOKEN` / `BROWSERLESS_TOKEN` are kept by decision (read-only PAT; a
// cluster-internal service token every browser test needs). A pattern would take both.
export const AGENT_STRIPPED_CREDENTIAL_ENV = [
  "OPENROUTER_API_KEY",
  "FAL_KEY",
  "QDRANT_API_KEY",
  "ACPX_EMBED_API_KEY",
  "CLICKHOUSE_PASSWORD",
] as const;

/** acpx's own prefixed form (`promotePrefixedAuthEnvironment`, `assignAuthCredentialEnv`). */
const AUTH_ENV_PREFIX = "ACPX_AUTH_";

/**
 * Remove every stripped credential from a child environment, under its plain name AND its
 * `ACPX_AUTH_` prefixed form. The prefixed form must go too: it would survive into the agent
 * and be promoted back to the plain name by the next acpx that agent runs.
 */
export function deleteAgentStrippedCredentialEnv(env: NodeJS.ProcessEnv): void {
  for (const name of AGENT_STRIPPED_CREDENTIAL_ENV) {
    delete env[name];
    delete env[`${AUTH_ENV_PREFIX}${name}`];
  }
}
