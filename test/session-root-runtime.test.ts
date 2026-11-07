import assert from "node:assert/strict";
import test from "node:test";
import { AcpRuntimeManager } from "../src/runtime/engine/manager.js";
import { createRuntimeOptions, InMemorySessionStore } from "./runtime-test-helpers.js";

// brick 45917618 §5.2 E4 (TEST-PLAN A8): the runtime library's FRESH create starts at the session
// root; a resume keeps the cwd it was given. Shaped like runtime-manager.test.ts's create/resume row.

function fakeClient(seen: { create: string[]; resume: string[] }) {
  return {
    initializeResult: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
    },
    start: async () => {},
    close: async () => {},
    createSession: async (cwd: string) => {
      seen.create.push(cwd);
      return { sessionId: "new-session", agentSessionId: "agent-session" };
    },
    loadSession: async () => {
      throw new Error("loadSession should not be called");
    },
    resumeSession: async (_sessionId: string, cwd: string) => {
      seen.resume.push(cwd);
      return { agentSessionId: "resumed-agent" };
    },
    hasReusableSession: () => false,
    supportsLoadSession: () => true,
    supportsResumeSession: () => true,
    loadSessionWithOptions: async () => ({ agentSessionId: "runtime-session" }),
    getAgentLifecycleSnapshot: () => ({ running: false }),
    prompt: async () => ({ stopReason: "end_turn" }),
    requestCancelActivePrompt: async () => false,
    hasActivePrompt: () => false,
    setSessionMode: async () => {},
    setSessionConfigOption: async () => {},
    clearEventHandlers: () => {},
    setEventHandlers: () => {},
  };
}

async function withSessionRoot<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.ACPX_SESSION_ROOT;
  if (value === undefined) {
    delete process.env.ACPX_SESSION_ROOT;
  } else {
    process.env.ACPX_SESSION_ROOT = value;
  }
  try {
    return await run();
  } finally {
    if (saved === undefined) {
      delete process.env.ACPX_SESSION_ROOT;
    } else {
      process.env.ACPX_SESSION_ROOT = saved;
    }
  }
}

test("A8: a fresh runtime-library create is re-rooted; a resume keeps the cwd it was given", async () => {
  const seen = { create: [] as string[], resume: [] as string[] };
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/tmp/x", sessionStore: new InMemorySessionStore() }),
    { clientFactory: () => fakeClient(seen) as never },
  );
  await withSessionRoot("/srv/session-root", async () => {
    const created = await manager.ensureSession({
      sessionKey: "fresh",
      agent: "codex",
      mode: "persistent",
      cwd: "/tmp/x",
    });
    assert.equal(created.cwd, "/srv/session-root");
    const resumed = await manager.ensureSession({
      sessionKey: "resumed",
      agent: "codex",
      mode: "persistent",
      cwd: "/tmp/x",
      resumeSessionId: "resume-session",
    });
    assert.equal(resumed.cwd, "/tmp/x");
  });
  assert.deepEqual(seen, { create: ["/srv/session-root"], resume: ["/tmp/x"] });
});

test("A8 negative: with enforcement off the fresh create keeps the requested cwd (upstream)", async () => {
  const seen = { create: [] as string[], resume: [] as string[] };
  const manager = new AcpRuntimeManager(
    createRuntimeOptions({ cwd: "/tmp/x", sessionStore: new InMemorySessionStore() }),
    { clientFactory: () => fakeClient(seen) as never },
  );
  await withSessionRoot("", async () => {
    const created = await manager.ensureSession({
      sessionKey: "fresh",
      agent: "codex",
      mode: "persistent",
      cwd: "/tmp/x",
    });
    assert.equal(created.cwd, "/tmp/x");
  });
  assert.deepEqual(seen.create, ["/tmp/x"]);
});
