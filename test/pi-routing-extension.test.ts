import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import {
  type OpenRouterRoutingPolicy,
  resolveProviderObject,
  validateRoutingPolicy,
} from "../src/acp/openrouter-provider-policy.js";
import { resetPiKnowledgeMemo } from "../src/acp/pi-model-knowledge.js";
import {
  PI_ROUTING_EXTENSION_CODE,
  PI_ROUTING_EXTENSION_FILENAME,
} from "../src/config/pi-routing-extension-code.js";

// Brick 5fee840d — the acpx OpenRouter LIVE-ROUTING extension seeded into pi
// config dirs.
//
// The spawn-time projection (models.json compat, brick 4c272cab) is pinned in
// `pi-models-json-routing.test.ts`. What was missing — and what the prod
// incident measured (session 01a09cce: spawned 22:06:40Z with no policy on
// disk, order saved 22:09:00Z, 22:11:09Z turn served by Z.AI outside the
// order) — is the LIVE half: pi reads models.json once at process start, so a
// policy saved mid-session never reached a running session.
//
// The extension is a SECOND RESOLVER by necessity (it runs inside pi; there is
// no channel back to acpx), and a second resolver that can drift is the exact
// failure the policy module header warns about. So the parity rows below are
// the point of this file: the extension's mirrors must agree with acpx's own
// validator and resolver on a matrix of valid AND invalid policies, and the
// handler rows pin the fail-open contract end to end.

const MODEL = "z-ai/glm-5.3-flash";

// ── Fixture: load the extension the way pi would ────────────────────────────

type LoadedExtension = {
  default: (pi: { on: (name: string, handler: (event: unknown) => unknown) => void }) => void;
  testMirrors: {
    resolveProviderObject: (policy: unknown, slug: string | undefined) => unknown;
    policyIsValid: (policy: unknown) => boolean;
    expandQuantizationFloor: (floor: string, allowUnknown: boolean) => string[];
  };
};

let importCounter = 0;

/**
 * Write the template to disk and import it FRESH, with the settings path bound
 * to this fixture — read at module load, exactly as in a real seeded session.
 *
 * Scoping is LIVE per request (ctx.model.provider), so NO config-dir fixture is
 * needed — that is the brick-5fee840d fix: the first version scoped on a
 * config-dir id snapshot built at load, which was EMPTY for a first child
 * spawned before any policy/models-store existed and could never engage
 * mid-session (reproduced live; see the extension header).
 */
async function loadExtension(opts: { settingsFile: string }): Promise<LoadedExtension> {
  const dir = mkdtempSync(join(tmpdir(), "acpx-pi-routing-ext-"));
  const path = join(dir, `ext-${importCounter++}.mjs`);
  writeFileSync(path, PI_ROUTING_EXTENSION_CODE, "utf8");
  const previous = process.env.ACPX_UI_SETTINGS_FILE;
  process.env.ACPX_UI_SETTINGS_FILE = opts.settingsFile;
  try {
    return (await import(`${pathToFileURL(path).href}?v=${importCounter}`)) as LoadedExtension;
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_UI_SETTINGS_FILE;
    } else {
      process.env.ACPX_UI_SETTINGS_FILE = previous;
    }
  }
}

/** ctx stub the way pi passes it: the LIVE model of this request. */
type Ctx = { model: { provider: string; id: string; baseUrl: string } | undefined };

