import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
// ACPX_SEAT_URL is composed by auth-env.ts as `<base>/?seat=<id>`; the hook copies it verbatim.
const SEAT_ID = "3f2b8c1e-5d44-4b7a-9a10-6c0de9f1a222";
const SEAT_URL = `https://acpx.devbox.nativai.de/?seat=${SEAT_ID}`;

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

test("hook: Seat trailer carries ACPX_SEAT_URL verbatim when it is set", () => {
  const { message } = runHookWithTranscript({
    subject: "feat: seated commit\n",
    transcript: FIXTURE_LINES,
    extraEnv: { ACPX_BRICK: BRICK_ID, ACPX_SEAT_URL: SEAT_URL },
  });
  assert.equal(countLines(message, "Seat:"), 1, message);
  assert.equal(message.match(/^Seat: (.+)$/m)?.[1], SEAT_URL);
});

test("hook: Seat trailer absent when ACPX_SEAT_URL is unset or empty — never invented", () => {
  for (const seatUrl of [undefined, ""]) {
    const { message } = runHookWithTranscript({
      subject: "feat: seatless commit\n",
      transcript: FIXTURE_LINES,
      extraEnv: { ACPX_BRICK: BRICK_ID, ACPX_SEAT_URL: seatUrl },
    });
    assert.equal(countLines(message, "Session:"), 1, message);
    assert.equal(countLines(message, "Seat:"), 0, message);
  }
});

test("hook: Seat trailer is idempotent — a second run adds no duplicate", () => {
  const dir = mkdtempSync(join(tmpdir(), "acpx-hook-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const msgFile = join(dir, "COMMIT_EDITMSG");
  writeFileSync(msgFile, "feat: repeat\n");
  const env = {
    ...process.env,
    ACPX_SESSION_URL: SESSION_URL,
    ACPX_BRICK: BRICK_ID,
    ACPX_SEAT_URL: SEAT_URL,
  };
  execFileSync("sh", [HOOK, msgFile], { cwd: dir, env });
  execFileSync("sh", [HOOK, msgFile], { cwd: dir, env });
  const message = execFileSync("cat", [msgFile]).toString();
  assert.equal(countLines(message, "Seat:"), 1, message);
  assert.equal(countLines(message, "Session:"), 1, message);
  assert.equal(countLines(message, "Brick:"), 1, message);
  rmSync(dir, { recursive: true, force: true });
});

test("hook: Session, Brick and Seat share ONE trailer paragraph — all three extract via %(trailers)", () => {
  const { dir, message } = runHookWithTranscript({
    subject: "feat: all three\n\nBody paragraph.\n",
    extraEnv: { ACPX_BRICK: BRICK_ID, ACPX_SEAT_URL: SEAT_URL },
  });
  // A blank line between trailers would end the block; the real extraction is the witness.
  const msgFile = join(dir, "COMMIT_EDITMSG");
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=hook-test",
      "-c",
      "user.email=hook-test@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-F",
      msgFile,
    ],
    { cwd: dir },
  );
  const extracted = execFileSync(
    "git",
    ["log", "-1", "--format=%(trailers:key=Session,key=Brick,key=Seat,valueonly)"],
    { cwd: dir },
  )
    .toString()
    .split("\n")
    .filter((l) => l.length > 0);
  assert.deepEqual(extracted, [SESSION_URL, BRICK_URL, SEAT_URL], message);
  rmSync(dir, { recursive: true, force: true });
});

