import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acpAdapterKind,
  isClaudeFamilyAgent,
  resolvePrimerChannel,
} from "../src/acp/agent-command.js";
import { applyProfileAuth, resolveAcpxUiBaseUrl } from "../src/acp/auth-env.js";
import { buildAgentSpawnOptions } from "../src/acp/client.js";
import { getValidEffortsForProfile, loadProfileRegistry } from "../src/config/profiles.js";
import type { SubscriptionLookupOptions } from "../src/config/subscriptions.js";

const SDK_CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";

// A REAL agent_command, sampled 2026-10-02 from three session records under
// ~/.acpx/sessions/ (agent_command field only). The claude-pty adapter is removed;
// stale records still carry this string. It must classify as UNKNOWN — never fall
// through to `claude`, which would hand a dead adapter the SDK adapter's handling.
const STALE_CLAUDE_PTY_COMMAND = "node /opt/claude-pty-acp/dist/index.js";

test("a stale record's removed-adapter command classifies as unknown, not claude", () => {
  assert.equal(acpAdapterKind(STALE_CLAUDE_PTY_COMMAND), undefined);
  assert.equal(resolvePrimerChannel(STALE_CLAUDE_PTY_COMMAND), "none");
  assert.equal(isClaudeFamilyAgent(STALE_CLAUDE_PTY_COMMAND), false);
  // control: the real SDK-adapter command still classifies
  assert.equal(acpAdapterKind(SDK_CLAUDE_COMMAND), "claude");
  assert.equal(resolvePrimerChannel(SDK_CLAUDE_COMMAND), "system-prompt");
});

type ProfilesHomeContext = {
  lookupOptions: SubscriptionLookupOptions;
  homeDir: string;
};

async function withProfilesHome(
  registry: unknown,
  run: (ctx: ProfilesHomeContext) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-auth-env-"));
  try {
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    await fs.mkdir(subsDir, { recursive: true });
    const registryPath = path.join(subsDir, "registry.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));
    await run({ lookupOptions: { homeDir, registryPath }, homeDir });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

const HYBRID_REGISTRY = {
  default: "sub1",
  // v1 list stays readable by old binaries / --subscription
  subscriptions: [
    { id: "sub1", label: "Max 20x - 1" },
    { id: "sub2", label: "Max 20x - 2" },
  ],
  profiles: [{ id: "sub1", label: "Max 20x - 1", harness: "claude", authMode: "subscription" }],
};

test("getValidEffortsForProfile: subscription profiles use the Claude effort ladder", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const registry = loadProfileRegistry(ctx.lookupOptions);
    const sub1 = registry.profiles.find((p) => p.id === "sub1");
    assert.ok(sub1);
    assert.deepEqual(getValidEffortsForProfile(sub1), ["low", "medium", "high", "xhigh", "max"]);
  });
});

test("resolveAcpxUiBaseUrl: explicit ACPX_UI_BASE_URL wins and is trimmed", () => {
  assert.equal(
    resolveAcpxUiBaseUrl({ ACPX_UI_BASE_URL: "https://acpx.labidio.nativai.de/" }),
    "https://acpx.labidio.nativai.de",
  );
});

test("adapter env carries acpx's resolved base URL (the seam adapters consume)", () => {
  // ⚠️ SCRUB THE VARIABLE FIRST — without this the test passes on a build that has
  // dropped the handoff entirely. `buildAgentEnvironment` starts from
  // `{...process.env}`, so on any box whose pod env carries ACPX_UI_BASE_URL the
  // child INHERITS the right answer and the assertion cannot tell inheritance from
  // the assignment. Measured 2026-09-11 on devbox: deleting the handoff left this
  // test green until the scrub was added. Scrubbed, the child can only obtain the
  // value from acpx resolving it (rungs 2–3) and writing it down — which is the
  // case an adapter's deleted copy existed to cover.
  const restore = process.env.ACPX_UI_BASE_URL;
  delete process.env.ACPX_UI_BASE_URL;
  try {
    // Pin to THIS box's own resolution rather than a literal: the claim is that the
    // child is told what acpx decided, not that any one box's answer is a constant.
    const expected = resolveAcpxUiBaseUrl(process.env);
    // …but `undefined === undefined` would pass while proving nothing, so require
    // that rungs 2–3 actually answered here. A box where they do not is covered by
    // the degraded-path test below, not by this one.
    assert.ok(
      expected,
      "rungs 2-3 must resolve on the box running this suite, or this assertion is vacuous",
    );
    for (const agentCommand of [SDK_CLAUDE_COMMAND, "claude", "codex"]) {
      const { env } = buildAgentSpawnOptions(process.cwd(), undefined, undefined, {}, agentCommand);
      assert.equal(
        env.ACPX_UI_BASE_URL,
        expected,
        `${agentCommand} must be handed acpx's resolved base URL`,
      );
    }
  } finally {
    if (restore === undefined) {
      delete process.env.ACPX_UI_BASE_URL;
    } else {
      process.env.ACPX_UI_BASE_URL = restore;
    }
  }
});

