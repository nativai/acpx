import type { SessionModelState } from "@agentclientprotocol/sdk";
import { AcpxOperationalError } from "../errors.js";
import { isClaudeAcpCommand } from "./agent-command.js";
import { splitCommandLine } from "./client-process.js";

// A requested model/effort the ACP agent does not advertise (e.g. a codex
// `gpt-5.6-luna[ultra]` when luna tops out at max, or a bare family). This is a
// USER input error, not a runtime fault: classifying it USAGE (detailCode
// MODEL_NOT_ADVERTISED) makes acpx emit -32602 with a friendly, actionable
// message so acpx-ui renders a "model/effort not available — pick another"
// notice instead of a scary -32603 RUNTIME internal-error card. Mirrors the
// USAGE classification of SubscriptionUnknownError / ProfileUnknownError. (de290ae4)
export class RequestedModelUnsupportedError extends AcpxOperationalError {
  constructor(
    message: string,
    detailCode: "MODEL_NOT_ADVERTISED" | "MODEL_EFFORT_OUT_OF_LADDER" = "MODEL_NOT_ADVERTISED",
  ) {
    super(message, {
      outputCode: "USAGE",
      detailCode,
      origin: "cli",
    });
    this.name = "RequestedModelUnsupportedError";
  }
}

export type AdvertisedComposedModel = Readonly<{
  family: string;
  efforts: readonly string[];
  modelIds: readonly string[];
}>;

