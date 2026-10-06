// brick ebfe4c3c — the Claude model advertisement: probe, file cache, version key,
// catalogue rows, and the CLI surfaces (`acpx models`, `acpx sessions reindex`).
// CONTRACT §4, §5.1 rows 2–3 and 7.
//
// Every probe here is INJECTED or goes through the `ACPX_TEST_CLAUDE_ADVERT_JSON`
// fixture seam, except the D-3 failure row, whose adapter command points at a path
// that does not exist — so no row ever spawns the real deployed claude adapter.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { catalogueNeedsWarm } from "../src/models/catalogue-warm.js";
import {
  CLAUDE_ADVERT_SCHEMA,
  CLAUDE_FAILED_KEY_RETRY_MS,
  CLAUDE_PROBE_COOLDOWN_MS,
  claudeAdvertisementNeedsProbe,
  currentClaudeAdvertKey,
  ensureClaudeAdvertisement,
  probeClaudeAdvertisement,
  readClaudeAdvertCache,
  TEST_ADVERT_ENV,
  type ClaudeAdvertisementSnapshot,
  type ClaudeAdvertKey,
  type ClaudeProbeResult,
} from "../src/models/claude-advertisement.js";
import { harnessNativeModels } from "../src/models/harness-models.js";
import type { ModelCatalogue } from "../src/models/types.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

const CLI = path.resolve(process.cwd(), "dist/cli.js");
const DEPLOYED_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const T0 = Date.parse("2026-10-02T12:00:00.000Z");

function tempDir(prefix = "acpx-claude-advert-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function options(version: string) {
  return [
    {
      value: "default",
      name: "Default (recommended)",
      description: `Opus ${version} · Test tagline`,
    },
    { value: "opus", name: "Opus", description: `Opus ${version} · Test tagline` },
    { value: "sonnet", name: "Sonnet", description: `Sonnet ${version} · Routine` },
    { value: "haiku", name: "Haiku", description: `Haiku ${version} · Quick` },
    { value: "fable", name: "Fable", description: `Fable ${version} · Hardest` },
  ];
}

