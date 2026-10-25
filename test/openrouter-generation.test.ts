import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AcpClient } from "../src/acp/client.js";
import { attachAttribution, piGenerationId } from "../src/acp/openrouter-attribution.js";
import {
  fetchGeneration,
  parseGenerationBody,
  resetGenerationResolverState,
  resolveTurnProvider,
  RETRY_DELAYS_MS,
} from "../src/acp/openrouter-generation.js";
import {
  cloneSessionAcpxState,
  createSessionConversation,
  recordSessionUpdate,
} from "../src/session/conversation-model.js";
import { flushPendingSessionIndexUpdates } from "../src/session/persistence/index-update-queue.js";
import { readSessionIndex } from "../src/session/persistence/index.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import { removeTempHomeSync } from "./temp-home.js";

// Brick 77054e85 — PER-TURN PROVIDER ATTRIBUTION ON THE pi PATH.
//
// 🛑 THE MEASUREMENT THE WHOLE DESIGN TURNS ON, AND THE BRIEF HAD IT BACKWARDS.
// The brief said "on 429/5xx leave null and retry on the next turn". Measured
// 2026-09-11 against the live API with this box's key, three runs, polling from
// the instant the completion returned:
//
//   run 1:  404 at t+0.3s … 404 at t+9.9s,  200 at t+10.6s
//   run 2:  404 at t+0.3s … 404 at t+6.4s,  200 at t+8.4s
//   run 3:  404 for ~6s, then 200
//
// Never a 429. Never a 5xx. The generation record is minted ASYNCHRONOUSLY,
// seconds after the completion the caller already holds — so 404 is this API's
// "not yet", a single lookup at turn end ALWAYS misses, and a resolver that
// treats 404 as terminal records `null` on every turn while looking healthy.
// That is the defect these rows exist to keep out, and it is invisible to any
// test whose fake answers 200 on the first call.

const GEN_ID = "gen-1789154639-WVc4Zx1I9IYWppWCMlEP";

