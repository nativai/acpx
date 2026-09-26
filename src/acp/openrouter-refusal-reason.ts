/**
 * Turn *"Request timed out."* into the provider's own words (bricks bb23a7fa, 5aacdba2).
 *
 * ## The defect this closes
 *
 * `qwen/qwen3.8-flash` has exactly ONE upstream provider (Alibaba) and acpx is on
 * OpenRouter's SHARED rate-limit pool (`is_byok: false`). When that pool is
 * exhausted, **the two endpoints disagree about how to say so** — measured on the
 * same key in the same minute, varying only `stream`:
 *
 * ```
 *   stream: false  ->  HTTP 429, 596-byte body naming the provider and the remedy
 *   stream: true   ->  http=000, ZERO bytes, NO response headers, hangs forever
 * ```
 *
 * acpx uses streaming, so it never learns the reason and reports pi's wording —
 * *"Request timed out."* — which is a statement about **us** for a refusal by
 * **them**. Daniel spent an evening concluding pi was broken while the provider was
 * saying, in plain English on a channel nobody reads, that it was throttling us.
 *
 * ## 🛑 THIS IS FOR PROSE, NOT FOR DECISIONS — AND THE DISTINCTION IS MEASURED
 *
 * A non-streaming probe was first proposed as a *classifier* to drive retry/abandon.
 * **Measured over 20 paired trials, it is not fit for that** (brick 5aacdba2
 * `evidence/cls2.txt`):
 *
 * ```
 *   probe (1 token)        sensitivity P(429 | stream dead) 3/6 = 50%   false-pos 2/14 = 14%
 *   probe (same 25k shape) sensitivity                      2/6 = 33%   false-pos 3/14 = 21%
 * ```
 *
 * It misses half the throttled streams and falsely accuses one healthy stream in
 * five to seven. **The mechanism, so nobody retunes it hoping for better:** the
 * probe asks about the pool *seconds after* the stream was refused, and the
 * throttle moves on a seconds timescale. Firing it *concurrently* would fix the
 * moment and double the load on the very pool being measured — and concurrency is
 * measured to take this model from 21% to 60% dead. **There is no version of this
 * probe that is both faithful and free.**
 *
 * ⇒ So it is used at exactly one point: **the terminal failure, to choose WORDING.**
 * A wrong answer costs a vaguer message, never a wrong action. Detection and retry
 * are handled where they are free and exact — pi's own idle bound and retry budget
 * (`writePiStallPolicyAndDefaultModel` in `harness-config-dir.ts`), sized from the same data.
 *
 * ⚠️ **DO NOT PROMOTE THIS TO A DECISION INPUT.** Gating a retry, an abandon, or a
 * failover on a 50%-sensitive signal is the failure this comment exists to prevent.
 *
 * ⚠️ **The CHEAP probe beat the same-shape probe on BOTH axes** (50%/14% vs
 * 33%/21%). That argues against a purely token-weighted pool limit, and it decides
 * which probe to send if anyone revisits: the one-token one. It is also the one
 * that spends least of the budget that is throttling us.
 */

import { resolveOpenRouterBoxCredential } from "./openrouter-routing.js";

/** One token, no streaming: the cheapest request that can still be refused. */
const PROBE_BODY = {
  max_tokens: 1,
  stream: false,
  messages: [{ role: "user", content: "x" }],
} as const;

/**
 * Measured 429 latencies were 3.5–6.9 s. This is a HARD bound on how long a
 * already-failed turn is delayed to improve its own error message — the probe is a
 * courtesy, so it must never become the reason a failure is slow to report.
 */
const PROBE_TIMEOUT_MS = 10_000;

const OPENROUTER_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * pi's wording for a turn its idle bound cut. Matched loosely and case-insensitively
 * because it is *pi's* string, not ours: a pi upgrade may reword it, and the cost of
 * a miss is only that we do not enrich the message.
 *
 * ⚠️ Deliberately NOT a check for "did the turn fail" — this asks the narrower
 * question *"does this failure look like the silent-stall shape"*, so an unrelated
 * failure (a bad tool call, a refusal) never triggers a probe.
 */
export function looksLikeSilentStall(turnError: string): boolean {
  const text = turnError.toLowerCase();
  return text.includes("timed out") || text.includes("timeout");
}

/** What the provider told us, already formatted for a human. */
export type OpenRouterRefusal = {
  /** e.g. `Alibaba` — absent when the body does not name one. */
  provider?: string;
  /** e.g. `upstream_provider_shared_pool`. */
  limitSource?: string;
  /** Whether we were using our own key. `false` is the actionable case. */
  isByok?: boolean;
  /** The provider's own sentence, verbatim. */
  raw: string;
  /** The provider's own suggested remedy, verbatim. */
  remedyHint?: string;
};

