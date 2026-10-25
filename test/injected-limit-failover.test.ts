// brick 901ecf75 — a subscription limit that rejects a mid-turn INJECTED prompt must fail the
// session over, exactly as one that rejects the turn's own prompt does.
//
// The defect (session 087544e1, devbox, 2026-10-13): a message from another agent was injected
// into a running turn as a second `session/prompt`. claude-agent-acp HANDED THE TURN OVER — the
// turn's own prompt resolved `end_turn` with no output — and the injected prompt then failed with
// "You've hit your weekly limit". The owner wrote that delivery `failed` and the turn `idle`; the
// main-turn failover never ran, because the turn's own prompt had "succeeded". The session sat
// still until a human re-prompted it (39 such occurrences on devbox in 30 days, f4615352 sweep).
//
// ⚠️ WHY REAL PROCESSES. The failover retry builds a FRESH adapter client from the switched record
// (new CLAUDE_CONFIG_DIR), so the observable is a second adapter process serving the message.
// Every row runs the real CLI, a real queue owner and the mock adapter launched from a
// `claude-agent-acp/` path (so the Claude seams — injection awaited, handover — engage as in
// production). The mock refuses `weekly-limited-on /dflt` only on the `dflt` subscription's
// adapter, so "served on another subscription" in the stream proves where the retry ran.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { scopeHarnessConfigDirRootForCli } from "./config-dir-root-isolation.js";
import { removeTempHome } from "./temp-home.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const WAIT_MS = 20_000;
const WEEKLY_LIMIT_MESSAGE =
  "Internal error: You've hit your weekly limit · resets Oct 14, 7pm (UTC)";

type CliRunResult = { code: number | null; stdout: string; stderr: string };

// Per-subscription answer of the usage probe failover consults before picking a sibling.
type ProbeTable = Record<string, { status: number; fiveHour?: string }>;

const HEALTHY_TARGET: ProbeTable = {
  "token-dflt": { status: 200, fiveHour: "0.95" },
  "token-target": { status: 200, fiveHour: "0.1" },
};
// No usable sibling: failover must end in all-subscriptions-exhausted.
const EXHAUSTED: ProbeTable = {
  "token-dflt": { status: 200, fiveHour: "1" },
  "token-target": { status: 401 },
};

type Rig = {
  homeDir: string;
  cwd: string;
  subsDir: string;
  cli: (args: string[]) => Promise<CliRunResult>;
};

function startProbeServer(table: ProbeTable): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
      const outcome = table[token];
      if (outcome === undefined || outcome.status !== 200) {
        response.writeHead(outcome?.status ?? 500).end("{}");
        return;
      }
      response
        .writeHead(200, {
          "anthropic-ratelimit-unified-5h-utilization": outcome.fiveHour ?? "0.1",
          "anthropic-ratelimit-unified-7d-utilization": "0.1",
          "anthropic-ratelimit-unified-7d-reset": "1893456000",
        })
        .end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      resolve({ server, url: `http://127.0.0.1:${address.port}/v1/messages` });
    });
  });
}

function cliEnv(homeDir: string, probeUrl: string, args: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    ACPX_STATE_HOME: homeDir,
    ACPX_NO_CATALOGUE_WARM: "1",
    CLAUDE_MESSAGES_ENDPOINT: probeUrl,
  };
  for (const key of Object.keys(env)) {
    // The launching agent's own session/subscription identity must not reach the rig: an
    // inherited parent subscription would pin the child and hide the switch.
    if (
      key.startsWith("ACPX_SESSION_") ||
      key.startsWith("ACPX_PARENT_") ||
      key.startsWith("ACPX_EFFECTIVE_") ||
      key.startsWith("ACPX_SEAT") ||
      key.startsWith("ACPX_BRICK") ||
      key === "ACPX_SUBSCRIPTION" ||
      key === "ACPX_SUBSCRIPTION_AUTO_SELECT" ||
      key === "ACPX_OWNER_LOG" ||
      key === "ACPX_TASK_FOLDER" ||
      key === "CLAUDE_CONFIG_DIR"
    ) {
      delete env[key];
    }
  }
  scopeHarnessConfigDirRootForCli(args, env, homeDir);
  return env;
}

