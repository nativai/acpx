// A-60 / C3.5 — the PRODUCTION-SHAPE rows (brick f67e0ff1): every row drives the real CLI, a real queue
// owner woken by a real `acpx prompt`, a real `acpx sessions close`, a real `acpx flow run`. They are
// the c917d9c9 probe's arms (LEAD, F4, F4-rev, F4-normal) with their controls, made committed rows:
// 60.1, 60.2, 60.3, 60.4, 60.12 and 60.13 of the test plan. Each is red on agent-pods b673d134 for the
// reason named in its title (60.12 and 60.13 pin facts that already hold there).
//
// Slow by nature (a stream lock budget is 20 s): each row carries its own generous timeout.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
} from "../src/process-identity.js";
import { sweepOwnPodLocks } from "../src/session/persistence/identity-file-lock.js";
import { queuePaths } from "./queue-test-helpers.js";
import { withTempHome } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const FLOW_PATH = fileURLToPath(new URL("./fixtures/a60-f4.flow.js", import.meta.url));
const CONNECT_HOOK_URL = new URL("./a60-connect-hook.js", import.meta.url).href;
const AGENT = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-load-session --claude-agent-acp`;
const EMPTY_BRICK_POOL = path.join(os.tmpdir(), "acpx-a60-empty-brick-pool");
const ROW_TIMEOUT_MS = 300_000;

type Finished = { code: number | null; stdout: string; stderr: string };
type Running = { child: ChildProcess; done: Promise<Finished> };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function start(homeDir: string, args: string[], env: NodeJS.ProcessEnv = {}): Running {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    ACPX_STATE_HOME: homeDir,
    ACPX_BRICK_POOL_DIR: EMPTY_BRICK_POOL,
    ACPX_OWNER_IDLE_RELEASE_MS: "3000",
    ...env,
  };
  for (const key of ["ACPX_SESSION_URL", "ACPX_SESSION_NAME", "ACPX_PARENT_SESSION_URL"]) {
    delete childEnv[key];
  }
  const cwd = path.join(homeDir, "cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const child = spawn(
    process.execPath,
    [CLI_PATH, "--agent", AGENT, "--approve-all", "--cwd", cwd, ...args],
    { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const done = new Promise<Finished>((resolve) => {
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}

async function run(
  homeDir: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<Finished> {
  return await start(homeDir, args, env).done;
}

async function waitUntil(
  label: string,
  predicate: () => boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function sessionsDir(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

function onlySessionId(homeDir: string): string {
  const ids = fs
    .readdirSync(sessionsDir(homeDir))
    .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
    .map((name) => name.replace(/\.json$/, ""));
  assert.equal(ids.length, 1, `exactly one session, found ${ids.join(",")}`);
  return ids[0];
}

function logOf(homeDir: string, id: string): string {
  return fs.readFileSync(path.join(sessionsDir(homeDir), `${id}.messages.ndjson`), "utf8");
}

function recordText(homeDir: string, id: string): string {
  return fs.readFileSync(path.join(sessionsDir(homeDir), `${id}.json`), "utf8");
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function assertEveryLogLineParses(log: string): void {
  assert.ok(log === "" || log.endsWith("\n"), "the log ends at a line boundary");
  for (const line of log.split("\n").filter((entry) => entry.length > 0)) {
    JSON.parse(line);
  }
}

async function newSession(homeDir: string): Promise<string> {
  const created = await run(homeDir, ["--format", "json", "sessions", "new"]);
  assert.equal(created.code, 0, created.stderr);
  const id = (JSON.parse(created.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId;
  assert.equal(typeof id, "string");
  return id as string;
}

function prompt(homeDir: string, id: string, text: string): Running {
  return start(homeDir, ["--format", "quiet", "prompt", "--session-id", id, text]);
}

async function readTranscript(homeDir: string, id: string): Promise<Finished> {
  return await run(homeDir, ["--format", "json", "sessions", "read", "--session-id", id]);
}

function ownerPid(homeDir: string, id: string): number {
  const lease = JSON.parse(fs.readFileSync(queuePaths(homeDir, id).lockPath, "utf8")) as {
    pid: number;
  };
  return lease.pid;
}

// ---------------------------------------------------------------------------------------------
// 60.1 — LEAD: `acpx sessions close` of a session whose owner is mid-turn
// ---------------------------------------------------------------------------------------------

type CloseArm = "mid" | "after" | "mid-noinline";

async function closeScenario(
  homeDir: string,
  arm: CloseArm,
): Promise<{ log: string; read: Finished }> {
  const id = await newSession(homeDir);
  const warm = await prompt(homeDir, id, "echo Q1-QUEUE-TURN").done;
  assert.equal(warm.code, 0, warm.stderr);

  const release = path.join(homeDir, "release-q2");
  const q2 = prompt(
    homeDir,
    id,
    arm === "mid-noinline" ? `hold-until-file ${release}` : `stream-hold ${release} PARTIAL-MARK`,
  );
  await waitUntil("the hold to engage", () => fs.existsSync(`${release}.holding`));
  if (arm !== "mid-noinline") {
    // The live checkpoint has published the partial inline: that is the state the close reads.
    await waitUntil("the partial to be inline", () =>
      recordText(homeDir, id).includes("PARTIAL-MARK"),
    );
  }

  if (arm === "after") {
    fs.writeFileSync(release, "");
    assert.equal((await q2.done).code, 0);
    assert.equal(
      (await run(homeDir, ["--format", "json", "sessions", "close", "--session-id", id])).code,
      0,
    );
  } else {
    const marker = path.join(homeDir, "close-connected");
    const close = start(homeDir, ["--format", "json", "sessions", "close", "--session-id", id], {
      A60_CONNECT_MARKER: marker,
      NODE_OPTIONS: `--import=${CONNECT_HOOK_URL}`,
    });
    // The close has read the record; its first connect to the owner comes next: end the owner's turn now.
    await waitUntil("the close's first owner connect", () => fs.existsSync(marker));
    fs.writeFileSync(release, "");
    const closed = await close.done;
    assert.equal(closed.code, 0, closed.stderr);
    await q2.done;
  }
  return { log: logOf(homeDir, id), read: await readTranscript(homeDir, id) };
}

test(
  "60.1 LEAD: a default close of a session whose owner is mid-turn keeps the turn's final reply (red on b673d134: FINAL ×0, the partial in its place)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a60-lead-", async (homeDir) => {
      const { log, read } = await closeScenario(homeDir, "mid");
      assert.equal(
        count(log, "FINAL-AFTER-HOLD"),
        1,
        `the final reply is in the log once:\n${log}`,
      );
      assert.equal(count(read.stdout, "FINAL-AFTER-HOLD"), 1, "and `sessions read` shows it once");
      assertEveryLogLineParses(log);
    });
  },
);

test(
  "60.1 control: a close after the turn ended keeps the reply once",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a60-lead-after-", async (homeDir) => {
      const { log, read } = await closeScenario(homeDir, "after");
      assert.equal(count(log, "FINAL-AFTER-HOLD"), 1);
      assert.equal(count(read.stdout, "FINAL-AFTER-HOLD"), 1);
    });
  },
);

test(
  "60.1 control: a close mid-turn with nothing streamed yet keeps the owner's reply once",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a60-lead-noinline-", async (homeDir) => {
      const { log, read } = await closeScenario(homeDir, "mid-noinline");
      assert.equal(count(log, "released by file"), 1);
      assert.equal(count(read.stdout, "released by file"), 1);
    });
  },
);

// ---------------------------------------------------------------------------------------------
// The flow rows: a flow's session, a second actor's queue owner mid-turn on it
// ---------------------------------------------------------------------------------------------

type FlowFixture = { dir: string; id: string; flow: Running };

/** Starts the probe's flow and brings it to n2 (its first turn done, its session created). */
async function flowAtN2(homeDir: string, withSubscription: boolean): Promise<FlowFixture> {
  const dir = path.join(homeDir, "flowdir");
  fs.mkdirSync(dir, { recursive: true });
  if (withSubscription) {
    const subs = path.join(homeDir, ".acpx", "subscriptions");
    fs.mkdirSync(path.join(subs, "sub1"), { recursive: true });
    fs.writeFileSync(
      path.join(subs, "registry.json"),
      JSON.stringify({
        version: 3,
        default: "sub1",
        profiles: [
          {
            id: "sub1",
            label: "sub1",
            authMode: "subscription",
            adapter: "claude",
            account: "sub1",
            credentialSource: path.join(subs, "sub1"),
          },
        ],
      }),
    );
  }
  const flow = start(
    homeDir,
    [...(withSubscription ? ["--subscription", "sub1"] : []), "flow", "run", FLOW_PATH],
    { A60_DIR: dir },
  );
  await waitUntil("the flow to reach n2", () => fs.existsSync(path.join(dir, "at-n2")));
  return { dir, id: onlySessionId(homeDir), flow };
}

async function ownerMidTurnOn(
  homeDir: string,
  fixture: FlowFixture,
): Promise<{ q1: Running; release: string }> {
  const release = path.join(fixture.dir, "release-q1");
  const q1 = prompt(homeDir, fixture.id, `hold-until-file ${release}`);
  await waitUntil("the owner's hold to engage", () => fs.existsSync(`${release}.holding`));
  return { q1, release };
}

function goToN3(fixture: FlowFixture): void {
  fs.writeFileSync(path.join(fixture.dir, "go-n3"), "");
}

test(
  "60.2 F4: a flow's pre-submit refusal notice behind a mid-turn owner survives the owner's turn end (red on b673d134: `turn failed` ×0)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a60-f4-", async (homeDir) => {
      const fixture = await flowAtN2(homeDir, true);
      const { q1, release } = await ownerMidTurnOn(homeDir, fixture);
      assert.equal((await run(homeDir, ["subscriptions", "lock", "sub1"])).code, 0);
      goToN3(fixture);
      await fixture.flow.done; // the refused turn's notice has landed (the wait on the stream lock is the 20 s budget)
      fs.writeFileSync(release, "");
      assert.equal((await q1.done).code, 0);

      const log = logOf(homeDir, fixture.id);
      assert.equal(
        count(log, "turn failed"),
        1,
        `the notice survives the owner's turn end:\n${log}`,
      );
      assert.equal(count(log, "released by file"), 1, "and so does the owner's reply");
      assert.equal(count((await readTranscript(homeDir, fixture.id)).stdout, "turn failed"), 1);
      assertEveryLogLineParses(log);
    });
  },
);

