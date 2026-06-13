import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  runSessionSetConfigOptionDirect,
  runSessionSetModelDirect,
  runSessionSetModeDirect,
} from "../src/cli/session/prompt-runner.js";
import { resolveSessionRecord } from "../src/session/persistence/repository.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile as writeSessionRecord,
} from "./runtime-test-helpers.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

test("runSessionSetModeDirect resumes a load-capable session and closes the client once", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    // Seed an OPEN session. Under the session-lifecycle-ownership model
    // (see DESIGN.md), runSessionSetModeDirect no longer silently reopens
    // closed sessions — that is user intent and only flipped via explicit
    // PATCH. Non-closed sessions work as before.
    const record = makeSessionRecord({
      acpxRecordId: "prompt-runner-resume",
      acpSessionId: "prompt-runner-resume-session",
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session`,
      cwd,
    });
    await writeSessionRecord(homeDir, record);

    let clientAvailableCalls = 0;
    let clientClosedCalls = 0;
    let controllerOperations: Promise<unknown> | undefined;

    const result = await runSessionSetModeDirect({
      sessionRecordId: record.acpxRecordId,
      modeId: "review",
      timeoutMs: 5_000,
      onClientAvailable: (controller) => {
        clientAvailableCalls += 1;
        controllerOperations = Promise.all([
          controller.setSessionMode("preload"),
          controller.setSessionConfigOption("reasoning_effort", "high"),
        ]);
      },
      onClientClosed: () => {
        clientClosedCalls += 1;
      },
    });
    await controllerOperations;

    assert.equal(result.resumed, true);
    assert.equal(result.loadError, undefined);
    assert.equal(clientAvailableCalls, 1);
    assert.equal(clientClosedCalls, 1);
    assert.equal(result.record.closed, false);
    assert.equal(result.record.closedAt, undefined);
    assert.equal(result.record.acpSessionId, record.acpSessionId);
    assert.equal(result.record.protocolVersion, 1);

    const persisted = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(persisted.acpSessionId, record.acpSessionId);
    assert.equal(persisted.closed, false);
    assert.equal(persisted.protocolVersion, 1);
    assert.equal(typeof persisted.lastUsedAt, "string");
  });
});

test("runSessionSetModeDirect does NOT silently reopen a closed session (fail-loud ownership)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "prompt-runner-stays-closed",
      acpSessionId: "prompt-runner-stays-closed-session",
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session`,
      cwd,
      closed: true,
      closedAt: "2026-01-01T00:05:00.000Z",
    });
    await writeSessionRecord(homeDir, record);

    // The set-mode-direct path previously included `record.closed = false`
    // side effects in the connect/resume helpers — those survive in the
    // in-memory record returned by the operation, but the read-preserve
    // mechanism in writeSessionRecord (see repository.ts) prevents those
    // transient flips from persisting to disk. What lands on disk is the
    // user's last explicit intent: `closed=true`.
    await runSessionSetModeDirect({
      sessionRecordId: record.acpxRecordId,
      modeId: "review",
      timeoutMs: 5_000,
    }).catch(() => {
      // The operation may fail because the session is closed from the
      // mock-agent's perspective — we only care about what hit disk.
    });

    const persisted = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(
      persisted.closed,
      true,
      "closed must remain true on disk even if connect-session.ts flipped it in-memory",
    );
    assert.equal(persisted.closedAt, "2026-01-01T00:05:00.000Z");
  });
});

test("runSessionSetConfigOptionDirect falls back to createSession and returns updated options", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "prompt-runner-config",
      acpSessionId: "stale-session-id",
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --load-session-fails-on-empty`,
      cwd,
      messages: [],
    });
    await writeSessionRecord(homeDir, record);

    const result = await runSessionSetConfigOptionDirect({
      sessionRecordId: record.acpxRecordId,
      configId: "reasoning_effort",
      value: "high",
      timeoutMs: 5_000,
    });

    assert.equal(result.resumed, false);
    assert.match(result.loadError ?? "", /internal error/i);
    assert.notEqual(result.record.acpSessionId, "stale-session-id");
    assert.deepEqual(result.response.configOptions, [
      {
        id: "mode",
        name: "Session Mode",
        category: "mode",
        type: "select",
        currentValue: "auto",
        options: [
          {
            value: "read-only",
            name: "Read Only",
          },
          {
            value: "auto",
            name: "Default",
          },
          {
            value: "full-access",
            name: "Full Access",
          },
          {
            value: "plan",
            name: "Plan",
          },
          {
            value: "default",
            name: "Default",
          },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "default-model",
        options: [
          {
            value: "default",
            name: "Default",
          },
          {
            value: "gpt-5.4",
            name: "gpt-5.4",
          },
          {
            value: "gpt-5.2",
            name: "gpt-5.2",
          },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning Effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          {
            value: "low",
            name: "Low",
          },
          {
            value: "medium",
            name: "Medium",
          },
          {
            value: "high",
            name: "High",
          },
          {
            value: "xhigh",
            name: "Xhigh",
          },
        ],
      },
    ]);

    const persisted = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(persisted.acpSessionId, result.record.acpSessionId);
    assert.equal(persisted.protocolVersion, 1);
    assert.equal(persisted.closed, false);
    assert.deepEqual(persisted.acpx?.desired_config_options, {
      reasoning_effort: "high",
    });
  });
});

test("runSessionSetModelDirect updates current and desired model", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const record = makeSessionRecord({
      acpxRecordId: "prompt-runner-model",
      acpSessionId: "prompt-runner-model-session",
      agentCommand: `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --advertise-models`,
      cwd,
      closed: true,
      closedAt: "2026-01-01T00:05:00.000Z",
    });
    await writeSessionRecord(homeDir, record);

    const result = await runSessionSetModelDirect({
      sessionRecordId: record.acpxRecordId,
      modelId: "smart-model",
      timeoutMs: 5_000,
    });

    assert.equal(result.resumed, true);
    assert.equal(result.record.acpx?.current_model_id, "smart-model");
    assert.equal(result.record.acpx?.session_options?.model, "smart-model");

    const persisted = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(persisted.acpx?.current_model_id, "smart-model");
    assert.equal(persisted.acpx?.session_options?.model, "smart-model");
  });
});

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-prompt-runner-home-", run);
}

function makeSessionRecord(
  overrides: Parameters<typeof makeSessionRecordFixture>[0],
): ReturnType<typeof makeSessionRecordFixture> {
  return makeSessionRecordFixture(overrides, { defaultName: false, defaultAcpx: false });
}
