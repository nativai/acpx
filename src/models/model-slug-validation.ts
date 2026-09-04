/**
 * `--model` validation at the CLI boundary — the three error shapes of
 * C5 `UI-DESIGN.md` §6.
 *
 * "Errors are the design, not an afterthought." Each one exits 2 (USAGE) and
 * each one hands back the thing that makes it actionable: the nearest matches,
 * both `source:id` forms with their billing, or the model's own ladder.
 *
 * ⚠️ THE COLD-CACHE RULE IS LOAD-BEARING (C4 §7.1 option 3): with no cached
 * catalogue the id is passed through UNVALIDATED. A session creation must never
 * fail because a third-party catalogue fetch was slow or down, and this path
 * never touches the network — it reads the cache or it stands aside.
 */

import { AcpxOperationalError } from "../errors.js";
import { findModelsById, loadCatalogue } from "./catalogue.js";
import { searchModels } from "./matcher.js";
import type { CatalogueModel, ModelCatalogue } from "./types.js";

const KNOWN_SOURCE_PREFIXES = new Set([
  "openrouter",
  "claude-subscription",
  "claude-home",
  "chatgpt",
  "claude-pty",
]);

export class ModelSlugError extends AcpxOperationalError {
  constructor(message: string, detailCode: string) {
    super(message, { outputCode: "USAGE", detailCode, origin: "cli" });
  }
}

export type ParsedModelRef = {
  /** The source, when the caller wrote `source:id`. */
  source: string | null;
  /** The id with any `[…]` suffix stripped. */
  id: string;
  /** `[high]` / `[1m]` — codex fuses the effort into the id, and acpx treats it as opaque. */
  bracket: string | null;
  /** What the caller actually typed, trimmed. */
  raw: string;
};

/**
 * `openrouter:z-ai/glm-5.3` → source + id. A bare `deepseek/v4:free` keeps its
 * colon: only a KNOWN source prefix splits, because OpenRouter ids carry `:free`
 * and `:batch` suffixes of their own.
 */
export function parseModelRef(raw: string): ParsedModelRef {
  const trimmed = raw.trim();
  let source: string | null = null;
  let rest = trimmed;

  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon).toLowerCase();
    if (KNOWN_SOURCE_PREFIXES.has(prefix)) {
      source = prefix;
      rest = trimmed.slice(colon + 1);
    }
  }

  const bracketMatch = /\[([^\]]*)\]$/.exec(rest);
  const bracket = bracketMatch ? bracketMatch[1] : null;
  const id = bracketMatch ? rest.slice(0, bracketMatch.index) : rest;

  return { source, id, bracket, raw: trimmed };
}

// ── Nearest matches (error shape 1) ──────────────────────────────────────────

function trigrams(value: string): Set<string> {
  const padded = ` ${value.toLowerCase()} `;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) {
    grams.add(padded.slice(i, i + 3));
  }
  return grams;
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const gram of a) {
    if (b.has(gram)) {
      shared += 1;
    }
  }
  return shared / Math.max(1, a.size + b.size - shared);
}

/**
 * The SAME matcher the picker uses, first; a trigram fallback only when the
 * token-AND filter returns too few, because the typical unknown slug is a TYPO
 * and a typo shares no whole token with anything.
 */
