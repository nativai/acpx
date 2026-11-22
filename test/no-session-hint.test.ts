import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { noSessionIdMessage } from "../src/cli/session-selector.js";
import { withTempHome } from "./runtime-test-helpers.js";

// Brick 56f5d869 (R2 TE I-5): the refusal for a call that names no session used to advise `--session-id <id>` without
// saying where — and for the BARE form `acpx <text>` the root grammar refuses exactly that flag (`unknown option`). The hint
// must name a form that RUNS. This file measures the old advice's failure, runs the advised command, and pins both.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const ABSENT_ID = "00000000-0000-4000-8000-0000000000ab";

type Run = { code: number | null; stdout: string; stderr: string };

function run(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ACPX_STATE_HOME: home };
    for (const name of [
      "ACPX_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_SESSION_RECORD_ID",
      "ACPX_DEFAULT_OWNER",
    ]) {
      delete env[name];
    }
    Object.assign(env, extraEnv);
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      cwd: path.join(home),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** The command the hint advises: the text after "as in ", up to its parenthetical. */
function advisedForm(message: string): string | undefined {
  return /as in (acpx <agent> --session-id <id> <text>)/u.exec(message)?.[1];
}

test("the hint advises a form that names the flag AFTER the agent, and never the root form that does not exist", () => {
  const message = noSessionIdMessage("codex");
  assert.equal(advisedForm(message), "acpx <agent> --session-id <id> <text>");
  assert.doesNotMatch(message, /acpx --session-id/u, "the root takes no --session-id");
  assert.match(message, /Create one: acpx codex sessions new/u, "the create form is still named");
});

test("the ROOT form the old hint implied is refused `unknown option` — measured, so the hint is right to avoid it", async () => {
  await withTempHome("acpx-no-session-hint-", async (home) => {
    const root = await run(["--session-id", ABSENT_ID, "hello"], home);
    assert.equal(root.code, 2, root.stderr);
    assert.match(root.stderr, /unknown option '--session-id'/u);
  });
});

test("the ADVISED command, filled in, RUNS: it is accepted by the grammar and reaches the session lookup (`Session not found`), where the root form died at `unknown option`", async () => {
  await withTempHome("acpx-no-session-hint-", async (home) => {
    // The refusal as a real caller sees it, from a call that named no session.
    const refused = await run(["codex", "hello"], home);
    assert.equal(refused.code, 4, refused.stderr);
    const advised = advisedForm(refused.stderr);
    assert.ok(advised, `the refusal carries the advised form: ${refused.stderr}`);
    const argv = advised
      .replace(/^acpx /u, "")
      .replace("<agent>", "claude")
      .replace("<id>", ABSENT_ID)
      .replace("<text>", "hello")
      .split(" ");
    assert.deepEqual(argv, ["claude", "--session-id", ABSENT_ID, "hello"]);
    const ran = await run(argv, home);
    assert.doesNotMatch(ran.stderr, /unknown option|unknown command|error: /u, ran.stderr);
    assert.equal(ran.code, 4, ran.stderr);
    assert.match(
      ran.stderr,
      new RegExp(`Session not found: ${ABSENT_ID}`, "u"),
      "it reached the lookup",
    );
    // and the bare spelling of the same advice (`<agent>` dropped) is the one that does NOT run
    const bare = await run(["--session-id", ABSENT_ID, "hello"], home);
    assert.match(bare.stderr, /unknown option/u);
  });
});

// Brick e62381fa (lows-r2 TE FN-1, lows-r3 TE FN-1a/b/c): the bare form `acpx hello` reads its first word as the AGENT, so the
// create line used to advise `acpx hello sessions new` — `Failed to spawn agent command: hello`, rc 1, nothing written. Where
// the first word is no agent at all, the create line names NO agent: `acpx sessions new` takes the parent session's agent
// inside a session and the configured default (else codex) outside one.

const CREATE_LINE = /Create one: (acpx[^\n]*? sessions new)/u;
const MOCK_B_COMMAND = `node  ${JSON.stringify(MOCK_AGENT_PATH)}`; // two spaces: distinguishable from the first by its record

async function writeConfig(home: string, config: unknown): Promise<void> {
  await fs.mkdir(path.join(home, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".acpx", "config.json"),
    `${JSON.stringify(config)}\n`,
    "utf8",
  );
}

async function readAgentCommand(home: string, acpxRecordId: string): Promise<string> {
  const record = JSON.parse(
    await fs.readFile(path.join(home, ".acpx", "sessions", `${acpxRecordId}.json`), "utf8"),
  ) as { agentCommand?: string; agent_command?: string };
  return record.agentCommand ?? record.agent_command ?? "";
}

async function createdId(result: Run): Promise<string> {
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(
    result.stderr,
    /Failed to spawn|unknown option|unknown command/u,
    result.stderr,
  );
  const created = JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown };
  assert.equal(typeof created.acpxRecordId, "string", result.stdout);
  return String(created.acpxRecordId);
}