const OPENROUTER_CTX: Ctx = {
  model: { provider: "openrouter", id: MODEL, baseUrl: "https://openrouter.ai/api/v1" },
};
const NON_OPENROUTER_CTX: Ctx = {
  model: { provider: "anthropic", id: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com" },
};

type Handler = (event: { payload: Record<string, unknown> }, ctx: Ctx) => unknown;

async function handlerFor(ext: LoadedExtension): Promise<Handler> {
  const registered: Record<string, Handler> = {};
  ext.default({
    on: (name, handler) => {
      registered[name] = handler as Handler;
    },
  });
  const handler = registered["before_provider_request"];
  assert.ok(handler, "the extension must register before_provider_request");
  return handler;
}

// ── The parity matrix ────────────────────────────────────────────────────────

const VALID_POLICIES: OpenRouterRoutingPolicy[] = [
  {},
  { perModel: { [MODEL]: { order: ["coreweave", "baseten"] } } },
  { perModel: { [MODEL]: { order: ["baseten"], allowFallbacks: false } } },
  { ignore: ["wafer"] },
  { minQuantization: "fp8" },
  { minQuantization: "fp8", allowUnknownQuantization: false },
  { minQuantization: "bf16", ignore: ["wafer", "crusoe"], minThroughput: { p50: 60, p90: 120 } },
  {
    ignore: ["wafer"],
    minQuantization: "fp8",
    perModel: { [MODEL]: { order: ["modal"] } },
  },
  { perModel: { [`openrouter/${MODEL}`]: { order: ["friendli"] } } },
  { perModel: { "unrelated/model": { order: ["modal"] } } },
];

const INVALID_POLICIES: unknown[] = [
  "not-an-object",
  { unknownKey: 1 },
  { minQuantization: "int2ish" },
  { allowUnknownQuantization: "yes" },
  { minThroughput: { p50: -1 } },
  { minThroughput: { perHour: 60 } },
  { ignore: "wafer" },
  { ignore: ["Wafer"] },
  { ignore: ["wafer/fp8"] },
  { perModel: [] },
  { perModel: { [MODEL]: "order" } },
  { perModel: { [MODEL]: { order: "baseten" } } },
  { perModel: { [MODEL]: { order: ["BaseTen"] } } },
  { perModel: { [MODEL]: { allowFallbacks: "no" } } },
  { perModel: { [MODEL]: { bogus: 1 } } },
  { perModel: { " ": { order: ["baseten"] } } },
];

test("parity · the extension's validator agrees with acpx's on the whole matrix", async () => {
  const ext = await loadExtension({ settingsFile: noSettingsFile() });
  for (const policy of VALID_POLICIES) {
    assert.deepEqual(
      validateRoutingPolicy(policy),
      [],
      `acpx must accept ${JSON.stringify(policy)}`,
    );
    assert.equal(
      ext.testMirrors.policyIsValid(policy),
      true,
      `extension must accept ${JSON.stringify(policy)}`,
    );
  }
  for (const policy of INVALID_POLICIES) {
    assert.ok(
      validateRoutingPolicy(policy).length > 0,
      `acpx must REJECT ${JSON.stringify(policy)}`,
    );
    assert.equal(
      ext.testMirrors.policyIsValid(policy),
      false,
      `extension must reject ${JSON.stringify(policy)}`,
    );
  }
});

function noSettingsFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), "acpx-pi-routing-noset-")), "ui-settings.json");
  writeFileSync(file, JSON.stringify({ version: 1 }), "utf8");
  return file;
}

test("parity · the extension's resolver agrees with resolveProviderObject on every valid policy", async () => {
  const ext = await loadExtension({ settingsFile: noSettingsFile() });
  for (const policy of VALID_POLICIES) {
    for (const slug of [MODEL, `openrouter/${MODEL}`, "moonshotai/kimi-k2-thinking", undefined]) {
      assert.deepEqual(
        ext.testMirrors.resolveProviderObject(policy, slug),
        resolveProviderObject(policy, slug),
        `resolver drift for policy=${JSON.stringify(policy)} slug=${String(slug)}`,
      );
    }
  }
  // On the INVALID ones the resolver itself is not the gate — readPolicy is
  // (an invalid file yields null before resolveProviderObject is ever called,
  // pinned end to end by the handler row below).
});