export function nearestModels(
  catalogue: ModelCatalogue,
  query: string,
  limit = 3,
): CatalogueModel[] {
  const found = searchModels(catalogue.models, query).map((match) => match.model);
  if (found.length >= limit) {
    return found.slice(0, limit);
  }

  const seen = new Set(found.map((model) => model.key));
  const wanted = trigrams(query);
  const scored = catalogue.models
    .filter((model) => !seen.has(model.key))
    .map((model) => ({ model, score: similarity(wanted, trigrams(`${model.id} ${model.name}`)) }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score || a.model.key.localeCompare(b.model.key));

  return [...found, ...scored.map((entry) => entry.model)].slice(0, limit);
}

function describeRow(model: CatalogueModel): string {
  const billing =
    model.billing.kind === "metered"
      ? `$${formatPrice(model.billing.inPerM)} / $${formatPrice(model.billing.outPerM)} per 1M`
      : model.billing.kind === "plan"
        ? `on plan (${model.billing.account})`
        : model.billing.kind;
  return `${model.key}  —  ${model.name}  [${billing}]`;
}

function formatPrice(value: number | null): string {
  if (value === null) {
    return "?";
  }
  return value >= 1 ? value.toFixed(2).replace(/\.00$/, "") : value.toFixed(4).replace(/0+$/, "");
}

export function describeLadder(model: CatalogueModel): string {
  const depth = model.depth;
  if (depth.kind === "ladder") {
    return (
      `${model.key} accepts: ${depth.levels.join(", ")}` +
      (depth.default === null ? " (default: the harness's own)" : ` (default: ${depth.default})`) +
      (depth.mandatory ? " — reasoning is mandatory, there is no off rung" : "")
    );
  }
  if (depth.kind === "boolean") {
    return `${model.key} has no depth ladder — reasoning is on/off only (default: ${
      depth.defaultEnabled ? "on" : "off"
    })`;
  }
  return `${model.key} does not accept a reasoning setting at all`;
}

// ── The three error shapes ───────────────────────────────────────────────────

export type ValidationInput = {
  model?: string;
  reasoningEffort?: string;
};

/**
 * Returns the resolved model when the catalogue could answer, `null` when it
 * stood aside (cold cache, or nothing to validate). Throws one of the three
 * shapes otherwise.
 */
export function validateModelSelection(
  catalogue: ModelCatalogue,
  input: ValidationInput,
): CatalogueModel | null {
  const raw = input.model?.trim();
  if (raw === undefined || raw === "") {
    return null;
  }

  const ref = parseModelRef(raw);
  const candidates = candidatesFor(catalogue, ref);

  if (candidates.length === 0) {
    // COLD CACHE: with no OpenRouter rows loaded, acpx cannot tell an unknown
    // slug from one it simply has not fetched — so it passes through rather than
    // blocking the create (C4 §7.1 option 3). A slug it DOES recognise is still
    // validated: knowing less never means checking less about what is known.
    if (!catalogue.models.some((model) => model.source === "openrouter")) {
      return null;
    }
    throw unknownSlugError(catalogue, ref);
  }

  if (new Set(candidates.map((model) => model.source)).size > 1) {
    throw ambiguousSlugError(candidates, ref);
  }

  const model = candidates[0];
  if (model === undefined) {
    return null;
  }
  assertEffortInLadder(model, input.reasoningEffort);
  return model;
}

function candidatesFor(catalogue: ModelCatalogue, ref: ParsedModelRef): CatalogueModel[] {
  const byId = findModelsById(catalogue, ref.id);
  return ref.source === null ? byId : byId.filter((model) => model.source === ref.source);
}

/** Shape 1 — unknown slug: the three nearest matches by the SAME matcher. */
function unknownSlugError(catalogue: ModelCatalogue, ref: ParsedModelRef): ModelSlugError {
  const suggestions = nearestModels(catalogue, ref.id);
  const suggestionText =
    suggestions.length > 0
      ? `\n  did you mean:\n${suggestions.map((model) => `    ${describeRow(model)}`).join("\n")}`
      : "";
  return new ModelSlugError(
    `[acpx] --model "${ref.raw}" is not in this box's model catalogue.${suggestionText}\n` +
      `  try: acpx models --search ${searchToken(ref.id)}`,
    "MODEL_SLUG_UNKNOWN",
  );
}

export function searchToken(id: string): string {
  return id.split(/[/\-_:]/).findLast((part) => part.length > 0) ?? id;
}

/**
 * Shape 2 — the same id under two sources. D2 enforced at the CLI boundary: the
 * two are the same weights and a completely different bill, so acpx refuses to
 * guess which one the caller meant.
 */
function ambiguousSlugError(candidates: CatalogueModel[], ref: ParsedModelRef): ModelSlugError {
  const sources = new Set(candidates.map((model) => model.source)).size;
  return new ModelSlugError(
    `[acpx] --model "${ref.raw}" exists under ${sources} sources — say which one:\n` +
      candidates.map((model) => `    --model ${describeRow(model)}`).join("\n"),
    "MODEL_SLUG_AMBIGUOUS",
  );
}

/**
 * Shape 3 — an effort outside the model's ladder. With 21 distinct ladders live,
 * "invalid effort" alone is unactionable, so the model's OWN ladder and default
 * are printed.
 */
function assertEffortInLadder(model: CatalogueModel, requested: string | undefined): void {
  const effort = requested?.trim().toLowerCase();
  if (effort === undefined || effort === "" || effort === "default") {
    return;
  }
  const depth = model.depth;
  const acceptable = depth.kind === "ladder" && (depth.levels as string[]).includes(effort);
  if (!acceptable) {
    throw new ModelSlugError(
      `[acpx] --reasoning-effort "${effort}" is not a depth ${model.key} offers.\n` +
        `  ${describeLadder(model)}`,
      "MODEL_EFFORT_OUT_OF_LADDER",
    );
  }
}

/**
 * The create-path entry point: read the cache (never the network), validate, and
 * stand aside when the cache is cold.
 */
export async function validateModelSelectionFromCache(
  input: ValidationInput,
): Promise<CatalogueModel | null> {
  if (!input.model?.trim()) {
    return null;
  }
  const catalogue = await loadCatalogue({ offline: true });
  return validateModelSelection(catalogue, input);
}

/**
 * The agent names acpx holds a native model list for. Validation is scoped to
 * these, and NOT because they are the interesting ones — because for any other
 * harness (gemini today; opencode and pi tomorrow) acpx cannot tell an unknown
 * slug from one it simply does not enumerate, and rejecting on ignorance would
 * break a create that works today. A harness joins this set when its models
 * join the catalogue.
 */
const MODEL_VALIDATED_AGENTS = new Set(["claude", "claude-pty", "codex"]);

export function isModelValidatedAgent(agentName: string | undefined): boolean {
  return agentName !== undefined && MODEL_VALIDATED_AGENTS.has(agentName);
}

/**
 * Called on the `sessions new` path. Silent on success; throws one of the three
 * shapes (exit 2) otherwise. Skipped for the raw `--agent` escape hatch and for
 * harnesses whose models acpx does not enumerate.
 */
export async function validateSessionModelFlags(params: {
  agentName: string | undefined;
  hasRawAgentOverride: boolean;
  model: string | undefined;
  reasoningEffort: string | undefined;
}): Promise<void> {
  if (params.hasRawAgentOverride) {
    return;
  }
  if (!isModelValidatedAgent(params.agentName)) {
    return;
  }
  await validateModelSelectionFromCache({
    model: params.model,
    reasoningEffort: params.reasoningEffort,
  });
}
