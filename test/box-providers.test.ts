import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyBoxProviderEnv,
  BOX_PROVIDER_EXPIRY_WARNING_DAYS,
  boxProviderEnvNames,
  boxProvidersPath,
  describeBoxProviders,
  loadBoxProviders,
  resolveBoxProviderKey,
} from "../src/config/providers.js";

// Block B1 — box-scoped provider credentials (~/.acpx/providers.json).
//
// ⚠️ NO REAL CREDENTIAL APPEARS IN THIS FILE OR IS NEEDED BY IT. Every key here
// is the synthetic literal below, which is also what the leak assertions plant
// as their POSITIVE CONTROL — a secret-absence assertion that never proves it
// could have seen the secret is indistinguishable from a broken one.
const SYNTHETIC_KEY = "sk-or-v1-TESTONLY-0000000000000000000000000000000000000000";
const SECRET_SHAPE = /sk-or-v1-/;

type Fixture = { homeDir: string; providersPath: string };

function makeHome(): Fixture {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "acpx-providers-test-"));
  mkdirSync(path.join(homeDir, ".acpx"), { recursive: true });
  return { homeDir, providersPath: path.join(homeDir, ".acpx", "providers.json") };
}

function writeProviders(fixture: Fixture, body: unknown, mode = 0o600): void {
  writeFileSync(fixture.providersPath, JSON.stringify(body), "utf8");
  chmodSync(fixture.providersPath, mode);
}

function openRouterFixture(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    box: "devbox",
    providers: {
      openrouter: {
        env: "OPENROUTER_API_KEY",
        apiKey: SYNTHETIC_KEY,
        source: "cardea",
        grantId: "g_TESTONLY",
        keyHash: "hash-TESTONLY",
        budgetUsd: 200,
        limitReset: "monthly",
        expiresAt: "2026-12-02T00:00:00Z",
        mintedAt: "2026-09-03T22:00:00Z",
        ...overrides,
      },
    },
  };
}

test("the path is ~/.acpx/providers.json, beside registry.json", () => {
  assert.equal(boxProvidersPath("/home/somebody"), "/home/somebody/.acpx/providers.json");
});

test("an ABSENT file is the normal case and never throws", () => {
  const fixture = makeHome();
  try {
    // ⚠️ THIS RUNS ON THE SESSION-CREATION PATH. Most boxes will not have this
    // file. A throw here would break session creation on every box that has not
    // been provisioned — which is nearly all of them on day one.
    const loaded = loadBoxProviders({ homeDir: fixture.homeDir });
    assert.deepEqual(loaded, { version: 1, providers: [] });
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(applyBoxProviderEnv(env, { homeDir: fixture.homeDir }), []);
    assert.deepEqual(env, {});
    assert.deepEqual(describeBoxProviders({ homeDir: fixture.homeDir }), []);
  } finally {
    rmSync(fixture.homeDir, { recursive: true, force: true });
  }
});

test("a MALFORMED file degrades to 'no provider credential' rather than throwing", () => {
  const fixture = makeHome();
  try {
    for (const body of ["", "{", "null", "[]", '{"providers":"nope"}', '{"providers":null}']) {
      writeFileSync(fixture.providersPath, body, "utf8");
      assert.deepEqual(
        loadBoxProviders({ homeDir: fixture.homeDir }),
        { version: 1, providers: [] },
        `malformed body ${JSON.stringify(body)} must degrade, not throw`,
      );
    }
    // An entry with no `env` has nothing to deliver: dropped, and the file's
    // other entries still load. Half-honoring it would set nothing under a name
    // nobody can predict.
    writeProviders(fixture, {
      version: 1,
      providers: { broken: { apiKey: SYNTHETIC_KEY }, openrouter: { env: "OPENROUTER_API_KEY" } },
    });
    const loaded = loadBoxProviders({ homeDir: fixture.homeDir });
    assert.deepEqual(
      loaded.providers.map((entry) => entry.name),
      ["openrouter"],
    );
  } finally {
    rmSync(fixture.homeDir, { recursive: true, force: true });
  }
});

test("the schema round-trips CONCEPTION §4.2 verbatim", () => {
  const fixture = makeHome();
  try {
    writeProviders(fixture, openRouterFixture());
    const loaded = loadBoxProviders({ homeDir: fixture.homeDir });
    assert.equal(loaded.version, 1);
    assert.equal(loaded.box, "devbox");
    assert.deepEqual(loaded.providers, [
      {
        name: "openrouter",
        env: "OPENROUTER_API_KEY",
        apiKey: SYNTHETIC_KEY,
        source: "cardea",
        grantId: "g_TESTONLY",
        keyHash: "hash-TESTONLY",
        budgetUsd: 200,
        limitReset: "monthly",
        expiresAt: "2026-12-02T00:00:00Z",
        mintedAt: "2026-09-03T22:00:00Z",
      },
    ]);
    assert.equal(statSync(fixture.providersPath).mode & 0o777, 0o600);
  } finally {
    rmSync(fixture.homeDir, { recursive: true, force: true });
  }
});

