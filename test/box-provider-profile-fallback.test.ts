import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveOpenRouterApiKey } from "../src/acp/auth-env.js";
import type { OpenRouterProfileEntry } from "../src/config/profiles.js";

// Block B1 deliverable 4 — "one key on the box, one place it lives", as CODE.
//
// ⚠️ WHY THIS EXISTS AT ALL, because the obvious reading of the deliverable does
// NOT work: `resolveOpenRouterApiKey` runs in the acpx PARENT and reads
// `process.env`, while `applyBoxProviderEnv` writes the CHILD's spawn env. So a
// profile carrying `openRouterApiKeyEnv: "OPENROUTER_API_KEY"` on a box whose
// only copy of that variable lives in providers.json would fall straight through
// to its literal — i.e. to the SECOND copy of the key this is meant to remove.
// The fallback below is what closes that, keyed on the provider's DECLARED `env`
// NAME so the profile keeps naming a VARIABLE and providers.json keeps being
// what supplies it.
//
// ⚠️ NO REAL CREDENTIAL IS USED OR NEEDED. Everything here is synthetic.
const SYNTHETIC_BOX_KEY = "sk-or-v1-TESTONLY-boxprovider-000000000000000000000000";
const SYNTHETIC_LITERAL = "sk-or-v1-TESTONLY-profileliteral-00000000000000000000";
const SYNTHETIC_AMBIENT = "sk-or-v1-TESTONLY-ambientenv-0000000000000000000000000";

function profile(overrides: Partial<OpenRouterProfileEntry> = {}): OpenRouterProfileEntry {
  return {
    id: "openrouter-testonly",
    label: "OpenRouter (test)",
    authMode: "openrouter",
    adapter: "claude",
    account: "openrouter-testonly",
    model: "deepseek/deepseek-v4-pro",
    credentialSource: null,
    ...overrides,
  } as OpenRouterProfileEntry;
}

type Harness = { stateHome: string; restore: () => void };

/** `null` writes no providers.json at all — the unprovisioned box. */
/**
 * Point the REAL resolver at a temp state home. `providers.json` resolution is
 * `ACPX_STATE_HOME || os.homedir()`, so this exercises the same path production
 * takes rather than a test-only injection point.
 */
function withStateHome(providers: unknown): Harness {
  const stateHome = mkdtempSync(path.join(os.tmpdir(), "acpx-b1-profile-"));
  mkdirSync(path.join(stateHome, ".acpx"), { recursive: true });
  if (providers !== null) {
    const file = path.join(stateHome, ".acpx", "providers.json");
    writeFileSync(file, JSON.stringify(providers), "utf8");
    chmodSync(file, 0o600);
  }
  const previousStateHome = process.env.ACPX_STATE_HOME;
  const previousVar = process.env.OPENROUTER_API_KEY;
  process.env.ACPX_STATE_HOME = stateHome;
  delete process.env.OPENROUTER_API_KEY;
  return {
    stateHome,
    restore: () => {
      if (previousStateHome === undefined) {
        delete process.env.ACPX_STATE_HOME;
      } else {
        process.env.ACPX_STATE_HOME = previousStateHome;
      }
      if (previousVar === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousVar;
      }
      rmSync(stateHome, { recursive: true, force: true });
    },
  };
}

function boxProviders(): unknown {
  return {
    version: 1,
    box: "devbox",
    providers: {
      openrouter: { env: "OPENROUTER_API_KEY", apiKey: SYNTHETIC_BOX_KEY, source: "cardea" },
    },
  };
}

test("a profile naming OPENROUTER_API_KEY resolves the BOX provider key", () => {
  const harness = withStateHome(boxProviders());
  try {
    // The deliverable, measured: the profile stores no literal at all and still
    // gets a key — one key on the box, one place it lives.
    assert.equal(
      resolveOpenRouterApiKey(profile({ openRouterApiKeyEnv: "OPENROUTER_API_KEY" })),
      SYNTHETIC_BOX_KEY,
    );
  } finally {
    harness.restore();
  }
});

test("PRECEDENCE IS UNCHANGED AT THE TOP: the process env still beats the box provider", () => {
  const harness = withStateHome(boxProviders());
  try {
    process.env.OPENROUTER_API_KEY = SYNTHETIC_AMBIENT;
    // The wave-one ambient shortcut (ACPX_AUTH_OPENROUTER_API_KEY promoted to
    // OPENROUTER_API_KEY) must keep winning, or a box mid-migration would flip
    // to the file the moment it appeared.
    assert.equal(
      resolveOpenRouterApiKey(profile({ openRouterApiKeyEnv: "OPENROUTER_API_KEY" })),
      SYNTHETIC_AMBIENT,
    );
  } finally {
    harness.restore();
  }
});

test("the literal STILL WINS over the box provider when no env indirection is declared", () => {
  const harness = withStateHome(boxProviders());
  try {
    // ⚠️ THE NON-BREAKING GUARANTEE, and it is what keeps the standing rig alive:
    // the rig reads profile `openrouter-deepseek`'s LITERAL openRouterApiKey out
    // of registry.json at every launch. A profile that declares no
    // openRouterApiKeyEnv must therefore be completely untouched by this change,
    // box provider present or not.
    assert.equal(
      resolveOpenRouterApiKey(profile({ openRouterApiKey: SYNTHETIC_LITERAL })),
      SYNTHETIC_LITERAL,
    );
  } finally {
    harness.restore();
  }
});

test("the box provider is consulted only for the DECLARED variable name", () => {
  const harness = withStateHome(boxProviders());
  try {
    // A profile pointing at some other variable must NOT silently pick up the
    // OpenRouter box key: the match is on the provider's declared `env` name,
    // not on "it is an OpenRouter profile, use the OpenRouter provider".
    assert.equal(
      resolveOpenRouterApiKey(
        profile({ openRouterApiKeyEnv: "SOME_OTHER_VAR", openRouterApiKey: SYNTHETIC_LITERAL }),
      ),
      SYNTHETIC_LITERAL,
    );
    assert.equal(
      resolveOpenRouterApiKey(profile({ openRouterApiKeyEnv: "SOME_OTHER_VAR" })),
      undefined,
    );
  } finally {
    harness.restore();
  }
});

test("no providers.json at all: behaviour is exactly what it was before this change", () => {
  const harness = withStateHome(null);
  try {
    assert.equal(
      resolveOpenRouterApiKey(
        profile({ openRouterApiKeyEnv: "OPENROUTER_API_KEY", openRouterApiKey: SYNTHETIC_LITERAL }),
      ),
      SYNTHETIC_LITERAL,
    );
    assert.equal(
      resolveOpenRouterApiKey(profile({ openRouterApiKeyEnv: "OPENROUTER_API_KEY" })),
      undefined,
    );
  } finally {
    harness.restore();
  }
});

test("MUTATION PROBE — the fallback is load-bearing, not decorative", () => {
  // ⚠️ Without this, every assertion above could pass on a build where the box
  // fallback does nothing: the literal cases would still resolve their literal
  // and the env case its env. This is the ONE case that fails if the fallback is
  // removed — no env var, no literal, only the file.
  const harness = withStateHome(boxProviders());
  try {
    const resolved = resolveOpenRouterApiKey(
      profile({ openRouterApiKeyEnv: "OPENROUTER_API_KEY" }),
    );
    assert.notEqual(
      resolved,
      undefined,
      "gutting the box-provider fallback in resolveOpenRouterApiKey must turn THIS red",
    );
    assert.equal(resolved, SYNTHETIC_BOX_KEY);
  } finally {
    harness.restore();
  }
});
