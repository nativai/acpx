// UMQ A1 (brick 0a6deb9a) — `acpx <agent> prompt --no-wait --session-id <id> --batch-file <path|->` through
// the REAL CLI, a REAL queue owner and the repo's mock ACP agent (CONTRACTS K3/K4). Each row reads the
// session's own stream file — the `session/prompt` frame as the client sent it. Rows are titled with their
// TEST-PLAN §4.1 ids.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const GOLDEN = fileURLToPath(
  new URL("../../test/fixtures/queue/batch-of-one.golden.json", import.meta.url),
);

type CliRun = { code: number | null; stdout: string; stderr: string };

const IDENTITY_ENV = [
  "ACPX_SESSION_URL",
  "ACPX_SESSION_NAME",
  "ACPX_PARENT_SESSION_URL",
  "ACPX_PARENT_SEAT_URL",
  "ACPX_SEAT_URL",
  "ACPX_TASK_FOLDER",
  "ACPX_BRICK",
  "ACPX_BRICK_PATH",
  "ACPX_OWNER_LOG",
  "ACPX_SUBSCRIPTION",
  "ACPX_ADMISSION_CLASS",
];

async function runCli(args: string[], homeDir: string, stdin?: string): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
  for (const key of IDENTITY_ENV) {
    delete env[key];
  }
  return await new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: homeDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI timed out: acpx ${args.join(" ")}`));
    }, 60_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin ?? "");
  });
}

async function withHome(prefix: string, body: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await body(homeDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function newSession(homeDir: string, agent = MOCK_AGENT): Promise<string> {
  const run = await runCli(["--format", "json", "--agent", agent, "sessions", "new"], homeDir);
  assert.equal(run.code, 0, run.stderr);
  return (JSON.parse(run.stdout) as { acpxRecordId: string }).acpxRecordId;
}

async function closeSession(homeDir: string, sessionId: string, agent = MOCK_AGENT): Promise<void> {
  await runCli(["--agent", agent, "sessions", "close", "--session-id", sessionId], homeDir);
}

function memberId(n: number): string {
  return `0a6deb9a-2222-4000-8000-${String(n).padStart(12, "0")}`;
}

async function writeBatch(
  homeDir: string,
  members: Array<{ messageId: string; text: string }>,
): Promise<string> {
  const file = path.join(homeDir, `batch-${members.length}-${Date.now()}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({
      v: 1,
      messages: members.map((member) => ({
        messageId: member.messageId,
        prompt: [{ type: "text", text: member.text }],
      })),
    }),
  );
  return file;
}

type StreamLine = { method?: string; id?: unknown; params?: Record<string, unknown> };

