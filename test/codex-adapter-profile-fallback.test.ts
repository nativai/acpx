import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  failoverEnabledForRecord,
  selectSubscriptionBeforeTurn,
} from "../src/runtime/engine/failover.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Regression: codex sessions authenticate from native ~/.codex (a chatgpt profile
// or none). The subauto pre-turn selector forced the registry's Claude-subscription
// `default` onto codex records that carried no stored profile, and the codex adapter
// rejected that profile at turn auth — killing every codex-session turn in ~13ms.
// The fix makes the default fallback adapter-aware: a codex record with no stored
// profile resolves to NO profile (native auth), so currentProfile()/failover/subauto
// all no-op for it, exactly as before subauto. (brick://792ad0a4)

const CLAUDE_AGENT = "node /opt/claude-agent-acp/dist/index.js";
const CODEX_AGENT = "node /opt/codex-acp/dist/index.js";

type RegistryProfile = Record<string, unknown>;

async function withRegistry<T>(
  setup: { defaultId?: string; profiles: RegistryProfile[] },
  run: (lookupOptions: { homeDir: string; registryPath: string }) => Promise<T>,
): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-codex-fallback-"));
  try {
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    await fs.mkdir(subsDir, { recursive: true });
    const registryPath = path.join(subsDir, "registry.json");
    await fs.writeFile(
      registryPath,
      JSON.stringify(
        {
          version: 3,
          ...(setup.defaultId ? { default: setup.defaultId } : {}),
          profiles: setup.profiles,
        },
        null,
        2,
      ),
    );
    return await run({ homeDir, registryPath });
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function subscriptionProfile(id: string, configDir: string): RegistryProfile {
  return {
    id,
    label: id,
    authMode: "subscription",
    adapter: "claude",
    credentialSource: configDir,
    account: id,
  };
}

function recordFor(
  agentCommand: string,
  sessionOptions: Record<string, unknown> = {},
): SessionRecord {
  return makeSessionRecord(
    {
      acpxRecordId: `rec-${agentCommand.length}`,
      acpSessionId: "acp",
      agentCommand,
      cwd: "/workspace/codex-fallback",
      acpx: { session_options: sessionOptions },
    },
    { resolveCwd: false },
  );
}

test("codex session with no stored profile does NOT inherit the subscription default (the fix)", async () => {
  await withRegistry(
    {
      defaultId: "sub1",
      profiles: [subscriptionProfile("sub1", "/home/node/.acpx/subscriptions/sub1")],
    },
    async (loadOpts) => {
      const codex = recordFor(CODEX_AGENT);
      // currentProfile() resolves to undefined → no subscription profile is forced on.
      assert.equal(failoverEnabledForRecord(codex, loadOpts), false);
      // And the subauto pre-turn selector no-ops for it (returns {} before any probe) —
      // the exact path that used to persist an incompatible sub6 into the codex record.
      assert.deepEqual(await selectSubscriptionBeforeTurn(codex, loadOpts), {});
    },
  );
});

test("claude session with no stored profile still inherits the subscription default (unaffected)", async () => {
  await withRegistry(
    {
      defaultId: "sub1",
      profiles: [subscriptionProfile("sub1", "/home/node/.acpx/subscriptions/sub1")],
    },
    async (loadOpts) => {
      const claude = recordFor(CLAUDE_AGENT);
      // The default fallback is intact for the Claude adapter: currentProfile() = sub1,
      // which has a transcript anchor → failover is enabled exactly as before.
      assert.equal(failoverEnabledForRecord(claude, loadOpts), true);
    },
  );
});

test("an explicit stored profile still wins for a codex record (guard only withholds the DEFAULT)", async () => {
  await withRegistry(
    {
      defaultId: "sub1",
      profiles: [subscriptionProfile("sub1", "/home/node/.acpx/subscriptions/sub1")],
    },
    async (loadOpts) => {
      // A codex record that explicitly stored a subscription profile still resolves it
      // (storedSelectionId path is untouched) — the fix narrowly withholds only the
      // registry-default fallback, it does not blanket-disable selection for codex.
      const codexWithExplicit = recordFor(CODEX_AGENT, { profile: "sub1" });
      assert.equal(failoverEnabledForRecord(codexWithExplicit, loadOpts), true);
    },
  );
});
