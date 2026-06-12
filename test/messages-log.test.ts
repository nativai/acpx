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
    const record = sessionRecord("missing", [userMessage(1)], {
      messagesLog: { v: 1, count: 7, base_index: 0, bytes: 128 },
    });

    const { result, stderr } = await captureStderr(async () => {
      return await hydrateSessionMessagesFromLog(record, messagesLogPath(sessionDir, "missing"));
    });

    assert.deepEqual(messageLabels(result.messages), ["user-1"]);
    assert.match(stderr, /messages log missing/);
  });
});

test("hydrate self-heals an inline non-empty no-pointer record by renaming a stale log", async () => {
  await withTempHome("acpx-messages-log-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const { path: logPath } = await writeMessagesLog(sessionDir, "stale", [agentMessage(9)]);
    const record = sessionRecord("stale", [userMessage(1)]);

    const hydrated = await hydrateSessionMessagesFromLog(record, logPath);

    assert.deepEqual(messageLabels(hydrated.messages), ["user-1"]);
    assert.equal(await fileExists(logPath), false);
    assert.equal(await fileExists(`${logPath}.stale`), true);
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
      const count = Math.floor(random() * 260);
      const messages = Array.from({ length: count }, (_unused, index) =>
        randomMessage(iteration * 1_000 + index, random),
      );
      const splitAt = count === 0 ? 0 : Math.floor(random() * (count + 1));
      const id = `property-${iteration}`;

      const expected = await hydrateSessionMessagesFromLog(
        sessionRecord(`${id}-expected`, structuredClone(messages)),
        messagesLogPath(sessionDir, `${id}-expected`),
      );

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
      assert.deepEqual(actual.messages, expected.messages);
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
      await writeSessionRecordFile(
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