test("hook: Co-Authored-By anthropic.com lines stripped from commit message", () => {
  const { message } = runHookWithTranscript({
    // The Claude harness appends this line; the hook must remove it.
    subject: "feat: agent commit\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>\n",
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

// --- Real-git coverage: the hook as git invokes it, trailers read back by git ---
//
// The cases above feed the hook a hand-written message file. These drive real
// `git commit` / `git merge` through core.hooksPath (as acpx's env-scoped hooks
// do) and read the trailers back with git's own parser, because that parser is
// what the atrium git area relies on. `git merge -m "<subject>"` is the case that
// motivated them: git writes MERGE_MSG with NO trailing newline.

const ALL_TRAILERS = [`Session: ${SESSION_URL}`, `Brick: ${BRICK_URL}`, `Seat: ${SEAT_URL}`];
const BOB_TRAILER = "Co-Authored-By: Bob <bob@example.invalid>";

type GitRepo = { dir: string; git: (...args: string[]) => string };

// A fresh repo whose hooks dir holds ONLY the prepare-commit-msg hook under test.
// Transcript env is dropped, so no Message: trailer joins the expected set.
function makeGitRepo(): GitRepo {
  const dir = mkdtempSync(join(tmpdir(), "acpx-hook-git-"));
  const hooksDir = join(dir, "hooks");
  mkdirSync(hooksDir);
  symlinkSync(HOOK, join(hooksDir, "prepare-commit-msg"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("CLAUDE_") && !k.startsWith("GIT_")) {
      env[k] = v;
    }
  }
  Object.assign(env, {
    ACPX_SESSION_URL: SESSION_URL,
    ACPX_BRICK: BRICK_ID,
    ACPX_SEAT_URL: SEAT_URL,
    GIT_EDITOR: "true",
    GIT_MERGE_AUTOEDIT: "no",
  });
  const git = (...args: string[]): string =>
    execFileSync(
      "git",
      [
        "-c",
        `core.hooksPath=${hooksDir}`,
        "-c",
        "user.name=hook-test",
        "-c",
        "user.email=hook-test@example.invalid",
        ...args,
      ],
      { cwd: dir, env, encoding: "utf8" },
    );
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "base");
  return { dir, git };
}

// Each side adds its own file, so `git merge --no-ff side` never conflicts.
function branchOffMain(repo: GitRepo): void {
  repo.git("checkout", "-q", "-b", "side");
  writeFileSync(join(repo.dir, "side.txt"), "side\n");
  repo.git("add", "side.txt");
  repo.git("commit", "-q", "-m", "side work");
  repo.git("checkout", "-q", "main");
  writeFileSync(join(repo.dir, "main.txt"), "main\n");
  repo.git("add", "main.txt");
  repo.git("commit", "-q", "-m", "main work");
}

// Every trailer git parses from the last commit, in order, as "Key: value" lines.
function trailersOfHead(repo: GitRepo): string[] {
  return repo
    .git("log", "-1", "--format=%(trailers:unfold)")
    .split("\n")
    .filter((l) => l.length > 0);
}

test("hook (git): normal commit with a body → one trailer block", () => {
  const repo = makeGitRepo();
  repo.git("commit", "-q", "--allow-empty", "-m", "feat: with body", "-m", "Body paragraph.");
  assert.deepEqual(trailersOfHead(repo), ALL_TRAILERS);
  rmSync(repo.dir, { recursive: true, force: true });
});

test("hook (git): one-line -m commit → one trailer block", () => {
  const repo = makeGitRepo();
  repo.git("commit", "-q", "--allow-empty", "-m", "feat: one line");
  assert.deepEqual(trailersOfHead(repo), ALL_TRAILERS);
  rmSync(repo.dir, { recursive: true, force: true });
});

test("hook (git): merge with a one-line -m keeps its trailers (unterminated MERGE_MSG)", () => {
  const repo = makeGitRepo();
  branchOffMain(repo);
  repo.git("merge", "--no-ff", "-m", "Merge side into main", "side");
  assert.deepEqual(trailersOfHead(repo), ALL_TRAILERS);
  assert.equal(repo.git("log", "-1", "--format=%P").trim().split(" ").length, 2, "is a merge");
  assert.equal(
    repo.git("log", "-1", "--format=%(trailers:key=Session,valueonly)").trim(),
    SESSION_URL,
  );
  // One paragraph for the subject, one for the trailers: nothing between them but a blank line.
  assert.equal(
    repo.git("log", "-1", "--format=%B").trimEnd(),
    ["Merge side into main", "", ...ALL_TRAILERS].join("\n"),
  );
  rmSync(repo.dir, { recursive: true, force: true });
});

test("hook (git): merge with a body keeps its trailers", () => {
  const repo = makeGitRepo();
  branchOffMain(repo);
  repo.git("merge", "--no-ff", "-m", "Merge side into main", "-m", "Body paragraph.", "side");
  assert.deepEqual(trailersOfHead(repo), ALL_TRAILERS);
  rmSync(repo.dir, { recursive: true, force: true });
});

test("hook (git): git's default merge message keeps its trailers", () => {
  const repo = makeGitRepo();
  branchOffMain(repo);
  repo.git("merge", "--no-ff", "side");
  assert.match(repo.git("log", "-1", "--format=%s"), /^Merge branch 'side'/);
  assert.deepEqual(trailersOfHead(repo), ALL_TRAILERS);
  rmSync(repo.dir, { recursive: true, force: true });
});

test("hook (git): default merge message with # comment lines (conflict resolved) keeps its trailers", () => {
  const repo = makeGitRepo();
  writeFileSync(join(repo.dir, "clash.txt"), "base\n");
  repo.git("add", "clash.txt");
  repo.git("commit", "-q", "-m", "add clash");
  repo.git("checkout", "-q", "-b", "side");
  writeFileSync(join(repo.dir, "clash.txt"), "side\n");
  repo.git("commit", "-q", "-am", "side edit");
  repo.git("checkout", "-q", "main");
  writeFileSync(join(repo.dir, "clash.txt"), "main\n");
  repo.git("commit", "-q", "-am", "main edit");
  assert.throws(() => repo.git("merge", "--no-ff", "side"), "the merge must stop on a conflict");
  const mergeMsg = readFileSync(join(repo.dir, ".git", "MERGE_MSG"), "utf8");
  assert.match(mergeMsg, /^#/m, `MERGE_MSG should carry # comment lines: ${mergeMsg}`);
  writeFileSync(join(repo.dir, "clash.txt"), "resolved\n");
  repo.git("add", "clash.txt");
  repo.git("commit", "-q", "--no-edit");
  assert.deepEqual(trailersOfHead(repo), ALL_TRAILERS);
  rmSync(repo.dir, { recursive: true, force: true });
});

test("hook (git): --amend adds no duplicate trailers (commit and merge)", () => {
  const repo = makeGitRepo();
  repo.git("commit", "-q", "--allow-empty", "-m", "feat: to amend");
  repo.git("commit", "-q", "--amend", "--allow-empty", "--no-edit");
  repo.git("commit", "-q", "--amend", "--allow-empty", "-m", "feat: to amend, reworded");
  assert.deepEqual(trailersOfHead(repo), ALL_TRAILERS);

  branchOffMain(repo);
  repo.git("merge", "--no-ff", "-m", "Merge side into main", "side");
  repo.git("commit", "-q", "--amend", "--allow-empty", "--no-edit");
  assert.deepEqual(trailersOfHead(repo), ALL_TRAILERS);
  rmSync(repo.dir, { recursive: true, force: true });
});

test("hook (git): a message already ending in a trailer gets ours in the same block", () => {
  const repo = makeGitRepo();
  repo.git("commit", "-q", "--allow-empty", "-m", "feat: co-authored", "-m", BOB_TRAILER);
  assert.deepEqual(trailersOfHead(repo), [BOB_TRAILER, ...ALL_TRAILERS]);

  branchOffMain(repo);
  repo.git("merge", "--no-ff", "-m", "Merge side into main", "-m", BOB_TRAILER, "side");
  assert.deepEqual(trailersOfHead(repo), [BOB_TRAILER, ...ALL_TRAILERS]);
  rmSync(repo.dir, { recursive: true, force: true });
});

// File-level: the unterminated last line is the trigger, whatever git command wrote it.
test("hook: a message whose last line has no newline still gets one trailer block", () => {
  for (const subject of [
    "Merge side into main",
    "feat: body\n\nBody paragraph, unterminated",
    "feat: two\nlines, no blank",
  ]) {
    const { dir, message } = runHookWithTranscript({
      subject,
      extraEnv: { ACPX_BRICK: BRICK_ID, ACPX_SEAT_URL: SEAT_URL },
    });
    const parsed = execFileSync("git", ["interpret-trailers", "--parse"], {
      cwd: dir,
      input: message,
      encoding: "utf8",
    })
      .split("\n")
      .filter((l) => l.length > 0);
    assert.deepEqual(parsed, ALL_TRAILERS, JSON.stringify(message));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook: messages that already end in a newline come out unchanged by the terminator step", () => {
  const { message } = runHookWithTranscript({
    subject: "feat: terminated\n\nBody.\n",
    extraEnv: { ACPX_BRICK: BRICK_ID, ACPX_SEAT_URL: SEAT_URL },
  });
  assert.equal(message, ["feat: terminated", "", "Body.", "", ...ALL_TRAILERS, ""].join("\n"));
});