test(
  "60.2 control: the same notice with no owner lands and survives a later turn",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a60-f4-noowner-", async (homeDir) => {
      const fixture = await flowAtN2(homeDir, true);
      assert.equal((await run(homeDir, ["subscriptions", "lock", "sub1"])).code, 0);
      goToN3(fixture);
      await fixture.flow.done;
      assert.equal(count(logOf(homeDir, fixture.id), "turn failed"), 1);
      assert.equal((await run(homeDir, ["subscriptions", "unlock", "sub1"])).code, 0);
      assert.equal((await prompt(homeDir, fixture.id, "echo Q2-QUEUE-TURN").done).code, 0);
      const log = logOf(homeDir, fixture.id);
      assert.equal(count(log, "turn failed"), 1);
      assert.equal(count(log, "Q2-QUEUE-TURN"), 2, "the later turn's prompt and reply");
    });
  },
);

test(
  "60.3 F4-rev: the notice landing AFTER the owner's turn end keeps the owner's reply, and the log stays whole through the release and a later turn (red on b673d134: reply ×0, a malformed line)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a60-f4rev-", async (homeDir) => {
      const fixture = await flowAtN2(homeDir, true);
      const { q1, release } = await ownerMidTurnOn(homeDir, fixture);
      assert.equal((await run(homeDir, ["subscriptions", "lock", "sub1"])).code, 0);
      goToN3(fixture); // the flow reads the record, then waits on the stream lock
      await sleep(4_000);
      fs.writeFileSync(release, ""); // the owner's turn ends first, while the flow waits
      assert.equal((await q1.done).code, 0);
      await fixture.flow.done; // the notice lands after the owner's idle release freed the lock
      // The owner's idle release has run by now (ACPX_OWNER_IDLE_RELEASE_MS=3000); a later queue turn follows.
      assert.equal((await run(homeDir, ["subscriptions", "unlock", "sub1"])).code, 0);
      assert.equal((await prompt(homeDir, fixture.id, "echo Q2-QUEUE-TURN").done).code, 0);

      const log = logOf(homeDir, fixture.id);
      assertEveryLogLineParses(log);
      assert.equal(count(log, "released by file"), 1, `the owner's reply is in the log:\n${log}`);
      assert.equal(count(log, "turn failed"), 1, "and so is the notice");
      assert.equal(count(log, "Q2-QUEUE-TURN"), 2, "and the later turn's prompt and reply");
      const read = await readTranscript(homeDir, fixture.id);
      assert.doesNotMatch(read.stderr, /malformed/, "`sessions read` warns nothing");
    });
  },
);

