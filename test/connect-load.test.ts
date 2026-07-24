import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { SessionModelState, SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import {
  connectAndLoadSession,
  type ConnectedSessionController,
} from "../src/runtime/engine/reconnect.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
} from "./runtime-test-helpers.js";

type FakeClient = {
  hasReusableSession: (sessionId: string) => boolean;
  start: () => Promise<void>;
  getAgentLifecycleSnapshot: () => {
    pid?: number;
    startedAt?: string;
    running: boolean;
    lastExit?: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      exitedAt: string;
      reason: string;
    };
  };
  supportsLoadSession: () => boolean;
  supportsResumeSession?: () => boolean;
  resumeSession?: (
    sessionId: string,
    cwd: string,
  ) => Promise<{ agentSessionId?: string; models?: SessionModelState }>;
  loadSessionWithOptions: (
    sessionId: string,
    cwd: string,
    options: { suppressReplayUpdates: boolean },
  ) => Promise<{ agentSessionId?: string; models?: SessionModelState }>;
  createSession: (cwd: string) => Promise<{
    sessionId: string;
    agentSessionId?: string;
    models?: SessionModelState;
  }>;
  setSessionMode: (sessionId: string, modeId: string) => Promise<void>;
  setSessionModel: (sessionId: string, modelId: string) => Promise<void>;
  setSessionConfigOption?: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<SetSessionConfigOptionResponse>;
};

const ACTIVE_CONTROLLER: ConnectedSessionController & {
  setSessionModel: (modelId: string) => Promise<void>;
} = {
  hasActivePrompt: () => false,
  requestCancelActivePrompt: async () => false,
  setSessionMode: async () => {},
  setSessionModel: async () => {},
  setSessionConfigOption: async () =>
    ({
      configOptions: [],
    }) as SetSessionConfigOptionResponse,
};

function buildModelsState(currentModelId: string): SessionModelState {
  return {
    currentModelId,
    availableModels: [
      { modelId: "default-model", name: "default-model" },
      { modelId: "gpt-5.4", name: "gpt-5.4" },
    ],
  };
}

test("connectAndLoadSession prefers session/resume for resume-capable sessions", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "resume-record",
      acpSessionId: "resume-session",
      agentCommand: "agent",
      cwd,
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => true,
      resumeSession: async (sessionId, resumeCwd) => {
        assert.equal(sessionId, "resume-session");
        assert.equal(resumeCwd, cwd);
        return { agentSessionId: "runtime-session" };
      },
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.deepEqual(result, {
      sessionId: "resume-session",
      agentSessionId: "runtime-session",
      resumed: true,
      loadError: undefined,
    });
    assert.equal(record.agentSessionId, "runtime-session");
  });
});

test("connectAndLoadSession replays desired config options after cold session/resume", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "resume-config-replay-record",
      acpSessionId: "resume-session",
      agentSessionId: "old-runtime-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_config_options: {
          effort: "low",
        },
      },
    });

    const configCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    let started = false;
    let resumed = false;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {
        started = true;
      },
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => true,
      resumeSession: async (sessionId, resumeCwd) => {
        resumed = true;
        assert.equal(sessionId, "resume-session");
        assert.equal(resumeCwd, cwd);
        return { agentSessionId: "resumed-runtime-session" };
      },
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async (sessionId, configId, value) => {
        configCalls.push({ sessionId, configId, value });
        return { configOptions: [] };
      },
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(started, true);
    assert.equal(resumed, true);
    assert.deepEqual(result, {
      sessionId: "resume-session",
      agentSessionId: "resumed-runtime-session",
      resumed: true,
      loadError: undefined,
    });
    assert.deepEqual(configCalls, [
      {
        sessionId: "resume-session",
        configId: "effort",
        value: "low",
      },
    ]);
    assert.equal(record.acpx?.desired_config_options?.effort, "low");
  });
});

test("connectAndLoadSession replays desired config options after cold session/load", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "load-config-replay-record",
      acpSessionId: "load-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_config_options: {
          effort: "low",
        },
      },
    });

    const configCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async (sessionId, loadCwd, options) => {
        assert.equal(sessionId, "load-session");
        assert.equal(loadCwd, cwd);
        assert.deepEqual(options, { suppressReplayUpdates: true });
        return { agentSessionId: "loaded-runtime-session" };
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async (sessionId, configId, value) => {
        configCalls.push({ sessionId, configId, value });
        return { configOptions: [] };
      },
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.deepEqual(result, {
      sessionId: "load-session",
      agentSessionId: "loaded-runtime-session",
      resumed: true,
      loadError: undefined,
    });
    assert.deepEqual(configCalls, [
      {
        sessionId: "load-session",
        configId: "effort",
        value: "low",
      },
    ]);
    assert.equal(record.acpx?.desired_config_options?.effort, "low");
  });
});

