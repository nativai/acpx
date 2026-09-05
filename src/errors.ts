import type { OutputErrorAcpPayload, OutputErrorCode, OutputErrorOrigin } from "./types.js";

type AcpxErrorOptions = ErrorOptions & {
  outputCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
  outputAlreadyEmitted?: boolean;
};

export class AcpxOperationalError extends Error {
  readonly outputCode?: OutputErrorCode;
  readonly detailCode?: string;
  readonly origin?: OutputErrorOrigin;
  readonly retryable?: boolean;
  readonly acp?: OutputErrorAcpPayload;
  readonly outputAlreadyEmitted?: boolean;

  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.outputCode = options?.outputCode;
    this.detailCode = options?.detailCode;
    this.origin = options?.origin;
    this.retryable = options?.retryable;
    this.acp = options?.acp;
    this.outputAlreadyEmitted = options?.outputAlreadyEmitted;
  }
}

export class SessionNotFoundError extends AcpxOperationalError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

export class SessionResolutionError extends AcpxOperationalError {}

/**
 * brick://16712ece — ⚠️ THIS MESSAGE IS TESTED, WORD BY ROUTE. Every route it
 * names must EXIST, and every route that exists and an operator can reach from
 * a CLI must be named.
 *
 * The text this replaced said *"deliver a message to its session URL to
 * **reopen-and-deliver**"* — a behaviour that had already been REMOVED
 * (brick://8f3aaa73's no-auto-reopen rule): a plain delivery to a closed session
 * is now rejected `409 SESSION_CLOSED`, and reopening needs `--reopen`, which
 * the old text never mentioned. So the refusal handed the operator two routes,
 * of which one (acpx-ui's button) needs a browser and the other simply did not
 * work — measured, and it is the defect this brick is named for.
 *
 * ⚠️ THIS IS THE SECOND TIME, IN THE OPPOSITE DIRECTION. Before `2deef5c`
 * (2026-06-30) the message named ``acpx sessions reopen <name>`` — a verb that,
 * settled with `git log -S` over all refs, **never existed in this repo**. That
 * commit fixed the lie by DELETING the mention and pinning its absence
 * (`doesNotMatch(/sessions reopen/)`) in two test files. The replacement text
 * then went stale in its turn, and those pins actively forbade the honest fix.
 * The loop only ends by BUILDING the verb the message wants to name — which is
 * what this change does. If you are about to make this text name a route again,
 * make sure the route EXISTS first; that is the whole lesson, twice over.
 *
 * It survived because NOTHING TESTED THE TEXT; worse, the one assertion that
 * touched it PINNED THE OLD REALITY (`assert.doesNotMatch(message,
 * /sessions reopen/)`), so the message could only ever go staler. The guard is
 * now the other way round in test/session-closed-recovery.test.ts: the message
 * must name `sessions reopen` and `--reopen`, and must NOT re-acquire the
 * removed `reopen-and-deliver` promise. If you change a recovery route, change
 * it here and there in the same commit.
 */
export class SessionClosedError extends AcpxOperationalError {
  readonly sessionId: string;
  readonly sessionName: string | undefined;

  constructor(sessionId: string, sessionName: string | undefined) {
    const label = sessionName ?? sessionId;
    super(
      `Session '${label}' is closed; prompts are rejected until it is reopened. ` +
        `Reopen it with \`acpx sessions reopen ${sessionId}\`, or click Reopen in acpx-ui. ` +
        `To reopen and deliver in one step, use \`send-message.sh --reopen <session-url> '<text>'\` — ` +
        `a plain delivery to a closed session does NOT reopen it, it is rejected with 409 SESSION_CLOSED.`,
      {
        outputCode: "RUNTIME",
        detailCode: "SESSION_CLOSED",
        origin: "runtime",
      },
    );
    this.sessionId = sessionId;
    this.sessionName = sessionName;
  }
}

export class AgentSpawnError extends AcpxOperationalError {
  readonly agentCommand: string;

