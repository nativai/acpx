import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import type { SessionCreateResult } from "../acp/client.js";
import {
  harnessIdForAgentCommand,
  resolveHarnessCapabilities,
} from "../acp/harness-capabilities.js";
import {
  assertRequestedModelSupported,
  RequestedModelUnsupportedError,
} from "../acp/model-support.js";
import { withTimeout } from "../async-control.js";
import type { SessionRecord } from "../types.js";
import { guardServedModel } from "./model-guard.js";

/**
 * Whether acpx itself is serving this exact model OUTSIDE the ACP wire — today
 * that is one route: claude's OpenRouter picker route, where the slug reaches the
 * model through the shim's `OR_MODEL` and the adapter never sees it (007eaac8).
 *
 * ⚠️ THIS IS A SHARED PREDICATE BECAUSE THE APPLY QUESTION IS ASKED IN MORE THAN
 * ONE PLACE, AND SHIPPING IT IN ONLY ONE WAS A LIVE OUTAGE. The first cut put the
 * check inside {@link applyRequestedModelIfAdvertised} alone. The PROMPT path
 * (`applyPromptModelIfAdvertised`, src/cli/session/runtime.ts) does not go through
 * that dispatcher — it calls `assertRequestedModelSupported` itself — so a
 * picker-route session CREATED cleanly, took the user's first prompt, and then
 * failed the turn with *"the ACP agent did not advertise that model"*, while the
 * picker advertised claude's OpenRouter rows as selectable. **An honest refusal at
 * create had been converted into an invitation that broke on use.**
 *
 * That is the F-9 family again — "apply and replay diverged once and it cost a
 * silent brick" — with a FOURTH member the F-9 comment does not name. The
 * population of direct `assertRequestedModelSupported` callers is exactly three
 * (here, `assertRecordModelSupported` below, and the prompt path); every one of
 * them that can reach a client must ask THIS function, not re-derive the test.
 */
export function modelServedOutOfBand(
  client: Pick<ModelApplyClient, "outOfBandModelId">,
  requestedModel: string,
): boolean {
  return client.outOfBandModelId !== undefined && client.outOfBandModelId === requestedModel;
}

/**
 * Minimal client surface, so the dispatcher is unit-testable with a stub and so
 * each arm's dependency is visible. `AcpClient` satisfies it structurally.
 */
export interface ModelApplyClient {
  /** Resolves with the post-model re-read when the adapter pushed one — see
   *  {@link ModelApplyOutcome.refreshedConfigOptions}. A stub may return
   *  `undefined`, which reads as "nothing re-advertised". */
  setSessionModel(
    sessionId: string,
    modelId: string,
  ): Promise<{ refreshedConfigOptions?: SessionConfigOption[] } | void>;
  setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<{ configOptions?: SessionConfigOption[] }>;
  /**
   * The model this session is served by OUT OF BAND — set only when acpx itself
   * delivers the model outside the ACP wire. Today that is exactly one route:
   * claude's OpenRouter picker route, where the slug reaches the model through
   * the shim's `OR_MODEL` and the adapter never sees it (brick 007eaac8).
   *
   * Optional so every existing stub and every non-`AcpClient` caller keeps
   * compiling and keeps today's behaviour: `undefined` means "nothing is served
   * out of band", which is the pre-brick world.
   */
  readonly outOfBandModelId?: string | undefined;
}

