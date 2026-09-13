/**
 * THE PERSISTED-STATE CONTRACT — one fully-populated `acpx` value that every
 * field-by-field transform in this repo must carry through intact.
 *
 * ## Why this file exists (brick 576d8090, from 4c272cab PM-1)
 *
 * `parseSessionRecord` is an ALLOWLIST. So is `cloneSessionAcpxState`. So is the
 * index-entry projection, and so is the session-options breadcrumb copy. Between
 * them they have silently dropped **four** persisted fields:
 *
 * | field | brick | how it was found |
 * |---|---|---|
 * | `applied_output_style` | 874fee67 | in production |
 * | `served` | 07dd62c9 | in production |
 * | `depth_projection` | B3 | in production |
 * | `last_turn_provider` | 4c272cab PM-1 | in production, by a post-merge smoke |
 *
 * **Not one of them was caught by the suite**, and the reason is structural:
 * `serializeSessionRecordForDisk` passes `acpx` through **wholesale**
 * (`acpx: canonical.acpx`) while every READER rebuilds it key by key. So a
 * write-only test writes the field, reads its own object back, and passes — while
 * in production the next reader drops it and the next writer persists the loss.
 * The asymmetry is the whole bug family: **writes are total, reads are allowlists.**
 *
 * `PROJECT.md` has warned about this in prose since the first occurrence. A
 * warning has now failed four times, which is the argument for a mechanism.
 *
 * ## How the guard works — two halves, and neither is sufficient alone
 *
 * 1. **THIS OBJECT IS EXHAUSTIVE BY COMPILATION.** `satisfies Required<SessionAcpxState>`
 *    means a new key on the type that is not given a sentinel here **fails
 *    `pnpm run typecheck`**, by name. It cannot be forgotten, because the
 *    compiler will not accept the file without it.
 * 2. **`test/persisted-allowlist-roundtrip.test.ts` drives every transform with
 *    it** and asserts key by key. A key that is registered here but missing from
 *    a transform's allowlist reds that row **naming the field**.
 *
 * ⇒ (1) forces registration; (2) forces the legs. A new persisted field cannot
 * pass both without actually surviving the round trip — which is the property
 * four bricks' worth of prose could not enforce.
 *
 * ## ⚠️ IF YOU ARE HERE BECAUSE typecheck JUST FAILED ON THIS FILE
 *
 * You added a field to `SessionAcpxState`. That is the guard working. Give it a
 * sentinel below — then run the round-trip test, and expect it to fail until you
 * have added your field to **every** allowlist it names. That failure list is the
 * work item, and it is exactly what the four fields above never got.
 *
 * ⚠️ **SENTINELS ARE DISTINCT ON PURPOSE.** Every string is unique, so a
 * transform that copies the *wrong* field into a slot is caught too — an
 * equality test over identical placeholders would pass on a crossed wire.
 *
 * ⚠️ **THIS LIVES IN `src/`, NOT `test/`, DELIBERATELY.** `tsconfig.json` (what
 * `pnpm run typecheck` uses) includes `src/**` only. In `test/` the exhaustiveness
 * check would fire only inside `build:test` — and this repo already knows that a
 * failed `build:test` leaves the previous `dist-test/` in place, so `node --test`
 * happily reports green for code that did not compile (`PROJECT.md`). A guard
 * whose failure can be read as a pass is not a guard.
 */

import type { SessionAcpxState } from "../../types.js";

/**
 * One value per persisted `acpx.*` key. See the header before editing.
 *
 * The type annotation is `satisfies`, not `:`, so the literal keeps its narrow
 * type — a test can read a sentinel back and compare it without widening.
 */
