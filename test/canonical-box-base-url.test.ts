import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalBaseUrlFromHostmapCache,
  deriveBoxBaseUrlFrom,
  envValueFromEnviron,
  parseBoxBaseUrlFromResolvConf,
  parseNamespaceFromResolvConf,
} from "../src/acp/auth-env.js";

// PROD-2 (brick e437db49) — the canonical-host ladder.
//
// Fixtures below are konsiq's and devbox's REAL file contents, measured read-only
// on 2026-08-20 against deployed acpx ff1cc2e7 (konsiq) / 9566e7c (devbox). The
// point of the ladder is that rung 4 (`parseBoxBaseUrlFromResolvConf`) is
// structurally unable to be right for the three product-domain boxes, so the two
// strings must be kept apart everywhere in this file:
//
//   https://acpx.konsiq.nativai.de     ← rung 4's ALIAS. Servable, but NOT canonical.
//   https://acpx.devbox.konsiq.de      ← the CANONICAL host. What rungs 2 and 3 give.
//
// ⚠️ DO NOT rewrite these as "assert the result is a valid acpx URL". Both strings
// are valid acpx URLs; the whole defect is which one comes out. Every assertion
// here names the exact expected string on purpose.

const KONSIQ_RESOLV_CONF =
  "search dev-konsiq.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.109.0.10\noptions ndots:5\n";
const DEVBOX_RESOLV_CONF =
  "search dev-devbox.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.109.0.10\noptions ndots:5\n";

const KONSIQ_PID1_ENVIRON =
  "PATH=/usr/local/bin:/usr/bin\0ACPX_UI_BASE_URL=https://acpx.devbox.konsiq.de\0HOME=/home/node\0";

// The live cache, trimmed to the entries that matter: dev-konsiq contributes BOTH a
// canonical (`source: "discovered"`) and an alias entry, which is exactly the
// discrimination rung 3 has to make.
const HOSTMAP_CACHE = JSON.stringify({
  generatedAt: 1786978229738,
  entries: [
    {
      host: "acpx.konsiq.nativai.de",
      namespace: "dev-konsiq",
      endpoint: "http://dev-server.dev-konsiq.svc.cluster.local:3456",
      source: "alias",
    },
    {
      host: "acpx.devbox.konsiq.de",
      namespace: "dev-konsiq",
      endpoint: "http://dev-server.dev-konsiq.svc.cluster.local:3456",
      source: "discovered",
    },
    {
      host: "acpx.devbox.nativai.de",
      namespace: "dev-devbox",
      endpoint: "http://dev-server.dev-devbox.svc.cluster.local:3456",
      source: "discovered",
    },
  ],
  misses: {},
});

const ALIAS = "https://acpx.konsiq.nativai.de";
const CANONICAL = "https://acpx.devbox.konsiq.de";

// ---------------------------------------------------------------------------
// The transition the brick exists for
// ---------------------------------------------------------------------------

test("PROD-2 transition: konsiq's real inputs yield the CANONICAL host where rung 4 alone yields the ALIAS", () => {
  // BEFORE — rung 4 in isolation is what the deployed resolver fell through to on
  // konsiq, because $ACPX_UI_BASE_URL is empty in an ssh shell. Measured live.
  assert.equal(parseBoxBaseUrlFromResolvConf(KONSIQ_RESOLV_CONF), ALIAS);

  // AFTER — the full ladder over the same box's real files.
  assert.equal(
    deriveBoxBaseUrlFrom({
      pid1Environ: KONSIQ_PID1_ENVIRON,
      namespaceFile: "dev-konsiq\n",
      resolvConf: KONSIQ_RESOLV_CONF,
      hostmapCache: HOSTMAP_CACHE,
    }),
    CANONICAL,
  );
});

test("PROD-2 control: devbox is unchanged by the ladder — every rung agrees", () => {
  const devboxHost = "https://acpx.devbox.nativai.de";
  assert.equal(parseBoxBaseUrlFromResolvConf(DEVBOX_RESOLV_CONF), devboxHost);
  assert.equal(
    deriveBoxBaseUrlFrom({
      pid1Environ: `ACPX_UI_BASE_URL=${devboxHost}\0`,
      namespaceFile: "dev-devbox\n",
      resolvConf: DEVBOX_RESOLV_CONF,
      hostmapCache: HOSTMAP_CACHE,
    }),
    devboxHost,
  );
});

// ---------------------------------------------------------------------------
// Rung ordering — each rung must beat the one below it, proven by making them
// disagree. A fixture where two rungs agree cannot detect a swapped order.
// ---------------------------------------------------------------------------

test("PROD-2 ordering: /proc/1/environ (rung 2) beats the hostmap cache and resolv.conf", () => {
  assert.equal(
    deriveBoxBaseUrlFrom({
      pid1Environ: "ACPX_UI_BASE_URL=https://acpx.pid-one-wins.example\0",
      namespaceFile: "dev-konsiq\n",
      resolvConf: KONSIQ_RESOLV_CONF,
      hostmapCache: HOSTMAP_CACHE,
    }),
    "https://acpx.pid-one-wins.example",
  );
});

test("PROD-2 ordering: the hostmap cache (rung 3) beats resolv.conf (rung 4)", () => {
  assert.equal(
    deriveBoxBaseUrlFrom({
      namespaceFile: "dev-konsiq\n",
      resolvConf: KONSIQ_RESOLV_CONF,
      hostmapCache: HOSTMAP_CACHE,
    }),
    CANONICAL,
  );
});

test("PROD-2 ordering: resolv.conf supplies the namespace when the service-account file is absent", () => {
  // Rung 3 still fires — the namespace is recoverable from resolv.conf alone, so
  // dropping the namespace file must not silently demote the box to its alias.
  assert.equal(
    deriveBoxBaseUrlFrom({ resolvConf: KONSIQ_RESOLV_CONF, hostmapCache: HOSTMAP_CACHE }),
    CANONICAL,
  );
});