/**
 * What applying a model produced.
 *
 * `refreshedConfigOptions` is **the post-model re-read** (CONCEPTION §5.2 —
 * "the single easiest thing in the whole program to get subtly wrong"). A
 * harness with a per-model depth ladder advertises the `effort` option **only
 * when the currently-selected model reasons**, so at `session/new` under a
 * non-reasoning default it is absent.
 * `session/set_config_option` answers with a REFRESHED advertisement, so the
 * options that describe the session after the model change come back on this
 * field for free — no second round-trip, and no snapshot to go stale.
 *
 * ⚠️ `undefined` means "this mechanism had nothing to re-read", and the caller
 * must then keep using the `session/new` advertisement. A caller that treats
 * `undefined` as "no options advertised" would delete claude's working depth path.
 *
 * 🛑 IT IS NO LONGER ALWAYS `undefined` FOR `session/set_model`, AND THE COMMENT
 * THAT SAID IT WAS COST EVERY PI SESSION ITS DEPTH LADDER. The claim was
 * *"`session/set_model` returns nothing to re-read"*. The RESPONSE returns
 * nothing — true, and irrelevant: the nativai `pi-acp` fork **pushes** a
 * `config_option_update` carrying the re-advertised `thought_level` selector,
 * written to the same stream just ahead of that response. Measured 2026-09-08
 * against the deployed fork (`af431c6e`): `session/new` advertises
 * `[off, minimal, low, medium, high]`, and after
 * `set_model → ~google/gemini-flash-latest` the pushed update advertises
 * `[low, medium, high]` — the model's real ladder, which the response alone
 * could never have told us.
 *
 * ⚠️ So do not re-derive this from the RESPONSE shape. `AcpClient.setSessionModel`
 * answers from a notification COUNTER, so an adapter that pushes nothing still
 * yields `undefined` and every non-pushing harness keeps today's behaviour.
 */
export interface ModelApplyOutcome {
  applied: boolean;
  refreshedConfigOptions?: SessionConfigOption[];
}

interface ModelApplyParams {
  client: ModelApplyClient;
  sessionId: string;
  requestedModel: string | undefined;
  models: SessionCreateResult["models"];
  agentCommand?: string;
  timeoutMs?: number;
  /** brick://5bac5564 Layer B belt: the pin's provenance. When present and
   *  non-explicit, a Fable pin is force-redirected to the non-Fable default;
   *  absent (legacy / caller opted out) grandfathers it (HoD Q4). */
  modelSource?: string;
  /**
   * The session's advertised config options. Required only by the
   * `config-option` arm, which validates the requested id against the advertised
   * `model` option before sending anything — the guard that keeps a stored value
   * acpx can never apply from returning by a new door.
   */
  advertisedConfigOptions?: SessionConfigOption[];
  /**
   * Whether this is the FIRST application or a REPLAY onto a reconnected session.
   * It only shapes the error wording — the DISPATCH is identical, deliberately.
   *
   * ⚠️ THIS PARAMETER EXISTS BECAUSE APPLY AND REPLAY DIVERGED ONCE AND IT COST A
   * SILENT BRICK (F-9). B3 gave the APPLY path a config-option arm and left the
   * REPLAY path on the generic check, so `set model` on a config-option harness
   * reported success, persisted the pin, and then every later turn died in
   * `assertRequestedModelSupported` — WITH rc=0, so only the empty content showed
   * it. Two code paths asking the same question two ways is what made that
   * possible; they are ONE function now so they cannot answer differently again.
   */
  context?: "apply" | "replay";
}

/**
 * Apply a requested model to a live ACP session, dispatching on the harness's
 * MODEL MECHANISM rather than assuming there is only one.
 *
 * Before B3 this function assumed `set-model`: it called
 * `assertRequestedModelSupported` unconditionally, which throws when `models` is
 * undefined — the exact shape of a harness that exposes no ACP `models` array
 * and no `session/set_model`, and carries the model as a config option instead.
 * That is why `set model` on such a harness reported success and then bricked
 * the session unrecoverably: acpx persisted a value it replays on every
 * reconnect through a path that can never apply it.
 *
 * The `config-option` arm routes to `session/set_config_option` — **the path
 * `mode` already takes successfully today**. It is not a new mechanism; it is
 * the existing one, reached for the axis that needed it.
 *
 * ⚠️ An agent command the descriptor does not classify keeps the generic
 * `set-model` path. Answering with a neighbouring harness's mechanism would send
 * a `session/set_config_option` to an adapter that never advertised one.
 */
