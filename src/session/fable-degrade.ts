import type { SessionMessage, SessionRecord } from "../types.js";
import { NON_FABLE_DEFAULT_MODEL } from "./model-guard.js";
import { isoNow, writeSessionRecordAtBoundary } from "./persistence.js";

// brick://4d517be2 — the Fable→Opus degrade. When a Fable session hits the
// fable-share short-circuit (every subscription cleanly fable-exhausted, unified
// windows healthy) AND the session opted in via `session_options.fable_degrade_ok`,
// we durably rewrite the model to Opus instead of raising the loud
// FableShareExhaustedError terminal. Mirrors the model-guard machinery: a durable
// model + `model_source="explicit-degrade"` provenance, a loud `fable_degrade`
// breadcrumb, and a best-effort messages-sidecar mirror so both the agent and its
// spawner see the degrade. Sticky (v1): the Opus rewrite holds until manual
// re-select; `fable_degrade.from` preserves the original Fable id for a future v2
// auto-restore with no data migration.

export function fableDegradeOkForRecord(record: SessionRecord): boolean {
  return record.acpx?.session_options?.fable_degrade_ok === true;
}

// Durably rewrite the record's model to the non-Fable default and stamp the
// degrade provenance + breadcrumb. Pure record mutation (no IO) — the caller
// persists. `from` is the Fable model the session was pinned to.
export function stampFableDegrade(
  record: SessionRecord,
  params: { from: string; at?: string },
): { to: string } {
  const to = NON_FABLE_DEFAULT_MODEL;
  const acpx = record.acpx ?? {};
  acpx.session_options = {
    ...acpx.session_options,
    model: to,
    model_source: "explicit-degrade",
    fable_degrade: {
      from: params.from,
      to,
      at: params.at ?? isoNow(),
    },
  };
  record.acpx = acpx;
  return { to };
}

function buildFableDegradeMessage(params: { from: string; to: string }): SessionMessage {
  return {
    Agent: {
      content: [
        {
          Text:
            `⚠ Fable share exhausted on all subscriptions — degraded to ${params.to} for this ` +
            `session (fable_degrade_ok). This turn and subsequent turns run on ${params.to} ` +
            `instead of failing. Re-select Fable to undo (brick://4d517be2).`,
        },
      ],
      tool_results: {},
      // System breadcrumb, not a real model turn — must not count as
      // irreplaceable history in the resume→session/new fallback gate
      // (brick://de3645c6, extended by brick://509b4ee1). Without this, a fresh
      // session whose first turn degraded and then died before any transcript
      // write is permanently unpromptable.
      synthetic: true,
    },
  };
}

// Mirror the degrade notice into `<id>.messages.ndjson` (best-effort) so BOTH the
// child and its spawner see that a Fable session degraded to Opus — mirroring
// `mirrorModelGuardToMessages`. Push-only; NOT the red `.stream.ndjson` terminal
// (the degrade is a handled continuation, not a turn failure).
export async function mirrorFableDegradeToMessages(
  record: SessionRecord,
  params: { from: string; to: string },
): Promise<void> {
  record.messages.push(buildFableDegradeMessage(params));
  await writeSessionRecordAtBoundary(record);
}

// Apply the full degrade: stamp the durable model/provenance/breadcrumb, mirror the
// notice to the messages sidecar (which also persists the record at a boundary).
export async function applyFableDegrade(
  record: SessionRecord,
  params: { from: string; at?: string },
): Promise<{ to: string }> {
  const { to } = stampFableDegrade(record, params);
  await mirrorFableDegradeToMessages(record, { from: params.from, to });
  return { to };
}
