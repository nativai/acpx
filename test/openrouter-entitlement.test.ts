import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { catalogueNeedsWarm } from "../src/models/catalogue-warm.js";
import { buildCatalogue, loadCatalogue } from "../src/models/catalogue.js";
import {
  CLAUDE_ADVERT_SCHEMA,
  currentClaudeAdvertKey,
} from "../src/models/claude-advertisement.js";
import {
  assertModelPolicy,
  ClaudeFamilyOnOpenRouterError,
  CLAUDE_FAMILY_OPENROUTER_REASON,
  claudeFamilyOnOpenRouterMessage,
  OPENROUTER_NOT_ENTITLED_REASON,
  OpenRouterModelNotEntitledError,
} from "../src/models/claude-family.js";
import type { OpenRouterSnapshot } from "../src/models/openrouter-catalogue.js";
import {
  describeCatalogueEntitlement,
  ENTITLEMENT_TTL_MS,
  ENTITLEMENT_UNKNOWN,
  entitlementModelSlugs,
  fetchOpenRouterAllowedModels,
  formatEntitlementUnknown,
  isEntitledOpenRouterModelId,
  isFloatingAliasModelId,
  isOpenRouterRouteShapedModelId,
  loadOpenRouterEntitlement,
  NO_ENTITLEMENT_FETCH_ENV,
  readOpenRouterEntitlementSync,
  type EntitlementSnapshot,
  type OpenRouterEntitlement,
} from "../src/models/openrouter-entitlement.js";

/**
 * THE PERMANENT NEGATIVE TESTS for brick ecfb0461 — *the box's OpenRouter KEY is the
 * one authority for which models an agent may pick.*
 *
 * ## What changed, and what that does to this file
 *
 * The previous design kept a hardcoded entitlement list in acpx **beside** the key's
 * `allowed_models`, and most of this file guarded the machinery that kept the two
 * honest — an `entitlementSha`, a comparison at spawn, three resolution branches, a
 * narrowing rule, a skew warning. **All of that is deleted**, because it existed
 * only to detect divergence between two authorities and there is now one. The rows
 * that guarded it are deleted with it; a test for a mechanism that no longer exists
 * is not coverage, it is a second thing to maintain.
 *
 * What replaces them is the one property that matters under a single authority:
 * **acpx's answer is the key's answer, and when acpx cannot get the key's answer it
 * gets out of the way.**
 *
 * Every guarantee below carries its own negative input and lives in the suite
 * forever. **No mutation probe, no "gut the guard and re-run"** — a check proves it
 * can fail by holding an input it must reject.
 *
 * ## ⚠️ WHAT GOES RED IF EACH PIECE IS BROKEN
 *
 *   delete `assertModelPolicy`'s route gate (`isOpenRouterRouteShapedModelId`)
 *       → "POSITIVE CONTROL — the `/` boundary": every live bare alias and codex id
 *         starts being refused. This is the single most destructive possible
 *         regression here and it is what that block exists for.
 *   reword or drop the shipped Claude-family refusal
 *       → "the shipped Claude-family message survives verbatim"
 *   leave Claude-family to the key instead of refusing it first
 *       → "a key that allows Claude STILL cannot open the metered Claude route"
 *   drop the floating-alias refusal
 *       → "a floating alias is refused even though its pinned sibling is allowed"
 *   make an unknown set refuse instead of permit (fail CLOSED)
 *       → "FAIL OPEN — an unreadable key answer permits, and says so"
 *   reintroduce a hardcoded list as a fallback
 *       → "FAIL OPEN" again: a fallback list would refuse where the row expects a pass
 *   stop honouring the key's answer at all
 *       → "a model the key does not allow is refused, naming the set"
 *   read only `.data[].id` and drop `canonical_slug`
 *       → "the fetch reads BOTH id forms off the measured response shape"
 *   serve a cache minted for a DIFFERENT key (a re-mint)
 *       → "a cache belonging to another key is COLD, not authoritative"
 *   serve a cache past its TTL from the spawn path
 *       → "the sync reader treats a stale set as unknown"
 *   let `loadCatalogue` swallow its injected set again
 *       → "loadCatalogue FORWARDS the injected set to buildCatalogue"
 *   warm only on a cold CATALOGUE and ignore a cold entitlement cache
 *       → "a cold entitlement cache triggers the warm even when the catalogue is fresh"
 *   drop the read-path narrowing in `availabilityFor`
 *       → "the READ path narrows"
 *   drop `policyReason` anywhere between the throw and the wire
 *       → "policyReason reaches the SERIALIZED output"
 *   serve a stale set from the read path WITHOUT labelling it
 *       → "the Tier 3 annotation LABELS a stale set"
 *   fail open on the READ path without SAYING SO (decision 2, half-implemented)
 *       → "the READ path says so when the key's set is UNKNOWN" — and its healthy-path
 *         negative, so a build that always warns cannot pass either
 */

const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/openrouter-models-2026-09-04.json");
const META = { fetchedAt: "2026-09-04T00:10:56.992Z", stale: false, error: null };

/**
 * THE MEASURED ANSWER. These are the exact ids `GET /api/v1/models/user` returned for
 * devbox's key on 2026-09-29 — `total_count: 2`, `links.next: null`, each row
 * carrying `canonical_slug` as a field.
 *
 * ⚠️ **WRITTEN DOWN, NOT FETCHED.** A test that asked the real endpoint would need a
 * credential and a network, would go red when Daniel re-mints, and would put the
 * box's key on the wire on every gate run — see `test/box-env-scrub.ts`.
 */
const KEY_ALLOWS = [
  "z-ai/glm-5.3-flash",
  "z-ai/glm-5.3-flash-20260826",
  "deepseek/deepseek-v4.1-flash",
  "deepseek/deepseek-v4.1-flash-20260910",
] as const;

/** The plain slugs of the two models above — what a human writes and a message names. */
const KEY_ALLOWS_SLUGS = ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash"] as const;

function known(ids: readonly string[] = KEY_ALLOWS): OpenRouterEntitlement {
  return {
    allowed: new Set(ids),
    fetchedAt: "2026-09-29T00:00:00.000Z",
    stale: false,
    error: null,
  };
}

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

/**
 * A scratch dir holding a `providers.json` and, optionally, an entitlement cache.
 *
 * 🛑 **`async`, AND THE `await` IN THE `try` IS LOAD-BEARING.** Written as a plain
 * `try { return run(p) } finally { rm() }`, the `finally` fires the moment an async
 * callback returns its PROMISE — so the directory is deleted before the body has
 * read a byte of it. It does not fail loudly either: the provider read degrades to
 * "no credential" by contract, the loader reports UNKNOWN, and the row reads as a
 * product that stopped honouring the key rather than a harness that deleted its own
 * fixture. (Hit exactly that way while writing this file.)
 */