  constructor(agentCommand: string, cause?: unknown) {
    super(`Failed to spawn agent command: ${agentCommand}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.agentCommand = agentCommand;
  }
}

export class AgentStartupError extends AcpxOperationalError {
  readonly agentCommand: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrSummary?: string;

  constructor(params: {
    agentCommand: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderrSummary?: string;
    cause?: unknown;
  }) {
    const exitSummary = `exit=${params.exitCode ?? "null"}, signal=${params.signal ?? "null"}`;
    const stderrSuffix =
      typeof params.stderrSummary === "string" && params.stderrSummary.trim().length > 0
        ? `: ${params.stderrSummary.trim()}`
        : "";
    super(`ACP agent exited before initialize completed (${exitSummary})${stderrSuffix}`, {
      cause: params.cause instanceof Error ? params.cause : undefined,
      outputCode: "RUNTIME",
      detailCode: "AGENT_STARTUP_FAILED",
      origin: "acp",
    });
    this.agentCommand = params.agentCommand;
    this.exitCode = params.exitCode;
    this.signal = params.signal;
    this.stderrSummary = params.stderrSummary?.trim() || undefined;
  }
}

export class AgentDisconnectedError extends AcpxOperationalError {
  readonly reason: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    reason: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    options?: AcpxErrorOptions,
  ) {
    super(
      `ACP agent disconnected during request (${reason}, exit=${exitCode ?? "null"}, signal=${signal ?? "null"})`,
      {
        outputCode: "RUNTIME",
        detailCode: "AGENT_DISCONNECTED",
        origin: "acp",
        ...options,
      },
    );
    this.reason = reason;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export class UnsupportedPromptContentError extends AcpxOperationalError {
  constructor(message: string) {
    super(message, {
      outputCode: "USAGE",
      detailCode: "UNSUPPORTED_PROMPT_CONTENT",
      origin: "acp",
    });
  }
}

export class SessionResumeRequiredError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_RESUME_REQUIRED",
      origin: "acp",
      retryable: true,
      ...options,
    });
  }
}

export class SessionOwnerRestoreError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_OWNER_RESTORE_FAILED",
      origin: "runtime",
      retryable: false,
      ...options,
    });
  }
}

export class GeminiAcpStartupTimeoutError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "TIMEOUT",
      detailCode: "GEMINI_ACP_STARTUP_TIMEOUT",
      origin: "acp",
      ...options,
    });
  }
}

// A subscription id was requested that is not in the registry. Usage error.
export class SubscriptionUnknownError extends AcpxOperationalError {
  constructor(id: string, knownIds?: readonly string[]) {
    const known =
      knownIds && knownIds.length > 0
        ? ` Known subscription ids: ${knownIds.join(", ")}.`
        : " Known subscription ids: none.";
    super(
      `subscription "${id}" not found in registry (~/.acpx/subscriptions/registry.json).${known}`,
      {
        outputCode: "USAGE",
        detailCode: "SUBSCRIPTION_UNKNOWN",
        origin: "cli",
      },
    );
  }
}

// A subscription/profile was requested while it is user-locked. Locks are not
// quota exhaustion: they are operator intent and must render with lock-specific
// recovery UI.
export class SubscriptionLockedError extends AcpxOperationalError {
  readonly subscriptionId: string;

  constructor(
    id: string,
    options?: { origin?: "cli" | "runtime"; outputCode?: "USAGE" | "RUNTIME" },
  ) {
    super(
      `subscription "${id}" is locked. Unlock it or select a different subscription before starting another turn.`,
      {
        outputCode: options?.outputCode ?? "USAGE",
        detailCode: "subscription-locked",
        origin: options?.origin ?? "cli",
      },
    );
    this.subscriptionId = id;
  }
}

export class SubscriptionChangeRequiresSwitchError extends AcpxOperationalError {
  constructor(params: {
    sessionLabel: string;
    currentSubscription?: string;
    requestedSubscription: string;
    switchCommand: string;
  }) {
    const current = params.currentSubscription
      ? `"${params.currentSubscription}"`
      : "no recorded subscription";
    super(
      `Cannot apply --subscription "${params.requestedSubscription}" to existing session ${params.sessionLabel}: current subscription is ${current}. Use \`${params.switchCommand}\` to switch the session before prompting; no prompt was sent.`,
      {
        outputCode: "USAGE",
        detailCode: "SUBSCRIPTION_CHANGE_REQUIRES_SWITCH",
        origin: "cli",
      },
    );
  }
}

