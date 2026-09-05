import type { SessionModeState } from "@agentclientprotocol/sdk";
import { isClaudeFamilyAgent } from "../acp/agent-command.js";
import type { HarnessId } from "../acp/harness-capabilities.js";
import { withTimeout } from "../async-control.js";
import type { SessionRecord } from "../types.js";
import {
  advertisedServedEffort,
  type DepthProjection,
  describeAdvertisedServedEffort,
  projectDepthOntoLadder,
  rejectedDepthProjection,
} from "./depth-projection.js";

/** Minimal client surface for the mode arm, so it is unit-testable with a stub. */
export interface DepthModeApplyClient {
  setSessionMode(sessionId: string, modeId: string): Promise<void>;
}

/** `acpx.served.source` value that marks a depth outcome acpx itself produced. */
export const DEPTH_PROJECTION_SERVED_SOURCE = "depth-projection";

/**
 * Apply a canonical depth request through the ACP **mode** selector (I2 R8).
 *
 * Pi advertises `configOptions: null` and carries thinking level on
 * `session/set_mode`, so acpx's depth path — gated on an advertised `effort`
 * config option — could never reach it. This is that missing arm.
 *
 * ⚠️ A rejected mode is a PROJECTION FAILURE, recorded, never retried. pi-acp
 * advertises `max` and then answers `-32602` for it, so the ladder acpx projects
 * onto is itself wrong. Retrying a lower rung would serve a depth the user did
 * not ask for and record it as success — see {@link rejectedDepthProjection}.
 */