export const PERSISTED_ACPX_SENTINEL = {
  reset_on_next_ensure: true,
  current_mode_id: "sentinel-current-mode",
  desired_mode_id: "sentinel-desired-mode",
  desired_config_options: { effort: "sentinel-desired-effort" },
  current_model_id: "sentinel-current-model",
  applied_output_style: "sentinel-applied-style",
  refused_output_style: "sentinel-refused-style",
  context_window_size: 987_654,
  context_window_model_id: "sentinel-window-model",
  available_models: ["sentinel-available-model"],
  available_commands: ["sentinel-available-command"],
  progress: { phase: "thinking", label: "sentinel-progress-label" },
  config_options: [
    {
      type: "boolean",
      currentValue: true,
      id: "sentinel-option",
      name: "sentinel-option-name",
    },
  ],
  owner_options: { permission_mode: "approve-all" },
  cost: {
    amount: 12.34,
    currency: "USD",
    provenance: "computed",
    coverage: { unit: "message", priced: 1, total: 1 },
  },
  cost_units: [
    {
      input: 11,
      output: 22,
      reasoning: 7,
      cache_read: 33,
      cache_write: 44,
      rates: null,
      ts: "2026-09-10T00:00:01.000Z",
      model: "sentinel-unit-model",
      cost_usd: 1.5,
      provider_name: "SentinelProvider",
      native_finish_reason: "sentinel-native-finish",
      response_id: "sentinel-unit-response-id",
    },
  ],
  served: {
    model: "sentinel-served-model",
    effort: "sentinel-served-effort",
    at: "2026-09-10T00:00:02.000Z",
    source: "sentinel-served-source",
  },
  last_turn_provider: {
    provider_name: "SentinelLastProvider",
    native_finish_reason: "sentinel-last-native",
    // ⚠️ A NESTED KEY NEEDS ITS OWN SENTINEL (brick d07129e7 residual, and
    // brick 77054e85 is the first field to actually exercise it). The compiler
    // half of this guard only forces the TOP-LEVEL keys — `satisfies
    // Required<SessionAcpxState>` says nothing about a new optional field INSIDE
    // `last_turn_provider`. What catches a dropped nested key is the round-trip
    // row's `deepEqual` over the whole block, and that only fires if the value
    // is here to be compared. Omit it and the parse leg can silently stop
    // carrying `response_id` with every row green.
    response_id: "sentinel-last-response-id",
    at: "2026-09-10T00:00:03.000Z",
  },
  harness_config_dir: "/tmp/sentinel-harness-config-dir",
  pi_session_dir: "/tmp/sentinel-pi-session-dir",
  model_set_unsupported_for: "sentinel-model-set-unsupported",
  depth_projection: {
    requested: "sentinel-depth-requested",
    outcome: "sentinel-depth-outcome",
    served: "sentinel-depth-served",
    reason: "sentinel-depth-reason",
  },
  served_below_floor: {
    served_model: "sentinel-below-floor-model",
    served_effort: "sentinel-below-floor-effort",
    pinned_model: "sentinel-below-floor-pinned-model",
    pinned_effort: "sentinel-below-floor-pinned-effort",
    at: "2026-09-10T00:00:05.000Z",
  },
  floor_parked: {
    at: "2026-09-10T00:00:06.000Z",
    reason: "sentinel-parked-reason",
    observed_model: "sentinel-parked-observed",
  },
  session_options: {
    model: "sentinel-option-model",
    allowed_tools: ["sentinel-allowed-tool"],
    max_turns: 7,
    system_prompt: "sentinel-system-prompt",
    subscription: "sentinel-subscription",
    profile: "sentinel-profile",
    effort: "sentinel-effort",
    output_style: "sentinel-output-style",
    auto_failover: true,
    floor_hard: true,
    auto_subscription: true,
    fable_degrade_ok: true,
    model_source: "sentinel-model-source",
    model_guard: {
      blocked: "sentinel-guard-blocked",
      forced_to: "sentinel-guard-forced-to",
      source: "sentinel-guard-source",
      at: "2026-09-10T00:00:07.000Z",
    },
    fable_degrade: {
      from: "sentinel-degrade-from",
      to: "sentinel-degrade-to",
      at: "2026-09-10T00:00:08.000Z",
    },
    subscription_switch: {
      from: "sentinel-switch-from",
      to: "sentinel-switch-to",
      reason: "manual",
      at: "2026-09-10T00:00:09.000Z",
    },
    account_switch: {
      toProfile: "sentinel-account-to-profile",
      toAccount: "sentinel-account-to-account",
      reason: "manual",
      at: "2026-09-10T00:00:10.000Z",
    },
    provisioning_warning: {
      at: "2026-09-10T00:00:11.000Z",
      profile_id: "sentinel-warning-profile",
      auth_mode: "sentinel-warning-auth-mode",
      adapter: "sentinel-warning-adapter",
      anchor: "sentinel-warning-anchor",
      message: "sentinel-warning-message",
    },
    routing_policy_warning: {
      file: "/tmp/sentinel-routing-warning.json",
      reason: "sentinel-routing-reason",
      at: "2026-09-10T00:00:12.000Z",
    },
    served_via_shim: true,
  },
} as const satisfies Required<SessionAcpxState>;
