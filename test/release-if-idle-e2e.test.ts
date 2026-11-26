// brick 35d4e64b (acpx half of ef5934ba) — `acpx sessions release --if-idle`, END TO END, in the production
// shape: the real CLI starts a real queue owner (a detached process), the owner spawns the mock agent as its
// adapter, and `sessions release --if-idle` is a SEPARATE real CLI process that asks that owner over its
// socket. The pod's marks are files in a temp directory the owner reads through the idle loop's own knobs
// (NV_AG_RUN_DIR / NV_AG_STATUS_DIR / NV_AGENT_SESSION_KEY).
//
// Each guarantee has its own row and each row can fail. The refusal rows are the committed negatives: the
// owner is asserted ALIVE afterwards, and the turn it was running still ends with its own answer.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isProcessAlive } from "../src/cli/queue/lease-store.js";
import { queuePaths, withTempHome } from "./queue-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type CliResult = { code: number | null; stdout: string; stderr: string };

type Rig = {
  homeDir: string;
  cwd: string;
  id: string;
  sessionsDir: string;
  runDir: string;
  statusDir: string;
};

function cliEnv(rig: Pick<Rig, "runDir" | "statusDir">, homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    ACPX_STATE_HOME: homeDir,
    ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    NV_AG_RUN_DIR: rig.runDir,
    NV_AG_STATUS_DIR: rig.statusDir,
    NV_AGENT_SESSION_KEY: "ritest",
  };
  for (const key of [
    "ACPX_SESSION_URL",
    "ACPX_SEAT_URL",
    "ACPX_SESSION_NAME",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_PARENT_SEAT_URL",
    "ACPX_BRICK",
    "ACPX_OWNER_LOG",
  ]) {
    delete env[key];
  }
  return env;
}

async function runCli(
  args: string[],
  rig: Rig,
  timeoutMs = 60_000,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...cliEnv(rig, rig.homeDir), ...extraEnv },
      cwd: rig.homeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`acpx ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function writeStatus(rig: Rig, overrides: Record<string, unknown> = {}): Promise<void> {
  await fs.writeFile(
    path.join(rig.statusDir, "ritest.json"),
    `${JSON.stringify({
      version: 1,
      kind: "agent",
      state: "running",
      updatedAt: new Date().toISOString(),
      browser: { open: false, since: null },
      ...overrides,
    })}\n`,
  );
}

async function withSession(run: (rig: Rig) => Promise<void>): Promise<void> {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const runDir = path.join(homeDir, "nv-run");
    const statusDir = path.join(homeDir, "nv-status");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(runDir, "inflight"), { recursive: true });
    await fs.mkdir(statusDir, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { codex: { command: MOCK_AGENT_COMMAND } } })}\n`,
    );
    const rig: Rig = { homeDir, cwd, id: "", sessionsDir: "", runDir, statusDir };
    const created = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "reclaimable"],
      rig,
    );
    assert.equal(created.code, 0, created.stderr);
    rig.id = String((JSON.parse(created.stdout.trim()) as { acpxRecordId: unknown }).acpxRecordId);
    rig.sessionsDir = path.join(homeDir, ".acpx", "sessions");
    await writeStatus(rig);
    await run(rig);
  });
}

const prompt = (rig: Rig, text: string, extra: string[] = []): Promise<CliResult> =>
  runCli(["--cwd", rig.cwd, ...extra, "codex", "prompt", "--session-id", rig.id, text], rig);

const HELD = "sess-held-9";