test(
  "60.4 F4-normal: a flow's ordinary turn behind a live owner fails with stream-lock-timeout, writes nothing, and the owner's reply survives (red on b673d134: the flow ran to completed, its turn erased)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a60-f4normal-", async (homeDir) => {
      const fixture = await flowAtN2(homeDir, false);
      const { q1, release } = await ownerMidTurnOn(homeDir, fixture);
      const logBefore = logOf(homeDir, fixture.id);
      goToN3(fixture);
      const flow = await fixture.flow.done; // 20 s budget, then the typed timeout
      assert.notEqual(
        flow.code,
        0,
        `the flow did not run its turn past a live owner:\n${flow.stdout}`,
      );
      assert.match(
        `${flow.stdout}${flow.stderr}`,
        /stream lock .* is held for over|stream-lock-timeout/,
      );
      assert.equal(
        logOf(homeDir, fixture.id),
        logBefore,
        "the flow's turn wrote nothing: no User entry, no reply",
      );
      assert.equal(count(recordText(homeDir, fixture.id), "N3-FLOW-TURN"), 0);

      fs.writeFileSync(release, "");
      assert.equal((await q1.done).code, 0);
      const log = logOf(homeDir, fixture.id);
      assert.equal(count(log, "released by file"), 1, "the owner's reply is in the log");
      assert.equal(count(log, "N3-FLOW-TURN"), 0);
      const breaks = path.join(homeDir, ".acpx", "lock-breaks");
      const lines = fs.existsSync(breaks)
        ? fs.readdirSync(breaks).map((name) => fs.readFileSync(path.join(breaks, name), "utf8"))
        : [];
      assert.equal(
        lines.filter((line) => line.includes(`${fixture.id}.stream.lock`)).length,
        0,
        "lock-breaks has no line for that lock",
      );
    });
  },
);

