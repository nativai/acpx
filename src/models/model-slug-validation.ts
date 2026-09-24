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

import {
  depthMechanismForAgentCommand,
  harnessIdForAgentCommand,
  harnessProvisionsModelCatalogue,
  modelSelectionAuthorityForAgentCommand,
  usesAdvertisedComposedModelCatalogue,
} from "../acp/harness-capabilities.js";
import { stripProviderPrefix } from "../acp/harness-config-dir.js";
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
  /**
   * Set only for a harness whose DESCRIPTOR fuses depth into the model id, where
   * `gpt-5.6-sol[high]`'s bracket is an effort and must answer to the model's
   * ladder. Left unset elsewhere because `sonnet[1m]`'s bracket is a
   * context-window hint, and judging it against a depth ladder would refuse a
   * form that works today.
   */
  assertBracketAsEffort?: boolean;
  /**
   * Set for a harness acpx PROVISIONS the model catalogue for (pi —
   * `ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR`). It resolves `openrouter/<id>` to
   * the catalogue row `<id>` FOR THE LOOKUP ONLY.
   *
   * ⚠️ WITHOUT IT THE GATE IS BACKWARDS FOR SUCH A HARNESS, AND THAT IS THE
   * WHOLE REASON THIS FLAG EXISTS (brick a5eddb8d §7.2). MEASURED at 11cadc6e
   * against the real cache: `openrouter/moonshotai/kimi-k2-thinking` — pi's
   * ACTUAL wire form — is refused `MODEL_SLUG_UNKNOWN`, while the bare
   * `moonshotai/kimi-k2-thinking` it admits is the form measured to die at apply
   * with a 502. So admitting pi to {@link MODEL_VALIDATED_AGENTS}
   * without this flag would refuse working creates and wave broken ones through.
   *
   * ⚠️ IT RESOLVES THE LOOKUP, NEVER THE ID THAT IS SENT. `raw` is untouched, so
   * every error still names what the caller typed; and
   * {@link validateSessionModelFlags} returns `undefined` for such a harness so
   * the flag reaches the spawn byte-identical. Rewriting a bare id INTO the
   * prefixed form is the picker's `source + "/" + id` trap — correct for pi,
   * silently wrong for codex — and is deliberately not done anywhere
   * here.
   */
  provisionsModelCatalogue?: boolean;
};

/**
 * Resolve `openrouter/<id>` to the catalogue row `<id>`, for a harness whose
 * spawn will apply THE SAME STRIP a few milliseconds later.
 *
 * The rule is not re-implemented: {@link stripProviderPrefix} is imported from
 * `src/acp/harness-config-dir.ts`, which is where provisioning uses it
 * (`writePiConfigDir`). One rule in one place is what stops
 * the gate and the write from ever disagreeing about the same string.
 *
 * Pinning `source` is not cosmetic: an id the caller explicitly prefixed with
 * `openrouter/` IS a source-qualified reference, and saying so makes
 * `candidatesFor` narrow to OpenRouter rows exactly as `openrouter:<id>` does.
 */
function resolveProvisionedRef(ref: ParsedModelRef): ParsedModelRef {
  const stripped = stripProviderPrefix(ref.id);
  if (stripped === ref.id) {
    return ref;
  }
  return { ...ref, source: "openrouter", id: stripped };
}

/** Parse, then resolve the provider prefix for a provisioning harness. */
function refForLookup(raw: string, provisionsModelCatalogue: boolean | undefined): ParsedModelRef {
  const parsed = parseModelRef(raw);
  return provisionsModelCatalogue === true ? resolveProvisionedRef(parsed) : parsed;
}

/**
 * The create path's two mutually-exclusive shapes, in one place so the exclusion
 * is visible: a provisioning harness gets the prefix resolution and NO effort
 * ladder; everything else gets the effort and no resolution. `assertBracketAsEffort`
 * is orthogonal — it follows the depth MECHANISM, not the harness.
 */