const release = (
  rig: Rig,
  extra: string[] = ["--held-target", HELD],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> =>
  runCli(
    [
      "--cwd",
      rig.cwd,
      "--format",
      "json",
      "codex",
      "sessions",
      "release",
      "--if-idle",
      "--session-id",
      rig.id,
      ...extra,
    ],
    rig,
    60_000,
    extraEnv,
  );

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

const recordOf = async (rig: Rig) =>
  JSON.parse(await fs.readFile(path.join(rig.sessionsDir, `${rig.id}.json`), "utf8")) as Record<
    string,
    unknown
  >;
const ownerLogOf = (rig: Rig) => readText(path.join(rig.sessionsDir, `${rig.id}.owner.log`));

async function waitFor(what: string, timeoutMs: number, ready: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    assert.ok(Date.now() < deadline, `${what} never happened within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function exists(file: string): Promise<boolean> {
  return await fs.stat(file).then(
    () => true,
    () => false,
  );
}

async function ownerPidOf(rig: Rig): Promise<number> {
  const lease = JSON.parse(await fs.readFile(queuePaths(rig.homeDir, rig.id).lockPath, "utf8")) as {
    pid: number;
  };
  return lease.pid;
}

const answer = (result: CliResult) => JSON.parse(result.stdout.trim()) as Record<string, unknown>;

/**
 * Releases once the owner's loop has parked again after its turn (a few ticks): `turn_running` right after
 * a turn ended is the gate's truthful "between turns", so the row retries until it is anything else.
 */
async function releaseOnceParked(
  rig: Rig,
  extra: string[] = ["--held-target", HELD],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await release(rig, extra, extraEnv);
    if (result.code === 0 || answer(result).reason !== "turn_running") {
      return result;
    }
    assert.ok(Date.now() < deadline, `the owner never parked: ${result.stdout}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForOwnerGone(rig: Rig, ownerPid: number): Promise<void> {
  await waitFor("the owner leaving", 30_000, async () => {
    return !isProcessAlive(ownerPid) && !(await exists(queuePaths(rig.homeDir, rig.id).lockPath));
  });
}

test("production shape: an idle owner is released on demand — reply first, owner gone, mark written, ONE loud log line, record untouched — and the NEXT message cold-starts it from its record", async () => {
  await withSession(async (rig) => {
    const first = await prompt(rig, "echo FIRST-ANSWER");
    assert.equal(first.code, 0, first.stderr);
    const ownerPid = await ownerPidOf(rig);
    assert.equal(isProcessAlive(ownerPid), true, "the owner outlives its turn (default ttl)");

    const result = await releaseOnceParked(rig);
    assert.equal(result.code, 0, `${result.stdout} ${result.stderr}`);
    const body = answer(result);
    assert.equal(body.released, true);
    assert.equal(body.sessionId, rig.id);

    await waitForOwnerGone(rig, ownerPid);
    const mark = await readText(path.join(rig.runDir, "reclaim"));
    assert.match(mark, new RegExp(`^session=${rig.id}$`, "m"));
    assert.match(mark, /^held_target=sess-held-9$/m);
    assert.match(mark, new RegExp(`^owner_pid=${ownerPid}$`, "m"));
    const log = await ownerLogOf(rig);
    const lines = log.split("\n").filter((line) => line.includes("queue owner RECLAIMED"));
    assert.equal(lines.length, 1, "ONE loud line per reclaim");
    assert.match(lines[0] ?? "", new RegExp(`session ${rig.id}`));
    assert.match(lines[0] ?? "", /held_target=sess-held-9/);
    assert.match(lines[0] ?? "", /idle=\d+m\d\ds/);
    assert.equal((await recordOf(rig)).closed, false, "the record stays OPEN");

    // THE COLD-START ROW: the very next message starts a fresh owner from the record and is answered.
    const next = await prompt(rig, "echo SECOND-ANSWER");
    assert.equal(next.code, 0, next.stderr);
    assert.match(next.stdout, /SECOND-ANSWER/);
    const newPid = await ownerPidOf(rig);
    assert.notEqual(newPid, ownerPid, "a NEW owner process answered");
    assert.equal(
      await exists(path.join(rig.runDir, "reclaim")),
      false,
      "the cold-started owner cleared the moot mark",
    );
  });
});

test("`--ttl 0` is reclaimable (Option A): the never-recycle owner stays alive on its own, and is ended on demand", async () => {
  await withSession(async (rig) => {
    const first = await prompt(rig, "echo TTL0-ANSWER", ["--ttl", "0"]);
    assert.equal(first.code, 0, first.stderr);
    const ownerPid = await ownerPidOf(rig);
    // Control: left alone, the ttl-0 owner is still there (it opts out of every self-release).
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    assert.equal(isProcessAlive(ownerPid), true, "a ttl-0 owner never releases itself");

    const result = await releaseOnceParked(rig);
    assert.equal(result.code, 0, `${result.stdout} ${result.stderr}`);
    await waitForOwnerGone(rig, ownerPid);
    assert.equal((await recordOf(rig)).closed, false);
  });
});

test("COMMITTED NEGATIVE — a turn running is NEVER released: refused(turn_running), the owner untouched, and the turn ends with its own answer", async () => {
  await withSession(async (rig) => {
    const releaseFile = path.join(rig.homeDir, "release-the-turn");
    const turn = prompt(rig, `hold-until-file ${releaseFile}`);
    await waitFor("the turn holding", 30_000, () => exists(`${releaseFile}.holding`));
    const ownerPid = await ownerPidOf(rig);

    const result = await release(rig);
    assert.equal(result.code, 1);
    assert.equal(answer(result).released, false);
    assert.equal(answer(result).reason, "turn_running");
    assert.equal(isProcessAlive(ownerPid), true, "the owner is untouched");
    assert.equal(await exists(path.join(rig.runDir, "reclaim")), false, "no reclaim mark");

    await fs.writeFile(releaseFile, "");
    const finished = await turn;
    assert.equal(finished.code, 0, finished.stderr);
    assert.match(
      finished.stdout,
      /released by file/,
      "the turn it refused to cut ended on its own",
    );
    assert.equal((await ownerLogOf(rig)).includes("queue owner RECLAIMED"), false);
  });
});

test("COMMITTED NEGATIVE — a QUEUED prompt behind a running turn is never lost: the release is refused and both prompts are answered", async () => {
  await withSession(async (rig) => {
    const releaseFile = path.join(rig.homeDir, "release-queued");
    const turn = prompt(rig, `hold-until-file ${releaseFile}`);
    await waitFor("the turn holding", 30_000, () => exists(`${releaseFile}.holding`));
    const queued = prompt(rig, "echo QUEUED-ANSWER");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const result = await release(rig);
    assert.equal(result.code, 1);
    assert.notEqual(answer(result).released, true);

    await fs.writeFile(releaseFile, "");
    assert.equal((await turn).code, 0);
    const done = await queued;
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /QUEUED-ANSWER/);
  });
});

test("COMMITTED NEGATIVE — an agent BROWSER open is not reclaimed: refused(pod_busy:browser_open), owner alive, no mark; closed again, the same owner IS released", async () => {
  await withSession(async (rig) => {
    assert.equal((await prompt(rig, "echo BROWSER-ROW")).code, 0);
    const ownerPid = await ownerPidOf(rig);
    await writeStatus(rig, { browser: { open: true, since: new Date().toISOString(), pages: 1 } });

    const refused = await releaseOnceParked(rig);
    assert.equal(refused.code, 1);
    assert.equal(answer(refused).reason, "pod_busy:browser_open");
    assert.equal(isProcessAlive(ownerPid), true);
    assert.equal(await exists(path.join(rig.runDir, "reclaim")), false);

    // CONTROL: the identical pod with the browser closed is released — so the refusal came from the browser.
    await writeStatus(rig);
    const result = await releaseOnceParked(rig);
    assert.equal(result.code, 0, `${result.stdout} ${result.stderr}`);
    await waitForOwnerGone(rig, ownerPid);
  });
});

test("COMMITTED NEGATIVE — a COMMAND IN FLIGHT is not reclaimed: refused(pod_busy:call_in_flight); the asking call's OWN mark is ignored", async () => {
  await withSession(async (rig) => {
    assert.equal((await prompt(rig, "echo FLIGHT-ROW")).code, 0);
    const ownerPid = await ownerPidOf(rig);
    // The asker's own routed call: the entry writes one mark per call with `call_id=` inside, and exports
    // the same id to the command as ACPX_ROUTED_CALL_ID, which the release CLI hands to the owner.
    const mark = (callId: string) =>
      `pid=${process.pid}\npid_start=1\nchild=${process.pid}\nstart_ms=1\ndeadline_ms=2\ncall_id=${callId}\n`;
    await fs.writeFile(
      path.join(rig.runDir, "inflight", `own-call.${process.pid}`),
      mark("own-call"),
    );
    // ANOTHER command in flight — same pids, a different call id:
    await fs.writeFile(path.join(rig.runDir, "inflight", "other-call.1"), mark("other-call"));
    const asker = { ACPX_ROUTED_CALL_ID: "own-call" };

    const refused = await releaseOnceParked(rig, ["--held-target", HELD], asker);
    assert.equal(refused.code, 1);
    assert.equal(answer(refused).reason, "pod_busy:call_in_flight");
    assert.equal(isProcessAlive(ownerPid), true);
    assert.equal(await exists(path.join(rig.runDir, "reclaim")), false);

    // CONTROL: with only the asker's own mark left, the owner IS released — the own call is not work.
    await fs.rm(path.join(rig.runDir, "inflight", "other-call.1"));
    const result = await releaseOnceParked(rig, ["--held-target", HELD], asker);
    assert.equal(result.code, 0, `${result.stdout} ${result.stderr}`);
    await waitForOwnerGone(rig, ownerPid);
  });
});

test("COMMITTED NEGATIVE — marks that cannot be read are NEVER idle: refused(pod_busy:unknown), owner untouched", async () => {
  await withSession(async (rig) => {
    assert.equal((await prompt(rig, "echo UNKNOWN-ROW")).code, 0);
    const ownerPid = await ownerPidOf(rig);
    await fs.rm(path.join(rig.statusDir, "ritest.json"));

    const refused = await releaseOnceParked(rig);
    assert.equal(refused.code, 1);
    assert.equal(answer(refused).reason, "pod_busy:unknown");
    assert.equal(isProcessAlive(ownerPid), true);
    assert.equal(await exists(path.join(rig.runDir, "reclaim")), false);
  });
});

test("COMMITTED NEGATIVE — the held message's OWN target is never released: refused(held_target_self), JSON printed, owner untouched", async () => {
  await withSession(async (rig) => {
    assert.equal((await prompt(rig, "echo SELF-ROW")).code, 0);
    const ownerPid = await ownerPidOf(rig);
    const result = await releaseOnceParked(rig, ["--held-target", rig.id]);
    assert.equal(result.code, 1);
    assert.deepEqual(
      { ...answer(result), detail: undefined },
      {
        action: "session_release",
        sessionId: rig.id,
        released: false,
        reason: "held_target_self",
        detail: undefined,
      },
    );
    assert.equal(isProcessAlive(ownerPid), true);
    assert.equal(await exists(path.join(rig.runDir, "reclaim")), false);
  });
});

test("the verb has NO unconditional form: without --if-idle, or without --held-target, it is a usage error (exit 2) and touches nothing", async () => {
  await withSession(async (rig) => {
    assert.equal((await prompt(rig, "echo USAGE-ROW")).code, 0);
    const ownerPid = await ownerPidOf(rig);
    const noIdle = await runCli(
      [
        "--cwd",
        rig.cwd,
        "codex",
        "sessions",
        "release",
        "--session-id",
        rig.id,
        "--held-target",
        HELD,
      ],
      rig,
    );
    assert.equal(noIdle.code, 2);
    assert.match(noIdle.stderr, /requires --if-idle/);
    const noTarget = await release(rig, []);
    assert.equal(noTarget.code, 2);
    assert.match(noTarget.stderr, /requires --held-target/);
    assert.equal(
      noTarget.stdout.includes("session_release"),
      false,
      "a usage error is not a verdict",
    );
    assert.equal(isProcessAlive(ownerPid), true);
  });
});

test("no owner to release: refused(no_owner), exit 1, the session_release JSON is printed, nothing started", async () => {
  await withSession(async (rig) => {
    const result = await release(rig);
    assert.equal(result.code, 1);
    assert.equal(answer(result).action, "session_release");
    assert.equal(answer(result).released, false);
    assert.equal(answer(result).reason, "no_owner");
    assert.equal(
      await exists(queuePaths(rig.homeDir, rig.id).lockPath),
      false,
      "no owner was started",
    );
  });
});
