// Regression lock for two HIGH spawn-correctness bugs, both already fixed on the
// deployed build (acpx 028b6a8 + adapter d3adb9d) and independently re-verified
// behaviorally by the test-engineer (see the task folder's VERIFICATION.md):
//
//   BUG1 cli-subscription-flag-records-but-does-not-apply — `--subscription X`
//        recorded the selection but the agent spawned under the registry default
//        home → silent budget violation.
//   BUG2 spawn-flags-ignored-effort-config-rejected — `--model`/`--reasoning-effort`
//        silently ignored; `--reasoning-effort` aborted the turn with
//        "Unknown config option: effort".
//
// These tests LOCK the seams so the fix cannot silently re-break. They assert
// BEHAVIORAL signals at the seams (not the `status`/record fields, which the
// CONCEPTION flagged as unreliable intent-echoes). The end-to-end inference-time
// signals (transcript message.model, billed account, low-vs-max thinking volume)
// are exercised by the documented live runbook in VERIFICATION.md (T1–T3); these
// CI-tier sentinels lock the deterministic seams that carry the flag to the live
// adapter (T4 of CONCEPTION §6).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentSpawnOptions } from "../src/acp/client.js";
import { resetKnownDeadSubs } from "../src/config/known-dead-subscriptions.js";
import type { SubscriptionLookupOptions } from "../src/config/subscriptions.js";
import { connectAndLoadSession } from "../src/runtime/engine/reconnect.js";
import {
  makeSessionRecord,
  withTempHome as withReconnectTempHome,
} from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
// --advertise-models so the mock accepts session/set_model (it advertises
// opus/sonnet/haiku); without it set_model is rejected and `sessions new --model`
// would fail to spawn before the record is written.
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)} --advertise-models`;
// Repo-root/src — the committed TypeScript source the threading sentinel reads.
// import.meta.url == <repo>/dist-test/test/<file>.js → ../../src == <repo>/src.
const SRC_DIR = fileURLToPath(new URL("../../src/", import.meta.url));

// ---------------------------------------------------------------------------
// T4.3 — BUG1 sink seam (behavioral): buildAgentEnvironment, when a profileId is
// set, must NOT fall back to the registry default home. The original bug: the
// selection was recorded under session_options.profile but the spawn path keyed
// off the (now-empty) subscription field, so applySubscriptionConfigDir(null)
// resolved the registry DEFAULT — silently landing a profile-pinned session on
// the wrong account. The fix gates that synchronous default-resolution behind
// "no profileId"; when a profileId is present the async profile-auth path owns
// CLAUDE_CONFIG_DIR, so the synchronous build must leave it UNSET (never default).
// ---------------------------------------------------------------------------

// Hermetic: inject a temp registry + temp configDirs via the 4th lookupOptions
// arg so we never read this box's real ~/.acpx, and scrub ambient Claude-account
// env so ABSENT assertions are meaningful regardless of how the runner launched.
type SubsHomeContext = {
  lookupOptions: SubscriptionLookupOptions;
  configDir: (id: string) => string;
};

async function withSubscriptionsHome(
  setup: { registry?: unknown; existingDirs?: string[] },
  run: (ctx: SubsHomeContext) => Promise<void>,
): Promise<void> {
  const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const previousAcpxSubscription = process.env.ACPX_SUBSCRIPTION;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.ACPX_SUBSCRIPTION;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-spawnlock-subs-"));
  try {
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    await fs.mkdir(subsDir, { recursive: true });
    if (setup.registry !== undefined) {
      await fs.writeFile(path.join(subsDir, "registry.json"), JSON.stringify(setup.registry));
    }
    for (const id of setup.existingDirs ?? []) {
      await fs.mkdir(path.join(subsDir, id), { recursive: true });
    }
    await run({
      lookupOptions: { homeDir, registryPath: path.join(subsDir, "registry.json") },
      configDir: (id) => path.join(subsDir, id),
    });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    if (previousAcpxSubscription === undefined) {
      delete process.env.ACPX_SUBSCRIPTION;
    } else {
      process.env.ACPX_SUBSCRIPTION = previousAcpxSubscription;
    }
  }
}

function hasClaudeConfigDir(env: NodeJS.ProcessEnv): boolean {
  return Object.prototype.hasOwnProperty.call(env, "CLAUDE_CONFIG_DIR");
}

// default=sub1 deliberately: it is the exact trap of the filed bug — a session
// whose intended account is sub2 must NOT fall through to the sub1 default.
const REGISTRY_DEFAULT_SUB1 = {
  default: "sub1",
  subscriptions: [
    { id: "sub1", label: "One" },
    { id: "sub2", label: "Two" },
  ],
};

test("T4.3 BUG1: profileId set → buildAgentEnvironment does NOT fall back to the registry default home", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: REGISTRY_DEFAULT_SUB1, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        // profileId carries the recorded selection (sub2); NO subscriptionId — the
        // exact shape the deployed code threads from session_options.profile.
        { acpxRecordId: "rec", profileId: "sub2" },
        ctx.lookupOptions,
      );
      // The synchronous build must NOT set CLAUDE_CONFIG_DIR (the async profile-auth
      // path owns it). The bug would have set it to the DEFAULT (sub1) home.
      assert.equal(
        hasClaudeConfigDir(options.env),
        false,
        "profileId-bearing spawn must not synchronously resolve CLAUDE_CONFIG_DIR (esp. not the default)",
      );
      assert.notEqual(
        options.env.CLAUDE_CONFIG_DIR,
        ctx.configDir("sub1"),
        "profileId-bearing spawn must never land on the registry default (sub1) home",
      );
    },
  );
});

test("T4.3 BUG1 (exact bug shape): profileId=sub2 wins even when a legacy subscriptionId=sub1 is also present", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: REGISTRY_DEFAULT_SUB1, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "rec", profileId: "sub2", subscriptionId: "sub1" },
        ctx.lookupOptions,
      );
      // profileId presence suppresses the synchronous subscription path entirely,
      // so the legacy subscriptionId=sub1 cannot drag the session onto sub1.
      assert.equal(hasClaudeConfigDir(options.env), false);
      assert.notEqual(options.env.CLAUDE_CONFIG_DIR, ctx.configDir("sub1"));
    },
  );
});

test("T4.3 W14-01: NO profileId/subscriptionId → env builder no longer late-binds registry default", async () => {
  resetKnownDeadSubs();
  await withSubscriptionsHome(
    { registry: REGISTRY_DEFAULT_SUB1, existingDirs: ["sub1", "sub2"] },
    async (ctx) => {
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-agent",
        undefined,
        { acpxRecordId: "rec" }, // no profileId, no subscriptionId
        ctx.lookupOptions,
      );
      // W14-01 moved default selection out of buildAgentEnvironment. New and
      // first-used sessions are bound to a concrete profile/subscription before
      // spawn; an actually unbound context must stay raw here.
      assert.equal(hasClaudeConfigDir(options.env), false);
      assert.equal(options.env.ACPX_SUBSCRIPTION, undefined);
    },
  );
});

// ---------------------------------------------------------------------------
// T4.1 — BUG1/BUG2 recording seam (behavioral, end-to-end via the real CLI):
// sessionOptionsFromGlobalFlags maps BOTH `--subscription X` and `--profile X`
// onto session_options.profile === "X" (profile takes priority when both given),
// and `--model X` onto session_options.model. We drive the actual `acpx` binary
// against a hermetic HOME + a mock ACP agent, then read the persisted record.
// (sessionOptionsFromGlobalFlags is module-private; this exercises the whole
// flag→record chain through the real entrypoint, which is a stronger lock than a
// unit test of the private function would be.)
// ---------------------------------------------------------------------------

type CliRunResult = { code: number | null; stdout: string; stderr: string };

async function runCli(args: string[], homeDir: string, cwd: string): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdin.end();
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withSubscriptionHome(
  run: (homeDir: string, cwd: string) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-spawnlock-cli-"));
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const subsRoot = path.join(homeDir, ".acpx", "subscriptions");
    await fs.mkdir(path.join(subsRoot, "sub1"), { recursive: true });
    await fs.mkdir(path.join(subsRoot, "sub2"), { recursive: true });
    await fs.writeFile(
      path.join(subsRoot, "registry.json"),
      `${JSON.stringify({
        version: 3,
        default: "sub1",
        profiles: [
          {
            id: "sub1",
            label: "Sub 1",
            authMode: "subscription",
            adapter: "claude",
            account: "acct-a",
            credentialSource: path.join(subsRoot, "sub1"),
          },
          {
            id: "sub2",
            label: "Sub 2",
            authMode: "subscription",
            adapter: "claude",
            account: "acct-b",
            credentialSource: path.join(subsRoot, "sub2"),
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    // Point the claude agent at the mock ACP server so no real Claude spawns.
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { claude: { command: MOCK_AGENT_COMMAND } } }, null, 2)}\n`,
      "utf8",
    );
    await run(homeDir, cwd);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function newSessionAndReadOptions(
  homeDir: string,
  cwd: string,
  globalFlags: string[],
  name: string,
): Promise<{ profile?: unknown; subscription?: unknown; model?: unknown }> {
  const result = await runCli(
    ["--cwd", cwd, "--format", "json", ...globalFlags, "claude", "sessions", "new", "--name", name],
    homeDir,
    cwd,
  );
  assert.equal(result.code, 0, `sessions new failed: ${result.stderr}`);
  const payload = JSON.parse(result.stdout.trim()) as { acpxRecordId?: string };
  const recordId = String(payload.acpxRecordId);
  const stored = JSON.parse(
    await fs.readFile(
      path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(recordId)}.json`),
      "utf8",
    ),
  ) as {
    acpx?: { session_options?: { profile?: unknown; subscription?: unknown; model?: unknown } };
  };
  return stored.acpx?.session_options ?? {};
}

