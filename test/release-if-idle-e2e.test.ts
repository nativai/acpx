// brick 35d4e64b (acpx half of ef5934ba) — `acpx sessions release --if-idle`, END TO END, in the production
// shape: the real CLI starts a real queue owner (a detached process), the owner spawns the mock agent as its
// adapter, and `sessions release --if-idle` is a SEPARATE real CLI process that asks that owner over its
// socket. The pod's idle predicate (`nv-agent-idle --check`, infra's, not installed anywhere yet) is a STUB
// executable whose exit code the test sets per row (0 idle · 10 browser_open · 11 call_in_flight · 12 busy)
// and which logs its argv; the owner finds it through the test-only ACPX_IDLE_PREDICATE override.
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
  stub: string;
  verdictFile: string;
  argvLog: string;
};

function cliEnv(rig: Pick<Rig, "runDir" | "stub">, homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    ACPX_STATE_HOME: homeDir,
    ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    NV_AG_RUN_DIR: rig.runDir,
    ACPX_IDLE_PREDICATE: rig.stub,
  };
  delete env.ACPX_ROUTED_CALL_ID;
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

/** What the stub predicate answers next: its exit code, or `hang` (sleeps past the owner's 5 s bound). */
async function setVerdict(rig: Rig, verdict: string): Promise<void> {
  await fs.writeFile(rig.verdictFile, verdict);
}

