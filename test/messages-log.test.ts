import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import {
  appendFinalizedMessagesToLog,
  compactMessagesLog,
  hydrateSessionMessagesFromLog,
  messagesLogPath,
} from "../src/session/messages-log.js";
import {
  readPersistedLifecycle,
  resolveSessionRecord,
  serializeSessionRecordForDisk,
  writeSessionRecord,
  writeSessionRecordAtBoundary,
} from "../src/session/persistence.js";
import type { SessionMessage, SessionRecord } from "../src/types.js";
import {
  assertTempHomeActive,
  fileExists,
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function userMessage(index: number, text = `user-${index}`): SessionMessage {
  return {
    User: {
      id: `user-${index}`,
      content: [{ Text: text }],
    },
  };
}

function agentMessage(index: number, text = `agent-${index}`): SessionMessage {
  return {
    Agent: {
      content: [{ Text: text }],
      tool_results: {},
    },
  };
}

function overCapText(label: string): string {
  return `${label}-${"z".repeat(9_000)}`;
}

function toolMessage(index: number): SessionMessage {
  const toolUseId = `tool-${index}`;
  return {
    Agent: {
      content: [
        {
          ToolUse: {
            id: toolUseId,
            name: "shell",
            input: { command: `echo ${index}` },
            raw_input: `{"command":"echo ${index}"}`,
            is_input_complete: true,
          },
        },
      ],
      tool_results: {
        [toolUseId]: {
          tool_use_id: toolUseId,
          tool_name: "shell",
          is_error: false,
          content: { Text: `result-${index}` },
        },
      },
    },
  };
}

function messageLabels(messages: readonly SessionMessage[]): string[] {
  return messages.map((message) => {
    if (message === "Resume") {
      return "Resume";
    }
    if ("User" in message) {
      return message.User.id;
    }
    const text = message.Agent.content
      .map((content) => {
        if ("Text" in content) {
          return content.Text;
        }
        if ("ToolUse" in content) {
          return content.ToolUse.id;
        }
        return "";
      })
      .join("|");
    return text;
  });
}

function sessionRecord(
  id: string,
  messages: SessionMessage[],
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    ...makeSessionRecord(
      {
        acpxRecordId: id,
        acpSessionId: id,
        agentCommand: AGENT_REGISTRY.codex,
        cwd: "/tmp/acpx-messages-log-test",
        messages,
      },
      { defaultName: false, defaultAcpx: false },
    ),
    ...overrides,
  };
}

function serializeMessages(messages: readonly SessionMessage[]): string {
  return messages.length === 0
    ? ""
    : `${messages.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function writeMessagesLog(
  sessionDir: string,
  recordId: string,
  messages: readonly SessionMessage[],
  suffix = "",
): Promise<{ path: string; completeBytes: number }> {
  assertTempHomeActive();
  const logPath = messagesLogPath(sessionDir, recordId);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const payload = serializeMessages(messages);
  await fs.writeFile(logPath, `${payload}${suffix}`, "utf8");
  return { path: logPath, completeBytes: Buffer.byteLength(payload) };
}

async function writeRawRecord(homeDir: string, record: SessionRecord): Promise<void> {
  assertTempHomeActive();
  const recordPath = sessionFilePath(homeDir, record.acpxRecordId);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(
    recordPath,
    `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
    "utf8",
  );
}

async function writeSplitRecord(homeDir: string, record: SessionRecord): Promise<void> {
  assertTempHomeActive();
  const recordPath = sessionFilePath(homeDir, record.acpxRecordId);
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(
    recordPath,
    `${JSON.stringify({
      ...serializeSessionRecordForDisk(record),
      messages_log: record.messagesLog,
    })}\n`,
    "utf8",
  );
}

async function readRawRecord(
  homeDir: string,
  acpxRecordId: string,
): Promise<Record<string, unknown>> {
  assertTempHomeActive();
  return JSON.parse(await fs.readFile(sessionFilePath(homeDir, acpxRecordId), "utf8")) as Record<
    string,
    unknown
  >;
}

async function captureStderr<T>(run: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), stderr };
  } finally {
    process.stderr.write = originalWrite;
  }
}

