// Order 1 (brick 07575918) — a session a PERSON writes to keeps its pool-pod agent for the person keep
// (default 60 min) after the end of the last turn that person's message started, instead of the 5-min
// idle release. Rows: the pure decision, the knob and the pool/home test, the wire field (and what a
// request WITHOUT the class gets), and a real owner with short values.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseQueueRequest } from "../src/cli/queue/messages.js";
import {
  DEFAULT_OWNER_PERSON_KEEP_MS,
  normalizeOwnerPersonKeepMs,
} from "../src/cli/session/contracts.js";
import {
  type DecideIdleOwnerReleaseInput,
  decideIdleOwnerRelease,
  resolveOwnerPersonKeepMs,
  startedByPerson,
} from "../src/cli/session/queue-owner-runtime.js";
import { agentPodName } from "../src/pod/placement.js";
import { makePod, makeServiceAccountDir } from "./pod-kit/two-pods.js";
import { queuePaths } from "./queue-test-helpers.js";

const BASE_NOW = 1_700_000_000_000;
const MIN = 60_000;
const IDLE = 5 * MIN;
const KEEP = 60 * MIN;

function input(overrides: Partial<DecideIdleOwnerReleaseInput> = {}): DecideIdleOwnerReleaseInput {
  return {
    ttlMs: 10_000,
    hasActiveTurn: false,
    now: BASE_NOW,
    lastIdleDrainActivityAt: 0,
    lastTaskCompletedAt: BASE_NOW,
    quiescenceWindowMs: 10_000,
    idleReleaseMs: IDLE,
    personKeepMs: KEEP,
    liveBackgroundTaskCount: 0,
    deployDiffers: () => false,
    recordClosed: () => false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. decideIdleOwnerRelease — the pure rows
// ---------------------------------------------------------------------------------------------

test("keep U1: a person turn ended 10 min ago ⇒ idle past 5 min does NOT release", async () => {
  const d = await decideIdleOwnerRelease(
    input({
      now: BASE_NOW + 10 * MIN,
      lastTaskCompletedAt: BASE_NOW,
      lastPersonTurnEndedAt: BASE_NOW,
    }),
  );
  assert.deepEqual(d, { release: false });
});

test("keep U2: past the keep ⇒ idle-memory releases (the keep is a bound, not a pin)", async () => {
  const at = BASE_NOW + KEEP;
  assert.deepEqual(
    await decideIdleOwnerRelease(
      input({ now: at - 1, lastTaskCompletedAt: BASE_NOW, lastPersonTurnEndedAt: BASE_NOW }),
    ),
    { release: false },
    "one ms inside the keep",
  );
  assert.deepEqual(
    await decideIdleOwnerRelease(
      input({ now: at, lastTaskCompletedAt: BASE_NOW, lastPersonTurnEndedAt: BASE_NOW }),
    ),
    { release: true, reason: "idle-memory" },
  );
});

test("keep U3: no person turn (a delivery or automation turn only) ⇒ today's 5 min", async () => {
  // `lastPersonTurnEndedAt` stays undefined for every non-interactive turn: the owner never sets it.
  const base = { lastTaskCompletedAt: BASE_NOW, lastPersonTurnEndedAt: undefined };
  assert.deepEqual(await decideIdleOwnerRelease(input({ ...base, now: BASE_NOW + IDLE - 1 })), {
    release: false,
  });
  assert.deepEqual(await decideIdleOwnerRelease(input({ ...base, now: BASE_NOW + IDLE })), {
    release: true,
    reason: "idle-memory",
  });
});

test("keep U4: keep 0 (or absent) ⇒ today, even with a person turn on record", async () => {
  for (const personKeepMs of [0, undefined]) {
    const d = await decideIdleOwnerRelease(
      input({
        personKeepMs,
        now: BASE_NOW + IDLE,
        lastTaskCompletedAt: BASE_NOW,
        lastPersonTurnEndedAt: BASE_NOW,
      }),
    );
    assert.deepEqual(d, { release: true, reason: "idle-memory" }, `personKeepMs=${personKeepMs}`);
  }
});

test("keep U5: a LATER agent turn does not shorten the keep, and does not extend it", async () => {
  // The person's turn ended at BASE_NOW; an agent turn ended 20 min later (lastTaskCompletedAt moves).
  // 5 min after the agent turn the ordinary clock is up — the keep still holds (person turn 25 min ago).
  const agentTurnEnd = BASE_NOW + 20 * MIN;
  assert.deepEqual(
    await decideIdleOwnerRelease(
      input({
        now: agentTurnEnd + IDLE,
        lastTaskCompletedAt: agentTurnEnd,
        lastPersonTurnEndedAt: BASE_NOW,
      }),
    ),
    { release: false },
  );
  // And once the keep runs out (measured from the PERSON's turn end) the agent turn's recency does not hold it.
  assert.deepEqual(
    await decideIdleOwnerRelease(
      input({
        now: BASE_NOW + KEEP,
        lastTaskCompletedAt: BASE_NOW + KEEP - IDLE,
        lastPersonTurnEndedAt: BASE_NOW,
      }),
    ),
    { release: true, reason: "idle-memory" },
  );
});

test("keep U6: deploy-staleness still releases inside the keep; so does nothing else the gate holds", async () => {
  const inside = {
    now: BASE_NOW + 2 * MIN,
    lastTaskCompletedAt: BASE_NOW,
    lastPersonTurnEndedAt: BASE_NOW,
  };
  assert.deepEqual(await decideIdleOwnerRelease(input({ ...inside, deployDiffers: () => true })), {
    release: true,
    reason: "deploy-staleness",
  });
  // The shared gate is untouched: an active turn / a live background task / --ttl 0 never release.
  const long = { ...inside, now: BASE_NOW + 3 * KEEP, deployDiffers: () => true };
  assert.deepEqual(await decideIdleOwnerRelease(input({ ...long, hasActiveTurn: true })), {
    release: false,
  });
  assert.deepEqual(await decideIdleOwnerRelease(input({ ...long, liveBackgroundTaskCount: 1 })), {
    release: false,
  });
  assert.deepEqual(await decideIdleOwnerRelease(input({ ...long, ttlMs: 0 })), { release: false });
});

// ---------------------------------------------------------------------------------------------
// 2. THE ONE PLACE THE KEEP READS THE CLASS
// ---------------------------------------------------------------------------------------------

test("keep C1: only `interactive` starts the keep — never delivery, automation, spawn or no class", () => {
  assert.equal(startedByPerson([{ admissionClass: "interactive" }]), true);
  assert.equal(startedByPerson([{}, { admissionClass: "interactive" }]), true, "any member");
  for (const admissionClass of ["delivery", "automation", "spawn", "", "x"]) {
    assert.equal(startedByPerson([{ admissionClass }]), false, `class ${admissionClass}`);
  }
  assert.equal(startedByPerson([{}]), false, "NO class — the agent's own shell");
  assert.equal(startedByPerson([]), false);
});

// ---------------------------------------------------------------------------------------------
// 3. the knob, and "pool pod" told from "home pod" by what the pod itself says
// ---------------------------------------------------------------------------------------------

function podEnv(
  root: string,
  extra: Record<string, string | undefined>,
  place: "agent" | "control" = "agent",
): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  const pod = makePod("keep");
  if (place === "agent") {
    fs.writeFileSync(path.join(home, ".nv-agent"), `${pod.name}\n`);
  }
  return {
    NODE_TEST_CONTEXT: "child-v8",
    ACPX_POD_TEST_HOME: home,
    ACPX_POD_SA_DIR: makeServiceAccountDir(root),
    NV_POD_NAME: pod.name,
    NV_POD_UID: pod.uid,
    NV_NODE_NAME: pod.node,
    ...extra,
  };
}

test("keep K1: pool pod ⇒ the default 60 min; unset, empty and blank all mean the default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "person-keep-k1-"));
  try {
    for (const raw of [undefined, "", "   "]) {
      const env = podEnv(root, { NV_AGENT_PLACEMENT: "pool", ACPX_OWNER_PERSON_KEEP_MS: raw });
      assert.equal(resolveOwnerPersonKeepMs(env), DEFAULT_OWNER_PERSON_KEEP_MS, `raw=${raw}`);
    }
    assert.equal(DEFAULT_OWNER_PERSON_KEEP_MS, 3_600_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keep K2: a HOME pod, a pod that does not say, the control pod and a bare process keep today's behaviour", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "person-keep-k2-"));
  try {
    assert.equal(resolveOwnerPersonKeepMs(podEnv(root, { NV_AGENT_PLACEMENT: "home" })), 0, "home");
    assert.equal(resolveOwnerPersonKeepMs(podEnv(root, {})), 0, "an agent pod that says nothing");
    assert.equal(
      resolveOwnerPersonKeepMs(podEnv(root, { NV_AGENT_PLACEMENT: "elsewhere" })),
      0,
      "an unknown placement",
    );
    assert.equal(
      resolveOwnerPersonKeepMs(podEnv(root, { NV_AGENT_PLACEMENT: "pool" }, "control")),
      0,
      "the control pod, even carrying the variable",
    );
    assert.equal(resolveOwnerPersonKeepMs({ NV_AGENT_PLACEMENT: "pool" }), 0, "a bare process");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keep K3: the value — 0 disables, a number sets, anything invalid is the default AND warns", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "person-keep-k3-"));
  try {
    const pool = (raw: string) =>
      podEnv(root, { NV_AGENT_PLACEMENT: "pool", ACPX_OWNER_PERSON_KEEP_MS: raw });
    const warnings: string[] = [];
    const warn = (line: string) => warnings.push(line);
    assert.equal(resolveOwnerPersonKeepMs(pool("0"), warn), 0);
    assert.equal(resolveOwnerPersonKeepMs(pool("4000"), warn), 4000);
    assert.deepEqual(warnings, [], "valid values never warn");
    for (const bad of ["abc", "-5", "NaN", "Infinity", "1e999"]) {
      assert.equal(resolveOwnerPersonKeepMs(pool(bad), warn), DEFAULT_OWNER_PERSON_KEEP_MS, bad);
    }
    assert.equal(warnings.length, 5);
    assert.match(warnings[0], /ACPX_OWNER_PERSON_KEEP_MS="abc".*default/u);
    // A home pod never reads the knob, so it never warns about it either.
    const before = warnings.length;
    resolveOwnerPersonKeepMs(
      podEnv(root, { NV_AGENT_PLACEMENT: "home", ACPX_OWNER_PERSON_KEEP_MS: "abc" }),
      warn,
    );
    assert.equal(warnings.length, before);
    assert.equal(normalizeOwnerPersonKeepMs("12.6"), 13);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// 4. the wire: ONE optional field on submit_prompt and submit_prompt_batch
// ---------------------------------------------------------------------------------------------

const submit = (extra: Record<string, unknown>) => ({
  type: "submit_prompt",
  requestId: "r1",
  message: "hello",
  permissionMode: "approve-all",
  waitForCompletion: false,
  ...extra,
});
const batch = (extra: Record<string, unknown>) => ({
  type: "submit_prompt_batch",
  requestId: "r2",
  members: [{ messageId: "m1", message: "hello", prompt: [{ type: "text", text: "hello" }] }],
  permissionMode: "approve-all",
  waitForCompletion: false,
  ...extra,
});
const classOf = (request: unknown) =>
  (parseQueueRequest(request) as { admissionClass?: string } | null)?.admissionClass;

test("keep W1: admissionClass survives the parse on both submissions", () => {
  for (const admissionClass of ["interactive", "delivery", "automation", "spawn"]) {
    assert.equal(classOf(submit({ admissionClass })), admissionClass);
    assert.equal(classOf(batch({ admissionClass })), admissionClass);
  }
});

test("keep W2 NEGATIVE: a submission well-formed in every other respect but with no class, a bogus one or a wrong type carries NONE — and is not refused", () => {
  for (const make of [submit, batch]) {
    const parsed = parseQueueRequest(make({}));
    assert.ok(parsed, "a request without the class still parses");
    assert.equal(
      "admissionClass" in parsed,
      false,
      "absent stays absent (not null, not a default)",
    );
    for (const bogus of ["person", "INTERACTIVE", "", 7, null, true, { class: "interactive" }]) {
      const parsedBogus = parseQueueRequest(make({ admissionClass: bogus }));
      assert.ok(parsedBogus, `a bogus class (${JSON.stringify(bogus)}) must not cost the prompt`);
      assert.equal("admissionClass" in parsedBogus, false, JSON.stringify(bogus));
    }
  }
  // And what the owner makes of each: only the declared `interactive` ever starts the keep.
  assert.equal(startedByPerson([{ admissionClass: classOf(submit({})) }]), false);
  assert.equal(
    startedByPerson([{ admissionClass: classOf(submit({ admissionClass: "delivery" })) }]),
    false,
  );
});

// ---------------------------------------------------------------------------------------------
// 5. a REAL owner with short values — the person's owner stays, an agent's goes
// ---------------------------------------------------------------------------------------------

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_HREF = pathToFileURL(
  fileURLToPath(new URL("./mock-agent.js", import.meta.url)),
).href;
const IDLE_MS = 1_000;
const KEEP_MS = 12_000;

type Run = { code: number | null; stdout: string; stderr: string };

function runCli(rig: Rig, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...rig.env, ...extraEnv },
      cwd: rig.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

type Rig = { root: string; env: NodeJS.ProcessEnv; agent: string; id: string; starts: string };

/**
 * A session whose owner runs as a pod would: the C1.1 test seam makes the process an agent pod
 * (`.nv-agent` under the stand-in home, the downward API variables) and `NV_AGENT_PLACEMENT` says
 * which kind. Created OUTSIDE the pod seam, then every later call runs inside it.
 */
async function makeRig(placement: "pool" | "home", keepMs: string | undefined): Promise<Rig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-person-keep-"));
  fs.mkdirSync(path.join(root, ".acpx", "sessions"), { recursive: true });
  fs.mkdirSync(path.join(root, "work"));
  const starts = path.join(root, "agent-starts.ndjson");
  const wrapper = path.join(root, "agent.mjs");
  fs.writeFileSync(
    wrapper,
    `import fs from "node:fs";\n` +
      `fs.appendFileSync(${JSON.stringify(starts)}, JSON.stringify({ classPresent: "ACPX_ADMISSION_CLASS" in process.env }) + "\\n");\n` +
      `await import(${JSON.stringify(MOCK_AGENT_HREF)});\n`,
  );
  const agent = `node ${JSON.stringify(wrapper)} --claude-agent-acp --supports-resume-session`;
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    ACPX_STATE_HOME: root,
    ACPX_ADMISSION_DIR: path.join(root, "admission"),
    ACPX_CAPACITY_PODINFO_DIR: path.join(root, "no-podinfo"),
    ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
  };
  for (const key of [
    "ACPX_SESSION_URL",
    "ACPX_SEAT_URL",
    "ACPX_SESSION_NAME",
    "ACPX_SESSION_RECORD_ID",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_PARENT_SEAT_URL",
    "ACPX_ADMISSION_CLASS",
    "ACPX_BRICK",
    "ACPX_BRICK_PATH",
    "ACPX_TASK_FOLDER",
    "ACPX_OWNER_LOG",
    "ACPX_OWNER_PERSON_KEEP_MS",
  ]) {
    delete base[key];
  }
  const rig: Rig = { root, env: base, agent, id: "", starts };
  const created = await runCli(rig, [
    "--format",
    "json",
    "--agent",
    agent,
    "--cwd",
    path.join(root, "work"),
    "sessions",
    "new",
  ]);
  assert.equal(created.code, 0, created.stderr);
  rig.id = String((JSON.parse(created.stdout.trim()) as { acpxRecordId: unknown }).acpxRecordId);
  // Now stand as the session's own agent pod.
  const pod = makePod("keep-real");
  pod.name = agentPodName(rig.id);
  fs.writeFileSync(path.join(root, ".nv-agent"), `${pod.name}\n`);
  rig.env = {
    ...base,
    ACPX_POD_TEST_HOME: root,
    ACPX_POD_SA_DIR: makeServiceAccountDir(root),
    NV_POD_NAME: pod.name,
    NV_POD_UID: pod.uid,
    NV_NODE_NAME: pod.node,
    NV_AGENT_PLACEMENT: placement,
    ACPX_OWNER_IDLE_RELEASE_MS: String(IDLE_MS),
    ...(keepMs !== undefined ? { ACPX_OWNER_PERSON_KEEP_MS: keepMs } : {}),
  };
  return rig;
}

const prompt = (rig: Rig, text: string, cls: string | undefined) =>
  runCli(
    rig,
    [
      "--format",
      "json",
      "--agent",
      rig.agent,
      "--ttl",
      "60",
      "prompt",
      "--session-id",
      rig.id,
      text,
    ],
    cls !== undefined ? { ACPX_ADMISSION_CLASS: cls } : {},
  );

const leaseOf = (rig: Rig) => queuePaths(rig.root, rig.id).lockPath;
const ownerLog = (rig: Rig) => {
  try {
    return fs.readFileSync(path.join(rig.root, ".acpx", "sessions", `${rig.id}.owner.log`), "utf8");
  } catch {
    return "";
  }
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitGone(rig: Rig, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (fs.existsSync(leaseOf(rig))) {
    assert.ok(Date.now() < deadline, `the owner was never released within ${timeoutMs} ms`);
    await sleep(100);
  }
  return Date.now();
}

type Case = {
  name: string;
  placement: "pool" | "home";
  keepMs: string | undefined;
  cls: string | undefined;
  kept: boolean;
};

const CASES: Case[] = [
  {
    name: "person class, pool pod",
    placement: "pool",
    keepMs: String(KEEP_MS),
    cls: "interactive",
    kept: true,
  },
  {
    name: "NEGATIVE delivery class, pool pod",
    placement: "pool",
    keepMs: String(KEEP_MS),
    cls: "delivery",
    kept: false,
  },
  {
    name: "NEGATIVE automation class, pool pod",
    placement: "pool",
    keepMs: String(KEEP_MS),
    cls: "automation",
    kept: false,
  },
  {
    name: "NEGATIVE no class (an agent's own shell), pool pod",
    placement: "pool",
    keepMs: String(KEEP_MS),
    cls: undefined,
    kept: false,
  },
  {
    name: "NEGATIVE person class, HOME pod",
    placement: "home",
    keepMs: String(KEEP_MS),
    cls: "interactive",
    kept: false,
  },
  {
    name: "NEGATIVE person class, pool pod, keep 0",
    placement: "pool",
    keepMs: "0",
    cls: "interactive",
    kept: false,
  },
];

test("keep R1: a real owner — a person-class prompt keeps it past the idle release and until the keep ends; every other shape goes at the idle release", async () => {
  const results = await Promise.all(
    CASES.map(async (c) => {
      const rig = await makeRig(c.placement, c.keepMs);
      try {
        const run = await prompt(rig, "echo hello", c.cls);
        assert.equal(run.code, 0, `${c.name}: ${run.stderr}`);
        const turnEnd = Date.now();
        assert.ok(
          fs.existsSync(leaseOf(rig)),
          `${c.name}: an owner holds the session after the turn`,
        );
        const goneAt = await waitGone(rig, KEEP_MS + 25_000);
        const log = ownerLog(rig);
        const starts = fs
          .readFileSync(rig.starts, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { classPresent: boolean });
        return { c, heldMs: goneAt - turnEnd, log, starts, rig };
      } catch (error) {
        throw new Error(`${c.name}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    }),
  );
  try {
    for (const { c, heldMs, log, starts } of results) {
      assert.match(log, /releasing session .* \(reason=idle-memory\)/u, `${c.name}: ${log}`);
      // The class never reached the owner's adapter (acpx deleted it at CLI start), prompt or not.
      assert.deepEqual(
        starts.map((s) => s.classPresent),
        starts.map(() => false),
        `${c.name}: the declared class reached an adapter`,
      );
      if (c.kept) {
        assert.ok(
          heldMs >= KEEP_MS - 500,
          `${c.name}: released after ${heldMs} ms, inside the keep`,
        );
        assert.match(log, /person keep armed for session/u, c.name);
      } else {
        assert.ok(heldMs < KEEP_MS - 1_500, `${c.name}: held ${heldMs} ms, the keep applied`);
        assert.doesNotMatch(log, /person keep armed/u, c.name);
      }
    }
  } finally {
    for (const { rig } of results) {
      fs.rmSync(rig.root, { recursive: true, force: true });
    }
  }
});