/** The wire shape, verbatim from the live probe — `data`-wrapped. */
function generationBody(providerName: string, nativeFinishReason: string | null): unknown {
  return {
    data: {
      created_at: "2026-09-11T19:23:59.332Z",
      model: "z-ai/glm-5.3-flash-20260826",
      provider_name: providerName,
      finish_reason: "length",
      native_finish_reason: nativeFinishReason,
      total_cost: 0.0000061,
      latency: 347,
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that replays a scripted sequence of responses and counts its calls. */
function scriptedFetch(steps: (() => Response | Promise<Response>)[]): {
  fetchImpl: typeof fetch;
  calls: () => number;
} {
  let call = 0;
  const fetchImpl = (async () => {
    const step = steps[Math.min(call, steps.length - 1)];
    call += 1;
    return await step();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => call };
}

/** A `providers.json` holding an OpenRouter key, in a throwaway home. */
function providersFile(home: string): string {
  const file = path.join(home, "providers.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      providers: { openrouter: { env: "OPENROUTER_API_KEY", apiKey: "sk-or-test-key" } },
    }),
    { mode: 0o600 },
  );
  return file;
}

function withHome<T>(prefix: string, body: (home: string) => T): T {
  const home = mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return body(home);
  } finally {
    removeTempHomeSync(home);
  }
}

/** The options every resolver row shares: no real network, no real waiting. */
function resolverOptions(home: string, fetchImpl: typeof fetch) {
  return {
    sessionId: "gen-1",
    responseId: GEN_ID,
    providersPath: providersFile(home),
    env: {} as NodeJS.ProcessEnv,
    fetchImpl,
    sleep: async () => {},
  };
}

test.beforeEach(() => {
  // The cache and the in-flight set are process-wide (a queue owner re-creates
  // its client across turns), so one row would otherwise condition the next.
  resetGenerationResolverState();
});

// --- the wire shape ---------------------------------------------------------

test("the body is `data`-wrapped — reading it flat, as the conception prints it, yields nothing", () => {
  // CONCEPTION 4c272cab MEASUREMENTS.md §5 prints the fields unwrapped. A reader
  // following that document literally gets `undefined` for every field and
  // records a permanent `null` — indistinguishable from the honest "not
  // recorded" this feature legitimately produces. This row pins which is real.
  assert.deepEqual(parseGenerationBody(generationBody("Parasail", "length")), {
    provider_name: "Parasail",
    native_finish_reason: "length",
  });
  assert.equal(
    parseGenerationBody({ provider_name: "Parasail", native_finish_reason: "length" }),
    undefined,
    "the unwrapped shape is NOT what the API returns — a parser that accepted it would be reading a document, not the wire",
  );
});

test("a provider name is passed through VERBATIM, display form and all", () => {
  // `"Z.AI"` is the display name; the routing policy stores the slug `z-ai`.
  // Normalising here would put a guess into the one field that exists to be
  // ground truth — and `"Z.AI".toLowerCase()` is `"z.ai"`, which is not the slug.
  assert.equal(parseGenerationBody(generationBody("Z.AI", null))?.provider_name, "Z.AI");
  assert.equal(parseGenerationBody(generationBody("Z.AI", null))?.native_finish_reason, null);
});

test("a body naming no provider is not an attribution", () => {
  assert.equal(parseGenerationBody({ data: {} }), undefined);
  assert.equal(parseGenerationBody({ data: { provider_name: "   " } }), undefined);
  assert.equal(parseGenerationBody(undefined), undefined);
});

// --- which failures are worth asking again about ----------------------------

test("🛑 404 is RETRYABLE — it is this API's `not minted yet`, not `no such generation`", async () => {
  const { fetchImpl } = scriptedFetch([() => jsonResponse(404, { error: "not found" })]);
  const outcome = await fetchGeneration(GEN_ID, "sk-or-test-key", fetchImpl);
  assert.equal(
    outcome.kind,
    "retry",
    "treating 404 as terminal records null on EVERY turn — the measured window is 8.4-10.6s",
  );
});

test("429, 5xx, 408 and a network throw are retryable; 401/403 are not", async () => {
  for (const status of [408, 429, 500, 502, 503]) {
    const { fetchImpl } = scriptedFetch([() => jsonResponse(status, {})]);
    assert.equal((await fetchGeneration(GEN_ID, "k", fetchImpl)).kind, "retry", `status ${status}`);
  }
  for (const status of [400, 401, 403]) {
    const { fetchImpl } = scriptedFetch([() => jsonResponse(status, {})]);
    assert.equal(
      (await fetchGeneration(GEN_ID, "k", fetchImpl)).kind,
      "giveUp",
      `status ${status}`,
    );
  }
  const { fetchImpl: throwing } = scriptedFetch([
    () => {
      throw new Error("ECONNRESET");
    },
  ]);
  assert.equal((await fetchGeneration(GEN_ID, "k", throwing)).kind, "retry");
});

test("a 200 that names no provider is an ANSWER, not an outage — it gives up", async () => {
  // Retrying it would spin against a record that will never say more.
  const { fetchImpl } = scriptedFetch([() => jsonResponse(200, { data: {} })]);
  assert.equal((await fetchGeneration(GEN_ID, "k", fetchImpl)).kind, "giveUp");
});

// --- the retry schedule -----------------------------------------------------

test("the resolver retries THROUGH the 404 window and resolves — the production shape", async () => {
  // Modelled on the measured run: 404 for the first several attempts, then 200.
  // ⚠️ THE CONTROL IS THE NEXT ROW. A fake that answers 200 first would pass
  // against a resolver with no retry at all, which is precisely the broken
  // implementation this brick replaces.
  await withHome("acpx-gen-retry-", async (home) => {
    const persisted: { provider_name: string | null; response_id: string }[] = [];
    const { fetchImpl, calls } = scriptedFetch([
      () => jsonResponse(404, {}),
      () => jsonResponse(404, {}),
      () => jsonResponse(404, {}),
      () => jsonResponse(200, generationBody("Parasail", "length")),
    ]);
    const result = await resolveTurnProvider({
      ...resolverOptions(home, fetchImpl),
      persist: async (_id, attribution) => {
        persisted.push(attribution);
      },
    });
    assert.deepEqual(result, { provider_name: "Parasail", native_finish_reason: "length" });
    assert.equal(calls(), 4, "three 404s then the answer");
    assert.deepEqual(persisted, [
      { provider_name: "Parasail", native_finish_reason: "length", response_id: GEN_ID },
    ]);
  });
});

test("CONTROL — a resolver that only ever sees 404 gives up and persists NOTHING", async () => {
  // `null` stays "not recorded": no guess, no preferred provider standing in.
  // The next turn stamps a fresh response_id and this runs again, so a give-up
  // costs one turn's attribution, never the session's.
  await withHome("acpx-gen-giveup-", async (home) => {
    const persisted: unknown[] = [];
    const { fetchImpl, calls } = scriptedFetch([() => jsonResponse(404, {})]);
    const result = await resolveTurnProvider({
      ...resolverOptions(home, fetchImpl),
      persist: async (_id, attribution) => {
        persisted.push(attribution);
      },
    });
    assert.equal(result, undefined);
    assert.deepEqual(persisted, [], "a give-up must not write a guess");
    assert.equal(
      calls(),
      RETRY_DELAYS_MS.length + 1,
      "the schedule is bounded — it must not spin forever against a generation that never appears",
    );
  });
});

test("a 401 stops at the FIRST attempt — a bad key is not a transient", async () => {
  await withHome("acpx-gen-401-", async (home) => {
    const { fetchImpl, calls } = scriptedFetch([() => jsonResponse(401, {})]);
    assert.equal(await resolveTurnProvider(resolverOptions(home, fetchImpl)), undefined);
    assert.equal(calls(), 1, "retrying a rejected credential burns requests and changes nothing");
  });
});

// --- caching and the in-flight guard ----------------------------------------

test("a resolved generation is answered from the cache — the next turn's retry is free", async () => {
  await withHome("acpx-gen-cache-", async (home) => {
    const { fetchImpl, calls } = scriptedFetch([
      () => jsonResponse(200, generationBody("Together", "stop")),
    ]);
    const options = { ...resolverOptions(home, fetchImpl), persist: async () => {} };
    await resolveTurnProvider(options);
    const again = await resolveTurnProvider(options);
    assert.deepEqual(again, { provider_name: "Together", native_finish_reason: "stop" });
    assert.equal(calls(), 1, "the second resolve must cost no request");
  });
});

test("one lookup in flight per SESSION — overlapping ids do not stack retry loops", async () => {
  // A turn with several assistant messages produces several ids; running a ~21 s
  // schedule for each would have one session holding a handful of overlapping
  // loops whose writes race onto one field.
  await withHome("acpx-gen-inflight-", async (home) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl, calls } = scriptedFetch([
      async () => {
        await gate;
        return jsonResponse(200, generationBody("BaseTen", "stop"));
      },
    ]);
    const base = { ...resolverOptions(home, fetchImpl), persist: async () => {} };
    const first = resolveTurnProvider(base);
    // ⚠️ RACED AGAINST A TIMER RATHER THAN AWAITED BARE, AND THAT IS THE
    // DIFFERENCE BETWEEN A RED AND A HANG. Without the guard the second call
    // blocks on the same gate as the first, which the line below only opens
    // afterwards — so a bare `await` deadlocks the whole suite instead of
    // failing it. Measured by removing the guard: the run stalled and reported
    // nothing. A guard whose absence produces a hang is untestable in practice.
    const second = await Promise.race([
      resolveTurnProvider({ ...base, responseId: `${GEN_ID}-2` }),
      new Promise((resolve) => setTimeout(() => resolve("BLOCKED"), 250)),
    ]);
    assert.equal(second, undefined, "the second id is dropped while a lookup is running");
    release?.();
    assert.deepEqual(await first, { provider_name: "BaseTen", native_finish_reason: "stop" });
    assert.equal(calls(), 1);
  });
});

