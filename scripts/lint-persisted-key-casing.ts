import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findPersistedKeyPolicyViolations } from "../src/persisted-key-policy.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";

function makeRecord(): SessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "lint-record",
    acpSessionId: "lint-session",
    agentSessionId: "agent-session",
    agentCommand: "npx -y @agentclientprotocol/codex-acp",
    cwd: "/tmp/lint",
    createdAt: "2026-02-27T00:00:00.000Z",
    lastUsedAt: "2026-02-27T00:00:00.000Z",
    lastSeq: 0,
    lastRequestId: undefined,
    eventLog: {
      active_path: "/tmp/lint-record.events.ndjson",
      segment_count: 1,
      max_segment_bytes: 1024,
      max_segments: 1,
      last_write_at: undefined,
      last_write_error: null,
    },
    closed: false,
    title: null,
    // ⚠️ NOT AN EMPTY LIST, AND DO NOT TRIM THESE ENTRIES BACK. `messages: []`
    // is what let `messages.Agent.claudeUuid` past this lint and into
    // production, where it threw inside `serializeSessionRecordForDisk` and
    // silently stopped 33 sessions persisting (brick://94b6f8fb). A record with
    // no messages never exercises the message subtree at all, so every key
    // under `messages.*` was unguarded. Both entry kinds carry every optional
    // provenance field so a camelCase one cannot be added without this lint
    // failing.
    messages: [
      {
        User: {
          id: "lint-user",
          content: [{ Text: "hello" }],
          claude_uuid: "11111111-1111-4111-8111-111111111111",
        },
      },
      {
        Agent: {
          content: [{ Text: "hi" }],
          tool_results: {},
          claude_uuid: "22222222-2222-4222-8222-222222222222",
        },
      },
    ],
    updated_at: "2026-02-27T00:00:00.000Z",
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {
      current_mode_id: "code",
      available_commands: ["run"],
    },
  };
}

function assertSerializationPolicy(): void {
  const persisted = serializeSessionRecordForDisk(makeRecord());
  const violations = findPersistedKeyPolicyViolations(persisted);
  assert.equal(
    violations.length,
    0,
    `serializeSessionRecordForDisk emitted non-snake keys: ${violations.join(", ")}`,
  );

  const requiredTopLevel = [
    "schema",
    "acpx_record_id",
    "acp_session_id",
    "agent_session_id",
    "agent_command",
    "cwd",
    "created_at",
    "last_used_at",
    "last_seq",
    "event_log",
    "title",
    "messages",
    "updated_at",
    "cumulative_token_usage",
    "request_token_usage",
  ];

  for (const key of requiredTopLevel) {
    assert.equal(
      key in persisted,
      true,
      `serialized session record is missing required key: ${key}`,
    );
  }

  const forbiddenTopLevel = [
    "acpxRecordId",
    "acpSessionId",
    "agentSessionId",
    "agentCommand",
    "createdAt",
    "lastUsedAt",
    "lastSeq",
    "lastRequestId",
    "eventLog",
    "closedAt",
    "agentStartedAt",
    "lastPromptAt",
    "lastAgentExitCode",
    "lastAgentExitSignal",
    "lastAgentExitAt",
    "lastAgentDisconnectReason",
    "protocolVersion",
    "agentCapabilities",
  ];

  for (const key of forbiddenTopLevel) {
    assert.equal(
      key in persisted,
      false,
      `serialized session record must not emit camelCase key: ${key}`,
    );
  }
}

function assertSerializerSourceKeys(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const sourcePath = path.join(scriptDir, "..", "src", "session", "persistence", "serialize.ts");
  const source = fs.readFileSync(sourcePath, "utf8");

  const serializerStart = source.indexOf("export function serializeSessionRecordForDisk");
  assert.notEqual(serializerStart, -1, "serializeSessionRecordForDisk not found");

  const serializerBlock = source.slice(serializerStart);
  const forbiddenPersistedKeys = [
    "acpxRecordId",
    "acpSessionId",
    "agentSessionId",
    "agentCommand",
    "createdAt",
    "lastUsedAt",
    "lastSeq",
    "lastRequestId",
    "eventLog",
    "closedAt",
    "agentStartedAt",
    "lastPromptAt",
    "lastAgentExitCode",
    "lastAgentExitSignal",
    "lastAgentExitAt",
    "lastAgentDisconnectReason",
    "protocolVersion",
    "agentCapabilities",
  ];

  for (const key of forbiddenPersistedKeys) {
    const matcher = new RegExp(`\\b${key}\\s*:`, "g");
    assert.equal(
      matcher.test(serializerBlock),
      false,
      `serializer contains non-snake persisted key literal: ${key}`,
    );
  }
}

assertSerializationPolicy();
assertSerializerSourceKeys();
