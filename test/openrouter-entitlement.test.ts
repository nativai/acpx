import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCatalogue } from "../src/models/catalogue.js";
import {
  assertModelPolicy,
  ClaudeFamilyOnOpenRouterError,
  claudeFamilyOnOpenRouterMessage,
  OPENROUTER_NOT_ENTITLED_REASON,
  OpenRouterModelNotEntitledError,
} from "../src/models/claude-family.js";
import type { OpenRouterSnapshot } from "../src/models/openrouter-catalogue.js";
import {
  entitlementModelIds,
  entitlementSha,
  formatOpenRouterEntitlementSkew,
  isFloatingAliasModelId,
  isOpenRouterRouteShapedModelId,
  OPENROUTER_ENTITLEMENT,
  OPENROUTER_ENTITLEMENT_SHA,
  OPENROUTER_GREEN_LIST,
  resolveOpenRouterEntitlement,
  type OpenRouterEntitlementResolution,
} from "../src/models/openrouter-entitlement.js";

/**
 * THE PERMANENT NEGATIVE TESTS for brick daed4261 §9 — *the two enforcement layers
 * must not be able to disagree.*
 *
 * ## What this guards, and why a comment would not have been enough
 *
 * Two layers refuse a non-entitled OpenRouter model: this code, at spawn; and the
 * provider, because the box key's `allowed_models` guardrail bounds it. The
 * guardrail's list is GENERATED from `src/models/openrouter-entitlement.ts`. If the
 * two ever differ in the wrong direction — code wider than key — the failure is not
 * an ugly 403, it is an **uninterpretable** one: `probeOpenRouterRefusal` returns
 * `undefined` for any status that is not 429 and only runs when the turn error says
 * `timed out`. An agent meeting an unexplained obstacle reads it as transient
 * infrastructure and retries, on a metered route.
 *
 * So every guarantee below carries its own negative input and lives in the suite
 * forever. **No mutation probe, no "gut the guard and re-run"** — a check proves it
 * can fail by holding an input it must reject.
 *
 * ## ⚠️ WHAT GOES RED IF EACH PIECE IS BROKEN
 *
 *   delete `assertModelPolicy`'s route gate (`isOpenRouterRouteShapedModelId`)
 *       → "POSITIVE CONTROL — the `/` boundary": every live bare alias and codex id
 *         starts being refused. This is the single most destructive possible
 *         regression here and it is what that block exists for.
 *   fold Claude-family INTO the entitlement list instead of checking it first
 *       → "a Claude row in the module cannot permit Claude"
 *   reword or drop the shipped Claude-family refusal
 *       → "the shipped Claude-family message survives verbatim"
 *   drop the floating-alias refusal
 *       → "a floating alias is refused even though its pinned sibling is entitled"
 *   make `OPENROUTER_GREEN_LIST` a second hand-written literal
 *       → "the green list is a SUBSET BY CONSTRUCTION"
 *   narrow on an ABSENT entitlementSha
 *       → "an unrecorded sha does NOT narrow"
 *   stop narrowing on a MISMATCHED sha
 *       → "a mismatched sha narrows to the green list"
 *   hardcode the sha instead of deriving it from the rows
 *       → "the sha is derived from the list, not stored beside it"
 *   forget `entitlementSha` in EITHER of providers.ts's two field lists
 *       → "entitlementSha survives parsing AND the status projection"
 *   drop the read-path narrowing in `availabilityFor`
 *       → "the READ path narrows"
 */

const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/openrouter-models-2026-09-04.json");
const META = { fetchedAt: "2026-09-04T00:10:56.992Z", stale: false, error: null };

/** Real production agent commands, sampled from this box's live session store. */
const REAL_CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const REAL_PI_COMMAND = "node /opt/pi-acp/dist/index.js";

/**
 * ⚠️ EVERY ONE OF THESE IS A **LIVE MEASURED ID** off devbox's session store
 * (2026-09-29), not a plausible-looking invention — counts in the comment. They are
 * the positive controls for the `/` boundary, so if a harness ever ships a
 * namespaced native id this file goes red BEFORE the allowlist starts refusing real
 * sessions.
 */