test("apiKeyEnv BEATS a literal apiKey — the profile schema's precedence, reused", () => {
  const fixture = makeHome();
  try {
    writeProviders(
      fixture,
      openRouterFixture({ apiKey: SYNTHETIC_KEY, apiKeyEnv: "HP_B1_INDIRECT_KEY" }),
    );
    const [entry] = loadBoxProviders({ homeDir: fixture.homeDir }).providers;
    assert.ok(entry);
    assert.equal(
      resolveBoxProviderKey(entry, { HP_B1_INDIRECT_KEY: `${SYNTHETIC_KEY}-INDIRECT` }),
      `${SYNTHETIC_KEY}-INDIRECT`,
    );
    // Indirection that does not resolve falls back to the literal rather than
    // yielding nothing — an unset variable must not silently disable the box.
    assert.equal(resolveBoxProviderKey(entry, {}), SYNTHETIC_KEY);
    assert.equal(resolveBoxProviderKey(entry, { HP_B1_INDIRECT_KEY: "   " }), SYNTHETIC_KEY);
  } finally {
    rmSync(fixture.homeDir, { recursive: true, force: true });
  }
});

test("applyBoxProviderEnv sets the declared variable, and NEVER overwrites one already set", () => {
  const fixture = makeHome();
  try {
    writeProviders(fixture, openRouterFixture());

    const fresh: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    assert.deepEqual(applyBoxProviderEnv(fresh, { homeDir: fixture.homeDir, env: {} }), [
      "OPENROUTER_API_KEY",
    ]);
    assert.equal(fresh.OPENROUTER_API_KEY, SYNTHETIC_KEY);

    // ⚠️ THE NON-OVERWRITING RULE — the same one `promotePrefixedAuthEnvironment`
    // uses. Anything more specific than the box (the wave-one ambient
    // ACPX_AUTH_OPENROUTER_API_KEY promotion, a caller's own export) wins, and
    // the box credential is a strict fallback. This is also why the injection is
    // a structural NO-OP wherever the variable is already in the parent's env.
    const occupied: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "pre-existing-value" };
    assert.deepEqual(applyBoxProviderEnv(occupied, { homeDir: fixture.homeDir, env: {} }), []);
    assert.equal(occupied.OPENROUTER_API_KEY, "pre-existing-value");
  } finally {
    rmSync(fixture.homeDir, { recursive: true, force: true });
  }
});

test("an entry whose credential does not resolve sets NOTHING", () => {
  const fixture = makeHome();
  try {
    // No literal and an indirection that resolves to nothing: setting the
    // variable to "" would be worse than leaving it unset — the harness would
    // then send an empty bearer token instead of falling through.
    writeProviders(fixture, {
      version: 1,
      providers: { openrouter: { env: "OPENROUTER_API_KEY", apiKeyEnv: "HP_B1_ABSENT" } },
    });
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(applyBoxProviderEnv(env, { homeDir: fixture.homeDir, env: {} }), []);
    assert.ok(!("OPENROUTER_API_KEY" in env));
  } finally {
    rmSync(fixture.homeDir, { recursive: true, force: true });
  }
});

test("MULTIPLE providers are each delivered under their own declared name", () => {
  const fixture = makeHome();
  try {
    writeProviders(fixture, {
      version: 1,
      box: "devbox",
      providers: {
        openrouter: { env: "OPENROUTER_API_KEY", apiKey: SYNTHETIC_KEY },
        // A name that does NOT end in _API_KEY / _TOKEN / _SECRET — the exact
        // shape the rig normalizer's suffix wildcards miss, which is why
        // `boxProviderEnvNames()` exists as a redaction input.
        someprovider: { env: "SOMEPROVIDER_AUTH", apiKey: `${SYNTHETIC_KEY}-2` },
      },
    });
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(applyBoxProviderEnv(env, { homeDir: fixture.homeDir, env: {} }).toSorted(), [
      "OPENROUTER_API_KEY",
      "SOMEPROVIDER_AUTH",
    ]);
    assert.deepEqual(boxProviderEnvNames({ homeDir: fixture.homeDir }).toSorted(), [
      "OPENROUTER_API_KEY",
      "SOMEPROVIDER_AUTH",
    ]);
  } finally {
    rmSync(fixture.homeDir, { recursive: true, force: true });
  }
});