test("parity · the quantization ladder expansion agrees rung by rung", async () => {
  const ext = await loadExtension({ settingsFile: noSettingsFile() });
  // acpx does not export expandQuantizationFloor's inputs as data; re-derive
  // the agreement through resolveProviderObject, which embeds the same ladder.
  for (const floor of ["fp4", "fp6", "fp8", "bf16", "fp32"]) {
    for (const allowUnknown of [true, false]) {
      const viaAcpx = resolveProviderObject(
        { minQuantization: floor, allowUnknownQuantization: allowUnknown },
        MODEL,
      )?.quantizations;
      assert.deepEqual(ext.testMirrors.expandQuantizationFloor(floor, allowUnknown), viaAcpx);
      if (allowUnknown) {
        assert.ok(viaAcpx?.includes("unknown"), "the unknown leg is the outage guard");
      }
    }
  }
});

// ── Handler behaviour ────────────────────────────────────────────────────────

test("handler · a policy saved mid-session reaches the NEXT request of a running session", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-live-"));
  const settingsFile = join(root, "ui-settings.json");
  // The policy did not exist when the session spawned…
  writeFileSync(settingsFile, JSON.stringify({ version: 1 }), "utf8");
  const ext = await loadExtension({ settingsFile });
  const handler = await handlerFor(ext);

  const payload: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  };
  assert.equal(handler({ payload }, OPENROUTER_CTX), undefined, "no policy ⇒ payload untouched");

  // …the order is saved while the session is running…
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      openrouterRouting: { perModel: { [MODEL]: { order: ["coreweave", "baseten"] } } },
    }),
    "utf8",
  );
  utimesSync(settingsFile, new Date(), new Date());

  // …and the next request carries it — byte-for-byte what acpx would resolve.
  const routed = handler({ payload }, OPENROUTER_CTX) as Record<string, unknown>;
  assert.deepEqual(
    routed?.provider,
    resolveProviderObject({ perModel: { [MODEL]: { order: ["coreweave", "baseten"] } } }, MODEL),
  );

  rmSync(root, { recursive: true, force: true });
});

test("handler · a CLEARED policy stops steering the running session", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-clear-"));
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      openrouterRouting: { perModel: { [MODEL]: { order: ["baseten"] } } },
    }),
    "utf8",
  );
  const ext = await loadExtension({ settingsFile });
  const handler = await handlerFor(ext);
  const payload: Record<string, unknown> = {
    model: MODEL,
    provider: { order: ["baseten"], allow_fallbacks: true },
  };
  const routed = handler({ payload }, OPENROUTER_CTX) as Record<string, unknown>;
  assert.ok(routed?.provider, "policy in force ⇒ provider set");
  assert.deepEqual(
    routed?.provider,
    resolveProviderObject({ perModel: { [MODEL]: { order: ["baseten"] } } }, MODEL),
  );

  writeFileSync(settingsFile, JSON.stringify({ version: 1 }), "utf8");
  utimesSync(settingsFile, new Date(), new Date());
  const cleared = handler({ payload }, OPENROUTER_CTX) as Record<string, unknown>;
  assert.equal(
    "provider" in (cleared ?? {}),
    false,
    "a cleared policy must strip the stale provider block",
  );

  rmSync(root, { recursive: true, force: true });
});

test("handler · a policy that becomes INVALID is dropped WHOLE, never partially applied", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-invalid-"));
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      openrouterRouting: { perModel: { [MODEL]: { order: ["baseten"] } } },
    }),
    "utf8",
  );
  const ext = await loadExtension({ settingsFile });
  const handler = await handlerFor(ext);
  const payload: Record<string, unknown> = { model: MODEL, provider: { order: ["baseten"] } };

  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      openrouterRouting: { perModel: { [MODEL]: { order: ["BaseTen"] } } },
    }),
    "utf8",
  );
  utimesSync(settingsFile, new Date(), new Date());
  const routed = handler({ payload }, OPENROUTER_CTX) as Record<string, unknown>;
  assert.equal("provider" in (routed ?? {}), false, "invalid policy ⇒ no routing in force");

  rmSync(root, { recursive: true, force: true });
});

