import { ModelFloorUnmetError } from "../errors.js";
import type { SessionMessage, SessionRecord } from "../types.js";
import {
  belowFloorEpisodeOpen,
  clearFloorBreadcrumbs,
  evaluateModelFloor,
  floorHardEnabled,
  type ModelFloorEvaluation,
  pinnedEffortFloor,
  pinnedModelFloor,
  setFloorParked,
  stampServedBelowFloor,
} from "./model-floor.js";
import {
  mirrorTerminalTurnErrorToMessages,
  persistTerminalTurnError,
} from "./persist-terminal-error.js";
import { writeSessionRecordAtBoundary } from "./persistence.js";

// The verdict of the post-serve floor check. `accept:true` ⇒ the turn settles
// normally (at floor, no pin, unreadable served, or below-floor in the default
// non-hard mode which accepts-but-surfaces). `accept:false` ⇒ `--floor-hard`
// and served below floor: the caller MUST throw `error` instead of returning the
// served-down result, so the content is quarantined behind a loud terminal.
export type ModelFloorVerdict =
  | { accept: true; recovered?: boolean }
  | { accept: false; error: ModelFloorUnmetError; evaluation: ModelFloorEvaluation };

/**
 * Post-serve model-floor check — the SINGLE code path shared by both modes
 * (brick://07dd62c9 §5b). Reads the pinned floor + the just-captured served
 * model and:
 *  - no pin / unreadable served / at floor → accept (clearing breadcrumbs and
 *    signalling recovery when a below-floor episode just closed);
 *  - below floor, non-hard (default) → WARN (session-visible + parent-visible via
 *    `.messages.ndjson`, debounced per episode) + `served_below_floor` breadcrumb,
 *    then ACCEPT (visibility only; the desired pin is never mutated);
 *  - below floor, `--floor-hard` → surface a loud `ModelFloorUnmetError` to BOTH
 *    sinks (`.stream.ndjson` banner + `.messages.ndjson`), stamp the breadcrumb,
 *    and return `accept:false` so the caller throws it (the served content is
 *    quarantined, NOT handed up as end_turn). Pin unchanged either way.
 *
 * Best-effort persistence: a write failure never masks the caller's turn result.
 */
export async function enforceModelFloorPostServe(
  record: SessionRecord,
  params: { servedModel: string | undefined; verbose?: boolean },
): Promise<ModelFloorVerdict> {
  const pinnedModel = pinnedModelFloor(record);
  if (!pinnedModel) {
    return { accept: true };
  }

  const evaluation = evaluateModelFloor({
    pinnedModel,
    pinnedEffort: pinnedEffortFloor(record),
    servedModel: params.servedModel,
  });

  if (evaluation.status !== "below-floor") {
    // At floor (or served unreadable — do not fail a legitimate turn on a
    // transient transcript-read miss, §9). Auto-recover: clear any open episode.
    const recovered = clearFloorBreadcrumbs(record);
    if (recovered) {
      await writeSessionRecordAtBoundary(record).catch(() => {});
      logFloor(
        params.verbose,
        `recovered — served ${evaluation.servedModel ?? "?"} at floor`,
        record,
      );
    }
    return { accept: true, recovered };
  }

  const firstOfEpisode = !belowFloorEpisodeOpen(record);
  stampServedBelowFloor(record, evaluation);

  if (!floorHardEnabled(record)) {
    // Default mode: surface loudly but ACCEPT. Debounce the session-visible
    // warning to once per contiguous below-floor episode.
    if (firstOfEpisode) {
      await mirrorFloorWarningToMessages(record, evaluation).catch(() => {});
    }
    await writeSessionRecordAtBoundary(record).catch(() => {});
    logFloor(
      params.verbose,
      `served ${evaluation.servedModel ?? "?"} below pinned ${evaluation.pinnedModel} — accepted (detect+surface)`,
      record,
    );
    return { accept: true };
  }

  // Hard mode: do NOT accept. Surface to both sinks, PARK, and quarantine the
  // content. Retry-across-time is the retryable error + the parent re-delivering:
  // each re-delivered turn re-enters the pre-turn gate, and the next at-floor serve
  // auto-clears the park. (We deliberately do NOT auto-re-run the agent turn from
  // the runtime — the prompt was already consumed; re-running is unsafe.)
  const error = new ModelFloorUnmetError({
    pinnedModel: evaluation.pinnedModel,
    servedModel: evaluation.servedModel,
    phase: "post-serve",
  });
  setFloorParked(record, evaluation.servedModel);
  await persistTerminalTurnError(record, error).catch(() => {});
  await mirrorTerminalTurnErrorToMessages(record, error).catch(() => {});
  await writeSessionRecordAtBoundary(record).catch(() => {});
  logFloor(
    params.verbose,
    `served ${evaluation.servedModel ?? "?"} below pinned ${evaluation.pinnedModel} — REFUSED (floor-hard)`,
    record,
  );
  return { accept: false, error, evaluation };
}

// A non-terminal, agent-visible warning entry mirrored into `.messages.ndjson`
// so the child AND its spawner see that the turn was served below the pinned
// floor (the default mode accepts the work but must never do so silently). Mirror
// only — no `.stream.ndjson` terminal, since the default mode is not a failure.
async function mirrorFloorWarningToMessages(
  record: SessionRecord,
  evaluation: ModelFloorEvaluation,
): Promise<void> {
  record.messages.push(buildFloorWarningMessage(evaluation));
  await writeSessionRecordAtBoundary(record);
}

function buildFloorWarningMessage(evaluation: ModelFloorEvaluation): SessionMessage {
  const served = evaluation.servedModel ?? "unknown";
  const effortNote =
    evaluation.pinnedEffort &&
    evaluation.servedEffort &&
    evaluation.servedEffort !== evaluation.pinnedEffort
      ? ` (effort authored down ${evaluation.pinnedEffort}→${evaluation.servedEffort})`
      : "";
  return {
    Agent: {
      content: [
        {
          Text:
            `⚠ served below pinned model floor: this turn was served "${served}" but the session ` +
            `is pinned to "${evaluation.pinnedModel}"${effortNote}. The work was accepted, but a ` +
            `hard-ruled agent should verify with \`whoami --require <effort>\` and flag its parent for ` +
            `a re-spawn at the pinned floor.`,
        },
      ],
      tool_results: {},
    },
  };
}

function logFloor(verbose: boolean | undefined, message: string, record: SessionRecord): void {
  if (verbose) {
    process.stderr.write(`[acpx] model-floor session=${record.acpxRecordId} ${message}\n`);
  }
}