const LIVE_NON_ROUTE_IDS = [
  "opus", // claude ×790
  "sonnet", // claude ×291
  "default", // claude ×78
  "fable", // claude ×43
  "haiku", // claude ×6
  "gpt-6-astra[high]", // codex ×32
  "gpt-5.6-terra[high]", // codex ×23
  "gpt-5.6-sol[max]", // codex ×10
  "gpt-5.5[xhigh]", // codex ×13
  "gpt-5.3-codex-spark[medium]", // codex ×1
  "claude-fable-5", // claude ×1 — bare, so NOT route-shaped despite naming Claude
] as const;

/** The three spellings the 2026-09-27 incident actually used. */
const THREE_SPELLINGS = [
  "openrouter:anthropic/claude-sonnet-5",
  "anthropic/claude-sonnet-5",
  "openrouter/anthropic/claude-sonnet-5",
] as const;

function detailCodeOf(error: unknown): string | undefined {
  return (error as { detailCode?: string } | undefined)?.detailCode;
}

function captureThrow(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** `S` injected directly, so no assertion here depends on THIS box's providers.json. */
function settled(): OpenRouterEntitlementResolution {
  return { entries: OPENROUTER_ENTITLEMENT, narrowed: false };
}

function narrowed(): OpenRouterEntitlementResolution {
  return {
    entries: OPENROUTER_GREEN_LIST,
    narrowed: true,
    skew: {
      kind: "mismatch",
      name: "openrouter",
      codeSha: OPENROUTER_ENTITLEMENT_SHA,
      entrySha: "0".repeat(64),
    },
  };
}

/** A `providers.json` on disk, with whatever `entitlementSha` the row needs. */
function withProvidersFile<T>(
  entry: Record<string, unknown>,
  run: (providersPath: string) => T,
): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-entitlement-"));
  const providersPath = path.join(dir, "providers.json");
  fs.writeFileSync(
    providersPath,
    JSON.stringify({ version: 1, box: "test", providers: { openrouter: entry } }),
  );
  try {
    return run(providersPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── The module's own invariants ───────────────────────────────────────────────

test("the green list is a SUBSET BY CONSTRUCTION, not a second literal", () => {
  // Reference identity, deliberately: `G ⊆ K` is what licenses narrowing to the
  // green list as the safe response to skew, and as a `filter` that containment
  // cannot drift. A hand-written twin would be deep-equal but NOT reference-equal,
  // so this is the assertion that catches one appearing.
  assert.ok(OPENROUTER_GREEN_LIST.length > 0, "a green list of zero would narrow to nothing");
  for (const entry of OPENROUTER_GREEN_LIST) {
    assert.ok(
      OPENROUTER_ENTITLEMENT.includes(entry),
      `${entry.slug} is not the very object in OPENROUTER_ENTITLEMENT — a second list has appeared`,
    );
  }
  // NEGATIVE: a deep-equal copy must NOT satisfy the check above.
  const impostor = OPENROUTER_GREEN_LIST.map((entry) => ({ ...entry }));
  assert.equal(
    impostor.every((entry) => OPENROUTER_ENTITLEMENT.includes(entry)),
    false,
    "reference identity is not actually being tested",
  );
});

test("no entitlement entry is Claude-family, alias-shaped, or unpinned", async () => {
  const { isClaudeFamilyModelId } = await import("../src/models/claude-family.js");
  for (const entry of OPENROUTER_ENTITLEMENT) {
    assert.equal(isClaudeFamilyModelId(entry.slug), false, `${entry.slug} is Claude-family`);
    assert.equal(
      isClaudeFamilyModelId(entry.canonicalSlug),
      false,
      `${entry.canonicalSlug} is Claude-family`,
    );
    assert.equal(isFloatingAliasModelId(entry.slug), false, `${entry.slug} is alias-shaped`);
    // `canonicalSlug === slug` is the MEASURED signature of a floating row, and it
    // catches an alias spelling nobody anticipated — which the shape test cannot.
    assert.notEqual(
      entry.canonicalSlug,
      entry.slug,
      `${entry.slug} has canonicalSlug === slug, the signature of a FLOATING alias`,
    );
    assert.ok(entry.slug.includes("/"), `${entry.slug} is not namespaced — it cannot route`);
  }
  // NEGATIVE CONTROLS: each invariant must reject a violating row.
  assert.equal(isClaudeFamilyModelId("anthropic/claude-sonnet-5"), true);
  assert.equal(isFloatingAliasModelId("~z-ai/glm-flash-latest"), true);
});

test("every model contributes BOTH id forms, deduped and sorted", () => {
  const ids = entitlementModelIds();
  assert.equal(ids.length, OPENROUTER_ENTITLEMENT.length * 2, "expected two spellings per model");
  assert.deepEqual([...ids], [...ids].toSorted(), "the generated list must be ordered");
  assert.equal(new Set(ids).size, ids.length, "the generated list must be deduped");
  for (const entry of OPENROUTER_ENTITLEMENT) {
    assert.ok(ids.includes(entry.slug), `${entry.slug} missing from the generated list`);
    assert.ok(ids.includes(entry.canonicalSlug), `${entry.canonicalSlug} missing`);
  }
  // Dedup must be real, not incidental: two rows sharing a spelling collapse.
  const duplicated = entitlementModelIds([
    { slug: "a/b", canonicalSlug: "a/b-1", why: "t" },
    { slug: "a/b", canonicalSlug: "a/b-2", why: "t" },
  ]);
  assert.deepEqual([...duplicated], ["a/b", "a/b-1", "a/b-2"]);
});

test("the sha is DERIVED from the list, not stored beside it", () => {
  assert.equal(OPENROUTER_ENTITLEMENT_SHA, entitlementSha(OPENROUTER_ENTITLEMENT));
  assert.match(OPENROUTER_ENTITLEMENT_SHA, /^[0-9a-f]{64}$/);
  // NEGATIVE: adding a model MUST move the sha. A hardcoded constant would not,
  // and would report "in step" while the two lists differed.
  const wider = entitlementSha([
    ...OPENROUTER_ENTITLEMENT,
    { slug: "openai/gpt-5-pro", canonicalSlug: "openai/gpt-5-pro-20260101", why: "test" },
  ]);
  assert.notEqual(wider, OPENROUTER_ENTITLEMENT_SHA);
  // …and it must be insensitive to ROW ORDER alone, or an innocuous reshuffle of the
  // array would present as skew and narrow every box to the green list.
  assert.equal(
    entitlementSha([...OPENROUTER_ENTITLEMENT].toReversed()),
    OPENROUTER_ENTITLEMENT_SHA,
  );
});

// ── The route gate: the `/` boundary ─────────────────────────────────────────

test("POSITIVE CONTROL — the `/` boundary: live bare aliases and codex ids are NOT route-shaped", () => {
  // 🛑 THE MOST DESTRUCTIVE POSSIBLE REGRESSION IN THIS BRICK. `assertModelPolicy`
  // is now an ALLOWLIST, so if the route gate ever matches a bare id it refuses
  // EVERYTHING it does not know — every claude and codex session on the box. These
  // ids are measured live traffic, not invented.
  for (const id of LIVE_NON_ROUTE_IDS) {
    assert.equal(isOpenRouterRouteShapedModelId(id), false, id);
    assert.equal(
      captureThrow(() => assertModelPolicy(REAL_CLAUDE_COMMAND, id, { entitlement: settled() })),
      undefined,
      `${id} must not be refused`,
    );
  }
  assert.equal(isOpenRouterRouteShapedModelId(undefined), false);
  assert.equal(isOpenRouterRouteShapedModelId(null), false);
  assert.equal(isOpenRouterRouteShapedModelId(""), false);
  // NEGATIVE: the gate must still fire on real route ids, or the loop above passes
  // because nothing is ever route-shaped.
  for (const id of ["z-ai/glm-5.3-flash", "openrouter:z-ai/glm-5.3-flash", "openrouter/free"]) {
    assert.equal(isOpenRouterRouteShapedModelId(id), true, id);
  }
});

// ── The shipped Claude-family refusal survives, verbatim ─────────────────────

test("the shipped Claude-family message survives verbatim, in all three spellings", () => {
  for (const spelling of THREE_SPELLINGS) {
    const error = captureThrow(() =>
      assertModelPolicy(REAL_CLAUDE_COMMAND, spelling, { entitlement: settled() }),
    );
    assert.ok(error instanceof ClaudeFamilyOnOpenRouterError, spelling);
    assert.equal(detailCodeOf(error), "CLAUDE_FAMILY_ON_OPENROUTER", spelling);
    // Byte-identical to the shipped wording — this is what catches a regression
    // into the new GENERAL message, which would still throw and still be a refusal
    // while losing every route-around the Claude message closes.
    assert.equal(
      (error as Error).message,
      claudeFamilyOnOpenRouterMessage({ requested: spelling.trim(), harness: "claude" }),
      spelling,
    );
  }
  // pi gets its own wording, and must not be told to pass `--model sonnet`.
  const piError = captureThrow(() =>
    assertModelPolicy(REAL_PI_COMMAND, "anthropic/claude-sonnet-5", { entitlement: settled() }),
  );
  assert.ok(piError instanceof ClaudeFamilyOnOpenRouterError);
  assert.equal(
    (piError as Error).message,
    claudeFamilyOnOpenRouterMessage({ requested: "anthropic/claude-sonnet-5", harness: "pi" }),
  );
});

test("a Claude row in the module cannot permit Claude — the check is list-independent", () => {
  // The ordering guarantee: Claude-family is refused BEFORE the list is consulted,
  // so even a module that (wrongly) entitled Sonnet would still refuse it. The
  // invariant test above asserts no such row exists; this asserts that if one ever
  // did, it could not open the metered route.
  const poisoned: OpenRouterEntitlementResolution = {
    entries: [
      ...OPENROUTER_ENTITLEMENT,
      {
        slug: "anthropic/claude-sonnet-5",
        canonicalSlug: "anthropic/claude-sonnet-5-20260101",
        why: "deliberately poisoned fixture",
      },
    ],
    narrowed: false,
  };
  const error = captureThrow(() =>
    assertModelPolicy(REAL_CLAUDE_COMMAND, "anthropic/claude-sonnet-5", { entitlement: poisoned }),
  );
  assert.ok(error instanceof ClaudeFamilyOnOpenRouterError);
  // POSITIVE CONTROL: the poisoned fixture IS otherwise honoured, so the row above
  // was genuinely present and genuinely ignored — not silently dropped.
  assert.equal(
    captureThrow(() =>
      assertModelPolicy(REAL_CLAUDE_COMMAND, "openai/gpt-5-pro", {
        entitlement: {
          entries: [{ slug: "openai/gpt-5-pro", canonicalSlug: "openai/gpt-5-pro-1", why: "t" }],
          narrowed: false,
        },
      }),
    ),
    undefined,
  );
});

// ── The allowlist ────────────────────────────────────────────────────────────

test("every entitled id, in BOTH forms and all three spellings, is allowed", () => {
  for (const entry of OPENROUTER_ENTITLEMENT) {
    for (const form of [entry.slug, entry.canonicalSlug]) {
      for (const spelling of [form, `openrouter/${form}`, `openrouter:${form}`]) {
        assert.equal(
          captureThrow(() =>
            assertModelPolicy(REAL_PI_COMMAND, spelling, { entitlement: settled() }),
          ),
          undefined,
          `${spelling} must be allowed`,
        );
      }
    }
  }
});

test("a model outside the entitlement set is refused, naming the set", () => {
  // `moonshotai/kimi-k3` is a real id from this box's store — a model that WAS used
  // and is not entitled. `openai/gpt-5-pro` is the frontier row §9 names as the gap
  // the old Claude-only denylist left open.
  for (const id of [
    "openai/gpt-5-pro",
    "google/gemini-3-ultra",
    "moonshotai/kimi-k3",
    "openrouter/openai/gpt-5-pro",
    "openrouter:google/gemini-3-ultra",
    "openrouter/free",
  ]) {
    const error = captureThrow(() =>
      assertModelPolicy(REAL_CLAUDE_COMMAND, id, { entitlement: settled() }),
    );
    assert.ok(error instanceof OpenRouterModelNotEntitledError, id);
    assert.equal(detailCodeOf(error), "OPENROUTER_MODEL_NOT_ENTITLED", id);
    const message = (error as Error).message;
    assert.ok(message.includes(id), `the refusal must echo the caller's own spelling: ${id}`);
    for (const entry of OPENROUTER_ENTITLEMENT) {
      assert.ok(message.includes(entry.slug), `the refusal must name ${entry.slug}`);
    }
  }
});

test("a floating alias is refused even though its pinned sibling is entitled", () => {
  for (const alias of [
    "~z-ai/glm-5.3-flash",
    "z-ai/glm-5.3-flash-latest",
    "~z-ai/glm-flash-latest",
    "openrouter/~z-ai/glm-5.3-flash",
    "openrouter:z-ai/glm-5.3-flash-latest",
  ]) {
    const error = captureThrow(() =>
      assertModelPolicy(REAL_PI_COMMAND, alias, { entitlement: settled() }),
    );
    assert.ok(error instanceof OpenRouterModelNotEntitledError, alias);
    assert.match((error as Error).message, /FLOATING alias/, alias);
  }
  // POSITIVE CONTROL: the non-alias sibling of the very same model is served, so
  // the block above cannot be passing because `z-ai/glm-5.3-flash` is refused too.
  assert.equal(
    captureThrow(() =>
      assertModelPolicy(REAL_PI_COMMAND, "z-ai/glm-5.3-flash", { entitlement: settled() }),
    ),
    undefined,
  );
});

// ── The sha tie, and which way it fails ──────────────────────────────────────

test("a matching sha uses the full set and reports NOTHING", () => {
  const skews: unknown[] = [];
  withProvidersFile(
    { env: "OPENROUTER_API_KEY", entitlementSha: OPENROUTER_ENTITLEMENT_SHA },
    (p) => {
      const resolution = resolveOpenRouterEntitlement({ providersPath: p });
      assert.equal(resolution.narrowed, false);
      assert.equal(resolution.skew, undefined);
      assert.equal(resolution.entries, OPENROUTER_ENTITLEMENT);
      // An entitled-but-NOT-green model is allowed, and no line is emitted.
      assert.equal(
        captureThrow(() =>
          assertModelPolicy(REAL_CLAUDE_COMMAND, "qwen/qwen3.8-flash", {
            entitlement: resolution,
            onEntitlementSkew: (skew) => skews.push(skew),
          }),
        ),
        undefined,
      );
    },
  );
  assert.deepEqual(skews, [], "a settled box must not warn");
});

test("a mismatched sha narrows to the green list and SAYS SO", () => {
  const skews: { kind: string }[] = [];
  withProvidersFile({ env: "OPENROUTER_API_KEY", entitlementSha: "deadbeef".repeat(8) }, (p) => {
    const resolution = resolveOpenRouterEntitlement({ providersPath: p });
    assert.equal(resolution.narrowed, true);
    assert.equal(resolution.entries, OPENROUTER_GREEN_LIST);
    assert.equal(resolution.skew?.kind, "mismatch");

    // THE NEGATIVE CASE: an entitled-but-non-green model is now refused. This is
    // the same call that passed under a matching sha above — the pair is what
    // proves the narrowing bit, rather than that qwen is refused in general.
    const error = captureThrow(() =>
      assertModelPolicy(REAL_CLAUDE_COMMAND, "qwen/qwen3.8-flash", {
        entitlement: resolution,
        onEntitlementSkew: (skew) => skews.push(skew),
      }),
    );
    assert.ok(error instanceof OpenRouterModelNotEntitledError);
    assert.match((error as Error).message, /NARROWED/);

    // POSITIVE CONTROL: a GREEN model still works while narrowed, or "narrowing"
    // would be indistinguishable from "refusing everything".
    assert.equal(
      captureThrow(() =>
        assertModelPolicy(REAL_CLAUDE_COMMAND, "z-ai/glm-5.3-flash", { entitlement: resolution }),
      ),
      undefined,
    );
  });
  assert.equal(skews.length, 1, "the skew must be reported exactly once per spawn");
  assert.equal(skews[0]?.kind, "mismatch");
});

test("an unrecorded sha does NOT narrow, and is reported rather than silent", () => {
  // 🛑 THE DECIDED DIRECTION, AND THE TEST THAT PINS IT. Absent means no key-side
  // claim was ever recorded — the pre-cutover state, where the key is UNRESTRICTED
  // so `S ⊆ K` holds for any `S`. Narrowing here would refuse the three open
  // `orseam-*` sessions on `qwen/qwen3.8-flash` BEFORE the mint: real present harm,
  // in the one window where this control provides nothing.
  for (const entry of [{ env: "OPENROUTER_API_KEY" }, { env: "OPENROUTER_API_KEY", source: "x" }]) {
    const skews: { kind: string }[] = [];
    withProvidersFile(entry, (p) => {
      const resolution = resolveOpenRouterEntitlement({ providersPath: p });
      assert.equal(resolution.narrowed, false);
      assert.equal(resolution.entries, OPENROUTER_ENTITLEMENT);
      assert.equal(resolution.skew?.kind, "unrecorded");
      assert.equal(
        captureThrow(() =>
          assertModelPolicy(REAL_CLAUDE_COMMAND, "qwen/qwen3.8-flash", {
            entitlement: resolution,
            onEntitlementSkew: (skew) => skews.push(skew),
          }),
        ),
        undefined,
        "a non-green entitled model must keep working pre-cutover",
      );
    });
    assert.equal(
      skews.length,
      1,
      "unrecorded must still be SAID — a silent check looks like a pass",
    );
  }
});

test("a missing or malformed providers.json resolves `unrecorded`, never throws", () => {
  // The route's never-throw-into-session-creation rule. A spawn must not fail
  // because this file is absent — most boxes have none.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-entitlement-none-"));
  try {
    const absent = resolveOpenRouterEntitlement({
      providersPath: path.join(dir, "nope.json"),
    });
    assert.equal(absent.skew?.kind, "unrecorded");
    assert.equal(absent.narrowed, false);

    const malformedPath = path.join(dir, "bad.json");
    fs.writeFileSync(malformedPath, "{ not json");
    const malformed = resolveOpenRouterEntitlement({ providersPath: malformedPath });
    assert.equal(malformed.skew?.kind, "unrecorded");
    assert.equal(malformed.narrowed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("both skew wordings name the state, the consequence and the remedy — and carry no key", () => {
  const mismatch = formatOpenRouterEntitlementSkew({
    kind: "mismatch",
    name: "openrouter",
    codeSha: OPENROUTER_ENTITLEMENT_SHA,
    entrySha: "deadbeef".repeat(8),
  });
  assert.match(mismatch, /NOT in step/);
  assert.match(mismatch, /Narrowing to the green list/);
  assert.match(mismatch, /re-mint/);
  for (const entry of OPENROUTER_GREEN_LIST) {
    assert.ok(mismatch.includes(entry.slug));
  }

  const unrecorded = formatOpenRouterEntitlementSkew({
    kind: "unrecorded",
    name: "openrouter",
    codeSha: OPENROUTER_ENTITLEMENT_SHA,
  });
  assert.match(unrecorded, /records no entitlementSha/);
  assert.match(unrecorded, /full entitlement/);
  // It must NOT claim the provider enforces anything, because pre-cutover it does
  // not — the same rule that had the false key-level claim cut from the
  // Claude-family message.
  assert.match(unrecorded, /nothing refuses it at the provider yet/);
  for (const text of [mismatch, unrecorded]) {
    assert.equal(/sk-[A-Za-z0-9]/.test(text), false, "a skew line must never carry a credential");
  }
});

test("the refusal claims provider enforcement ONLY when acpx can prove it", () => {
  // Settled (sha equal) ⇒ the key provably came from this list, so saying "a direct
  // call would be refused too" is true and is the sharper deterrent.
  const settledError = captureThrow(() =>
    assertModelPolicy(REAL_CLAUDE_COMMAND, "openai/gpt-5-pro", { entitlement: settled() }),
  );
  assert.match((settledError as Error).message, /bounded to this same list/);

  // Unrecorded ⇒ acpx does NOT know, so it must not claim it. A message an agent can
  // falsify with one `curl` is worth less than no message at all.
  const unrecordedError = captureThrow(() =>
    assertModelPolicy(REAL_CLAUDE_COMMAND, "openai/gpt-5-pro", {
      entitlement: {
        entries: OPENROUTER_ENTITLEMENT,
        narrowed: false,
        skew: { kind: "unrecorded", name: "openrouter", codeSha: OPENROUTER_ENTITLEMENT_SHA },
      },
    }),
  );
  assert.match((unrecordedError as Error).message, /not yet bounded to this list at the provider/);
  assert.equal(
    (unrecordedError as Error).message.includes("bounded to this same list"),
    false,
    "acpx must not claim provider enforcement it cannot prove",
  );

  // Narrowed ⇒ the key came from a DIFFERENT list, so it might well serve this
  // model; the claim must be withheld there too.
  const narrowedError = captureThrow(() =>
    assertModelPolicy(REAL_CLAUDE_COMMAND, "openai/gpt-5-pro", { entitlement: narrowed() }),
  );
  assert.equal((narrowedError as Error).message.includes("bounded to this same list"), false);
});

// ── `providers.json` round-trip: BOTH field lists ────────────────────────────

test("entitlementSha survives parsing AND the status projection", async () => {
  // 🛑 providers.ts carries TWO explicit field lists — OPTIONAL_STRING_FIELDS
  // (parsing) and STATUS_FIELDS (the `describeBoxProviders` projection). A field
  // missing from EITHER is dropped silently, in opposite directions, with nothing
  // failing. This asserts both halves.
  const { loadBoxProviders, describeBoxProviders } = await import("../src/config/providers.js");
  const sha = OPENROUTER_ENTITLEMENT_SHA;
  withProvidersFile(
    { env: "OPENROUTER_API_KEY", apiKey: "sk-test-not-a-real-key", entitlementSha: sha },
    (p) => {
      const parsed = loadBoxProviders({ providersPath: p }).providers[0];
      assert.equal(parsed?.entitlementSha, sha, "dropped by OPTIONAL_STRING_FIELDS");

      const status = describeBoxProviders({ providersPath: p, env: {} })[0];
      assert.equal(status?.entitlementSha, sha, "dropped by STATUS_FIELDS");
      // The projection still has no slot for the credential.
      assert.equal(JSON.stringify(status).includes("sk-test"), false);
    },
  );
});

// ── The READ path ────────────────────────────────────────────────────────────

test("the READ path narrows: a non-entitled row is unavailable for claude and pi", () => {
  const snapshot = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
  const catalogue = buildCatalogue(snapshot.models, META, {
    entitlement: OPENROUTER_ENTITLEMENT,
  });
  const openRouterRows = catalogue.models.filter((model) => model.source === "openrouter");
  assert.ok(openRouterRows.length > 50, "the fixture must actually carry OpenRouter rows");

  let entitledSeen = 0;
  let refusedSeen = 0;
  for (const model of openRouterRows) {
    if (model.unavailableReasons.length > 0) {
      continue; // already blocked for an unrelated reason — not this branch's subject
    }
    const entitled =
      entitlementModelIds().includes(model.id.replace(/^~/, "").toLowerCase()) ||
      entitlementModelIds().includes(model.id.toLowerCase());
    for (const agent of ["claude", "pi"] as const) {
      const availability = model.availability[agent];
      if (availability === undefined) {
        continue;
      }
      if (entitled) {
        entitledSeen += 1;
        assert.equal(availability.ok, true, `${model.id} is entitled and must be offered`);
      } else if (availability.reason === OPENROUTER_NOT_ENTITLED_REASON) {
        refusedSeen += 1;
        assert.equal(availability.ok, false);
      }
    }
  }
  // BOTH counts must be non-zero, or the loop proves nothing: all-refused would
  // pass a one-sided check, and so would all-offered.
  assert.ok(entitledSeen > 0, "no entitled row was offered — the fixture or the join is wrong");
  assert.ok(refusedSeen > 0, "no row was refused — the read-path narrowing is not firing");
});

test("the READ path leaves codex's own message alone, and Claude-family keeps its own reason", async () => {
  const { CLAUDE_FAMILY_OPENROUTER_REASON } = await import("../src/models/claude-family.js");
  const snapshot = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
  const catalogue = buildCatalogue(snapshot.models, META, { entitlement: OPENROUTER_ENTITLEMENT });

  const claudeRow = catalogue.models.find(
    (model) => model.source === "openrouter" && model.id.startsWith("anthropic/claude"),
  );
  assert.ok(claudeRow, "the fixture must carry an anthropic/claude row");
  // The Claude branch sits ABOVE the entitlement branch, so a Claude row keeps the
  // specialised reason rather than the generic one.
  assert.equal(claudeRow.availability.claude?.reason, CLAUDE_FAMILY_OPENROUTER_REASON);
  assert.notEqual(claudeRow.availability.claude?.reason, OPENROUTER_NOT_ENTITLED_REASON);

  // Codex cannot reach OpenRouter at all, and that is the more informative answer —
  // the entitlement branch sits after the arbitrary-ids arm so this stays true.
  const anyRow = catalogue.models.find((model) => model.source === "openrouter");
  assert.ok(anyRow);
  assert.notEqual(anyRow.availability.codex?.reason, OPENROUTER_NOT_ENTITLED_REASON);
  assert.equal(anyRow.availability.codex?.ok, false);
});

test("`acpx models list --agent` DROPS a non-entitled row, and `--all` keeps it WITH the reason", async () => {
  // The user-visible consequence of the read path, asserted through the same band
  // mechanism the CLI renders from: absent by default, present and explained under
  // `--all`. That split is the design — availability annotates and never filters,
  // so an agent asking "why can I not use this?" always gets an answer.
  const { bandModels } = await import("../src/models/matcher.js");
  const snapshot = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
  const catalogue = buildCatalogue(snapshot.models, META, { entitlement: OPENROUTER_ENTITLEMENT });

  const nonEntitled = catalogue.models.find(
    (model) => model.availability.claude?.reason === OPENROUTER_NOT_ENTITLED_REASON,
  );
  assert.ok(nonEntitled, "the fixture must produce at least one non-entitled row");

  const listed = (includeUnavailable: boolean) =>
    bandModels(catalogue.models, { agentType: "claude", includeUnavailable }).flatMap(
      (band) => band.models,
    );

  assert.equal(
    listed(false).some((model) => model.key === nonEntitled.key),
    false,
    "a non-entitled row must be ABSENT from the default listing",
  );
  const all = listed(true);
  assert.ok(
    all.some((model) => model.key === nonEntitled.key),
    "`--all` must still list it — a silently vanished row is the failure Tier 3 prevents",
  );
  assert.equal(nonEntitled.availability.claude?.ok, false);
  assert.match(nonEntitled.availability.claude?.message ?? "", /entitlement set/);

  // POSITIVE CONTROL: an entitled row is in BOTH listings, so the assertion above
  // cannot be passing because the default listing is empty.
  const entitledRow = catalogue.models.find(
    (model) => model.id === "z-ai/glm-5.3-flash" && model.source === "openrouter",
  );
  if (entitledRow) {
    assert.ok(listed(false).some((model) => model.key === entitledRow.key));
  }
});

test("Tier 1 REFUSES on entitlement too — the read path is not declaration-only", async () => {
  // 🛑 THE TEST BEHIND A COMMENT THAT ASSERTS A GUARANTEE (`catalogue.ts`, the
  // entitlement branch). The Claude-family Tier 3 branch IS declaration-only; this one
  // is not, and the difference is easy to state wrongly and impossible to notice:
  // `availability` is also read by `assertModelAvailable` inside
  // `validateModelSelection`, which THROWS. So a row this branch marks unavailable is
  // refused by the `--model` gate, one tier ABOVE `assertModelPolicy`.
  const { ModelSlugError, validateModelSelection } =
    await import("../src/models/model-slug-validation.js");
  const entitled = OPENROUTER_ENTITLEMENT[0];
  assert.ok(entitled);
  const rows = [
    { id: entitled.slug, name: "entitled", supported_parameters: ["tools"] },
    { id: "zzz-vendor/not-entitled-1", name: "outsider", supported_parameters: ["tools"] },
  ];
  const catalogue = buildCatalogue(rows, META, { entitlement: OPENROUTER_ENTITLEMENT });

  // THE NEGATIVE: the non-entitled row is refused at Tier 1, by the catalogue's reason.
  let thrown: unknown;
  try {
    validateModelSelection(catalogue, {
      model: "zzz-vendor/not-entitled-1",
      agentName: "claude",
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ModelSlugError, "Tier 1 must refuse a non-entitled row");
  assert.equal(thrown.detailCode, "MODEL_NOT_AVAILABLE_FOR_AGENT");
  // The wording must still name the set, or the refusal relocates the puzzle.
  assert.match(thrown.message, /entitlement set/);
  for (const row of OPENROUTER_ENTITLEMENT) {
    assert.ok(thrown.message.includes(row.slug), `Tier 1's refusal must name ${row.slug}`);
  }

  // POSITIVE CONTROL on the same call shape: the ENTITLED row resolves. Without it
  // this row would pass on a Tier 1 that refuses every OpenRouter id.
  const resolved = validateModelSelection(catalogue, {
    model: entitled.slug,
    agentName: "claude",
  });
  assert.equal(resolved?.id, entitled.slug);
  assert.equal(resolved?.source, "openrouter");
});