test("connectAndLoadSession resumes an existing load-capable session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "resume-record",
      acpSessionId: "resume-session",
      agentCommand: "agent",
      cwd,
      closed: true,
      closedAt: "2026-01-01T00:05:00.000Z",
    });

    let clientAvailableCalls = 0;
    let connectedRecordCalls = 0;
    let resolvedSessionId: string | undefined;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        pid: 777,
        startedAt: "2026-01-01T00:00:00.000Z",
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async (sessionId, loadCwd, options) => {
        assert.equal(sessionId, "resume-session");
        assert.equal(loadCwd, cwd);
        assert.deepEqual(options, { suppressReplayUpdates: true });
        return { agentSessionId: "runtime-session" };
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
      onClientAvailable: (controller) => {
        clientAvailableCalls += 1;
        assert.equal(controller, ACTIVE_CONTROLLER);
      },
      onConnectedRecord: (connectedRecord) => {
        connectedRecordCalls += 1;
        assert.equal(connectedRecord.closed, false);
        assert.equal(connectedRecord.closedAt, undefined);
      },
      onSessionIdResolved: (sessionId) => {
        resolvedSessionId = sessionId;
      },
    });

    assert.deepEqual(result, {
      sessionId: "resume-session",
      agentSessionId: "runtime-session",
      resumed: true,
      loadError: undefined,
    });
    assert.equal(clientAvailableCalls, 1);
    assert.equal(connectedRecordCalls, 1);
    assert.equal(resolvedSessionId, "resume-session");
    assert.equal(record.pid, 777);
    assert.equal(record.agentStartedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(record.agentSessionId, "runtime-session");
  });
});

test("connectAndLoadSession falls back to createSession when load returns resource-not-found", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "fallback-record",
      acpSessionId: "old-session",
      agentCommand: "agent",
      cwd,
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async (createCwd) => {
        assert.equal(createCwd, cwd);
        return {
          sessionId: "new-session",
          agentSessionId: "new-runtime",
        };
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.resumed, false);
    assert.equal(result.sessionId, "new-session");
    assert.equal(result.agentSessionId, "new-runtime");
    assert.match(result.loadError ?? "", /session not found/);
    assert.equal(record.acpSessionId, "new-session");
    assert.equal(record.agentSessionId, "new-runtime");
  });
});

test("connectAndLoadSession ports a stranded transcript before retrying resource-not-found", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const subscriptionDir = path.join(homeDir, ".acpx", "subscriptions", "paid");
    await writeSubscriptionRegistry(homeDir, {
      default: "paid",
      subscriptions: [{ id: "paid", label: "Paid", configDir: subscriptionDir }],
    });

    const oldSessionId = "old-session";
    const rawTranscriptPath = transcriptJsonlPath(path.join(homeDir, ".claude"), cwd, oldSessionId);
    await fs.mkdir(path.dirname(rawTranscriptPath), { recursive: true });
    await fs.writeFile(rawTranscriptPath, '{"type":"message"}\n', "utf8");

    const record = makeSessionRecord({
      acpxRecordId: "transcript-port-record",
      acpSessionId: oldSessionId,
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "prior response" }],
            tool_results: {},
          },
        },
      ],
      acpx: {
        session_options: {
          subscription: "paid",
        },
      },
    });

    let loadCalls = 0;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          throw {
            error: {
              code: -32002,
              message: "session not found",
            },
          };
        }
        return { agentSessionId: "runtime-session" };
      },
      createSession: async () => {
        throw new Error("createSession must not be called after transcript recovery");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      timeoutMs: 1_000,
      activeController: ACTIVE_CONTROLLER,
    });

    const activeTranscriptPath = transcriptJsonlPath(subscriptionDir, cwd, oldSessionId);
    assert.equal(loadCalls, 2);
    assert.equal(await fs.readFile(activeTranscriptPath, "utf8"), '{"type":"message"}\n');
    assert.equal(result.resumed, true);
    assert.equal(result.sessionId, oldSessionId);
    assert.equal(record.acpSessionId, oldSessionId);
    assert.equal(record.agentSessionId, "runtime-session");
  });
});

test("connectAndLoadSession fails loudly for history when resource-not-found has no transcript anywhere", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const subscriptionDir = path.join(homeDir, ".acpx", "subscriptions", "paid");
    await writeSubscriptionRegistry(homeDir, {
      default: "paid",
      subscriptions: [{ id: "paid", label: "Paid", configDir: subscriptionDir }],
    });

    const record = makeSessionRecord({
      acpxRecordId: "missing-transcript-record",
      acpSessionId: "missing-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "prior response" }],
            tool_results: {},
          },
        },
      ],
      acpx: {
        session_options: {
          subscription: "paid",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => {
        throw new Error("createSession must not be called for history without transcript");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          timeoutMs: 1_000,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionResumeRequiredError");
        assert.match(error.message, /missing transcript at/);
        assert.match(error.message, /missing-session\.jsonl/);
        assert.match(error.message, /\.claude\/projects/);
        return true;
      },
    );
    assert.equal(record.acpSessionId, "missing-session");
  });
});