test("a keyless box makes NO request, says so once, and leaves the record honest", async () => {
  await withHome("acpx-gen-keyless-", async (home) => {
    const notes: string[] = [];
    const { fetchImpl, calls } = scriptedFetch([
      () => jsonResponse(200, generationBody("Parasail", "stop")),
    ]);
    const options = {
      sessionId: "gen-keyless",
      responseId: GEN_ID,
      // An empty providers file and an empty env: no key from either source.
      providersPath: path.join(home, "absent-providers.json"),
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
      sleep: async () => {},
      persist: async () => {
        assert.fail("a keyless box must not persist an attribution");
      },
      warn: (message: string) => notes.push(message),
    };
    assert.equal(await resolveTurnProvider(options), undefined);
    assert.equal(calls(), 0, "no credential ⇒ no request at all");
    assert.equal(notes.length, 1);
    assert.match(notes[0], /no OpenRouter credential/);

    resetGenerationResolverState();
    await resolveTurnProvider({ ...options, sessionId: "gen-keyless-2" });
    assert.equal(
      notes.length,
      2,
      "the note is per-process, and the reset proves it is not per-call",
    );
  });
});

// --- the wire path into the record ------------------------------------------

test("piGenerationId reads the id off the pi block, and nothing else", () => {
  const update = {
    sessionUpdate: "usage_update",
    _meta: { piAcp: { message: { input: 10, output: 2, responseId: GEN_ID } } },
  };
  assert.equal(piGenerationId(update), GEN_ID);
  assert.equal(
    piGenerationId({ _meta: { piAcp: { message: { input: 10, provider: "openrouter" } } } }),
    undefined,
    "pi's provider ID is not a generation id — and it is the field a reader reaches for first",
  );
  assert.equal(piGenerationId({ _meta: { piAcp: { message: { responseId: "  " } } } }), undefined);
  assert.equal(piGenerationId({ sessionUpdate: "usage_update" }), undefined);
});