async function withScratch<T>(
  options: { entry?: Record<string, unknown>; cache?: unknown },
  run: (paths: { providersPath: string; entitlementCachePath: string }) => T | Promise<T>,
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-entitlement-"));
  const providersPath = path.join(dir, "providers.json");
  const entitlementCachePath = path.join(dir, "openrouter-entitlement.json");
  if (options.entry !== undefined) {
    fs.writeFileSync(
      providersPath,
      JSON.stringify({
        version: 1,
        box: "test",
        // ⚠️ `env` IS MANDATORY OR THE ENTRY IS SILENTLY DROPPED. `parseEntry` returns
        // `undefined` for an entry with no `env` — "without the variable name there is
        // nothing to deliver" — so a fixture omitting it produces a providers file
        // that parses fine and yields ZERO providers. The reader then reports "this
        // box has no resolvable OpenRouter credential", which reads exactly like the
        // no-credential case a neighbouring row deliberately tests.
        providers: { openrouter: { env: "OPENROUTER_API_KEY", ...options.entry } },
      }),
    );
  }
  if (options.cache !== undefined) {
    fs.writeFileSync(
      entitlementCachePath,
      typeof options.cache === "string" ? options.cache : JSON.stringify(options.cache),
    );
  }
  try {
    return await run({ providersPath, entitlementCachePath });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The fingerprint `providers.ts` computes — imported rather than re-derived here. */
async function fingerprint(key: string): Promise<string> {
  const { fingerprintCredential } = await import("../src/config/providers.js");
  return fingerprintCredential(key);
}

const TEST_KEY = "sk-or-v1-test-key-for-the-acpx-suite-only";

// ── The route gate: the `/` boundary ─────────────────────────────────────────

test("POSITIVE CONTROL — the `/` boundary: live bare aliases and codex ids are NOT route-shaped", () => {
  // 🛑 THE MOST DESTRUCTIVE POSSIBLE REGRESSION IN THIS FILE'S SUBJECT. An allowlist
  // that over-reaches refuses everything it does not know, so the route gate is the
  // only thing standing between `assertModelPolicy` and every claude and codex
  // session on the box. Each id below was measured in devbox's live session store.
  for (const id of LIVE_NON_ROUTE_IDS) {
    assert.equal(isOpenRouterRouteShapedModelId(id), false, `${id} must not be route-shaped`);
    for (const command of [REAL_CLAUDE_COMMAND, REAL_PI_COMMAND]) {
      assert.equal(
        captureThrow(() => assertModelPolicy(command, id, { entitlement: known() })),
        undefined,
        `${id} must survive the policy gate untouched`,
      );
    }
  }
  // …and NO `--model` at all is likewise untouched, on every state of the set.
  for (const entitlement of [known(), ENTITLEMENT_UNKNOWN]) {
    assert.equal(
      captureThrow(() => assertModelPolicy(REAL_CLAUDE_COMMAND, undefined, { entitlement })),
      undefined,
    );
    assert.equal(
      captureThrow(() => assertModelPolicy(REAL_CLAUDE_COMMAND, "  ", { entitlement })),
      undefined,
    );
  }
  // NEGATIVE CONTROL: a namespaced id IS route-shaped, and so is an explicit prefix
  // with nothing after it. Without this the block above would pass on a predicate
  // that answered `false` to everything.
  for (const id of ["z-ai/glm-5.3-flash", "openrouter/free", "openrouter:anything"]) {
    assert.equal(isOpenRouterRouteShapedModelId(id), true, id);
  }
});

// ── The shipped Claude-family refusal survives, verbatim and list-independent ─

test("the shipped Claude-family message survives verbatim, in all three spellings", () => {
  for (const spelling of THREE_SPELLINGS) {
    const error = captureThrow(() =>
      assertModelPolicy(REAL_CLAUDE_COMMAND, spelling, { entitlement: known() }),
    );
    assert.ok(error instanceof ClaudeFamilyOnOpenRouterError, spelling);
    assert.equal(detailCodeOf(error), "CLAUDE_FAMILY_ON_OPENROUTER", spelling);
    // Byte-identical to the shipped wording — this is what catches a regression into
    // the general not-allowed message, which would still throw and still be a refusal
    // while losing every route-around the Claude message closes.
    assert.equal(
      (error as Error).message,
      claudeFamilyOnOpenRouterMessage({ requested: spelling.trim(), harness: "claude" }),
      spelling,
    );
  }
  // pi gets its own wording, and must not be told to pass `--model sonnet`.
  const piError = captureThrow(() =>
    assertModelPolicy(REAL_PI_COMMAND, "anthropic/claude-sonnet-5", { entitlement: known() }),
  );
  assert.ok(piError instanceof ClaudeFamilyOnOpenRouterError);
  assert.equal(
    (piError as Error).message,
    claudeFamilyOnOpenRouterMessage({ requested: "anthropic/claude-sonnet-5", harness: "pi" }),
  );
});

test("a key that allows Claude STILL cannot open the metered Claude route", () => {
  // 🛑 THE ORDERING GUARANTEE, AND THE REASON DECISION 4 KEPT THIS CHECK. Under one
  // authority the tempting simplification is "the key decides, so delete the
  // Claude-family branch". This row is what that would break: a key scoped (by
  // accident or by a future re-mint) to include a Claude-family id would silently
  // re-open the metered route the 2026-09-27 incident closed. Claude-family is
  // refused BEFORE the key's set is consulted, so it cannot.
  const permissive = known([...KEY_ALLOWS, "anthropic/claude-sonnet-5"]);
  const error = captureThrow(() =>
    assertModelPolicy(REAL_CLAUDE_COMMAND, "anthropic/claude-sonnet-5", {
      entitlement: permissive,
    }),
  );
  assert.ok(error instanceof ClaudeFamilyOnOpenRouterError);

  // POSITIVE CONTROL: the permissive set IS otherwise honoured, so the row above was
  // genuinely present and genuinely ignored — not silently dropped from the set.
  assert.equal(
    captureThrow(() =>
      assertModelPolicy(REAL_CLAUDE_COMMAND, "openai/gpt-5-pro", {
        entitlement: known(["openai/gpt-5-pro"]),
      }),
    ),
    undefined,
  );

  // …and it survives FAIL-OPEN, which is the state the whole design leans on. With
  // no set at all, everything else is permitted and Claude is still refused.
  assert.ok(
    captureThrow(() =>
      assertModelPolicy(REAL_CLAUDE_COMMAND, "anthropic/claude-sonnet-5", {
        entitlement: ENTITLEMENT_UNKNOWN,
      }),
    ) instanceof ClaudeFamilyOnOpenRouterError,
  );
});

// ── The key's set IS the allowlist ───────────────────────────────────────────

test("every id the key allows, in BOTH forms and all three spellings, is permitted", () => {
  for (const form of KEY_ALLOWS) {
    for (const spelling of [form, `openrouter/${form}`, `openrouter:${form}`]) {
      assert.equal(
        captureThrow(() => assertModelPolicy(REAL_PI_COMMAND, spelling, { entitlement: known() })),
        undefined,
        `${spelling} must be permitted`,
      );
    }
  }
});

test("a model the key does not allow is refused, naming the set", () => {
  // `moonshotai/kimi-k3` is a real id from this box's store — a model that WAS used
  // and is not allowed. `openai/gpt-5-pro` is the frontier row the old Claude-only
  // denylist left open.
  for (const id of [
    "openai/gpt-5-pro",
    "google/gemini-3-ultra",
    "moonshotai/kimi-k3",
    "qwen/qwen3.8-flash",
    "openrouter/openai/gpt-5-pro",
    "openrouter:google/gemini-3-ultra",
    "openrouter/free",
  ]) {
    const error = captureThrow(() =>
      assertModelPolicy(REAL_CLAUDE_COMMAND, id, { entitlement: known() }),
    );
    assert.ok(error instanceof OpenRouterModelNotEntitledError, id);
    assert.equal(detailCodeOf(error), "OPENROUTER_MODEL_NOT_ENTITLED", id);
    const message = (error as Error).message;
    assert.ok(message.includes(id), `the refusal must echo the caller's own spelling: ${id}`);
    for (const slug of KEY_ALLOWS_SLUGS) {
      assert.ok(message.includes(slug), `the refusal must name ${slug}`);
    }
    // 🛑 AND IT MUST NOT NAME THE MODEL IT IS REFUSING AS A REMEDY. The predecessor
    // built this list from a module-level constant and so offered the refused model
    // back as a choice — the agent had no available action and the obvious next move
    // is to retry what just failed. Derived from the live set, that shape is
    // unreachable; this asserts it stays so.
    const remedy = message.slice(message.indexOf("models this box's key allows:"));
    assert.equal(remedy.includes(id), false, `the remedy list must not contain ${id}`);
  }
});

test("a floating alias is refused even though its pinned sibling is allowed", () => {
  for (const alias of [
    "~z-ai/glm-5.3-flash",
    "z-ai/glm-5.3-flash-latest",
    "~z-ai/glm-flash-latest",
    "openrouter/~z-ai/glm-5.3-flash",
    "openrouter:z-ai/glm-5.3-flash-latest",
  ]) {
    assert.equal(isFloatingAliasModelId(alias), true, alias);
    const error = captureThrow(() =>
      assertModelPolicy(REAL_PI_COMMAND, alias, { entitlement: known() }),
    );
    assert.ok(error instanceof OpenRouterModelNotEntitledError, alias);
    assert.match((error as Error).message, /FLOATING alias/, alias);
  }
  // POSITIVE CONTROL: the non-alias sibling of the very same model is served, so the
  // block above cannot be passing because `z-ai/glm-5.3-flash` is refused too.
  assert.equal(
    captureThrow(() =>
      assertModelPolicy(REAL_PI_COMMAND, "z-ai/glm-5.3-flash", { entitlement: known() }),
    ),
    undefined,
  );
  // ⚠️ THE DELIBERATE EXCEPTION TO "THE KEY DECIDES", PINNED SO IT IS A DECISION AND
  // NOT AN ACCIDENT: even a key that explicitly allowed the alias does not lift the
  // shape refusal, and neither does fail-open. A floating id is the one form whose
  // cost can change with no edit by anyone.
  for (const entitlement of [known(["~z-ai/glm-5.3-flash"]), ENTITLEMENT_UNKNOWN]) {
    assert.ok(
      captureThrow(() =>
        assertModelPolicy(REAL_PI_COMMAND, "~z-ai/glm-5.3-flash", { entitlement }),
      ) instanceof OpenRouterModelNotEntitledError,
    );
  }
});

// ── FAIL OPEN — the dividend of one authority ────────────────────────────────

test("FAIL OPEN — an unreadable key answer permits, and says so", () => {
  // 🛑 THE DECISION THIS BRICK OWNS, WITH ITS NEGATIVE INPUT. Under two lists,
  // failing open meant no enforcement. Under one authority the KEY still refuses, so
  // an unreadable local set costs a clean message and nothing else — while failing
  // CLOSED would break every OpenRouter spawn on the box whenever OpenRouter is slow.
  const notes: OpenRouterEntitlement[] = [];
  for (const id of ["openai/gpt-5-pro", "moonshotai/kimi-k3", "zzz-vendor/never-heard-of-it"]) {
    assert.equal(
      captureThrow(() =>
        assertModelPolicy(REAL_CLAUDE_COMMAND, id, {
          entitlement: { ...ENTITLEMENT_UNKNOWN, error: "connect ETIMEDOUT" },
          onEntitlementUnknown: (entitlement) => notes.push(entitlement),
        }),
      ),
      undefined,
      `${id} must be PERMITTED when acpx cannot read what the key allows`,
    );
  }

  // 🛑 A FALLBACK LIST WOULD FAIL HERE. If anyone reintroduces a hardcoded set as a
  // "safe default" for the unknown state, `openai/gpt-5-pro` starts being refused and
  // this row goes red — which is the whole reason it enumerates frontier ids rather
  // than nonsense ones.

  // …and the skip is REPORTED, once per model actually checked.
  assert.equal(notes.length, 3, "the note must fire for each check that was skipped");
  const first = notes[0];
  assert.ok(first);
  const note = formatEntitlementUnknown(first);
  assert.match(note, /could not read/);
  assert.match(note, /connect ETIMEDOUT/, "the note must carry WHY it could not read");
  assert.match(note, /key itself still enforces/, "it must say the key still refuses");
  assert.match(note, /acpx models --refresh/, "a remedy that actually runs");

  // NEGATIVE CONTROL on the callback: it must NOT fire for a spawn the gate never had
  // to check, or it becomes ambient noise on the claude sessions that dominate this
  // box and stops being read at all.
  const quiet: unknown[] = [];
  for (const id of ["opus", "sonnet", "gpt-6-astra[high]", undefined]) {
    assertModelPolicy(REAL_CLAUDE_COMMAND, id, {
      entitlement: ENTITLEMENT_UNKNOWN,
      onEntitlementUnknown: (entitlement) => quiet.push(entitlement),
    });
  }
  assert.equal(quiet.length, 0, "the note must not fire for non-OpenRouter model ids");

  // …nor when the set IS known, however the call goes.
  const silent: unknown[] = [];
  assertModelPolicy(REAL_PI_COMMAND, "z-ai/glm-5.3-flash", {
    entitlement: known(),
    onEntitlementUnknown: (entitlement) => silent.push(entitlement),
  });
  captureThrow(() =>
    assertModelPolicy(REAL_PI_COMMAND, "openai/gpt-5-pro", {
      entitlement: known(),
      onEntitlementUnknown: (entitlement) => silent.push(entitlement),
    }),
  );
  assert.equal(silent.length, 0);
});

test("UNKNOWN and EMPTY are different facts — an empty set still refuses", () => {
  // 🛑 COLLAPSING THEM IS HOW A COLD CACHE BECOMES A BOX WHERE NOTHING IS SELECTABLE.
  // `allowed: null` permits; `allowed: new Set()` — a key that genuinely allows
  // nothing — refuses. Both directions are asserted, because a predicate that merely
  // checked `size === 0` would pass one of them.
  assert.equal(isEntitledOpenRouterModelId("openai/gpt-5-pro", ENTITLEMENT_UNKNOWN), true);
  assert.equal(isEntitledOpenRouterModelId("openai/gpt-5-pro", known([])), false);
  assert.ok(
    captureThrow(() =>
      assertModelPolicy(REAL_PI_COMMAND, "openai/gpt-5-pro", { entitlement: known([]) }),
    ) instanceof OpenRouterModelNotEntitledError,
  );
});

// ── Reading the key: the measured response shape ─────────────────────────────

test("the fetch reads BOTH id forms off the measured response shape", async () => {
  // The body is the one measured on devbox 2026-09-29 — `total_count: 2`,
  // `links.next: null`, `canonical_slug` as a FIELD on each row.
  let seenUrl = "";
  let seenAuth = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    seenAuth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "z-ai/glm-5.3-flash",
            canonical_slug: "z-ai/glm-5.3-flash-20260826",
            name: "GLM 5.3 Flash",
          },
          {
            id: "deepseek/deepseek-v4.1-flash",
            canonical_slug: "deepseek/deepseek-v4.1-flash-20260910",
          },
          { id: "  " }, // blank ids are dropped, not stored
          "not an object", // and so is anything that is not a row
        ],
        links: { next: null },
        total_count: 2,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
  try {
    const snapshot = await fetchOpenRouterAllowedModels(TEST_KEY);
    assert.deepEqual(snapshot.modelIds, [...KEY_ALLOWS].toSorted());
    assert.ok(Date.parse(snapshot.fetchedAt) > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(seenUrl, "https://openrouter.ai/api/v1/models/user");
  // ⚠️ THE CREDENTIAL TRAVELS IN A HEADER AND NOWHERE ELSE. A key in the URL would
  // reach access logs, proxies and any error message that echoes the request.
  assert.equal(seenAuth, `Bearer ${TEST_KEY}`);
  assert.equal(seenUrl.includes(TEST_KEY), false, "the key must never appear in the URL");
});

test("a non-200 from models/user is an error, not an empty set", async () => {
  // 🛑 THE DANGEROUS MISREAD. A 401/403 body has no `data`, and treating that as
  // "the key allows nothing" would refuse every model on the box. It must raise, so
  // the loader's catch turns it into UNKNOWN and the product fails open.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof globalThis.fetch;
  try {
    await assert.rejects(() => fetchOpenRouterAllowedModels(TEST_KEY), /401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  // …and a 200 whose body has no `data` array is equally an error, not emptiness.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ total_count: 0 }), { status: 200 })) as typeof globalThis.fetch;
  try {
    await assert.rejects(() => fetchOpenRouterAllowedModels(TEST_KEY), /no "data" array/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── The cache: where it lives, and every way it goes cold ────────────────────

test("a successful read is cached, and the cache is served without a second fetch", async () => {
  await withScratch({ entry: { apiKey: TEST_KEY } }, async (paths) => {
    let calls = 0;
    const fetchAllowed = async (): Promise<EntitlementSnapshot> => {
      calls += 1;
      return { fetchedAt: new Date().toISOString(), modelIds: [...KEY_ALLOWS] };
    };
    const options = { ...paths, env: {} as NodeJS.ProcessEnv, fetchAllowed };

    const first = await loadOpenRouterEntitlement(options);
    assert.equal(calls, 1);
    assert.deepEqual([...(first.allowed ?? [])].toSorted(), [...KEY_ALLOWS].toSorted());
    assert.equal(first.stale, false);
    assert.equal(first.error, null);

    // Second call inside the TTL: served from disk, no fetch.
    const second = await loadOpenRouterEntitlement(options);
    assert.equal(calls, 1, "a fresh cache must not be refetched");
    assert.deepEqual([...(second.allowed ?? [])].toSorted(), [...KEY_ALLOWS].toSorted());

    // `--refresh` forces one, which is the seam `acpx models --refresh` uses.
    await loadOpenRouterEntitlement({ ...options, refresh: true });
    assert.equal(calls, 2);

    // The sync (spawn-path) reader sees the same set off the same file.
    const sync = readOpenRouterEntitlementSync(options);
    assert.deepEqual([...(sync.allowed ?? [])].toSorted(), [...KEY_ALLOWS].toSorted());

    // 🛑 THE CACHE FILE MUST NOT CONTAIN THE KEY. It carries a digest so a re-mint
    // can be detected; a stored key would turn a cache file into a credential store.
    const raw = fs.readFileSync(paths.entitlementCachePath, "utf8");
    assert.equal(raw.includes(TEST_KEY), false, "the cache must never hold the key itself");
    assert.ok(raw.includes(await fingerprint(TEST_KEY)), "it must hold the fingerprint");
  });
});

test("a cache belonging to another key is COLD, not authoritative", async () => {
  // 🛑 THE INVALIDATION THAT ACTUALLY FIRES. The allowed set almost never changes on
  // its own — it changes when the key is RE-MINTED, which produces a new key rather
  // than an older timestamp. On time alone, a box would serve the previous key's
  // answer for a full hour after a re-mint, which is exactly the window where being
  // wrong is most likely.
  const stale = {
    fetchedAt: new Date().toISOString(), // deliberately FRESH, so only the key differs
    keyFingerprint: await fingerprint("sk-or-v1-the-PREVIOUS-key"),
    modelIds: ["openai/gpt-5-pro"],
  };
  await withScratch({ entry: { apiKey: TEST_KEY }, cache: stale }, async (paths) => {
    const sync = readOpenRouterEntitlementSync({ ...paths, env: {} });
    assert.equal(sync.allowed, null, "a foreign-key cache must read as UNKNOWN");
    assert.match(sync.error ?? "", /different OpenRouter key/);
    // …so the old key's set cannot leak into a decision.
    assert.equal(isEntitledOpenRouterModelId("openai/gpt-5-pro", sync), true); // fail-open, not the stale list
    assert.equal(
      captureThrow(() =>
        assertModelPolicy(REAL_PI_COMMAND, "openai/gpt-5-pro", { entitlement: sync }),
      ),
      undefined,
    );

    // POSITIVE CONTROL: the very same file, re-stamped with the CURRENT key's
    // fingerprint, IS honoured — so the row above fails for the fingerprint and not
    // because the file was unreadable for some other reason.
    fs.writeFileSync(
      paths.entitlementCachePath,
      JSON.stringify({ ...stale, keyFingerprint: await fingerprint(TEST_KEY) }),
    );
    const honoured = readOpenRouterEntitlementSync({ ...paths, env: {} });
    assert.deepEqual([...(honoured.allowed ?? [])], ["openai/gpt-5-pro"]);
  });
});

test("the sync reader treats a stale, malformed or absent set as unknown", async () => {
  const fp = await fingerprint(TEST_KEY);
  const entry = { apiKey: TEST_KEY };

  // Past the TTL. ⚠️ The SYNC reader fails open on staleness rather than enforcing
  // an hour-old set: it cannot report, so quietly enforcing would be enforcement
  // without authority. (`loadOpenRouterEntitlement` *does* serve stale — it can say
  // so — which the next row pins.)
  await withScratch(
    {
      entry,
      cache: {
        fetchedAt: new Date(Date.now() - ENTITLEMENT_TTL_MS - 60_000).toISOString(),
        keyFingerprint: fp,
        modelIds: [...KEY_ALLOWS],
      },
    },
    (paths) => {
      const read = readOpenRouterEntitlementSync({ ...paths, env: {} });
      assert.equal(read.allowed, null);
      assert.match(read.error ?? "", /older than its TTL/);
    },
  );

  // Truncated / hand-mangled — a cold cache, never a crash.
  for (const cache of ["{ not json", JSON.stringify([1, 2]), JSON.stringify({ modelIds: 7 })]) {
    await withScratch({ entry, cache }, (paths) => {
      const read = readOpenRouterEntitlementSync({ ...paths, env: {} });
      assert.equal(read.allowed, null, cache);
      assert.ok(read.error, "a cold read must say WHY");
    });
  }

  // Absent outright.
  await withScratch({ entry }, (paths) => {
    assert.equal(readOpenRouterEntitlementSync({ ...paths, env: {} }).allowed, null);
  });

  // POSITIVE CONTROL: the same reader, same options, WITH a fresh well-formed cache
  // — so none of the nulls above can be a reader that always answers null.
  await withScratch(
    {
      entry,
      cache: { fetchedAt: new Date().toISOString(), keyFingerprint: fp, modelIds: [...KEY_ALLOWS] },
    },
    (paths) => {
      const read = readOpenRouterEntitlementSync({ ...paths, env: {} });
      assert.deepEqual([...(read.allowed ?? [])].toSorted(), [...KEY_ALLOWS].toSorted());
    },
  );
});

test("the load path serves a STALE set and labels it; a failed refresh never empties it", async () => {
  const fp = await fingerprint(TEST_KEY);
  await withScratch(
    {
      entry: { apiKey: TEST_KEY },
      cache: {
        fetchedAt: new Date(Date.now() - ENTITLEMENT_TTL_MS - 60_000).toISOString(),
        keyFingerprint: fp,
        modelIds: [...KEY_ALLOWS],
      },
    },
    async (paths) => {
      const failed = await loadOpenRouterEntitlement({
        ...paths,
        env: {},
        fetchAllowed: () => Promise.reject(new Error("connect ETIMEDOUT")),
      });
      // Stale-on-error: the cache is served rather than emptiness, and labelled.
      assert.deepEqual([...(failed.allowed ?? [])].toSorted(), [...KEY_ALLOWS].toSorted());
      assert.equal(failed.stale, true);
      assert.match(failed.error ?? "", /ETIMEDOUT/);
    },
  );

  // With NO cache to fall back on, the same failure is UNKNOWN — not an empty set.
  await withScratch({ entry: { apiKey: TEST_KEY } }, async (paths) => {
    const cold = await loadOpenRouterEntitlement({
      ...paths,
      env: {},
      fetchAllowed: () => Promise.reject(new Error("connect ETIMEDOUT")),
    });
    assert.equal(cold.allowed, null, "a cold cache plus a failed fetch is UNKNOWN, never empty");
    assert.match(cold.error ?? "", /ETIMEDOUT/);
  });
});

test("no credential and the no-fetch guard both prevent the call outright", async () => {
  // A box with no OpenRouter entry must not attempt an authenticated call at all.
  await withScratch({}, async (paths) => {
    let calls = 0;
    const result = await loadOpenRouterEntitlement({
      ...paths,
      env: {},
      fetchAllowed: async () => {
        calls += 1;
        return { fetchedAt: new Date().toISOString(), modelIds: [] };
      },
    });
    assert.equal(calls, 0, "no key ⇒ no request");
    assert.equal(result.allowed, null);
    assert.match(result.error ?? "", /no resolvable OpenRouter credential/);
  });

  // 🛑 AND THE SUITE'S OWN GUARD. This is the only authenticated outbound call acpx
  // makes for the model surface; `test/box-env-scrub.ts` sets this from the bootstrap
  // so no gate run can put the box's key on the wire. The guard is honoured AFTER the
  // fresh-cache branch, so a warm cache is still served — asserted below.
  const fp = await fingerprint(TEST_KEY);
  await withScratch({ entry: { apiKey: TEST_KEY } }, async (paths) => {
    let calls = 0;
    const guarded = await loadOpenRouterEntitlement({
      ...paths,
      env: { [NO_ENTITLEMENT_FETCH_ENV]: "1" },
      fetchAllowed: async () => {
        calls += 1;
        return { fetchedAt: new Date().toISOString(), modelIds: [] };
      },
    });
    assert.equal(calls, 0, "the guard must suppress the request");
    assert.equal(guarded.allowed, null);
    assert.match(guarded.error ?? "", new RegExp(NO_ENTITLEMENT_FETCH_ENV));

    // A warm cache is still served under the guard — it suppresses the FETCH only.
    fs.writeFileSync(
      paths.entitlementCachePath,
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        keyFingerprint: fp,
        modelIds: [...KEY_ALLOWS],
      }),
    );
    const warm = await loadOpenRouterEntitlement({
      ...paths,
      env: { [NO_ENTITLEMENT_FETCH_ENV]: "1" },
      fetchAllowed: async () => {
        calls += 1;
        return { fetchedAt: new Date().toISOString(), modelIds: [] };
      },
    });
    assert.equal(calls, 0);
    assert.deepEqual([...(warm.allowed ?? [])].toSorted(), [...KEY_ALLOWS].toSorted());
  });

  // POSITIVE CONTROL on the injected fetcher itself: with a key, no guard and a cold
  // cache, it IS called — so every `calls === 0` above is the guard working rather
  // than a seam that is never reached.
  await withScratch({ entry: { apiKey: TEST_KEY } }, async (paths) => {
    let calls = 0;
    await loadOpenRouterEntitlement({
      ...paths,
      env: {},
      fetchAllowed: async () => {
        calls += 1;
        return { fetchedAt: new Date().toISOString(), modelIds: [...KEY_ALLOWS] };
      },
    });
    assert.equal(calls, 1);
  });
});

test("`offline` never touches the network, whatever the cache says", async () => {
  await withScratch({ entry: { apiKey: TEST_KEY } }, async (paths) => {
    let calls = 0;
    const cold = await loadOpenRouterEntitlement({
      ...paths,
      env: {},
      offline: true,
      fetchAllowed: async () => {
        calls += 1;
        return { fetchedAt: new Date().toISOString(), modelIds: [] };
      },
    });
    assert.equal(calls, 0);
    assert.equal(cold.allowed, null);
  });
});

test("the Tier 3 annotation LABELS a stale set, and says nothing about staleness when fresh", async () => {
  // 🛑 THE COMMENT ON `openRouterNotEntitledAnnotation` ASSERTS THIS CLAUSE, SO IT
  // NEEDS A CASE. A comment has no adversary — no typecheck, no test, no reviewer
  // runs it — and a false one is what a future reader trusts INSTEAD of reading the
  // code. It matters because the two readers treat staleness DIFFERENTLY on purpose:
  // the read path serves a stale set and must say so (it can report), while the sync
  // spawn reader fails open (it cannot). Drop the label and the read path silently
  // enforces an hour-old set — enforcement the operator cannot see.
  const { openRouterNotEntitledAnnotation } = await import("../src/models/claude-family.js");
  const fresh = openRouterNotEntitledAnnotation(known());
  const stale = openRouterNotEntitledAnnotation({ ...known(), stale: true });

  assert.match(stale, /out-of-date cache/);
  assert.match(stale, /acpx models --refresh/, "a stale label must carry a remedy that runs");
  // THE NEGATIVE: a fresh set must NOT claim staleness, or the label means nothing.
  assert.equal(fresh.includes("out-of-date cache"), false);
  assert.notEqual(fresh, stale, "the two states must be distinguishable");
  // Both still name the allowed set — the label is additive, never a replacement.
  for (const slug of KEY_ALLOWS_SLUGS) {
    assert.ok(fresh.includes(slug), slug);
    assert.ok(stale.includes(slug), slug);
  }

  // …and it reaches the CATALOGUE ROW, not just the formatter: this is the string an
  // agent and the acpx-ui picker actually read.
  const rows = [{ id: "zzz-vendor/not-allowed-stale", supported_parameters: ["tools"] }];
  const capabilities = [
    {
      id: "claude",
      acceptsArbitraryModelIds: true,
      arbitraryModelSupport: "via-shim" as const,
      idForm: "source-prefixed" as const,
      depthFusedIntoId: false,
    },
  ];
  const staleRow = buildCatalogue(rows, META, {
    entitlement: { ...known(), stale: true },
    nativeModels: [],
    capabilities,
  }).models[0];
  assert.match(staleRow?.availability.claude?.message ?? "", /out-of-date cache/);
  const freshRow = buildCatalogue(rows, META, {
    entitlement: known(),
    nativeModels: [],
    capabilities,
  }).models[0];
  assert.equal((freshRow?.availability.claude?.message ?? "").includes("out-of-date cache"), false);
});

test("entitlementModelSlugs drops a dated id whose undated form is also allowed", () => {
  // `models/user` answers with both forms per model, so a bare enumeration would
  // offer an agent two spellings of two models as four choices — and a refusal that
  // lists four ids for two models reads as a wider set than the key really has.
  assert.deepEqual(entitlementModelSlugs(known()), [...KEY_ALLOWS_SLUGS]);
  // NEGATIVE CONTROL: a dated id with NO undated sibling is kept, or the filter
  // would be silently dropping models the key does allow.
  assert.deepEqual(entitlementModelSlugs(known(["openai/gpt-5-pro-20260101"])), [
    "openai/gpt-5-pro-20260101",
  ]);
  assert.deepEqual(entitlementModelSlugs(ENTITLEMENT_UNKNOWN), []);
});

// ── The READ path ────────────────────────────────────────────────────────────

test("the READ path narrows: a row the key does not allow is unavailable for claude and pi", () => {
  const snapshot = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
  const catalogue = buildCatalogue(snapshot.models, META, { entitlement: known() });
  const openRouterRows = catalogue.models.filter((model) => model.source === "openrouter");
  assert.ok(openRouterRows.length > 50, "the fixture must actually carry OpenRouter rows");

  let allowedSeen = 0;
  let refusedSeen = 0;
  for (const model of openRouterRows) {
    if (model.unavailableReasons.length > 0) {
      continue; // already blocked for an unrelated reason — not this branch's subject
    }
    const allowed = (KEY_ALLOWS as readonly string[]).includes(
      model.id.replace(/^~/, "").toLowerCase(),
    );
    for (const agent of ["claude", "pi"] as const) {
      const availability = model.availability[agent];
      if (availability === undefined) {
        continue;
      }
      if (allowed) {
        allowedSeen += 1;
        assert.equal(availability.ok, true, `${model.id} is allowed and must be offered`);
      } else if (availability.reason === OPENROUTER_NOT_ENTITLED_REASON) {
        refusedSeen += 1;
        assert.equal(availability.ok, false);
      }
    }
  }
  // BOTH counts must be non-zero, or the loop proves nothing: all-refused would pass
  // a one-sided check, and so would all-offered.
  assert.ok(allowedSeen > 0, "no allowed row was offered — the fixture or the join is wrong");
  assert.ok(refusedSeen > 0, "no row was refused — the read-path narrowing is not firing");

  // 🛑 AND THE FAIL-OPEN CONTROL, ON THE SAME FIXTURE: with an UNKNOWN set nothing is
  // marked for this reason, so the catalogue is exactly as wide as it is today.
  const open = buildCatalogue(snapshot.models, META, { entitlement: ENTITLEMENT_UNKNOWN });
  assert.equal(
    open.models.some((model) =>
      Object.values(model.availability).some(
        (availability) => availability.reason === OPENROUTER_NOT_ENTITLED_REASON,
      ),
    ),
    false,
    "an unknown set must narrow NOTHING",
  );
});

test("the READ path leaves codex's own message alone, and Claude-family keeps its own reason", () => {
  const snapshot = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
  const catalogue = buildCatalogue(snapshot.models, META, { entitlement: known() });

  const claudeRow = catalogue.models.find(
    (model) => model.source === "openrouter" && model.id.startsWith("anthropic/claude"),
  );
  assert.ok(claudeRow, "the fixture must carry an anthropic/claude row");
  // The Claude branch sits ABOVE the key's-set branch, so a Claude row keeps the
  // specialised reason rather than the generic one.
  assert.equal(claudeRow.availability.claude?.reason, CLAUDE_FAMILY_OPENROUTER_REASON);
  assert.notEqual(claudeRow.availability.claude?.reason, OPENROUTER_NOT_ENTITLED_REASON);

  // Codex cannot reach OpenRouter at all, and that is the more informative answer —
  // the key's-set branch sits after the arbitrary-ids arm so this stays true.
  const anyRow = catalogue.models.find((model) => model.source === "openrouter");
  assert.ok(anyRow);
  assert.notEqual(anyRow.availability.codex?.reason, OPENROUTER_NOT_ENTITLED_REASON);
  assert.equal(anyRow.availability.codex?.ok, false);
});

test("`acpx models list --agent` DROPS a disallowed row, and `--all` keeps it WITH the reason", async () => {
  // The user-visible consequence of the read path — and this brick's acceptance
  // criterion — asserted through the same band mechanism the CLI renders from:
  // absent by default, present and explained under `--all`.
  const { bandModels } = await import("../src/models/matcher.js");
  const snapshot = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
  const catalogue = buildCatalogue(snapshot.models, META, { entitlement: known() });

  const disallowed = catalogue.models.find(
    (model) => model.availability.claude?.reason === OPENROUTER_NOT_ENTITLED_REASON,
  );
  assert.ok(disallowed, "the fixture must produce at least one disallowed row");

  const listed = (includeUnavailable: boolean) =>
    bandModels(catalogue.models, { agentType: "claude", includeUnavailable }).flatMap(
      (band) => band.models,
    );

  assert.equal(
    listed(false).some((model) => model.key === disallowed.key),
    false,
    "a disallowed row must be ABSENT from the default listing",
  );
  const all = listed(true);
  assert.ok(
    all.some((model) => model.key === disallowed.key),
    "`--all` must still list it — a silently vanished row is the failure Tier 3 prevents",
  );
  assert.equal(disallowed.availability.claude?.ok, false);
  assert.match(disallowed.availability.claude?.message ?? "", /does not allow this model/);

  // 🛑 THE POSITIVE CONTROL THIS BRICK'S ACCEPTANCE TURNS ON: the allowed rows are
  // PRESENT in the default listing. Without it, a build that narrowed the catalogue
  // to NOTHING would pass every assertion above.
  const defaultListing = listed(false);
  for (const slug of KEY_ALLOWS_SLUGS) {
    const row = catalogue.models.find(
      (model) => model.source === "openrouter" && model.id === slug,
    );
    if (row === undefined) {
      continue; // not in this fixture — the loop below asserts at least one was
    }
    assert.ok(
      defaultListing.some((model) => model.key === row.key),
      `${slug} is allowed by the key and must be OFFERED by default`,
    );
  }
  assert.ok(
    defaultListing.some((model) => model.source === "openrouter"),
    "the default listing must still offer SOME OpenRouter row — narrowing to nothing is a failure",
  );
  // …and the non-OpenRouter rows are untouched by any of this.
  assert.ok(
    defaultListing.some((model) => model.source !== "openrouter"),
    "native rows (opus/sonnet/codex) must be unaffected by the OpenRouter allowlist",
  );
});

test("Tier 1 REFUSES on the key's set too — the read path is not declaration-only", async () => {
  // 🛑 THE TEST BEHIND A COMMENT THAT ASSERTS A GUARANTEE (`catalogue.ts`). The
  // Claude-family Tier 3 branch IS declaration-only; this one is not, and the
  // difference is easy to state wrongly and impossible to notice: `availability` is
  // also read by `assertModelAvailable` inside `validateModelSelection`, which
  // THROWS. So a row this branch marks unavailable is refused by the `--model` gate,
  // one tier ABOVE `assertModelPolicy`.
  const { ModelSlugError, validateModelSelection } =
    await import("../src/models/model-slug-validation.js");
  const rows = [
    { id: "z-ai/glm-5.3-flash", name: "allowed", supported_parameters: ["tools"] },
    { id: "zzz-vendor/not-allowed-1", name: "outsider", supported_parameters: ["tools"] },
  ];
  const catalogue = buildCatalogue(rows, META, { entitlement: known() });

  // THE NEGATIVE: the disallowed row is refused at Tier 1, by the catalogue's reason.
  let thrown: unknown;
  try {
    validateModelSelection(catalogue, { model: "zzz-vendor/not-allowed-1", agentName: "claude" });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ModelSlugError, "Tier 1 must refuse a disallowed row");
  assert.equal(thrown.detailCode, "MODEL_NOT_AVAILABLE_FOR_AGENT");
  // The wording must still name the set, or the refusal relocates the puzzle.
  assert.match(thrown.message, /does not allow this model/);
  for (const slug of KEY_ALLOWS_SLUGS) {
    assert.ok(thrown.message.includes(slug), `Tier 1's refusal must name ${slug}`);
  }
  // …and never the model it is refusing.
  assert.equal(
    thrown.message.slice(thrown.message.indexOf("enumerated set")).includes("not-allowed-1"),
    false,
  );

  // POSITIVE CONTROL on the same call shape: the ALLOWED row resolves. Without it
  // this row would pass on a Tier 1 that refuses every OpenRouter id.
  const resolved = validateModelSelection(catalogue, {
    model: "z-ai/glm-5.3-flash",
    agentName: "claude",
  });
  assert.equal(resolved?.id, "z-ai/glm-5.3-flash");
  assert.equal(resolved?.source, "openrouter");

  // FAIL-OPEN CONTROL: with an unknown set, Tier 1 resolves the outsider too.
  const open = buildCatalogue(rows, META, { entitlement: ENTITLEMENT_UNKNOWN });
  assert.equal(
    validateModelSelection(open, { model: "zzz-vendor/not-allowed-1", agentName: "claude" })?.id,
    "zzz-vendor/not-allowed-1",
  );
});

test("the policy reason token is IDENTICAL at both tiers, and machine-readable", async () => {
  // 🛑 WHY A TOKEN AND NOT `detailCode`. One policy is enforced at two tiers whose
  // detail codes necessarily DIFFER — Tier 1 is the generic availability gate
  // (`MODEL_NOT_AVAILABLE_FOR_AGENT`), the spawn guard is specific
  // (`OPENROUTER_MODEL_NOT_ENTITLED`). So "was this refused for the key's set?" was
  // answerable only by matching the message — and the message is tuned for an agent
  // to READ and is expected to change, so a caller coupled to it breaks on a reword.
  const { ModelSlugError, validateModelSelection } =
    await import("../src/models/model-slug-validation.js");
  const rows = [
    { id: "z-ai/glm-5.3-flash", name: "allowed", supported_parameters: ["tools"] },
    { id: "zzz-vendor/not-allowed-2", name: "outsider", supported_parameters: ["tools"] },
  ];
  const catalogue = buildCatalogue(rows, META, { entitlement: known() });

  let tier1: unknown;
  try {
    validateModelSelection(catalogue, { model: "zzz-vendor/not-allowed-2", agentName: "claude" });
  } catch (error) {
    tier1 = error;
  }
  assert.ok(tier1 instanceof ModelSlugError);
  assert.equal(tier1.policyReason, OPENROUTER_NOT_ENTITLED_REASON);
  assert.equal(tier1.detailCode, "MODEL_NOT_AVAILABLE_FOR_AGENT");

  const p0 = captureThrow(() =>
    assertModelPolicy(REAL_CLAUDE_COMMAND, "zzz-vendor/not-allowed-2", { entitlement: known() }),
  );
  assert.ok(p0 instanceof OpenRouterModelNotEntitledError);
  assert.equal(p0.policyReason, OPENROUTER_NOT_ENTITLED_REASON);
  assert.equal(p0.detailCode, "OPENROUTER_MODEL_NOT_ENTITLED");

  // THE PROPERTY: the tokens AGREE while the detail codes DIFFER. Both halves are
  // asserted, because "they agree" is vacuous if the codes happened to agree too.
  assert.equal(tier1.policyReason, p0.policyReason);
  assert.notEqual(tier1.detailCode, p0.detailCode);
  // …and it is the SAME token the read path publishes, so all three surfaces agree.
  const row = catalogue.models.find((model) => model.id === "zzz-vendor/not-allowed-2");
  assert.equal(row?.availability.claude?.reason, tier1.policyReason);

  // The Claude-family refusal carries its own policy token by the same mechanism.
  const claude = captureThrow(() =>
    assertModelPolicy(REAL_CLAUDE_COMMAND, "anthropic/claude-sonnet-5", { entitlement: known() }),
  );
  assert.ok(claude instanceof ClaudeFamilyOnOpenRouterError);
  assert.equal(claude.policyReason, CLAUDE_FAMILY_OPENROUTER_REASON);
  // NEGATIVE: the two policies must be DISTINGUISHABLE by the token, or it answers
  // "some policy refused" rather than "which one".
  assert.notEqual(claude.policyReason, OPENROUTER_NOT_ENTITLED_REASON);
});

test("policyReason reaches the SERIALIZED output, not just the thrown error", async () => {
  // 🛑 THE ASSERTION THAT WOULD HAVE CAUGHT THE MISS, AND WHY IT IS ON BYTES. The
  // token was once correct on the thrown error and DROPPED AT SERIALIZATION —
  // `BuildJsonRpcErrorParams` had no such field — so ZERO bytes of output carried it
  // while every in-process check passed. For a real consumer (an agent reading
  // `--format json`, acpx-ui, any tool) the only discriminator was `detailCode`,
  // which DIFFERS BY TIER: exactly the problem the token was added to solve.
  // **A discriminator that never crosses the process boundary does not exist.**
  const { normalizeOutputError } = await import("../src/acp/error-normalization.js");
  const { buildJsonRpcErrorResponse } = await import("../src/acp/jsonrpc-error.js");
  const { ModelSlugError, validateModelSelection } =
    await import("../src/models/model-slug-validation.js");

  const onTheWire = (error: unknown) => {
    const normalized = normalizeOutputError(error, { origin: "cli" });
    const response = buildJsonRpcErrorResponse({
      outputCode: normalized.code,
      detailCode: normalized.detailCode,
      origin: normalized.origin,
      message: normalized.message,
      policyReason: normalized.policyReason,
    });
    // Round-trip through JSON: the bytes are the subject, not the object.
    return JSON.parse(JSON.stringify(response)) as {
      error: { data?: { policyReason?: string; detailCode?: string } };
    };
  };

  const p0 = captureThrow(() =>
    assertModelPolicy(REAL_CLAUDE_COMMAND, "zzz-vendor/not-allowed-3", { entitlement: known() }),
  );
  const p0Wire = onTheWire(p0);
  assert.equal(p0Wire.error.data?.policyReason, OPENROUTER_NOT_ENTITLED_REASON);
  assert.equal(p0Wire.error.data?.detailCode, "OPENROUTER_MODEL_NOT_ENTITLED");

  const rows = [{ id: "zzz-vendor/not-allowed-3", supported_parameters: ["tools"] }];
  const catalogue = buildCatalogue(rows, META, { entitlement: known() });
  let tier1: unknown;
  try {
    validateModelSelection(catalogue, { model: "zzz-vendor/not-allowed-3", agentName: "claude" });
  } catch (error) {
    tier1 = error;
  }
  assert.ok(tier1 instanceof ModelSlugError);
  const tier1Wire = onTheWire(tier1);
  assert.equal(tier1Wire.error.data?.policyReason, OPENROUTER_NOT_ENTITLED_REASON);
  assert.equal(tier1Wire.error.data?.detailCode, "MODEL_NOT_AVAILABLE_FOR_AGENT");

  // THE PROPERTY, on the wire: tokens AGREE where detail codes DIFFER.
  assert.equal(tier1Wire.error.data?.policyReason, p0Wire.error.data?.policyReason);
  assert.notEqual(tier1Wire.error.data?.detailCode, p0Wire.error.data?.detailCode);

  // NEGATIVE CONTROL: an error carrying NO policy token must not gain one, or the
  // assertions above would pass on a serializer that hardcoded the field.
  const plain = onTheWire(new ModelSlugError("[acpx] nope", "MODEL_SLUG_UNKNOWN"));
  assert.equal(plain.error.data?.policyReason, undefined);
  assert.equal(plain.error.data?.detailCode, "MODEL_SLUG_UNKNOWN");
});

// ── The wiring that can be dropped without anything else failing ─────────────

test("loadCatalogue FORWARDS the injected set to buildCatalogue", async () => {
  // 🛑 A REGRESSION THAT ALREADY HAPPENED ONCE, SILENTLY. `loadCatalogue` destructured
  // `now`/`capabilities`/`nativeModels` and swept everything else into its load
  // options — so `entitlement` was accepted, documented, and NEVER REACHED
  // `buildCatalogue`. Every test passing it was quietly measuring whatever this box's
  // own state happened to be. Nothing failed; the seam simply did not exist.
  const snapshot: OpenRouterSnapshot = {
    fetchedAt: META.fetchedAt,
    models: [
      { id: "z-ai/glm-5.3-flash", supported_parameters: ["tools"] },
      { id: "zzz-vendor/not-allowed-4", supported_parameters: ["tools"] },
    ],
  };
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-loadcat-"));
  // ⚠️ `capabilities` IS PINNED TOO. `buildCatalogue` otherwise reads the ambient
  // harness table, and an EMPTY table yields an empty `availability` map — which
  // makes this row's assertion fail with `undefined` and read as "the option is not
  // forwarded" rather than "the table was not there". Measured: green run alone,
  // red inside a multi-file run. The subject here is option forwarding, so every
  // other input is held.
  // 🛑 AND `cachePath` IS PINNED TO A TEMP FILE, WHICH IS THE TRAP THAT ACTUALLY BIT.
  // `loadOpenRouterCatalogue` only calls `fetchModels` when its cache is stale or
  // absent — so with the BOX's real `~/.acpx/models-cache.json` warm (anyone who has
  // run `acpx models` leaves it that way) the injected fetcher is never called, the
  // catalogue is the real 464 rows, and `zzz-vendor/not-allowed-4` simply is not in
  // it. The assertion then fails with `undefined` and reads as "the option is not
  // forwarded". Measured: this row passed before an `acpx models --refresh` on the
  // box and failed after it, with no code change in between.
  const catalogue = await loadCatalogue({
    cachePath: path.join(cacheDir, "models-cache.json"),
    refresh: true,
    fetchModels: () => Promise.resolve(snapshot),
    entitlement: known(),
    nativeModels: [],
    capabilities: [
      {
        id: "claude",
        acceptsArbitraryModelIds: true,
        arbitraryModelSupport: "via-shim",
        idForm: "source-prefixed",
        depthFusedIntoId: false,
      },
    ],
  });
  const outsider = catalogue.models.find((model) => model.id === "zzz-vendor/not-allowed-4");
  assert.equal(
    outsider?.availability.claude?.reason,
    OPENROUTER_NOT_ENTITLED_REASON,
    "the injected set must reach availabilityFor through loadCatalogue",
  );
  // POSITIVE CONTROL on the same call: the allowed row is offered, so the assertion
  // above is the injected set biting rather than everything being refused.
  assert.equal(
    catalogue.models.find((model) => model.id === "z-ai/glm-5.3-flash")?.availability.claude?.ok,
    true,
  );
  // …and the injected fetcher really was the source of these rows: exactly the two
  // above, not the box's 464. A catalogue of 464 here means the temp cache was
  // bypassed and the row is measuring the box.
  assert.equal(catalogue.models.length, 2);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test("the READ path says so when the key's set is UNKNOWN — and stays quiet when it is not", async () => {
  // 🛑 THE HALF OF DECISION 2 THAT WAS NOT BUILT. "Unknown permits everything AND
  // SAYS SO" was true at the spawn path (`formatEntitlementUnknown` on stderr) and
  // FALSE on the read path — which is the surface an agent actually queries. Under
  // fail-open every OpenRouter row reads available, so an unreadable key answer
  // produces a catalogue byte-indistinguishable from a key that genuinely allows
  // everything: `acpx models list` reported ~310 models as available, unhedged, on a
  // cold / corrupt / 401'd read, and `/api/models` gave the picker no field to
  // qualify it with.
  const { renderModelsListForTesting } = await import("../src/cli/models-command.js");
  const rows = [
    { id: "z-ai/glm-5.3-flash", supported_parameters: ["tools"] },
    { id: "zzz-vendor/not-allowed-5", supported_parameters: ["tools"] },
  ];
  const capabilities = [
    {
      id: "claude",
      acceptsArbitraryModelIds: true,
      arbitraryModelSupport: "via-shim" as const,
      idForm: "source-prefixed" as const,
      depthFusedIntoId: false,
    },
  ];
  const build = (entitlement: OpenRouterEntitlement) =>
    buildCatalogue(rows, META, { entitlement, nativeModels: [], capabilities });

  // ── THE MACHINE-READABLE HALF. `source` is what a consumer branches on; the
  // picker is a machine and must never parse prose.
  const unknownCat = build({ ...ENTITLEMENT_UNKNOWN, error: "connect ETIMEDOUT" });
  assert.equal(unknownCat.entitlement.source, "unknown");
  assert.equal(unknownCat.entitlement.stale, false);
  assert.match(unknownCat.entitlement.note ?? "", /could not read/);
  assert.match(unknownCat.entitlement.note ?? "", /connect ETIMEDOUT/, "it must carry WHY");
  // …and it must say the listing is NOT narrowed, which is the read-path fact.
  assert.match(unknownCat.entitlement.note ?? "", /nothing here is narrowed/);

  // 🛑 THE NEGATIVE, AND IT IS WHY THIS ROW CANNOT BE SATISFIED BY ALWAYS WARNING:
  // a known, fresh set reports `key` and carries NO note at all.
  const knownCat = build(known());
  assert.equal(knownCat.entitlement.source, "key");
  assert.equal(knownCat.entitlement.stale, false);
  assert.equal(knownCat.entitlement.note, null);

  // A stale-but-read set is a THIRD state, distinguishable from both.
  const staleCat = build({ ...known(), stale: true, error: "guard set" });
  assert.equal(staleCat.entitlement.source, "key", "stale is still the KEY's answer");
  assert.equal(staleCat.entitlement.stale, true);
  assert.match(staleCat.entitlement.note ?? "", /older than its TTL/);

  // ── THE HUMAN HALF, on the rendered CLI output — the bytes `acpx models list`
  // actually prints. Asserting only the field would leave the verb able to drop it.
  const unknownOut = renderModelsListForTesting(unknownCat, { agent: "claude" });
  assert.match(unknownOut, /KEY'S ALLOWED SET UNKNOWN/);
  assert.match(unknownOut, /NOT narrowed to it/);
  // The fail-open behaviour itself is UNCHANGED — both rows are still offered.
  assert.match(unknownOut, /zzz-vendor\/not-allowed-5/, "unknown must not start refusing rows");

  const knownOut = renderModelsListForTesting(knownCat, { agent: "claude" });
  assert.equal(
    knownOut.includes("KEY'S ALLOWED SET UNKNOWN"),
    false,
    "a healthy read must print NO caveat — a footer that always warns gets ignored",
  );
  assert.equal(knownOut.includes("allowed set STALE"), false);
  // POSITIVE CONTROL on the renderer itself: it did produce a real listing, so the
  // absence above is a quiet footer rather than an empty string.
  assert.match(knownOut, /z-ai\/glm-5.3-flash/);

  const staleOut = renderModelsListForTesting(staleCat, { agent: "claude" });
  assert.match(staleOut, /allowed set STALE/);
  assert.equal(staleOut.includes("KEY'S ALLOWED SET UNKNOWN"), false, "stale is not unknown");

  // ── And the descriptor is a pure function of the entitlement, so the three states
  // cannot drift between the field and the renderer.
  assert.deepEqual(describeCatalogueEntitlement(known()), {
    source: "key",
    stale: false,
    note: null,
  });
  assert.equal(describeCatalogueEntitlement(ENTITLEMENT_UNKNOWN).source, "unknown");
});

test("a cold entitlement cache triggers the warm even when the catalogue is fresh", () => {
  // 🛑 THE ONE STATE THAT MOST NEEDS WARMING IS THE ONE A CATALOGUE-ONLY CHECK MISSES:
  // a box that has run `acpx models` before this shipped has a FRESH catalogue cache
  // and NO entitlement cache. Asking only about the catalogue, nothing would ever
  // refresh the allowed set, `assertModelPolicy` would fail open forever, and no
  // instrument anywhere would report a problem.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-warm-"));
  try {
    const cachePath = path.join(dir, "models-cache.json");
    const entitlementCachePath = path.join(dir, "openrouter-entitlement.json");
    const now = Date.now();
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: new Date(now).toISOString(), models: [] }),
    );

    assert.equal(
      catalogueNeedsWarm({ cachePath, entitlementCachePath, now: () => now }),
      true,
      "a fresh catalogue beside a COLD entitlement cache must still warm",
    );

    // POSITIVE CONTROL: with BOTH fresh, nothing warms — so the assertion above is
    // the entitlement leg firing rather than a predicate that always says true.
    fs.writeFileSync(
      entitlementCachePath,
      JSON.stringify({ fetchedAt: new Date(now).toISOString(), keyFingerprint: "x", modelIds: [] }),
    );
    const claude = freshClaudeAdvert(dir);
    assert.equal(
      catalogueNeedsWarm({ cachePath, entitlementCachePath, ...claude, now: () => now }),
      false,
    );

    // …and the original leg still works: a STALE catalogue warms regardless.
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: new Date(now - 48 * 3600_000).toISOString(), models: [] }),
    );
    assert.equal(
      catalogueNeedsWarm({ cachePath, entitlementCachePath, ...claude, now: () => now }),
      true,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A FRESH Claude model-advertisement cache (brick ebfe4c3c) — the warm's THIRD
 * term. Pinned for the same reason the entitlement cache is: unpinned, it falls
 * back to the real `$HOME/.acpx/claude-advertisement.json`, and a "fresh ⇒ no
 * warm" row would measure whether THIS box happens to hold one.
 */
function freshClaudeAdvert(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): { claudeAdvertCachePath: string; runtimeInfoPath: string } {
  const claudeAdvertCachePath = path.join(dir, "claude-advertisement.json");
  const runtimeInfoPath = path.join(dir, "no-runtime-info.json");
  fs.writeFileSync(
    claudeAdvertCachePath,
    JSON.stringify({
      schema: CLAUDE_ADVERT_SCHEMA,
      key: currentClaudeAdvertKey({ env, runtimeInfoPath }),
      probedAt: new Date().toISOString(),
      source: "fixture",
      options: [{ value: "opus", name: "Opus", description: "Opus 9.1 · x" }],
      lastFailure: null,
    }),
  );
  return { claudeAdvertCachePath, runtimeInfoPath };
}