test("expiry: 'expires in N days' and the 14-day warning threshold", () => {
  const fixture = makeHome();
  const now = new Date("2026-09-04T00:00:00Z");
  try {
    const cases: { expiresAt: string; days: number; soon: boolean; expired: boolean }[] = [
      { expiresAt: "2026-12-03T00:00:00Z", days: 90, soon: false, expired: false },
      { expiresAt: "2026-09-19T00:00:00Z", days: 15, soon: false, expired: false },
      // The boundary is inclusive: exactly 14 days raises it.
      { expiresAt: "2026-09-18T00:00:00Z", days: 14, soon: true, expired: false },
      { expiresAt: "2026-09-05T00:00:00Z", days: 1, soon: true, expired: false },
      { expiresAt: "2026-09-04T00:00:00Z", days: 0, soon: true, expired: false },
      { expiresAt: "2026-09-01T00:00:00Z", days: -3, soon: false, expired: true },
    ];
    for (const testCase of cases) {
      writeProviders(fixture, openRouterFixture({ expiresAt: testCase.expiresAt }));
      const [status] = describeBoxProviders({ homeDir: fixture.homeDir, now });
      assert.ok(status);
      assert.equal(status.expiresInDays, testCase.days, `days for ${testCase.expiresAt}`);
      assert.equal(status.expiringSoon, testCase.soon, `expiringSoon for ${testCase.expiresAt}`);
      assert.equal(status.expired, testCase.expired, `expired for ${testCase.expiresAt}`);
    }
    assert.equal(BOX_PROVIDER_EXPIRY_WARNING_DAYS, 14);
  } finally {
    rmSync(fixture.homeDir, { recursive: true, force: true });
  }
});

test("expiry: an unstamped or unparseable expiresAt is UNKNOWN, never a false all-clear", () => {
  const fixture = makeHome();
  try {
    for (const expiresAt of [undefined, "not-a-date"]) {
      writeProviders(
        fixture,
        expiresAt === undefined
          ? {
              version: 1,
              providers: { openrouter: { env: "OPENROUTER_API_KEY", apiKey: SYNTHETIC_KEY } },
            }
          : openRouterFixture({ expiresAt }),
      );
      const [status] = describeBoxProviders({ homeDir: fixture.homeDir });
      assert.ok(status);
      // ⚠️ Absent must not read as "expires soon" (a warning nobody can act on)
      // NOR as "expired" (which would look like an outage). It reads as unknown,
      // and the renderer says "no expiry recorded".
      assert.equal(status.expiresInDays, undefined, `expiresAt=${String(expiresAt)}`);
      assert.equal(status.expiringSoon, false);
      assert.equal(status.expired, false);
    }
  } finally {
    rmSync(fixture.homeDir, { recursive: true, force: true });
  }
});

test("describeBoxProviders CANNOT leak the credential — planted positive control", () => {
  const fixture = makeHome();
  try {
    writeProviders(fixture, openRouterFixture());

    // ⚠️ POSITIVE CONTROL FIRST, ON THE SAME INSTRUMENT AND THE SAME PATH. A
    // regex that never matches anything passes the absence assertion below
    // vacuously; this proves the planted key IS reachable and IS matched, so the
    // absence that follows is a measurement rather than a broken probe.
    const rawFile = JSON.stringify(loadBoxProviders({ homeDir: fixture.homeDir }));
    assert.match(rawFile, SECRET_SHAPE, "control: the planted key must be findable in the load");
    assert.ok(rawFile.includes(SYNTHETIC_KEY), "control: the exact planted value must be present");

    // The assertion. Same instrument, same fixture, diagnostic surface instead.
    const described = JSON.stringify(describeBoxProviders({ homeDir: fixture.homeDir }));
    assert.doesNotMatch(described, SECRET_SHAPE, "describeBoxProviders leaked a credential shape");
    assert.ok(!described.includes(SYNTHETIC_KEY), "describeBoxProviders leaked the exact key");

    // The non-secret audit fields must SURVIVE, or the "absence" above would be
    // achieved by returning nothing at all — a control that examined nothing.
    const [status] = describeBoxProviders({ homeDir: fixture.homeDir });
    assert.ok(status);
    assert.equal(status.grantId, "g_TESTONLY");
    assert.equal(status.keyHash, "hash-TESTONLY");
    assert.equal(status.hasCredential, true);
    assert.equal(status.env, "OPENROUTER_API_KEY");
  } finally {
    rmSync(fixture.homeDir, { recursive: true, force: true });
  }
});

test("hasCredential is FALSE, not absent, when nothing resolves", () => {
  const fixture = makeHome();
  try {
    writeProviders(fixture, {
      version: 1,
      providers: { openrouter: { env: "OPENROUTER_API_KEY", apiKeyEnv: "HP_B1_ABSENT" } },
    });
    const [status] = describeBoxProviders({ homeDir: fixture.homeDir, env: {} });
    assert.ok(status);
    // A declared provider with no working credential is the failure this file
    // must be able to SHOW — reporting it as "no providers" would hide a
    // half-provisioned box.
    assert.equal(status.hasCredential, false);
    assert.equal(status.name, "openrouter");
  } finally {
    rmSync(fixture.homeDir, { recursive: true, force: true });
  }
});
