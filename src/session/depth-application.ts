import type { SessionModeState } from "@agentclientprotocol/sdk";
import { isClaudeFamilyAgent } from "../acp/agent-command.js";
import { withTimeout } from "../async-control.js";
import type { SessionRecord } from "../types.js";
import {
  type DepthProjection,
  describePiWireDepthCollapse,
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
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<DepthProjection> {
  const ladder = (params.modes?.availableModes ?? []).map((mode) => mode.id);
  const projection = projectDepthOntoLadder(params.requested, ladder);
  if (projection.value === undefined) {
    return projection;
  }
  if (params.modes?.currentModeId === projection.value) {
    return projection; // already there; nothing to send
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
  // The wire collapse is a property of Pi, not of acpx's projection, so it is
  // reported ALONGSIDE a successful apply rather than folded into the outcome.
  reportDepth(params.verbose, describePiWireDepthCollapse(projection.value));
  reportDepth(params.verbose, projection.reason);
  return projection;
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
  acpx.served = {
    ...acpx.served,
    ...(projection.value ? { effort: projection.value } : {}),
    source: DEPTH_PROJECTION_SERVED_SOURCE,
    at: new Date().toISOString(),
  };
  acpx.depth_projection = {
    requested: projection.requested,
    outcome: projection.kind,
    ...(projection.value ? { served: projection.value } : {}),
    ...(projection.reason ? { reason: projection.reason } : {}),
  };
}
