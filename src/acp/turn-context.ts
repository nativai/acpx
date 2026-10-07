/**
 * PER-TURN CONTEXT INJECTION — the harness-agnostic channel (brick 4539b033).
 *
 * Ships as a NO-OP: the plumbing is wired end to end and {@link TURN_CONTEXT_PROVIDERS}
 * is EMPTY. "Proven inert, proven capable" — a no-op never demonstrated to carry
 * anything is indistinguishable from dead code, so the test seam (§4.3) exercises the
 * real registry, composer, caps and transport.
 *
 * ## THIS IS NOT `midTurnSteering`. The two are neighbours and will keep being confused.
 *
 * |                     | **Turn context** (this module)        | **Mid-turn steering**                  |
 * |---------------------|---------------------------------------|----------------------------------------|
 * | When                | Before a turn starts                  | While a turn is already running        |
 * | Initiated by        | acpx itself, unprompted               | A human or agent sending a message     |
 * | Wire                | Decorates *that turn's own* `session/prompt` | A *second, concurrent* `session/prompt` |
 * | Count per turn      | ≤ 1, inside the turn's own request    | 0..n additional requests               |
 * | Harness support     | All three (one mechanism, no cell)    | `midTurnSteering` cell; pi only on a forked build |
 * | Failure if wrong    | Content the model didn't need; wasted uncacheable bytes | A turn wedged open with no terminal response |
 * | Code                | this file                             | `src/acp/mid-turn-injection-support.ts` |
 * | Call site           | `runtime/engine/prompt-turn.ts` (sets the flag) | `cli/session/runtime.ts` (must NEVER set it) |
 *
 * **The operative rule:** the mid-turn injected path must NEVER set the turn-context
 * flag. If it did, a steer would arrive wearing a "new turn" frame inside a turn that
 * already had one — a content error, not merely waste. Eligibility is therefore an
 * explicit opt-in on `AcpPromptOptions`, default OFF, set in exactly one place.
 *
 * ## THE PROVIDER CONTRACT (normative — enforced at review, see below)
 *
 * **A provider MUST NOT block the event loop.** Async I/O only. **No `*Sync` filesystem
 * calls, no `execSync`, no unbounded synchronous computation, no synchronous parse of an
 * unbounded input.** A provider that blocks delays **every turn of every session** by its
 * full blocking duration, and the {@link TURN_CONTEXT_BUDGET_MS} budget cannot save it —
 * the timer that enforces the budget is itself starved by the block.
 *
 * A provider MUST be cheap in the ordinary case (sub-millisecond to low-single-digit ms),
 * MUST return a **small delta**, and MUST tolerate being called on every turn.
 *
 * Anything expensive belongs **behind** this channel, not in it: publish into a cache on
 * its own schedule and have the provider read the cache. **Reading `/wisdom` directly is
 * the canonical thing not to do** — it is a network-backed synced mount.
 *
 * ⚠️ **`Promise.race` bounds a provider that never SETTLES. It does not bound one that
 * never YIELDS.** Marking a provider `async` changes nothing about this; `async` is not a
 * thread. There is no in-process mechanical fix — genuinely bounding it needs a worker
 * thread or a child process, which would re-introduce the per-turn spawn cost and the
 * ingress surface this design rejects, to defend against a provider we ourselves wrote.
 * The bound is therefore **architectural**: the contract above plus code review.
 *
 * **Why that is real enforcement and not a wish:** there is **no UNGOVERNED runtime ingress**.
 * A *compiled-in* provider cannot arrive from a config file or a third party — the only way one
 * exists is a reviewed code change in this file's registry, so contract + review is the actual
 * mechanism, with a finite and known set of authors.
 *
 * ⚠️ **Corrected after measurement — an earlier revision said "no runtime ingress" flatly, and
 * that was false.** One runtime path does exist: the `ACPX_TURN_CONTEXT_TEST_PAYLOAD` seam
 * below. It was measured carrying an imperative payload that a live agent then acted on. It is
 * kept rather than gated behind a test-only build, because it is what proves this channel is
 * capable on a real deployed build — and it is **governed**: it is a declared provider subject
 * to the same attribution union, caps, composer and envelope as any other, and it declares
 * `requires-mitigation` because it cannot honestly claim neutrality for text it never inspects.
 */
import { contextAlarmLineForTurnStart } from "../session/context-alarm-detector.js";
import { harnessIdForAgentCommand, type HarnessId } from "./harness-capabilities.js";

