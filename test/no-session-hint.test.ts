import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { noSessionIdMessage } from "../src/cli/session-selector.js";
import { withTempHome } from "./runtime-test-helpers.js";

// Brick 56f5d869 (R2 TE I-5): the refusal for a call that names no session used to advise `--session-id <id>` without
// saying where — and for the BARE form `acpx <text>` the root grammar refuses exactly that flag (`unknown option`). The hint
// must name a form that RUNS. This file measures the old advice's failure, runs the advised command, and pins both.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const ABSENT_ID = "00000000-0000-4000-8000-0000000000ab";

type Run = { code: number | null; stdout: string; stderr: string };

function run(args: string[], home: string): Promise<Run> {
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