type ErrorBody = {
  error?: {
    code?: unknown;
    metadata?: {
      raw?: unknown;
      provider_name?: unknown;
      is_byok?: unknown;
      limit_source?: unknown;
      remedy_hint?: unknown;
    };
  };
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Parse a 429 body into the fields worth quoting. Exported for tests: the live
 * endpoint cannot be asked to be rate-limited on demand, so the parse is pinned
 * against a REAL captured body (`evidence/429-body-specimen.json`) rather than a
 * shape invented here.
 */
/** Set an optional string field only when the wire actually carried one, so an absent
 *  field never becomes an empty string in the message a human reads. */
function assignText(
  target: OpenRouterRefusal,
  key: "provider" | "limitSource" | "remedyHint",
  value: unknown,
): void {
  const text = asString(value);
  if (text !== undefined) {
    target[key] = text;
  }
}

/** `is_byok` is the one non-string field, and `false` is its actionable value — so it
 *  gets its own assigner rather than being inlined as another branch. */
function assignByok(target: OpenRouterRefusal, value: unknown): void {
  if (typeof value === "boolean") {
    target.isByok = value;
  }
}

export function refusalFromBody(body: unknown): OpenRouterRefusal | undefined {
  // Resolved to `{}` ONCE. Repeating `metadata?.x` five times read as five separate
  // branches to the complexity rule; with the spreads that reached 16 against a
  // ceiling of 8, and this is the same logic with the branching factored out.
  const metadata = (body as ErrorBody)?.error?.metadata ?? {};
  const raw = asString(metadata.raw);
  if (raw === undefined) {
    // No provider sentence ⇒ nothing worth quoting. Returning a hand-written
    // substitute here would be inventing a reason, which is the defect, inverted.
    return undefined;
  }
  const refusal: OpenRouterRefusal = { raw };
  assignText(refusal, "provider", metadata.provider_name);
  assignText(refusal, "limitSource", metadata.limit_source);
  assignText(refusal, "remedyHint", metadata.remedy_hint);
  assignByok(refusal, metadata.is_byok);
  return refusal;
}

/**
 * The message a human reads. pi's original wording is kept and attributed, because
 * deleting it would hide which layer reported what — and because when the probe
 * finds nothing, that original is all we have.
 */
export function formatRefusalMessage(
  turnError: string,
  refusal: OpenRouterRefusal | undefined,
): string {
  if (refusal === undefined) {
    return turnError;
  }
  const parts = [refusal.raw];
  const attributes = [
    refusal.provider !== undefined ? `provider: ${refusal.provider}` : undefined,
    refusal.limitSource !== undefined ? `limit: ${refusal.limitSource}` : undefined,
    refusal.isByok === false ? "using OpenRouter's shared pool (no own key)" : undefined,
  ].filter((part): part is string => part !== undefined);
  if (attributes.length > 0) {
    parts.push(`(${attributes.join("; ")})`);
  }
  if (refusal.remedyHint !== undefined) {
    parts.push(`Remedy: ${refusal.remedyHint}`);
  }
  // pi's own sentence last and labelled, so the layers stay distinguishable.
  return `${parts.join(" ")} [pi reported: ${turnError}]`;
}

export type RefusalProbeDeps = {
  /** Injected in tests so no network call is made. */
  fetchImpl?: typeof fetch;
  /**
   * The API key, injectable.
   *
   * ⚠️ **SCOPING `env` DOES NOT ISOLATE THE CREDENTIAL, AND THAT IS NOT OBVIOUS.**
   * `resolveOpenRouterBoxCredential` consults `~/.acpx/providers.json` first, and
   * `boxProvidersPath` resolves its home from **`process.env.ACPX_STATE_HOME ||
   * os.homedir()`** — the *process's* environment, never the `env` argument, which
   * only covers the `apiKeyEnv` indirection and the ambient fallback. So a caller
   * that passes a scoped `env` still reads the REAL box file.
   *
   * That cost me a false pass: tests handing `{OPENROUTER_API_KEY: "k"}` (no `HOME`)
   * were authenticating with the box's actual key, and only a "no credential ⇒ no
   * request" row exposed it. Same class as the `ACPX_MODELS_CACHE` trap in
   * `test/pi-models-store.test.ts` — a fixture variable that is set and then ignored
   * is worse than none, because it makes the test LOOK hermetic.
   */
  resolveKey?: (env: NodeJS.ProcessEnv) => string | undefined;
};

/**
 * One non-streaming request, to learn why the streaming one delivered nothing.
 *
 * Returns `undefined` for every outcome that is not a quotable refusal — a 200
 * (the pool freed up between the stream and this probe, which is the 50%-of-the-time
 * case), a non-429 error, a timeout, a missing key, a thrown fetch. **It never
 * throws:** this runs on the failure path, and an explain step that breaks the
 * error path is strictly worse than a vague message.
 */
export async function probeOpenRouterRefusal(
  modelId: string,
  env: NodeJS.ProcessEnv,
  deps: RefusalProbeDeps = {},
): Promise<OpenRouterRefusal | undefined> {
  // The same resolver the routing path uses — providers.json first, then an ambient
  // `OPENROUTER_API_KEY`. Reusing it is what keeps this probe authenticating as the
  // session did rather than inventing a second key-resolution order.
  const resolveKey =
    deps.resolveKey ?? ((e: NodeJS.ProcessEnv) => resolveOpenRouterBoxCredential({ env: e })?.key);
  const apiKey = resolveKey(env);
  if (apiKey === undefined) {
    return undefined;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(OPENROUTER_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        // The key is never logged anywhere in this module.
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...PROBE_BODY, model: modelId }),
      signal: controller.signal,
    });
    if (response.status !== 429) {
      return undefined;
    }
    return refusalFromBody(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole explain step, in the shape the caller needs: hand it the turn error it
 * was already going to report, get back one that may be truer.
 *
 * ⚠️ **It only ever transforms a message that ALREADY EXISTS.** `runtime.ts` guards
 * hard against inventing an error on a clean turn — `buildDeliveryEvent` substitutes
 * `EMPTY_DELIVERY_ERROR` whenever `error` is absent, so a non-empty message stamps
 * "this turn failed" in acpx-ui. This function is therefore total on strings and
 * never decides *whether* to report, only *what* to say.
 */
export async function explainTurnError(
  turnError: string,
  modelId: string | undefined,
  env: NodeJS.ProcessEnv,
  deps: RefusalProbeDeps = {},
): Promise<string> {
  if (modelId === undefined || !looksLikeSilentStall(turnError)) {
    return turnError;
  }
  return formatRefusalMessage(turnError, await probeOpenRouterRefusal(modelId, env, deps));
}