test("adapter env: a padded / trailing-slash ACPX_UI_BASE_URL is NORMALIZED for the child", () => {
  // The child must see the exact string acpx built its own URLs from. Handing the
  // raw env value down instead would give the adapter `https://host//?session=…`
  // where acpx composed `https://host/?session=…` — two spellings of one session.
  const restore = process.env.ACPX_UI_BASE_URL;
  process.env.ACPX_UI_BASE_URL = "  https://acpx.devbox.konsiq.de//  ";
  try {
    const spawnOptions = buildAgentSpawnOptions(
      process.cwd(),
      undefined,
      { acpxRecordId: "rec-1" },
      {},
      SDK_CLAUDE_COMMAND,
    );
    assert.equal(spawnOptions.env.ACPX_UI_BASE_URL, "https://acpx.devbox.konsiq.de");
    assert.equal(spawnOptions.env.ACPX_SESSION_URL, "https://acpx.devbox.konsiq.de/?session=rec-1");
  } finally {
    if (restore === undefined) {
      delete process.env.ACPX_UI_BASE_URL;
    } else {
      process.env.ACPX_UI_BASE_URL = restore;
    }
  }
});

test("adapter env: an unresolvable box leaves the URL keys UNSET — never fabricated", () => {
  // The degraded path cannot be reached in-process: the source files are read once
  // and cached, and on a control-plane pod /proc/1/environ answers rung 2 whatever
  // the env says. So drive it in a CHILD with the env scrubbed and the hostmap cache
  // pointed at nothing, and assert the SAME expression in both outcomes — the child
  // env must carry exactly what the resolver returned, and nothing when it returned
  // nothing. That way the test is meaningful on a pod where rung 2 answers (it pins
  // the handoff) and on one where nothing answers (it pins the omission), and it can
  // never pass by being vacuous. Re-add any constructed fallback and the branch that
  // returned null here starts returning a host, failing the `?? undefined` equality.
  const script = [
    `process.env.ACPX_HOSTMAP_CACHE_FILE = "/nonexistent-f29ba473/hostmap-cache.json";`,
    `delete process.env.ACPX_UI_BASE_URL;`,
    `const { resolveAcpxUiBaseUrl } = await import("./dist-test/src/acp/auth-env.js");`,
    `const { buildAgentSpawnOptions } = await import("./dist-test/src/acp/client.js");`,
    `const resolved = resolveAcpxUiBaseUrl(process.env) ?? null;`,
    `const { env } = buildAgentSpawnOptions(process.cwd(), undefined, { acpxRecordId: "rec-1" }, {}, "node /opt/claude-agent-acp/dist/index.js");`,
    `process.stdout.write(JSON.stringify({ resolved, base: env.ACPX_UI_BASE_URL ?? null, session: env.ACPX_SESSION_URL ?? null }));`,
  ].join("\n");
  const childEnv = { ...process.env };
  delete childEnv.ACPX_UI_BASE_URL;
  const raw = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: childEnv,
    encoding: "utf8",
  });
  const { resolved, base, session } = JSON.parse(raw) as {
    resolved: string | null;
    base: string | null;
    session: string | null;
  };
  assert.equal(base, resolved, "the child's ACPX_UI_BASE_URL must be exactly what acpx resolved");
  assert.equal(session, resolved === null ? null : `${resolved}/?session=rec-1`);
});

test("applyProfileAuth: subscription profile on the SDK agent stays byte-identical (no gate misfire)", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const subsDir = path.join(ctx.homeDir, ".acpx", "subscriptions");
    await fs.mkdir(path.join(subsDir, "sub1"), { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    const shim = await applyProfileAuth(
      env,
      "sub1",
      "session-1",
      "max",
      ctx.lookupOptions,
      SDK_CLAUDE_COMMAND,
    );
    assert.equal(shim, null);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(subsDir, "sub1"));
    assert.equal("INDEPENDENT_CLAUDE_HOME_MAP" in env, false);
  });
});