export async function applyRequestedModelIfAdvertised(
  params: ModelApplyParams,
): Promise<ModelApplyOutcome> {
  const rawRequested =
    typeof params.requestedModel === "string" ? params.requestedModel.trim() : "";
  if (!rawRequested) {
    return { applied: false };
  }
  // ⚠️ SERVED OUT OF BAND — THE APPLY IS A NO-OP AND `applied: true` IS THE
  // TRUTHFUL ANSWER, NOT A CONVENIENT ONE (brick 007eaac8). On claude's OpenRouter
  // picker route the shim rewrites every outbound request to this slug, so the
  // model IS applied — through `OR_MODEL` rather than through `session/set_model`.
  // Reporting `false` would leave `current_model_id` unset on a session that is
  // demonstrably being served by that model, and would make the reconnect replay
  // report a failure it did not have.
  //
  // ⚠️ IT IS DELIBERATELY THE FIRST TEST, AHEAD OF `guardServedModel`. The Fable
  // belt exists for a model that arrives by INHERITANCE or DEFAULT; a slug on this
  // route can only ever arrive from an explicit pick. Letting the belt rewrite it
  // first would produce a `requestedModel` that no longer matches the shim's model,
  // fall through to `assertRequestedModelSupported`, and throw on a session that is
  // running correctly.
  //
  // Without this branch, wiring the shim ALONE would break every picker-route
  // create: claude-agent-acp advertises only its own aliases, so the slug would
  // reach `assertRequestedModelSupported` and be refused.
  if (modelServedOutOfBand(params.client, rawRequested)) {
    return { applied: true };
  }
  const guarded = guardServedModel({
    requestedModel: rawRequested,
    modelSource: params.modelSource,
    availableModels: params.models?.availableModels.map((model) => model.modelId),
  });
  const requestedModel = guarded.model ?? rawRequested;

  return await applyModelAsSetModel(params, requestedModel, guarded.forced);
}

/** The generic path: claude, claude-pty, codex and pi. */
async function applyModelAsSetModel(
  params: ModelApplyParams,
  requestedModel: string,
  guardForced: boolean,
): Promise<ModelApplyOutcome> {
  assertRequestedModelSupported({
    requestedModel,
    models: params.models,
    agentCommand: params.agentCommand,
    context: params.context ?? "apply",
  });
  if (!params.models) {
    return { applied: false };
  }
  if (!guardForced && params.models.currentModelId === requestedModel) {
    return { applied: true };
  }
  const result = await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel),
    params.timeoutMs,
  );
  // The post-model re-read, when the adapter pushed one — see the note on
  // `ModelApplyOutcome.refreshedConfigOptions` for why the RESPONSE being empty
  // is not evidence that nothing was re-advertised.
  const refreshed = result ? result.refreshedConfigOptions : undefined;
  return { applied: true, ...(refreshed ? { refreshedConfigOptions: refreshed } : {}) };
}

/**
 * The advertisement to use AFTER a model was applied — the post-model re-read,
 * in one place so the rule cannot be got wrong at one call site out of four.
 *
 * ⚠️ `undefined` refreshed options means "this mechanism had nothing to re-read",
 * NOT "nothing is advertised". Collapsing the two deletes claude's and
 * claude-pty's working depth path, which is why this is a named function rather
 * than a `??` repeated at each site.
 */
export function advertisedAfterModelApply(
  outcome: ModelApplyOutcome,
  sessionNewAdvertisement: SessionConfigOption[] | undefined,
): SessionConfigOption[] | undefined {
  return outcome.refreshedConfigOptions ?? sessionNewAdvertisement;
}