async function runBuiltCli(args: readonly string[], homeDir: string): Promise<CliResult> {
  const child = spawn(process.execPath, [path.resolve("dist/cli.js"), ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  return { code, stdout, stderr };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomMessage(index: number, random: () => number): SessionMessage {
  const shape = Math.floor(random() * 4);
  if (shape === 0) {
    const extra = random() > 0.85 ? "x".repeat(9_000) : "";
    return userMessage(index, `user-${index}-${extra}`);
  }
  if (shape === 1) {
    const extra = random() > 0.85 ? "y".repeat(9_000) : "";
    return agentMessage(index, `agent-${index}-${extra}`);
  }
  if (shape === 2) {
    return toolMessage(index);
  }
  return "Resume";
}

test("serializeSessionRecordForDisk drops messages_log for write-inline records", () => {
  const messages = [userMessage(1)];
  const record = sessionRecord("serialize-drop", structuredClone(messages), {
    messagesLog: { v: 1, count: 5, base_index: 0, bytes: 512 },
  });

  const persisted = serializeSessionRecordForDisk(record);

  assert.equal(Object.hasOwn(persisted, "messages_log"), false);
  assert.deepEqual(persisted.messages, messages);
});

test("appendFinalizedMessagesToLog truncates from the watermark before appending", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const first = userMessage(1);
    const appended = agentMessage(2);
    const firstBytes = Buffer.byteLength(serializeMessages([first]));
    const logPath = messagesLogPath(sessionDir, "append");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      logPath,
      `${serializeMessages([first])}${JSON.stringify(agentMessage(99)).slice(0, 12)}`,
      "utf8",
    );

    const record = sessionRecord("append", [], {
      messagesLog: { v: 1, count: 1, base_index: 0, bytes: firstBytes },
    });
    await appendFinalizedMessagesToLog(record, logPath, [appended]);

    const expectedPayload = serializeMessages([first, appended]);
    assert.equal(await fs.readFile(logPath, "utf8"), expectedPayload);
    assert.deepEqual(record.messagesLog, {
      v: 1,
      count: 2,
      base_index: 0,
      bytes: Buffer.byteLength(expectedPayload),
    });
  });
});

test("writeSessionRecord keeps split records split without touching the log", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const messages = [userMessage(1), agentMessage(2), toolMessage(3)];
    const logMessages = messages.slice(0, 2);
    const inlineMessages = messages.slice(2);
    const log = await writeMessagesLog(sessionDir, "fold-write", logMessages);
    const originalLogPayload = await fs.readFile(log.path, "utf8");
    await writeSplitRecord(
      homeDir,
      sessionRecord("fold-write", structuredClone(inlineMessages), {
        messagesLog: {
          v: 1,
          count: logMessages.length,
          base_index: 0,
          bytes: log.completeBytes,
        },
      }),
    );

    const resolved = await resolveSessionRecord("fold-write");
    assert.deepEqual(resolved.messages, messages);

    await writeSessionRecord(resolved);

    const raw = await readRawRecord(homeDir, "fold-write");
    assert.deepEqual(raw.messages, inlineMessages);
    assert.deepEqual(raw.messages_log, {
      v: 1,
      count: logMessages.length,
      base_index: 0,
      bytes: log.completeBytes,
    });
    assert.equal(await fs.readFile(log.path, "utf8"), originalLogPayload);
  });
});

test("writeSessionRecordAtBoundary migrates legacy inline records to split form", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const messages = [userMessage(1), agentMessage(2), userMessage(3)];
    await writeRawRecord(homeDir, sessionRecord("boundary-migrate", structuredClone(messages)));

    await writeSessionRecordAtBoundary(await resolveSessionRecord("boundary-migrate"));

    const raw = await readRawRecord(homeDir, "boundary-migrate");
    const logPath = messagesLogPath(sessionDir, "boundary-migrate");
    assert.deepEqual(raw.messages, []);
    assert.deepEqual(raw.messages_log, {
      v: 1,
      count: messages.length,
      base_index: 0,
      bytes: Buffer.byteLength(serializeMessages(messages)),
    });
    assert.equal(await fs.readFile(logPath, "utf8"), serializeMessages(messages));

    const hydrated = await resolveSessionRecord("boundary-migrate");
    assert.deepEqual(hydrated.messages, messages);
  });
});

