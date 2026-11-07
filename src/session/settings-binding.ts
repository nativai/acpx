import type { SessionAgentOptions } from "../runtime/engine/session-options.js";
import type { SessionRecord } from "../types.js";

/**
 * brick 6e27669f — what a queue owner's shared client is BOUND to: exactly the record fields the
 * eight settings verbs write (`set model`, `set effort`/`reasoning_effort`, `set outputStyle`,
 * `set profile`, `set subscription`, `set auto-failover`, `set auto-subscription`,
 * `set fable-degrade`). The owner compares this before every turn; a difference makes it rebuild
 * its client in place instead of anyone stopping it.
 *
 * ⚠️ A NEW SETTINGS VERB THAT USED TO RECYCLE THE OWNER MUST ADD ITS FIELD HERE — and a row to
 * NA1's verb table in test/settings-rebind.test.ts. Without the field the owner never sees the
 * change: the setter no longer stops it, so the old value is served until the owner happens to exit.
 *
 * Excluded on purpose: `model_source` (the reconnect guard rewrites it, so it would rebind every
 * turn), and every turn-path or non-verb field (`current_model_id`, `config_options`, `served`,
 * breadcrumbs, `floor_hard`).
 */
export function settingsBindingFingerprint(record: SessionRecord): string {
  const options = record.acpx?.session_options ?? {};
  const desired = record.acpx?.desired_config_options ?? {};
  return JSON.stringify([
    ...BOUND_SESSION_OPTIONS.map((field) => options[field] ?? null),
    ...BOUND_DESIRED_CONFIG_OPTIONS.map((id) => desired[id] ?? null),
  ]);
}

const BOUND_SESSION_OPTIONS = [
  "model",
  "effort",
  "output_style",
  "profile",
  "subscription",
  "auto_failover",
  "auto_subscription",
  "fable_degrade_ok",
] as const;

const BOUND_DESIRED_CONFIG_OPTIONS = ["effort", "reasoning_effort", "outputStyle"] as const;

const SETTINGS_FLAG_KEYS = [
  "model",
  "modelSource",
  "reasoningEffort",
  "outputStyle",
  "profile",
  "subscription",
  "autoFailover",
  "autoSubscription",
  "fableDegradeOk",
] as const satisfies ReadonlyArray<keyof SessionAgentOptions>;

/**
 * The owner's spawn-time options without the settings the verbs own. Those flags are PREFERRED
 * over the record at every merge, so once a verb has changed the record they would win it back;
 * dropped, the record wins — as it does for an owner spawned by a flagless prompt.
 */
export function withoutSettingsFlags(
  options: SessionAgentOptions | undefined,
): SessionAgentOptions | undefined {
  if (!options) {
    return undefined;
  }
  const kept: SessionAgentOptions = { ...options };
  for (const key of SETTINGS_FLAG_KEYS) {
    delete kept[key];
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}
