import { isFableModel } from "../config/subscription-usage.js";
import type { SessionMessage, SessionRecord } from "../types.js";
import { isoNow, writeSessionRecordAtBoundary } from "./persistence.js";

// The non-Fable model every profile advertises as an alias. When an IMPLICIT
// resolution would land on a Fable-family model we rewrite it to this (or a
// concrete advertised non-Fable id when one is known). Daniel's invariant:
// "Fable must never be inherited automatically" — only an explicit request
// reaches Fable (brick://5bac5564).
export const NON_FABLE_DEFAULT_MODEL = "opus";

// How a session's model value was chosen. Persisted as the FLAT STRING
// `session_options.model_source` (Layer C). `metadata`/nested non-string values
// fail the whole record load (brick://d4f7d808) — a single string is safe.
//  - explicit    : THIS invocation passed `--model` / `set model` for it
//  - inherited    : copied from the parent/source session's model
//  - default      : no explicit and no inheritable parent value
//  - failover     : chosen by the failover retarget path
//  - guard-forced : an implicit Fable was rewritten to the non-Fable default
//  - explicit-degrade : a Fable session was deliberately degraded to Opus because
//    no subscription had Fable available and `fable_degrade_ok` opted in
//    (brick://4d517be2). The SANCTIONED exception to "Fable only via explicit
//    request" — the marker lets audits distinguish a deliberate degrade from a
//    silent `guard-forced`.
export type ModelSource =
  | "explicit"
  | "inherited"
  | "default"
  | "failover"
  | "guard-forced"
  | "explicit-degrade";

// Pick a CONCRETE advertised non-Fable model when the adapter's model set is
// known. Skips the bare `default` alias (which can resolve to Fable server-side,
// RCA §4 Layer-B edge / Q2) so an implicit spawn always lands a concrete
// non-Fable pin. Returns undefined when nothing usable is advertised → caller
// falls back to the NON_FABLE_DEFAULT_MODEL alias.
export function pickNonFableDefault(availableModels: string[] | undefined): string | undefined {
  if (!availableModels) {
    return undefined;
  }
  return availableModels.find(
    (model) => !isFableModel(model) && model.trim().toLowerCase() !== "default",
  );
}

// Resolve the provenance of a spawn-time model resolution (pre-guard). Explicit
// child `--model` wins; else an inheritable parent value is "inherited"; else
// "default". Mirrors the precedence in `withInheritedModel`.
export function resolveSpawnModelSource(
  explicitModel: string | undefined,
  inheritedModel: string | undefined,
): ModelSource {
  if (explicitModel?.trim()) {
    return "explicit";
  }
  return inheritedModel?.trim() ? "inherited" : "default";
}

export type GuardImplicitFableResult = {
  model: string | undefined;
  source: ModelSource;
  forced: boolean;
  /** The implicit Fable value that was blocked (only set when `forced`). */
  blocked?: string;
};

/**
 * Enforce Daniel's invariant "a session resolves to Fable ONLY via an explicit
 * Fable request". PURE, no IO — the single choke-point every model-entry site
 * calls. Keys on THIS session's OWN explicit request (`explicitModel`), never on
 * the inherited/resolved value: an inherited Fable (`explicitModel` absent) is
 * rewritten to the non-Fable default; an explicit Fable (`explicitModel` names
 * Fable) is preserved untouched.
 */
export function guardImplicitFable(params: {
  resolvedModel: string | undefined;
  explicitModel: string | undefined;
  source: ModelSource;
  availableModels?: string[];
}): GuardImplicitFableResult {
  const requestedFable = isFableModel(params.explicitModel);
  if (!isFableModel(params.resolvedModel) || requestedFable) {
    return { model: params.resolvedModel, source: params.source, forced: false };
  }
  const fallback = pickNonFableDefault(params.availableModels) ?? NON_FABLE_DEFAULT_MODEL;
  return { model: fallback, source: "guard-forced", forced: true, blocked: params.resolvedModel };
}

/**
 * Apply/serve-tier BELT (RCA §4 Layer B, apply tier). Fires when a model that is
 * about to be SERVED is Fable-family but its provenance says it was not
 * explicitly requested — a defence even if a non-explicit Fable pin slipped
 * through resolution.
 *
 * GRANDFATHER LEGACY (HoD Q4 decision, brick://5bac5564): force ONLY when
 * `modelSource` is PRESENT and != "explicit". When `modelSource` is ABSENT (every
 * pre-fix/legacy record) the belt must NOT force — a deliberate Fable pin (e.g.
 * the Mail-Server session `session_options.model="fable"`) and an implicit
 * inherited-Fable pin are INDISTINGUISHABLE without provenance, and force-flipping
 * the former would break Daniel's real Fable sessions. Every NEW spawn/copy/set is
 * still protected at the resolution tier regardless. DO NOT "tighten" this to force
 * on absent provenance — that reintroduces the legacy-Fable breakage.
 */
export function guardServedModel(params: {
  requestedModel: string | undefined;
  modelSource: string | undefined;
  availableModels?: string[];
}): { model: string | undefined; forced: boolean; blocked?: string } {
  if (params.modelSource === undefined || params.modelSource === "explicit") {
    return { model: params.requestedModel, forced: false };
  }
  if (!isFableModel(params.requestedModel)) {
    return { model: params.requestedModel, forced: false };
  }
  const fallback = pickNonFableDefault(params.availableModels) ?? NON_FABLE_DEFAULT_MODEL;
  return { model: fallback, forced: true, blocked: params.requestedModel };
}

// Stamp the loud `model_guard` breadcrumb into the record (RCA §4 Layer B). A
// nested object on `session_options`, validated + round-tripped exactly like the
// existing `subscription_switch` breadcrumb — the flat-string constraint applies
// to `model_source`, not to a validated typed breadcrumb block.
export function stampModelGuardBreadcrumb(
  record: SessionRecord,
  params: { blocked: string; forcedTo: string; source: string; at?: string },
): void {
  const acpx = record.acpx ?? {};
  acpx.session_options = {
    ...acpx.session_options,
    model_guard: {
      blocked: params.blocked,
      forced_to: params.forcedTo,
      source: params.source,
      at: params.at ?? isoNow(),
    },
  };
  record.acpx = acpx;
}

function buildModelGuardMessage(params: { blocked: string; forcedTo: string }): SessionMessage {
  return {
    Agent: {
      content: [
        {
          Text:
            `⚠ implicit Fable blocked → forced ${params.forcedTo}: this session would have resolved to ` +
            `"${params.blocked}" by inheritance/default, but Fable is never inherited automatically ` +
            `(brick://5bac5564). The model was rewritten to "${params.forcedTo}". Pass \`--model fable\` ` +
            `explicitly if a Fable session was actually intended.`,
        },
      ],
      tool_results: {},
      // System breadcrumb, not a real model turn — must not count as
      // irreplaceable history in the resume→session/new fallback gate
      // (brick://de3645c6). Without this, a fresh guard-forced session whose
      // cold first prompt hits a missing transcript is permanently unpromptable.
      synthetic: true,
    },
  };
}

// Mirror the guard warning into `<id>.messages.ndjson` (best-effort) so BOTH the
// child and its spawner see that an implicit Fable was blocked — mirroring
// `mirrorFloorWarningToMessages`. Push-only; no `.stream.ndjson` terminal (the
// guard is a redirect, not a turn failure).
export async function mirrorModelGuardToMessages(
  record: SessionRecord,
  params: { blocked: string; forcedTo: string },
): Promise<void> {
  record.messages.push(buildModelGuardMessage(params));
  await writeSessionRecordAtBoundary(record);
}