// Every registered subscription is dead (401) or maxed (≥ threshold) — there is
// nothing to fail over to. Terminal turn error; the record's selection is left
// unchanged so a later turn re-probes and auto-recovers when a window resets.
// `code` (OutputErrorCode) is a closed set, so the cross-repo contract string
// lives in detailCode = "all-subscriptions-exhausted" (acpx-ui maps it to its
// "all subscriptions exhausted" notice).
export class AllSubscriptionsExhaustedError extends AcpxOperationalError {
  constructor(statuses: string) {
    super(`All subscriptions are exhausted or unavailable. ${statuses}`, {
      outputCode: "RUNTIME",
      detailCode: "all-subscriptions-exhausted",
      origin: "runtime",
    });
  }
}

// Every Fable-eligible subscription rejects claude-fable-5 with 429 while the
// unified 5h/7d windows are HEALTHY (the per-model "fallback" cap). A SEPARATE
// terminal condition from AllSubscriptionsExhaustedError, whose unified-window
// premise is FALSE here. detailCode 'fable-share-exhausted' is the cross-repo
// contract string; normalizeOutputError reads outputCode+detailCode off the
// AcpxOperationalError base, so it flows through the SAME builder + persist mirror
// as the existing terminal errors with ZERO persist-path changes. Record
// selection is left unchanged so a later turn re-probes and auto-recovers when
// the Fable-share window resets. Only ever thrown when isFableModel(sessionModel).
export class FableShareExhaustedError extends AcpxOperationalError {
  constructor(statuses: string) {
    super(
      `Fable-share limit reached on all subscriptions (per-model fallback cap; ` +
        `unified 5h/7d windows are healthy). ${statuses} — switch to a non-Fable ` +
        `model (e.g. \`--model opus\` / \`sessions set-model opus\`) or wait for the ` +
        `Fable-share window to reset (this Fable-share limit is intermittent — a ` +
        `later turn may succeed).`,
      {
        outputCode: "RUNTIME",
        detailCode: "fable-share-exhausted",
        origin: "runtime",
      },
    );
  }
}

// The turn was served (or is knowably about to be served) BELOW a pinned model
// floor — the API silently downgraded the pinned model (e.g. fable → sonnet)
// under load, which acpx cannot PREVENT (the serving choice is the harness/API's,
// not acpx's) but MUST refuse to silently ACCEPT. Raised in two places under
// `--floor-hard`: (i) the pre-turn probe-gate, when the pinned model probes
// cleanly unavailable (retryable, no prompt submitted); (ii) the post-serve
// check, when the last served assistant model is not the pinned model (the turn
// does NOT settle as end_turn — its content is quarantined behind this terminal).
// detailCode 'model-floor-unmet' is the cross-repo contract string; acpx-ui maps
// it to a dedicated "served below pinned floor" banner. Retryable so a bounded
// auto-retry can re-probe; the record's desired pin is NEVER mutated by this
// error, so a later at-floor serve auto-recovers.
export class ModelFloorUnmetError extends AcpxOperationalError {
  readonly pinnedModel: string;
  readonly servedModel: string | undefined;
  readonly phase: "pre-turn" | "post-serve";

  constructor(params: {
    pinnedModel: string;
    servedModel?: string;
    phase: "pre-turn" | "post-serve";
    detail?: string;
  }) {
    const servedClause =
      params.phase === "pre-turn"
        ? `the pinned model "${params.pinnedModel}" is not servable right now (probed cleanly unavailable)`
        : `the turn was served "${params.servedModel ?? "unknown"}" instead of the pinned model "${params.pinnedModel}"`;
    super(
      `Model floor not met: ${servedClause}. Under --floor-hard, below-floor work is not accepted — ` +
        `the pinned model+effort are unchanged and the session auto-recovers once the pin is served again` +
        (params.detail ? ` (${params.detail})` : "") +
        `.`,
      {
        outputCode: "RUNTIME",
        detailCode: "model-floor-unmet",
        origin: "runtime",
        retryable: true,
      },
    );
    this.pinnedModel = params.pinnedModel;
    this.servedModel = params.servedModel;
    this.phase = params.phase;
  }
}

export function isModelFloorUnmetError(error: unknown): error is ModelFloorUnmetError {
  return error instanceof ModelFloorUnmetError;
}

export function isSessionResumeRequiredError(error: unknown): error is SessionResumeRequiredError {
  return error instanceof SessionResumeRequiredError;
}