/**
 * The MODE ladder to use after a model was applied — the sibling of
 * {@link advertisedAfterModelApply}, and the fix for the defect that having only
 * one of the two produced.
 *
 * 🛑 THE DEFECT, MEASURED ON LIVE SESSIONS 2026-09-08. For a `mode`-mechanism
 * harness the ACP mode advertisement **is** the depth ladder, and for pi it is
 * **per model**. `session-management.ts` passed `advertised: advertisedAfterModel`
 * (post-model) and `modes: sessionResult.modes` (**`session/new`** — pre-model) to
 * the same call, so every pi session projected its depth request onto pi's
 * *default* model's ladder. That default carries no `thinkingLevelMap`, so no
 * rung ever carried a `_meta.piAcp.servedEffort` and the read-the-agent's-own-
 * advertisement mechanism that replaced `PI_WIRE_DEPTH_LADDER` **could not fire
 * even once** — 83 of pi 0.84.4's 362 catalogue models declare a renaming map and
 * not one of them was reachable. `--reasoning-effort off` on a model whose map
 * nulls `off` recorded `outcome: "off"` while pi sent `{"effort":"low"}`.
 *
 * ## Why the config option, and not a re-read of `session/new`
 *
 * ACP has **no notification variant that re-advertises `availableModes`** (the
 * `SessionUpdate` union has `current_mode_update` and nothing for the list), and
 * `session/set_model` answers `{}`. But an agent whose depth is a mode also
 * advertises it as a selector carrying ACP's own spec category
 * **`thought_level`**, and THAT is re-emitted on `config_option_update`. So the
 * post-model ladder is already on the wire; it simply had no reader.
 *
 * ⚠️ Matched on `category`, never on the option's `id`. pi's id is
 * `thought_level` but claude's is `effort` — an id match is a per-harness list,
 * which is the shape of every fact this programme has had to un-freeze.
 *
 * ⚠️ `_meta` is carried through per option, because that is where
 * `advertisedServedEffort` reads `_meta.piAcp.servedEffort`. Dropping it would
 * leave the ladder correct and the served value invisible — the same gap one
 * layer down.
 *
 * ⚠️ An option with no values yields `undefined`, NOT an empty ladder. An empty
 * ladder projects to `unavailable`, so a malformed advertisement would silently
 * disable a depth control that works; keeping `session/new` is the safe read.
 */
export function modesAfterModelApply(
  sessionNewModes: SessionModeState | undefined,
  advertisedAfterModel: SessionConfigOption[] | undefined,
): SessionModeState | undefined {
  const option = advertisedAfterModel?.find(
    (entry) => entry.category === "thought_level" && entry.type === "select",
  );
  if (option?.type !== "select") {
    return sessionNewModes;
  }
  const availableModes = flattenSelectValues(option.options).map(toAdvertisedMode);
  if (availableModes.length === 0) {
    return sessionNewModes;
  }
  return {
    currentModeId: currentModeIdFrom(option.currentValue, sessionNewModes, availableModes[0].id),
    availableModes,
  };
}

/**
 * The CURRENT model's depth ladder, read off a live advertisement (brick a3c65f0f).
 *
 * {@link modesAfterModelApply} answers the CREATE-time question: which ladder should
 * a `--reasoning-effort` request project onto, given the `session/new` snapshot plus
 * the post-model re-read. THIS function answers the LIVE question: a `set effort`
 * on an already-running session has no `session/new` snapshot of its own — and the
 * snapshot it could reach (the record's) describes whichever model was default at
 * creation, not the model the session runs now (measured 2026-09-13: a session
 * re-pinned to `openrouter/z-ai/glm-5.3-flash` advertises `thought_level` values
 * `["low","high"]` while its `session/new` modes said `off…high` for the default
 * model — projecting `max` onto the stale ladder and the live one both land on
 * `high` here, but they diverge for any model whose default ladder differs from its
 * own). The live advertisement — `AcpClient.getAdvertisedConfigOptions()`, kept
 * current by every pushed `config_option_update` — is the one source that tracks the
 * session.
 *
 * Same derivation rules as {@link modesAfterModelApply}, stated there: matched on
 * `category` (never the option id), `_meta` carried through per rung, an option with
 * no values yields `undefined` rather than an empty ladder — here the caller records
 * `unavailable` with a reason instead of silently disabling a live control.
 */
export function advertisedDepthLadderFromConfigOptions(
  advertised: readonly SessionConfigOption[] | undefined,
): SessionModeState | undefined {
  const option = advertised?.find(
    (entry) => entry.category === "thought_level" && entry.type === "select",
  );
  if (option?.type !== "select") {
    return undefined;
  }
  const availableModes = flattenSelectValues(option.options).map(toAdvertisedMode);
  if (availableModes.length === 0) {
    return undefined;
  }
  return {
    currentModeId:
      typeof option.currentValue === "string" && option.currentValue.trim()
        ? option.currentValue
        : availableModes[0].id,
    availableModes,
  };
}

/** The selector's own current value, else the `session/new` mode, else the ladder's foot. */
function currentModeIdFrom(
  currentValue: unknown,
  sessionNewModes: SessionModeState | undefined,
  fallback: string,
): string {
  const advertised = typeof currentValue === "string" ? currentValue.trim() : "";
  return advertised || sessionNewModes?.currentModeId || fallback;
}

