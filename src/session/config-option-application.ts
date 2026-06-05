import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { withTimeout } from "../async-control.js";
import type { SessionRecord } from "../types.js";
import { applyConfigOptionsToRecord } from "./config-options.js";
import { getDesiredConfigOptions, setDesiredConfigOption } from "./mode-preference.js";

/** Minimal client surface so this is unit-testable with a stub. */
export interface ConfigOptionApplyClient {
  setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<{ configOptions?: SessionConfigOption[] }>;
}

/** Whether the advertised option set includes a given config id (e.g. `effort`). */
export function advertisesConfigOption(
  advertised: SessionConfigOption[] | undefined,
  configId: string,
): boolean {
  return (advertised ?? []).some((option) => option.id === configId);
}

// Apply one config option to the live session when it is advertised, the value
// is a supported (model-coupled) level, and it differs from the current value —
// otherwise skip (never error: "layer on top, never break"). Returns the
// set-response (for record capture) or undefined when skipped.
async function applyConfigOptionIfAdvertised(params: {
  client: ConfigOptionApplyClient;
  sessionId: string;
  configId: string;
  value: string;
  advertised: SessionConfigOption[];
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<{ configOptions?: SessionConfigOption[] } | undefined> {
  const option = params.advertised.find((entry) => entry.id === params.configId);
  if (!option || option.type !== "select") {
    return undefined; // not advertised, or not a selectable option (e.g. codex effort)
  }
  if (!selectableValues(option).has(params.value)) {
    if (params.verbose) {
      process.stderr.write(
        `[acpx] config option ${params.configId}=${params.value} is not an advertised level for this model; skipping\n`,
      );
    }
    return undefined; // model-coupled level unsupported → skip
  }
  if (option.currentValue === params.value) {
    return undefined; // already at the requested value
  }
  return await withTimeout(
    params.client.setSessionConfigOption(params.sessionId, params.configId, params.value),
    params.timeoutMs,
  );
}

/**
 * Apply the record's desired config options (e.g. `effort`) to the live ACP
 * session at creation — the config-option analogue of
 * `applyRequestedModelIfAdvertised`. It is `replayDesiredConfigOptions`
 * (reconnect.ts) run at creation against the create-result's advertised options,
 * plus the advertised-value guard above. The set-response's refreshed options are
 * captured back onto the record.
 *
 * NOTE: the deployed claude-agent-acp (0.39.0) rebuilds the advertised `effort`
 * `currentValue` from the global settings default on every response, so the live
 * snapshot may NOT reflect the just-applied per-session level — the durable
 * signal is `acpx.desired_config_options.effort`, written by the caller.
 */
export async function applyRequestedConfigOptionsIfAdvertised(params: {
  client: ConfigOptionApplyClient;
  sessionId: string;
  record: SessionRecord;
  advertised: SessionConfigOption[] | undefined;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  const desired = getDesiredConfigOptions(params.record.acpx);
  const advertised = params.advertised ?? [];

  for (const [configId, value] of Object.entries(desired)) {
    const response = await applyConfigOptionIfAdvertised({
      client: params.client,
      sessionId: params.sessionId,
      configId,
      value,
      advertised,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
    if (response) {
      applyConfigOptionsToRecord(params.record, response);
    }
  }
}

/**
 * Creation-site entry point for the `--reasoning-effort` spawn flag on the
 * record-backed paths (`sessions new`/`ensure`, persistent `prompt`). Persists
 * the requested level as the durable intent (`acpx.desired_config_options.effort`)
 * and applies it live before the first prompt — but ONLY when the session
 * advertises an `effort` option, so a non-claude agent (e.g. codex) never gains
 * an effort field and the flag is a silent no-op there (the CLI emits the
 * user-facing "ignored" warning).
 */
export async function persistAndApplyRequestedEffort(params: {
  client: ConfigOptionApplyClient;
  sessionId: string;
  record: SessionRecord;
  reasoningEffort: string | undefined;
  advertised: SessionConfigOption[] | undefined;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.reasoningEffort || !advertisesConfigOption(params.advertised, "effort")) {
    return;
  }
  setDesiredConfigOption(params.record, "effort", params.reasoningEffort);
  await applyRequestedConfigOptionsIfAdvertised({
    client: params.client,
    sessionId: params.sessionId,
    record: params.record,
    advertised: params.advertised,
    timeoutMs: params.timeoutMs,
    verbose: params.verbose,
  });
}

/**
 * `exec` variant — the one-shot path has no persisted record, so this applies
 * the effort live to the ephemeral session for the single turn (no persistence).
 * Same advertised/supported/differing guard, so codex `exec` is a no-op.
 */
export async function applyExecReasoningEffort(params: {
  client: ConfigOptionApplyClient;
  sessionId: string;
  reasoningEffort: string | undefined;
  advertised: SessionConfigOption[] | undefined;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.reasoningEffort) {
    return;
  }
  await applyConfigOptionIfAdvertised({
    client: params.client,
    sessionId: params.sessionId,
    configId: "effort",
    value: params.reasoningEffort,
    advertised: params.advertised ?? [],
    timeoutMs: params.timeoutMs,
    verbose: params.verbose,
  });
}

function selectableValues(option: SessionConfigOption): Set<string> {
  const values = new Set<string>();
  if (option.type !== "select") {
    return values;
  }
  for (const entry of option.options) {
    if ("value" in entry) {
      values.add(entry.value);
    } else {
      for (const grouped of entry.options) {
        values.add(grouped.value);
      }
    }
  }
  return values;
}