async function withSession(run: (rig: Rig) => Promise<void>): Promise<void> {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const runDir = path.join(homeDir, "nv-run");
    const stubDir = path.join(homeDir, "nv-stub");
    const stub = path.join(stubDir, "nv-agent-idle");
    const verdictFile = path.join(stubDir, "verdict");
    const argvLog = path.join(stubDir, "argv.log");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(stubDir, { recursive: true });
    await fs.writeFile(verdictFile, "0");
    await fs.writeFile(
      stub,
      `#!/bin/sh\necho "$@" >> ${JSON.stringify(argvLog)}\nv=$(cat ${JSON.stringify(verdictFile)})\n` +
        `[ "$v" = hang ] && exec sleep 30\ncase $v in 2) echo 'unknown no_idle_loop';; 10) echo browser_open;; 11) echo call_in_flight;; 12) echo busy;; esac\nexit "$v"\n`,
      { mode: 0o755 },
    );
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { codex: { command: MOCK_AGENT_COMMAND } } })}\n`,
    );
    const rig: Rig = { homeDir, cwd, id: "", sessionsDir: "", runDir, stub, verdictFile, argvLog };
    const created = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "reclaimable"],
      rig,
    );
    assert.equal(created.code, 0, created.stderr);
    rig.id = String((JSON.parse(created.stdout.trim()) as { acpxRecordId: unknown }).acpxRecordId);
    rig.sessionsDir = path.join(homeDir, ".acpx", "sessions");
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
    const raw = answer(result).detail;
    const detail = typeof raw === "string" ? raw : "";
    if (
      result.code === 0 ||
      answer(result).reason !== "turn_running" ||
      /^(background|closing):/.test(detail)
    ) {
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
    // The pod's rule ignores a symlink: the mark is a REGULAR file (temp + rename in the run dir).
    const markStat = await fs.lstat(path.join(rig.runDir, "reclaim"));
    assert.equal(markStat.isFile(), true, "a regular file");
    assert.equal(markStat.isSymbolicLink(), false, "never a symlink");
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

/** One refusal row: the predicate answers `verdict`, the owner is untouched; set back to 0 the SAME owner is released. */
async function pinnedRefusalRow(
  rig: Rig,
  label: string,
  verdict: string,
  expected: string,
): Promise<void> {
  assert.equal((await prompt(rig, `echo ${label}-ROW`)).code, 0);
  const ownerPid = await ownerPidOf(rig);
  await setVerdict(rig, verdict);

  const refused = await releaseOnceParked(rig);
  assert.equal(refused.code, 1);
  assert.equal(answer(refused).released, false);
  assert.equal(answer(refused).reason, expected);
  assert.equal(isProcessAlive(ownerPid), true, "the owner is untouched");
  assert.equal(await exists(path.join(rig.runDir, "reclaim")), false, "no reclaim mark");

  // CONTROL: the identical pod with an idle answer is released — so the refusal came from the predicate.
  await setVerdict(rig, "0");
  const result = await releaseOnceParked(rig);
  assert.equal(result.code, 0, `${result.stdout} ${result.stderr}`);
  await waitForOwnerGone(rig, ownerPid);
}

test("COMMITTED NEGATIVE — an agent BROWSER open is not reclaimed: predicate exit 10 ⇒ refused(pod_busy:browser_open)", async () => {
  await withSession((rig) => pinnedRefusalRow(rig, "BROWSER", "10", "pod_busy:browser_open"));
});

test("COMMITTED NEGATIVE — a COMMAND IN FLIGHT is not reclaimed: predicate exit 11 ⇒ refused(pod_busy:call_in_flight)", async () => {
  await withSession((rig) => pinnedRefusalRow(rig, "FLIGHT", "11", "pod_busy:call_in_flight"));
});

test("COMMITTED NEGATIVE — a BUSY pod is not reclaimed: predicate exit 12 ⇒ refused(pod_busy:busy)", async () => {
  await withSession((rig) => pinnedRefusalRow(rig, "BUSY", "12", "pod_busy:busy"));
});

test("COMMITTED NEGATIVE — the predicate's own fail-closed answer (exit 2, `unknown no_idle_loop`) is pod_busy:unknown, owner untouched", async () => {
  await withSession((rig) => pinnedRefusalRow(rig, "EXIT2", "2", "pod_busy:unknown"));
});

test("COMMITTED NEGATIVE — a predicate that answers anything else is NEVER idle: refused(pod_busy:unknown)", async () => {
  await withSession((rig) => pinnedRefusalRow(rig, "UNKNOWN", "1", "pod_busy:unknown"));
});

test("COMMITTED NEGATIVE — a predicate that is NOT INSTALLED (the image lands later) refuses pod_busy:unknown; once it is there the same owner is released", async () => {
  await withSession(async (rig) => {
    assert.equal((await prompt(rig, "echo MISSING-ROW")).code, 0);
    const ownerPid = await ownerPidOf(rig);
    const hidden = `${rig.stub}.hidden`;
    await fs.rename(rig.stub, hidden);

    const refused = await releaseOnceParked(rig);
    assert.equal(refused.code, 1);
    assert.equal(answer(refused).reason, "pod_busy:unknown");
    assert.equal(isProcessAlive(ownerPid), true);
    assert.equal(await exists(path.join(rig.runDir, "reclaim")), false);

    await fs.rename(hidden, rig.stub);
    const result = await releaseOnceParked(rig);
    assert.equal(result.code, 0, `${result.stdout} ${result.stderr}`);
    await waitForOwnerGone(rig, ownerPid);
  });
});

test("COMMITTED NEGATIVE — a predicate that HANGS is bounded at 5 s and refuses pod_busy:unknown, owner untouched", async () => {
  await withSession(async (rig) => {
    assert.equal((await prompt(rig, "echo HANG-ROW")).code, 0);
    const ownerPid = await ownerPidOf(rig);
    await setVerdict(rig, "hang");
    const started = Date.now();
    const refused = await releaseOnceParked(rig);
    assert.equal(refused.code, 1);
    assert.equal(answer(refused).reason, "pod_busy:unknown");
    assert.ok(Date.now() - started < 25_000, "bounded");
    assert.equal(isProcessAlive(ownerPid), true);
  });
});

test("the predicate is called with --check, the OWNER's pid and the asking call's id; a release that is not routed passes NO id (fail closed)", async () => {
  await withSession(async (rig) => {
    assert.equal((await prompt(rig, "echo ARGV-ROW")).code, 0);
    const ownerPid = await ownerPidOf(rig);
    // Not routed: no ACPX_ROUTED_CALL_ID ⇒ no --exclude-call-id (every mark counts). Refused, so it can be repeated.
    await setVerdict(rig, "11");
    await releaseOnceParked(rig);
    await releaseOnceParked(rig, ["--held-target", HELD], { ACPX_ROUTED_CALL_ID: "own-call-1" });
    const calls = (await fs.readFile(rig.argvLog, "utf8")).split("\n").filter(Boolean);
    assert.ok(calls.includes(`--check --owner-pid ${ownerPid}`), calls.join(" | "));
    assert.ok(
      calls.includes(`--check --owner-pid ${ownerPid} --exclude-call-id own-call-1`),
      calls.join(" | "),
    );
    assert.equal(
      calls.filter((line) => line.includes("--exclude-call-id") && !line.endsWith("own-call-1"))
        .length,
      0,
    );
  });
});

/** The prompt that makes the agent run `argv` itself, start a background task, and answer `say`. */
function runThenSayWithBackgroundTask(say: string, bgTask: [number, string]): string {
  const spec = { argv: ["true"], say, bgTask };
  return `run-then-say ${Buffer.from(JSON.stringify(spec)).toString("base64url")}`;
}

test("COMMITTED NEGATIVE — a live BACKGROUND TASK is never killed by a release: refused(turn_running, detail background:), owner untouched, the session keeps working", async () => {
  await withSession(async (rig) => {
    const result = await prompt(rig, runThenSayWithBackgroundTask("BG-ANSWER", [120_000, "bg-1"]));
    assert.equal(result.code, 0, result.stderr);
    const ownerPid = await ownerPidOf(rig);

    const refused = await releaseOnceParked(rig);
    assert.equal(refused.code, 1, `${refused.stdout} ${refused.stderr}`);
    assert.equal(answer(refused).released, false);
    assert.equal(answer(refused).reason, "turn_running");
    assert.match(JSON.stringify(answer(refused).detail), /^"background:/);
    assert.equal(isProcessAlive(ownerPid), true, "the owner is untouched");
    assert.equal(await exists(path.join(rig.runDir, "reclaim")), false);

    const next = await prompt(rig, "echo STILL-SERVING");
    assert.equal(next.code, 0, next.stderr);
    assert.match(next.stdout, /STILL-SERVING/);
  });
});

test("atrium's EXACT argv — `acpx --format json sessions release --if-idle --session-id <id> --held-target <id>`, no agent word — refuses and releases", async () => {
  await withSession(async (rig) => {
    assert.equal((await prompt(rig, "echo ATRIUM-ARGV-ROW")).code, 0);
    const ownerPid = await ownerPidOf(rig);
    const atrium = () =>
      runCli(
        [
          "--format",
          "json",
          "sessions",
          "release",
          "--if-idle",
          "--session-id",
          rig.id,
          "--held-target",
          HELD,
        ],
        rig,
      );
    await setVerdict(rig, "10");
    const deadline = Date.now() + 30_000;
    let refused = await atrium();
    while (
      refused.code === 1 &&
      answer(refused).reason === "turn_running" &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      refused = await atrium();
    }
    assert.equal(refused.code, 1, `${refused.stdout} ${refused.stderr}`);
    assert.equal(answer(refused).action, "session_release");
    assert.equal(answer(refused).reason, "pod_busy:browser_open");
    assert.equal(isProcessAlive(ownerPid), true);

    await setVerdict(rig, "0");
    const released = await atrium();
    assert.equal(released.code, 0, `${released.stdout} ${released.stderr}`);
    assert.equal(answer(released).released, true);
    await waitForOwnerGone(rig, ownerPid);
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
    // With --format json a usage error is reported as the JSON error document, on stdout.
    assert.match(`${noTarget.stdout}${noTarget.stderr}`, /requires --held-target/);
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

test("the help names the WHOLE closed reason set (incl. pod_busy:busy) and says that outside an agent pod a release always refuses pod_busy:unknown (L1, L5)", async () => {
  await withSession(async (rig) => {
    const help = await runCli(["sessions", "release", "--help"], rig);
    assert.equal(help.code, 0, help.stderr);
    const text = help.stdout.replaceAll(/\s+/g, " ");
    for (const reason of [
      "turn_running",
      "queued",
      "pod_busy:browser_open",
      "pod_busy:call_in_flight",
      "pod_busy:busy",
      "pod_busy:unknown",
      "no_owner",
      "unsupported",
      "held_target_self",
    ]) {
      assert.ok(text.includes(reason), `help lists ${reason}`);
    }
    assert.match(text, /outside an agent pod[^.]*always[^.]*pod_busy:unknown/i);
  });
});
