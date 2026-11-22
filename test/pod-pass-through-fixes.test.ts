import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Command } from "commander";
import { registerDefaultCommands } from "../src/cli/command-registration.js";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";
import { callHome, clampRetryAfterS, waitingLine, type WaitInfo } from "../src/pod/call-home.js";
import { classifyArgv, COMMAND_TABLE } from "../src/pod/command-classes.js";
import {
  buildPassThroughCall,
  checkAdvice,
  PATH_FLAG_RULES,
  PATH_OPERAND_RULES,
  PassThroughUsageError,
  realPathOf,
  underSharedRoot,
  type PassThroughInput,
} from "../src/pod/pass-through-args.js";
import { agentPodEnv, agentPodHome, runCli, tmpDir, type ChildRun } from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
import type { AtriumScript, RecordedAtrium } from "./pod-kit/recorded-atrium.js";

// brick 7eb9686f — the fix round after the test engineer's verdict on bb032e25 (TE-VERIFICATION.md):
// F-1 (an executable recovery), F-1b (advice per class), F-2 (Retry-After clamp), F-3 (real paths),
// F-4 (operands), O-4 (progress). Each row is an input right in every respect but the one it protects.

const BUILT_IN = ["claude", "codex", "pi"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

async function withAtrium(script: AtriumScript, run: (atrium: RecordedAtrium) => Promise<void>) {
  const atrium = await startRecordedAtrium(script);
  try {
    await run(atrium);
  } finally {
    await atrium.close();
  }
}

const FAST = {
  ACPX_CALL_HOME_BUDGET_MS: "20000",
  ACPX_CALL_HOME_RETRY_MS: "100",
  ACPX_CALL_HOME_ANSWER_TIMEOUT_MS: "1500",
};

/** `acpx a 'b c'` → ["a", "b c"]: the printed command, back into an argv (single quotes only). */
function shellSplit(line: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'\\'')*)'|(\S+)/gu;
  for (const m of line.matchAll(re)) {
    out.push((m[1] ?? m[2] ?? "").replaceAll("'\\''", "'"));
  }
  return out;
}

function retryLineOf(stderr: string): string {
  const line = stderr.split("\n").find((l) => l.includes("Repeat exactly this command")) ?? "";
  return line.slice(line.indexOf("creating nothing twice: ") + "creating nothing twice: ".length);
}

// ─── F-1: the recovery after CALL_HOME outcome=unknown is executable ─────────────────────────────

test("F-1: a lost answer, then the PRINTED retry, is an IDENTICAL request (same argv, call_id and stdin)", async () => {
  const { home } = agentPodHome();
  const work = tmpDir("acpx-a3-work-");
  fs.writeFileSync(path.join(work, "brief.md"), "the brief\n");
  await withAtrium({ calls: [{ answer: { exit: 0 }, loseAnswer: true }] }, async (atrium) => {
    const env = agentPodEnv(home, atrium.url, FAST);
    const first = await runCli(
      ["sessions", "new", "--name", "it's child", "--prompt-file", "brief.md"],
      env,
      { cwd: work },
    );
    assert.equal(first.status, 1, first.stderr);
    assert.match(first.stderr, /^acpx: CALL_HOME outcome=unknown reason=connection call_id=/u);
    const printed = shellSplit(retryLineOf(first.stderr));
    assert.equal(printed[0], "acpx");
    // The command line the agent was told to run: its own words plus the two ids, nothing else.
    assert.deepEqual(printed.slice(1, 6), [
      "sessions",
      "new",
      "--name",
      "it's child",
      "--prompt-file",
    ]);
    const retry = await runCli(printed.slice(1), env, { cwd: work });
    assert.equal(retry.status, 0, retry.stderr);
    const [a, b] = atrium.requests.filter((r) => r.route === "call");
    assert.ok(a?.body && b?.body, "two calls reached atrium");
    assert.deepEqual(b.body.argv, a.body.argv, "the retry's argv is byte-identical to the first's");
    assert.equal(b.body.call_id, a.body.call_id, "same call_id");
    assert.equal(b.callId, a.callId);
    assert.equal(b.stdin, a.stdin, "same file bytes");
    const argv = a.body.argv as string[];
    assert.equal(
      argv[argv.indexOf("--created-by-call") + 1],
      a.body.call_id,
      "call_id IS the created-by call",
    );
    assert.match(argv[argv.indexOf("--record-id") + 1] ?? "", UUID);
  });
});

test("F-1: the caller's own --record-id / --created-by-call are forwarded as given; only the missing one is minted", () => {
  const mine = "dddddddd-0000-4000-8000-0000000000d1";
  const call = "eeeeeeee-0000-4000-8000-0000000000e1";
  const both = buildPassThroughCall(
    input(["sessions", "new", "--record-id", mine, "--created-by-call", call]),
  );
  assert.deepEqual(both.body.argv, [
    "sessions",
    "new",
    "--record-id",
    mine,
    "--created-by-call",
    call,
  ]);
  assert.equal(both.body.call_id, call);
  const onlyRecord = buildPassThroughCall(input(["sessions", "new", `--record-id=${mine}`]));
  assert.deepEqual((onlyRecord.body.argv as string[]).slice(0, 3), [
    "sessions",
    "new",
    `--record-id=${mine}`,
  ]);
  assert.equal(
    (onlyRecord.body.argv as string[]).length,
    5,
    "one flag pair added: --created-by-call",
  );
  const onlyCall = buildPassThroughCall(input(["sessions", "new", "--created-by-call", call]));
  assert.deepEqual((onlyCall.body.argv as string[]).slice(0, 4), [
    "sessions",
    "new",
    "--created-by-call",
    call,
  ]);
  assert.equal((onlyCall.body.argv as string[])[4], "--record-id");
});

test("F-1: the printed retry, fed back, adds nothing: the wire argv is unchanged (so the replay fingerprint matches)", () => {
  for (const argv of [
    ["sessions", "new", "--name", "x"],
    ["sessions", "new", "--", "--weird"],
    ["sessions", "import", "a.tar"],
  ]) {
    const first = buildPassThroughCall(input(argv, { commandPath: argv.slice(0, 2).join(" ") }));
    assert.equal(first.advice.kind, "retry");
    const printed = shellSplit(first.advice.kind === "retry" ? first.advice.command : "").slice(1);
    const second = buildPassThroughCall(
      input(printed, { commandPath: argv.slice(0, 2).join(" ") }),
    );
    assert.deepEqual(second.body.argv, first.body.argv, argv.join(" "));
    assert.equal(second.body.call_id, first.body.call_id, argv.join(" "));
  }
});

/**
 * The control pod's half: the request atrium runs is acpx on the control pod with that argv. The
 * first attempt creates; the printed retry — the same argv — is answered with the first record.
 */
test("F-1: on the control pod the retry's argv is a REPLAY — rc 0, the same record, nothing duplicated", async () => {
  const first = buildPassThroughCall(input(["sessions", "new", "--name", "child"]));
  const argv = first.body.argv as string[];
  const recordId = argv[argv.indexOf("--record-id") + 1] ?? "";
  const home = tmpDir("acpx-a3-control-");
  const work = path.join(home, "work");
  fs.mkdirSync(work, { recursive: true });
  const sa = tmpDir("acpx-a3-sa-");
  fs.writeFileSync(path.join(sa, "namespace"), "dev-kit\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT || "child",
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: home,
    ACPX_POD_SA_DIR: sa,
    NV_POD_NAME: "dev-server-0",
    NV_POD_UID: "00000000-0000-0000-0000-000000000001",
    NV_NODE_NAME: "node-a",
  };
  delete env.ACPX_STATE_HOME;
  const create = (): Promise<ChildRun> =>
    runCli(["--agent", "agent", "--cwd", work, "--format", "json", ...argv], env, { cwd: work });
  const one = await create();
  assert.equal(one.status, 0, one.stderr);
  const recordFile = path.join(home, ".acpx", "sessions", `${recordId}.json`);
  const bytes = fs.readFileSync(recordFile, "utf8");
  const two = await create();
  assert.equal(two.status, 0, two.stderr);
  assert.equal(
    (JSON.parse(two.stdout.trim().split("\n").at(-1) ?? "{}") as { acpxRecordId?: string })
      .acpxRecordId,
    recordId,
    "the replay answers with the first record",
  );
  assert.equal(fs.readFileSync(recordFile, "utf8"), bytes, "nothing written the second time");
  assert.deepEqual(
    fs
      .readdirSync(path.join(home, ".acpx", "sessions"))
      .filter((f) => f.endsWith(".json") && f !== "seats.json" && f !== "index.json"),
    [`${recordId}.json`],
    "one record",
  );
  // Negative: the OLD retry — the record id alone, a new call id — is a collision, not a replay.
  const old = await runCli(
    [
      "--agent",
      "agent",
      "--cwd",
      work,
      "--format",
      "json",
      "sessions",
      "new",
      "--record-id",
      recordId,
      "--created-by-call",
      "ffffffff-0000-4000-8000-0000000000f1",
    ],
    env,
    { cwd: work },
  );
  assert.notEqual(old.status, 0, "a different call id on the same record id is refused");
});

// ─── F-1b: advice only where the control pod de-duplicates ───────────────────────────────────────

async function unknownText(argv: string[], script: AtriumScript = { phases: [{ mode: "hang" }] }) {
  const { home } = agentPodHome();
  let result: ChildRun | undefined;
  await withAtrium(script, async (atrium) => {
    result = await runCli(
      argv,
      agentPodEnv(home, atrium.url, { ...FAST, ACPX_CALL_HOME_ANSWER_TIMEOUT_MS: "600" }),
    );
  });
  assert.ok(result);
  return result;
}

test("F-1b: the unknown line advises a repeat ONLY for a create; every other class says it is unknown whether it ran", async () => {
  const create = await unknownText(["sessions", "new", "--name", "c"]);
  assert.match(create.stderr, /Repeat exactly this command/u);
  assert.match(create.stderr, /nothing twice/u);

  const refresh = await unknownText(["box", "refresh"]);
  assert.equal(refresh.status, 1);
  assert.doesNotMatch(refresh.stderr, /Repeat exactly/u);
  assert.match(refresh.stderr, /it is unknown whether the command ran/u);
  assert.match(refresh.stderr, /runtime-status record \/data\/runtime\/runtime-status\.v1/u);
  assert.match(refresh.stderr, /do not simply run it again/u);

  const store = await unknownText(["seats", "rename", "11111111-1111-4111-8111-111111111111", "x"]);
  assert.doesNotMatch(store.stderr, /Repeat exactly/u);
  assert.match(store.stderr, /unknown whether the command ran/u);
  assert.match(store.stderr, /not de-duplicated/u);

  const handover = await unknownText(["sessions", "handover", "--brief", "/workspace/b.md"]);
  assert.doesNotMatch(handover.stderr, /Repeat exactly/u);
  assert.match(handover.stderr, /could create a second successor/u);
});

test("F-1b: checkAdvice names the runtime-status path from the caller's own environment when it has one", () => {
  const advice = checkAdvice("box refresh", { NV_RUNTIME_STATUS_FILE: "/x/status" });
  assert.equal(advice.kind, "check");
  assert.match(advice.kind === "check" ? advice.how : "", /\/x\/status/u);
});

// ─── F-2: Retry-After is clamped ─────────────────────────────────────────────────────────────────

test("F-2: Retry-After is clamped to [1, 30] s; 0, negative and garbage are the default 5 s", () => {
  assert.equal(clampRetryAfterS(0), 5);
  assert.equal(clampRetryAfterS(-3), 5);
  assert.equal(clampRetryAfterS(Number.NaN), 5);
  assert.equal(clampRetryAfterS(Number.POSITIVE_INFINITY), 5);
  assert.equal(clampRetryAfterS(0.2), 1, "a fraction is floored to the minimum");
  assert.equal(clampRetryAfterS(7), 7, "a sane value is honoured");
  assert.equal(clampRetryAfterS(30), 30);
  assert.equal(clampRetryAfterS(3600), 30, "a long value is capped");
});

test("F-2: a 503 with Retry-After 0 does not hot-loop: the whole 600 s budget costs ≤ 121 attempts", async () => {
  let t = 0;
  let attempts = 0;
  const outcome = await callHome({
    send: async () => {
      attempts += 1;
      return { kind: "response", status: 503, body: {}, retryAfterS: 0 };
    },
    now: () => t,
    sleep: async (ms) => {
      assert.ok(ms >= 1000, `slept ${ms} ms`);
      t += ms;
    },
    env: {},
  });
  assert.equal(outcome.kind, "away");
  assert.ok(attempts <= 121 && attempts >= 100, `${attempts} attempts`);
  // Garbage from the wire (NaN) behaves the same; a header the reader could not parse is not "no header".
  let n = 0;
  const garbage = await callHome({
    send: async () => ({ kind: "response", status: 503, body: {}, retryAfterS: Number.NaN }),
    now: () => n,
    sleep: async (ms) => {
      assert.equal(ms, 5000);
      n += ms;
    },
    budgetMs: 20_000,
    env: {},
  });
  assert.equal(garbage.kind, "away");
});

test("F-2: through the real exchange a 'Retry-After: 0' header reaches the clamp as 0, and 'soon' as NaN", async () => {
  const { atriumRequest } = await import("../src/pod/atrium-exchange.js");
  for (const [header, check] of [
    ["0", (v: number | undefined) => v === 0],
    ["soon", (v: number | undefined) => v !== undefined && Number.isNaN(v)],
  ] as const) {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { "retry-after": header });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const exchange = await atriumRequest({ method: "GET", url: `http://127.0.0.1:${port}/` });
    server.close();
    assert.equal(exchange.kind, "response");
    assert.ok(exchange.kind === "response" && check(exchange.retryAfterS), header);
  }
});

