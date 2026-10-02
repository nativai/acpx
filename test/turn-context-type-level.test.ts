/**
 * T17h — THE TYPE-LEVEL ENFORCEMENT ROW (added by the independent test-engineer, brick 4539b033).
 *
 * The design publishes a guarantee: a provider literal that declares no `attribution` must FAIL TO
 * COMPILE. That is the entire mechanism behind the admissible-payload rule — `TurnContextAttribution`
 * is a discriminated union specifically so that an author carrying imperative content cannot stay
 * silent, because the missing required field is a compile error visible in a diff.
 *
 * Until this file existed, that guarantee had **no test**, which makes it a comment. The implementer
 * declared the gap honestly (TESTER-PLAN §6 item 3) rather than leaving it implied.
 *
 * ## Why this row lives in `test/` and not in `src/`
 *
 * `pnpm run typecheck` runs `tsgo --noEmit` against `tsconfig.json`, whose `include` is
 * `src/**` ONLY. A type-level row placed anywhere outside `test/` therefore would not run under the
 * gate stage people think covers it. This file is compiled by **`tsconfig.test.json`** (`include`
 * carries `test/**\/*.ts`), i.e. by **`pnpm run build:test`** — and `build:test`'s exit code is the
 * assertion. Read that rc; do not infer it from the presence of emitted JavaScript, because neither
 * tsconfig sets `noEmitOnError` and a FAILING build still writes fresh `.js`.
 *
 * ## Why the row is self-controlling
 *
 * `@ts-expect-error` inverts: it fails the compile when the line below it has **no** error
 * ("Unused '@ts-expect-error' directive"). So this row cannot silently degrade into a no-op the way
 * `@ts-ignore` would. If `attribution` ever stops being required, this file stops compiling — which
 * is the alarm. Verified live by the test-engineer: adding `attribution` back to the arm below makes
 * `build:test` fail with exactly that unused-directive error, so the directive is demonstrably live
 * and not decorative.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  type TurnContextAttribution,
  type TurnContextProvider,
  composeTurnContext,
} from "../src/acp/turn-context.js";

/**
 * THE ROW. A provider literal omitting `attribution` must not type-check.
 *
 * The omission is the ONLY defect in this literal — `id` and `resolve` are both present and
 * well-formed — so the directive below can only be satisfied by the missing `attribution`, and not
 * by some unrelated error that happens to land on the same line.
 */
// @ts-expect-error — `attribution` is REQUIRED on TurnContextProvider; omitting it must not compile.
const providerWithoutAttribution: TurnContextProvider = {
  id: "no-attribution-declared",
  resolve: () => "some per-turn delta",
};

/**
 * POSITIVE CONTROL, at the type level. The *same* literal shape WITH `attribution` compiles clean
 * and carries NO directive. Without this arm the row above is consistent with
 * `TurnContextProvider` being unsatisfiable for an unrelated reason — i.e. with every literal
 * failing, which would make the expect-error pass for the wrong cause.
 */
const providerWithAttribution: TurnContextProvider = {
  id: "attribution-declared",
  attribution: { kind: "neutral" },
  resolve: () => "some per-turn delta",
};

/**
 * The `requires-mitigation` variant must also be expressible — and must require `evidence`. This is
 * the half that makes the union more than a decorated boolean: the non-neutral path exists, but it
 * cannot be taken silently.
 */
const mitigated: TurnContextAttribution = {
  kind: "requires-mitigation",
  evidence: "M1e/ENVELOPE-V1",
};

// @ts-expect-error — `requires-mitigation` without `evidence` must not compile.
const mitigatedWithoutEvidence: TurnContextAttribution = { kind: "requires-mitigation" };

test("T17h a provider literal omitting `attribution` does not compile", () => {
  // The compile-time assertion is the `@ts-expect-error` directives above; this body exists so the
  // row is also a RUNTIME subject rather than a file that merely sits in the tree. If this file were
  // ever dropped from `tsconfig.test.json`'s include, the test would vanish from the tally too —
  // which is a visible count change rather than a silent loss of the type-level guarantee.
  assert.equal(providerWithAttribution.id, "attribution-declared");
  assert.deepEqual(providerWithAttribution.attribution, { kind: "neutral" });
  assert.equal(mitigated.kind, "requires-mitigation");

  // SUBJECT CHECK: the module under test is really imported and really the turn-context module, so a
  // green here cannot mean "nothing was loaded". `composeTurnContext` of nothing is `undefined`.
  assert.equal(composeTurnContext([]), undefined);
  assert.ok(composeTurnContext(["x"])?.startsWith("<acpx-turn-context>"));

  // Reference the error-arm bindings so no linter can delete them as unused — deleting them would
  // delete the coverage while leaving the test green.
  assert.equal(typeof providerWithoutAttribution, "object");
  assert.equal(typeof mitigatedWithoutEvidence, "object");
});
