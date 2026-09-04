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

test("a stored CLAUDE-SUBSCRIPTION profile on a codex record no longer wins (B0.2 widened the guard)", async () => {
  await withRegistry(
    {
      defaultId: "sub1",
      profiles: [subscriptionProfile("sub1", "/home/node/.acpx/subscriptions/sub1")],
    },
    async (loadOpts) => {
      // ⚠️ THIS TEST'S PROPERTY WAS DELIBERATELY INVERTED BY B0.2, and the reason
      // is that the old property could only ever hold for a record that cannot
      // spawn. It read: "an explicit stored profile still wins for a codex record
      // (guard only withholds the DEFAULT)".
      //
      // The record it pinned is a codex record carrying a Claude *subscription*
      // profile. `assertCodexProfileCompatibility` (src/acp/auth-env.ts) throws
      // for exactly that combination — "profile ... cannot be used with the codex
      // adapter" — so such a record is already refused at spawn. 56 of them were
      // measured on devbox on 2026-09-04 (53 codex, 2 opencode, 1 pi); they are
      // the wedged population `acpx sessions repair-account-seam` exists to free.
      // Answering "yes, failover is enabled" for a record that can never take a
      // turn is not a capability, it is the corruption being believed.
      //
      // ⚠️ NOTE WHAT DID **NOT** CHANGE, which is what keeps the codex guardrail
      // intact: a LEGITIMATE codex record — no profile, or a `chatgpt` profile —
      // is byte-identically unaffected. It already resolved to false, because
      // `failoverEnabledForRecord` requires `transcriptAnchorDir(profile) !== null`
      // and that is null for `chatgpt` (CONCEPTION §5.5). The two cases below pin
      // both directions.
      const codexWithClaudeSubscription = recordFor(CODEX_AGENT, { profile: "sub1" });
      assert.equal(failoverEnabledForRecord(codexWithClaudeSubscription, loadOpts), false);

      // The Claude-family control on the same registry and the same stored value:
      // the guard is about the ADAPTER, not about the profile being stored.
      const claudeWithSameProfile = recordFor(CLAUDE_AGENT, { profile: "sub1" });
      assert.equal(failoverEnabledForRecord(claudeWithSameProfile, loadOpts), true);
    },
  );
});
