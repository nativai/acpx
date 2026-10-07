// Brick c6bab3aa — the CLI message ledger (LEDGER-CONTRACT.md v1). `acpx <agent> prompt` hands
// its text to the target's queue owner over a local socket and reaches no other store, so an
// agent's send by CLI was invisible in every message history. These rows pin the writer: one
// line per prompt an AGENT delivers, in the shape acpx-ui's reader ingests, and NOTHING for
// any other caller. Each guarantee has its negative row.
//
// The CLI rows drive the REAL compiled CLI against the mock agent in an isolated home and
// read the ledger back from DISK.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  type MessageLedgerLine,
  messageLedgerDir,
  resolveLedgerCaller,
  withMessageLedger,
} from "../src/cli/message-ledger.js";
import { textPrompt } from "../src/prompt-content.js";
import { sessionBaseDir } from "../src/session/persistence.js";
import { withTempHome } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
// `--supports-fork-session`: `sessions copy` / `--from-template` refuse an agent without it.
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-fork-session`;
const UI_BASE = "https://ui.example.test";
const LEDGER_FAILURE_RE = /^acpx: message ledger not written: /;

// Every variable that can carry a caller identity, scrubbed from each child unless the row
// sets it — the suite itself runs inside an agent session whose own identity must never leak
// into a "no identity" row.
const IDENTITY_KEYS = [
  "ACPX_SESSION_URL",
  "ACPX_SEAT_URL",
  "ACPX_SESSION_RECORD_ID",
  "ACPX_SESSION_NAME",
  "ACPX_PARENT_SESSION_URL",
  "ACPX_PARENT_SEAT_URL",
  "ACPX_TASK_FOLDER",
  "ACPX_BRICK",
  "ACPX_BRICK_PATH",
  "ACPX_OWNER_LOG",
] as const;

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ACPX_UI_BASE_URL: UI_BASE };
    delete childEnv.ACPX_STATE_HOME;
    for (const key of IDENTITY_KEYS) {
      delete childEnv[key];
    }
    Object.assign(childEnv, env);
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: childEnv,
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

type Rig = {
  stateHome: string;
  base: string[];
  cli: (args: string[], env?: NodeJS.ProcessEnv) => Promise<CliResult>;
  create: (extra?: string[]) => Promise<string>;
  onDisk: (id: string) => Promise<Record<string, unknown>>;
  /** An agent caller's identity env: a real session of this home, and its seat. */
  agentEnv: (caller: string) => Promise<NodeJS.ProcessEnv>;
  ledger: () => Promise<MessageLedgerLine[]>;
};

/** HOME and ACPX_STATE_HOME point at DIFFERENT dirs, so a ledger under HOME is a wrong home. */
async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  await withTempHome("acpx-message-ledger-", async (root) => {
    const home = path.join(root, "home");
    const stateHome = path.join(root, "state");
    const cwd = path.join(root, "workspace");
    await Promise.all([home, stateHome, cwd].map((dir) => fs.mkdir(dir, { recursive: true })));
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all"];
    const cli = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      runCli(args, { HOME: home, ACPX_STATE_HOME: stateHome, ...env });
    const onDisk = async (id: string) =>
      JSON.parse(
        await fs.readFile(path.join(stateHome, ".acpx", "sessions", `${id}.json`), "utf8"),
      ) as Record<string, unknown>;
    const create = async (extra: string[] = []) => {
      const result = await cli([...base, "--format", "json", "sessions", "new", ...extra]);
      assert.equal(result.code, 0, `sessions new ${extra.join(" ")}: ${result.stderr}`);
      return String((JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId);
    };
    const agentEnv = async (caller: string) => ({
      ACPX_SESSION_URL: `${UI_BASE}/?session=${caller}`,
      ACPX_SEAT_URL: `${UI_BASE}/?seat=${String((await onDisk(caller)).seat_id)}`,
    });
    const ledger = async () => {
      await assert.rejects(
        fs.stat(path.join(home, ".acpx", "message-ledger")),
        "a ledger was written under HOME although ACPX_STATE_HOME names another home",
      );
      return await readLedger(path.join(stateHome, ".acpx", "message-ledger"));
    };
    await run({ stateHome, base, cli, create, onDisk, agentEnv, ledger });
  });
}

async function readLedger(dir: string): Promise<MessageLedgerLine[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const lines: MessageLedgerLine[] = [];
  for (const name of names.toSorted()) {
    const raw = await fs.readFile(path.join(dir, name), "utf8");
    assert.ok(raw.endsWith("\n"), `${name}: the last line is not \\n-terminated`);
    for (const line of raw.split("\n").filter((entry) => entry.length > 0)) {
      lines.push(JSON.parse(line) as MessageLedgerLine);
    }
  }
  return lines;
}

/** Every v1 field, typed — the reader in acpx-ui keys on exactly these. */
function assertV1Shape(line: MessageLedgerLine): void {
  assert.deepEqual(Object.keys(line).toSorted(), [
    "addressedAs",
    "at",
    "failureCode",
    "from",
    "id",
    "kind",
    "outcome",
    "text",
    "to",
    "v",
  ]);
  assert.equal(line.v, 1);
  assert.match(line.id, /^[0-9a-f-]{36}$/);
  assert.equal(new Date(line.at).toISOString(), line.at, "at is not ISO-8601 UTC");
  assert.deepEqual(Object.keys(line.from).toSorted(), ["seat", "session", "url"]);
  assert.deepEqual(Object.keys(line.to).toSorted(), ["seat", "session"]);
}

async function writeFile(dir: string, text: string): Promise<string> {
  const file = path.join(dir, `prompt-${randomUUID()}.txt`);
  await fs.writeFile(file, text, "utf8");
  return file;
}

/** A seat whose ACTIVE holder is the successor — so a seat address and a session address differ. */
async function succeededSeat(rig: Rig): Promise<{ seatId: string; successor: string }> {
  const founder = await rig.create();
  const seatId = String((await rig.onDisk(founder)).seat_id);
  const successor = await rig.create(["--from", founder]);
  const activated = await rig.cli(["sessions", "activate", seatId, successor, "--no-notify"]);
  assert.equal(activated.code, 0, `activate: ${activated.stderr}`);
  return { seatId, successor };
}

// ─── the production shape: an agent's `prompt --seat <seat> --no-wait -f <file>` ─────────────

test("ledger · an agent's `prompt --seat S --no-wait -f` writes ONE v1 line naming S, its active holder and the sender", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create();
    const { seatId, successor } = await succeededSeat(rig);
    // Leading/trailing whitespace, a blank line, quotes, `$` and non-ASCII: recorded verbatim.
    const text = '  brief: "go" — $HOME, `x`, ✓\n\nline three  \n';
    const file = await writeFile(rig.stateHome, text);
    const env = await rig.agentEnv(caller);

    const result = await rig.cli(
      [...rig.base, "prompt", "--seat", seatId, "--no-wait", "-f", file],
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /message ledger/);

    const lines = await rig.ledger();
    assert.equal(lines.length, 1, JSON.stringify(lines));
    const [line] = lines;
    assertV1Shape(line);
    assert.equal(line.kind, "prompt");
    assert.equal(line.addressedAs, "seat");
    assert.deepEqual(line.to, { session: successor, seat: seatId });
    assert.deepEqual(line.from, {
      session: caller,
      seat: String((await rig.onDisk(caller)).seat_id),
      url: env.ACPX_SESSION_URL,
    });
    assert.equal(line.outcome, "accepted");
    assert.equal(line.failureCode, null);
    // `-f` submits the file's content trimmed at both ends (`parsePromptSource`); the
    // interior — the blank line, the quotes, `$`, the non-ASCII — must survive byte for byte.
    assert.equal(line.text, text.trim());
  });
});

test("ledger · `--session-id` and `--session-url ?session=` are addressedAs session; `--session-url ?seat=` is a seat", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create();
    const { seatId, successor } = await succeededSeat(rig);
    const env = await rig.agentEnv(caller);
    const send = async (selector: string[]) => {
      const result = await rig.cli([...rig.base, "prompt", ...selector, "--no-wait", "hi"], env);
      assert.equal(result.code, 0, result.stderr);
    };
    await send(["--session-id", successor]);
    await send(["--session-url", `${UI_BASE}/?session=${successor}`]);
    await send(["--session-url", `${UI_BASE}/?seat=${seatId}`]);

    const lines = await rig.ledger();
    assert.deepEqual(
      lines.map((line) => [line.addressedAs, line.to.session, line.to.seat]),
      [
        // A session address still names the holder's seat — the record's seat_id.
        ["session", successor, seatId],
        ["session", successor, seatId],
        ["seat", successor, seatId],
      ],
    );
  });
});

test("ledger · ACPX_SESSION_RECORD_ID alone identifies the agent caller (from.seat/url null)", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create();
    const target = await rig.create();
    const result = await rig.cli(
      [...rig.base, "prompt", "--session-id", target, "--no-wait", "hi"],
      { ACPX_SESSION_RECORD_ID: caller },
    );
    assert.equal(result.code, 0, result.stderr);
    const lines = await rig.ledger();
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0].from, { session: caller, seat: null, url: null });
  });
});

// ─── negatives: who is NOT recorded ──────────────────────────────────────────────────────────

test("ledger · NEGATIVE: a caller with no agent identity writes no line (and no ledger dir)", async () => {
  await withRig(async (rig) => {
    const target = await rig.create();
    const result = await rig.cli([
      ...rig.base,
      "prompt",
      "--session-id",
      target,
      "--no-wait",
      "hi",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await rig.ledger(), []);
    await assert.rejects(fs.stat(path.join(rig.stateHome, ".acpx", "message-ledger")));
  });
});

test("ledger · NEGATIVE: `--message-id` (acpx-ui's own delivery) writes no line even with an identity", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create();
    const target = await rig.create();
    const result = await rig.cli(
      [
        ...rig.base,
        "prompt",
        "--session-id",
        target,
        "--no-wait",
        "--message-id",
        randomUUID(),
        "hi",
      ],
      await rig.agentEnv(caller),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await rig.ledger(), []);
  });
});

test("ledger · NEGATIVE: a ?seat= that is not a seat id is recorded as from.seat null — the line is still written", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create();
    const target = await rig.create();
    const callerUrl = `${UI_BASE}/?session=${caller}`;
    const realSeat = String((await rig.onDisk(caller)).seat_id);
    for (const seatUrl of [
      `${UI_BASE}/?seat=garbage-seat`,
      // An uppercased real seat id: the store never normalises one, so neither does the ledger.
      `${UI_BASE}/?seat=${realSeat.toUpperCase()}`,
    ]) {
      const result = await rig.cli(
        [...rig.base, "prompt", "--session-id", target, "--no-wait", "hi"],
        { ACPX_SESSION_URL: callerUrl, ACPX_SEAT_URL: seatUrl },
      );
      assert.equal(result.code, 0, result.stderr);
    }
    const lines = await rig.ledger();
    assert.equal(lines.length, 2, JSON.stringify(lines));
    for (const line of lines) {
      assert.deepEqual(line.from, { session: caller, seat: null, url: callerUrl });
    }
  });
});

test("ledger · NEGATIVE: an ACPX_SESSION_URL without a ?session= uuid is no identity", async () => {
  await withRig(async (rig) => {
    const target = await rig.create();
    for (const url of [`${UI_BASE}/?session=not-a-uuid`, `${UI_BASE}/?seat=${randomUUID()}`]) {
      const result = await rig.cli(
        [...rig.base, "prompt", "--session-id", target, "--no-wait", "hi"],
        { ACPX_SESSION_URL: url },
      );
      assert.equal(result.code, 0, result.stderr);
    }
    assert.deepEqual(await rig.ledger(), []);
  });
});

// ─── a write failure never changes the command ───────────────────────────────────────────────

test("ledger · NEGATIVE: an unwritable ledger keeps the exit code and stdout, prints ONE stderr line, and still delivers", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create();
    const target = await rig.create();
    const args = [...rig.base, "prompt", "--session-id", target, "echo delivered-anyway"];
    // Warm the owner first: a cold start prints its `[client] initialize` lines once, so only
    // two warm runs have stdout that can be compared byte for byte.
    assert.equal((await rig.cli(args)).code, 0);
    const control = await rig.cli(args);
    assert.equal(control.code, 0, control.stderr);

    // A FILE where the ledger directory belongs: mkdir fails, every time.
    await fs.writeFile(path.join(rig.stateHome, ".acpx", "message-ledger"), "not a dir");
    const result = await rig.cli(args, await rig.agentEnv(caller));

    assert.equal(result.code, control.code);
    assert.equal(result.stdout, control.stdout);
    assert.match(result.stdout, /delivered-anyway/, "the prompt was not delivered");
    const ledgerLines = result.stderr.split("\n").filter((line) => LEDGER_FAILURE_RE.test(line));
    assert.equal(ledgerLines.length, 1, result.stderr);
  });
});

// ─── refusals ────────────────────────────────────────────────────────────────────────────────

test("ledger · a refused submit (closed target) records outcome refused with the acpx code, exit code unchanged", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create();
    const target = await rig.create();
    const closed = await rig.cli(["sessions", "close", "--session-id", target]);
    assert.equal(closed.code, 0, closed.stderr);
    const args = [...rig.base, "prompt", "--session-id", target, "--no-wait", "hi"];
    const control = await rig.cli(args);
    assert.notEqual(control.code, 0, "precondition: a closed target refuses");

    const result = await rig.cli(args, await rig.agentEnv(caller));
    assert.equal(result.code, control.code);
    assert.equal(result.stdout, control.stdout);
    const lines = await rig.ledger();
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assertV1Shape(lines[0]);
    assert.equal(lines[0].outcome, "refused");
    assert.equal(lines[0].failureCode, "SESSION_CLOSED");
    assert.equal(lines[0].to.session, target);
  });
});

// ─── the other prompt-delivering commands ────────────────────────────────────────────────────

test("ledger · `sessions copy` records its ⟦FORK-NOTICE⟧ delivery as kind fork-notice to the new session", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create();
    const source = await rig.create();
    const result = await rig.cli(
      [
        ...rig.base,
        "--format",
        "json",
        "sessions",
        "copy",
        "--from",
        source,
        "--prompt",
        "carry on",
      ],
      await rig.agentEnv(caller),
    );
    assert.equal(result.code, 0, result.stderr);
    const lines = await rig.ledger();
    assert.equal(lines.length, 1, JSON.stringify(lines));
    const [line] = lines;
    assertV1Shape(line);
    assert.equal(line.kind, "fork-notice");
    assert.equal(line.addressedAs, "session");
    assert.notEqual(line.to.session, source);
    assert.equal(line.to.seat, String((await rig.onDisk(line.to.session)).seat_id));
    assert.match(line.text, /carry on$/);
  });
});

test("ledger · `sessions new --from-template --prompt` records kind template-prompt to the spawned child", async () => {
  await withRig(async (rig) => {
    const caller = await rig.create();
    const template = await rig.create();
    const marked = await rig.cli([
      ...rig.base,
      "sessions",
      "template",
      template,
      "--enable",
      "--slug",
      "ledger-template",
    ]);
    assert.equal(marked.code, 0, marked.stderr);
    const result = await rig.cli(
      [
        ...rig.base,
        "--format",
        "json",
        "sessions",
        "new",
        "--from-template",
        "ledger-template",
        "--prompt",
        "template brief",
      ],
      await rig.agentEnv(caller),
    );
    assert.equal(result.code, 0, result.stderr);
    const lines = await rig.ledger();
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].kind, "template-prompt");
    assert.equal(lines[0].text, "template brief");
    assert.notEqual(lines[0].to.session, template);
  });
});

// ─── the writer, in process ──────────────────────────────────────────────────────────────────

async function withCapturedStderr<T>(run: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

async function withIdentity<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>(
    IDENTITY_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of IDENTITY_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const SEND = {
  kind: "prompt" as const,
  to: { session: randomUUID(), seat: null },
  addressedAs: "session" as const,
  prompt: textPrompt("x"),
};

test("ledger writer · resolves <state home> from ACPX_STATE_HOME — the same home sessions/ uses", async () => {
  await withTempHome("acpx-message-ledger-dir-", async (stateHome) => {
    assert.equal(process.env.ACPX_STATE_HOME, stateHome, "precondition");
    assert.equal(messageLedgerDir(), path.join(stateHome, ".acpx", "message-ledger"));
    assert.equal(path.dirname(messageLedgerDir()), path.dirname(sessionBaseDir()));
  });
});

test("ledger writer · caller identity: url uuid first, record id as fallback, seat from ACPX_SEAT_URL", () => {
  const session = randomUUID();
  const seat = randomUUID();
  assert.equal(resolveLedgerCaller({}), undefined);
  assert.equal(resolveLedgerCaller({ ACPX_SESSION_URL: "   " }), undefined);
  assert.equal(
    resolveLedgerCaller({
      ACPX_SESSION_URL: `${UI_BASE}/?session=${session}`,
      ACPX_SEAT_URL: `${UI_BASE}/?seat=garbage-seat`,
    })?.seat,
    null,
    "a ?seat= that is not a seat id must be null, not written through",
  );
  assert.deepEqual(
    resolveLedgerCaller({
      ACPX_SESSION_URL: `${UI_BASE}/?session=${session}`,
      ACPX_SEAT_URL: `${UI_BASE}/?seat=${seat}`,
      ACPX_SESSION_RECORD_ID: randomUUID(),
    }),
    { session, seat, url: `${UI_BASE}/?session=${session}` },
  );
  assert.deepEqual(
    resolveLedgerCaller({
      ACPX_SESSION_URL: `${UI_BASE}/?session=nope`,
      ACPX_SESSION_RECORD_ID: session,
    }),
    { session, seat: null, url: `${UI_BASE}/?session=nope` },
  );
});

test("ledger writer · text is the text blocks exactly as submitted; an image block is not copied", async () => {
  await withTempHome("acpx-message-ledger-text-", async () => {
    const text = "  leading and trailing  \n";
    await withIdentity({ ACPX_SESSION_RECORD_ID: randomUUID() }, async () => {
      await withMessageLedger({ ...SEND, prompt: textPrompt(text) }, async (accept) => accept());
      await withMessageLedger(
        {
          ...SEND,
          prompt: [
            { type: "text", text: "a" },
            { type: "image", mimeType: "image/png", data: "AAAA" },
            { type: "text", text: "b" },
          ],
        },
        async (accept) => accept(),
      );
    });
    const lines = await readLedger(messageLedgerDir());
    assert.deepEqual(
      lines.map((line) => line.text),
      [text, "a\n\nb"],
    );
  });
});

test("ledger writer · one line per send: an ack then a retried ack, or an ack then a failed turn, is ONE accepted line", async () => {
  await withTempHome("acpx-message-ledger-once-", async () => {
    await withIdentity({ ACPX_SESSION_RECORD_ID: randomUUID() }, async () => {
      await withMessageLedger(SEND, async (accept) => {
        accept();
        accept();
      });
      await assert.rejects(
        withMessageLedger(SEND, async (accept) => {
          accept();
          throw new Error("turn failed after the ack");
        }),
        /turn failed/,
      );
    });
    const lines = await readLedger(messageLedgerDir());
    assert.deepEqual(
      lines.map((line) => line.outcome),
      ["accepted", "accepted"],
    );
  });
});

test("ledger writer · NEGATIVE: an unwritable ledger never throws, returns the result, and prints exactly one stderr line", async () => {
  await withTempHome("acpx-message-ledger-fail-", async () => {
    await fs.mkdir(path.dirname(messageLedgerDir()), { recursive: true });
    await fs.writeFile(messageLedgerDir(), "not a dir");
    const { value, stderr } = await withCapturedStderr(() =>
      withIdentity({ ACPX_SESSION_RECORD_ID: randomUUID() }, () =>
        withMessageLedger(SEND, async (accept) => {
          accept();
          return "the result";
        }),
      ),
    );
    assert.equal(value, "the result");
    const lines = stderr.split("\n").filter((line) => line.length > 0);
    assert.equal(lines.length, 1, stderr);
    assert.match(lines[0], LEDGER_FAILURE_RE);
  });
});