/**
 * The whole resolve, not per provider — so N providers cannot sum to N×budget.
 *
 * 100 ms is ~50× smaller than the primer's 5 s because the primer is amortised over an
 * entire session and this is not. It sits far below the measured floor of one adapter
 * round-trip to first model token: **minimum observed time-to-first-token 1009 ms** across
 * claude / codex / pi (brick 4539b033 M4), so a resolve that spends the whole budget is
 * still invisible against the latency the turn already has. The stated falsifier was a
 * harness with a sub-100 ms floor; it was measured and not met.
 */
export const TURN_CONTEXT_BUDGET_MS = 100;

/**
 * Byte caps — the quantitative half of the bulk bound (the categorical half is that the only
 * runtime ingress is the governed test seam, and these caps apply to it too).
 *
 * Chosen against real numbers: the intended deltas are a timestamp (~30 ch), a brick
 * status line (~120 ch), an inbox notice (~200 ch). A primer-sized payload cannot fit by
 * construction — the artifact a previous phase deleted was 36,100 ch (17.6× the
 * per-provider cap, 8.8× the total), and the live primer measured on the wire is 43,291 ch.
 *
 * Exported, and guarded by a unit test that names the 36,100 figure in its assertion
 * message: raising these to fit a primer-sized payload must mean editing a test that says,
 * in words, why it exists. A doc comment would not survive that; a red test does.
 */
export const PER_PROVIDER_CAP = 2048;
export const TOTAL_CAP = 4096;

/**
 * The envelope — `ENVELOPE-V1`, **frozen as measured**.
 *
 * ⚠️ **DO NOT "IMPROVE" THIS WORDING.** It is the string a real measurement validated on
 * three harnesses (brick 4539b033 M1d/M1e), and any edit invalidates that measurement and
 * requires re-running it. A future reader tidying the prose silently discards the evidence.
 *
 * It is a **named exported constant rather than an inline literal** so the test matrix, the
 * shipped code and the measurement cannot disagree about which version shipped.
 *
 * **Both halves are load-bearing, and this is not decoration:**
 *  - **the tags** make the block machine-detectable — what a test instrument keys on, what a
 *    future "strip before display" would use, and what makes it greppable in a transcript;
 *  - **the natural-language line** is what the *model* keys on. Measured: a BARE prepended
 *    block is attributed to the **USER by all three harnesses**; with this line it is
 *    attributed to the **SYSTEM**. Without it the model believes the user said it, and then
 *    weights it as an instruction from the user — a silent correctness failure.
 *
 * `ENVELOPE-V2` (a longer explicit directive) was measured and **NOT adopted**: identical on
 * every comparable cell, including the one predicted to discriminate, at 2.55× the framing
 * cost (258 vs 98 chars/turn) on the one slot that cannot be cached.
 *
 * **Scoped honestly:** this is a model-judgement signal, not a guarantee. On codex, a turn
 * whose predecessor was misattributed can itself be misattributed — reachable in production,
 * though measured not to self-perpetuate. That residual is exactly why the
 * admissible-payload rule below is unconditional rather than contingent on the measurement.
 */
export const TURN_CONTEXT_ENVELOPE_ID = "ENVELOPE-V1";
export const TURN_CONTEXT_OPEN_TAG = "<acpx-turn-context>";
export const TURN_CONTEXT_CLOSE_TAG = "</acpx-turn-context>";
export const TURN_CONTEXT_PROVENANCE_LINE =
  "System-injected turn context (not written by the user):";

/**
 * Separator for multiple providers' contributions — the same `"\n\n---\n\n"` every other
 * prompt fragment in this codebase uses (`joinPromptFragments`, `src/acp/agent-command.ts`).
 * Duplicated as a constant rather than imported because that helper is module-private;
 * if it is ever exported, switch to it rather than keeping two spellings.
 */
const FRAGMENT_SEPARATOR = "\n\n---\n\n";

/** A LITERAL STRING, never a command path — the seam is inert data, not an executable. */
export const TURN_CONTEXT_TEST_PAYLOAD_ENV = "ACPX_TURN_CONTEXT_TEST_PAYLOAD";