test("handler · an UNREADABLE settings file leaves the payload untouched (fail-open)", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-gone-"));
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({ version: 1, openrouterRouting: { ignore: ["wafer"] } }),
    "utf8",
  );
  const ext = await loadExtension({ settingsFile });
  const handler = await handlerFor(ext);
  const payload: Record<string, unknown> = {
    model: MODEL,
    provider: { ignore: ["wafer"], allow_fallbacks: true },
  };
  rmSync(settingsFile);
  assert.equal(
    handler({ payload }, OPENROUTER_CTX),
    undefined,
    "unreadable file ⇒ no opinion, spawn-time routing stands",
  );

  rmSync(root, { recursive: true, force: true });
});

test("handler · non-openrouter models are never touched, box-wide policy or not", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-scope-"));
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      openrouterRouting: { ignore: ["wafer"], perModel: { [MODEL]: { order: ["baseten"] } } },
    }),
    "utf8",
  );
  const ext = await loadExtension({ settingsFile });
  const handler = await handlerFor(ext);
  // Scoping is the request's LIVE model provider: an anthropic-model request
  // (Anthropic-shaped bodies 400 on unknown top-level fields) must never carry
  // OpenRouter routing, whatever the policy says.
  assert.equal(
    handler({ payload: { model: "claude-sonnet-4-5", max_tokens: 1024 } }, NON_OPENROUTER_CTX),
    undefined,
  );
  // And a missing/undefined model (never expected from pi) is a no-op too.
  assert.equal(handler({ payload: { model: MODEL } }, { model: undefined }), undefined);

  rmSync(root, { recursive: true, force: true });
});

test("handler · the FIRST-CHILD anomaly regression: engagement does NOT depend on a spawn-time snapshot — brick 5fee840d", async () => {
  // The defect this row pins: the first version scoped on an id set built ONCE
  // at module load from the config dir's models-store.json + models.json. For
  // the first pi child of a session spawned BEFORE the policy existed, acpx
  // writes NEITHER file (pi knows the slug from its bundled catalogue so no
  // entry is fabricated; the box cache can be empty), the set was empty, and a
  // policy saved mid-session never engaged for that child's lifetime —
  // reproduced live (turn 2 succeeded where an engaged extension would have
  // forced an OpenRouter 404). The fix scopes on ctx.model.provider, so the
  // config-dir state at load is IRRELEVANT — asserted here with an EMPTY
  // config dir.
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-firstchild-"));
  const emptyConfigDir = join(root, "cfg-empty");
  mkdirSync(emptyConfigDir, { recursive: true }); // no models-store.json, no models.json content
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      openrouterRouting: {
        perModel: {
          [MODEL]: { order: ["definitely-not-a-real-provider-xyz"], allowFallbacks: false },
        },
      },
    }),
    "utf8",
  );
  const ext = await loadExtension({ settingsFile });
  const handler = await handlerFor(ext);
  const routed = handler(
    { payload: { model: MODEL, messages: [], stream: true } },
    OPENROUTER_CTX,
  ) as Record<string, unknown>;
  assert.deepEqual(
    routed?.provider,
    resolveProviderObject(
      {
        perModel: {
          [MODEL]: { order: ["definitely-not-a-real-provider-xyz"], allowFallbacks: false },
        },
      },
      MODEL,
    ),
    "a first child with NO spawn-time catalogue files must still engage once the policy is saved",
  );

  rmSync(root, { recursive: true, force: true });
});

// ── Sticky session affinity (brick c2df657e) ────────────────────────────────

// The extension reads the record id PER REQUEST, so the fixture toggles
// process.env around each handler call — no re-import needed.
function withStickyEnv(value: string | undefined, run: () => void): void {
  const previous = process.env.ACPX_SESSION_RECORD_ID;
  if (value === undefined) {
    delete process.env.ACPX_SESSION_RECORD_ID;
  } else {
    process.env.ACPX_SESSION_RECORD_ID = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_SESSION_RECORD_ID;
    } else {
      process.env.ACPX_SESSION_RECORD_ID = previous;
    }
  }
}