// Every same-family subscription target is locked by operator action. Distinct
// from exhausted/quota so retry-exhausted semantics remain untouched.
export class AllSubscriptionsLockedError extends AcpxOperationalError {
  constructor(statuses: string) {
    super(`All compatible subscriptions are locked. ${statuses}`, {
      outputCode: "RUNTIME",
      detailCode: "all-subscriptions-locked",
      origin: "runtime",
    });
  }
}

// `subscriptions remove` targeted the registry's current default. Removing it
// would silently drop every unselected spawn to the raw global ~/.claude, so the
// operator must say what the new default is — `--set-default <id>` to repoint it
// or `--clear-default` to accept the fallthrough deliberately.
export class SubscriptionRemoveDefaultError extends AcpxOperationalError {
  constructor(id: string, candidates: readonly string[]) {
    const suggestion =
      candidates.length > 0
        ? ` Pass --set-default <id> (candidates: ${candidates.join(", ")}) or --clear-default.`
        : " No other profile remains; pass --clear-default to remove it anyway.";
    super(
      `subscription "${id}" is the registry default; refusing to leave the default dangling.${suggestion}`,
      {
        outputCode: "USAGE",
        detailCode: "SUBSCRIPTION_REMOVE_DEFAULT",
        origin: "cli",
      },
    );
  }
}

// A `subscriptions remove` flag that must name a DIFFERENT profile (--set-default,
// --reassign) was pointed at the very profile being removed — it would re-point
// straight back at the entry about to disappear.
export class SubscriptionRemoveSelfReferenceError extends AcpxOperationalError {
  constructor(flag: string, id: string, candidates: readonly string[]) {
    const suggestion = candidates.length > 0 ? ` Candidates: ${candidates.join(", ")}.` : "";
    super(
      `${flag} cannot be "${id}" — that is the profile being removed; it needs a different id.${suggestion}`,
      {
        outputCode: "USAGE",
        detailCode: "SUBSCRIPTION_REMOVE_SELF_REFERENCE",
        origin: "cli",
      },
    );
  }
}

// `--purge` was asked to delete a dir that is not strictly beneath
// ~/.acpx/subscriptions. A registry entry is just a string on disk, so a
// malformed or hand-edited credentialSource would otherwise turn a routine
// removal into a recursive delete of something else. Refused BEFORE any
// mutation so the operator can fix the entry or re-run without --purge.
export class SubscriptionPurgeOutsideRootError extends AcpxOperationalError {
  constructor(id: string, dir: string, root: string) {
    super(
      `refusing to --purge "${dir}" for "${id}": it is not inside ${root}. ` +
        `Re-run without --purge to drop the registry entry only, then remove the directory yourself.`,
      {
        outputCode: "USAGE",
        detailCode: "SUBSCRIPTION_PURGE_OUTSIDE_ROOT",
        origin: "cli",
      },
    );
  }
}

// `subscriptions remove` targeted a profile that live sessions are still pinned
// to. Their persisted session_options.profile would dangle, and applyProfileAuth
// throws on an unknown profile rather than silently spawning under another
// account — so those sessions would fail at their next spawn. Refuse by default;
// `--reassign <id>` re-pins them, `--force` accepts the breakage.
export class SubscriptionRemoveInUseError extends AcpxOperationalError {
  readonly openSessions: number;

  constructor(id: string, openSessions: number, candidates: readonly string[]) {
    const suggestion = candidates.length > 0 ? ` (candidates: ${candidates.join(", ")})` : "";
    super(
      `subscription "${id}" is still pinned by ${openSessions} open session(s); ` +
        `they would fail to spawn once it is gone. ` +
        `Pass --reassign <id> to re-pin them${suggestion}, or --force to remove anyway.`,
      {
        outputCode: "USAGE",
        detailCode: "SUBSCRIPTION_REMOVE_IN_USE",
        origin: "cli",
      },
    );
    this.openSessions = openSessions;
  }
}

// A claude-home (PTY bridge) turn failed because the bridge's Claude login is
// gated/expired and no sibling bridge has a usable login. NOT quota — detailCode
// 'auth-gated' so acpx-ui renders the existing AuthGatedBanner (keyed on
// lastError.code === 'auth-gated'), never the exhausted/quota one. Sibling of
// AllSubscriptionsExhaustedError; the record's selection is left unchanged so a
// later turn re-probes and auto-recovers once the login is refreshed.
export class BridgeAuthGatedError extends AcpxOperationalError {
  constructor(statuses: string) {
    super(`Claude bridge needs an interactive login on this box. ${statuses}`, {
      outputCode: "RUNTIME",
      detailCode: "auth-gated",
      origin: "runtime",
    });
  }
}