test("the CLIENT puts pi's id on the canonical `_meta.acpx.orAttribution` path", () => {
  // ⚠️ THE SEAM THE OTHER ROWS CANNOT SEE. `piGenerationId` is a reader and
  // `attachAttribution` is a writer; both can be perfect while the client wires
  // neither to the other, and that failure is silent in both directions — no
  // error, no type failure, just a record that never carries a provider on the
  // pi path. So this drives the client's own decoration and asserts what the
  // INGEST would read back, not what the client meant to write.
  const client = new AcpClient({
    agentCommand: "node ./test/mock-agent.js",
    cwd: process.cwd(),
    permissionMode: "approve-reads",
  });
  const update: Record<string, unknown> = {
    sessionUpdate: "usage_update",
    used: 1000,
    size: 200_000,
    _meta: { piAcp: { message: { input: 100, output: 10, responseId: GEN_ID } } },
  };
  (
    client as unknown as { decorateWithAttribution: (update: object) => void }
  ).decorateWithAttribution(update);

  const meta = update._meta as { acpx?: { orAttribution?: Record<string, unknown> } };
  assert.deepEqual(
    meta.acpx?.orAttribution,
    { provider_name: null, native_finish_reason: null, response_id: GEN_ID },
    "an id with both names null is the honest intermediate state — identified, not yet attributed",
  );

  // CONTROL: no id on the block ⇒ no attribution block at all, so the record
  // records "not recorded" rather than an empty shell that reads as observed.
  const bare: Record<string, unknown> = {
    sessionUpdate: "usage_update",
    _meta: { piAcp: { message: { input: 1, output: 1 } } },
  };
  (
    client as unknown as { decorateWithAttribution: (update: object) => void }
  ).decorateWithAttribution(bare);
  assert.equal((bare._meta as { acpx?: unknown }).acpx, undefined);
});

test("a pi usage update lands an UNRESOLVED breadcrumb: the id, both names null", () => {
  // ⚠️ THE INTERMEDIATE STATE IS A REQUIREMENT, NOT A GAP. The lookup takes ~10 s,
  // so between the turn and the answer the record must say "this turn is
  // identified, its provider is not yet known" — and that is exactly
  // `provider_name: null` with a `response_id`, never a placeholder name.
  const update: Record<string, unknown> = {
    sessionUpdate: "usage_update",
    used: 1000,
    size: 200_000,
    _meta: { piAcp: { message: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 } } },
  };
  attachAttribution(update, {
    provider_name: null,
    native_finish_reason: null,
    response_id: GEN_ID,
  });

  const acpx = recordSessionUpdate(
    createSessionConversation(),
    { current_model_id: "z-ai/glm-5.3-flash" },
    { sessionId: "s-pi-1", update } as unknown as Parameters<typeof recordSessionUpdate>[2],
  );
  assert.equal(acpx.last_turn_provider?.response_id, GEN_ID);
  assert.equal(acpx.last_turn_provider?.provider_name, null);
  assert.equal(acpx.cost_units?.at(-1)?.response_id, GEN_ID, "the unit is stamped with the id too");
  assert.equal(acpx.cost_units?.at(-1)?.provider_name, null);
  // The clone is the turn path's allowlist — the one that ate three fields.
  assert.equal(
    cloneSessionAcpxState(acpx)?.last_turn_provider?.response_id,
    GEN_ID,
    "a nested field dropped by the clone is present at `sessions new` and gone after one prompt",
  );
});

// --- the write-back, through the real record + index -------------------------