/** A runtime info.json naming `sha` as the deployed claude-agent-acp. */
function writeRuntimeInfo(dir: string, sha: string): string {
  const file = path.join(dir, `info-${sha}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ "claude-agent-acp": { sha, state: "ok", ref: "main", deployed: true } }),
  );
  return file;
}

/** A probe that records its calls and answers from a script. */
function scriptedProbe(answers: (ClaudeProbeResult | Error)[]) {
  const calls: ClaudeAdvertKey[] = [];
  return {
    calls,
    probe: async (key: ClaudeAdvertKey): Promise<ClaudeProbeResult> => {
      calls.push(key);
      const next = answers.shift() ?? new Error("no scripted answer left");
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

// ── Rows: a different advertisement changes the names with ZERO code edits ──────

test("harnessNativeModels(advert) row names, taglines and citations follow the advertisement", () => {
  const advert: ClaudeAdvertisementSnapshot = {
    options: options("9.1"),
    adapterSha: "abc123",
    sdkVersion: "9.9.9",
    probedAt: "2026-10-02T12:00:00.000Z",
    source: "fixture",
  };
  const rows = harnessNativeModels(advert);
  assert.deepEqual(
    rows.map((row) => [row.id, row.name, row.description]),
    [
      ["default", "Opus 9.1", "Test tagline"],
      ["opus", "Opus 9.1", "Test tagline"],
      ["sonnet", "Sonnet 9.1", "Routine"],
      ["haiku", "Haiku 9.1", "Quick"],
      ["fable", "Fable 9.1", "Hardest"],
    ],
  );
  for (const row of rows) {
    assert.deepEqual(row.advertisedBy, {
      adapter: "claude-agent-acp",
      adapterSha: "abc123",
      sdkVersion: "9.9.9",
      probedAt: "2026-10-02T12:00:00.000Z",
      source: "fixture",
    });
  }
  // The SAME call with a 9.2 advertisement — no edit anywhere.
  assert.equal(harnessNativeModels({ ...advert, options: options("9.2") })[2]?.name, "Sonnet 9.2");
  // The default → opus aliasTarget model-floor depends on survives.
  assert.deepEqual(rows[0]?.aliasTarget, { id: "opus", name: "Opus" });
});

test("with NO advertisement the rows carry version-free alias names and no citation", () => {
  const rows = harnessNativeModels();
  assert.deepEqual(
    rows.map((row) => row.name),
    ["Default", "Opus", "Sonnet", "Haiku", "Fable"],
  );
  for (const row of rows) {
    assert.doesNotMatch(row.name, /[0-9]/, `${row.id}: a fallback must never carry a version`);
    assert.equal(row.advertisedBy, undefined);
    assert.equal(row.description, "Claude Code on a Claude Max subscription.");
  }
  // A row the advertisement does not carry, or carries without a clean label, falls back alone.
  const partial = harnessNativeModels({
    options: [
      { value: "opus", name: "Opus", description: "Opus 9.1 · x" },
      // Neither field carries a label (prose description, lowercase name) → fallback.
      { value: "sonnet", name: "sonnet (legacy)", description: "Newer version available" },
    ],
    adapterSha: null,
    sdkVersion: null,
    probedAt: "2026-10-02T12:00:00.000Z",
    source: "probe",
  });
  assert.deepEqual(
    partial.map((row) => [row.id, row.name, row.advertisedBy !== undefined]),
    [
      ["default", "Default", false],
      ["opus", "Opus 9.1", true],
      ["sonnet", "Sonnet", false],
      ["haiku", "Haiku", false],
      ["fable", "Fable", false],
    ],
  );
});

// ── The version key ─────────────────────────────────────────────────────────────

test("the key: adapterSha from info.json ONLY for the deployed command; sdkVersion from the adapter root", () => {
  const dir = tempDir();
  const info = writeRuntimeInfo(dir, "sha-k1");
  const deployed = currentClaudeAdvertKey({ env: {}, runtimeInfoPath: info });
  assert.equal(deployed.adapterSha, "sha-k1");
  assert.equal(deployed.agentCommand, DEPLOYED_COMMAND);

  // An override describes a DIFFERENT binary — info.json says nothing about it.
  const root = path.join(dir, "claude-agent-acp");
  const sdkDir = path.join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(path.join(sdkDir, "package.json"), JSON.stringify({ version: "7.7.7" }));
  const override = currentClaudeAdvertKey({
    env: { ACPX_CLAUDE_ACP_COMMAND: `node ${path.join(root, "dist", "index.js")}` },
    runtimeInfoPath: info,
  });
  assert.deepEqual(override, {
    adapterSha: null,
    sdkVersion: "7.7.7",
    agentCommand: `node ${path.join(root, "dist", "index.js")}`,
  });

  // No info.json (dev slots, tests) → the sha degrades to null, never throws.
  assert.equal(
    currentClaudeAdvertKey({ env: {}, runtimeInfoPath: path.join(dir, "absent.json") }).adapterSha,
    null,
  );
});

// ── Probe, cache, key, retry ───────────────────────────────────────────────────

test("mode never: reads only — a cold box is state none and nothing is probed", async () => {
  const dir = tempDir();
  const scripted = scriptedProbe([{ options: options("9.1"), source: "probe" }]);
  const view = await ensureClaudeAdvertisement({
    mode: "never",
    probe: scripted.probe,
    cachePath: path.join(dir, "claude-advertisement.json"),
    runtimeInfoPath: writeRuntimeInfo(dir, "sha-k1"),
    env: {},
    now: () => T0,
  });
  assert.equal(scripted.calls.length, 0);
  assert.equal(view.snapshot, null);
  assert.equal(view.status.state, "none");
  assert.equal(view.status.deployedAdapterSha, "sha-k1");
  assert.equal(fs.existsSync(path.join(dir, "claude-advertisement.json")), false);
});

test("if-needed: a cold cache probes ONCE, the same key never again, a new key re-probes", async () => {
  const dir = tempDir();
  const cachePath = path.join(dir, "claude-advertisement.json");
  const k1 = writeRuntimeInfo(dir, "sha-k1");
  const k2 = writeRuntimeInfo(dir, "sha-k2");
  const scripted = scriptedProbe([
    { options: options("9.1"), source: "probe" },
    { options: options("9.2"), source: "probe" },
  ]);
  const ensure = (
    runtimeInfoPath: string,
    now: number,
    mode: "if-needed" | "never" = "if-needed",
  ) =>
    ensureClaudeAdvertisement({
      mode,
      probe: scripted.probe,
      cachePath,
      runtimeInfoPath,
      env: {},
      now: () => now,
    });

  const first = await ensure(k1, T0);
  assert.equal(scripted.calls.length, 1);
  assert.equal(first.status.state, "fresh");
  assert.equal(first.snapshot?.adapterSha, "sha-k1");
  const cache = readClaudeAdvertCache(cachePath);
  assert.equal(cache?.schema, CLAUDE_ADVERT_SCHEMA);
  assert.equal(cache?.key?.adapterSha, "sha-k1");
  assert.equal(cache?.probedAt, new Date(T0).toISOString());

  // Same key, long after the sentinel cooldown: no probe.
  await ensure(k1, T0 + 10 * CLAUDE_PROBE_COOLDOWN_MS);
  assert.equal(scripted.calls.length, 1, "the same key must never re-probe");

  // The deploy moved the key. Before the re-probe, a read reports STALE with the OLD citation.
  const before = await ensure(k2, T0 + 10 * CLAUDE_PROBE_COOLDOWN_MS, "never");
  assert.equal(before.status.state, "stale");
  assert.equal(before.status.adapterSha, "sha-k1");
  assert.equal(before.status.deployedAdapterSha, "sha-k2");

  const after = await ensure(k2, T0 + 10 * CLAUDE_PROBE_COOLDOWN_MS);
  assert.equal(scripted.calls.length, 2, "a new key re-probes");
  assert.equal(after.status.state, "fresh");
  assert.equal(after.status.adapterSha, "sha-k2");
  assert.equal(harnessNativeModels(after.snapshot)[2]?.name, "Sonnet 9.2");
});

test("a FAILED probe keeps the last good options byte-identical and records a BOUNDED retry", async () => {
  const dir = tempDir();
  const cachePath = path.join(dir, "claude-advertisement.json");
  const k1 = writeRuntimeInfo(dir, "sha-k1");
  const k2 = writeRuntimeInfo(dir, "sha-k2");
  const scripted = scriptedProbe([
    { options: options("9.1"), source: "probe" },
    new Error("adapter exited"),
  ]);
  await ensureClaudeAdvertisement({
    mode: "force",
    probe: scripted.probe,
    cachePath,
    runtimeInfoPath: k1,
    env: {},
    now: () => T0,
  });
  const goodOptions = JSON.stringify(readClaudeAdvertCache(cachePath)?.options);

  const failedAt = T0 + 1000;
  const view = await ensureClaudeAdvertisement({
    mode: "force",
    probe: scripted.probe,
    cachePath,
    runtimeInfoPath: k2,
    env: {},
    now: () => failedAt,
  });
  const cache = readClaudeAdvertCache(cachePath);
  assert.equal(
    JSON.stringify(cache?.options),
    goodOptions,
    "the K1 options must survive untouched",
  );
  assert.equal(cache?.key?.adapterSha, "sha-k1");
  assert.equal(cache?.probedAt, new Date(T0).toISOString());
  assert.equal(cache?.lastFailure?.key.adapterSha, "sha-k2");
  assert.equal(cache?.lastFailure?.message, "adapter exited");
  assert.equal(
    cache?.lastFailure?.retryAfter,
    new Date(failedAt + CLAUDE_FAILED_KEY_RETRY_MS).toISOString(),
    "the backoff window is written into the record",
  );
  assert.equal(view.status.state, "stale");
  assert.equal(view.status.error, "adapter exited");
  assert.equal(harnessNativeModels(view.snapshot)[1]?.name, "Opus 9.1", "rows keep K1's labels");
  assert.equal(harnessNativeModels(view.snapshot)[1]?.advertisedBy?.adapterSha, "sha-k1");

  // Inside the window: no automatic re-probe (else every warm would probe — TEST-MATRIX D-6).
  const needs = (now: number) =>
    claudeAdvertisementNeedsProbe({ cachePath, runtimeInfoPath: k2, env: {}, now: () => now });
  assert.equal(needs(failedAt + 60_000), false);
  assert.equal(needs(failedAt + CLAUDE_FAILED_KEY_RETRY_MS - 1), false);
  // ⚠️ HoD condition (2026-10-02): the window is BOUNDED — past it the box retries on
  // its own and never sits on stale/alias labels until someone runs --refresh.
  assert.equal(needs(failedAt + CLAUDE_FAILED_KEY_RETRY_MS), true);
});

test("the retry window is bounded even when the record says otherwise", () => {
  const dir = tempDir();
  const cachePath = path.join(dir, "claude-advertisement.json");
  const k2 = writeRuntimeInfo(dir, "sha-k2");
  const key = currentClaudeAdvertKey({ env: {}, runtimeInfoPath: k2 });
  const failedAt = T0;
  // A hand-edited retryAfter a year out must not suppress the retry past the 1 h bound…
  fs.writeFileSync(
    cachePath,
    JSON.stringify({
      schema: CLAUDE_ADVERT_SCHEMA,
      key: null,
      probedAt: null,
      source: null,
      options: [],
      lastFailure: {
        at: new Date(failedAt).toISOString(),
        retryAfter: new Date(failedAt + 365 * 24 * 3_600_000).toISOString(),
        message: "x",
        key,
      },
    }),
  );
  const needs = (now: number) =>
    claudeAdvertisementNeedsProbe({ cachePath, runtimeInfoPath: k2, env: {}, now: () => now });
  assert.equal(needs(failedAt + 1000), false);
  assert.equal(needs(failedAt + CLAUDE_FAILED_KEY_RETRY_MS), true);
  // …and a failure stamped in the FUTURE (clock step) does not suppress it at all.
  assert.equal(needs(failedAt - 1000), true);
});

test("the sentinel suppresses a second AUTOMATIC probe, never a force", async () => {
  const dir = tempDir();
  const cachePath = path.join(dir, "claude-advertisement.json");
  const k1 = writeRuntimeInfo(dir, "sha-k1");
  const k2 = writeRuntimeInfo(dir, "sha-k2");
  const scripted = scriptedProbe([
    { options: options("9.1"), source: "probe" },
    { options: options("9.2"), source: "probe" },
    { options: options("9.3"), source: "probe" },
  ]);
  const ensure = (mode: "if-needed" | "force", info: string, now: number) =>
    ensureClaudeAdvertisement({
      mode,
      probe: scripted.probe,
      cachePath,
      runtimeInfoPath: info,
      env: {},
      now: () => now,
    });
  await ensure("if-needed", k1, T0);
  assert.equal(scripted.calls.length, 1);
  assert.equal(fs.readFileSync(`${cachePath}.probing`, "utf8"), String(T0), "content = epoch ms");

  // The key moved, but a probe ran 1 s ago: an automatic one is suppressed…
  await ensure("if-needed", k2, T0 + 1000);
  assert.equal(scripted.calls.length, 1, "inside the cooldown no automatic probe runs");
  // …while a force runs regardless, and stamps the sentinel.
  await ensure("force", k2, T0 + 2000);
  assert.equal(scripted.calls.length, 2);
  assert.equal(fs.readFileSync(`${cachePath}.probing`, "utf8"), String(T0 + 2000));
  // Even with a fresh key and a recent sentinel, force probes again (C-5).
  await ensure("force", k2, T0 + 3000);
  assert.equal(scripted.calls.length, 3);
});

test("the cache write is atomic — no temp file is ever left behind", async () => {
  const dir = tempDir();
  const cachePath = path.join(dir, "nested", "claude-advertisement.json");
  const scripted = scriptedProbe([{ options: options("9.1"), source: "probe" }, new Error("boom")]);
  for (const _ of [0, 1]) {
    await ensureClaudeAdvertisement({
      mode: "force",
      probe: scripted.probe,
      cachePath,
      runtimeInfoPath: path.join(dir, "absent.json"),
      env: {},
      now: () => T0,
    });
  }
  const leftovers = fs.readdirSync(path.dirname(cachePath)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
  assert.ok(readClaudeAdvertCache(cachePath)?.lastFailure);
});

test("an advertisement with NO model options is a failure, never an empty 'good' probe", async () => {
  const dir = tempDir();
  const cachePath = path.join(dir, "claude-advertisement.json");
  const view = await ensureClaudeAdvertisement({
    mode: "force",
    probe: async () => ({ options: [], source: "probe" }),
    cachePath,
    runtimeInfoPath: path.join(dir, "absent.json"),
    env: {},
    now: () => T0,
  });
  assert.equal(view.status.state, "none");
  assert.match(view.status.error ?? "", /no `model` options/);
});

test("a garbled cache file is no cache — never a throw", async () => {
  const dir = tempDir();
  const cachePath = path.join(dir, "claude-advertisement.json");
  fs.writeFileSync(cachePath, "{not json");
  assert.equal(readClaudeAdvertCache(cachePath), null);
  const view = await ensureClaudeAdvertisement({
    mode: "never",
    cachePath,
    runtimeInfoPath: path.join(dir, "absent.json"),
    env: {},
  });
  assert.equal(view.status.state, "none");
});

test("the fixture seam: options come from the file and are marked source fixture", async () => {
  const dir = tempDir();
  const wrapped = path.join(dir, "wrapped.json");
  fs.writeFileSync(wrapped, JSON.stringify({ options: options("9.1") }));
  const configForm = path.join(dir, "config.json");
  fs.writeFileSync(
    configForm,
    JSON.stringify([
      { id: "model", type: "select", currentValue: "opus", options: options("9.4") },
    ]),
  );
  const fromWrapped = await probeClaudeAdvertisement({
    agentCommand: DEPLOYED_COMMAND,
    env: { [TEST_ADVERT_ENV]: wrapped },
  });
  assert.equal(fromWrapped.source, "fixture");
  assert.equal(fromWrapped.options[1]?.description, "Opus 9.1 · Test tagline");
  const fromConfig = await probeClaudeAdvertisement({
    agentCommand: DEPLOYED_COMMAND,
    env: { [TEST_ADVERT_ENV]: configForm },
  });
  assert.equal(fromConfig.options[2]?.description, "Sonnet 9.4 · Routine");
  await assert.rejects(
    probeClaudeAdvertisement({
      agentCommand: DEPLOYED_COMMAND,
      env: { [TEST_ADVERT_ENV]: path.join(dir, "absent.json") },
    }),
  );
});

// ── The warm predicate's third term ────────────────────────────────────────────

test("catalogueNeedsWarm: the advertisement term alone decides under scope claude-advertisement", () => {
  const dir = tempDir();
  const runtimeInfoPath = writeRuntimeInfo(dir, "sha-k1");
  const claudeAdvertCachePath = path.join(dir, "claude-advertisement.json");
  // OpenRouter + entitlement caches ABSENT (so scope "all" would warm regardless).
  const deps = {
    cachePath: path.join(dir, "models-cache.json"),
    entitlementCachePath: path.join(dir, "entitlement.json"),
    claudeAdvertCachePath,
    runtimeInfoPath,
    env: {},
    now: () => T0,
  };
  assert.equal(catalogueNeedsWarm({ ...deps, scope: "claude-advertisement" }), true, "cold");
  const key = currentClaudeAdvertKey({ env: {}, runtimeInfoPath });
  fs.writeFileSync(
    claudeAdvertCachePath,
    JSON.stringify({
      schema: CLAUDE_ADVERT_SCHEMA,
      key,
      probedAt: new Date(T0).toISOString(),
      source: "probe",
      options: options("9.1"),
      lastFailure: null,
    }),
  );
  assert.equal(catalogueNeedsWarm({ ...deps, scope: "claude-advertisement" }), false, "fresh key");
  // Scope "all" still warms for the cold OpenRouter caches — the claude scope ignores them.
  assert.equal(catalogueNeedsWarm({ ...deps, scope: "all" }), true);
  // A redeploy (new sha) makes the claude scope warm again.
  assert.equal(
    catalogueNeedsWarm({
      ...deps,
      runtimeInfoPath: writeRuntimeInfo(dir, "sha-k2"),
      scope: "claude-advertisement",
    }),
    true,
  );
});

// ── The CLI, end to end through the real built binary ──────────────────────────

function cliHome(): string {
  const dir = tempDir("acpx-claude-cli-");
  fs.mkdirSync(path.join(dir, ".acpx"), { recursive: true });
  // A fresh OpenRouter cache, so the CLI never reaches the network.
  fs.writeFileSync(
    path.join(dir, ".acpx", "models-cache.json"),
    JSON.stringify({ fetchedAt: new Date().toISOString(), models: [] }),
  );
  return dir;
}

function runCli(args: string[], home: string, env: Record<string, string | undefined> = {}) {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ACPX_STATE_HOME: home,
    HOME: home,
    // No detached warm child outliving the row and writing into a removed HOME.
    ACPX_NO_CATALOGUE_WARM: "1",
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      delete merged[name];
    } else {
      merged[name] = value;
    }
  }
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: merged,
    cwd: os.tmpdir(),
    timeout: 90_000,
  });
}

function claudeNames(stdout: string): string[] {
  const payload = JSON.parse(stdout) as ModelCatalogue;
  return payload.models
    .filter((model) => model.source === "claude-subscription")
    .map((model) => model.name);
}

test("CLI: a different advertisement changes `acpx models` with zero code edits (9.1 → 9.2)", () => {
  const home = cliHome();
  const fixture = path.join(home, "advert.json");
  fs.writeFileSync(fixture, JSON.stringify({ options: options("9.1") }));
  const env = { [TEST_ADVERT_ENV]: fixture };

  const first = runCli(["models", "--refresh", "--json"], home, env);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(claudeNames(first.stdout), [
    "Opus 9.1",
    "Opus 9.1",
    "Sonnet 9.1",
    "Haiku 9.1",
    "Fable 9.1",
  ]);
  const payload = JSON.parse(first.stdout) as ModelCatalogue;
  assert.equal(payload.claudeAdvertisement.state, "fresh");
  assert.equal(payload.claudeAdvertisement.source, "fixture");

  // A plain read serves the CACHE — no probe, same names.
  const cached = runCli(["models", "--json"], home, { [TEST_ADVERT_ENV]: undefined });
  assert.deepEqual(claudeNames(cached.stdout).slice(0, 2), ["Opus 9.1", "Opus 9.1"]);

  fs.writeFileSync(fixture, JSON.stringify({ options: options("9.2") }));
  const second = runCli(["models", "--refresh", "--json"], home, env);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(claudeNames(second.stdout)[2], "Sonnet 9.2");

  // The text surfaces cite it: the list footer and the single-row `show`.
  const listed = runCli(["models", "list", "--agent", "claude"], home);
  assert.match(listed.stdout, /Sonnet 9\.2/);
  assert.match(listed.stdout, /claude labels: claude-agent-acp .* \/ sdk .*, probed .*\[fixture\]/);
  const shown = runCli(["models", "show", "default"], home);
  assert.match(shown.stdout, /name {8}Opus 9\.2/);
  assert.match(shown.stdout, /labels {6}claude-agent-acp .*\[fixture\]/);
  const shownJson = JSON.parse(runCli(["models", "show", "default", "--json"], home).stdout) as {
    advertisedBy?: { source?: string };
  };
  assert.equal(shownJson.advertisedBy?.source, "fixture", "the single-row JSON cites itself");
});

test("CLI D-3: a failing probe with no prior cache shows alias names only, exit 0", () => {
  const home = cliHome();
  const result = runCli(["models", "--refresh", "--json"], home, {
    [TEST_ADVERT_ENV]: undefined,
    ACPX_CLAUDE_ACP_COMMAND: "node /nonexistent/claude-agent-acp/dist/index.js",
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as ModelCatalogue;
  const rows = payload.models.filter((model) => model.source === "claude-subscription");
  assert.deepEqual(
    rows.map((row) => row.name),
    ["Default", "Opus", "Sonnet", "Haiku", "Fable"],
  );
  assert.equal(
    rows.some((row) => /[0-9]/.test(row.name)),
    false,
    "no version digit in any fallback name",
  );
  assert.equal(
    rows.some((row) => row.advertisedBy !== undefined),
    false,
  );
  assert.equal(payload.claudeAdvertisement.state, "none");
  assert.notEqual(payload.claudeAdvertisement.error, null);

  const text = runCli(["models", "list", "--agent", "claude"], home, {
    [TEST_ADVERT_ENV]: undefined,
    ACPX_CLAUDE_ACP_COMMAND: "node /nonexistent/claude-agent-acp/dist/index.js",
  });
  assert.match(text.stdout, /⚠ claude labels unavailable — alias names only/);
  const shown = runCli(["models", "show", "opus"], home);
  assert.match(shown.stdout, /labels {6}fallback \(no advertisement\)/);
});

// ── `acpx sessions reindex` (CONTRACT §2.4 / §5.1-7) ──────────────────────────

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("CLI: `sessions reindex` backfills both fields from the records and never touches a record", () => {
  const home = cliHome();
  const sessionsDir = path.join(home, ".acpx", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const ids = ["reindex-a", "reindex-b"];
  for (const [index, id] of ids.entries()) {
    const record = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-sid`,
      agentCommand: DEPLOYED_COMMAND,
      cwd: "/workspace",
      closed: true,
      acpx: {
        current_model_id: index === 0 ? "opus" : "sonnet",
        served: { model: index === 0 ? "claude-opus-5" : "claude-sonnet-5" },
        config_options: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "default",
            options: [
              { value: "opus", name: "Opus", description: "Opus 5 with 1M context · Best" },
              { value: "sonnet", name: "Sonnet", description: "Sonnet 5 · Routine" },
            ],
          },
        ],
      },
    });
    fs.writeFileSync(
      path.join(sessionsDir, `${encodeURIComponent(id)}.json`),
      `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`,
    );
  }
  // The PRE-CHANGE index shape: entries without the two fields.
  fs.writeFileSync(
    path.join(sessionsDir, "index.json"),
    JSON.stringify({
      schema: "acpx.session-index.v1",
      files: ids.map((id) => `${id}.json`),
      entries: ids.map((id) => ({
        file: `${id}.json`,
        acpxRecordId: id,
        acpSessionId: `${id}-sid`,
        agentCommand: DEPLOYED_COMMAND,
        cwd: "/workspace",
        closed: true,
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      })),
    }),
  );
  const before = ids.map((id) => sha256(path.join(sessionsDir, `${id}.json`)));

  const result = runCli(["--format", "json", "sessions", "reindex"], home);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(payload.action, "sessions_reindexed");
  assert.equal(payload.entries, 2);
  assert.equal(payload.files, 2);
  assert.equal(typeof payload.ms, "number");

  const index = JSON.parse(fs.readFileSync(path.join(sessionsDir, "index.json"), "utf8")) as {
    entries: { acpxRecordId: string; resolvedModelLabel?: string; servedModel?: string }[];
  };
  const byId = new Map(index.entries.map((entry) => [entry.acpxRecordId, entry]));
  // Each closed session gets ITS OWN stored label — truthful history, not today's version.
  assert.equal(byId.get("reindex-a")?.resolvedModelLabel, "Opus 5 (1M)");
  assert.equal(byId.get("reindex-a")?.servedModel, "claude-opus-5");
  assert.equal(byId.get("reindex-b")?.resolvedModelLabel, "Sonnet 5");
  assert.deepEqual(
    ids.map((id) => sha256(path.join(sessionsDir, `${id}.json`))),
    before,
    "records must be byte-identical — only index.json is rewritten",
  );

  const text = runCli(["sessions", "reindex"], home);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^reindexed 2 entries \(2 record files\) in \d+ ms$/m);
});

test("CLI: `sessions reindex bogus` fails loudly — never parsed as a prompt or an agent", () => {
  const result = runCli(["sessions", "reindex", "bogus"], cliHome());
  assert.equal(result.status, 1);
  assert.match(result.stderr, /too many arguments/);
});
