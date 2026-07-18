import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The acpx-shipped hook lives at repo-root git-hooks/. From dist-test/test/*.js
// the repo root is two levels up.
const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK = join(REPO_ROOT, "git-hooks", "prepare-commit-msg");
const SESSION_URL = "https://acpx.devbox.nativai.de/?session=740e3fbc-1024-481e-96bb-203ac5eefb1b";
const SESSION_ID = "740e3fbc-1024-481e-96bb-203ac5eefb1b";
const BRICK_ID = "49d4ba9c-8ac1-4253-b7dd-f46374efb796";
// Expected Brick: URL = base URL (SESSION_URL up to '?') + ?brick=<uuid>
const BRICK_URL = `https://acpx.devbox.nativai.de/?brick=${BRICK_ID}`;

// Fixture transcript: exactly 3 genuine user-prompt turns amid noise the predicate
// must reject (tool_result carrier, assistant, isMeta/isSidechain/isCompactSummary,
// slash-command echo, null uuid).
const FIXTURE_LINES: unknown[] = [
  { type: "user", uuid: "u1", message: { role: "user", content: "first real prompt" } }, // ✅
  { type: "user", uuid: "u2", message: { content: [{ type: "tool_result", content: "x" }] } }, // ✗ tool_result
  { type: "assistant", uuid: "a1", message: { content: "hello" } }, // ✗ not user
  { type: "user", uuid: "u3", isMeta: true, message: { content: "meta" } }, // ✗ meta
  { type: "user", uuid: "u4", isSidechain: true, message: { content: "sidechain" } }, // ✗ sidechain
  { type: "user", uuid: "u5", isCompactSummary: true, message: { content: "compact" } }, // ✗ compact
  { type: "user", uuid: "u6", message: { content: "<command-name>/model</command-name>" } }, // ✗ slash echo
  { type: "user", uuid: null, message: { content: "no uuid" } }, // ✗ uuid null
  { type: "user", uuid: "u7", message: { content: [{ type: "text", text: "real array prompt" }] } }, // ✅
  { type: "user", uuid: "u8", message: { content: "second real prompt" } }, // ✅
];
const EXPECTED_K = 3;

type HookRun = { dir: string; message: string };

// Set up a scratch dir with an optional transcript, run the hook over a commit
// message, and return the resulting message text. cwd is a fresh git repo so
// `git interpret-trailers` behaves realistically.
function runHook(opts: {
  subject: string;
  env: Record<string, string | undefined>;
  transcript?: unknown[] | "malformed";
  reuseDir?: string;
}): HookRun {
  const dir = opts.reuseDir ?? mkdtempSync(join(tmpdir(), "acpx-hook-"));
  if (!opts.reuseDir) {
    execFileSync("git", ["init", "-q"], { cwd: dir });
  }
  const msgFile = join(dir, "COMMIT_EDITMSG");
  writeFileSync(msgFile, opts.subject);

  const configDir = join(dir, "claude-config");
  if (opts.transcript !== undefined) {
    const projectDir = join(configDir, "projects", "some-project");
    mkdirSync(projectDir, { recursive: true });
    const txPath = join(projectDir, `${SESSION_ID}.jsonl`);
    const body =
      opts.transcript === "malformed"
        ? '{"type":"user","uuid":"u1","message":{"content":"ok"}}\n{ this is not json\n'
        : opts.transcript.map((line) => JSON.stringify(line)).join("\n") + "\n";
    writeFileSync(txPath, body);
  }

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  execFileSync("sh", [HOOK, msgFile], { cwd: dir, env });
  return { dir, message: execFileSync("cat", [msgFile]).toString() };
}

function countLines(message: string, prefix: string): number {
  return message.split("\n").filter((l) => l.startsWith(prefix)).length;
}

test("hook exists and is executable", () => {
  assert.ok(existsSync(HOOK), `hook must exist at ${HOOK}`);
});

// Drive the real cases through a variant that injects CLAUDE_CONFIG_DIR = the
// per-run dir (which the base helper cannot know before it creates the dir).
function runHookWithTranscript(opts: {
  subject: string;
  extraEnv?: Record<string, string | undefined>;
  transcript?: unknown[] | "malformed";
  withSessionId?: boolean;
}): HookRun {
  const dir = mkdtempSync(join(tmpdir(), "acpx-hook-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const configDir = join(dir, "claude-config");
  return runHook({
    subject: opts.subject,
    reuseDir: dir,
    transcript: opts.transcript,
    env: {
      ACPX_SESSION_URL: SESSION_URL,
      CLAUDE_CONFIG_DIR: configDir,
      ...(opts.withSessionId === false ? {} : { CLAUDE_CODE_SESSION_ID: SESSION_ID }),
      ...opts.extraEnv,
    },
  });
}

test("hook: Session + Message with the correct turn count (dir-accurate)", () => {
  const { message } = runHookWithTranscript({
    subject: "feat: add widget\n",
    transcript: FIXTURE_LINES,
  });
  assert.equal(countLines(message, "Session:"), 1);
  assert.equal(message.match(/^Session: (.+)$/m)?.[1], SESSION_URL);
  assert.equal(countLines(message, "Message:"), 1);
  assert.equal(message.match(/^Message: (\d+)$/m)?.[1], String(EXPECTED_K));
});

test("hook: idempotent — a second run adds no duplicate trailers", () => {
  const dir = mkdtempSync(join(tmpdir(), "acpx-hook-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const configDir = join(dir, "claude-config");
  const projectDir = join(configDir, "projects", "p");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${SESSION_ID}.jsonl`),
    FIXTURE_LINES.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    ACPX_SESSION_URL: SESSION_URL,
    ACPX_BRICK: BRICK_ID,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_SESSION_ID: SESSION_ID,
  })) {
    if (v !== undefined) {
      env[k] = v;
    }
  }
  const msgFile = join(dir, "COMMIT_EDITMSG");
  writeFileSync(msgFile, "feat: repeat\n");
  execFileSync("sh", [HOOK, msgFile], { cwd: dir, env });
  execFileSync("sh", [HOOK, msgFile], { cwd: dir, env });
  const message = execFileSync("cat", [msgFile]).toString();
  assert.equal(countLines(message, "Session:"), 1, message);
  assert.equal(countLines(message, "Brick:"), 1, message);
  assert.equal(countLines(message, "Message:"), 1, message);
  rmSync(dir, { recursive: true, force: true });
});

test("hook: ACPX_SESSION_URL unset → complete no-op", () => {
  const { message } = runHookWithTranscript({
    subject: "chore: human commit\n",
    transcript: FIXTURE_LINES,
    extraEnv: { ACPX_SESSION_URL: undefined },
  });
  assert.equal(message, "chore: human commit\n");
});

test("hook: missing transcript → Session only, no Message", () => {
  // Session id set + jq present, but no transcript file written.
  const { message } = runHookWithTranscript({
    subject: "feat: no transcript\n",
    // no transcript → find yields nothing
  });
  assert.equal(countLines(message, "Session:"), 1);
  assert.equal(countLines(message, "Message:"), 0, message);
});

test("hook: no CLAUDE_CODE_SESSION_ID → Session only (non-Claude agent degradation)", () => {
  const { message } = runHookWithTranscript({
    subject: "feat: codex agent\n",
    transcript: FIXTURE_LINES,
    withSessionId: false,
  });
  assert.equal(countLines(message, "Session:"), 1);
  assert.equal(countLines(message, "Message:"), 0, message);
});

test("hook: malformed transcript → never fails, Session only", () => {
  const { message } = runHookWithTranscript({
    subject: "feat: bad transcript\n",
    transcript: "malformed",
  });
  assert.equal(countLines(message, "Session:"), 1);
  assert.equal(countLines(message, "Message:"), 0, message);
});

test("hook: Brick trailer injected as full URL when ACPX_BRICK is set", () => {
  const { message } = runHookWithTranscript({
    subject: "feat: brick-linked commit\n",
    transcript: FIXTURE_LINES,
    extraEnv: { ACPX_BRICK: BRICK_ID },
  });
  assert.equal(countLines(message, "Session:"), 1);
  assert.equal(countLines(message, "Brick:"), 1);
  assert.equal(message.match(/^Brick: (.+)$/m)?.[1], BRICK_URL);
  assert.equal(countLines(message, "Message:"), 1);
});

test("hook: Brick trailer absent when ACPX_BRICK is unset", () => {
  const { message } = runHookWithTranscript({
    subject: "feat: no brick session\n",
    transcript: FIXTURE_LINES,
    extraEnv: { ACPX_BRICK: undefined },
  });
  assert.equal(countLines(message, "Session:"), 1);
  assert.equal(countLines(message, "Brick:"), 0, message);
  assert.equal(countLines(message, "Message:"), 1);
});

test("hook: Co-Authored-By anthropic.com lines stripped from commit message", () => {
  const { message } = runHookWithTranscript({
    // The Claude harness appends this line; the hook must remove it.
    subject:
      "feat: agent commit\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>\n",
  });
  assert.equal(countLines(message, "Session:"), 1);
  assert.ok(!message.includes("Co-Authored-By:"), `Co-Authored-By must be stripped: ${message}`);
});

test("hook: jq missing → Session only (PATH without jq)", () => {
  const dir = mkdtempSync(join(tmpdir(), "acpx-hook-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const configDir = join(dir, "claude-config");
  const projectDir = join(configDir, "projects", "p");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${SESSION_ID}.jsonl`),
    FIXTURE_LINES.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  // Curated PATH: everything the hook needs EXCEPT jq.
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  for (const tool of ["sh", "git", "grep", "find", "head", "cat", "env"]) {
    symlinkSync(join("/usr/bin", tool), join(binDir, tool));
  }
  const msgFile = join(dir, "COMMIT_EDITMSG");
  writeFileSync(msgFile, "feat: no jq\n");
  execFileSync("sh", [HOOK, msgFile], {
    cwd: dir,
    env: {
      PATH: binDir,
      ACPX_SESSION_URL: SESSION_URL,
      CLAUDE_CONFIG_DIR: configDir,
      CLAUDE_CODE_SESSION_ID: SESSION_ID,
    },
  });
  const message = execFileSync("/usr/bin/cat", [msgFile]).toString();
  assert.equal(countLines(message, "Session:"), 1, message);
  assert.equal(countLines(message, "Message:"), 0, message);
  rmSync(dir, { recursive: true, force: true });
});