test("the resolved provider reaches the RECORD and the index entry mirrors it", async () => {
  // Driven through the real write path rather than asserted on a local
  // expression: the lookup finishes ~10 s after the turn, when no ACP event
  // handler is attached any more, so this writer IS the write path. The index
  // leg matters because acpx-ui's header reads its view from the entry.
  const { readPersistedLifecycle, writeSessionRecord } =
    await import("../src/session/persistence.js");
  const home = mkdtempSync(path.join(os.tmpdir(), "acpx-gen-write-"));
  const previous = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = home;
  try {
    const record = makeSessionRecord({
      acpxRecordId: "gen-write-1",
      acpSessionId: "acp-gen-write-1",
      agentCommand: "node /opt/pi-acp/dist/index.js",
      cwd: "/workspace/x",
    });
    record.acpx = {
      last_turn_provider: {
        provider_name: null,
        native_finish_reason: null,
        response_id: GEN_ID,
        at: "2026-09-11T19:23:59.000Z",
      },
    };
    await writeSessionRecord(record);

    const { fetchImpl } = scriptedFetch([
      () => jsonResponse(404, {}),
      () => jsonResponse(200, generationBody("Parasail", "length")),
    ]);
    const resolved = await resolveTurnProvider({
      sessionId: "gen-write-1",
      responseId: GEN_ID,
      providersPath: providersFile(home),
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
      sleep: async () => {},
    });
    assert.deepEqual(resolved, { provider_name: "Parasail", native_finish_reason: "length" });

    const after = await readPersistedLifecycle("gen-write-1");
    assert.equal(after?.acpx?.last_turn_provider?.provider_name, "Parasail");
    assert.equal(after?.acpx?.last_turn_provider?.native_finish_reason, "length");
    assert.equal(after?.acpx?.last_turn_provider?.response_id, GEN_ID, "the id is preserved");
    assert.notEqual(
      after?.acpx?.last_turn_provider?.at,
      "2026-09-11T19:23:59.000Z",
      "`at` is when the RECORD learned it, so it must advance when the answer arrives",
    );

    // ⚠️ THE INDEX LAGS BY UP TO 5 s AND THAT IS BY DESIGN, NOT A BUG HERE.
    // `updateSessionIndexForRecordWrite` coalesces SCALAR updates on a 5-second
    // throttle (the first write flushes immediately because membership is
    // unknown; this second one is deferred to a trailing timer). In production
    // that timer fires and the entry catches up well inside the acceptance
    // window; in a test the process would exit first, so drive the flush.
    await flushPendingSessionIndexUpdates();
    const index = await readSessionIndex(path.join(home, ".acpx", "sessions"));
    const entry = index?.entries.find((row) => row.acpxRecordId === "gen-write-1");
    assert.ok(entry, "the session must be in the index");
    assert.equal(entry.lastTurnProvider, "Parasail", "the acpx-ui projection must follow");
    assert.equal(entry.lastTurnNativeFinishReason, "length");
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previous;
    }
    removeTempHomeSync(home);
  }
});

test("a LATER turn's breadcrumb is not overwritten by an earlier turn's answer", async () => {
  // The lookup outlives its turn by ~10 s, so a fast follow-up turn can already
  // have stamped a new id by the time this answer arrives. Writing it then would
  // report a stale provider as the CURRENT turn's — the same un-falsifiability
  // the whole feature is shaped to avoid, arriving by a different door.
  const { readPersistedLifecycle, writeSessionRecord } =
    await import("../src/session/persistence.js");
  const home = mkdtempSync(path.join(os.tmpdir(), "acpx-gen-stale-"));
  const previous = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = home;
  try {
    const record = makeSessionRecord({
      acpxRecordId: "gen-stale-1",
      acpSessionId: "acp-gen-stale-1",
      agentCommand: "node /opt/pi-acp/dist/index.js",
      cwd: "/workspace/x",
    });
    record.acpx = {
      last_turn_provider: {
        provider_name: null,
        native_finish_reason: null,
        response_id: "gen-NEWER-TURN",
        at: "2026-09-11T19:30:00.000Z",
      },
    };
    await writeSessionRecord(record);

    const { fetchImpl } = scriptedFetch([
      () => jsonResponse(200, generationBody("Parasail", "length")),
    ]);
    await resolveTurnProvider({
      sessionId: "gen-stale-1",
      responseId: GEN_ID,
      providersPath: providersFile(home),
      env: {} as NodeJS.ProcessEnv,
      fetchImpl,
      sleep: async () => {},
    });

    const after = await readPersistedLifecycle("gen-stale-1");
    assert.equal(after?.acpx?.last_turn_provider?.response_id, "gen-NEWER-TURN");
    assert.equal(
      after?.acpx?.last_turn_provider?.provider_name,
      null,
      "an answer about an OLDER generation must not be written onto a newer turn's breadcrumb",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = previous;
    }
    removeTempHomeSync(home);
  }
});
