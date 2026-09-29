import type { OpenRouterRawModel } from "../src/models/openrouter-catalogue.js";
import type {
  OpenRouterEntitlementEntry,
  OpenRouterEntitlementResolution,
} from "../src/models/openrouter-entitlement.js";

/**
 * "Entitlement is NOT the subject of this test" — an entitlement set that covers
 * every row of a fixture (brick daed4261).
 *
 * ## Why this exists
 *
 * `availabilityFor` now marks a non-entitled OpenRouter row unavailable, so the box's
 * real 5-model entitlement set would silently make every OpenRouter row in every
 * fixture unavailable. Tests whose subject is banding, wire-id derivation,
 * provisioning or `--reasoning-effort` would then fail for a reason that has nothing
 * to do with what they assert — and, worse, some would keep *passing* for the wrong
 * reason. Passing this to `buildCatalogue`'s `entitlement` option holds that
 * dimension constant so each test keeps measuring its own claim.
 *
 * 🛑 **DO NOT USE IT IN A TEST WHOSE SUBJECT *IS* ENTITLEMENT.** It entitles
 * everything, so it would turn the allowlist into a no-op and the test green against
 * a broken control. `test/openrouter-entitlement.test.ts` deliberately never imports
 * this — it passes the real `OPENROUTER_ENTITLEMENT`, or a fixture it states
 * explicitly, and its `--all`/default-listing rows depend on some row being
 * NON-entitled.
 *
 * ⚠️ The `canonicalSlug` is synthesised here **on purpose and only here**. Production
 * must never construct one (three date formats and a word reordering are on record),
 * which is why this lives in a test helper and why the suffix is conspicuous: nothing
 * reads it, these rows never reach a guardrail, and the invariant tests that forbid
 * derivation run against the committed module, not against this.
 */
export function entitleAll(models: readonly OpenRouterRawModel[]): OpenRouterEntitlementResolution {
  const entries: readonly OpenRouterEntitlementEntry[] = models.map((model) => ({
    slug: model.id.replace(/^~/, "").toLowerCase(),
    canonicalSlug: `${model.id.replace(/^~/, "").toLowerCase()}-test-fixture-not-a-real-canonical`,
    why: "test fixture — entitlement is not this test's subject (entitleAll)",
  }));
  // ⚠️ `narrowed: false` is part of the held-constant state, not a default worth
  // skipping: the annotation is a FUNCTION of the resolution now (brick daed4261 F1),
  // so a test that left this ambiguous would be asserting against a message whose
  // shape depends on a field it never set.
  return { entries, narrowed: false };
}