function validationInputFor(
  params: { model: string | undefined; reasoningEffort: string | undefined; agentName?: string },
  provisionsModelCatalogue: boolean,
  depthFusedIntoId: boolean,
): ValidationInput {
  return {
    model: params.model,
    agentName: params.agentName,
    ...(provisionsModelCatalogue
      ? { provisionsModelCatalogue: true }
      : { reasoningEffort: params.reasoningEffort }),
    ...(depthFusedIntoId ? { assertBracketAsEffort: true } : {}),
  };
}

function shouldPrevalidateSessionModel(params: {
  agentName: string | undefined;
  agentCommand: string | undefined;
}): boolean {
  if (!isModelValidatedAgent(params.agentName, params.agentCommand)) {
    return false;
  }
  const authority = modelSelectionAuthorityForAgentCommand(params.agentCommand);
  return !usesAdvertisedComposedModelCatalogue(authority);
}

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

  const ref = refForLookup(raw, input.provisionsModelCatalogue);
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
  if (input.assertBracketAsEffort === true) {
    assertBracketInLadder(model, ref);
  }
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
/**
 * Exported for {@link "../session/model-ladder.js"}'s READ-side reuse (`acpx
 * status --json`'s catalogue-derived effort ceiling): the exact same
 * source/agent-type narrowing the create-path gate uses, so the two can never
 * disagree about which rows are candidates for a given pin.
 */
