import type { SessionAcpxState, SessionRecord } from "../../types.js";
import { DURABLE_OVERLAY_FIELDS } from "../mode-preference.js";

/**
 * Baseline of the durable preference options a writer started from — the analogue of
 * `model-merge.ts` / `metadata-merge.ts` for everything `mergeLatestDurableAcpxPreferences`
 * protects at the turn CHECKPOINT: `desired_mode_id`, `desired_config_options.*` and the
 * `session_options` fields in `DURABLE_OVERLAY_FIELDS`. Captured on parse and re-captured
 * after every persist, so a stale write can be told from a deliberate change at persist time.
 *
 * ⚠️ WHY THE WRITER AND NOT EACH CALLER (brick://34f5f588). The checkpoint merges these from
 * disk, but the turn's other record writes did not: `recordPromptStart` assigns
 * `record.acpx = <clone taken when the turn loaded the record>` and writes it, so an
 * `acpx set outputStyle` accepted between that load and that write was put back to the OLD
 * value (lost 4/16 on dev be2b3860, only outputStyle is accepted mid-turn so only it showed).
 * Merging in the one funnel (`writeSessionRecordInternal`, inside the record lock) covers the
 * prompt-start write, the injected-prompt prompt-start, the pin flush, the guard/floor/degrade
 * writes and the turn-end writes alike, and any writer added later.
 */
export type DurableOptionsBaseline = {
  modeId: string | undefined;
  configOptions: Record<string, string>;
  sessionOptions: Record<string, unknown>;
};

// `model` is protected by `model-merge.ts` (which also self-heals a lost pin); every other
// overlay field is protected here.
const FIELDS = DURABLE_OVERLAY_FIELDS.filter((field) => field !== "model");

const baselines = new WeakMap<SessionRecord, DurableOptionsBaseline>();

function snapshot(acpx: SessionAcpxState | undefined): DurableOptionsBaseline {
  const sessionOptions: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const value = acpx?.session_options?.[field];
    if (value !== undefined) {
      sessionOptions[field] = value;
    }
  }
  return {
    modeId: acpx?.desired_mode_id,
    configOptions: { ...acpx?.desired_config_options },
    sessionOptions,
  };
}

export function rememberSessionDurableOptionsBaseline(record: SessionRecord): SessionRecord {
  baselines.set(record, snapshot(record.acpx));
  return record;
}

/**
 * Reconcile the record's durable options against the on-disk `acpx` block before it is
 * serialized. Per option: when the writer still holds the value it started from (it did NOT
 * deliberately change it) and disk holds a different, concrete value, the disk value is
 * adopted; a deliberate change by the writer wins. Mutates `record.acpx` IN PLACE — the turn
 * keeps its own reference to that object (`acpxState`), and a replacement would leave the
 * turn's later checkpoints carrying the stale copy.
 *
 * Disk absence is never adopted (same as the checkpoint's merge): an option cleared on disk
 * does not clear the writer's copy.
 *
 * No baseline (a record that never went through a parse or a persist) ⇒ nothing to protect
 * against: the write is left verbatim, so a first-time set persists as-is.
 *
 * ⚠️ A writer that deliberately sets an option back to the very value it started from is
 * indistinguishable from one that never touched it; against a concurrent change of that
 * option disk wins. Same limit as the pinned-model and metadata baselines.
 */
export function mergeRecordDurableOptionsForPersist(
  record: SessionRecord,
  persistedAcpx: SessionAcpxState | undefined,
): void {
  const baseline = baselines.get(record);
  if (!baseline || !persistedAcpx) {
    return;
  }

  const acpx = (record.acpx ??= {});

  if (
    persistedAcpx.desired_mode_id !== undefined &&
    persistedAcpx.desired_mode_id !== baseline.modeId &&
    acpx.desired_mode_id === baseline.modeId
  ) {
    acpx.desired_mode_id = persistedAcpx.desired_mode_id;
  }

  for (const [key, onDisk] of Object.entries(persistedAcpx.desired_config_options ?? {})) {
    if (
      onDisk !== baseline.configOptions[key] &&
      acpx.desired_config_options?.[key] === baseline.configOptions[key]
    ) {
      acpx.desired_config_options = { ...acpx.desired_config_options, [key]: onDisk };
    }
  }

  for (const field of FIELDS) {
    const onDisk = persistedAcpx.session_options?.[field];
    if (
      onDisk !== undefined &&
      onDisk !== baseline.sessionOptions[field] &&
      acpx.session_options?.[field] === baseline.sessionOptions[field]
    ) {
      // The heterogeneous field union defeats a typed assignment; `field` is a known key and
      // the value came from the same slot on disk (an unknown-valued view, not `any`).
      acpx.session_options = { ...acpx.session_options, [field]: onDisk };
    }
  }
}