test("connectAndLoadSession completes a pending subscription switch by porting the transcript before load", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const subADir = path.join(homeDir, ".acpx", "subscriptions", "sub-a");
    const subBDir = path.join(homeDir, ".acpx", "subscriptions", "sub-b");
    await writeSubscriptionRegistry(homeDir, {
      subscriptions: [
        { id: "sub-a", label: "Sub A", configDir: subADir },
        { id: "sub-b", label: "Sub B", configDir: subBDir },
      ],
    });

    const sessionId = "switch-session";
    const sourceTranscriptPath = transcriptJsonlPath(subADir, cwd, sessionId);
    await fs.mkdir(path.dirname(sourceTranscriptPath), { recursive: true });
    await fs.writeFile(sourceTranscriptPath, '{"switch":"source"}\n', "utf8");

    const record = makeSessionRecord({
      acpxRecordId: "pending-switch-record",
      acpSessionId: sessionId,
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "prior response" }],
            tool_results: {},
          },
        },
      ],
      acpx: {
        session_options: {
          subscription: "sub-b",
          subscription_switch: {
            from: "sub-a",
            to: "sub-b",
            reason: "manual",
            at: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });

    const targetTranscriptPath = transcriptJsonlPath(subBDir, cwd, sessionId);
    let loadCalls = 0;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        loadCalls += 1;
        assert.equal(await fs.readFile(targetTranscriptPath, "utf8"), '{"switch":"source"}\n');
        return { agentSessionId: "runtime-session" };
      },
      createSession: async () => {
        throw new Error("createSession must not be called for pending switch recovery");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(loadCalls, 1);
    assert.equal(result.resumed, true);
    assert.equal(record.acpSessionId, sessionId);
  });
});

test("connectAndLoadSession completes a pending account switch by porting the profile transcript before load", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const subADir = path.join(homeDir, ".acpx", "subscriptions", "sub-a");
    const subBDir = path.join(homeDir, ".acpx", "subscriptions", "sub-b");
    await writeProfileRegistry(homeDir, {
      profiles: [
        {
          id: "sub-a",
          label: "Sub A",
          authMode: "subscription",
          adapter: "claude",
          account: "acct-a",
          credentialSource: subADir,
        },
        {
          id: "sub-b",
          label: "Sub B",
          authMode: "subscription",
          adapter: "claude",
          account: "acct-b",
          credentialSource: subBDir,
        },
      ],
    });

    const sessionId = "account-switch-session";
    const sourceTranscriptPath = transcriptJsonlPath(subADir, cwd, sessionId);
    await fs.mkdir(path.dirname(sourceTranscriptPath), { recursive: true });
    await fs.writeFile(sourceTranscriptPath, '{"account-switch":"source"}\n', "utf8");

    const record = makeSessionRecord({
      acpxRecordId: "pending-account-switch-record",
      acpSessionId: sessionId,
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "prior response" }],
            tool_results: {},
          },
        },
      ],
      acpx: {
        session_options: {
          profile: "sub-b",
          account_switch: {
            fromProfile: "sub-a",
            toProfile: "sub-b",
            fromAccount: "acct-a",
            toAccount: "acct-b",
            reason: "failover",
            at: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });

    const targetTranscriptPath = transcriptJsonlPath(subBDir, cwd, sessionId);
    let loadCalls = 0;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        loadCalls += 1;
        assert.equal(
          await fs.readFile(targetTranscriptPath, "utf8"),
          '{"account-switch":"source"}\n',
        );
        return { agentSessionId: "runtime-session" };
      },
      createSession: async () => {
        throw new Error("createSession must not be called for pending account switch recovery");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(loadCalls, 1);
    assert.equal(result.resumed, true);
    assert.equal(record.acpSessionId, sessionId);
  });
});

test("connectAndLoadSession fails a pending subscription switch loudly when no transcript can be ported", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const subADir = path.join(homeDir, ".acpx", "subscriptions", "sub-a");
    const subBDir = path.join(homeDir, ".acpx", "subscriptions", "sub-b");
    await writeSubscriptionRegistry(homeDir, {
      subscriptions: [
        { id: "sub-a", label: "Sub A", configDir: subADir },
        { id: "sub-b", label: "Sub B", configDir: subBDir },
      ],
    });

    const record = makeSessionRecord({
      acpxRecordId: "pending-switch-missing-record",
      acpSessionId: "switch-missing-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "prior response" }],
            tool_results: {},
          },
        },
      ],
      acpx: {
        session_options: {
          subscription: "sub-b",
          subscription_switch: {
            from: "sub-a",
            to: "sub-b",
            reason: "manual",
            at: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });

    let loadCalled = false;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        loadCalled = true;
        throw new Error("load should be preflight-blocked");
      },
      createSession: async () => {
        throw new Error("createSession must not be called for pending switch wedge");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionResumeRequiredError");
        assert.match(error.message, /pending subscription switch sub-a -> sub-b cannot resume/);
        assert.match(error.message, /switch-missing-session\.jsonl/);
        return true;
      },
    );
    assert.equal(loadCalled, false);
  });
});

