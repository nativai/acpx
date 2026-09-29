/**
 * Print the OpenRouter key's `scope.models` list, GENERATED from
 * `src/models/openrouter-entitlement.ts` (brick daed4261 §9).
 *
 *   pnpm run openrouter:entitlement              # the full JSON envelope
 *   pnpm run openrouter:entitlement -- --models  # the bare list, one id per line
 *
 * 🛑 **THIS IS THE ONLY SANCTIONED WAY TO PRODUCE THAT LIST. NEVER TYPE IT.** Cardea
 * validates `scope.models` not at all — it passes verbatim into the key's
 * `allowed_models` guardrail — so a typo is accepted end-to-end by Cardea AND by
 * OpenRouter and enforces NOTHING, silently. The infra agent staging a mint pastes
 * this output; it does not transcribe it.
 *
 * Record the `sha` alongside the grant, and write it into the new key's
 * `providers.json` entry as `entitlementSha`. That is what lets acpx prove at spawn
 * that its own allowed set and the key's came from one list — with no network and no
 * management key — and so keeps a non-entitled model producing a legible spawn-time
 * refusal instead of a provider 403 that nothing interprets.
 *
 * Deliberately a script rather than an `acpx` verb: a new top-level verb needs TWO
 * registrations (`registerDefaultCommands` AND `TOP_LEVEL_VERBS`, `src/cli-core.ts`)
 * and one alone fails **silently** — the token is parsed as an agent name with the
 * rest of the line as a prompt. The guarantee under test is `entitlementModelIds()`
 * itself, which `test/openrouter-entitlement.test.ts` pins; this file is a wrapper
 * over it and holds no list of its own.
 */

import {
  entitlementModelIds,
  OPENROUTER_ENTITLEMENT,
  OPENROUTER_ENTITLEMENT_MEASURED_AT,
  OPENROUTER_ENTITLEMENT_SHA,
  OPENROUTER_ENTITLEMENT_SOURCE,
  OPENROUTER_GREEN_LIST,
} from "../src/models/openrouter-entitlement.js";

const models = entitlementModelIds();

if (process.argv.includes("--models")) {
  process.stdout.write(`${models.join("\n")}\n`);
} else {
  process.stdout.write(
    `${JSON.stringify(
      {
        sha: OPENROUTER_ENTITLEMENT_SHA,
        measuredAt: OPENROUTER_ENTITLEMENT_MEASURED_AT,
        source: OPENROUTER_ENTITLEMENT_SOURCE,
        modelCount: OPENROUTER_ENTITLEMENT.length,
        greenListed: OPENROUTER_GREEN_LIST.map((entry) => entry.slug),
        models,
      },
      null,
      2,
    )}\n`,
  );
}