const RECORD_ID = "11111111-2222-3333-4444-555555555555";

test("sticky · an openrouter request carries the acpx record id as a TOP-LEVEL session_id", async () => {
  const handler = await handlerFor(await loadExtension({ settingsFile: noSettingsFile() }));
  const payload: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  };
  withStickyEnv(RECORD_ID, () => {
    const routed = handler({ payload }, OPENROUTER_CTX) as Record<string, unknown>;
    assert.ok(routed, "a set record id ⇒ the handler has an opinion, even with no policy");
    assert.equal(routed.session_id, RECORD_ID);
    // Top-level, NOT inside provider — OpenRouter validates the provider object
    // strictly and would 400 on an unknown field there.
    assert.equal("provider" in routed, false);
    assert.equal(routed.model, MODEL, "everything else rides unchanged");
  });
});

test("sticky · no record id in the env ⇒ no opinion (payload untouched)", async () => {
  const handler = await handlerFor(await loadExtension({ settingsFile: noSettingsFile() }));
  withStickyEnv(undefined, () => {
    assert.equal(
      handler({ payload: { model: MODEL, messages: [] } }, OPENROUTER_CTX),
      undefined,
      "a creation spawn / non-acpx pi run has no key to send — today's behaviour",
    );
  });
});

test("sticky · a differing pre-existing session_id is overridden with the record id", async () => {
  const handler = await handlerFor(await loadExtension({ settingsFile: noSettingsFile() }));
  const payload: Record<string, unknown> = {
    model: MODEL,
    session_id: "someone-elses-key",
  };
  withStickyEnv(RECORD_ID, () => {
    const routed = handler({ payload }, OPENROUTER_CTX) as Record<string, unknown>;
    assert.equal(
      routed.session_id,
      RECORD_ID,
      "the record id is THE stable key — a per-spawn or per-branch id must not ride",
    );
  });
});

test("sticky · non-openrouter models never carry it, record id or not", async () => {
  const handler = await handlerFor(await loadExtension({ settingsFile: noSettingsFile() }));
  withStickyEnv(RECORD_ID, () => {
    assert.equal(
      handler({ payload: { model: "claude-sonnet-4-5", max_tokens: 1024 } }, NON_OPENROUTER_CTX),
      undefined,
      "an Anthropic-shaped body 400s on unknown top-level fields — never touch it",
    );
  });
});

test("sticky · composes with a routing policy — session_id AND provider both land", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-sticky-policy-"));
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      openrouterRouting: { perModel: { [MODEL]: { order: ["baseten"], allowFallbacks: false } } },
    }),
    "utf8",
  );
  const handler = await handlerFor(await loadExtension({ settingsFile }));
  const payload: Record<string, unknown> = { model: MODEL, messages: [], stream: true };
  withStickyEnv(RECORD_ID, () => {
    const routed = handler({ payload }, OPENROUTER_CTX) as Record<string, unknown>;
    assert.equal(routed.session_id, RECORD_ID);
    assert.deepEqual(
      routed.provider,
      resolveProviderObject(
        { perModel: { [MODEL]: { order: ["baseten"], allowFallbacks: false } } },
        MODEL,
      ),
    );
  });
  rmSync(root, { recursive: true, force: true });
});

test("sticky · an UNREADABLE settings file still carries the sticky key (affinity is not policy-conditional)", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-sticky-gone-"));
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(settingsFile, JSON.stringify({ version: 1 }), "utf8");
  const handler = await handlerFor(await loadExtension({ settingsFile }));
  rmSync(settingsFile);
  const payload: Record<string, unknown> = { model: MODEL, messages: [] };
  withStickyEnv(RECORD_ID, () => {
    const routed = handler({ payload }, OPENROUTER_CTX) as Record<string, unknown>;
    assert.ok(routed, "unreadable file ⇒ no opinion on ROUTING, but the key must ride");
    assert.equal(routed.session_id, RECORD_ID);
  });
  rmSync(root, { recursive: true, force: true });
});

