import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sessionFilePath, withTempHome } from "./runtime-test-helpers.js";

// Brick f74abb05 — `acpx sessions handover --brief <file>` (Daniel, 7f61daf9 DECISION.md item F).
// Every row drives the compiled CLI against an isolated HOME and reads the result back from
// DISK and from the acpx-ui stand-in the delivery is POSTed to — never from the CLI's own echo.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const CLAUDE_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)} --claude-agent-acp --advertise-models --advertise-config-options --advertise-output-style`;

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(
  args: string[],
  homeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_PARENT_SEAT_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
      "ACPX_UI_BASE_URL",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

type Posted = { url: string; body: { text?: string; from?: string } };

/** A stand-in for this box's acpx-ui message route: records every POST, answers 202. */
async function withAcpxUi(run: (origin: string, posted: Posted[]) => Promise<void>): Promise<void> {
  const posted: Posted[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      posted.push({ url: req.url ?? "", body: JSON.parse(raw || "{}") });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ delivery_id: `delivery-${posted.length}`, status: "queued" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, posted);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type Stored = {
  seat_id?: string;
  holder_active?: boolean;
  closed?: boolean;
  cwd?: string;
  agent_command?: string;
  parent_session_id?: string;
  parent_session_url?: string;
  parent_seat_id?: string;
  forked_from_session_id?: string;
  metadata?: Record<string, string>;
  acpx?: {
    session_options?: Record<string, unknown>;
    desired_config_options?: { effort?: unknown };
  };
};

async function readStored(homeDir: string, id: string): Promise<Stored> {
  return JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Stored;
}

async function sessionIds(homeDir: string): Promise<string[]> {
  const files = await fs.readdir(path.join(homeDir, ".acpx", "sessions"));
  return files
    .filter((f) => /^[0-9a-f-]{36}\.json$/.test(f))
    .map((f) => f.slice(0, -5))
    .toSorted();
}

async function rig(homeDir: string): Promise<string> {
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({ agents: { claude: { command: CLAUDE_COMMAND } } })}\n`,
    "utf8",
  );
  const cwd = path.join(homeDir, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  return cwd;
}

function createdId(result: CliResult): string {
  assert.equal(result.code, 0, result.stderr);
  return (JSON.parse(result.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;
}

async function newHolder(homeDir: string, cwd: string, args: string[] = []): Promise<string> {
  return createdId(
    await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "--approve-all",
        "--model",
        "fable",
        "claude",
        "sessions",
        "new",
        ...args,
      ],
      homeDir,
    ),
  );
}

const url = (id: string): string => `https://atrium.example.test/?session=${id}`;

async function writeBrief(homeDir: string, bytes = 2_000): Promise<string> {
  const file = path.join(homeDir, "HANDOVER.md");
  await fs.writeFile(file, `# Handover\n${"x".repeat(Math.max(0, bytes - 11))}`, "utf8");
  return file;
}

async function handover(
  homeDir: string,
  callerId: string,
  origin: string,
  args: string[],
): Promise<CliResult> {
  return await runCli(
    ["--format", "json", "--approve-all", "claude", "sessions", "handover", ...args],
    homeDir,
    {
      ACPX_SESSION_URL: url(callerId),
      ACPX_UI_INTERNAL_URL: origin,
      ACPX_UI_BASE_URL: "https://atrium.example.test",
    },
  );
}

test("F1 a top-level caller: the successor takes its seat with its exact settings, is ACTIVE, gets ONE turn pointing at the brief — and stays top-level", async () => {
  await withTempHome("acpx-handover-top-", async (homeDir) => {
    const cwd = await rig(homeDir);
    const callerId = await newHolder(homeDir, cwd, ["-s", "orchestrator"]);
    const caller = await readStored(homeDir, callerId);
    assert.equal(caller.parent_session_id, undefined);
    const brief = await writeBrief(homeDir);

    await withAcpxUi(async (origin, posted) => {
      const res = await handover(homeDir, callerId, origin, ["--brief", brief]);
      assert.equal(res.code, 0, res.stderr);
      const out = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
      const successorId = String(out.successorId);
      assert.equal(out.seatUrl, `https://atrium.example.test/?seat=${caller.seat_id}`);
      assert.equal(out.predecessorId, callerId);

      const successor = await readStored(homeDir, successorId);
      assert.equal(successor.seat_id, caller.seat_id, "in the caller's seat");
      assert.equal(successor.holder_active, true, "activated");
      assert.equal(successor.acpx?.session_options?.model, "fable", "exact model, Fable included");
      assert.equal(successor.acpx?.session_options?.model_source, "succession");
      assert.equal(successor.agent_command, caller.agent_command);
      assert.equal(successor.cwd, caller.cwd);
      // The top-level trap: ACPX_SESSION_URL names the caller, and the successor is NOT its child.
      assert.equal(successor.parent_session_id, undefined);
      assert.equal(successor.parent_session_url, undefined);
      assert.equal(successor.parent_seat_id, undefined);
      // Never a fork.
      assert.equal(successor.forked_from_session_id, undefined);

      const after = await readStored(homeDir, callerId);
      assert.equal(after.holder_active, false, "the caller is retired");
      assert.notEqual(after.closed, true, "…and NOT closed: that is its own duty");

      assert.equal(posted.length, 1, "exactly one turn is delivered");
      assert.equal(posted[0]?.url, `/api/sessions/${successorId}/message`);
      const text = posted[0]?.body.text ?? "";
      assert.ok(text.startsWith("⟦SEAT-ACTIVATION⟧\n"), text);
      const handoverAt = text.indexOf("⟦HANDOVER⟧\n");
      assert.ok(handoverAt > 0, "the handover prompt follows the activation notice");
      assert.ok(
        text.includes(
          `Your predecessor ${callerId} handed this seat to you and wrote your brief: ${brief}`,
        ),
      );
      assert.ok(text.includes("Read the brief in full before you do anything else."));
    });
  });
});

test("F2 a child caller: the successor keeps the caller's parent and parent seat, not the caller", async () => {
  await withTempHome("acpx-handover-child-", async (homeDir) => {
    const cwd = await rig(homeDir);
    const parentId = await newHolder(homeDir, cwd, ["-s", "parent"]);
    const callerId = createdId(
      await runCli(
        [
          "--cwd",
          cwd,
          "--format",
          "json",
          "--approve-all",
          "--model",
          "opus",
          "claude",
          "sessions",
          "new",
          "-s",
          "child",
        ],
        homeDir,
        { ACPX_SESSION_URL: url(parentId) },
      ),
    );
    const caller = await readStored(homeDir, callerId);
    assert.equal(caller.parent_session_id, parentId);
    assert.ok(caller.parent_seat_id, "fixture: the child records its parent's seat");
    const brief = await writeBrief(homeDir);

    await withAcpxUi(async (origin) => {
      const res = await handover(homeDir, callerId, origin, ["--brief", brief]);
      assert.equal(res.code, 0, res.stderr);
      const successor = await readStored(
        homeDir,
        String(JSON.parse(res.stdout.trim()).successorId),
      );
      assert.equal(successor.parent_session_id, parentId);
      assert.equal(successor.parent_seat_id, caller.parent_seat_id);
      assert.equal(successor.acpx?.session_options?.model, "opus");
    });
  });
});

test("F3 a missing, a directory, or an empty brief is refused — and nothing is created or delivered", async () => {
  await withTempHome("acpx-handover-refuse-", async (homeDir) => {
    const cwd = await rig(homeDir);
    const callerId = await newHolder(homeDir, cwd);
    const empty = path.join(homeDir, "EMPTY.md");
    await fs.writeFile(empty, "  \n", "utf8");
    const before = await sessionIds(homeDir);
    await withAcpxUi(async (origin, posted) => {
      for (const [brief, code] of [
        [path.join(homeDir, "NOPE.md"), "BRIEF_MISSING"],
        [homeDir, "BRIEF_UNREADABLE"],
        [empty, "BRIEF_EMPTY"],
      ] as const) {
        const res = await handover(homeDir, callerId, origin, ["--brief", brief]);
        assert.notEqual(res.code, 0, `${code} must fail`);
        assert.equal(JSON.parse(res.stdout.trim()).code, code);
      }
      assert.deepEqual(posted, []);
    });
    assert.deepEqual(await sessionIds(homeDir), before, "no successor was created");
    assert.equal(
      (await readStored(homeDir, callerId)).holder_active,
      true,
      "the caller still holds its seat",
    );
  });
});

test("F4 a brief over 20 KB is honoured with a warning", async () => {
  await withTempHome("acpx-handover-big-", async (homeDir) => {
    const cwd = await rig(homeDir);
    const callerId = await newHolder(homeDir, cwd);
    await withAcpxUi(async (origin, posted) => {
      const big = await handover(homeDir, callerId, origin, [
        "--brief",
        await writeBrief(homeDir, 25_000),
      ]);
      assert.equal(big.code, 0, big.stderr);
      assert.match(big.stderr, /⚠ the brief is 25,000 bytes, over 20 KB/);
      assert.equal(posted.length, 1);
    });
    // CONTROL: under 20 KB, no warning.
    const calm = await newHolder(homeDir, cwd);
    await withAcpxUi(async (origin) => {
      const small = await handover(homeDir, calm, origin, [
        "--brief",
        await writeBrief(homeDir, 20_000),
      ]);
      assert.equal(small.code, 0, small.stderr);
      assert.doesNotMatch(small.stderr, /over 20 KB/);
    });
  });
});

test("F5 the text output names the seat URL and the caller's own close duty", async () => {
  await withTempHome("acpx-handover-text-", async (homeDir) => {
    const cwd = await rig(homeDir);
    const callerId = await newHolder(homeDir, cwd);
    const caller = await readStored(homeDir, callerId);
    await withAcpxUi(async (origin) => {
      const res = await runCli(
        ["--approve-all", "claude", "sessions", "handover", "--brief", await writeBrief(homeDir)],
        homeDir,
        {
          ACPX_SESSION_URL: url(callerId),
          ACPX_UI_INTERNAL_URL: origin,
          ACPX_UI_BASE_URL: "https://atrium.example.test",
        },
      );
      assert.equal(res.code, 0, res.stderr);
      assert.match(
        res.stdout,
        new RegExp(`seat: https://atrium\\.example\\.test/\\?seat=${caller.seat_id}`),
      );
      assert.match(res.stdout, new RegExp(`Retired \\(NOT closed\\): ${callerId}`));
      assert.match(res.stdout, /notice delivered to /);
    });
  });
});

test("F6 a failed delivery is loud: exit 1, the successor stands activated, the turn is printed to paste", async () => {
  await withTempHome("acpx-handover-undelivered-", async (homeDir) => {
    const cwd = await rig(homeDir);
    const callerId = await newHolder(homeDir, cwd);
    const res = await runCli(
      ["--approve-all", "claude", "sessions", "handover", "--brief", await writeBrief(homeDir)],
      homeDir,
      { ACPX_SESSION_URL: url(callerId), ACPX_UI_INTERNAL_URL: "" },
    );
    assert.equal(res.code, 1, res.stderr);
    assert.match(res.stdout, /⟦HANDOVER⟧/);
    assert.match(res.stdout, /notice NOT delivered — paste it to the successor/);
  });
});

test("F7 no caller session and no --session-id is refused before anything is created", async () => {
  await withTempHome("acpx-handover-nocaller-", async (homeDir) => {
    await rig(homeDir);
    const res = await runCli(
      ["--format", "json", "claude", "sessions", "handover", "--brief", await writeBrief(homeDir)],
      homeDir,
    );
    assert.notEqual(res.code, 0);
    assert.equal(JSON.parse(res.stdout.trim()).code, "NO_CALLER");
  });
});

test("F8 (TE D3) a RETIRED holder cannot hand over: NOT_HOLDER names the live holder, and nothing is created, delivered or displaced", async () => {
  await withTempHome("acpx-handover-retired-", async (homeDir) => {
    const cwd = await rig(homeDir);
    const retiredId = await newHolder(homeDir, cwd);
    const seatId = (await readStored(homeDir, retiredId)).seat_id;
    let liveId = "";
    await withAcpxUi(async (origin) => {
      const first = await handover(homeDir, retiredId, origin, [
        "--brief",
        await writeBrief(homeDir),
      ]);
      assert.equal(first.code, 0, first.stderr);
      liveId = String(JSON.parse(first.stdout.trim()).successorId);
    });
    assert.equal((await readStored(homeDir, retiredId)).holder_active, false, "fixture: retired");
    const before = await sessionIds(homeDir);

    await withAcpxUi(async (origin, posted) => {
      // The retired holder, by --session-id, from a THIRD party's shell (no ACPX_SESSION_URL of its own).
      const res = await runCli(
        [
          "--format",
          "json",
          "claude",
          "sessions",
          "handover",
          "--session-id",
          retiredId,
          "--brief",
          await writeBrief(homeDir),
        ],
        homeDir,
        { ACPX_UI_INTERNAL_URL: origin, ACPX_UI_BASE_URL: "https://atrium.example.test" },
      );
      assert.notEqual(res.code, 0, "must refuse");
      const out = JSON.parse(res.stdout.trim()) as { code: string; error: string };
      assert.equal(out.code, "NOT_HOLDER");
      assert.ok(out.error.includes(liveId), `names the live holder: ${out.error}`);
      assert.ok(out.error.includes(`https://atrium.example.test/?seat=${seatId}`), out.error);
      assert.deepEqual(posted, [], "nothing delivered");
    });
    assert.deepEqual(await sessionIds(homeDir), before, "nothing created");
    assert.equal(
      (await readStored(homeDir, liveId)).holder_active,
      true,
      "the live holder is untouched",
    );
    assert.equal((await readStored(homeDir, retiredId)).holder_active, false);
  });
});

// Brick bbe2bc47 A6 — the backstop: a handover from a context that Codex already compacted
// after the alarm prints ONE line and proceeds. It never refuses.
async function storeContextFill(
  homeDir: string,
  id: string,
  fill: { used_tokens: number; window_tokens: number; compaction_tokens: number },
): Promise<void> {
  const file = sessionFilePath(homeDir, id);
  const record = JSON.parse(await fs.readFile(file, "utf8")) as { acpx?: Record<string, unknown> };
  record.acpx = { ...record.acpx, context_fill: fill };
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

test("F9 (bbe2bc47 A6) a handover from far below the alarm warns once and still hands over; near the alarm, or with no fill on record, it is silent", async () => {
  await withTempHome("acpx-handover-compacted-", async (homeDir) => {
    const cwd = await rig(homeDir);
    const compacted = await newHolder(homeDir, cwd);
    await storeContextFill(homeDir, compacted, {
      used_tokens: 97_088,
      window_tokens: 828_400,
      compaction_tokens: 784_800,
    });
    await withAcpxUi(async (origin, posted) => {
      const res = await handover(homeDir, compacted, origin, [
        "--brief",
        await writeBrief(homeDir),
      ]);
      assert.equal(res.code, 0, res.stderr);
      assert.match(
        res.stderr,
        /handover: your context is 97,088 \/ 828,400 tokens, far below your alarm .* Proceeding anyway\./,
      );
      assert.equal(posted.length, 1, "the handover was delivered all the same");
      assert.equal((await readStored(homeDir, compacted)).holder_active, false);
    });

    // CONTROLS: past half the alarm point (744,800 / 2 = 372,400) and no fill at all: silent.
    const busy = await newHolder(homeDir, cwd);
    await storeContextFill(homeDir, busy, {
      used_tokens: 400_000,
      window_tokens: 828_400,
      compaction_tokens: 784_800,
    });
    const fresh = await newHolder(homeDir, cwd);
    await withAcpxUi(async (origin) => {
      for (const id of [busy, fresh]) {
        const res = await handover(homeDir, id, origin, ["--brief", await writeBrief(homeDir)]);
        assert.equal(res.code, 0, res.stderr);
        assert.doesNotMatch(res.stderr, /far below your alarm/);
      }
    });
  });
});