// A manual subscription switch was requested while a turn is in flight on the
// live queue owner. Refused (not queued) — switching mid-stream would tear the
// client down. acpx-ui maps the "turn-in-flight" detailCode to a 409.
export class SubscriptionTurnInFlightError extends AcpxOperationalError {
  constructor(sessionName?: string) {
    const label = sessionName ? ` '${sessionName}'` : "";
    super(
      `Cannot switch subscription while a turn is in flight on session${label}; wait for the current turn to finish (turn-in-flight).`,
      {
        outputCode: "USAGE",
        detailCode: "TURN_IN_FLIGHT",
        origin: "queue",
      },
    );
  }
}

// `set profile <id>` names a profile not in the registry. Sibling of
// SubscriptionUnknownError for the unified credential-move path.
export class ProfileUnknownError extends AcpxOperationalError {
  constructor(id: string, knownIds?: readonly string[]) {
    const known =
      knownIds && knownIds.length > 0
        ? ` Known profile ids: ${knownIds.join(", ")}.`
        : " Known profile ids: none.";
    super(`profile "${id}" not found in registry (~/.acpx/subscriptions/registry.json).${known}`, {
      outputCode: "USAGE",
      detailCode: "PROFILE_UNKNOWN",
      origin: "cli",
    });
  }
}

// A `set profile` move was requested across credential classes (e.g. an SDK
// subscription session → a claude-pty bridge profile, or → an openrouter API-key
// profile). The auth layer requires a move to stay within the session's
// adapter/authMode class (claude-home⟺claude-pty vs subscription⟺SDK), so the
// move is refused before it can wedge the next turn's auth.
export class ProfileClassMismatchError extends AcpxOperationalError {
  constructor(params: {
    targetId: string;
    targetAuthMode: string;
    currentId: string;
    currentAuthMode: string;
  }) {
    super(
      `Cannot move session to profile "${params.targetId}" (authMode "${params.targetAuthMode}"): ` +
        `the session's current credential "${params.currentId}" is authMode "${params.currentAuthMode}". ` +
        `A move must stay within the same credential class (subscription↔subscription or claude-home↔claude-home).`,
      {
        outputCode: "USAGE",
        detailCode: "PROFILE_CLASS_MISMATCH",
        origin: "cli",
      },
    );
  }
}

// A manual profile move was requested while a turn is in flight on the live
// queue owner. Refused (not queued) — moving mid-stream would tear the client
// down. Shares the "TURN_IN_FLIGHT" detailCode with the subscription path so
// acpx-ui maps it to the same 409.
export class ProfileTurnInFlightError extends AcpxOperationalError {
  constructor(sessionName?: string) {
    const label = sessionName ? ` '${sessionName}'` : "";
    super(
      `Cannot move the session to a different credential while a turn is in flight on session${label}; wait for the current turn to finish (turn-in-flight).`,
      {
        outputCode: "USAGE",
        detailCode: "TURN_IN_FLIGHT",
        origin: "queue",
      },
    );
  }
}

// A manual `set model` (CLI verb, recycle path) was requested while a turn is in
// flight on the live queue owner. Refused (not queued) — recycling the owner
// would SIGKILL the live turn. Shares the "TURN_IN_FLIGHT" detailCode with the
// subscription/profile paths so acpx-ui maps it to the same 409.
export class ModelTurnInFlightError extends AcpxOperationalError {
  constructor(sessionName?: string) {
    const label = sessionName ? ` '${sessionName}'` : "";
    super(
      `Cannot change the model while a turn is in flight on session${label}; wait for the current turn to finish (turn-in-flight).`,
      {
        outputCode: "USAGE",
        detailCode: "TURN_IN_FLIGHT",
        origin: "queue",
      },
    );
  }
}