test("the create line: a first word that is no agent names no agent; a real agent — built in, alias, configured, in any case — is kept as written", () => {
  const bare = noSessionIdMessage("hello");
  assert.doesNotMatch(
    bare,
    /acpx hello sessions new/u,
    "the first word of a bare prompt is no agent",
  );
  assert.match(bare, /Create one: acpx sessions new$/u);
  assert.match(noSessionIdMessage("fix"), /Create one: acpx sessions new$/u);
  assert.match(
    noSessionIdMessage("claude"),
    /Create one: acpx claude sessions new$/u,
    "a built-in agent",
  );
  assert.match(
    noSessionIdMessage("Claude"),
    /Create one: acpx Claude sessions new$/u,
    "FN-1b: the name acpx resolves",
  );
  assert.match(noSessionIdMessage("CLAUDE"), /Create one: acpx CLAUDE sessions new$/u);
  assert.match(
    noSessionIdMessage("myagent", { agents: { myagent: "node x.js" } }),
    /Create one: acpx myagent sessions new$/u,
    "an agent the config adds",
  );
  assert.match(
    noSessionIdMessage("MyAgent", { agents: { myagent: "node x.js" } }),
    /Create one: acpx MyAgent sessions new$/u,
  );
});

test("bare `acpx hello` / `acpx fix the bug` advise `acpx sessions new`, and that RUNS — outside a session it creates the configured default's session, inside one the PARENT's; the old `acpx hello sessions new` is measured to fail to spawn", async () => {
  await withTempHome("acpx-no-session-hint-", async (home) => {
    await writeConfig(home, {
      defaultAgent: "mocka",
      agents: { mocka: { command: MOCK_AGENT_COMMAND }, mockb: { command: MOCK_B_COMMAND } },
    });

    // outside a session
    for (const words of [["hello"], ["fix", "the", "bug"]]) {
      const refused = await run(words, home);
      assert.equal(refused.code, 4, refused.stderr);
      assert.doesNotMatch(refused.stderr, /acpx hello sessions new|acpx fix sessions new/u);
      const advised = CREATE_LINE.exec(refused.stderr)?.[1];
      assert.equal(advised, "acpx sessions new", refused.stderr);
      const ran = await run(
        ["--format", "json", ...advised.replace(/^acpx /u, "").split(" ")],
        home,
      );
      assert.equal(
        await readAgentCommand(home, await createdId(ran)),
        MOCK_AGENT_COMMAND,
        "the configured default",
      );
    }

    // inside a session whose agent is NOT the default: the same advice, filled in, creates the parent's agent
    const parent = await createdId(
      await run(["--format", "json", "mockb", "sessions", "new"], home),
    );
    assert.equal(await readAgentCommand(home, parent), MOCK_B_COMMAND);
    const inside = { ACPX_SESSION_URL: `http://localhost:3456/?session=${parent}` };
    const refused = await run(["hello"], home, inside);
    assert.equal(refused.code, 4, refused.stderr);
    const advised = CREATE_LINE.exec(refused.stderr)?.[1];
    assert.equal(advised, "acpx sessions new", refused.stderr);
    const ran = await run(
      ["--format", "json", ...advised.replace(/^acpx /u, "").split(" ")],
      home,
      inside,
    );
    assert.equal(
      await readAgentCommand(home, await createdId(ran)),
      MOCK_B_COMMAND,
      "the parent's agent, not the configured default",
    );

    // the advice this row replaces: the first word as the agent — rc 1, `Failed to spawn`, nothing written
    const old = await run(["hello", "sessions", "new"], home);
    assert.equal(old.code, 1, old.stderr);
    assert.match(old.stderr, /Failed to spawn agent command: hello/u);
  });
});

test("`status` keeps the config (FN-1a): with a configured default and a configured agent, `acpx status` and `acpx <agent> status` advise that agent's create line, and it RUNS", async () => {
  await withTempHome("acpx-no-session-hint-", async (home) => {
    await writeConfig(home, {
      defaultAgent: "mocka",
      agents: { mocka: { command: MOCK_AGENT_COMMAND }, mockb: { command: MOCK_B_COMMAND } },
    });
    for (const [words, agent, command] of [
      [["status"], "mocka", MOCK_AGENT_COMMAND],
      [["mockb", "status"], "mockb", MOCK_B_COMMAND],
    ] as const) {
      const refused = await run([...words], home);
      assert.equal(refused.code, 4, refused.stderr);
      const advised = CREATE_LINE.exec(refused.stderr)?.[1];
      assert.equal(advised, `acpx ${agent} sessions new`, refused.stderr);
      assert.doesNotMatch(
        refused.stderr,
        /acpx codex sessions new/u,
        "the built-in default is not the configured one",
      );
      const ran = await run(
        ["--format", "json", ...advised.replace(/^acpx /u, "").split(" ")],
        home,
      );
      assert.equal(await readAgentCommand(home, await createdId(ran)), command);
    }
  });
});