test("T4.1 BUG1: --subscription X records session_options.profile === X (unified profile field)", async () => {
  await withSubscriptionHome(async (homeDir, cwd) => {
    const opts = await newSessionAndReadOptions(
      homeDir,
      cwd,
      ["--subscription", "sub2"],
      "lock-sub",
    );
    assert.equal(opts.profile, "sub2");
  });
});

test("T4.1 BUG1: --profile X records session_options.profile === X", async () => {
  await withSubscriptionHome(async (homeDir, cwd) => {
    const opts = await newSessionAndReadOptions(homeDir, cwd, ["--profile", "sub2"], "lock-prof");
    assert.equal(opts.profile, "sub2");
  });
});

test("T4.1 BUG1: --profile wins over --subscription when both are given", async () => {
  await withSubscriptionHome(async (homeDir, cwd) => {
    const opts = await newSessionAndReadOptions(
      homeDir,
      cwd,
      ["--profile", "sub2", "--subscription", "sub1"],
      "lock-both",
    );
    assert.equal(opts.profile, "sub2");
  });
});

test("T4.1 BUG2: --model X is recorded onto session_options.model", async () => {
  await withSubscriptionHome(async (homeDir, cwd) => {
    const opts = await newSessionAndReadOptions(homeDir, cwd, ["--model", "sonnet"], "lock-model");
    assert.equal(opts.model, "sonnet");
  });
});