// A manual `set <configId>` (CLI verb, recycle path — e.g. thinking depth via
// `set effort`) was requested while a turn is in flight on the live queue owner.
// Refused for the same reason as ModelTurnInFlightError; same 409 contract.
export class ConfigOptionTurnInFlightError extends AcpxOperationalError {
  constructor(configId: string, sessionName?: string) {
    const label = sessionName ? ` '${sessionName}'` : "";
    super(
      `Cannot change config option "${configId}" while a turn is in flight on session${label}; wait for the current turn to finish (turn-in-flight).`,
      {
        outputCode: "USAGE",
        detailCode: "TURN_IN_FLIGHT",
        origin: "queue",
      },
    );
  }
}

/**
 * brick://874fee67 — refuse a config change that would recycle the owner while
 * prompts are QUEUED BEHIND the active turn.
 *
 * Distinct from {@link ConfigOptionTurnInFlightError}: that one guards the turn
 * currently RUNNING. This one guards work already handed to the owner and
 * waiting. acpx has no persisted prompt queue — the owner's entire on-disk
 * footprint is a `.lock` and a `.sock`, so anything the owner holds in memory
 * dies with it. Deferring the recycle protects the active turn but not the
 * queue, so a recycle here would silently drop a prompt the user already sent.
 * Refusing turns that into a visible "try again when idle".
 */
export class ConfigOptionQueuedWorkError extends AcpxOperationalError {
  constructor(configId: string, sessionName?: string) {
    const label = sessionName ? ` '${sessionName}'` : "";
    super(
      `Cannot change config option "${configId}" while work is queued on session${label}; the change would restart the agent and drop the queued prompt(s) — try again once the queue has drained (queued-work).`,
      {
        outputCode: "USAGE",
        detailCode: "QUEUED_WORK",
        origin: "queue",
      },
    );
  }
}

/**
 * brick://874fee67 — the session's agent advertises no `outputStyle` config
 * option, so a style would be persisted and then silently ignored.
 *
 * Support is derived from the live ADVERTISEMENT, never from the agent name: a
 * name check would call a claude session on a not-yet-updated adapter
 * "supported" and hand the user a control that does nothing. Codex lands here
 * with no special-casing anywhere, which is the point.
 */
export class OutputStyleNotSupportedError extends AcpxOperationalError {
  constructor(agent: string) {
    super(
      `Agent "${agent}" does not support output styles (it advertises no "outputStyle" config option).`,
      { outputCode: "USAGE", detailCode: "UNSUPPORTED_ADAPTER", origin: "queue" },
    );
  }
}

/**
 * brick://874fee67 — the requested style is not one the session's agent offers.
 *
 * ⚠️ This error exists because CLAUDE CODE ITSELF DOES NOT VALIDATE: it accepts
 * any string and echoes it back as the active style (measured). Without this
 * refusal a typo produces a session that reports a style it does not have, on
 * every surface. Never relax it into a warning.
 */
export class OutputStyleUnknownError extends AcpxOperationalError {
  constructor(requested: string, available: string[]) {
    super(`Unknown output style "${requested}"; this session offers: ${available.join(", ")}.`, {
      outputCode: "USAGE",
      detailCode: "UNKNOWN_OUTPUT_STYLE",
      origin: "queue",
    });
  }
}

export class SessionModeReplayError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_MODE_REPLAY_FAILED",
      origin: "acp",
      ...options,
    });
  }
}

export class SessionModelReplayError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_MODEL_REPLAY_FAILED",
      origin: "acp",
      ...options,
    });
  }
}

export class SessionConfigOptionReplayError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_CONFIG_OPTION_REPLAY_FAILED",
      origin: "acp",
      ...options,
    });
  }
}

export class ClaudeAcpSessionCreateTimeoutError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "TIMEOUT",
      detailCode: "CLAUDE_ACP_SESSION_CREATE_TIMEOUT",
      origin: "acp",
      ...options,
    });
  }
}

export class CopilotAcpUnsupportedError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "COPILOT_ACP_UNSUPPORTED",
      origin: "acp",
      ...options,
    });
  }
}

export class AuthPolicyError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "AUTH_REQUIRED",
      origin: "acp",
      ...options,
    });
  }
}

export class QueueConnectionError extends AcpxOperationalError {}

export class QueueProtocolError extends AcpxOperationalError {}

export class PermissionDeniedError extends AcpxOperationalError {}

export class PermissionPromptUnavailableError extends AcpxOperationalError {
  constructor() {
    super("Permission prompt unavailable in non-interactive mode");
  }
}