test("connectAndLoadSession fails instead of creating a fresh session when resume policy requires the same session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "strict-resume-record",
      acpSessionId: "strict-resume-session",
      agentCommand: "agent",
      cwd,
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          resumePolicy: "same-session-only",
          timeoutMs: 1_000,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session strict-resume-session could not be resumed: .*session not found/i,
    );

    assert.equal(record.acpSessionId, "strict-resume-session");
  });
});

test("connectAndLoadSession requires the same provider session for imported records", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "imported-record",
      acpSessionId: "imported-provider-session",
      agentCommand: "agent",
      cwd,
      importedFrom: {
        recordId: "source-record",
        cwdOriginal: "/source/workspace",
        exportedBy: "source-user",
        exportedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          timeoutMs: 1_000,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session imported-provider-session could not be resumed: .*session not found/i,
    );

    assert.equal(record.acpSessionId, "imported-provider-session");
  });
});

test("connectAndLoadSession falls back to createSession for empty sessions on adapter internal errors", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "empty-record",
      acpSessionId: "empty-session",
      agentCommand: "agent",
      cwd,
      messages: [],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32603,
            message: "internal error",
          },
        };
      },
      createSession: async () => ({
        sessionId: "created-for-empty",
        agentSessionId: "created-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "created-for-empty");
    assert.equal(result.resumed, false);
    assert.equal(record.acpSessionId, "created-for-empty");
    assert.equal(record.agentSessionId, "created-runtime");
  });
});

test("connectAndLoadSession fails clearly when same-session resume is required but session reuse is unsupported", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "unsupported-load-record",
      acpSessionId: "unsupported-load-session",
      agentCommand: "agent",
      cwd,
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw new Error("loadSession should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          resumePolicy: "same-session-only",
          timeoutMs: 1_000,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session unsupported-load-session could not be resumed: agent does not support session\/resume or session\/load/i,
    );
  });
});

test("connectAndLoadSession fails loudly on -32602 Invalid params after real turns", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "invalid-params-record",
      acpSessionId: "invalid-params-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "has history" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32602,
            message: "Invalid params",
          },
        };
      },
      createSession: async () => {
        throw new Error("createSession must not be called for a session with real history");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session invalid-params-session could not be resumed: .*Invalid params/i,
    );

    assert.equal(record.acpSessionId, "invalid-params-session");
  });
});

test("connectAndLoadSession fails loudly on -32601 Method not found after real turns", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "method-not-found-record",
      acpSessionId: "method-not-found-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "has history" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32601,
            message: "Method not found",
          },
        };
      },
      createSession: async () => {
        throw new Error("createSession must not be called for a session with real history");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session method-not-found-session could not be resumed: .*Method not found/i,
    );

    assert.equal(record.acpSessionId, "method-not-found-session");
  });
});

test("connectAndLoadSession rethrows load failures that should not create a new session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "agent-history-record",
      acpSessionId: "agent-history-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "already responded" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32603,
            message: "still broken",
          },
        };
      },
      createSession: async () => ({
        sessionId: "unexpected",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session agent-history-session could not be resumed: .*still broken/i,
    );
    assert.equal(record.acpSessionId, "agent-history-session");
  });
});

// Pinned wire shape of the independent-claude-acp bridge's session/load
// rejection for a never-prompted session (UIC-4 verification F1).
const TRANSCRIPT_GONE_LOAD_ERROR = {
  error: {
    code: -32000,
    message:
      "session/load rejected: Claude session wedge-session is not resumable (transcript gone)",
    data: {
      schema: "independent-claude-acp/load-session/v1",
      reason: "transcript-gone",
      sessionId: "wedge-session",
      claudeSessionId: "wedge-session",
      homeSelector: "home1",
      detail: "No transcript at expected path; the Claude session wedge-session is not resumable.",
    },
  },
};

test("connectAndLoadSession falls back to session/new when a NEVER-prompted session's load is rejected with the structured transcript-gone schema (F1)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "wedge-record",
      acpSessionId: "wedge-session",
      agentCommand: "agent",
      cwd,
      messages: [], // created, owner idle-released, never prompted
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw TRANSCRIPT_GONE_LOAD_ERROR;
      },
      createSession: async () => ({
        sessionId: "unwedged-fresh",
        agentSessionId: "unwedged-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "unwedged-fresh");
    assert.equal(result.resumed, false);
    assert.equal(record.acpSessionId, "unwedged-fresh");
  });
});

test("connectAndLoadSession keeps a transcript-gone rejection LOUD after real turns (no silent continuity loss)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "lost-history-record",
      acpSessionId: "wedge-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "real prior turn" }],
            tool_results: {},
          },
        },
      ],
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw TRANSCRIPT_GONE_LOAD_ERROR;
      },
      createSession: async () => {
        throw new Error("createSession must not be called for a session with real history");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      /Persistent ACP session wedge-session could not be resumed: .*transcript gone/i,
    );
    assert.equal(record.acpSessionId, "wedge-session");
  });
});