const COMPOSED_MODEL_ID = /^(.*)\[([^[]+)\]$/;

function parseComposedModelId(modelId: string): { family: string; effort: string } | undefined {
  const match = COMPOSED_MODEL_ID.exec(modelId.trim());
  const family = match?.[1]?.trim();
  const effort = match?.[2]?.trim().toLowerCase();
  return family && effort ? { family, effort } : undefined;
}

/** Project exact adapter ids into per-family ladders without a family or rung table. */
export function projectAdvertisedComposedModels(
  models: SessionModelState,
): AdvertisedComposedModel[] {
  const families = new Map<string, { efforts: string[]; modelIds: string[] }>();
  for (const model of models.availableModels) {
    const parsed = parseComposedModelId(model.modelId);
    if (!parsed) {
      continue;
    }
    const row = families.get(parsed.family) ?? { efforts: [], modelIds: [] };
    if (!row.efforts.includes(parsed.effort)) {
      row.efforts.push(parsed.effort);
    }
    row.modelIds.push(model.modelId);
    families.set(parsed.family, row);
  }
  return [...families.entries()].map(([family, row]) => ({
    family,
    efforts: row.efforts,
    modelIds: row.modelIds,
  }));
}

function requestedFamilyAndEffort(requestedModel: string): {
  family: string;
  effort: string | undefined;
} {
  const withoutSource = requestedModel.startsWith("chatgpt:")
    ? requestedModel.slice("chatgpt:".length)
    : requestedModel;
  return parseComposedModelId(withoutSource) ?? { family: withoutSource, effort: undefined };
}

export function findAdvertisedComposedModel(
  models: SessionModelState,
  requestedModel: string,
): AdvertisedComposedModel | undefined {
  const requested = requestedFamilyAndEffort(requestedModel.trim());
  return projectAdvertisedComposedModels(models).find((model) => model.family === requested.family);
}

function selectedEffort(params: {
  requestedEffort: string | undefined;
  bracketEffort: string | undefined;
  requestedFamily: string;
  family: AdvertisedComposedModel;
  currentModelId: string;
}): string | undefined {
  const explicit = params.requestedEffort?.trim().toLowerCase();
  if (explicit && explicit !== "default") {
    return explicit;
  }
  if (params.bracketEffort) {
    return params.bracketEffort;
  }
  if (params.family.efforts.includes("medium")) {
    return "medium";
  }
  const current = requestedFamilyAndEffort(params.currentModelId);
  return current.family === params.requestedFamily ? current.effort : undefined;
}

function requireAdvertisedFamily(
  requestedModel: string,
  requestedFamily: string,
  models: SessionModelState,
): AdvertisedComposedModel {
  const family = findAdvertisedComposedModel(models, requestedFamily);
  if (family) {
    return family;
  }
  throw new RequestedModelUnsupportedError(
    `Cannot apply --model "${requestedModel}": the ACP agent did not advertise that model family. Available models: ${formatAvailableModelIds(models)}.`,
  );
}

/** Resolve a family + requested effort only against the connected adapter catalogue. */
export function resolveAdvertisedComposedModel(params: {
  requestedModel: string;
  reasoningEffort?: string;
  models: SessionModelState;
}): string {
  const requested = requestedFamilyAndEffort(params.requestedModel.trim());
  const family = requireAdvertisedFamily(params.requestedModel, requested.family, params.models);
  const effort = selectedEffort({
    requestedEffort: params.reasoningEffort,
    bracketEffort: requested.effort,
    requestedFamily: requested.family,
    family,
    currentModelId: params.models.currentModelId,
  });
  if (!effort || !family.efforts.includes(effort)) {
    throw new RequestedModelUnsupportedError(
      `Cannot apply --model "${params.requestedModel}" with reasoning effort "${effort ?? "default"}": ` +
        `${family.family} offers ${family.efforts.join(", ") || "no advertised efforts"}.`,
      "MODEL_EFFORT_OUT_OF_LADDER",
    );
  }
  const resolved = family.modelIds.find(
    (modelId) => requestedFamilyAndEffort(modelId).effort === effort,
  );
  if (!resolved) {
    throw new RequestedModelUnsupportedError(
      `Cannot apply --model "${params.requestedModel}" with reasoning effort "${effort}": the ACP agent did not advertise that composed id.`,
      "MODEL_EFFORT_OUT_OF_LADDER",
    );
  }
  return resolved;
}

// A trailing `[Nm]` (e.g. `sonnet[1m]`, `opus[1m]`) is a context-window MODIFIER on a
// base model, not a distinct model id. The adapter resolves it away before matching
// (claude-agent-acp resolveModelPreference / MODEL_CONTEXT_HINT_PATTERN), so it advertises
// only base names. Mirror that stripping here so the acpx gate is never stricter than the
// agent it guards — otherwise a `[1m]`-pinned model throws on replay even though the
// adapter would accept it.
const MODEL_CONTEXT_HINT_PATTERN = /\[\d+m\]$/i;

function stripModelContextHint(modelId: string): string {
  return modelId.replace(MODEL_CONTEXT_HINT_PATTERN, "");
}

export function supportsLegacyClaudeCodeModelMetadata(agentCommand: string | undefined): boolean {
  if (!agentCommand) {
    return false;
  }
  const { command, args } = splitCommandLine(agentCommand);
  return isClaudeAcpCommand(command, args);
}

export function formatAvailableModelIds(models: SessionModelState | undefined): string {
  const ids =
    models?.availableModels
      .map((model) => model.modelId.trim())
      .filter((modelId) => modelId.length > 0) ?? [];
  return ids.length > 0 ? ids.join(", ") : "none advertised";
}

export function assertRequestedModelSupported(params: {
  requestedModel: string;
  models: SessionModelState | undefined;
  agentCommand?: string;
  context: "apply" | "replay";
}): void {
  if (!params.models) {
    if (supportsLegacyClaudeCodeModelMetadata(params.agentCommand)) {
      return;
    }
    const action = params.context === "replay" ? "replay saved model" : "apply --model";
    throw new RequestedModelUnsupportedError(
      `Cannot ${action} "${params.requestedModel}": the ACP agent did not advertise model support. Generic model selection requires ACP models plus session/set_model support, or an adapter-specific startup model flag.`,
    );
  }

  const advertised = new Set(params.models.availableModels.map((model) => model.modelId));
  // Accept the requested model if EITHER its exact id OR its context-hint-stripped base
  // (`sonnet[1m]` -> `sonnet`) is advertised. The original alias is still what gets forwarded
  // to setSessionModel by the callers; the adapter re-resolves the hint. A genuinely-unknown
  // model (no advertised base, e.g. `gpt-9`) still throws.
  if (
    !advertised.has(params.requestedModel) &&
    !advertised.has(stripModelContextHint(params.requestedModel))
  ) {
    const action = params.context === "replay" ? "replay saved model" : "apply --model";
    throw new RequestedModelUnsupportedError(
      `Cannot ${action} "${params.requestedModel}": the ACP agent did not advertise that model. Available models: ${formatAvailableModelIds(params.models)}.`,
    );
  }
}