async function runCli(
  homeDir: string,
  cwd: string,
  probeUrl: string,
  args: string[],
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: cliEnv(homeDir, probeUrl, args),
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withRig(table: ProbeTable, run: (rig: Rig) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-injected-limit-"));
  const { server, url } = await startProbeServer(table);
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const adapterDir = path.join(homeDir, "claude-agent-acp", "dist");
    await fs.mkdir(adapterDir, { recursive: true });
    const adapterPath = path.join(adapterDir, "index.js");
    await fs.symlink(MOCK_AGENT_PATH, adapterPath);
    const command = `node ${adapterPath} --claude-agent-acp --supports-load-session`;
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { claude: { command } } }, null, 2)}\n`,
    );
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    for (const id of ["dflt", "target"]) {
      await fs.mkdir(path.join(subsDir, id), { recursive: true });
      await fs.writeFile(
        path.join(subsDir, id, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: `token-${id}` } }),
      );
    }
    await fs.writeFile(
      path.join(subsDir, "registry.json"),
      JSON.stringify({
        version: 3,
        default: "dflt",
        profiles: ["dflt", "target"].map((id) => ({
          id,
          label: id,
          authMode: "subscription",
          adapter: "claude",
          account: `${id}-account`,
          credentialSource: path.join(subsDir, id),
        })),
      }),
      { mode: 0o600 },
    );
    await run({
      homeDir,
      cwd,
      subsDir,
      cli: async (args) => await runCli(homeDir, cwd, url, args),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempHome(homeDir);
  }
}

function sessionFile(rig: Rig, id: string, suffix: string): string {
  return path.join(rig.homeDir, ".acpx", "sessions", `${encodeURIComponent(id)}${suffix}`);
}

async function readText(file: string): Promise<string> {
  return await fs.readFile(file, "utf8").catch(() => "");
}

// On-disk shape: snake_case, options under `.acpx` (acpx PROJECT.md).
type RecordView = {
  acp_session_id: string;
  messages?: unknown[];
  acpx?: {
    session_options?: {
      profile?: string;
      account_switch?: { reason?: string; toProfile?: string };
    };
  };
};

async function readRecord(rig: Rig, id: string): Promise<RecordView> {
  return JSON.parse(await fs.readFile(sessionFile(rig, id, ".json"), "utf8")) as RecordView;
}

type Frame = {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  error?: { message?: string };
};

async function readFrames(rig: Rig, id: string): Promise<Frame[]> {
  return (await readText(sessionFile(rig, id, ".stream.ndjson")))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Frame);
}

function deliveryFrames(frames: Frame[], messageId: string): Record<string, unknown>[] {
  return frames
    .filter((frame) => frame.method === "acpx/delivery" && frame.params?.messageId === messageId)
    .map((frame) => frame.params ?? {});
}

function promptFramesWithText(frames: Frame[], text: string): Frame[] {
  return frames.filter(
    (frame) => frame.method === "session/prompt" && JSON.stringify(frame.params).includes(text),
  );
}

function isTerminalPhase(phase: unknown): boolean {
  return phase === "done" || phase === "failed" || phase === "cancelled";
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  diagnose: () => Promise<string>,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new assert.AssertionError({
    message: `timed out waiting for ${what}\n${await diagnose()}`,
  });
}

async function diagnose(rig: Rig, id: string): Promise<string> {
  const record = await readRecord(rig, id).catch(() => undefined);
  return [
    `session_options=${JSON.stringify(record?.acpx?.session_options)}`,
    `owner.log:\n${await readText(sessionFile(rig, id, ".owner.log"))}`,
    `stream (methods/errors):\n${(await readFrames(rig, id))
      .map((frame) =>
        frame.method === "acpx/delivery" || frame.method === "acpx/turn"
          ? `${frame.method} ${JSON.stringify(frame.params)}`
          : (frame.method ?? (frame.error ? `error ${frame.error.message}` : "response")),
      )
      .join("\n")}`,
  ].join("\n");
}

// A session on `dflt` with one real turn and the Claude transcript a switch ports (the mock writes
// none, so the row writes it, as the real adapter would have). auto-subscription is OFF so the
// pre-turn selection never moves it: the only switch possible is the failover under test.
async function newSessionOnDefault(
  rig: Rig,
  options: { autoFailover?: boolean } = {},
): Promise<string> {
  const created = await rig.cli(["--format", "json", "claude", "sessions", "new"]);
  assert.equal(created.code, 0, created.stderr);
  const id = String((JSON.parse(created.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId);
  const off = await rig.cli(["claude", "set", "auto-subscription", "off", "--session-id", id]);
  assert.equal(off.code, 0, off.stderr);
  if (options.autoFailover === false) {
    const noFailover = await rig.cli(["claude", "set", "auto-failover", "off", "--session-id", id]);
    assert.equal(noFailover.code, 0, noFailover.stderr);
  }
  const warm = await rig.cli([
    "--approve-all",
    "claude",
    "prompt",
    "--session-id",
    id,
    "echo warm",
  ]);
  assert.equal(warm.code, 0, warm.stderr);
  const record = await readRecord(rig, id);
  assert.equal(record.acpx?.session_options?.profile, "dflt", "the session starts on dflt");
  const transcript = transcriptJsonlPath(
    path.join(rig.subsDir, "dflt"),
    rig.cwd,
    record.acp_session_id,
  );
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, '{"type":"assistant","text":"context"}\n');
  return id;
}

type Injection = { text: string; messageId: string; wait?: boolean };

// Run `mainText` as a turn, inject each message into it while it is in flight, and return the
// main prompt's CLI result plus each waiting injection's.
async function runTurnWithInjections(
  rig: Rig,
  id: string,
  mainText: string,
  injections: Injection[],
): Promise<{ main: CliRunResult; waited: CliRunResult[] }> {
  const activeTurns = async (): Promise<number> =>
    (await readFrames(rig, id)).filter(
      (frame) => frame.method === "acpx/turn" && frame.params?.phase === "active",
    ).length;
  const before = await activeTurns();
  const main = rig.cli(["--approve-all", "claude", "prompt", "--session-id", id, mainText]);
  // Once the turn is active the owner captures every arriving task for injection into it (its
  // mid-turn buffer is drained into the turn the moment the prompt is in flight), so this is
  // early enough. The outbound `session/prompt` frame itself reaches the stream only later.
  await waitFor(
    async () => ((await activeTurns()) > before ? true : undefined),
    `the turn "${mainText}" to start`,
    async () => await diagnose(rig, id),
  );
  const waited: Promise<CliRunResult>[] = [];
  for (const injection of injections) {
    const args = [
      "--approve-all",
      "claude",
      "prompt",
      "--session-id",
      id,
      ...(injection.wait ? [] : ["--no-wait"]),
      "--message-id",
      injection.messageId,
      injection.text,
    ];
    if (injection.wait) {
      waited.push(rig.cli(args));
    } else {
      const queued = await rig.cli(args);
      assert.equal(queued.code, 0, `injection "${injection.text}" was refused: ${queued.stderr}`);
    }
  }
  return { main: await main, waited: await Promise.all(waited) };
}

async function waitForTerminal(
  rig: Rig,
  id: string,
  messageId: string,
): Promise<Record<string, unknown>> {
  return await waitFor(
    async () =>
      deliveryFrames(await readFrames(rig, id), messageId).find((event) =>
        isTerminalPhase(event.phase),
      ),
    `a delivery terminal for ${messageId}`,
    async () => await diagnose(rig, id),
  );
}

// Settles every row on the record's final state: the owner finishes a deferred retry after the
// main caller already returned, so read only once each delivery has its terminal.
async function settledDeliveryPhases(rig: Rig, id: string, messageId: string): Promise<unknown[]> {
  await waitForTerminal(rig, id, messageId);
  // A late second terminal would land right behind the first; give it the chance to.
  await new Promise((resolve) => setTimeout(resolve, 500));
  return deliveryFrames(await readFrames(rig, id), messageId).map((event) => event.phase);
}

// The owner.log as of the owner's turn-boundary recycle line, which a failover always ends in.
//
// ⚠️ DO NOT READ owner.log STRAIGHT AFTER `settledDeliveryPhases` (brick 4fb1e3d3, gate red #1373). The
// delivery `done` is appended DURING the deferred re-run; the re-run's client then closes, then the
// `re-run on target` line is written, then the owner leaves the turn and writes the recycle line
// (`logTurnBoundaryRecycle`) — all AFTER the terminal the row waits on. Under load that tail measured
// up to 1.3 s, past the 500 ms grace, and the row read a log without either line (0 recycle lines
// where 1 was written moments later). The recycle line is the owner's last word: it `break`s out of
// its loop right after, so once it is there no later line can come from this owner and a count is
// final. A missing line still reds (bounded wait); a second one still reds the count.
const OWNER_RECYCLE_LINE = /queue owner recycling session \S+ after turn \(reason=/u;

async function ownerLogAfterRecycle(rig: Rig, id: string): Promise<string> {
  return await waitFor(
    async () => {
      const log = await readText(sessionFile(rig, id, ".owner.log"));
      return OWNER_RECYCLE_LINE.test(log) ? log : undefined;
    },
    "the owner's turn-boundary recycle line",
    async () => await diagnose(rig, id),
  );
}

async function closeSession(rig: Rig, id: string): Promise<void> {
  await rig.cli(["claude", "sessions", "close", id]);
}

// User rows for `messageId` across the conversation: the append-only `.messages.ndjson` log plus
// the record's own not-yet-logged tail (`messages`), which do not overlap.
async function userRowsFor(rig: Rig, id: string, messageId: string): Promise<number> {
  const logged = (await readText(sessionFile(rig, id, ".messages.ndjson")))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
  const tail = (await readRecord(rig, id)).messages ?? [];
  return [...logged, ...tail].filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { User?: { id?: unknown } }).User?.id === messageId,
  ).length;
}

test("a weekly limit on an injected prompt fails the session over and re-runs that message once", async () => {
  await withRig(HEALTHY_TARGET, async (rig) => {
    const id = await newSessionOnDefault(rig);
    try {
      const messageId = randomUUID();
      const text = "weekly-limited-on /dflt";
      const { main } = await runTurnWithInjections(rig, id, "hold-for-injection", [
        { text, messageId },
      ]);
      assert.equal(main.code, 0, `the handed-over turn itself ends cleanly: ${main.stderr}`);

      const phases = await settledDeliveryPhases(rig, id, messageId);
      const frames = await readFrames(rig, id);
      const diagnosis = await diagnose(rig, id);
      assert.ok(
        !phases.includes("failed"),
        `the delivery is never written failed: ${JSON.stringify(phases)}\n${diagnosis}`,
      );
      assert.equal(phases.filter(isTerminalPhase).length, 1, "exactly one terminal");
      assert.equal(phases.at(-1), "done", diagnosis);
      const terminal = deliveryFrames(frames, messageId).at(-1);
      assert.equal(terminal?.stopReason, "end_turn");

      // The limit really was hit first, with the production error, on dflt…
      assert.ok(
        frames.some((frame) => frame.error?.message === WEEKLY_LIMIT_MESSAGE),
        "the adapter refused the injected prompt with the weekly-limit error",
      );
      // …the message was sent exactly twice — the refused injection, then ONE retry…
      assert.equal(promptFramesWithText(frames, text).length, 2, diagnosis);
      // …and that retry ran on target: only target's adapter serves it.
      assert.ok(
        JSON.stringify(frames).includes(`served on another subscription: ${text}`),
        `the retry was served on target\n${diagnosis}`,
      );
      const activeSubscriptions = frames
        .filter((frame) => frame.method === "acpx/turn" && frame.params?.phase === "active")
        .map((frame) => frame.params?.subscription);
      assert.equal(
        activeSubscriptions.at(-1),
        "target",
        "the retry turn shows the new subscription",
      );

      const record = await readRecord(rig, id);
      assert.equal(record.acpx?.session_options?.profile, "target", "failover switched");
      assert.equal(record.acpx?.session_options?.account_switch?.reason, "failover");
      assert.equal(await userRowsFor(rig, id, messageId), 1, "one User row for the message");

      const log = await ownerLogAfterRecycle(rig, id);
      assert.match(
        log,
        /failed with a rate_limit error; deferring it to an in-owner subscription failover/u,
      );
      assert.match(
        log,
        /deferred injected prompt for session \S+ \(messageId=\S+\) re-run on target/u,
      );
      assert.match(
        log,
        /queue owner recycling session \S+ after turn \(reason=account-switch; switched to target by failover\)/u,
      );
    } finally {
      await closeSession(rig, id);
    }
  });
});

test("the limit text alone (no data.errorKind) also fails over, and a waiting caller gets the retry's answer", async () => {
  await withRig(HEALTHY_TARGET, async (rig) => {
    const id = await newSessionOnDefault(rig);
    try {
      const messageId = randomUUID();
      const text = "limit-text-only-on /dflt";
      const { waited } = await runTurnWithInjections(rig, id, "hold-for-injection", [
        { text, messageId, wait: true },
      ]);
      const [caller] = waited;
      assert.equal(caller?.code, 0, `the waiting caller got a result: ${caller?.stderr}`);
      assert.match(caller?.stdout ?? "", /served on another subscription: limit-text-only-on/u);

      const phases = await settledDeliveryPhases(rig, id, messageId);
      assert.ok(!phases.includes("failed"), JSON.stringify(phases));
      assert.equal(phases.at(-1), "done");
      const record = await readRecord(rig, id);
      assert.equal(record.acpx?.session_options?.profile, "target");
      assert.equal(record.acpx?.session_options?.account_switch?.reason, "failover");
    } finally {
      await closeSession(rig, id);
    }
  });
});

test("two limit-refused injected messages are each re-run once, in arrival order, after one switch", async () => {
  await withRig(HEALTHY_TARGET, async (rig) => {
    const id = await newSessionOnDefault(rig);
    try {
      // `+hold`: the first is refused only once the second has reached the turn, so both are
      // injected into it (rather than the second queuing as a turn of its own).
      const first = { text: "weekly-limited-on /dflt +hold first", messageId: randomUUID() };
      const second = { text: "weekly-limited-on /dflt second", messageId: randomUUID() };
      await runTurnWithInjections(rig, id, "hold-for-injection", [first, second]);

      for (const injection of [first, second]) {
        const phases = await settledDeliveryPhases(rig, id, injection.messageId);
        assert.ok(!phases.includes("failed"), `${injection.text}: ${JSON.stringify(phases)}`);
        assert.equal(phases.filter(isTerminalPhase).length, 1);
        assert.equal(phases.at(-1), "done");
      }
      const frames = await readFrames(rig, id);
      const diagnosis = await diagnose(rig, id);
      const prompts = frames
        .filter((frame) => frame.method === "session/prompt")
        .map((frame) => JSON.stringify(frame.params));
      const firstSends = prompts.filter((p) => p.includes(first.text));
      const secondSends = prompts.filter((p) => p.includes(second.text));
      assert.equal(firstSends.length, 2, `first: refused + one retry\n${diagnosis}`);
      assert.equal(secondSends.length, 2, `second: refused + one retry\n${diagnosis}`);
      const retryOrder = prompts
        .map((p, index) => ({ p, index }))
        .filter(({ p }) => p.includes(first.text) || p.includes(second.text))
        .slice(2)
        .map(({ p }) => (p.includes(first.text) ? "first" : "second"));
      assert.deepEqual(retryOrder, ["first", "second"], "retried in arrival order");

      const record = await readRecord(rig, id);
      assert.equal(record.acpx?.session_options?.profile, "target");
      const log = await ownerLogAfterRecycle(rig, id);
      assert.equal(
        log.match(/re-run on target after failover/gu)?.length,
        2,
        `both re-run on target\n${diagnosis}`,
      );
    } finally {
      await closeSession(rig, id);
    }
  });
});

test("when the turn's own prompt fails over too, the injected message rides on that one switch", async () => {
  await withRig(HEALTHY_TARGET, async (rig) => {
    const id = await newSessionOnDefault(rig);
    try {
      const injection = { text: "weekly-limited-on /dflt", messageId: randomUUID() };
      const { main } = await runTurnWithInjections(rig, id, "hold-then-limit-on /dflt", [
        injection,
      ]);
      assert.equal(main.code, 0, `the main turn failed over and was served: ${main.stderr}`);

      const phases = await settledDeliveryPhases(rig, id, injection.messageId);
      const frames = await readFrames(rig, id);
      const diagnosis = await diagnose(rig, id);
      assert.ok(!phases.includes("failed"), `${JSON.stringify(phases)}\n${diagnosis}`);
      assert.equal(phases.at(-1), "done");
      assert.equal(promptFramesWithText(frames, injection.text).length, 2, diagnosis);
      assert.ok(
        JSON.stringify(frames).includes(`served on another subscription: ${injection.text}`),
      );
      const record = await readRecord(rig, id);
      assert.equal(record.acpx?.session_options?.profile, "target");
      assert.equal(await userRowsFor(rig, id, injection.messageId), 1, "one User row");
      const log = await ownerLogAfterRecycle(rig, id);
      // One switch: the main turn's. The injected message just ran where the session now was.
      assert.equal(
        log.match(/switched to target by failover/gu)?.length,
        1,
        `exactly one failover recycle\n${diagnosis}`,
      );
    } finally {
      await closeSession(rig, id);
    }
  });
});

test("CONTROL: failover disabled for the session — the injected delivery fails with the original error, no switch", async () => {
  await withRig(HEALTHY_TARGET, async (rig) => {
    const id = await newSessionOnDefault(rig, { autoFailover: false });
    try {
      const messageId = randomUUID();
      const text = "weekly-limited-on /dflt";
      await runTurnWithInjections(rig, id, "hold-for-injection", [{ text, messageId }]);

      const phases = await settledDeliveryPhases(rig, id, messageId);
      assert.deepEqual(phases.filter(isTerminalPhase), ["failed"]);
      const terminal = deliveryFrames(await readFrames(rig, id), messageId).at(-1);
      assert.equal((terminal?.error as { message?: unknown })?.message, WEEKLY_LIMIT_MESSAGE);
      assert.equal(
        promptFramesWithText(await readFrames(rig, id), text).length,
        1,
        "never re-sent",
      );
      const record = await readRecord(rig, id);
      assert.equal(record.acpx?.session_options?.profile, "dflt", "no switch");
      assert.doesNotMatch(await readText(sessionFile(rig, id, ".owner.log")), /deferring it/u);
    } finally {
      await closeSession(rig, id);
    }
  });
});

test("CONTROL: every sibling exhausted — one failed terminal carrying the exhaustion, no retry loop", async () => {
  await withRig(EXHAUSTED, async (rig) => {
    const id = await newSessionOnDefault(rig);
    try {
      const messageId = randomUUID();
      const text = "weekly-limited-on /dflt";
      await runTurnWithInjections(rig, id, "hold-for-injection", [{ text, messageId }]);

      const phases = await settledDeliveryPhases(rig, id, messageId);
      const frames = await readFrames(rig, id);
      const diagnosis = await diagnose(rig, id);
      assert.deepEqual(phases.filter(isTerminalPhase), ["failed"], diagnosis);
      const terminal = deliveryFrames(frames, messageId).at(-1);
      assert.equal(
        (terminal?.error as { detailCode?: unknown })?.detailCode,
        "all-subscriptions-exhausted",
        diagnosis,
      );
      assert.equal(promptFramesWithText(frames, text).length, 1, "no retry was sent anywhere");
      const record = await readRecord(rig, id);
      assert.equal(record.acpx?.session_options?.profile, "dflt", "selection left unchanged");
    } finally {
      await closeSession(rig, id);
    }
  });
});

test("CONTROL: a non-limit error on an injected prompt is terminalized as before, no failover", async () => {
  await withRig(HEALTHY_TARGET, async (rig) => {
    const id = await newSessionOnDefault(rig);
    try {
      const messageId = randomUUID();
      // The mock rejects this with a plain -32603 "Internal error" — not failover-classified.
      const text = "partial-retryable-error";
      await runTurnWithInjections(rig, id, "hold-for-injection", [{ text, messageId }]);

      const phases = await settledDeliveryPhases(rig, id, messageId);
      assert.deepEqual(phases.filter(isTerminalPhase), ["failed"]);
      assert.equal(promptFramesWithText(await readFrames(rig, id), text).length, 1);
      const record = await readRecord(rig, id);
      assert.equal(record.acpx?.session_options?.profile, "dflt");
      assert.doesNotMatch(await readText(sessionFile(rig, id, ".owner.log")), /deferring it/u);
    } finally {
      await closeSession(rig, id);
    }
  });
});