test(
  "60.4 control: the owner's process killed during the wait — the lock is broken (the holder is dead) and the flow's turn runs",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-a60-f4normal-kill-", async (homeDir) => {
      const fixture = await flowAtN2(homeDir, false);
      const { release } = await ownerMidTurnOn(homeDir, fixture);
      goToN3(fixture);
      await sleep(3_000);
      process.kill(ownerPid(homeDir, fixture.id), "SIGKILL");
      fs.writeFileSync(release, ""); // lets the orphaned mock agent finish
      const flow = await fixture.flow.done;
      assert.equal(flow.code, 0, `${flow.stdout}${flow.stderr}`);
      assert.equal(
        count(logOf(homeDir, fixture.id), "N3-FLOW-TURN"),
        2,
        "the flow's turn ran: its prompt and reply",
      );
    });
  },
);

test(
  "60.12: a direct turn whose stream lock times out writes nothing — no User entry, nothing of the turn in the log or the record (holds on b673d134 too: C3.5 (iii) corrected)",
  { timeout: ROW_TIMEOUT_MS },
  async (t) => {
    if (process.platform !== "linux") {
      t.skip("linux identity");
      return;
    }
    await withTempHome("acpx-a60-lockfirst-", async (homeDir) => {
      const fixture = await flowAtN2(homeDir, false);
      // Control, same fixture: n1's turn got its lock and wrote its User entry.
      assert.equal(count(logOf(homeDir, fixture.id), "N1-FLOW-TURN"), 2);
      const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
        stdio: "ignore",
      });
      try {
        assert.ok(sleeper.pid);
        const birth = readProcessBirthIdentity(sleeper.pid);
        assert.ok(birth);
        fs.writeFileSync(
          path.join(sessionsDir(homeDir), `${fixture.id}.stream.lock`),
          JSON.stringify({
            pid: sleeper.pid,
            created_at: new Date().toISOString(),
            host: os.hostname(),
            processIdentity: serializeProcessBirthIdentity(birth),
          }),
        );
        const logBefore = logOf(homeDir, fixture.id);
        const messagesBefore = (
          JSON.parse(recordText(homeDir, fixture.id)) as { messages: unknown[] }
        ).messages;
        goToN3(fixture);
        const flow = await fixture.flow.done;
        assert.notEqual(flow.code, 0);
        assert.equal(logOf(homeDir, fixture.id), logBefore, "nothing of the turn is in the log");
        assert.deepEqual(
          (JSON.parse(recordText(homeDir, fixture.id)) as { messages: unknown[] }).messages,
          messagesBefore,
          "nothing of the turn is inline in the record",
        );
      } finally {
        sleeper.kill("SIGKILL");
      }
    });
  },
);

