/**
 * `--model` validation at the CLI boundary — C5 `UI-DESIGN.md` §6's three error
 * shapes, plus the two AVAILABILITY shapes S2 added.
 *
 * "Errors are the design, not an afterthought." Each one exits 2 (USAGE) and
 * each one hands back the thing that makes it actionable: the nearest matches,
 * both `source:id` forms with their billing, the model's own ladder, the sources
 * that DO own the id, or the reason this agent cannot run it.
 *
 * ⚠️ THE AVAILABILITY SHAPES ARE NOT "STRICTER VALIDATION" — THEY MOVE A REFUSAL
 * THAT ALREADY HAPPENED SOMEWHERE WORSE. Before S2 a catalogue-valid row that the
 * agent cannot run reached the adapter, and on claude the adapter refuses inside
 * `session/new`, upstream of `assertRequestedModelSupported` — so acpx surfaced
 * `-32603 Internal error`, the unclassified card `RequestedModelUnsupportedError`
 * exists to prevent. Nothing that used to create a session stops creating one;
 * what changes is which component says no, and how legibly (brick://db554b05).
 *
 * ⚠️ THE COLD-CACHE RULE IS LOAD-BEARING (C4 §7.1 option 3): with no cached
 * catalogue the id is passed through UNVALIDATED. A session creation must never
 * fail because a third-party catalogue fetch was slow or down, and this path
 * never touches the network — it reads the cache or it stands aside.
 */

import { AcpxOperationalError } from "../errors.js";
import { findModelsById, loadCatalogue } from "./catalogue.js";
import { nativeAgentTypesForSource } from "./harness-models.js";
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
    const dflt =
      depth.defaultEnabled === null ? "not stated upstream" : depth.defaultEnabled ? "on" : "off";
    return `${model.key} has no depth ladder — reasoning is on/off only (default: ${dflt})`;
  }
  return `${model.key} does not accept a reasoning setting at all`;
}

// ── The five error shapes ────────────────────────────────────────────────────

export type ValidationInput = {
  model?: string;
  reasoningEffort?: string;
  /**
   * The agent type the session is being created for. It narrows the candidate
   * set BEFORE ambiguity is judged — without it, `--model sonnet` on a claude
   * session reads as ambiguous between the subscription and the independent
   * home, which is not a question the caller was asking.
   */
  agentName?: string;
};

/**
 * Returns the resolved model when the catalogue could answer, `null` when it
 * stood aside (cold cache, or nothing to validate). Throws one of the five
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
  const byId = findModelsById(catalogue, ref.id);
  const candidates = candidatesFor(byId, ref, input.agentName);

  if (candidates.length === 0) {
    return refuseOrStandAside(catalogue, byId, ref, input.agentName);
  }

  if (isAmbiguous(candidates)) {
    throw ambiguousSlugError(candidates, ref);
  }

  const model = candidates[0];
  if (model === undefined) {
    return null;
  }
  assertModelAvailable(model, ref, input.agentName);
  assertEffortInLadder(model, input.reasoningEffort);
  return model;
}

/**
 * Nothing this agent can reach answers to the id. There are three distinct
 * reasons for that and they are NOT interchangeable — collapsing them is how the
 * caller gets sent to look for a typo that is not there.
 *
 * Returns `null` only for the cold cache, where standing aside is the design.
 */
function refuseOrStandAside(
  catalogue: ModelCatalogue,
  byId: CatalogueModel[],
  ref: ParsedModelRef,
  agentName: string | undefined,
): null {
  // The slug IS in the catalogue, it just belongs to another harness. Saying
  // "not in this box's catalogue" here would be false.
  if (byId.length > 0 && agentName !== undefined) {
    throw otherHarnessError(byId, ref, agentName);
  }
  // COLD CACHE: with no OpenRouter rows loaded, acpx cannot tell an unknown slug
  // from one it simply has not fetched — so it passes through rather than
  // blocking the create (C4 §7.1 option 3). A slug it DOES recognise is still
  // validated: knowing less never means checking less about what is known.
  if (!catalogue.models.some((model) => model.source === "openrouter")) {
    return null;
  }
  throw unknownSlugError(catalogue, ref);
}

/**
 * ⚠️ DO NOT RESTORE `return reachable.length > 0 ? reachable : byId`. It reads
 * like a safety net and it is the defect: when the ONLY candidates belong to
 * another harness, `reachable` is empty and the fallback re-admits them —
 * precisely the case the narrowing above exists to reject, so the filter did
 * nothing exactly when it mattered.
 *
 * MEASURED at a5ba50fe, both directions (brick://db554b05
 * `reports/MEASUREMENT.md` P3 / C2): `--model gpt-5.6-luna` was accepted on a
 * `claude` session and `--model sonnet` on a `codex` session; each then died
 * downstream — codex with acpx's own advertised-models error, claude with an
 * unclassified `-32603 Internal error` out of the adapter.
 *
 * The empty result is now MEANINGFUL and the caller distinguishes it from a
 * genuinely unknown slug (`otherHarnessError` vs `unknownSlugError`), which is
 * what makes returning it safe rather than merely stricter.
 */
