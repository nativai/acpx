import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { agentPodEnv, agentPodHome, tmpDir } from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
import type { AtriumScript, RecordedAtrium } from "./pod-kit/recorded-atrium.js";

// brick cc2f6a98 — from an agent pod, `sessions new --prompt-file` must say `promptQueued:true`
// exactly when atrium queued the brief. Through the SHIPPED CLI (src/cli.js → dist), as the defect
// lives on the CLI path: the pass-through prints the control pod's stdout, and that stdout was
// written by an acpx that was never given the brief (atrium takes it out of argv, C6.2), so it
// says `promptQueued:false` for a brief atrium then queued. The truth is in the answer's `delivery`.

/**
 * What the CONTROL pod's acpx prints for a sleeping create it was given no first turn for — the TE's
 * evidence line (acpx 5ed94dad, 08:14Z): `render.ts` `sleepingJson` + `printNewSessionByFormat`.
 */
const SLEEPING_CREATE_LINE =
  '{"action":"session_ensured","created":true,"acpxRecordId":"ed3e38bd-2768-48ca-8912-97aa64813288",' +
  '"acpxSessionId":"","agentSessionId":"","cwd":"/workspace","sessionUrl":"https://atrium.example/?session=ed3e38bd-2768-48ca-8912-97aa64813288",' +
  '"promptQueued":false,"sleeping":true}\n';

/** The SHIPPED bundle (`pnpm build` first): an in-process object can carry the right value while the CLI prints another (59070d68). */
const SHIPPED_CLI = path.resolve(process.cwd(), "dist/cli.js");

function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  options: { cwd?: string } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHIPPED_CLI, ...argv], {
      env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end("");
  });
}

const ASK = ["--format", "json", "sessions", "new", "--name", "child", "--prompt-file", "brief.md"];

async function withAtrium(script: AtriumScript, run: (atrium: RecordedAtrium) => Promise<void>) {
  const atrium = await startRecordedAtrium(script);
  try {
    await run(atrium);
  } finally {
    await atrium.close();
  }
}

async function spawnWithBrief(atrium: RecordedAtrium, brief: string) {
  const { home } = agentPodHome();
  const work = tmpDir("acpx-cc2f-work-");
  fs.writeFileSync(path.join(work, "brief.md"), brief);
  const result = await runCli(ASK, agentPodEnv(home, atrium.url), { cwd: work });
  const call = atrium.requests.find((r) => r.route === "call");
  return { result, call };
}

function resultLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 1, `one result line, got: ${stdout}`);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

test("cc2f row 1: the brief atrium queued is reported promptQueued:true (still sleeping), the other fields untouched", async () => {
  await withAtrium(
    { calls: [{ answer: { exit: 0, stdout: SLEEPING_CREATE_LINE } }] },
    async (atrium) => {
      const { result, call } = await spawnWithBrief(atrium, "the brief\n");
      assert.equal(result.status, 0, result.stderr);
      assert.ok(call, "the call reached atrium");
      const line = resultLine(result.stdout);
      assert.equal(line.promptQueued, true, `atrium queued the brief: ${result.stdout}`);
      assert.equal(line.sleeping, true, "the session still sleeps: queued AND sleeping");
      const expected = JSON.parse(SLEEPING_CREATE_LINE) as Record<string, unknown>;
      expected.promptQueued = true;
      assert.deepEqual(line, expected, "nothing but promptQueued changed");
    },
  );
});

test("cc2f row 1b: a brief atrium HOLDS for room is still queued — promptQueued:true", async () => {
  await withAtrium(
    {
      calls: [{ answer: { exit: 0, stdout: SLEEPING_CREATE_LINE } }],
      firstMessageHold: { reason: "no_capacity", ahead: 2 },
    },
    async (atrium) => {
      const { result } = await spawnWithBrief(atrium, "the brief\n");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(resultLine(result.stdout).promptQueued, true, result.stdout);
    },
  );
});

test("cc2f row 2 (NEGATIVE): a brief that is blank queues nothing — atrium answers no delivery, the field says false", async () => {
  await withAtrium(
    { calls: [{ answer: { exit: 0, stdout: SLEEPING_CREATE_LINE } }] },
    async (atrium) => {
      const { result } = await spawnWithBrief(atrium, "  \n\n");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(resultLine(result.stdout).promptQueued, false, result.stdout);
    },
  );
});