test("boundary migration renames a pointer-less pre-existing log before writing a fresh one", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const staleMessages = [agentMessage(99)];
    const freshMessages = [userMessage(1), agentMessage(2)];
    const stale = await writeMessagesLog(sessionDir, "rename-first", staleMessages);
    const stalePayload = await fs.readFile(stale.path, "utf8");
    await writeRawRecord(homeDir, sessionRecord("rename-first", structuredClone(freshMessages)));

    await writeSessionRecordAtBoundary(await resolveSessionRecord("rename-first"));

    assert.equal(await fs.readFile(`${stale.path}.stale`, "utf8"), stalePayload);
    assert.equal(await fs.readFile(stale.path, "utf8"), serializeMessages(freshMessages));
    const raw = await readRawRecord(homeDir, "rename-first");
    assert.deepEqual(raw.messages, []);
    assert.deepEqual(raw.messages_log, {
      v: 1,
      count: freshMessages.length,
      base_index: 0,
      bytes: Buffer.byteLength(serializeMessages(freshMessages)),
    });
  });
});

test("checkpoints never append unlogged split tails and the next boundary appends once", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const logMessages = [userMessage(1), agentMessage(2)];
    const inlineMessages = [userMessage(3)];
    const log = await writeMessagesLog(sessionDir, "append-once", logMessages);
    await writeSplitRecord(
      homeDir,
      sessionRecord("append-once", structuredClone(inlineMessages), {
        messagesLog: {
          v: 1,
          count: logMessages.length,
          base_index: 0,
          bytes: log.completeBytes,
        },
      }),
    );

    const resolved = await resolveSessionRecord("append-once");
    await writeSessionRecord(resolved);
    await writeSessionRecord(resolved);
    await writeSessionRecord(resolved);

    assert.equal(await fs.readFile(log.path, "utf8"), serializeMessages(logMessages));
    assert.deepEqual((await readRawRecord(homeDir, "append-once")).messages, inlineMessages);

    await writeSessionRecordAtBoundary(resolved);

    assert.equal(
      await fs.readFile(log.path, "utf8"),
      serializeMessages([...logMessages, ...inlineMessages]),
    );
    const raw = await readRawRecord(homeDir, "append-once");
    assert.deepEqual(raw.messages, []);
    assert.deepEqual(raw.messages_log, {
      v: 1,
      count: 3,
      base_index: 0,
      bytes: Buffer.byteLength(serializeMessages([...logMessages, ...inlineMessages])),
    });
  });
});

test("boundary compaction rewrites the current window and advances base_index", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const previousThreshold = process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES;
    process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES = "1";
    try {
      const messages = Array.from({ length: 205 }, (_, index) => userMessage(index + 1));
      await writeRawRecord(homeDir, sessionRecord("boundary-compact", structuredClone(messages)));

      await writeSessionRecordAtBoundary(await resolveSessionRecord("boundary-compact"));

      const raw = await readRawRecord(homeDir, "boundary-compact");
      assert.deepEqual(raw.messages, []);
      assert.deepEqual(raw.messages_log, {
        v: 1,
        count: 200,
        base_index: 5,
        bytes: Buffer.byteLength(serializeMessages(messages.slice(5))),
      });

      const hydrated = await resolveSessionRecord("boundary-compact");
      assert.deepEqual(messageLabels(hydrated.messages), messageLabels(messages.slice(5)));
    } finally {
      if (previousThreshold === undefined) {
        delete process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES;
      } else {
        process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES = previousThreshold;
      }
    }
  });
});

test("hydrate applies watermark delta repair with positional inline dedup", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const base = [userMessage(1)];
    const delta = [agentMessage(2), userMessage(3)];
    const inlineAfterDelta = [agentMessage(4)];
    const { path: logPath, completeBytes: baseBytes } = await writeMessagesLog(
      sessionDir,
      "delta",
      base,
      serializeMessages(delta),
    );
    const record = sessionRecord("delta", [...delta, ...inlineAfterDelta], {
      messagesLog: { v: 1, count: base.length, base_index: 0, bytes: baseBytes },
    });

    const hydrated = await hydrateSessionMessagesFromLog(record, logPath);

    assert.deepEqual(messageLabels(hydrated.messages), ["user-1", "agent-2", "user-3", "agent-4"]);
    assert.equal(hydrated.messagesLog?.count, 3);
    assert.equal(
      hydrated.messagesLog?.bytes,
      Buffer.byteLength(serializeMessages([...base, ...delta])),
    );
  });
});