test("connectAndLoadSession self-heals a guard-forced fresh session via session/new — synthetic breadcrumb must not gate the fallback (brick://de3645c6 repro C)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const subscriptionDir = path.join(homeDir, ".acpx", "subscriptions", "paid");
    await writeSubscriptionRegistry(homeDir, {
      default: "paid",
      subscriptions: [{ id: "paid", label: "Paid", configDir: subscriptionDir }],
    });

    // Incident specimen shape: a never-run session whose ONLY log entry is the
    // implicit-Fable→opus guard breadcrumb acpx mirrors at CREATE time
    // (Agent.synthetic:true). No real turn, no transcript on disk. Its cold first
    // prompt issues session/resume → -32002; the transcript is genuinely missing.
    // Before the fix the cosmetic breadcrumb tripped the has-agent-messages gate
    // and the session was permanently unpromptable; now it must fall back to
    // session/new and live.
    const record = makeSessionRecord({
      acpxRecordId: "guard-forced-record",
      acpSessionId: "guard-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [
              {
                Text:
                  '⚠ implicit Fable blocked → forced opus: this session would have resolved to "fable" ' +
                  "by inheritance/default, but Fable is never inherited automatically (brick://5bac5564).",
              },
            ],
            tool_results: {},
            synthetic: true,
          },
        },
      ],
      acpx: {
        session_options: {
          subscription: "paid",
          model_source: "guard-forced",
          model_guard: {
            blocked: "fable",
            forced_to: "opus",
            source: "inherited",
            at: "2026-01-01T00:00:00.000Z",
          },
        },
      },
    });

    let createCalls = 0;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => true,
      resumeSession: async () => {
        throw {
          error: {
            code: -32002,
            message: "Resource not found: guard-session",
          },
        };
      },
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions must not be called on the resume path");
      },
      createSession: async (createCwd) => {
        createCalls += 1;
        assert.equal(createCwd, cwd);
        return {
          sessionId: "healed-session",
          agentSessionId: "healed-runtime",
        };
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(createCalls, 1, "guard-forced fresh session must fall back to session/new");
    assert.equal(result.resumed, false);
    assert.equal(result.sessionId, "healed-session");
    assert.equal(record.acpSessionId, "healed-session");
    assert.equal(record.agentSessionId, "healed-runtime");
  });
});

test("connectAndLoadSession keeps a missing-transcript resume LOUD when a real turn precedes the synthetic breadcrumb (gate not weakened) — brick://de3645c6", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const subscriptionDir = path.join(homeDir, ".acpx", "subscriptions", "paid");
    await writeSubscriptionRegistry(homeDir, {
      default: "paid",
      subscriptions: [{ id: "paid", label: "Paid", configDir: subscriptionDir }],
    });

    // A real model turn DID happen (irreplaceable history), and a synthetic
    // breadcrumb also sits in the log. A missing-transcript resume must still
    // fail loudly — the synthetic-excluding gate must not swallow real history.
    const record = makeSessionRecord({
      acpxRecordId: "real-plus-synthetic-record",
      acpSessionId: "history-session",
      agentCommand: "agent",
      cwd,
      messages: [
        {
          Agent: {
            content: [{ Text: "⚠ implicit Fable blocked → forced opus" }],
            tool_results: {},
            synthetic: true,
          },
        },
        {
          Agent: {
            content: [{ Text: "real prior turn" }],
            tool_results: {},
          },
        },
      ],
      acpx: {
        session_options: {
          subscription: "paid",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => true,
      resumeSession: async () => {
        throw {
          error: {
            code: -32002,
            message: "Resource not found: history-session",
          },
        };
      },
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions must not be called on the resume path");
      },
      createSession: async () => {
        throw new Error("createSession must not be called for a session with real history");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionResumeRequiredError");
        assert.match(error.message, /missing transcript at/);
        return true;
      },
    );
    assert.equal(record.acpSessionId, "history-session");
  });
});

test("connectAndLoadSession fails when desired mode replay cannot be restored on a fresh session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "mode-replay-record",
      acpSessionId: "stale-session",
      agentSessionId: "stale-runtime",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_mode_id: "plan",
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
      }),
      setSessionMode: async (sessionId, modeId) => {
        assert.equal(sessionId, "fresh-session");
        assert.equal(modeId, "plan");
        throw new Error("mode restore rejected");
      },
      setSessionModel: async () => {},
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionModeReplayError");
        assert.equal((error as Error & { retryable?: boolean }).retryable, true);
        assert.match(error.message, /Failed to replay saved session mode plan/);
        return true;
      },
    );
    assert.equal(record.acpSessionId, "stale-session");
    assert.equal(record.agentSessionId, "stale-runtime");
  });
});

