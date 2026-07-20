import assert from "node:assert/strict";
import test from "node:test";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import type { SessionAgentOptions } from "../src/runtime/engine/session-options.js";
import type { SessionRecord } from "../src/types.js";
import {
  createRuntimeOptions,
  InMemorySessionStore,
  makeSessionRecord,
} from "./runtime-test-helpers.js";

// A fresh-create respawn (reset_on_next_ensure / recover / resume-id-mismatch)
// rebuilds the record from scratch. Without the auto_failover policy carry-forward
// at manager.ts createAndSaveRuntimeRecord, an explicit `auto-failover off` would
// silently revert to default-on across the respawn (brick://71af1351).

function freshCreateManager(store: InMemorySessionStore): AcpRuntimeManager {
  return new AcpRuntimeManager(createRuntimeOptions({ cwd: "/workspace", sessionStore: store }), {
    clientFactory: () =>
      ({
        initializeResult: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        start: async () => {},
        close: async () => {},
        createSession: async () => ({
          sessionId: "respawn-new-sid",
          agentSessionId: "respawn-agent",
        }),
        loadSession: async () => ({ agentSessionId: "unused" }),
        hasReusableSession: () => false,
        supportsLoadSession: () => true,
        supportsResumeSession: () => false,
        loadSessionWithOptions: async () => ({ agentSessionId: "unused" }),
        getAgentLifecycleSnapshot: () => ({ running: true }),
        prompt: async () => ({ stopReason: "end_turn" }),
        requestCancelActivePrompt: async () => false,
        hasActivePrompt: () => false,
        setSessionMode: async () => {},
        setSessionConfigOption: async () => {},
        clearEventHandlers: () => {},
        setEventHandlers: () => {},
      }) as never,
  });
}

function ensure(
  manager: AcpRuntimeManager,
  sessionOptions?: SessionAgentOptions,
): Promise<SessionRecord> {
  return manager.ensureSession({
    sessionKey: "respawn-sess",
    agent: "codex",
    mode: "persistent",
    sessionOptions,
  });
}

test("fresh-create respawn preserves a persisted auto_failover:false (spawn flags omit it)", async () => {
  const existing = makeSessionRecord({
    acpxRecordId: "respawn-sess",
    acpSessionId: "respawn-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
    acpx: {
      // Forces the fresh-create path (non-reuse) so the record is rebuilt.
      reset_on_next_ensure: true,
      session_options: { auto_failover: false, profile: "sub6" },
    },
  });
  const store = new InMemorySessionStore([existing]);
  const manager = freshCreateManager(store);

  // Respawn carries spawn-flag options only (profile) — NO autoFailover.
  const record = await ensure(manager, { profile: "sub6" });

  assert.equal(record.acpx?.session_options?.auto_failover, false);
  const saved = await store.load("respawn-sess");
  assert.equal(saved?.acpx?.session_options?.auto_failover, false);
});

test("fresh-create respawn: an explicit options.autoFailover still wins over the prior policy", async () => {
  const existing = makeSessionRecord({
    acpxRecordId: "respawn-sess",
    acpSessionId: "respawn-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
    acpx: {
      reset_on_next_ensure: true,
      session_options: { auto_failover: false, profile: "sub6" },
    },
  });
  const store = new InMemorySessionStore([existing]);
  const manager = freshCreateManager(store);

  const record = await ensure(manager, { profile: "sub6", autoFailover: true });

  assert.equal(record.acpx?.session_options?.auto_failover, true);
});

test("fresh-create of a genuinely NEW session stays default (no prior -> undefined)", async () => {
  const store = new InMemorySessionStore();
  const manager = freshCreateManager(store);

  const record = await ensure(manager, { profile: "sub6" });

  assert.equal(record.acpx?.session_options?.auto_failover, undefined);
});