test("applyProfileAuth treats default reasoning effort as no override for subscription profiles", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const subsDir = path.join(ctx.homeDir, ".acpx", "subscriptions");
    await fs.mkdir(path.join(subsDir, "sub1"), { recursive: true });
    const env: NodeJS.ProcessEnv = {};
    const shim = await applyProfileAuth(
      env,
      "sub1",
      "session-1",
      "default",
      ctx.lookupOptions,
      SDK_CLAUDE_COMMAND,
    );

    assert.equal(shim, null);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(subsDir, "sub1"));
  });
});

test("applyProfileAuth validates explicit reasoning effort against the selected profile type", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const subsDir = path.join(ctx.homeDir, ".acpx", "subscriptions");
    await fs.mkdir(path.join(subsDir, "sub1"), { recursive: true });

    await assert.rejects(
      applyProfileAuth({}, "sub1", "session-1", "minimal", ctx.lookupOptions, SDK_CLAUDE_COMMAND),
      /--reasoning-effort "minimal" is not valid for profile "sub1" \(subscription\).*low, medium, high, xhigh, max/s,
    );
  });
});

test("buildAgentSpawnOptions (SDK claude): subscription resolution unchanged when agentCommand is passed", async () => {
  await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
    const subsDir = path.join(ctx.homeDir, ".acpx", "subscriptions");
    await fs.mkdir(path.join(subsDir, "sub1"), { recursive: true });
    const options = buildAgentSpawnOptions(
      "/tmp/acpx-auth-env-cwd",
      undefined,
      { acpxRecordId: "rec", subscriptionId: "sub1" },
      ctx.lookupOptions,
      SDK_CLAUDE_COMMAND,
    );
    assert.equal(options.env.CLAUDE_CONFIG_DIR, path.join(subsDir, "sub1"));
  });
});

// brick 92121ff9 — the OpenRouter capability knob must stay OFF the Anthropic
// path: subscription Opus/Sonnet 5.5 need per-turn effort and friends. These are
// the negative cases for the shim-path rows in openrouter-picker-turn.test.ts.
async function withScrubbedCapabilitiesEnv(
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const previous = process.env.CLAUDE_CODE_MODEL_CAPABILITIES;
  if (value === undefined) {
    delete process.env.CLAUDE_CODE_MODEL_CAPABILITIES;
  } else {
    process.env.CLAUDE_CODE_MODEL_CAPABILITIES = value;
  }
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CODE_MODEL_CAPABILITIES;
    } else {
      process.env.CLAUDE_CODE_MODEL_CAPABILITIES = previous;
    }
  }
}

test("92121ff9 · a subscription (non-shim) claude spawn carries NO capability knob", async () => {
  await withScrubbedCapabilitiesEnv(undefined, async () => {
    await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
      const subsDir = path.join(ctx.homeDir, ".acpx", "subscriptions");
      await fs.mkdir(path.join(subsDir, "sub1"), { recursive: true });
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-auth-env-cwd",
        undefined,
        { acpxRecordId: "rec", subscriptionId: "sub1" },
        ctx.lookupOptions,
        SDK_CLAUDE_COMMAND,
      );
      const shim = await applyProfileAuth(
        options.env,
        "sub1",
        "session-1",
        "high",
        ctx.lookupOptions,
        SDK_CLAUDE_COMMAND,
      );
      assert.equal(shim, null);
      assert.equal("CLAUDE_CODE_MODEL_CAPABILITIES" in options.env, false);
    });
  });
});

test("92121ff9 · an operator's own knob on a non-shim spawn passes through UNCHANGED", async () => {
  await withScrubbedCapabilitiesEnv("claude-opus-5-5=-fast_mode", async () => {
    await withProfilesHome(HYBRID_REGISTRY, async (ctx) => {
      const subsDir = path.join(ctx.homeDir, ".acpx", "subscriptions");
      await fs.mkdir(path.join(subsDir, "sub1"), { recursive: true });
      const options = buildAgentSpawnOptions(
        "/tmp/acpx-auth-env-cwd",
        undefined,
        { acpxRecordId: "rec", subscriptionId: "sub1" },
        ctx.lookupOptions,
        SDK_CLAUDE_COMMAND,
      );
      assert.equal(options.env.CLAUDE_CODE_MODEL_CAPABILITIES, "claude-opus-5-5=-fast_mode");
    });
  });
});