test("connectAndLoadSession replays desired model on a fresh session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "model-replay-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: {
          model: "gpt-5.4",
        },
      },
    });

    let setModelCalls = 0;
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
        models: buildModelsState("default-model"),
      }),
      setSessionMode: async () => {},
      setSessionModel: async (sessionId, modelId) => {
        setModelCalls += 1;
        assert.equal(sessionId, "fresh-session");
        assert.equal(modelId, "gpt-5.4");
      },
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "fresh-session");
    assert.equal(result.resumed, false);
    assert.equal(setModelCalls, 1);
    assert.equal(record.acpSessionId, "fresh-session");
    assert.equal(record.acpx?.current_model_id, "gpt-5.4");
    assert.deepEqual(record.acpx?.available_models, ["default-model", "gpt-5.4"]);
  });
});

// Regression for brick bbdbd56d (live prod specimen b94c0828): a byway/fork session pinned
// to a `[1m]` context alias (`sonnet[1m]`) reconnected and threw SESSION_MODEL_REPLAY_FAILED
// because the adapter advertises only the base `sonnet`. The replay gate must now tolerate the
// context hint AND forward the ORIGINAL alias unchanged (the adapter re-resolves it).
test("connectAndLoadSession replays a [1m] context-alias model without throwing and forwards the original alias", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "context-alias-replay-record",
      acpSessionId: "resume-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: {
          model: "sonnet[1m]",
        },
      },
    });

    // Adapter advertises BASE names only — never the `[1m]` variant.
    const resumedModels: SessionModelState = {
      currentModelId: "default",
      availableModels: [
        { modelId: "default", name: "default" },
        { modelId: "sonnet", name: "sonnet" },
        { modelId: "opus", name: "opus" },
      ],
    };
    const modelCalls: Array<{ sessionId: string; modelId: string }> = [];
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => true,
      resumeSession: async (sessionId, resumeCwd) => {
        assert.equal(sessionId, "resume-session");
        assert.equal(resumeCwd, cwd);
        return {
          agentSessionId: "resumed-runtime-session",
          models: resumedModels,
        };
      },
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async (sessionId, modelId) => {
        modelCalls.push({ sessionId, modelId });
      },
      setSessionConfigOption: async () => ({ configOptions: [] }),
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.resumed, true);
    // No SessionModelReplayError thrown, and the ORIGINAL alias is forwarded (not the base).
    assert.deepEqual(modelCalls, [
      {
        sessionId: "resume-session",
        modelId: "sonnet[1m]",
      },
    ]);
  });
});

test("connectAndLoadSession replays desired model after cold session/resume and records it current", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "resume-model-replay-record",
      acpSessionId: "resume-session",
      agentCommand: "codex-agent",
      cwd,
      acpx: {
        current_model_id: "gpt-5.4[low]",
        session_options: {
          model: "gpt-5.4[xhigh]",
        },
      },
    });

    const resumedModels: SessionModelState = {
      currentModelId: "gpt-5.4[low]",
      availableModels: [
        { modelId: "gpt-5.4[low]", name: "gpt-5.4[low]" },
        { modelId: "gpt-5.4[xhigh]", name: "gpt-5.4[xhigh]" },
      ],
    };
    const modelCalls: Array<{ sessionId: string; modelId: string }> = [];
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => true,
      resumeSession: async (sessionId, resumeCwd) => {
        assert.equal(sessionId, "resume-session");
        assert.equal(resumeCwd, cwd);
        return {
          agentSessionId: "resumed-runtime-session",
          models: resumedModels,
        };
      },
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async (sessionId, modelId) => {
        modelCalls.push({ sessionId, modelId });
      },
      setSessionConfigOption: async () => ({ configOptions: [] }),
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.deepEqual(result, {
      sessionId: "resume-session",
      agentSessionId: "resumed-runtime-session",
      resumed: true,
      loadError: undefined,
    });
    assert.deepEqual(modelCalls, [
      {
        sessionId: "resume-session",
        modelId: "gpt-5.4[xhigh]",
      },
    ]);
    assert.equal(record.acpx?.current_model_id, "gpt-5.4[xhigh]");
    assert.deepEqual(record.acpx?.available_models, ["gpt-5.4[low]", "gpt-5.4[xhigh]"]);
  });
});

test("connectAndLoadSession replays desired model after cold session/load", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "load-model-replay-record",
      acpSessionId: "load-session",
      agentCommand: "codex-agent",
      cwd,
      acpx: {
        current_model_id: "gpt-5.4[low]",
        session_options: {
          model: "gpt-5.4[xhigh]",
        },
      },
    });

    const resumedModels: SessionModelState = {
      currentModelId: "gpt-5.4[low]",
      availableModels: [
        { modelId: "gpt-5.4[low]", name: "gpt-5.4[low]" },
        { modelId: "gpt-5.4[xhigh]", name: "gpt-5.4[xhigh]" },
      ],
    };
    const modelCalls: Array<{ sessionId: string; modelId: string }> = [];
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async (sessionId, loadCwd, options) => {
        assert.equal(sessionId, "load-session");
        assert.equal(loadCwd, cwd);
        assert.deepEqual(options, { suppressReplayUpdates: true });
        return {
          agentSessionId: "loaded-runtime-session",
          models: resumedModels,
        };
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async (sessionId, modelId) => {
        modelCalls.push({ sessionId, modelId });
      },
      setSessionConfigOption: async () => ({ configOptions: [] }),
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.deepEqual(result, {
      sessionId: "load-session",
      agentSessionId: "loaded-runtime-session",
      resumed: true,
      loadError: undefined,
    });
    assert.deepEqual(modelCalls, [
      {
        sessionId: "load-session",
        modelId: "gpt-5.4[xhigh]",
      },
    ]);
    assert.equal(record.acpx?.current_model_id, "gpt-5.4[xhigh]");
    assert.deepEqual(record.acpx?.available_models, ["gpt-5.4[low]", "gpt-5.4[xhigh]"]);
  });
});