/**
 * The ADMISSIBLE-PAYLOAD claim. **REQUIRED on every provider — omitting it is a compile
 * error**, which is the point.
 *
 * A discriminated union rather than a boolean, deliberately. With
 * `attributionNeutral: boolean`, an author carrying imperative content has only two moves:
 * **lie** (`true`) or have nowhere to state their case. **A lie is invisible; a missing
 * required field is a compile error in a diff.** The union makes the non-neutral path
 * expressible but impossible to take silently — `evidence` is required in that variant, so
 * shipping imperative content without a measured mitigation is a missing field, visible in
 * review.
 *
 * The reviewer's question, so the gate has a checklist and not a vibe:
 * **"Read as the user's own words, does this payload change what the agent would do?"**
 * No ⇒ `{ kind: "neutral" }`. Yes ⇒ `requires-mitigation` **and** cite the measurement.
 */
export type TurnContextAttribution =
  /** Harmless if the model reads it as the user's own words. */
  | { readonly kind: "neutral" }
  /**
   * Imperative or third-party-authored. INADMISSIBLE without a MEASURED attribution
   * mitigation: `evidence` must name the measurement AND the envelope identifier it was
   * measured against, e.g. `"M1e/ENVELOPE-V1"`.
   */
  | { readonly kind: "requires-mitigation"; readonly evidence: string };

/** Envelope identifiers a provider's `evidence` string may cite. */
export const KNOWN_ENVELOPE_IDS: readonly string[] = ["ENVELOPE-V1", "ENVELOPE-V2"];

/** What a provider is told about the turn it is decorating. */
export type TurnContextRequest = {
  readonly sessionId: string;
  readonly harness: HarnessId | undefined;
  readonly agentCommand: string;
  /**
   * The environment the SESSION's agent process was spawned with — NOT acpx's.
   *
   * Required and non-optional, deliberately. An optional parameter defaulting to
   * `process.env` would silently restore the defect where guards are evaluated for the
   * SPAWNER instead of the child — with no type error, no test failure and no log line.
   * Same discipline as `resolveSessionPrimer(sessionEnv)`.
   */
  readonly sessionEnv: NodeJS.ProcessEnv;
};

export type TurnContextProvider = {
  /** Stable id. Appears in warnings and is half of the warn-dedupe key. */
  readonly id: string;
  /** The admissible-payload claim. Required — see {@link TurnContextAttribution}. */
  readonly attribution: TurnContextAttribution;
  resolve(request: TurnContextRequest): Promise<string | undefined> | string | undefined;
};

/**
 * THE REGISTRY — **ships EMPTY, and that is the shipped state of this feature.**
 *
 * Deciding *what* to inject (time, brick status, inbox notice) is separate work with its
 * own cost argument. Adding an entry here is the only way a **compiled-in** payload can
 * exist: no config file, no command. That is what makes both the provider contract and the
 * admissible-payload rule enforceable at review.
 *
 * ⚠️ It is **not** the only way *any* payload can exist — the `ACPX_TURN_CONTEXT_TEST_PAYLOAD`
 * seam is a runtime path, deliberately kept and deliberately governed. See
 * {@link testPayloadProvider}.
 */
/**
 * THE CONTEXT ALARM AT THE TOP OF EVERY LATER TURN (brick 4f3fa88c, Daniel's item C):
 * while the session's fill is past its seat's alarm, every prompt it receives — a parent's
 * message, a wakeup, Daniel's own — opens with the fixed `⟦CONTEXT-ALARM⟧` line, numbers
 * as last reported. Wire-only, like every provider here: the transcript keeps the user's
 * own text.
 *
 * `requires-mitigation`, not `neutral`: the line tells the agent to hand over, so read as
 * the user's own words it WOULD change what the agent does. The envelope's measured
 * attribution flip (M1e/ENVELOPE-V1) is the mitigation it rides on.
 *
 * Cheap by construction — one synchronous map lookup; the detector it reads is fed by the
 * usage reports, never by I/O here.
 */
const contextAlarmProvider: TurnContextProvider = {
  id: "context-alarm",
  attribution: { kind: "requires-mitigation", evidence: `M1e/${TURN_CONTEXT_ENVELOPE_ID}` },
  resolve: (request) => contextAlarmLineForTurnStart(request.sessionId),
};

const SHIPPED_PROVIDERS: readonly TurnContextProvider[] = [contextAlarmProvider];

let registeredProviders: readonly TurnContextProvider[] = SHIPPED_PROVIDERS;

/**
 * The registry as it currently stands — the shipped array, or a test override.
 *
 * Deliberately a FUNCTION and not an exported array: an exported snapshot would not reflect
 * a test override, so the guard tests and the running code would be reading two different
 * things. One accessor, one source of truth.
 */