test("cc2f row 3 (NEGATIVE): only the fork NOTICE was queued, not the brief — the field says false", async () => {
  await withAtrium(
    {
      calls: [{ answer: { exit: 0, stdout: SLEEPING_CREATE_LINE } }],
      forkNotice: "You are a fork.",
    },
    async (atrium) => {
      const { result } = await spawnWithBrief(atrium, "\n");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        resultLine(result.stdout).promptQueued,
        false,
        `the notice is not the brief: ${result.stdout}`,
      );
    },
  );
});

test("cc2f row 4 (NEGATIVE, the real failure): atrium could not queue the brief — non-zero exit, and NO promptQueued:true anywhere on stdout", async () => {
  await withAtrium(
    {
      calls: [
        {
          answer: {
            status: 500,
            body: {
              exit: 0,
              stdout: SLEEPING_CREATE_LINE,
              stderr: "",
              error: "first-message-not-queued",
              reason: "append failed",
            },
          },
        },
      ],
    },
    async (atrium) => {
      const { result } = await spawnWithBrief(atrium, "the brief\n");
      assert.notEqual(result.status, 0, "the failure is loud");
      assert.equal(result.stdout.includes('"promptQueued":true'), false, result.stdout);
    },
  );
});

test("cc2f row 5 (NEGATIVE): a create with NO brief is not rewritten — it still prints what the control pod printed", async () => {
  await withAtrium(
    { calls: [{ answer: { exit: 0, stdout: SLEEPING_CREATE_LINE } }] },
    async (atrium) => {
      const { home } = agentPodHome();
      const result = await runCli(
        ["--format", "json", "sessions", "new", "--name", "child"],
        agentPodEnv(home, atrium.url),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, SLEEPING_CREATE_LINE, "verbatim");
    },
  );
});

test("cc2f row 6 (text mode): atrium queued the brief — stderr says first turn queued, never that it was NOT queued", async () => {
  await withAtrium(
    {
      calls: [
        {
          answer: {
            exit: 0,
            stdout: "ed3e38bd-2768-48ca-8912-97aa64813288\n",
            stderr:
              "[acpx] created session ed3e38bd-2768-48ca-8912-97aa64813288 (sleeping — its first message starts it)\n",
          },
        },
      ],
    },
    async (atrium) => {
      const { home } = agentPodHome();
      const work = tmpDir("acpx-cc2f-work-");
      fs.writeFileSync(path.join(work, "brief.md"), "the brief\n");
      const result = await runCli(
        ["sessions", "new", "--name", "child", "--prompt-file", "brief.md"],
        agentPodEnv(home, atrium.url),
        { cwd: work },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "ed3e38bd-2768-48ca-8912-97aa64813288\n", "stdout verbatim");
      assert.match(result.stderr, /\[acpx\] first turn queued \(from brief\.md\)/u);
      assert.doesNotMatch(result.stderr, /NOT queued/u);
    },
  );
});

test("cc2f row 7 (text mode, NEGATIVE): a blank brief queued nothing — no 'first turn queued' line", async () => {
  await withAtrium(
    {
      calls: [{ answer: { exit: 0, stdout: "ed3e38bd-2768-48ca-8912-97aa64813288\n" } }],
    },
    async (atrium) => {
      const { home } = agentPodHome();
      const work = tmpDir("acpx-cc2f-work-");
      fs.writeFileSync(path.join(work, "brief.md"), " \n");
      const result = await runCli(
        ["sessions", "new", "--name", "child", "--prompt-file", "brief.md"],
        agentPodEnv(home, atrium.url),
        { cwd: work },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /first turn queued/u);
    },
  );
});

test("cc2f row 8 (NEGATIVE): a non-create verb prints the control pod's stdout verbatim, even a line that looks like a sleeping create", async () => {
  await withAtrium(
    { calls: [{ answer: { exit: 0, stdout: SLEEPING_CREATE_LINE } }] },
    async (atrium) => {
      const { home } = agentPodHome();
      const result = await runCli(
        ["--format", "json", "seats", "rename", "11111111-1111-4111-8111-111111111111", "x"],
        agentPodEnv(home, atrium.url),
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, SLEEPING_CREATE_LINE, "verbatim");
    },
  );
});

test("cc2f row 3b: a brief AND a fork notice both queued — delivery names the brief, the field says true", async () => {
  await withAtrium(
    {
      calls: [{ answer: { exit: 0, stdout: SLEEPING_CREATE_LINE } }],
      forkNotice: "You are a fork.",
    },
    async (atrium) => {
      const { result } = await spawnWithBrief(atrium, "a real brief\n");
      assert.equal(resultLine(result.stdout).promptQueued, true, result.stdout);
    },
  );
});
