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
  return JSON.stringify(settingsBindingSlots(record));
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

type BindingSlots = Array<[slot: string, value: unknown]>;

function settingsBindingSlots(record: SessionRecord): BindingSlots {
  const options = record.acpx?.session_options ?? {};
  const desired = record.acpx?.desired_config_options ?? {};
  const metadata = record.metadata ?? {};
  return [
    ["metadata.principal_id", metadata.principal_id ?? null],
    ["metadata.principal_name", metadata.principal_name ?? null],
    ...BOUND_SESSION_OPTIONS.map((field): [string, unknown] => [
      `session_options.${field}`,
      options[field] ?? null,
    ]),
    ...BOUND_DESIRED_CONFIG_OPTIONS.map((id): [string, unknown] => [
      `desired_config_options.${id}`,
      desired[id] ?? null,
    ]),
  ];
}

// The slots a turn writes from its OWN options (a per-task `prompt --model X` /
// `--reasoning-effort`, or the owner's spawn-time flags): `applyPromptModelIfAdvertised` pins the
// model, the effort application writes both effort slots.
const TURN_OWN_WRITES: ReadonlyArray<readonly [slot: string, option: "model" | "reasoningEffort"]> =
  [
    ["session_options.model", "model"],
    ["session_options.effort", "reasoningEffort"],
    ["desired_config_options.effort", "reasoningEffort"],
  ];

/**
 * brick 6e27669f F1 — the binding after a turn that wrote settings from its own options. The
 * client already serves those values (the turn applied them live), so they are bound: without this
 * the NEXT turn saw "the record moved" and rebound for nothing, killing the session's live
 * background tasks (9df709f4 VERIFICATION F1: one restart per `--model` switch).
 *
 * ⚠️ PER SLOT, AND ONLY WHERE THE RECORD HOLDS EXACTLY THE TURN'S OWN VALUE. A blanket re-baseline
 * at turn end would swallow an outside set that landed mid-turn (an output style, or a set whose
 * turn-in-flight check went stale) — GA2 says that set rebinds the next turn. A slot whose record
 * value differs from the turn's own value is left alone, so that set still rebinds. Rows "F1" in
 * test/settings-rebind.test.ts.
 */
export function bindTurnOwnWrites(
  bound: string,
  record: SessionRecord,
  turnOptions: SessionAgentOptions | undefined,
): string {
  const slots = new Map(JSON.parse(bound) as BindingSlots);
  const now = new Map(settingsBindingSlots(record));
  for (const [slot, option] of TURN_OWN_WRITES) {
    const own = turnOptions?.[option];
    if (own !== undefined && now.get(slot) === own) {
      slots.set(slot, own);
    }
  }
  return JSON.stringify([...slots]);
}

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
