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
  constructor(message: string) {
    super(message, {
      outputCode: "USAGE",
      detailCode: "MODEL_NOT_ADVERTISED",
      origin: "cli",
    });
    this.name = "RequestedModelUnsupportedError";
  }
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
    // ⚠️ THIS MESSAGE DESCRIBES A RESPONSE, NOT A CAPABILITY. DO NOT SHORTEN IT
    // BACK TO "the ACP agent did not advertise model support" — that wording is
    // punchier, it is what shipped, and it cost a night. pi-acp's
    // `unstable_forkSession` returned `{sessionId, modes, configOptions, _meta}`
    // and omitted `models`, while its OWN `session/new` and `session/load` both
    // returned it. `models` therefore arrived here `undefined`, this branch fired,
    // and the sentence asserted that the ADAPTER lacks model support — about an
    // adapter that implements `session/set_model` and serves OpenRouter models on
    // every turn. Daniel could not fork a pi session, and the message sent the
    // investigation at acpx for an hour before anyone read the adapter's fork
    // handler. (bricks 8320bedc / a82f6833; fixed in nativai/pi-acp 73f2e39.)
    //
    // ⚠️ `undefined` here means ONE RESPONSE CARRIED NO `models`, and WHICH
    // response is not knowable at this seam: the three direct callers are the
    // apply path (create/fork), the replay path and the prompt path. So the
    // message names all three candidates rather than guessing one — naming a
    // single seam would read better and would be wrong two times in three.
    //
    // `test/model-support.test.ts` pins both halves: the capability claim must
    // stay absent, and the response-scoped wording must stay present.
    throw new RequestedModelUnsupportedError(
      `Cannot ${action} "${params.requestedModel}": this session carries no ACP \`models\` advertisement — the agent's session/new, session/load or session/fork response did not include one. That describes THAT RESPONSE, not the agent's capability: an adapter can implement session/set_model and still omit \`models\` from one of them. Generic model selection needs an advertised \`models\` list plus session/set_model support, or an adapter-specific startup model flag.`,
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
