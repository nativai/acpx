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
 * Write the template to disk and import it FRESH, with `PI_CODING_AGENT_DIR`
 * and `ACPX_UI_SETTINGS_FILE` bound to this fixture — both are read at module
 * load (the openrouter id set and the settings path), exactly as in a real
 * seeded session.
 */
async function loadExtension(opts: {
  configDir: string;
  settingsFile: string;
}): Promise<LoadedExtension> {
  const dir = mkdtempSync(join(tmpdir(), "acpx-pi-routing-ext-"));
  const path = join(dir, `ext-${importCounter++}.mjs`);
  writeFileSync(path, PI_ROUTING_EXTENSION_CODE, "utf8");
  const previous = {
    dir: process.env.PI_CODING_AGENT_DIR,
    settings: process.env.ACPX_UI_SETTINGS_FILE,
  };
  process.env.PI_CODING_AGENT_DIR = opts.configDir;
  process.env.ACPX_UI_SETTINGS_FILE = opts.settingsFile;
  try {
    return (await import(`${pathToFileURL(path).href}?v=${importCounter}`)) as LoadedExtension;
  } finally {
    if (previous.dir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous.dir;
    }
    if (previous.settings === undefined) {
      delete process.env.ACPX_UI_SETTINGS_FILE;
    } else {
      process.env.ACPX_UI_SETTINGS_FILE = previous.settings;
    }
  }
}

function writeOpenrouterConfigDir(root: string): string {
  const configDir = join(root, "cfg");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "models-store.json"),
    JSON.stringify({
      openrouter: {
        lastModified: 1,
        checkedAt: 1,
        models: [{ id: MODEL }, { id: "moonshotai/kimi-k2-thinking" }],
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(configDir, "models.json"),
    JSON.stringify({
      providers: {
        openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
      },
    }),
    "utf8",
  );
  return configDir;
}

type Handler = (event: { payload: Record<string, unknown> }) => unknown;

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
  const ext = await loadExtension({ configDir: noConfigDir(), settingsFile: noSettingsFile() });
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

// Minimal env targets for the pure-function parity rows: the module reads the
// id set and settings path at load, and both may legitimately be empty here.
function noConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "acpx-pi-routing-nocfg-"));
  return dir;
}
function noSettingsFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), "acpx-pi-routing-noset-")), "ui-settings.json");
  writeFileSync(file, JSON.stringify({ version: 1 }), "utf8");
  return file;
}

test("parity · the extension's resolver agrees with resolveProviderObject on every valid policy", async () => {
  const ext = await loadExtension({ configDir: noConfigDir(), settingsFile: noSettingsFile() });
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
  const ext = await loadExtension({ configDir: noConfigDir(), settingsFile: noSettingsFile() });
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
  const configDir = writeOpenrouterConfigDir(root);
  const settingsFile = join(root, "ui-settings.json");
  // The policy did not exist when the session spawned…
  writeFileSync(settingsFile, JSON.stringify({ version: 1 }), "utf8");
  const ext = await loadExtension({ configDir, settingsFile });
  const handler = await handlerFor(ext);

  const payload: Record<string, unknown> = {
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
  };
  assert.equal(handler({ payload }), undefined, "no policy ⇒ payload untouched");

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
  const routed = handler({ payload }) as Record<string, unknown>;
  assert.deepEqual(
    routed?.provider,
    resolveProviderObject({ perModel: { [MODEL]: { order: ["coreweave", "baseten"] } } }, MODEL),
  );

  rmSync(root, { recursive: true, force: true });
});

test("handler · a CLEARED policy stops steering the running session", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-clear-"));
  const configDir = writeOpenrouterConfigDir(root);
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      openrouterRouting: { perModel: { [MODEL]: { order: ["baseten"] } } },
    }),
    "utf8",
  );
  const ext = await loadExtension({ configDir, settingsFile });
  const handler = await handlerFor(ext);
  const payload: Record<string, unknown> = {
    model: MODEL,
    provider: { order: ["baseten"], allow_fallbacks: true },
  };
  const routed = handler({ payload }) as Record<string, unknown>;
  assert.ok(routed?.provider, "policy in force ⇒ provider set");
  assert.deepEqual(
    routed?.provider,
    resolveProviderObject({ perModel: { [MODEL]: { order: ["baseten"] } } }, MODEL),
  );

  writeFileSync(settingsFile, JSON.stringify({ version: 1 }), "utf8");
  utimesSync(settingsFile, new Date(), new Date());
  const cleared = handler({ payload }) as Record<string, unknown>;
  assert.equal(
    "provider" in (cleared ?? {}),
    false,
    "a cleared policy must strip the stale provider block",
  );

  rmSync(root, { recursive: true, force: true });
});

test("handler · a policy that becomes INVALID is dropped WHOLE, never partially applied", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-invalid-"));
  const configDir = writeOpenrouterConfigDir(root);
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      openrouterRouting: { perModel: { [MODEL]: { order: ["baseten"] } } },
    }),
    "utf8",
  );
  const ext = await loadExtension({ configDir, settingsFile });
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
  const routed = handler({ payload }) as Record<string, unknown>;
  assert.equal("provider" in (routed ?? {}), false, "invalid policy ⇒ no routing in force");

  rmSync(root, { recursive: true, force: true });
});

test("handler · an UNREADABLE settings file leaves the payload untouched (fail-open)", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-gone-"));
  const configDir = writeOpenrouterConfigDir(root);
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({ version: 1, openrouterRouting: { ignore: ["wafer"] } }),
    "utf8",
  );
  const ext = await loadExtension({ configDir, settingsFile });
  const handler = await handlerFor(ext);
  const payload: Record<string, unknown> = {
    model: MODEL,
    provider: { ignore: ["wafer"], allow_fallbacks: true },
  };
  rmSync(settingsFile);
  assert.equal(
    handler({ payload }),
    undefined,
    "unreadable file ⇒ no opinion, spawn-time routing stands",
  );

  rmSync(root, { recursive: true, force: true });
});

test("handler · non-openrouter models are never touched, box-wide policy or not", async () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-routing-scope-"));
  const configDir = writeOpenrouterConfigDir(root);
  const settingsFile = join(root, "ui-settings.json");
  writeFileSync(
    settingsFile,
    JSON.stringify({
      version: 1,
      openrouterRouting: { ignore: ["wafer"], perModel: { [MODEL]: { order: ["baseten"] } } },
    }),
    "utf8",
  );
  const ext = await loadExtension({ configDir, settingsFile });
  const handler = await handlerFor(ext);
  // An id in neither models-store.json nor models.json: the extension has no
  // basis to call it an openrouter model, and Anthropic-shaped bodies 400 on
  // unknown top-level fields — so the only safe answer is no-op.
  assert.equal(handler({ payload: { model: "claude-sonnet-4-5", max_tokens: 1024 } }), undefined);
  assert.equal(handler({ payload: { model: "moonshotai/kimi-k2-thinking" } }) !== undefined, true);

  rmSync(root, { recursive: true, force: true });
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