/**
 * A `select` option's entries are either values or GROUPS of values; only a value
 * names a rung. Groups are FLATTENED rather than skipped — a harness that groups
 * its rungs must not read as advertising an empty ladder.
 */
function flattenSelectValues(entries: readonly unknown[]): AdvertisedSelectValue[] {
  const flat: AdvertisedSelectValue[] = [];
  for (const entry of entries) {
    const group = entry as { options?: unknown };
    if (Array.isArray(group.options)) {
      flat.push(...(group.options as AdvertisedSelectValue[]));
    } else {
      flat.push(entry as AdvertisedSelectValue);
    }
  }
  return flat;
}

/** The value entries of a `select` config option, as much of them as a mode needs. */
interface AdvertisedSelectValue {
  value: string;
  name?: string | null;
  description?: string | null;
  _meta?: unknown;
}

function toAdvertisedMode(
  value: AdvertisedSelectValue,
): SessionModeState["availableModes"][number] {
  return {
    id: value.value,
    name: value.name ?? value.value,
    ...(value.description ? { description: value.description } : {}),
    // Carried, not dropped: `_meta.piAcp.servedEffort` lives here.
    ...(value._meta ? { _meta: value._meta as Record<string, unknown> } : {}),
  };
}

/**
 * THE LOUD-FAILURE GATE for a live model change acpx cannot apply (B0.2).
 *
 * It runs BEFORE anything is persisted, and the ordering is the entire fix. On a
 * harness whose model is an ACP **config option** (`session/set_config_option`)
 * there is no `models` array and no `session/set_model`, so acpx's
 * generic path stored a `session_options.model` it could never apply, and the
 * session then became **unrecoverable**: every later connect replayed the bad
 * stored value first, so even setting the model *back* failed. A success message
 * for a value the adapter rejected is the worst of both: the user believes the
 * model changed, and the session is dead.
 *
 * The predicate is the descriptor's `canSetModelLive`, which is DERIVED from the
 * harness's mechanism AND from whether acpx routes that mechanism today
 * (`MODEL_MECHANISMS_ROUTED_BY_ACPX`). B3 landed the config-option apply path
 * and the list entry in one commit, so this gate opened on its own — with no
 * edit here and no edit to the table. That is the derivation working, and it is
 * why neither this function nor `HARNESS_FACTS` was touched to achieve it.
 *
 * ⚠️ It refuses only for a harness the descriptor KNOWS. An unrecognised agent
 * command falls through to the pre-existing advertised-models check below — the
 * gate must not start refusing model changes on adapters it has never classified.
 */
export function assertLiveModelChangeRoutable(record: SessionRecord): void {
  const harness = harnessIdForAgentCommand(record.agentCommand);
  if (harness === undefined) {
    return;
  }
  // Pass the session's own advertisement so the answer can only NARROW, never
  // widen — the descriptor's stated one-way property.
  const advertised = record.acpx?.config_options;
  const capabilities = resolveHarnessCapabilities(
    harness,
    advertised ? { configOptions: advertised } : undefined,
  );
  if (capabilities.canSetModelLive) {
    return;
  }
  throw new RequestedModelUnsupportedError(
    `Cannot set the model on this ${harness} session: ` +
      `${capabilities.liveModelChangeReason ?? "acpx has no live model path for this harness."} ` +
      `Nothing was written — the session is unchanged and still usable.`,
  );
}

export function assertRecordModelSupported(params: {
  record: SessionRecord;
  requestedModel: string;
  context?: "apply" | "replay";
}): void {
  const availableModels = params.record.acpx?.available_models;
  if (!availableModels || availableModels.length === 0) {
    return;
  }
  const models = {
    currentModelId: params.record.acpx?.current_model_id ?? "",
    availableModels: availableModels.map((modelId) => ({ modelId, name: modelId })),
  };
  assertRequestedModelSupported({
    requestedModel: params.requestedModel,
    models,
    agentCommand: params.record.agentCommand,
    context: params.context ?? "apply",
  });
}