test("hydrate ignores a torn final line and keeps the inline checkpointed tail", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const base = [userMessage(1)];
    const inlineTail = [agentMessage(2)];
    const { path: logPath, completeBytes } = await writeMessagesLog(
      sessionDir,
      "torn",
      base,
      JSON.stringify(inlineTail[0]).slice(0, 10),
    );
    const record = sessionRecord("torn", inlineTail, {
      messagesLog: { v: 1, count: base.length, base_index: 0, bytes: completeBytes },
    });

    const hydrated = await hydrateSessionMessagesFromLog(record, logPath);

    assert.deepEqual(messageLabels(hydrated.messages), ["user-1", "agent-2"]);
  });
});

test("hydrate degrades to inline messages and warns when a pointed log is missing", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const messages = [userMessage(1, overCapText("missing-inline"))];
    const record = sessionRecord("missing", structuredClone(messages), {
      messagesLog: { v: 1, count: 7, base_index: 0, bytes: 128 },
    });

    const { result, stderr } = await captureStderr(async () => {
      return await hydrateSessionMessagesFromLog(record, messagesLogPath(sessionDir, "missing"));
    });

    assert.deepEqual(result.messages, messages);
    assert.match(stderr, /messages log missing/);
  });
});

test("hydrate leaves no-pointer records byte-preserved when a stale log is present", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const { path: logPath } = await writeMessagesLog(sessionDir, "stale", [agentMessage(9)]);
    const messages = [
      userMessage(1, overCapText("legacy-user")),
      agentMessage(2, overCapText("legacy-agent")),
    ];
    const record = sessionRecord("stale", structuredClone(messages));
    const before = JSON.stringify(record);

    const hydrated = await hydrateSessionMessagesFromLog(record, logPath);

    assert.equal(JSON.stringify(hydrated), before);
    assert.deepEqual(hydrated.messages, messages);
    assert.equal(await fileExists(logPath), true);
    assert.equal(await fileExists(`${logPath}.stale`), false);
  });
});

test("hydrate split records preserves over-cap content exactly like the legacy twin", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const messages = [
      userMessage(1, overCapText("split-log-user")),
      agentMessage(2, overCapText("split-log-agent")),
      userMessage(3, overCapText("split-inline-user")),
    ];
    const logMessages = messages.slice(0, 2);
    const inlineMessages = messages.slice(2);
    const legacy = sessionRecord("split-overcap-legacy", structuredClone(messages));
    const log = await writeMessagesLog(sessionDir, "split-overcap", logMessages);
    const splitRecord = sessionRecord("split-overcap", structuredClone(inlineMessages), {
      messagesLog: {
        v: 1,
        count: logMessages.length,
        base_index: 0,
        bytes: log.completeBytes,
      },
    });

    const hydrated = await hydrateSessionMessagesFromLog(splitRecord, log.path);

    assert.deepEqual(hydrated.messages, legacy.messages);
  });
});

test("hydrate bounds only the log tail and never drops inline messages for the count cap", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const logMessages = Array.from({ length: 10 }, (_unused, index) => userMessage(index + 1));
    const inlineMessages = Array.from({ length: 205 }, (_unused, index) =>
      agentMessage(index + 100),
    );
    const log = await writeMessagesLog(sessionDir, "inline-overcap", logMessages);
    const record = sessionRecord("inline-overcap", structuredClone(inlineMessages), {
      messagesLog: {
        v: 1,
        count: logMessages.length,
        base_index: 0,
        bytes: log.completeBytes,
      },
    });

    const hydrated = await hydrateSessionMessagesFromLog(record, log.path);

    assert.deepEqual(hydrated.messages, inlineMessages);
  });
});

test("hydrate handles empty log and log-only records", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const empty = await writeMessagesLog(sessionDir, "empty", []);
    const emptyRecord = sessionRecord("empty", [userMessage(1)], {
      messagesLog: { v: 1, count: 0, base_index: 0, bytes: 0 },
    });
    const emptyHydrated = await hydrateSessionMessagesFromLog(emptyRecord, empty.path);
    assert.deepEqual(messageLabels(emptyHydrated.messages), ["user-1"]);

    const logMessages = [userMessage(2), agentMessage(3)];
    const logOnly = await writeMessagesLog(sessionDir, "log-only", logMessages);
    const logOnlyRecord = sessionRecord("log-only", [], {
      messagesLog: {
        v: 1,
        count: logMessages.length,
        base_index: 0,
        bytes: logOnly.completeBytes,
      },
    });
    const logOnlyHydrated = await hydrateSessionMessagesFromLog(logOnlyRecord, logOnly.path);
    assert.deepEqual(messageLabels(logOnlyHydrated.messages), ["user-2", "agent-3"]);
  });
});