test("sticky · a CLEARED policy strips the stale provider but keeps the sticky key", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-sticky-clear-"));
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      openrouterRouting: { perModel: { [MODEL]: { order: ["baseten"] } } },
    }),
    "utf8",
  );
  const handler = await handlerFor(await loadExtension({ settingsFile }));
  const payload: Record<string, unknown> = {
    model: MODEL,
    provider: { order: ["baseten"], allow_fallbacks: true },
  };
  writeFileSync(settingsFile, JSON.stringify({ version: 1 }), "utf8");
  utimesSync(settingsFile, new Date(), new Date());
  withStickyEnv(RECORD_ID, () => {
    const routed = handler({ payload }, OPENROUTER_CTX) as Record<string, unknown>;
    assert.equal("provider" in (routed ?? {}), false, "cleared policy ⇒ no provider block");
    assert.equal(routed?.session_id, RECORD_ID, "but affinity holds");
  });
  rmSync(root, { recursive: true, force: true });
});

test("sticky · an overlong record id is clamped to OpenRouter's 256-char bound", async () => {
  const handler = await handlerFor(await loadExtension({ settingsFile: noSettingsFile() }));
  const oversized = `x`.repeat(400);
  const payload: Record<string, unknown> = { model: MODEL, messages: [] };
  withStickyEnv(oversized, () => {
    const routed = handler({ payload }, OPENROUTER_CTX) as Record<string, unknown>;
    assert.equal((routed.session_id as string).length, 256);
  });
});

// ── The seed itself ──────────────────────────────────────────────────────────

function configDirFixture(envHome: string): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-seed-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".acpx"), { recursive: true });
  writeFileSync(
    join(root, "pi-knowledge.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), ids: [] }),
  );
  writeFileSync(
    join(root, "models-cache.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), models: [] }),
  );
  resetPiKnowledgeMemo();
  return {
    root,
    env: {
      HOME: envHome || home,
      ACPX_PI_KNOWLEDGE_CACHE: join(root, "pi-knowledge.json"),
      ACPX_MODELS_CACHE: join(root, "models-cache.json"),
      ACPX_PI_BOX_AGENT_DIR: join(root, "box-agent"),
      PATH: "/nonexistent-so-a-spawn-cannot-silently-succeed",
    },
  };
}

test("seed · every pi config dir carries the live-routing extension, byte-identical to the template", () => {
  const fx = configDirFixture("");
  try {
    const plan = applyHarnessConfigDir({
      env: fx.env,
      agentCommand: "node /opt/pi-acp/dist/index.js",
      sessionId: `seed-${Math.random().toString(36).slice(2)}`,
      rootDir: join(fx.root, "cfg"),
    });
    assert.ok(plan, "pi must produce a plan");
    const seeded = plan.piExtensions?.find((entry) =>
      entry.target.endsWith(PI_ROUTING_EXTENSION_FILENAME),
    );
    assert.ok(seeded, "the builtin must be reported in the seeded list");
    const path = join(plan.dir, "extensions", PI_ROUTING_EXTENSION_FILENAME);
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path, "utf8"), PI_ROUTING_EXTENSION_CODE);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("seed · ACPX_PI_EXTENSIONS_SEED=off disables the builtin too (one switch, one meaning)", () => {
  const fx = configDirFixture("");
  fx.env.ACPX_PI_EXTENSIONS_SEED = "off";
  try {
    const plan = applyHarnessConfigDir({
      env: fx.env,
      agentCommand: "node /opt/pi-acp/dist/index.js",
      sessionId: `seedoff-${Math.random().toString(36).slice(2)}`,
      rootDir: join(fx.root, "cfg"),
    });
    assert.ok(plan);
    assert.equal(
      existsSync(join(plan.dir, "extensions", PI_ROUTING_EXTENSION_FILENAME)),
      false,
      "the kill switch must reach the builtin",
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