function candidatesFor(
  byId: CatalogueModel[],
  ref: ParsedModelRef,
  agentName: string | undefined,
): CatalogueModel[] {
  if (ref.source !== null) {
    return byId.filter((model) => model.source === ref.source);
  }
  if (agentName === undefined) {
    return byId;
  }
  // Rows another harness owns are not candidates for THIS create at all.
  return byId.filter((model) => {
    const owners = nativeAgentTypesForSource(model.source);
    return owners === null || owners.includes(agentName);
  });
}

/**
 * ⚠️ AMBIGUITY IS ABOUT THE BILL, NOT ABOUT THE ROW COUNT — and getting this
 * wrong is a REGRESSION, not a stricter check.
 *
 * MEASURED 2026-09-04T00:27Z, and it is why this function exists: a first cut
 * refused on "more than one source", and `acpx claude sessions new --model
 * sonnet` — which works on the deployed CLI today — exited 2, because `sonnet`
 * is a row under BOTH `claude-subscription` and `claude-home`. Those two are
 * the same weights on the same plan class reached through a different
 * credential, and the credential is what `--profile` / `--subscription` select;
 * `--model` has never meant a source. So a split that costs the same is not an
 * ambiguity the caller must resolve.
 *
 * What D2 actually protects against is spending money you did not mean to —
 * `opus` on plan versus the same weights metered on OpenRouter. So the test is
 * a difference in BILLING KIND, which is exactly that case and not this one.
 */
function isAmbiguous(candidates: CatalogueModel[]): boolean {
  if (candidates.length < 2) {
    return false;
  }
  return new Set(candidates.map((model) => model.billing.kind)).size > 1;
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
 * Shape 4 — the id exists, under a source this agent cannot reach. Distinct from
 * shape 1 on purpose: "not in this box's catalogue" would be FALSE here, and it
 * sends the caller hunting for a typo that does not exist. Names the sources it
 * did find and the one command that lists what this agent can actually run.
 */
function otherHarnessError(
  byId: CatalogueModel[],
  ref: ParsedModelRef,
  agentName: string,
): ModelSlugError {
  const owners = [
    ...new Set(byId.flatMap((model) => nativeAgentTypesForSource(model.source) ?? [])),
  ];
  const reachableBy = owners.length > 0 ? ` It belongs to: ${owners.join(", ")}.` : "";
  return new ModelSlugError(
    `[acpx] --model "${ref.raw}" is not a model a ${agentName} session can run.${reachableBy}\n` +
      byId.map((model) => `    ${describeRow(model)}`).join("\n") +
      `\n  try: acpx models --agent ${agentName}`,
    "MODEL_NOT_REACHABLE_FROM_AGENT",
  );
}

/**
 * Shape 5 — the row is this agent's to reach, and still cannot be run: either the
 * catalogue blocks it outright (a batch endpoint, no tool calling, an
 * unpredictable price) or the harness cannot take an arbitrary model id.
 *
 * ⚠️ THE TWO CHECKS ARE NOT REDUNDANT, AND THE ORDER IS THE MESSAGE. A blocked
 * row's `availability` entry already carries the catalogue's reason, so the
 * second check alone would usually say the right thing — but `availability` is
 * `{}` whenever the capability table is empty, and then a batch endpoint would
 * validate clean. `selectable` is a catalogue fact that is always present, so it
 * is checked first and independently; the per-agent question is only asked of a
 * row the catalogue itself allows.
 *
 * MEASURED at a5ba50fe (brick://db554b05, P1 / P4): with neither check,
 * `--model z-ai/glm-5.3` and `--model openrouter:openai/gpt-6-astra:batch` both
 * passed validation on a `claude` session and died in the adapter as
 * `-32603 Internal error` — the unclassified card `RequestedModelUnsupportedError`
 * exists to prevent.
 */
function assertModelAvailable(
  model: CatalogueModel,
  ref: ParsedModelRef,
  agentName: string | undefined,
): void {
  if (!model.selectable) {
    throw new ModelSlugError(
      `[acpx] --model "${ref.raw}" cannot be used for a session: ` +
        `${model.unavailableReasons.map((reason) => reason.message).join(" · ")}\n` +
        `  try: acpx models --search ${searchToken(ref.id)}`,
      "MODEL_NOT_SELECTABLE",
    );
  }
  if (agentName === undefined) {
    return;
  }
  const availability = model.availability[agentName];
  // `undefined` is "acpx has no capability table for this agent type", which is
  // absence of knowledge, not evidence of unavailability — the same rule
  // `isAvailableForAgent` follows, and refusing on it would block a create that
  // works today.
  if (availability === undefined || availability.ok) {
    return;
  }
  throw new ModelSlugError(
    `[acpx] --model "${ref.raw}" is not available for a ${agentName} session: ` +
      `${availability.message ?? availability.reason}\n` +
      `  try: acpx models --agent ${agentName}`,
    "MODEL_NOT_AVAILABLE_FOR_AGENT",
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
    agentName: params.agentName,
  });
}
