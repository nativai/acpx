import type { OpenRouterRawModel } from "../src/models/openrouter-catalogue.js";
import type { OpenRouterEntitlement } from "../src/models/openrouter-entitlement.js";

/**
 * "What the key allows is NOT the subject of this test" — an allowed set covering
 * every row of a fixture (brick ecfb0461).
 *
 * ## Why this exists
 *
 * `availabilityFor` marks a row the box key does not allow unavailable, so a real
 * 2-model allowed set would silently make every OpenRouter row in every fixture
 * unavailable. Tests whose subject is banding, wire-id derivation, provisioning or
 * `--reasoning-effort` would then fail for a reason that has nothing to do with what
 * they assert — and, worse, some would keep *passing* for the wrong reason. Passing
 * this to `buildCatalogue`'s `entitlement` option holds that dimension constant so
 * each test keeps measuring its own claim.
 *
 * 🛑 **DO NOT USE IT IN A TEST WHOSE SUBJECT *IS* THE ALLOWED SET.** It allows
 * everything, so it would turn the allowlist into a no-op and the test green against
 * a broken control. `test/openrouter-entitlement.test.ts` deliberately never imports
 * this — it states its set explicitly, and its `--all` / default-listing rows depend
 * on some row being DISALLOWED.
 *
 * 🛑 **AND DO NOT REACH FOR `ENTITLEMENT_UNKNOWN` AS A SUBSTITUTE, EVEN THOUGH IT
 * ALSO PERMITS EVERYTHING.** It permits by *failing open*, which is a different code
 * path — a test held constant that way would go green against a build whose allowed
 * set never loads at all, which is precisely the regression most worth catching.
 * This helper exercises the *populated* path and pins the same outcome.
 */
export function entitleAll(models: readonly OpenRouterRawModel[]): OpenRouterEntitlement {
  const allowed = new Set<string>();
  for (const model of models) {
    allowed.add(model.id.replace(/^~/, "").toLowerCase());
    if (model.canonical_slug) {
      allowed.add(model.canonical_slug.toLowerCase());
    }
  }
  // ⚠️ `stale: false` is part of the held-constant state, not a default worth
  // skipping: the Tier 3 annotation appends a staleness clause when it is true
  // (brick ecfb0461), so a test that left it ambiguous would be asserting against a
  // message whose shape depends on a field it never set.
  return { allowed, fetchedAt: "2026-09-29T00:00:00.000Z", stale: false, error: null };
}