test("connectAndLoadSession fails clearly when saved model cannot be replayed generically", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "model-replay-unsupported-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: {
          model: "gpt-5.4",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => false,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions should not be called");
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {
        throw new Error("setSessionModel should not be called");
      },
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionModelReplayError");
        assert.match(error.message, /did not advertise model support/);
        return true;
      },
    );

    assert.equal(record.acpSessionId, "stale-session");
  });
});

// brick://07dd62c9 C4: when the reconnected/failover target advertises a model
// SET that LACKS the pinned model, that is a pinned FLOOR the target cannot meet —
// the replay must surface a LOUD ModelFloorUnmetError (detailCode model-floor-unmet
// → acpx-ui banner + parent-visible), NOT a generic SESSION_MODEL_REPLAY_FAILED
// that reads as an internal hiccup. (Distinct from the "no model metadata at all"
// case above, which stays SessionModelReplayError.)
test("connectAndLoadSession surfaces a loud model-floor terminal when the resume target advertises a set lacking the pinned model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "floor-crossing-record",
      acpSessionId: "resume-session",
      agentCommand: "agent",
      cwd,
      acpx: { session_options: { model: "fable" } },
    });

    // The target serves sonnet/opus but NOT the pinned fable → below floor.
    const resumedModels: SessionModelState = {
      currentModelId: "sonnet",
      availableModels: [
        { modelId: "sonnet", name: "sonnet" },
        { modelId: "opus", name: "opus" },
      ],
    };
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({ running: true }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => true,
      resumeSession: async () => ({
        agentSessionId: "resumed-runtime-session",
        models: resumedModels,
      }),
      loadSessionWithOptions: async () => {
        throw new Error("loadSessionWithOptions should not be called");
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {
        throw new Error("setSessionModel should not be called");
      },
      setSessionConfigOption: async () => ({ configOptions: [] }),
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "ModelFloorUnmetError");
        assert.equal((error as Error & { detailCode?: string }).detailCode, "model-floor-unmet");
        // Observed served model = what the target IS serving.
        assert.equal((error as Error & { servedModel?: string }).servedModel, "sonnet");
        return true;
      },
    );
  });
});

test("connectAndLoadSession restores the original session when desired model replay fails", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "model-replay-failure-record",
      acpSessionId: "stale-session",
      agentSessionId: "stale-runtime",
      agentCommand: "agent",
      cwd,
      acpx: {
        session_options: {
          model: "gpt-5.4",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
        models: buildModelsState("default-model"),
      }),
      setSessionMode: async () => {},
      setSessionModel: async (sessionId, modelId) => {
        assert.equal(sessionId, "fresh-session");
        assert.equal(modelId, "gpt-5.4");
        throw new Error("model restore rejected");
      },
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionModelReplayError");
        assert.equal((error as Error & { retryable?: boolean }).retryable, true);
        assert.match(error.message, /Failed to replay saved session model gpt-5\.4/);
        return true;
      },
    );

    assert.equal(record.acpSessionId, "stale-session");
    assert.equal(record.agentSessionId, "stale-runtime");
    assert.equal(record.acpx?.current_model_id, undefined);
  });
});

test("connectAndLoadSession replays desired config options on a fresh session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "config-replay-record",
      acpSessionId: "stale-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_config_options: {
          reasoning_effort: "high",
        },
      },
    });

    const configCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async (sessionId, configId, value) => {
        configCalls.push({ sessionId, configId, value });
        return { configOptions: [] };
      },
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(result.sessionId, "fresh-session");
    assert.equal(result.resumed, false);
    assert.deepEqual(configCalls, [
      {
        sessionId: "fresh-session",
        configId: "reasoning_effort",
        value: "high",
      },
    ]);
  });
});