export function candidatesFor(
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
 * The agent names acpx holds a NATIVE model list for (`harness-models.ts`).
 *
 * ⚠️ THESE ROWS ARE TRANSCRIBED CONSTANTS, AND THE ADVERTISED SET IS PER-SEAT,
 * NOT PER-VERSION — so this arm catches a typo and an unreachable source, and is
 * NOT a pre-flight against the advertised list. MEASURED 2026-09-06 by
 * hp-r3-acpx-hod: at the very `@openai/codex 0.153.3` {@link CODEX_FAMILIES}'
 * comment cites, the deployed seat advertised 5 families / 25 ids — missing
 * astra, 5.4-mini and codex-spark, and carrying gpt-5.2 the table does not list.
 * Disagreement in BOTH directions at one version. No table acpx can hold makes
 * this arm authoritative; for these three the authority is the wire, and the
 * honest remedy is the LATE error `assertRequestedModelSupported` already emits
 * (brick a5eddb8d §5). Do not "repair" the table on the strength of one seat.
 */
const NATIVE_MODEL_LIST_AGENTS = new Set(["claude", "claude-pty", "codex"]);

/**
 * Whether acpx can judge a `--model` for this session at all. TWO ARMS, and they
 * are here for DIFFERENT and unequal reasons — the distinction is the finding of
 * brick a5eddb8d, so do not collapse them into one list.
 *
 * 1. **A native-row harness** ({@link NATIVE_MODEL_LIST_AGENTS}) — judged against
 *    acpx's transcribed rows, with the per-seat caveat above.
 * 2. **A harness acpx PROVISIONS the catalogue for** (pi) — asked of
 *    the DESCRIPTOR, never of the agent name, because it is the same predicate
 *    `client.ts:998` routes the provisioning write on.
 *
 * ⚠️ ARM 2 IS NOT A WEAKER VERSION OF ARM 1 — IT IS THE ONLY AUTHORITY THERE IS.
 * For a provisioning harness acpx WRITES the requested id into the harness's own
 * catalogue before `session/new` (`harness-config-dir.ts`, `writePiConfigDir`),
 * so the harness advertises whatever was asked for and
 * `assertRequestedModelSupported` ends up checking acpx's own write. That is why
 * a bogus id was accepted at create and died only at turn time — the wire check
 * is structurally incapable of catching it, and deferring to it is not an option.
 * MEASURED 2026-09-06 at 11cadc6e on the box's real cache: of 430 OpenRouter rows,
 * 293 carry `availability.pi.ok === true` (0 for claude / claude-pty / codex), and
 * all 430 carry an entry for each — so the catalogue does answer for pi, and an
 * empty-map false negative is excluded.
 *
 * Anything acpx does not enumerate (gemini; the raw `--agent` escape hatch)
 * stands aside: it cannot tell an unknown slug from one it does not know, and
 * rejecting on ignorance would break a create that works today.
 *
 * `agentCommand` is optional so the predicate keeps answering arm 1 for callers
 * that only hold a name; a caller that omits it simply never gets arm 2.
 */
export function isModelValidatedAgent(
  agentName: string | undefined,
  agentCommand?: string,
): boolean {
  if (agentName !== undefined && NATIVE_MODEL_LIST_AGENTS.has(agentName)) {
    return true;
  }
  return harnessProvisionsModelCatalogue(harnessIdForAgentCommand(agentCommand));
}

/**
 * The id that actually goes to the harness — the SOURCE PREFIX RESOLVED AWAY and,
 * for a harness that fuses depth into the id, the rung composed in.
 *
 * ⚠️ COMPOSE AFTER VALIDATE, NEVER INSTEAD OF IT. Every input here is a row
 * `validateModelSelection` already admitted, so composition can only ever
 * reshape a model this agent can run. Composing first would produce a
 * well-formed `family[rung]` for a family the adapter never heard of — a string
 * that looks right and fails later, which is a WORSE error than the one the user
 * gets today, not a better one. (Three such families were live until 8ff8cfd.)
 *
 * ⚠️ THE RUNGS COME FROM THE MODEL'S OWN ADVERTISED LADDER (`depth.levels`),
 * NEVER FROM A PER-FAMILY TABLE. `codexEffortCeiling` and friends are the
 * catalogue's CONSTRUCTION of that ladder and are deliberately not consulted
 * here: in Codex 0.153.x `ReasoningEffort` widened from a closed union to an
 * open string, so a hardcoded rung list is wrong by construction going forward.
 * Reading `depth.levels` means that when brick://8ca68c82 replaces the
 * transcribed constant with the adapter's advertisement, this function follows
 * with no edit.
 *
 * What each case produces, and the first three are the ones that MUST NOT MOVE:
 *   `sonnet`                    → `sonnet`               (unchanged)
 *   `opus[1m]`                  → `opus[1m]`             (a CONTEXT hint, not an
 *                                                         effort — preserved verbatim)
 *   `gpt-5.6-sol[medium]`       → `gpt-5.6-sol[medium]`  (byte-identical)
 *   `claude-subscription:sonnet`→ `sonnet`               (prefix resolved away)
 *   `gpt-5.6-sol` + effort high → `gpt-5.6-sol[high]`    (composed)
 *   `chatgpt:gpt-5.6-sol`       → `gpt-5.6-sol[medium]`  (both, via the ladder default)
 */
export function composeEffectiveModelId(params: {
  model: CatalogueModel;
  ref: ParsedModelRef;
  reasoningEffort: string | undefined;
  /** From the DESCRIPTOR (`depth.mechanism === "compose-into-id"`), never from an agent name. */
  depthFusedIntoId: boolean;
}): string {
  const { model, ref } = params;
  const rung = params.depthFusedIntoId
    ? fusedRung(model, ref, params.reasoningEffort)
    : // Not a fused-depth harness: the bracket is whatever the caller wrote and
      // means nothing to acpx (`[1m]` is a context window). Carry it through.
      ref.bracket;
  return rung === null ? model.id : `${model.id}[${rung}]`;
}

/**
 * Precedence: an explicit `--reasoning-effort`, then the rung the caller already
 * fused into the id, then the ladder's own default.
 *
 * `assertEffortInLadder` and `assertBracketInLadder` have already refused
 * anything outside `depth.levels`, so no unverified rung reaches here — which is
 * the whole reason composition is safe to do after validation and would not be
 * before it.
 */
function fusedRung(
  model: CatalogueModel,
  ref: ParsedModelRef,
  reasoningEffort: string | undefined,
): string | null {
  const depth = model.depth;
  if (depth.kind !== "ladder") {
    return null;
  }
  const requested = reasoningEffort?.trim().toLowerCase();
  const explicit =
    requested === undefined || requested === "" || requested === "default" ? null : requested;
  return explicit ?? ref.bracket ?? depth.default;
}

/**
 * For a fused-depth harness the BRACKET *is* the effort, so it answers to the
 * same ladder `--reasoning-effort` does — otherwise `gpt-5.6-sol[bogus]` would
 * compose straight back into itself and fail at the adapter.
 *
 * ⚠️ Gated on the mechanism, and that gate is load-bearing rather than tidy:
 * on claude the bracket is a CONTEXT-WINDOW hint (`sonnet[1m]`), and checking it
 * against a depth ladder would reject a form that works today.
 */
function assertBracketInLadder(model: CatalogueModel, ref: ParsedModelRef): void {
  if (ref.bracket === null || ref.bracket === "") {
    return;
  }
  const depth = model.depth;
  if (depth.kind === "ladder" && (depth.levels as string[]).includes(ref.bracket.toLowerCase())) {
    return;
  }
  throw new ModelSlugError(
    `[acpx] --model "${ref.raw}" fuses the depth "${ref.bracket}" into the id, and that is not a ` +
      `depth ${model.key} offers.\n  ${describeLadder(model)}`,
    "MODEL_EFFORT_OUT_OF_LADDER",
  );
}

/**
 * Called on the `sessions new` path. Returns the id to actually spawn with —
 * resolved and, where the harness fuses depth into the id, composed. `undefined`
 * means "leave the flag exactly as the caller wrote it", which covers the raw
 * `--agent` escape hatch, a harness acpx does not enumerate, a cold cache, and —
 * since brick a5eddb8d — every harness acpx PROVISIONS the catalogue for.
 *
 * ⚠️ A PROVISIONING HARNESS IS VALIDATED AND NEVER SUBSTITUTED, AND THE TWO HALVES
 * ARE ONE DECISION. `composeEffectiveModelId` returns the catalogue row's `id`,
 * i.e. the BARE slug — so on pi, whose wire form is `openrouter/<id>`, a caller
 * who wrote the working prefixed form would have it rewritten into the form
 * MEASURED to die at apply with a 502. Refusing to substitute is what keeps the
 * flag byte-identical to what the caller wrote; naming a better form is
 * `availability.<agent>.modelId`'s job (brick c4da2ff2), and GUESSING one here is
 * the picker's `source + "/" + id` trap — right for pi, silently
 * wrong for codex.
 *
 * ⚠️ `--reasoning-effort` is deliberately NOT judged for such a harness. The
 * OpenRouter row's `depth` ladder comes from the model's `supported_parameters`,
 * and whether that describes pi's depth MECHANISM is unmeasured —
 * so judging it there could only produce a false refusal on a create that works
 * today. Named limitation, recorded in brick a5eddb8d §7.3; it is the depth
 * lane's to close, not a gap to paper over here.
 */
export async function validateSessionModelFlags(params: {
  agentName: string | undefined;
  agentCommand: string | undefined;
  hasRawAgentOverride: boolean;
  model: string | undefined;
  reasoningEffort: string | undefined;
}): Promise<string | undefined> {
  if (params.hasRawAgentOverride) {
    return undefined;
  }
  if (!shouldPrevalidateSessionModel(params)) {
    return undefined;
  }
  // Asked of the DESCRIPTOR, never of the agent NAME: it is the same predicate
  // `client.ts:998` routes the provisioning write on, so the gate and the write
  // can never disagree about which harnesses this applies to. It also means an
  // agent command that does not classify stands aside entirely rather than
  // falling through to the native-row arm and refusing pi's working
  // `openrouter/<id>` form.
  const provisionsModelCatalogue = harnessProvisionsModelCatalogue(
    harnessIdForAgentCommand(params.agentCommand),
  );
  const depthFusedIntoId = depthMechanismForAgentCommand(params.agentCommand) === "compose-into-id";
  const resolved = await validateModelSelectionFromCache(
    validationInputFor(params, provisionsModelCatalogue, depthFusedIntoId),
  );
  // VALIDATE, THEN STOP. The refusals above have already run — this returns after
  // them, never instead of them, so a provisioning harness is fully gated and
  // merely never has its flag rewritten.
  if (provisionsModelCatalogue) {
    return undefined;
  }
  const ref = params.model?.trim() ? parseModelRef(params.model) : null;
  if (resolved === null || ref === null) {
    return undefined;
  }
  return composeEffectiveModelId({
    model: resolved,
    ref,
    reasoningEffort: params.reasoningEffort,
    depthFusedIntoId,
  });
}