// ---------------------------------------------------------------------------
// Fall-through: a missing or unusable input must demote by one rung, never throw.
// This resolver runs on EVERY spawn.
// ---------------------------------------------------------------------------

test("PROD-2 fall-through: no usable input at all → undefined (caller applies the devbox default)", () => {
  assert.equal(deriveBoxBaseUrlFrom({}), undefined);
  assert.equal(deriveBoxBaseUrlFrom({ resolvConf: "nameserver 1.1.1.1\n" }), undefined);
});

test("PROD-2 fall-through: a missing / malformed / stale hostmap cache demotes to the alias, never throws", () => {
  const withoutCache = { namespaceFile: "dev-konsiq\n", resolvConf: KONSIQ_RESOLV_CONF };
  // Absent file.
  assert.equal(deriveBoxBaseUrlFrom(withoutCache), ALIAS);
  // Truncated mid-write / not JSON at all.
  assert.equal(deriveBoxBaseUrlFrom({ ...withoutCache, hostmapCache: '{"entries":[' }), ALIAS);
  assert.equal(deriveBoxBaseUrlFrom({ ...withoutCache, hostmapCache: "" }), ALIAS);
  // Valid JSON, wrong shape.
  assert.equal(deriveBoxBaseUrlFrom({ ...withoutCache, hostmapCache: "null" }), ALIAS);
  assert.equal(deriveBoxBaseUrlFrom({ ...withoutCache, hostmapCache: "[]" }), ALIAS);
  assert.equal(
    deriveBoxBaseUrlFrom({ ...withoutCache, hostmapCache: '{"entries":"nope"}' }),
    ALIAS,
  );
  // Stale: a real cache that predates this box joining the fleet.
  assert.equal(
    deriveBoxBaseUrlFrom({
      ...withoutCache,
      hostmapCache: JSON.stringify({ entries: [{ host: "a.b", namespace: "dev-other" }] }),
    }),
    ALIAS,
  );
});

// ---------------------------------------------------------------------------
// Rung 3's discrimination — the alias/canonical test is the whole point
// ---------------------------------------------------------------------------

test("canonicalBaseUrlFromHostmapCache: skips the alias entry and returns the canonical one", () => {
  assert.equal(canonicalBaseUrlFromHostmapCache(HOSTMAP_CACHE, "dev-konsiq"), CANONICAL);
  assert.equal(
    canonicalBaseUrlFromHostmapCache(HOSTMAP_CACHE, "dev-devbox"),
    "https://acpx.devbox.nativai.de",
  );
});

test("canonicalBaseUrlFromHostmapCache: an alias-ONLY namespace is a miss, not a fallback to the alias", () => {
  // Rung 4 already produces the alias. If rung 3 returned it too, a box that never
  // reported a canonical host would look like one that did.
  const aliasOnly = JSON.stringify({
    entries: [{ host: "acpx.konsiq.nativai.de", namespace: "dev-konsiq", source: "alias" }],
  });
  assert.equal(canonicalBaseUrlFromHostmapCache(aliasOnly, "dev-konsiq"), undefined);
});

test("canonicalBaseUrlFromHostmapCache: matches acpx-ui's `source !== alias` test, so a sourceless entry counts", () => {
  const noSource = JSON.stringify({
    entries: [{ host: "acpx.devbox.konsiq.de", namespace: "dev-konsiq" }],
  });
  assert.equal(canonicalBaseUrlFromHostmapCache(noSource, "dev-konsiq"), CANONICAL);
});

test("canonicalBaseUrlFromHostmapCache: unknown namespace and unusable entries are misses", () => {
  assert.equal(canonicalBaseUrlFromHostmapCache(HOSTMAP_CACHE, "dev-nosuchbox"), undefined);
  const junk = JSON.stringify({
    entries: [null, 7, "x", { namespace: "dev-konsiq" }, { host: "   ", namespace: "dev-konsiq" }],
  });
  assert.equal(canonicalBaseUrlFromHostmapCache(junk, "dev-konsiq"), undefined);
});

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

test("envValueFromEnviron: reads a NUL-separated KEY=value block", () => {
  assert.equal(
    envValueFromEnviron(KONSIQ_PID1_ENVIRON, "ACPX_UI_BASE_URL"),
    "https://acpx.devbox.konsiq.de",
  );
  assert.equal(envValueFromEnviron(KONSIQ_PID1_ENVIRON, "HOME"), "/home/node");
  assert.equal(envValueFromEnviron(KONSIQ_PID1_ENVIRON, "NOT_SET"), undefined);
  // Prefix collisions must not match, and an empty value is a miss not an empty string.
  assert.equal(envValueFromEnviron("ACPX_UI_BASE_URL_EXTRA=x\0", "ACPX_UI_BASE_URL"), undefined);
  assert.equal(envValueFromEnviron("ACPX_UI_BASE_URL=   \0", "ACPX_UI_BASE_URL"), undefined);
  assert.equal(envValueFromEnviron("", "ACPX_UI_BASE_URL"), undefined);
});

test("parseNamespaceFromResolvConf: derives dev-<box>, undefined off-cluster", () => {
  assert.equal(parseNamespaceFromResolvConf(KONSIQ_RESOLV_CONF), "dev-konsiq");
  assert.equal(parseNamespaceFromResolvConf(DEVBOX_RESOLV_CONF), "dev-devbox");
  assert.equal(parseNamespaceFromResolvConf("search example.com lan\n"), undefined);
  assert.equal(parseNamespaceFromResolvConf(""), undefined);
});