// ---------------------------------------------------------------------------
// T4.2 — BUG1 threading sentinel (structural): every spawn-context builder must
// thread profileId from the recorded session_options.profile. The fix wired this
// into four exec paths; if a future refactor drops the threading at any of them,
// a profile-pinned session would again resolve the env without its profileId and
// could silently default-home. These builders are deep async functions not unit-
// callable in isolation, so this asserts the wiring is present at each site. The
// BEHAVIORAL coverage of the consequence lives in T4.3 (the sink) and the live
// T1 runbook (record → real adapter home). Labeled structural in VERIFICATION.md.
// ---------------------------------------------------------------------------

const PROFILE_THREADING_SITES = [
  "runtime/engine/connected-session.ts",
  "cli/session/queue-owner-runtime.ts",
  "cli/session/runtime.ts",
  "cli/session/session-management.ts",
];

// profileId assigned from <something>.session_options?.profile OR
// options.sessionOptions?.profile (session-management threads from the options).
const THREADING_RE =
  /profileId:\s*[^,\n]*(?:session_options\?\.\s*profile|sessionOptions\?\.\s*profile)/;

for (const site of PROFILE_THREADING_SITES) {
  test(`T4.2 BUG1: ${site} threads profileId from session_options.profile`, async () => {
    const source = await fs.readFile(path.join(SRC_DIR, site), "utf8");
    assert.match(
      source,
      THREADING_RE,
      `${site} must thread profileId from the recorded session_options.profile`,
    );
  });
}

// ---------------------------------------------------------------------------
// HAIKU-FIX lock (sibling defect, fix 9bae3c7 in src/runtime/engine/reconnect.ts;
// task bugs/haiku-effort-replay-loses-first-turn). A fresh `--model haiku` spawn
// deterministically LOST its first turn: the deployed adapter advertises an
// `effort` option at session/new for haiku yet REJECTS set_config_option(effort)
// for it, so replaying the persisted/inherited effort (added by BUG2 fix 2ff3498)
// on the fresh ACP session threw a fatal SessionConfigOptionReplayError. The fix
// makes that replay NON-FATAL — but ONLY for `effort` AND only on a genuine ACP
// rejection (extractAcpError payload); every other config option, and an effort
// transport failure (no ACP payload), still throws fatally.
//
// These drive the REAL reconnect path connectAndLoadSession →
// replayDesiredConfigOptions → handleConfigOptionReplayError with a mock client
// (the handler is module-private; this locks it through its exported entrypoint).
// BEHAVIORAL signal: the reconnect RESOLVES (turn proceeds) vs REJECTS (turn lost).
// ---------------------------------------------------------------------------

