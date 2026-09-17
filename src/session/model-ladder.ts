import {
  harnessIdForAgentCommand,
  harnessProvisionsModelCatalogue,
  type HarnessId,
} from "../acp/harness-capabilities.js";
import { stripProviderPrefix } from "../acp/harness-config-dir.js";
import { findModelsById, loadCatalogue } from "../models/catalogue.js";
import {
  candidatesFor,
  isModelValidatedAgent,
  parseModelRef,
  type ParsedModelRef,
} from "../models/model-slug-validation.js";
import type { CatalogueModel, ModelCatalogue } from "../models/types.js";
import type { SessionRecord } from "../types.js";
import { pinnedModelFloor } from "./model-floor.js";

// ─── The model's REAL depth ceiling, from the catalogue ─────────────────────
//
// Amendment (2026-09-17, parent session, before this brief's implementation
// began): the generic per-harness ladder `acpx.config_options` advertises is a
// UNION across every model that harness can run — not the ceiling of the model
// actually PINNED. Measured live: a `claude-subscription:sonnet` session's
// `config_options` advertises the full [default,low,medium,high,xhigh,max]
// ladder (every rung any claude model might offer), but sonnet's own catalogue
// row (`harness-models.ts`'s `claudeEffortCeiling`) caps at `high` — sonnet
// cannot serve xhigh/max, and acpx's own `--model`/`--reasoning-effort` create
// gate already refuses `max` for it. A `--require max` check against the
// generic union would misreport "under-configured" (ask for a re-spawn) for a
// pin that could never satisfy the request at any configuration.
//
// This module answers the narrower, correct question — "what does THIS
// session's pinned model actually offer" — by resolving the pin through the
// same catalogue + candidate-narrowing `model-slug-validation.ts` uses at
// spawn time (`candidatesFor`, `isModelValidatedAgent`), reused rather than
// reimplemented so the two can never disagree about which rows a pin resolves
// to. Deliberately NOT reusing `validateModelSelection` wholesale: that
// function also asserts current per-agent AVAILABILITY and effort-in-ladder,
// which are spawn-time refusals — a session already running on a model the
// catalogue has since marked unavailable (or removed a rung from) should still
// report the ladder it was actually given, not "unresolved".

export type SessionModelLadder = {
  /** The pinned model's own advertised depth ceiling — `null` when it cannot
   *  be resolved (see `note`) or the session has no pin at all. */
  levels: string[] | null;
  /** Why `levels` is null; also `null` when `levels` is populated. */
  note: string | null;
};

function unresolved(note: string): SessionModelLadder {
  return { levels: null, note };
}

function resolveRef(rawModel: string, provisionsModelCatalogue: boolean): ParsedModelRef {
  const parsed = parseModelRef(rawModel);
  if (!provisionsModelCatalogue) {
    return parsed;
  }
  const stripped = stripProviderPrefix(parsed.id);
  return stripped === parsed.id ? parsed : { ...parsed, source: "openrouter", id: stripped };
}

function defaultLoadCatalogue(): Promise<ModelCatalogue> {
  return loadCatalogue({ offline: true });
}

/**
 * Resolve the session's pinned model to its catalogue row(s) and report the
 * ladder — `null`/note when unresolvable. Candidates that disagree on their
 * ladder shape are reported as unresolved rather than guessing: this is a
 * READ, and a wrong ceiling is worse than an absent one (a `--require` gate
 * that trusts a wrong ceiling can wrongly pass a request the model cannot
 * serve).
 *
 * `loadCatalogue` is injectable (defaults to the real cache-only read) so
 * tests can supply a `buildCatalogue(...)`-constructed catalogue instead of
 * depending on this box's live `~/.acpx/models-cache.json` — the same seam
 * `warmCatalogueInBackground` uses for its own `spawn` dependency.
 */
export async function resolveSessionModelLadder(
  record: SessionRecord,
  options: { loadCatalogue?: () => Promise<ModelCatalogue> } = {},
): Promise<SessionModelLadder> {
  const pinnedModel = pinnedModelFloor(record);
  if (!pinnedModel) {
    return unresolved("no pinned model");
  }

  const harness = harnessIdForAgentCommand(record.agentCommand);
  if (!isModelValidatedAgent(harness, record.agentCommand)) {
    return unresolved(unmeasuredHarnessNote(harness));
  }

  const loadCatalogueFn = options.loadCatalogue ?? defaultLoadCatalogue;
  const catalogue = await loadCatalogueFn();
  if (catalogueIsCold(catalogue)) {
    return unresolved("model catalogue cache is cold");
  }

  const { byId, candidates } = resolveCandidateRows(catalogue, pinnedModel, harness);
  if (candidates.length === 0) {
    return unresolved(emptyCandidatesNote(byId));
  }

  return resolveLadderFromCandidates(candidates);
}

function unmeasuredHarnessNote(harness: HarnessId | undefined): string {
  return harness
    ? `${harness} model catalogue not measured for this concept`
    : "harness not classified";
}

function catalogueIsCold(catalogue: ModelCatalogue): boolean {
  return !catalogue.models.some((model) => model.source === "openrouter");
}

function resolveCandidateRows(
  catalogue: ModelCatalogue,
  pinnedModel: string,
  harness: HarnessId | undefined,
): { byId: CatalogueModel[]; candidates: CatalogueModel[] } {
  const provisionsModelCatalogue = harnessProvisionsModelCatalogue(harness);
  const ref = resolveRef(pinnedModel, provisionsModelCatalogue);
  const byId = findModelsById(catalogue, ref.id);
  return { byId, candidates: candidatesFor(byId, ref, harness) };
}

function emptyCandidatesNote(byId: CatalogueModel[]): string {
  return byId.length > 0 ? "model belongs to a different harness" : "model not in catalogue cache";
}

function resolveLadderFromCandidates(candidates: CatalogueModel[]): SessionModelLadder {
  const ladders = candidates
    .map((model) => ladderLevelsOf(model))
    .filter((levels): levels is readonly string[] => levels !== undefined);
  if (ladders.length === 0) {
    return unresolved(`${candidates[0].key} has no depth ladder (${candidates[0].depth.kind})`);
  }
  const distinctLadders = new Set(ladders.map((levels) => levels.join(",")));
  if (distinctLadders.size > 1) {
    return unresolved("ambiguous: candidate models disagree on depth ladder");
  }
  return { levels: [...ladders[0]], note: null };
}

function ladderLevelsOf(model: CatalogueModel): readonly string[] | undefined {
  return model.depth.kind === "ladder" ? model.depth.levels : undefined;
}
