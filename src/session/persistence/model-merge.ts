import type { SessionAcpxState, SessionRecord } from "../../types.js";
import { setCurrentModelId, setDesiredModelId } from "../mode-preference.js";

/**
 * Baseline snapshot of the pinned model a writer started from. Captured on read
 * (parse) and re-captured after each persist, so a stale/racing write can be
 * told apart from a deliberate model change at persist time.
 *
 * This is the pinned-model analogue of the metadata baseline in
 * `metadata-merge.ts` (introduced by 2c848d3 to stop owner writes clobbering an
 * externally-set field). 2c848d3 protected `metadata`; it left the pinned model
 * uncovered — this extends the identical baseline-diff protection to
 * `acpx.session_options.model` (the durable pin) and `acpx.current_model_id`.
 */
export type ModelBaseline = {
  model: string | undefined;
};

const modelBaselines = new WeakMap<SessionRecord, ModelBaseline>();

function normalizeModel(model: string | undefined): string | undefined {
  if (typeof model !== "string") {
    return undefined;
  }
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pinnedModelOf(acpx: SessionAcpxState | undefined): string | undefined {
  return normalizeModel(acpx?.session_options?.model);
}

/**
 * Remember the pinned model this record object currently carries, so a later
 * persist of the SAME object can diff against it. Called wherever the metadata
 * baseline is remembered (on parse, and after each write).
 */
export function rememberSessionModelBaseline(record: SessionRecord): SessionRecord {
  modelBaselines.set(record, { model: pinnedModelOf(record.acpx) });
  return record;
}

/**
 * Resolve the pinned model to persist, given the writer's in-memory value, the
 * baseline it started from, and the current on-disk value. Pure, so it is
 * unit-testable in isolation.
 *
 * - A DELIBERATE change — the writer holds a concrete model that differs from
 *   its baseline — wins (a real `set model` / subscription-switch / fresh
 *   `--model`).
 * - Otherwise (unchanged from baseline, OR the in-memory model was DROPPED to
 *   absent by a transient reconnect state) the on-disk pin is adopted, so a
 *   stale writer can never regress a model another writer pinned. A dropped
 *   model is deliberately NOT treated as a change — that drop is exactly the
 *   clobber this protects against.
 */
export function resolvePinnedModelForPersist(options: {
  inMemory: string | undefined;
  baseline: string | undefined;
  onDisk: string | undefined;
}): string | undefined {
  const inMemory = normalizeModel(options.inMemory);
  const baseline = normalizeModel(options.baseline);
  const onDisk = normalizeModel(options.onDisk);
  if (inMemory !== undefined && inMemory !== baseline) {
    return inMemory; // deliberate change wins
  }
  // Unchanged from baseline, or dropped to absent by a transient reconnect state:
  // adopt the on-disk pin. If disk itself has already lost the pin (e.g. a
  // pre-fix clobber still on disk), self-heal from the baseline/in-memory pin
  // rather than propagating the loss — a write must never regress a known pin.
  return onDisk ?? baseline ?? inMemory;
}

/**
 * Reconcile the record's pinned model against the on-disk `acpx` block before it
 * is serialized, using the baseline captured when this record object was read.
 * Mutates `record.acpx` in place:
 *   - `session_options.model` is set to the resolved pin (protecting it from a
 *     stale/dropped write);
 *   - `current_model_id` is realigned to a non-empty resolved pin so a transient
 *     advertised `"default"` (from `syncAdvertisedModelState`) can't be
 *     persisted over a still-pinned model. An UNPINNED session (resolved pin
 *     absent) keeps its advertised `current_model_id` untouched.
 *
 * No baseline (a freshly constructed record that never went through a
 * baseline-remembering read/write) ⇒ nothing to protect against: leave the
 * write verbatim so a first-time pin persists as-is.
 */
export function mergeRecordPinnedModelForPersist(
  record: SessionRecord,
  persistedAcpx: SessionAcpxState | undefined,
): void {
  const baseline = modelBaselines.get(record);
  if (!baseline) {
    return;
  }

  const inMemory = pinnedModelOf(record.acpx);
  const resolved = resolvePinnedModelForPersist({
    inMemory,
    baseline: baseline.model,
    onDisk: pinnedModelOf(persistedAcpx),
  });

  // Only rewrite session_options.model when the resolved pin actually differs
  // from the in-memory value, and only ever to a concrete pin. This avoids
  // calling setDesiredModelId with `undefined` (which would drop the whole
  // session_options block — including effort/subscription) on an unpinned write.
  // resolved can only differ from inMemory toward a defined value: when nothing
  // is pinned anywhere, resolved === inMemory === undefined and this is skipped.
  if (resolved !== inMemory && resolved !== undefined) {
    setDesiredModelId(record, resolved);
  }
  if (resolved !== undefined) {
    // Realign current_model_id to the resolved pin so a transient advertised
    // "default" (from syncAdvertisedModelState) can't be persisted over it.
    setCurrentModelId(record, resolved);
  }
}
