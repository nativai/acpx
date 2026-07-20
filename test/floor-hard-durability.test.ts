import assert from "node:assert/strict";
import test from "node:test";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import {
  mergeSessionOptions,
  persistSessionOptions,
  type SessionAgentOptions,
  sessionOptionsFromRecord,
} from "../src/runtime/engine/session-options.js";
import type { SessionRecord } from "../src/types.js";
import {
  createRuntimeOptions,
  InMemorySessionStore,
  makeSessionRecord,
} from "./runtime-test-helpers.js";

// floor_hard is a durable per-session POLICY (brick://07dd62c9), carried forward
// across owner respawns by carryForwardPinnedFloor exactly like auto_failover
// (brick://71af1351). A fresh-create respawn rebuilds session_options from spawn
// flags, so without the carry-forward a --floor-hard CE would silently revert to
// the default detect+surface mode across a TTL reap.

// ─── session_options round-trip ─────────────────────────────────────────────

test("persistSessionOptions + sessionOptionsFromRecord round-trip floor_hard", () => {
  const record = makeSessionRecord({
    acpxRecordId: "r",
    acpSessionId: "s",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
  });
  persistSessionOptions(record, { model: "fable", reasoningEffort: "max", floorHard: true });
  assert.equal(record.acpx?.session_options?.floor_hard, true);
  const opts = sessionOptionsFromRecord(record);
  assert.equal(opts?.floorHard, true);
  assert.equal(opts?.model, "fable");
});

test("mergeSessionOptions carries floorHard (preferred wins)", () => {
  const merged = mergeSessionOptions({ floorHard: true }, { model: "fable" });
  assert.equal(merged?.floorHard, true);
  assert.equal(merged?.model, "fable");
});

// ─── fresh-create carry-forward ─────────────────────────────────────────────

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

function priorRecord(
  sessionOptions: NonNullable<SessionRecord["acpx"]>["session_options"],
): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "respawn-sess",
    acpSessionId: "respawn-sid",
    agentCommand: "codex --acp",
    cwd: "/workspace",
    acpx: { reset_on_next_ensure: true, session_options: sessionOptions },
  });
}

test("fresh-create respawn preserves a persisted floor_hard:true when spawn flags omit it", async () => {
  const store = new InMemorySessionStore([priorRecord({ floor_hard: true, profile: "sub6" })]);
  const manager = freshCreateManager(store);
  const record = await ensure(manager, { profile: "sub6" });
  assert.equal(record.acpx?.session_options?.floor_hard, true);
  const saved = await store.load("respawn-sess");
  assert.equal(saved?.acpx?.session_options?.floor_hard, true);
});

test("fresh-create respawn: an explicit options.floorHard:false still wins over the prior policy", async () => {
  const store = new InMemorySessionStore([priorRecord({ floor_hard: true, profile: "sub6" })]);
  const manager = freshCreateManager(store);
  const record = await ensure(manager, { profile: "sub6", floorHard: false });
  assert.equal(record.acpx?.session_options?.floor_hard, false);
});

test("fresh-create respawn seeds the pinned model+effort from the prior record when spawn flags omit them", async () => {
  const store = new InMemorySessionStore([
    priorRecord({ model: "fable", effort: "max", floor_hard: true, profile: "sub6" }),
  ]);
  const manager = freshCreateManager(store);
  // Respawn carries profile only — NO model/effort/floorHard.
  const record = await ensure(manager, { profile: "sub6" });
  assert.equal(record.acpx?.session_options?.model, "fable");
  assert.equal(record.acpx?.session_options?.effort, "max");
  assert.equal(record.acpx?.session_options?.floor_hard, true);
});

test("fresh-create of a genuinely NEW session leaves floor_hard undefined (default mode)", async () => {
  const store = new InMemorySessionStore();
  const manager = freshCreateManager(store);
  const record = await ensure(manager, { profile: "sub6" });
  assert.equal(record.acpx?.session_options?.floor_hard, undefined);
});