// ─── F-3 / F-4: real paths, operands ─────────────────────────────────────────────────────────────

function input(argv: string[], over: Partial<PassThroughInput> = {}): PassThroughInput {
  let n = 0;
  const c = classifyArgv(argv, { builtInAgents: BUILT_IN });
  return {
    argv,
    commandPath: c.kind === "classified" ? c.path : "",
    commandClass: c.kind === "classified" ? c.class : "create",
    operandIndexes: c.kind === "classified" ? c.operandIndexes : [],
    env: {},
    cwd: "/workspace/projects/x",
    readFile: (file) => Buffer.from(`file:${file}`),
    readStdin: () => Buffer.from("from-stdin"),
    // a stand-in file system: nothing is a symlink unless the row says so
    realpath: (p) => p,
    mintId: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`,
    ...over,
  };
}

const refusedAs = (reason: string) => (error: unknown) =>
  error instanceof PassThroughUsageError && error.reason === reason;

test("F-3: a symlink under /workspace that points to /tmp is refused — --brief, --os and set-os (negative), the same path unlinked passes", () => {
  const realpath = (p: string) =>
    p.startsWith("/workspace/link") ? p.replace("/workspace/link", "/tmp/elsewhere") : p;
  assert.throws(
    () =>
      buildPassThroughCall(
        input(["sessions", "handover", "--brief", "/workspace/link/b.md"], { realpath }),
      ),
    refusedAs("brief_not_shared"),
  );
  assert.throws(
    () =>
      buildPassThroughCall(input(["sessions", "new", "--os", "/workspace/link/os"], { realpath })),
    refusedAs("os_not_shared"),
  );
  assert.throws(
    () =>
      buildPassThroughCall(input(["sessions", "set-os", "S", "/workspace/link/os"], { realpath })),
    refusedAs("os_not_shared"),
  );
  // The near-miss: the same shape with no symlink is accepted.
  const ok = buildPassThroughCall(
    input(["sessions", "handover", "--brief", "/workspace/plain/b.md"], { realpath }),
  );
  assert.deepEqual(ok.body.argv, ["sessions", "handover", "--brief", "/workspace/plain/b.md"]);
});

test("F-3: realPathOf follows a REAL symlink, also for a path that does not exist yet (deepest existing ancestor)", () => {
  const root = fs.realpathSync(tmpDir("acpx-a3-real-"));
  const inside = path.join(root, "shared");
  const outside = fs.realpathSync(tmpDir("acpx-a3-outside-"));
  fs.mkdirSync(inside);
  fs.symlinkSync(outside, path.join(inside, "link-out"));
  fs.writeFileSync(path.join(inside, "ok.md"), "x");
  assert.equal(realPathOf(path.join(inside, "link-out", "new.md")), path.join(outside, "new.md"));
  assert.equal(
    underSharedRoot(path.join(inside, "link-out", "new.md"), [inside]),
    false,
    "escapes",
  );
  assert.equal(underSharedRoot(path.join(inside, "ok.md"), [inside]), true, "positive control");
  assert.equal(
    underSharedRoot(path.join(inside, "not-yet", "b.md"), [inside]),
    true,
    "absent file under the root",
  );
});

test("F-4: `sessions import <archive>` travels as '-' + stdin_b64 (relative path, read in the CALLER's pod), --record-id and --created-by-call forwarded", () => {
  const call = buildPassThroughCall(
    input(["sessions", "import", "fx/x.tar", "--cwd", "/workspace"]),
  );
  const argv = call.body.argv as string[];
  assert.deepEqual(argv.slice(0, 3), ["sessions", "import", "-"]);
  assert.equal(argv.includes("fx/x.tar"), false, "the path does not travel");
  assert.equal(
    Buffer.from(call.body.stdin_b64 as string, "base64").toString(),
    "file:/workspace/projects/x/fx/x.tar",
  );
  assert.ok(argv.includes("--record-id") && argv.includes("--created-by-call"));
  // Under an agent prefix and with a global flag first, the operand is still found by its index.
  const agent = buildPassThroughCall(
    input(["--format", "json", "claude", "sessions", "import", "a.tar"]),
  );
  assert.equal((agent.body.argv as string[])[5], "-");
  assert.equal(
    Buffer.from(agent.body.stdin_b64 as string, "base64").toString(),
    "file:/workspace/projects/x/a.tar",
  );
  // Negative: another operand of another command is untouched.
  const store = buildPassThroughCall(input(["sessions", "show", "a.tar"]));
  assert.equal((store.body.argv as string[])[2], "a.tar");
});

test("F-4: `--os` / `set-os <choice>` become absolute and must lie under /workspace or /opt/atrium-os; `default` and '' are not paths", () => {
  const rel = buildPassThroughCall(input(["sessions", "new", "--os", "os/wt"]));
  assert.equal((rel.body.argv as string[])[3], "/workspace/projects/x/os/wt");
  const inline = buildPassThroughCall(input(["sessions", "new", "--os=os/wt"]));
  assert.equal((inline.body.argv as string[])[2], "--os=/workspace/projects/x/os/wt");
  const setOs = buildPassThroughCall(input(["sessions", "set-os", "S", "os/wt"]));
  assert.deepEqual(setOs.body.argv, ["sessions", "set-os", "S", "/workspace/projects/x/os/wt"]);
  assert.equal(
    (buildPassThroughCall(input(["sessions", "set-os", "S", "default"])).body.argv as string[])[3],
    "default",
  );
  assert.equal(
    (buildPassThroughCall(input(["sessions", "new", "--os", "default"])).body.argv as string[])[3],
    "default",
  );
  assert.equal(
    (buildPassThroughCall(input(["sessions", "set-os", "S", ""])).body.argv as string[])[3],
    "",
  );
  const atriumOs = buildPassThroughCall(
    input(["sessions", "set-os", "S", "/opt/atrium-os/releases/x"]),
  );
  assert.equal((atriumOs.body.argv as string[])[3], "/opt/atrium-os/releases/x");
  for (const bad of ["/tmp/os", "/home/node/os", "/workspace/../tmp/os", "/wisdom/os"]) {
    assert.throws(
      () => buildPassThroughCall(input(["sessions", "set-os", "S", bad])),
      refusedAs("os_not_shared"),
      bad,
    );
  }
});

test("F-4: the classifier says where each operand sits in the argv (the rewrite depends on it)", () => {
  const at = (argv: string[]) => {
    const c = classifyArgv(argv, { builtInAgents: BUILT_IN });
    return c.kind === "classified" ? c.operandIndexes : "unclassified";
  };
  assert.deepEqual(at(["sessions", "import", "a.tar"]), [2]);
  assert.deepEqual(at(["sessions", "import", "a.tar", "--record-id", "r"]), [2]);
  assert.deepEqual(at(["sessions", "import", "--record-id", "r", "a.tar"]), [4]);
  assert.deepEqual(at(["claude", "sessions", "import", "a.tar"]), [3]);
  assert.deepEqual(at(["--format", "json", "sessions", "set-os", "S", "C"]), [4, 5]);
  assert.deepEqual(at(["sessions", "set-os", "--dry-run", "S", "C"]), [3, 4]);
  assert.deepEqual(at(["sessions", "set-os", "S", "--", "-weird"]), [2, 4]);
});

// ─── the discovery, extended to operands and to flags named by what they ARE ────────────────────

function fakeConfig(): ResolvedAcpxConfig {
  return {
    defaultAgent: "codex",
    defaultPermissions: "approve-all",
    nonInteractivePermissions: "deny",
    authPolicy: "skip",
    ttlMs: 900_000,
    queueMaxDepth: 16,
    format: "text",
    agents: {},
    auth: {},
    disableExec: false,
    mcpServers: [],
    subscriptions: { version: 3, subscriptions: [], profiles: [] },
    globalPath: "/tmp/acpx-test-config.json",
    projectPath: "/tmp/.acpx-test.json",
    hasGlobalConfig: false,
    hasProjectConfig: false,
  } as unknown as ResolvedAcpxConfig;
}

/** Every commander leaf with its path, as `registerDefaultCommands` registers it. */
function leaves(): Array<{ path: string; command: Command }> {
  const program = new Command();
  registerDefaultCommands(program, fakeConfig());
  const out: Array<{ path: string; command: Command }> = [];
  const walk = (command: Command, prefix: string[]) => {
    for (const child of command.commands) {
      const next = [...prefix, child.name()];
      out.push({ path: next.join(" "), command: child });
      walk(child, next);
    }
  };
  walk(program, []);
  return out;
}

const PASSABLE = new Set(["create", "control-store", "record", "owner-if-pod"]);
const PATHISH = /\b(file|path|dir|directory|archive|root|manifest)\b/iu;

/**
 * Operands and options of a PASSED-THROUGH command that name a file or a path — found by their
 * registered name or description, not by a hand list — and not decided. An operand or flag whose
 * argument is not a path says so here, with its reason.
 */
const EXEMPT_OPERANDS: Readonly<Record<string, string>> = {
  "transcripts restore":
    "an exit-tail file in the control pod's own transcript store: operator maintenance, the path as given",
  "sessions export": "class read, never passed",
  "flow run": "class local, never passed",
};

/**
 * THE predicates of the discovery — the discovery row and its "bites" row both call these two
 * functions, so the negative case cannot test a copy (R2-N2).
 */
function undecidedOperands(commandPath: string, command: Command): string[] {
  return command.registeredArguments.flatMap((arg, n) => {
    const pathish =
      PATHISH.test(arg.name()) || PATHISH.test(arg.description) || arg.name() === "choice";
    const decided =
      PATH_OPERAND_RULES[commandPath]?.[n] !== undefined || commandPath in EXEMPT_OPERANDS;
    return pathish && !decided ? [`${commandPath} <${arg.name()}> (operand ${n})`] : [];
  });
}

/** Flags are decided PER COMMAND (`<path> <flag>`): one command's exemption never covers another's (R2-N3). */
function undecidedFlags(commandPath: string, command: Command): string[] {
  return command.options.flatMap((option) => {
    const flag = option.long;
    const takesValue = option.required || option.optional;
    const pathish =
      flag !== undefined && takesValue && /<[^>]*(file|path|dir)/iu.test(option.flags);
    return flag !== undefined &&
      pathish &&
      !(flag in PATH_FLAG_RULES) &&
      !(`${commandPath} ${flag}` in VERBATIM_FLAGS)
      ? [`${commandPath} ${flag}`]
      : [];
  });
}

test("no passed-through command grows an UNDECIDED file/path-valued operand or flag (discovering, from commander itself)", () => {
  const undecided: string[] = [];
  for (const { path: commandPath, command } of leaves()) {
    const entry = COMMAND_TABLE[commandPath];
    if (entry && PASSABLE.has(entry.class)) {
      undecided.push(
        ...undecidedOperands(commandPath, command),
        ...undecidedFlags(commandPath, command),
      );
    }
  }
  assert.deepEqual(
    undecided,
    [],
    "decide how each travels (pass-through-args.ts: PATH_FLAG_RULES / PATH_OPERAND_RULES) or list it with its reason",
  );
});

/** Path-valued flags that travel verbatim: the control pod's own operator paths, or never passed. */
const VERBATIM_FLAGS: Readonly<Record<string, string>> = {
  // key: "<command path> <flag>"
  "sessions repair-account-seam --backup-dir":
    "sessions repair-account-seam: an operator's directory on the control pod",
  "sessions archive --exclude-ids":
    "sessions archive: the scheduler's file on the control pod (control-pod only)",
  "sessions archive --manifest-out": "sessions archive: control-pod only",
  "sessions archive --cat": "sessions archive: control-pod only",
  "agent-folders migrate --pool":
    "agent-folders migrate: an operator's pool directory on the control pod",
  "agent-folders migrate --sessions-dir":
    "agent-folders migrate: an operator's directory on the control pod",
  "transcripts dedup --manifest":
    "transcripts dedup: an operator's manifest file on the control pod",
  "sessions list --filter-cwd": "sessions list: a filter value, not a file",
  "sessions export --output": "sessions export: class read, never passed",
  "flow run --input-file": "flow run: local, never passed",
  "prompt --batch-file": "prompt: atrium's own delivery, refused by the message-route branch",
};

test("the discovery bites: a fresh path-valued operand and flag, registered here, in no table, are flagged by THE discovery's own predicates", () => {
  const program = new Command();
  const fresh = program
    .command("fresh-create")
    .argument("<archive-path>", "an archive")
    .option("--bundle <file>", "a bundle file");
  assert.deepEqual(
    [...undecidedOperands("fresh-create", fresh), ...undecidedFlags("fresh-create", fresh)],
    ["fresh-create <archive-path> (operand 0)", "fresh-create --bundle"],
  );
});

test("R2-N3: a verbatim exemption is per command — `sessions archive --manifest-out` does not decide another command's", () => {
  assert.ok("sessions archive --manifest-out" in VERBATIM_FLAGS);
  assert.ok("--to" in PATH_FLAG_RULES, "--to is a decided path flag, not an exemption");
  const program = new Command();
  const other = program.command("restore").option("--manifest-out <path>", "write here");
  assert.deepEqual(undecidedFlags("fresh-command", other), ["fresh-command --manifest-out"]);
  assert.deepEqual(undecidedFlags("sessions archive", other), []);
});

test("O-4: a 600 s wait prints a progress line every 30 s (attempt count, seconds left), never more often", async () => {
  let t = 0;
  const lines: WaitInfo[] = [];
  await callHome({
    send: async () => ({ kind: "response", status: 503, body: {}, retryAfterS: 5 }),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    onWait: (info) => lines.push(info),
    env: {},
  });
  assert.ok(lines.length >= 19 && lines.length <= 21, `${lines.length} progress lines in 600 s`);
  for (let i = 1; i < lines.length; i += 1) {
    assert.ok(
      (lines[i]?.elapsedMs ?? 0) - (lines[i - 1]?.elapsedMs ?? 0) >= 30_000,
      "≥ 30 s apart",
    );
  }
  assert.match(
    waitingLine({ attempts: 7, elapsedMs: 35_000, remainingMs: 565_000 }),
    /attempt 7, 565 s of the 600 s call-home budget left/u,
  );
  // Negative: the progress knob compresses the interval only under NODE_TEST_CONTEXT.
  for (const [context, max] of [
    ["", 21],
    ["child", 2000],
  ] as const) {
    let u = 0;
    let count = 0;
    await callHome({
      send: async () => ({ kind: "response", status: 503, body: {}, retryAfterS: 5 }),
      now: () => u,
      sleep: async (ms) => {
        u += ms;
      },
      onWait: () => (count += 1),
      env: { ACPX_CALL_HOME_PROGRESS_MS: "1", NODE_TEST_CONTEXT: context },
    });
    assert.ok(
      count <= max && (context === "" || count > 21),
      `context '${context}': ${count} lines`,
    );
  }
  // And with no onWait there is silence by construction: nothing to call.
  let v = 0;
  await callHome({
    send: async () => ({ kind: "connect-failure", reason: "x" }),
    now: () => v,
    sleep: async (ms) => {
      v += ms;
    },
    env: {},
  });
});

test("O-4: the CLI prints the progress line on stderr during the wait — and nothing under --json-strict", async () => {
  const { home } = agentPodHome();
  await withAtrium({ phases: [{ mode: "away" }] }, async (atrium) => {
    const env = agentPodEnv(home, atrium.url, {
      ACPX_CALL_HOME_BUDGET_MS: "1500",
      ACPX_CALL_HOME_RETRY_MS: "100",
      ACPX_CALL_HOME_PROGRESS_MS: "300",
    });
    const text = await runCli(["sessions", "new", "--name", "c"], env);
    assert.equal(text.status, 75);
    assert.match(
      text.stderr,
      /^\[acpx\] still waiting for atrium \(attempt \d+, \d+ s of the \d+ s call-home budget left\)/mu,
    );
    const strict = await runCli(
      ["--json-strict", "--format", "json", "sessions", "new", "--name", "c"],
      env,
    );
    assert.equal(strict.status, 75);
    assert.equal(strict.stderr, "", "json-strict: machine-clean stderr");
  });
});

// ─── A-24: the client owns the ids; atrium answers 400 call-id-mismatch when they differ ─────────

test("A-24: every create sends call_id == its --created-by-call, with --record-id, in argv (atrium passes argv unchanged)", () => {
  for (const argv of [
    ["sessions", "new", "--name", "x"],
    ["sessions", "copy", "--from", "S"],
    ["sessions", "import", "a.tar"],
  ]) {
    const call = buildPassThroughCall(input(argv));
    const wire = call.body.argv as string[];
    assert.equal(wire[wire.indexOf("--created-by-call") + 1], call.body.call_id, argv.join(" "));
    assert.match(wire[wire.indexOf("--record-id") + 1] ?? "", UUID, argv.join(" "));
  }
  // A caller-given created-by call is the call_id too (not a second, different id).
  const given = "eeeeeeee-0000-4000-8000-0000000000e1";
  const call = buildPassThroughCall(input(["sessions", "new", "--created-by-call", given]));
  assert.equal(call.body.call_id, given);
});

test("A-24: a 400 call-id-mismatch is pass_through_refused, exit 2, ONE request — never retried", async () => {
  const { home } = agentPodHome();
  await withAtrium(
    { calls: [{ answer: { status: 400, body: { error: "call-id-mismatch" } } }] },
    async (atrium) => {
      const r = await runCli(
        ["sessions", "new", "--name", "c"],
        agentPodEnv(home, atrium.url, FAST),
      );
      assert.equal(r.status, 2, r.stderr);
      assert.match(
        r.stderr.split("\n")[0] ?? "",
        /^acpx: REFUSED reason=pass_through_refused nothing_started=true protocol=1 status=400 error=call-id-mismatch$/u,
      );
      assert.equal(atrium.requests.filter((q) => q.route === "call").length, 1, "not retried");
    },
  );
});

// ─── R2-F5, R2-F3b, O-1 ──────────────────────────────────────────────────────────────────────────

test("R2-F5: after a wait over 30 s the FIRST `acpx:` line on stderr is the C7.2 token; progress lines start with [acpx]", async () => {
  const { home } = agentPodHome();
  await withAtrium({ phases: [{ mode: "away" }] }, async (atrium) => {
    const r = await runCli(
      ["sessions", "new", "--name", "c"],
      agentPodEnv(home, atrium.url, {
        ACPX_CALL_HOME_BUDGET_MS: "1500",
        ACPX_CALL_HOME_RETRY_MS: "100",
        ACPX_CALL_HOME_PROGRESS_MS: "300",
      }),
    );
    assert.equal(r.status, 75);
    const lines = r.stderr.split("\n");
    assert.ok(
      lines.some((l) => l.startsWith("[acpx] still waiting")),
      "a progress line was printed",
    );
    assert.match(
      lines.find((l) => l.startsWith("acpx:")) ?? "",
      /^acpx: REFUSED reason=atrium_away nothing_started=true/u,
    );
    assert.equal(lines.filter((l) => l.startsWith("acpx: still")).length, 0);
  });
  assert.ok(!waitingLine({ attempts: 1, elapsedMs: 0, remainingMs: 1000 }).startsWith("acpx:"));
});

test("R2-F3b: a DANGLING symlink under /workspace that points outside is refused; one that points inside passes", () => {
  const root = fs.realpathSync(tmpDir("acpx-a3-dangling-"));
  const outside = fs.realpathSync(tmpDir("acpx-a3-out-"));
  fs.symlinkSync(path.join(outside, "not-yet"), path.join(root, "dangling-out"));
  fs.symlinkSync(path.join(root, "also-not-yet"), path.join(root, "dangling-in"));
  assert.equal(
    underSharedRoot(path.join(root, "dangling-out"), [root]),
    false,
    "leaves through a dangling link",
  );
  assert.equal(underSharedRoot(path.join(root, "dangling-out", "b.md"), [root]), false);
  assert.equal(
    underSharedRoot(path.join(root, "dangling-in", "b.md"), [root]),
    true,
    "positive control",
  );
  assert.equal(realPathOf(path.join(root, "dangling-out")), path.join(outside, "not-yet"));
  // The same through a two-link chain.
  fs.symlinkSync(path.join(root, "dangling-out"), path.join(root, "chain"));
  assert.equal(underSharedRoot(path.join(root, "chain"), [root]), false);
});

test("O-1: the --batch-file / --message-id scan stops at `--`: words after it are prompt text and route as a prompt", async () => {
  const { home } = agentPodHome();
  const other = "cccccccc-0000-4000-8000-000000000a99";
  const { addRecord } = await import("./pod-a3-helpers.js");
  await addRecord(home, other, "dddddddd-5555-4666-8777-888888888888");
  await withAtrium({}, async (atrium) => {
    const env = agentPodEnv(home, atrium.url, FAST);
    const routed = await runCli(
      ["prompt", "--session-id", other, "--no-wait", "--", "--batch-file", "x"],
      env,
    );
    assert.equal(routed.status, 0, routed.stderr);
    assert.equal(atrium.requests.filter((q) => q.route === "session_message").length, 1);
    // Negative: the same option BEFORE `--` is still refused.
    const refused = await runCli(
      ["prompt", "--session-id", other, "--no-wait", "--batch-file", "x", "--", "hi"],
      env,
    );
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /prompt_option_not_routable/u);
  });
});

// ─── --to: a write destination the caller must not choose on the control pod ─────────────────────

test("a pod-side `transcripts restore --to /tmp/x` is refused path_not_shared, NOTHING sent; `sessions archive --to` likewise", async () => {
  const { home } = agentPodHome();
  await withAtrium({}, async (atrium) => {
    const env = agentPodEnv(home, atrium.url, FAST);
    for (const argv of [
      ["transcripts", "restore", "x.exit-tail-2026.acpx", "--to", "/tmp/x"],
      ["transcripts", "restore", "x.exit-tail-2026.acpx", "--to=/tmp/x"],
      ["transcripts", "restore", "x.exit-tail-2026.acpx", "--to", "/workspace/../tmp/x"],
      ["sessions", "archive", "--ids", "a", "--apply", "--to", "/tmp/x"],
    ]) {
      const r = await runCli(argv, env);
      assert.equal(r.status, 2, `${argv.join(" ")}: ${r.stderr}`);
      assert.equal(
        r.stderr.split("\n")[0],
        "acpx: REFUSED reason=path_not_shared nothing_started=true protocol=1",
        argv.join(" "),
      );
    }
    assert.equal(atrium.requests.length, 0, "not one request");
    // Near-miss: under /workspace it is made absolute and passes through.
    const ok = await runCli(
      ["transcripts", "restore", "x.exit-tail-2026.acpx", "--to", "/workspace/out/x"],
      env,
    );
    assert.equal(ok.status, 0, ok.stderr);
    const call = atrium.requests.find((q) => q.route === "call");
    assert.deepEqual((call?.body?.argv as string[] | undefined)?.slice(-2), [
      "--to",
      "/workspace/out/x",
    ]);
  });
});