async function streamLines(
  homeDir: string,
  sessionId: string,
): Promise<{ raw: string[]; parsed: StreamLine[] }> {
  const file = path.join(homeDir, ".acpx", "sessions", `${sessionId}.stream.ndjson`);
  const raw = (await fs.readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return { raw, parsed: raw.map((line) => JSON.parse(line) as StreamLine) };
}

async function waitForDone(
  homeDir: string,
  sessionId: string,
  count: number,
): Promise<StreamLine[]> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const { parsed } = await streamLines(homeDir, sessionId);
    const done = parsed.filter(
      (line) => line.method === "acpx/delivery" && line.params?.phase === "done",
    );
    if (done.length >= count) {
      return parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fewer than ${count} done terminals on ${sessionId}`);
}

function promptFrames(lines: StreamLine[]): StreamLine[] {
  return lines.filter((line) => line.method === "session/prompt");
}

function phases(lines: StreamLine[], messageId: string): string[] {
  return lines
    .filter((line) => line.method === "acpx/delivery" && line.params?.messageId === messageId)
    .map((line) => String(line.params?.phase));
}

function normalizePromptFrame(raw: string): string {
  const frame = JSON.parse(raw) as { id: unknown; params: { sessionId: string } };
  return raw
    .replace(`"id":${JSON.stringify(frame.id)},`, '"id":"<id>",')
    .replace(frame.params.sessionId, "<acp-session>");
}

test("N-A1-1: a one-member batch file writes the SAME session/prompt line as today's single prompt (golden from 5c21f164)", async () => {
  const golden = JSON.parse(await fs.readFile(GOLDEN, "utf8")) as { frame: string };
  await withHome("acpx-umq-golden-", async (homeDir) => {
    const sessionId = await newSession(homeDir);
    try {
      const file = await writeBatch(homeDir, [
        { messageId: "0a6deb9a-9999-4000-8000-000000000001", text: "echo golden batch of one" },
      ]);
      const run = await runCli(
        [
          "--agent",
          MOCK_AGENT,
          "prompt",
          "--no-wait",
          "--session-id",
          sessionId,
          "--batch-file",
          file,
        ],
        homeDir,
      );
      assert.equal(run.code, 0, run.stderr);
      await waitForDone(homeDir, sessionId, 1);
      const { raw, parsed } = await streamLines(homeDir, sessionId);
      const frames = raw.filter((line) => line.includes('"method":"session/prompt"'));
      assert.equal(frames.length, 1);
      assert.equal(
        normalizePromptFrame(frames[0]),
        golden.frame,
        "byte-identical to today's frame",
      );
      const received = parsed.filter((line) => line.method === "acpx/received");
      assert.equal(received.length, 1);
      assert.equal(String(received[0].params?.requestId).includes("#"), false, "plain requestId");
    } finally {
      await closeSession(homeDir, sessionId);
    }
  });
});

test("G5 (end to end): a batch of 3 through --batch-file is ONE session/prompt carrying _meta acpx/batch; 3 received, 3 accepted, 3 done", async () => {
  await withHome("acpx-umq-batch3-", async (homeDir) => {
    const sessionId = await newSession(homeDir);
    try {
      const members = [1, 2, 3].map((n) => ({ messageId: memberId(n), text: `echo member ${n}` }));
      const run = await runCli(
        [
          "--agent",
          MOCK_AGENT,
          "prompt",
          "--no-wait",
          "--session-id",
          sessionId,
          "--batch-file",
          "-",
        ],
        homeDir,
        JSON.stringify({
          v: 1,
          messages: members.map((member) => ({
            messageId: member.messageId,
            prompt: [{ type: "text", text: member.text }],
          })),
        }),
      );
      assert.equal(run.code, 0, run.stderr);
      const lines = await waitForDone(homeDir, sessionId, 3);
      const frames = promptFrames(lines);
      assert.equal(frames.length, 1, "ONE prompt for the batch");
      const meta = (frames[0].params?._meta as Record<string, unknown> | undefined)?.[
        "acpx/batch"
      ] as { members: Array<{ messageId: string; requestId: string }> } | undefined;
      assert.deepEqual(
        meta?.members.map((member) => member.messageId),
        members.map((member) => member.messageId),
      );
      assert.equal(frames[0].params?.messageId, memberId(1));
      const received = lines.filter((line) => line.method === "acpx/received");
      assert.equal(received.length, 3);
      assert.deepEqual(
        received.map((line) => String(line.params?.requestId).split("#")[1]),
        ["0", "1", "2"],
      );
      for (const member of members) {
        assert.deepEqual(phases(lines, member.messageId), ["accepted", "done"]);
      }
    } finally {
      await closeSession(homeDir, sessionId);
    }
  });
});

test("N-A1-4: two prompts submitted while the adapter connects go into the turn's ONE prompt", async () => {
  const slowAgent = `${MOCK_AGENT} --claude-agent-acp --initialize-delay-ms 6000`;
  await withHome("acpx-umq-gather-", async (homeDir) => {
    const sessionId = await newSession(homeDir, slowAgent);
    try {
      const send = async (n: number) =>
        await runCli(
          [
            "--agent",
            slowAgent,
            "prompt",
            "--no-wait",
            "--session-id",
            sessionId,
            "--message-id",
            memberId(10 + n),
            `echo gathered ${n}`,
          ],
          homeDir,
        );
      // The first starts the owner, which takes it and begins connecting (initialize held 6 s).
      assert.equal((await send(1)).code, 0);
      assert.equal((await send(2)).code, 0);
      assert.equal((await send(3)).code, 0);
      const lines = await waitForDone(homeDir, sessionId, 3);
      const frames = promptFrames(lines);
      assert.equal(frames.length, 1, "ONE session/prompt, not a prompt and two injections");
      const meta = (frames[0].params?._meta as Record<string, unknown> | undefined)?.[
        "acpx/batch"
      ] as { members: Array<{ messageId: string }> } | undefined;
      assert.deepEqual(
        meta?.members.map((member) => member.messageId),
        [memberId(11), memberId(12), memberId(13)],
      );
    } finally {
      await closeSession(homeDir, sessionId, slowAgent);
    }
  });
});

test("N-A1-11: --batch-file usage refusals exit 2 with `acpx: --batch-file …` and submit nothing", async () => {
  await withHome("acpx-umq-usage-", async (homeDir) => {
    const sessionId = await newSession(homeDir);
    try {
      const good = await writeBatch(homeDir, [{ messageId: memberId(1), text: "echo x" }]);
      const write = async (name: string, body: unknown): Promise<string> => {
        const file = path.join(homeDir, name);
        await fs.writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
        return file;
      };
      const prompt = [{ type: "text", text: "x" }];
      const cases: Array<{ what: string; args: string[]; rule: RegExp }> = [
        {
          what: "without --no-wait",
          args: ["prompt", "--session-id", sessionId, "--batch-file", good],
          rule: /^acpx: --batch-file requires --no-wait$/mu,
        },
        {
          what: "with --message-id",
          args: [
            "prompt",
            "--no-wait",
            "--session-id",
            sessionId,
            "--message-id",
            memberId(2),
            "--batch-file",
            good,
          ],
          rule: /^acpx: --batch-file cannot be combined with --message-id$/mu,
        },
        {
          what: "with positional text",
          args: ["prompt", "--no-wait", "--session-id", sessionId, "--batch-file", good, "hello"],
          rule: /^acpx: --batch-file cannot be combined with positional prompt text$/mu,
        },
        {
          what: "with --file",
          args: [
            "prompt",
            "--no-wait",
            "--session-id",
            sessionId,
            "--file",
            good,
            "--batch-file",
            good,
          ],
          rule: /^acpx: --batch-file cannot be combined with --file$/mu,
        },
        {
          what: "with --seat",
          args: [
            "prompt",
            "--no-wait",
            "--seat",
            "0a6deb9a-0000-4000-8000-0000000000aa",
            "--batch-file",
            good,
          ],
          rule: /^acpx: --batch-file cannot be combined with --seat$/mu,
        },
        {
          what: "a v:2 body",
          args: [
            "prompt",
            "--no-wait",
            "--session-id",
            sessionId,
            "--batch-file",
            await write("v2.json", { v: 2, messages: [{ messageId: memberId(3), prompt }] }),
          ],
          rule: /^acpx: --batch-file version 2 is not supported/mu,
        },
        {
          what: "a duplicate member messageId",
          args: [
            "prompt",
            "--no-wait",
            "--session-id",
            sessionId,
            "--batch-file",
            await write("dup.json", {
              v: 1,
              messages: [
                { messageId: memberId(4), prompt },
                { messageId: memberId(4), prompt },
              ],
            }),
          ],
          rule: /^acpx: --batch-file messages\[1\]: duplicate messageId/mu,
        },
        {
          what: "a member whose messageId is not a lowercase UUID",
          args: [
            "prompt",
            "--no-wait",
            "--session-id",
            sessionId,
            "--batch-file",
            await write("upper.json", {
              v: 1,
              messages: [{ messageId: memberId(5).toUpperCase(), prompt }],
            }),
          ],
          rule: /^acpx: --batch-file messages\[0\]: messageId must be a lowercase UUID$/mu,
        },
      ];
      for (const entry of cases) {
        const run = await runCli(["--agent", MOCK_AGENT, ...entry.args], homeDir);
        assert.equal(run.code, 2, `${entry.what}: exit 2 (${run.stderr})`);
        assert.match(run.stderr, entry.rule, entry.what);
      }
      const { parsed } = await streamLines(homeDir, sessionId);
      assert.equal(
        parsed.filter((line) => line.method === "acpx/received").length,
        0,
        "nothing reached an owner",
      );
    } finally {
      await closeSession(homeDir, sessionId);
    }
  });
});
