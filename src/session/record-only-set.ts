import { harnessIdForAgentCommand } from "../acp/harness-capabilities.js";
import type { SessionRecord } from "../types.js";
import {
  modelSetMethodKnownUnsupported,
  setCurrentModelId,
  setDesiredModelId,
  setDesiredModelSource,
} from "./mode-preference.js";
import { flattenSelectValues } from "./model-application.js";

/**
 * Ownerless `acpx <agent> set …` (brick 5c44d8ba, DESIGN §2, §6 T1): may the setting be written to
 * the record alone, with no adapter started? Pure — no I/O.
 *
 * The direct connect never made a setting take effect sooner: its adapter is closed before the verb
 * returns, and the next turn's fresh owner replays the record anyway. What it bought was a live
 * adapter's check of the value. Where the record already holds that adapter's own advertisement for
 * the model the next connect serves, the check is answered here and nothing starts.
 *
 * ⚠️ THE RECORD ONLY EVER SAYS YES (DESIGN Q2). Every other answer is `live`: the gated direct
 * connect runs and the adapter decides. Do not add a record-side refusal here — atrium offers rungs
 * from its own catalogue, and a refusal acpx invents from a possibly stale snapshot is a new
 * "offered, then refused" path (brick e6e74bf5's class).
 */
export type RecordOnlyVerdict = { kind: "record" } | { kind: "live"; reason: string };

const RECORD: RecordOnlyVerdict = { kind: "record" };

/**
 * DESIGN §2 condition 3: does the stored advertisement describe the model the next connect serves?
 * The snapshot names its model as the `model` option's `currentValue` (else a `category:"model"`
 * option's). No model option at all (codex) is no evidence of staleness.
 *
 * ⚠️ DO NOT RELAX THIS TO "THE LADDERS USUALLY AGREE". Per-model ladders are real — the live census
 * (conception/census-2026-11-07.md §3) has `sonnet` with and without `xhigh` — and a `default`
 * snapshot on an opus-pinned session cannot vouch for opus's rungs. It is also what keeps
 * model-then-depth correct while ownerless: a record-only `set model` moves `session_options.model`
 * but not the snapshot, so the following `set effort` goes live and is checked against the new
 * model's ladder. Rows "N3" in test/record-only-set.test.ts.
 */
export function advertisementDescribesNextModel(record: SessionRecord): boolean {
  const modelOption = snapshotModelOption(record);
  if (!modelOption) {
    return true;
  }
  const next = nextServedModel(record);
  return next !== undefined && modelOption.currentValue === next;
}

function snapshotModelOption(record: SessionRecord) {
  const options = record.acpx?.config_options ?? [];
  return (
    options.find((option) => option.id === "model") ??
    options.find((option) => option.category === "model")
  );
}

/** The model the next connect asks for: the desired pin, else the last served one. */
function nextServedModel(record: SessionRecord): string | undefined {
  return record.acpx?.session_options?.model ?? record.acpx?.current_model_id;
}

export function recordOnlyModelVerdict(record: SessionRecord): RecordOnlyVerdict {
  // UMQ K7: a sleeping record has no adapter to ask and nothing to be stale against — the pin is
  // written and the first wake's preference replay applies (or loudly refuses) it.
  if (record.acpx?.sleeping) {
    return RECORD;
  }
  if (harnessIdForAgentCommand(record.agentCommand) === undefined) {
    return { kind: "live", reason: "unclassified-adapter" };
  }
  if ((record.acpx?.available_models ?? []).length === 0) {
    return { kind: "live", reason: "no-available-models" };
  }
  // A learned `-32601` for THIS adapter: go live so the F-12 re-probe still happens.
  if (modelSetMethodKnownUnsupported(record)) {
    return { kind: "live", reason: "model-set-known-unsupported" };
  }
  return RECORD;
}

function advertisesValue(option: { type?: unknown; options?: unknown }, value: string): boolean {
  if (option.type === "boolean") {
    return value === "true" || value === "false";
  }
  if (option.type !== "select" || !Array.isArray(option.options)) {
    return false;
  }
  return flattenSelectValues(option.options).some((entry) => entry.value === value);
}

/**
 * ⚠️ `mode` IS NEVER RECORD-ONLY (G4). It writes `desired_mode_id`, and the mode replay is the one
 * that throws and kills the next turn (`replayDesiredMode`): an unvetted mode in the record is a dead
 * session, not a degraded one. Row "N4" in test/record-only-set.test.ts.
 */
export function recordOnlyConfigOptionVerdict(
  record: SessionRecord,
  configId: string,
  value: string,
): RecordOnlyVerdict {
  if (record.acpx?.sleeping) {
    return RECORD; // UMQ K7 — see recordOnlyModelVerdict
  }
  if (configId === "mode") {
    return { kind: "live", reason: "mode" };
  }
  if (harnessIdForAgentCommand(record.agentCommand) === undefined) {
    return { kind: "live", reason: "unclassified-adapter" };
  }
  const option = (record.acpx?.config_options ?? []).find((entry) => entry.id === configId);
  if (!option) {
    return { kind: "live", reason: "not-advertised" };
  }
  if (!advertisesValue(option, value)) {
    return { kind: "live", reason: "value-not-advertised" };
  }
  if (!advertisementDescribesNextModel(record)) {
    return { kind: "live", reason: "stale-advertisement" };
  }
  return RECORD;
}

/** The owner arm's own write for `set model` (session-control.ts), with provenance "explicit". */
export function writeModelPin(record: SessionRecord, modelId: string): void {
  setDesiredModelId(record, modelId);
  setCurrentModelId(record, modelId);
  setDesiredModelSource(record, "explicit");
}