test("connectAndLoadSession restores the original session when desired config replay fails", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "config-replay-failure-record",
      acpSessionId: "stale-session",
      agentSessionId: "stale-runtime",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_config_options: {
          effort: "xhigh",
        },
      },
    });

    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async (sessionId, configId, value) => {
        assert.equal(sessionId, "fresh-session");
        assert.equal(configId, "effort");
        assert.equal(value, "xhigh");
        throw new Error("Unknown config option: effort");
      },
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionConfigOptionReplayError");
        assert.equal((error as Error & { retryable?: boolean }).retryable, true);
        assert.match(error.message, /Failed to replay saved session config option effort/);
        assert.match(error.message, /Unknown config option: effort/);
        return true;
      },
    );

    assert.equal(record.acpSessionId, "stale-session");
    assert.equal(record.agentSessionId, "stale-runtime");
  });
});

test("connectAndLoadSession does not persist normalized effort when later config replay fails", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "config-replay-normalized-failure-record",
      acpSessionId: "stale-session",
      agentSessionId: "stale-runtime",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd,
      acpx: {
        session_options: {
          model: "sonnet",
        },
        desired_config_options: {
          effort: "xhigh",
          secondary: "kept",
        },
      },
    });

    const configCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    const client: FakeClient = {
      hasReusableSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        throw {
          error: {
            code: -32002,
            message: "session not found",
          },
        };
      },
      createSession: async () => ({
        sessionId: "fresh-session",
        agentSessionId: "fresh-runtime",
      }),
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async (sessionId, configId, value) => {
        configCalls.push({ sessionId, configId, value });
        if (configId === "secondary") {
          throw new Error("secondary config restore rejected");
        }
        return { configOptions: [] };
      },
    };

    await assert.rejects(
      async () =>
        await connectAndLoadSession({
          client: client as never,
          record,
          activeController: ACTIVE_CONTROLLER,
        }),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.name, "SessionConfigOptionReplayError");
        assert.match(error.message, /Failed to replay saved session config option secondary/);
        return true;
      },
    );

    assert.deepEqual(configCalls, [
      { sessionId: "fresh-session", configId: "effort", value: "high" },
      { sessionId: "fresh-session", configId: "secondary", value: "kept" },
    ]);
    assert.equal(record.acpSessionId, "stale-session");
    assert.equal(record.agentSessionId, "stale-runtime");
    assert.equal(record.acpx?.desired_config_options?.effort, "xhigh");
    assert.equal(record.acpx?.desired_config_options?.secondary, "kept");
  });
});

test("connectAndLoadSession reuses an already loaded client session", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "reused-record",
      acpSessionId: "reused-session",
      agentCommand: "agent",
      cwd,
      acpx: {
        desired_config_options: {
          effort: "low",
        },
        session_options: {
          model: "gpt-5.4",
        },
      },
    });

    let started = false;
    let loaded = false;
    const client: FakeClient = {
      hasReusableSession: (sessionId) => sessionId === "reused-session",
      start: async () => {
        started = true;
      },
      getAgentLifecycleSnapshot: () => ({
        pid: 888,
        startedAt: "2026-01-01T00:00:00.000Z",
        running: true,
      }),
      supportsLoadSession: () => true,
      supportsResumeSession: () => false,
      loadSessionWithOptions: async () => {
        loaded = true;
        return {};
      },
      createSession: async () => {
        throw new Error("createSession should not be called");
      },
      setSessionMode: async () => {},
      setSessionModel: async () => {
        throw new Error("setSessionModel should not be called for a warm reusable session");
      },
      setSessionConfigOption: async () => {
        throw new Error("setSessionConfigOption should not be called for a warm reusable session");
      },
    };

    const result = await connectAndLoadSession({
      client: client as never,
      record,
      activeController: ACTIVE_CONTROLLER,
    });

    assert.equal(started, false);
    assert.equal(loaded, false);
    assert.equal(result.resumed, true);
    assert.equal(result.sessionId, "reused-session");
    assert.equal(record.pid, 888);
  });
});

function makeSessionRecord(
  overrides: Parameters<typeof makeSessionRecordFixture>[0],
): ReturnType<typeof makeSessionRecordFixture> {
  return makeSessionRecordFixture(overrides, { defaultName: false, defaultAcpx: false });
}

async function writeSubscriptionRegistry(
  homeDir: string,
  registry: {
    default?: string;
    subscriptions: Array<{ id: string; label: string; configDir: string }>;
  },
): Promise<void> {
  const registryPath = path.join(homeDir, ".acpx", "subscriptions", "registry.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  for (const entry of registry.subscriptions) {
    await fs.mkdir(entry.configDir, { recursive: true });
  }
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

type TestProfileRegistryEntry = {
  id: string;
  label: string;
  authMode: string;
  adapter: string;
  account: string;
  credentialSource: string;
};

async function writeProfileRegistry(
  homeDir: string,
  registry: {
    default?: string;
    profiles: TestProfileRegistryEntry[];
  },
): Promise<void> {
  const registryPath = path.join(homeDir, ".acpx", "subscriptions", "registry.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  for (const entry of registry.profiles) {
    await fs.mkdir(entry.credentialSource, { recursive: true });
  }
  await fs.writeFile(
    registryPath,
    `${JSON.stringify({ version: 3, ...registry }, null, 2)}\n`,
    "utf8",
  );
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-connect-load-home-", run);
}