export function turnContextProviders(): readonly TurnContextProvider[] {
  return registeredProviders;
}

/** TEST SEAM. Replaces the registry; returns a disposer restoring the previous contents. */
export function setTurnContextProvidersForTesting(
  providers: readonly TurnContextProvider[],
): () => void {
  const previous = registeredProviders;
  registeredProviders = providers;
  return () => {
    registeredProviders = previous;
  };
}

/** Failure classes, distinct so a provider that first times out and later throws reports both. */
export type TurnContextFailureClass = "threw" | "timed-out" | "over-cap" | "invalid";

/**
 * Process-scoped warn dedupe, keyed `(provider id, failure class)`.
 *
 * **This is a real departure from the primer, not a style choice.** The primer runs once
 * per process, so "once per call" and "once per process" coincide there. Per-turn they
 * diverge hard: an un-deduped warning on a broken provider emits one line per turn — 500
 * lines into a 500-turn session's stderr, which acpx-ui surfaces to the user. That is a new
 * failure mode created by moving from session-start to per-turn.
 */
const warnedFailures = new Set<string>();

/** TEST SEAM — the dedupe is process-scoped, so per-test isolation needs this. */
export function resetTurnContextWarningsForTests(): void {
  warnedFailures.clear();
}

function warnTurnContext(
  providerId: string,
  failureClass: TurnContextFailureClass,
  reason: string,
): void {
  // "::" and not a NUL separator: a NUL byte anywhere in a source file makes it BINARY to
  // search tools, and this repo has already lost searches that way.
  const key = `${providerId}::${failureClass}`;
  if (warnedFailures.has(key)) {
    return;
  }
  warnedFailures.add(key);
  // Structured single-line, `warnPrimer` convention (`src/acp/session-primer.ts`).
  process.stderr.write(
    `[acpx] turn context unavailable (${providerId}): ${reason}; continuing without it\n`,
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The seam ANNOUNCES ITSELF, every turn it contributes. **Deliberately NOT deduped.**
 *
 * The realistic failure here is not an attacker, it is **a stale env var**.
 * `ACPX_TURN_CONTEXT_TEST_PAYLOAD` surviving in a pod spec, a session template or a **copied
 * session record** would inject operator text into every production turn of that session,
 * indefinitely, with nobody remembering having set it — and the injected block is **absent from
 * the user's transcript message** (acpx records the prompt before decorating), so a human
 * reading the session cannot see it. Invisible, persistent, un-diagnosable, and reachable by
 * copy-paste.
 *
 * **Why undeduped, against the `(provider, class)` dedupe used for failures:** those warnings
 * describe a fault that is the same fact every turn, so once per process is the whole of the
 * information. This line describes an ONGOING condition whose hazard IS its persistence, and a
 * single line emitted at session start is exactly what a reader scrolling a long session would
 * miss. The volume cost is real but it is bounded and self-selected: a production session with
 * the seam unset emits **zero** of these, so the only person who ever sees one line per turn is
 * the operator who armed it — which is precisely the person who needs to see it.
 */
function announceTurnContextSeam(payload: string): void {
  process.stderr.write(
    `[acpx] turn context: ${TURN_CONTEXT_TEST_PAYLOAD_ENV} is set (${payload.length} chars) — operator-supplied text is being injected into this turn\n`,
  );
}

/**
 * The payload may not contain EITHER envelope tag, in any case.
 *
 * The closing tag would let a payload **close the envelope early** and emit arbitrary text
 * that reads as outside system-injected context. The opening tag is rejected for symmetry:
 * a forged opening tag frames later user text as system context.
 *
 * Rejected rather than escaped or stripped — escaping needs a de-escaping contract on the
 * model side that does not exist, and silently mangled text is a debugging trap.
 */
function containsEnvelopeTag(payload: string): boolean {
  const lowered = payload.toLowerCase();
  return lowered.includes(TURN_CONTEXT_OPEN_TAG) || lowered.includes(TURN_CONTEXT_CLOSE_TAG);
}

/**
 * THE ONE COMPOSITION, used by every transport path.
 *
 * This is the `composePrimerWithBrickContext` lesson taken literally: that function exists
 * *because* the primer's stream leg and config-dir leg drifted silently — the render
 * arrived complete and only the brick block was missing, with no test catching it. If a
 * second transport is ever added here, the two must differ **only** in how they place an
 * **identical** composed string.
 *
 * Contributions are joined in registration order inside **one** envelope as **one** block —
 * not one block per provider, which would multiply the per-harness forwarding risk by N and
 * force the provenance line to repeat.
 *
 * Returns `undefined` when there is nothing to inject, so every "contributes nothing" path
 * converges on one case.
 */
export function composeTurnContext(contributions: readonly string[]): string | undefined {
  const present = contributions.filter((part) => part.length > 0);
  if (present.length === 0) {
    return undefined;
  }
  const body = present.join(FRAGMENT_SEPARATOR);
  const composed = `${TURN_CONTEXT_OPEN_TAG}\n${TURN_CONTEXT_PROVENANCE_LINE}\n\n${body}\n${TURN_CONTEXT_CLOSE_TAG}`;
  if (composed.length > TOTAL_CAP) {
    // The WHOLE block is dropped, never an arbitrary subset — dropping a subset would be
    // non-deterministic. Not truncated: a half-sentence of system-framed text is worse than
    // none, and a cut inside the closing tag turns a size bug into a malformed-frame bug.
    warnTurnContext(
      "composed",
      "over-cap",
      `composed turn context is ${composed.length} chars, over the ${TOTAL_CAP}-char total cap`,
    );
    return undefined;
  }
  return composed;
}

/**
 * The test-seam provider, present only when the SESSION's env carries a non-empty payload.
 *
 * ⚠️ **THIS IS THE ONE RUNTIME INGRESS PATH, AND IT IS GOVERNED RATHER THAN HIDDEN.** An
 * earlier revision of this module claimed there is *no* runtime ingress. That was false, and it
 * was falsified by measurement, not by review: an imperative payload supplied through this env
 * var made a live agent act on it. The seam is deliberately **not** gated behind a test-only
 * build, because it is the instrument that proves the channel is *capable* on a real deployed
 * build — gating it would trade that proof away to tidy a claim. A governed seam beats a hidden
 * one. The accurate claim is **no UNGOVERNED runtime ingress**: this path is itself a declared
 * provider, subject to the same attribution union, the same caps, the same composer and the
 * same envelope as any compiled-in one.
 *
 * ⚠️ **AND THAT IS WHY IT DECLARES `requires-mitigation`, NOT `neutral`.** It carries arbitrary
 * operator-supplied text that it never inspects, so the reviewer's question — *"read as the
 * user's own words, does this payload change what the agent would do?"* — is **unanswerable**
 * for it. `neutral` is therefore a claim this provider cannot make, and the whole point of the
 * attribution union is that such a claim must be impossible to make silently. A seam that lied
 * in its own declaration would have been the one provider defeating the mechanism built to stop
 * exactly that.
 *
 * `evidence` cites `M1e/ENVELOPE-V1` because that is a real, measured mitigation which the
 * composer already applies to this payload like any other: the attribution flip from USER to
 * SYSTEM was measured on all three harnesses with `ENVELOPE-V1` wrapping the block.
 */
function testPayloadProvider(sessionEnv: NodeJS.ProcessEnv): TurnContextProvider | undefined {
  // Read from the SESSION's env, not `process.env` — the same one-env rule as every other
  // guard here. This is what makes a per-session test payload possible.
  const payload = sessionEnv[TURN_CONTEXT_TEST_PAYLOAD_ENV];
  if (typeof payload !== "string" || payload.trim().length === 0) {
    return undefined;
  }
  return {
    id: "test-payload",
    attribution: { kind: "requires-mitigation", evidence: `M1e/${TURN_CONTEXT_ENVELOPE_ID}` },
    resolve: () => {
      // Announce on contribution, not on registration: being asked to resolve is the moment
      // this payload is actually on its way into a turn. If the caps or the envelope guard
      // then reject it, that emits its own separate warning.
      announceTurnContextSeam(payload);
      return payload;
    },
  };
}

/** Every provider that would run for this session, registry plus the test seam. */
export function effectiveTurnContextProviders(
  sessionEnv: NodeJS.ProcessEnv,
): readonly TurnContextProvider[] {
  const seam = testPayloadProvider(sessionEnv);
  return seam === undefined ? registeredProviders : [...registeredProviders, seam];
}

/**
 * THE SYNCHRONOUS GUARD. Call this at the call site **before any `await` exists.**
 *
 * Implementation constraint, not a stylistic preference. If the call site instead
 * unconditionally `await`s a `resolveTurnContext()` that short-circuits internally on an
 * empty registry, the inert path still **allocates a promise and costs a microtask tick** on
 * every turn — which both breaks the inertness claim and makes the latency row measure a
 * microtask the claim never included.
 *
 * Scoped precisely rather than overclaimed: with the registry empty the added cost on the
 * prompt path is one boolean test, one integer comparison and one property read on the
 * session env. **No promise is created and no microtask is queued.**
 */
export function hasTurnContextProviders(sessionEnv: NodeJS.ProcessEnv): boolean {
  return registeredProviders.length > 0 || testPayloadProvider(sessionEnv) !== undefined;
}

/** Resolve one provider to a validated contribution, or to nothing plus one warning. */
async function resolveOneProvider(
  provider: TurnContextProvider,
  request: TurnContextRequest,
): Promise<string | undefined> {
  let raw: unknown;
  try {
    raw = await provider.resolve(request);
  } catch (error) {
    warnTurnContext(provider.id, "threw", describeError(error));
    return undefined;
  }
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== "string") {
    warnTurnContext(provider.id, "invalid", `expected a string, received ${typeof raw}`);
    return undefined;
  }
  if (raw.trim().length === 0) {
    return undefined;
  }
  if (containsEnvelopeTag(raw)) {
    warnTurnContext(
      provider.id,
      "invalid",
      "payload contains an acpx-turn-context tag and would break the envelope",
    );
    return undefined;
  }
  if (raw.length > PER_PROVIDER_CAP) {
    warnTurnContext(
      provider.id,
      "over-cap",
      `${raw.length} chars exceeds the ${PER_PROVIDER_CAP}-char per-provider cap`,
    );
    return undefined;
  }
  return raw.trim();
}

const BUDGET_EXPIRED = Symbol("turn-context-budget-expired");

/**
 * Resolve the per-turn delta. **Never throws into the turn, never blocks past the budget
 * for a provider that fails to settle, and never changes the request when it contributes
 * nothing.**
 *
 * Fail-open in all five senses: a provider throw/rejection is caught and the others still
 * contribute; the budget is enforced across the whole resolve; every nothing-to-inject path
 * returns `undefined` so the caller takes the identical code path it takes today; and each
 * failure warns exactly once per (provider id, failure class) per process.
 *
 * **NOT bounded:** a provider that never yields to the event loop (see the module contract).
 * That limit is architectural, and it is measured rather than claimed away.
 *
 * No memoisation, deliberately: a per-turn delta's entire purpose is to differ between
 * turns, so caching it would defeat the mechanism.
 */
export async function resolveTurnContext(
  request: TurnContextRequest,
  providers: readonly TurnContextProvider[] = effectiveTurnContextProviders(request.sessionEnv),
): Promise<string | undefined> {
  if (providers.length === 0) {
    return undefined;
  }
  // Which providers actually settled, so a budget overrun blames only the ones that overran.
  const settled = new Set<number>();
  const work = Promise.all(
    providers.map(async (provider, index) => {
      const contribution = await resolveOneProvider(provider, request);
      settled.add(index);
      return contribution;
    }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof BUDGET_EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(BUDGET_EXPIRED), TURN_CONTEXT_BUDGET_MS);
  });

  try {
    const outcome = await Promise.race([work, budget]);
    if (outcome === BUDGET_EXPIRED) {
      // Blame only the providers that had not settled — the ones that actually overran.
      providers.forEach((provider, index) => {
        if (!settled.has(index)) {
          warnTurnContext(
            provider.id,
            "timed-out",
            `did not settle within the ${TURN_CONTEXT_BUDGET_MS}ms turn-context budget`,
          );
        }
      });
      return undefined;
    }
    return composeTurnContext(outcome.filter((part): part is string => part !== undefined));
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // A provider that rejects AFTER the race settled must not surface as an unhandled
    // rejection — the per-provider catch already handles it, but the aggregate promise is
    // abandoned on the timeout path, so pin a no-op handler to it.
    void work.catch(() => undefined);
  }
}

/** Build a {@link TurnContextRequest} for a session. Kept here so the shape has one author. */
export function buildTurnContextRequest(params: {
  sessionId: string;
  agentCommand: string;
  sessionEnv: NodeJS.ProcessEnv;
}): TurnContextRequest {
  return {
    sessionId: params.sessionId,
    harness: harnessIdForAgentCommand(params.agentCommand),
    agentCommand: params.agentCommand,
    sessionEnv: params.sessionEnv,
  };
}