// ---------------------------------------------------------------------------------------------
// 60.13 — the S11 sweep's row E: atrium's `sweepOwnPodLocks` never removes a live owner's lock
// ---------------------------------------------------------------------------------------------

test(
  "60.13: a real owner mid-turn holds its stream lock with its birth identity for the whole turn, and the 5 s sweep never removes it; the owner killed, the sweep removes it",
  { timeout: ROW_TIMEOUT_MS },
  async (t) => {
    if (process.platform !== "linux") {
      t.skip("linux identity");
      return;
    }
    await withTempHome("acpx-a60-sweep-", async (homeDir) => {
      const id = await newSession(homeDir);
      const release = path.join(homeDir, "release-turn");
      const turn = start(
        homeDir,
        ["--format", "quiet", "prompt", "--session-id", id, `hold-until-file ${release}`],
        {
          ACPX_OWNER_IDLE_RELEASE_MS: "0",
        },
      );
      await waitUntil("the hold to engage", () => fs.existsSync(`${release}.holding`));
      const lockPath = path.join(sessionsDir(homeDir), `${id}.stream.lock`);
      const first = fs.readFileSync(lockPath, "utf8");
      const body = JSON.parse(first) as { processIdentity?: unknown; host?: unknown };
      assert.ok(body.processIdentity, "the body carries the owner's birth identity");
      assert.equal(typeof body.host, "string");

      // Past the 15 s an `unjudgeable` body would be broken at, with the sweep running every second.
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        const swept = await sweepOwnPodLocks({ dirs: [sessionsDir(homeDir)] });
        assert.deepEqual(swept.removed, [], "the sweep removed nothing");
        assert.equal(fs.readFileSync(lockPath, "utf8"), first, "the lock is byte-identical");
        await sleep(1_000);
      }
      assert.equal(fs.existsSync(path.join(homeDir, ".acpx", "lock-breaks")), false);

      // Control: the owner killed mid-turn — its lock is a dead process's, and the sweep removes it.
      process.kill(ownerPid(homeDir, id), "SIGKILL");
      fs.writeFileSync(release, "");
      await waitUntil("the sweep to remove the dead owner's lock", () => {
        void sweepOwnPodLocks({ dirs: [sessionsDir(homeDir)] });
        return !fs.existsSync(lockPath);
      });
      await turn.done;
    });
  },
);