export async function applyDepthAsMode(params: {
  client: DepthModeApplyClient;
  sessionId: string;
  requested: string;
  modes: SessionModeState | undefined;
  /** Whose WIRE ladder applies. Absent ⇒ no collapse is folded in, because the
   *  measured collapse table belongs to one harness and must not be applied to
   *  another by default (F-14, second writer). */
  harness?: HarnessId;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<DepthProjection> {
  const ladder = (params.modes?.availableModes ?? []).map((mode) => mode.id);
  const projection = projectDepthOntoLadder(params.requested, ladder);
  if (projection.value === undefined) {
    return projection;
  }
  if (params.modes?.currentModeId === projection.value) {
    // Already there; nothing to send. The mode is the agent's own word, but the
    // WIRE collapse applies just the same — so this arm is downgraded too.
    return withWireCollapse(projection, params.harness, params.modes);
  }
  try {
    await withTimeout(
      params.client.setSessionMode(params.sessionId, projection.value),
      params.timeoutMs,
    );
  } catch (error) {
    const rejected = rejectedDepthProjection(
      projection,
      error instanceof Error ? error.message : String(error),
    );
    reportDepth(params.verbose, rejected.reason);
    return rejected;
  }
  reportDepth(params.verbose, describeAdvertisedServedEffort(params.modes, projection.value));
  const served = withWireCollapse(projection, params.harness, params.modes);
  reportDepth(params.verbose, served.reason);
  return served;
}

/**
 * Fold the agent's OWN advertised wire value into the recorded outcome (F-14's
 * rule, second writer — brick 06ae06c1 as corrected, then corrected again by B5).
 *
 * ⚠️ THIS REVERSES A DECISION I MADE IN THE ORIGINAL MODE ARM. The comment that
 * stood here said the collapse "is a property of Pi, not of acpx's projection, so
 * it is reported ALONGSIDE a successful apply rather than folded into the
 * outcome" — and the consequence was that acpx PRINTED *"Pi collapses
 * off/minimal/low to {effort: low}"* under `--verbose` while RECORDING
 * `{"requested":"minimal","outcome":"exact","served":"minimal"}` in the same run.
 * Two surfaces of one process contradicting each other, with the trusted one
 * wrong. Knowing a value is collapsed and recording it as served exactly is the
 * same defect F-14 fixes on the config-option arm; the writer differs, the rule
 * does not.
 *
 * 🛑 AND THE FIRST VERSION OF THIS FIX WAS ITSELF WRONG — worth stating, because
 * it shipped. It folded in a FROZEN, MODEL-INDEPENDENT table of Pi's collapse.
 * Pi's collapse is per MODEL (`thinkingLevelMap`), and measured against pi
 * 0.84.4's catalogue **no model has the shape that table encoded** — so the
 * "honest" record was a different wrong answer, with more confidence behind it.
 * The served value is now read from the agent's own advertisement
 * (`_meta.piAcp.servedEffort`, nativai `pi-acp` fork) and NOTHING is folded in
 * when the adapter did not say. A missing served value is a gap; an invented one
 * is a lie that reads like a measurement.
 *
 * ⚠️ IT ONLY EVER DOWNGRADES. An `exact` can become `projected`; a `projected`
 * never becomes `exact`. So a request that acpx already had to move (e.g. `max`
 * onto a ladder topping out at `xhigh`) stays `projected` even where the collapse
 * happens to land back on the requested level — because acpx did not send what
 * was asked for, which is the fact the reader needs.
 */
function withWireCollapse(
  projection: DepthProjection,
  harness: HarnessId | undefined,
  modes: SessionModeState | undefined,
): DepthProjection {
  if (projection.value === undefined) {
    return projection;
  }
  // The harness gate stays: a `_meta.piAcp` block is pi-acp's own vocabulary, and
  // reading it from another agent's advertisement would attribute pi's semantics
  // to something that never agreed to them.
  if (harness !== "pi") {
    return projection;
  }
  const served = advertisedServedEffort(modes, projection.value);
  if (served === undefined || served === projection.value) {
    return projection;
  }
  return {
    kind: "projected",
    value: served ?? "none",
    requested: projection.requested,
    reason:
      served === null
        ? `"${projection.requested}" was applied as mode "${projection.value}", but the agent advertises that this model sends NO reasoning parameter for it — reasoning is off`
        : `"${projection.requested}" was applied as mode "${projection.value}", which the agent advertises it serves as effort "${served}" for this model`,
  };
}

function reportDepth(verbose: boolean | undefined, message: string | undefined): void {
  if (verbose && message) {
    process.stderr.write(`[acpx] thinking depth: ${message}\n`);
  }
}

/**
 * Record what a depth request actually produced — **the invariant that matters
 * more than the arithmetic: a depth request is never silently dropped.**
 *
 * Before B3 it was: `persistAndApplyRequestedEffort` returned with no error and
 * no persist when the `effort` option was not advertised. The request lived on
 * in `session_options.effort` and nothing anywhere said it had not been honoured.
 *
 * ## Two writers, one field — why this stamps instead of calling setServedState
 *
 * `acpx.served` already has a producer: `captureServedState`
 * (`src/session/model-floor.ts:390-401`) stamps it post-turn from the Claude
 * transcript, and `setServedState` (`:325-336`) **REPLACES THE WHOLE BLOCK**
 * rather than merging. So:
 *
 *  - this function MERGES, so it can never destroy a co-existing `served.model`;
 *  - it is gated on `!isClaudeFamilyAgent`, because for the Claude family that
 *    block belongs to the transcript capture — whose `effort` means something
 *    different ("derived from the served model", `src/types.ts:607-618`) and
 *    which would overwrite this on the very next turn anyway;
 *  - it labels itself `source: "depth-projection"` so the two producers are
 *    distinguishable in the record instead of silently sharing a vocabulary.
 *
 * That gate is also exactly the program guardrail: claude and claude-pty depth
 * goes through the existing generic path, unchanged.
 *
 * ⚠️ `readLastServedModel` returns undefined for any non-Claude agent
 * (`:234-237`), so for OpenCode and Pi there is no second writer at all and this
 * stamp is durable. Verified before relying on it.
 */
export function recordDepthOutcome(record: SessionRecord, projection: DepthProjection): void {
  // ⚠️ NO DEPTH REQUEST ⇒ THE KEY IS ABSENT. Not `null`, not `{}` — absent.
  //
  // Every default claude / claude-pty / codex spawn makes no depth request, and
  // their records must stay byte-comparable to today's. A record that gains a key
  // has a CHANGED SHAPE, and record shape is consumed by parse, serialize, the
  // index projection and the UI — so "we added a field but it is null for you" is
  // a behaviour change wearing a reassuring value.
  //
  // This guard makes an empty write structurally impossible rather than trusting
  // every caller to check first. `requested` is required on the outcome precisely
  // so there is no valid shape for "an outcome with no request".
  if (!projection.requested.trim()) {
    return;
  }
  if (isClaudeFamilyAgent(record.agentCommand)) {
    return;
  }
  const acpx = record.acpx ?? (record.acpx = {});
  // ⚠️ ONLY WHEN A VALUE WAS ACTUALLY SERVED. An `unavailable` or rejected
  // outcome sends nothing, so writing a `served` block for it would assert a
  // served truth that does not exist — the same dishonesty this whole block was
  // built to end, one field over. It also matters because `served` is ABSENT for
  // codex on this build (a MEASURED baseline the programme relies on in two
  // places), and an `--reasoning-effort` on codex always lands in the
  // `unavailable` arm: writing here unconditionally gave every such session a
  // `served` block carrying only `{at, source}` and no model and no effort.
  //
  // The outcome is never lost by this — `depth_projection` below records it
  // whether or not anything was served. That is exactly why that field exists.
  if (projection.value) {
    acpx.served = {
      ...acpx.served,
      effort: projection.value,
      source: DEPTH_PROJECTION_SERVED_SOURCE,
      at: new Date().toISOString(),
    };
  }
  acpx.depth_projection = {
    requested: projection.requested,
    outcome: projection.kind,
    ...(projection.value ? { served: projection.value } : {}),
    ...(projection.reason ? { reason: projection.reason } : {}),
  };
}