test("compactMessagesLog rewrites the current window and advances base_index", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const originalLogMessages = [
      userMessage(1),
      agentMessage(2),
      userMessage(3),
      agentMessage(4),
      userMessage(5),
    ];
    const kept = [userMessage(3), agentMessage(4), userMessage(5)];
    const { path: logPath, completeBytes } = await writeMessagesLog(
      sessionDir,
      "compact",
      originalLogMessages,
    );
    const record = sessionRecord("compact", kept, {
      messagesLog: {
        v: 1,
        count: originalLogMessages.length,
        base_index: 100,
        bytes: completeBytes,
      },
    });

    assert.equal(await compactMessagesLog(record, logPath, 1), true);

    assert.deepEqual(record.messagesLog, {
      v: 1,
      count: kept.length,
      base_index: 102,
      bytes: Buffer.byteLength(serializeMessages(kept)),
    });
    assert.equal(await fs.readFile(logPath, "utf8"), serializeMessages(kept));
  });
});

test("property: hydrate(split(record)) is equivalent to the inline window", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const random = seededRandom(0xace);

    for (let iteration = 0; iteration < 80; iteration += 1) {
      const count = Math.floor(random() * 201);
      const messages = Array.from({ length: count }, (_unused, index) =>
        randomMessage(iteration * 1_000 + index, random),
      );
      const splitAt = count === 0 ? 0 : Math.floor(random() * (count + 1));
      const id = `property-${iteration}`;

      const logMessages = messages.slice(0, splitAt);
      const inlineMessages = messages.slice(splitAt);
      const splitRecord = sessionRecord(id, structuredClone(inlineMessages));
      if (logMessages.length > 0) {
        const log = await writeMessagesLog(sessionDir, id, logMessages);
        splitRecord.messagesLog = {
          v: 1,
          count: logMessages.length,
          base_index: Math.floor(random() * 50),
          bytes: log.completeBytes,
        };
      }

      const actual = await hydrateSessionMessagesFromLog(
        splitRecord,
        messagesLogPath(sessionDir, id),
      );
      assert.deepEqual(actual.messages, messages);
    }
  });
});

test("repository hydration gives legacy and hand-split twins identical windows and CLI history", async () => {
  const messages = [
    userMessage(1, "first"),
    agentMessage(2, "second"),
    toolMessage(3),
    userMessage(4, "fourth"),
  ];

  async function setupStore(homeDir: string, split: boolean): Promise<string> {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    if (!split) {
      await writeSessionRecordFile(homeDir, sessionRecord("golden", structuredClone(messages)));
    } else {
      const logMessages = messages.slice(0, 3);
      const inlineMessages = messages.slice(3);
      const log = await writeMessagesLog(sessionDir, "golden", logMessages);
      await writeSplitRecord(
        homeDir,
        sessionRecord("golden", structuredClone(inlineMessages), {
          messagesLog: {
            v: 1,
            count: logMessages.length,
            base_index: 0,
            bytes: log.completeBytes,
          },
        }),
      );
    }

    const resolved = await resolveSessionRecord("golden");
    assert.deepEqual(resolved.messages, messages);
    const cli = await runBuiltCli(
      ["--format", "json", "codex", "sessions", "history", "golden"],
      homeDir,
    );
    assert.equal(cli.code, 0, cli.stderr);
    return cli.stdout;
  }

  let legacyOutput = "";
  await withTempHome("acpx-messages-log-legacy-", async (homeDir) => {
    legacyOutput = await setupStore(homeDir, false);
  });

  await withTempHome("acpx-messages-log-split-", async (homeDir) => {
    const splitOutput = await setupStore(homeDir, true);
    assert.equal(splitOutput, legacyOutput);
  });
});

test("readPersistedLifecycle stays non-hydrating and does not self-heal stale logs", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const { path: logPath } = await writeMessagesLog(sessionDir, "lifecycle", [agentMessage(9)]);
    await writeRawRecord(
      homeDir,
      sessionRecord("lifecycle", [userMessage(1)], {
        closed: true,
        closedAt: "2026-06-12T12:00:00.000Z",
      }),
    );

    const lifecycle = await readPersistedLifecycle("lifecycle");

    assert.equal(lifecycle?.closed, true);
    assert.equal(lifecycle?.closedAt, "2026-06-12T12:00:00.000Z");
    assert.equal(await fileExists(logPath), true);
    assert.equal(await fileExists(`${logPath}.stale`), false);
  });
});