const RECONNECT_ACTIVE_CONTROLLER = {
  hasActivePrompt: () => false,
  requestCancelActivePrompt: async () => false,
  setSessionMode: async () => {},
  setSessionModel: async () => {},
  setSessionConfigOption: async () => ({ configOptions: [] }),
};

// A fresh-session reconnect: the stale session is gone (load → -32002 not found),
// so connectAndLoadSession creates a fresh session and replays desired config
// options onto it via setSessionConfigOption — whose behavior we inject per test.
function makeReconnectClient(
  setSessionConfigOption: (sessionId: string, configId: string, value: string) => Promise<unknown>,
) {
  return {
    hasReusableSession: () => false,
    start: async () => {},
    getAgentLifecycleSnapshot: () => ({ running: true }),
    supportsLoadSession: () => true,
    supportsResumeSession: () => false,
    loadSessionWithOptions: async () => {
      throw { error: { code: -32002, message: "session not found" } };
    },
    createSession: async () => ({ sessionId: "fresh-session", agentSessionId: "fresh-runtime" }),
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption,
  };
}

test("HAIKU-fix: effort replay rejected by the adapter (ACP error) is NON-FATAL — first turn proceeds", async () => {
  await withReconnectTempHome("acpx-haikufix-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "haiku-effort-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: { desired_config_options: { effort: "high" } },
    });
    let attempted = false;
    const client = makeReconnectClient(async (_sessionId, configId) => {
      attempted = true;
      assert.equal(configId, "effort");
      // mirrors deployed haiku: adapter rejects the effort mutation (-32603)
      throw { error: { code: -32603, message: "Unknown config option: effort" } };
    });
    // Resolves (does NOT throw) → the first turn is NOT lost.
    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: RECONNECT_ACTIVE_CONTROLLER as never,
    });
    assert.equal(attempted, true, "effort replay must have been attempted");
    assert.equal(result.sessionId, "fresh-session");
  });
});

// ⚠️ REVERSED DELIBERATELY, 2026-08-28 (brick://874fee67 F1). This test used to
// assert the OPPOSITE — that a NON-effort config-option rejection still throws
// fatally — as a scope guard keeping the haiku effort fix from over-broadening.
// That conservatism was reasonable when written and the field has since falsified
// it: the narrow scope KILLED SESSIONS.
//
// What happened: acpx auto-failover moved a session to another subscription on
// its first turn. A custom output style resolves per `CLAUDE_CONFIG_DIR`, so it
// did not exist under the new one; the adapter correctly declined to advertise
// it; acpx replayed `set_config_option` anyway and this fatal rethrow took the
// whole turn down — the user got NO REPLY AT ALL. Auto-failover is on by default
// and re-picks the subscription every turn, so that was the ordinary path for any
// session carrying a custom style.
//
// THE GUARD STILL EXISTS — it just guards the right axis. The discriminator was
// never really "is this effort?"; it is "did the AGENT decline, or did the
// TRANSPORT fail?". A decline is information and degrades; a transport failure
// means we do not know the backend state and must still rethrow (pinned by the
// sibling test below, which is unchanged and now carries the whole guard).
//
// Safe because `desired_config_options` structurally cannot hold a correctness
// pin: `setDesiredConfigOption` early-returns for `mode` and `model`, which have
// their own replay paths. Everything reaching this loop is a preference.
test("F1: a NON-effort config option rejection DEGRADES rather than killing the turn", async () => {
  await withReconnectTempHome("acpx-haikufix-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "other-config-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: { desired_config_options: { thought_level: "deep" } },
    });
    let attempted = false;
    const client = makeReconnectClient(async () => {
      attempted = true;
      throw { error: { code: -32603, message: "rejected" } };
    });
    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: RECONNECT_ACTIVE_CONTROLLER as never,
    });
    assert.equal(attempted, true, "subject witness: the replay must have been attempted");
    assert.equal(result.sessionId, "fresh-session", "the turn survives the declined option");
  });
});

test("HAIKU-fix scope guard: an effort replay TRANSPORT failure (no ACP payload) still throws fatally", async () => {
  await withReconnectTempHome("acpx-haikufix-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const record = makeSessionRecord({
      acpxRecordId: "effort-transport-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: { desired_config_options: { effort: "high" } },
    });
    const client = makeReconnectClient(async () => {
      // a transport failure carries NO ACP error payload → must rethrow (retryable)
      throw new Error("socket hang up");
    });
    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: RECONNECT_ACTIVE_CONTROLLER as never,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionConfigOptionReplayError");
        assert.equal((error as Error & { retryable?: boolean }).retryable, true);
        return true;
      },
    );
  });
});
