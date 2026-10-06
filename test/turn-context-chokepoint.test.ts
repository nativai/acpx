/**
 * Per-turn context injection — the BEHAVIOURAL chokepoint rows (brick 4539b033).
 *
 * These drive a **real `AcpClient`** against the mock ACP agent and assert on what the agent
 * ACTUALLY RECEIVED, read out of its operation log. That makes them immune to the failure class
 * the structural rows in `turn-context.test.ts` (J1/J3) cannot escape: a source grep whose
 * pattern silently stops matching passes, reporting the premise protected at the exact moment it
 * stopped being checked.
 *
 * **Neither form subsumes the other, which is why both exist:**
 *  - **behavioural (here)** — catches a double-send introduced into the path we have, and proves
 *    the decoration actually reaches the wire. Immune to formatting, renames and NUL bytes.
 *    Blind to a second call site added in a file this test never drives.
 *  - **structural (J1/J3)** — catches a second call site added anywhere in `src`. Blind to a
 *    behavioural double-send through the existing site.
 *
 * ⚠️ The mock is reached through a **token-named directory** so acpx classifies the session as
 * the intended harness: classification is derived from path SEGMENTS of the agent command
 * (`src/acp/adapter-token.ts`), so a differently-named path would silently reclassify the
 * session and the rows would be measuring something else.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import { TURN_CONTEXT_OPEN_TAG, TURN_CONTEXT_TEST_PAYLOAD_ENV } from "../src/acp/turn-context.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type MockOperation = { method?: string; text?: string };

/** One `session/prompt` as the MOCK AGENT received it — the wire, not our reconstruction. */
async function readPromptOperations(operationLog: string): Promise<MockOperation[]> {
  const raw = await fs.readFile(operationLog, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MockOperation)
    .filter((operation) => operation.method === "session/prompt");
}

/**
 * Drive one real prompt through a real `AcpClient` and return what the agent received.
 *
 * `payload` set ⇒ the test seam is armed **in the spawned agent's environment**, which is the
 * only env the provider is allowed to read.
 */
async function runOnePrompt(options: {
  turnContext: boolean;
  payload?: string;
  userText: string;
}): Promise<MockOperation[]> {
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "turnctx-chokepoint-"));
  const linkDir = path.join(scratchDir, "claude-agent-acp");
  await fs.mkdir(linkDir, { recursive: true });
  const mockLink = path.join(linkDir, "mock-agent.js");
  await fs.symlink(MOCK_AGENT_PATH, mockLink);
  const operationLog = path.join(scratchDir, "ops.jsonl");

  const previousPayload = process.env[TURN_CONTEXT_TEST_PAYLOAD_ENV];
  if (options.payload === undefined) {
    delete process.env[TURN_CONTEXT_TEST_PAYLOAD_ENV];
  } else {
    process.env[TURN_CONTEXT_TEST_PAYLOAD_ENV] = options.payload;
  }

  const client = new AcpClient({
    agentCommand: `node ${JSON.stringify(mockLink)} --operation-log ${JSON.stringify(operationLog)}`,
    cwd: scratchDir,
    permissionMode: "approve-reads",
    sessionContext: { acpxRecordId: "turnctx-chokepoint" },
  });
  try {
    await client.start();
    const created = await client.createSession();
    // K4 depends on the un-opted-in call passing NO `turnContext` at all, exactly as the
    // mid-turn and one-shot paths do — not `turnContext: false`, which would test a different
    // thing (an explicit opt-out rather than an absent opt-in).
    await client.prompt(
      created.sessionId,
      options.userText,
      options.turnContext ? { turnContext: true } : {},
    );
    return await readPromptOperations(operationLog);
  } finally {
    await client.close().catch(() => {});
    if (previousPayload === undefined) {
      delete process.env[TURN_CONTEXT_TEST_PAYLOAD_ENV];
    } else {
      process.env[TURN_CONTEXT_TEST_PAYLOAD_ENV] = previousPayload;
    }
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

test("K1 one client.prompt() reaches the transport EXACTLY ONCE — behavioural, no source grep", async () => {
  const operations = await runOnePrompt({ turnContext: true, userText: "the user's words" });
  assert.equal(
    operations.length,
    1,
    "One client.prompt() call must produce exactly ONE session/prompt on the wire. More than " +
      "one means a double-send was introduced into the send path, which on a decorated turn " +
      "also means the turn-context block is delivered more than once. Counted from the MOCK " +
      "AGENT's own operation log, so this cannot be fooled by a reformat, a rename, or the " +
      "NUL-byte search false-negative that the structural rows are exposed to.",
  );
});

test("K2 with the seam unset the wire text is the user's words, unmodified — AC1 end to end", async () => {
  const operations = await runOnePrompt({ turnContext: true, userText: "just the user" });
  assert.equal(operations.length, 1);
  assert.equal(
    operations[0].text,
    "just the user",
    "With no payload configured the agent must receive the user's text and nothing else",
  );
  assert.equal(
    operations[0].text?.includes(TURN_CONTEXT_OPEN_TAG),
    false,
    "no envelope may appear when nothing is configured to inject",
  );
});

test("K3 with the seam armed the envelope reaches the wire AHEAD of the user's text — AC2 end to end", async () => {
  const nonce = "c0ffee1234abcdef";
  const operations = await runOnePrompt({
    turnContext: true,
    payload: `PERTURN-NONCE = ${nonce}`,
    userText: "just the user",
  });
  assert.equal(operations.length, 1, "still exactly one send on a decorated turn");
  const text = operations[0].text ?? "";
  // K2 is this row's control: the same instrument, same harness, reports the envelope ABSENT
  // when nothing is configured. Without it, K3 passes on an instrument that cannot see text.
  assert.ok(text.includes(TURN_CONTEXT_OPEN_TAG), "the envelope must reach the wire");
  assert.ok(text.includes(nonce), "the payload must reach the wire");
  assert.ok(text.includes("just the user"), "the user's text must survive");
  assert.ok(
    text.indexOf(TURN_CONTEXT_OPEN_TAG) < text.indexOf("just the user"),
    "the block is PREPENDED: the user's own words stay last and most salient",
  );
});

test("K4 WITHOUT the opt-in flag an armed seam injects NOTHING — the scoping guarantee, behaviourally", async () => {
  // This is the row that protects the mid-turn-steer and one-shot paths: they call
  // AcpClient.prompt without the flag, and must be undecorated even with a payload configured.
  const nonce = "feedface99887766";
  const operations = await runOnePrompt({
    turnContext: false,
    payload: `PERTURN-NONCE = ${nonce}`,
    userText: "just the user",
  });
  assert.equal(operations.length, 1);
  assert.equal(
    operations[0].text,
    "just the user",
    "An un-opted-in call must be byte-identical to the undecorated turn EVEN WITH a payload " +
      "configured. If this fails, the mid-turn injected prompt and the runOnce one-shot path " +
      "are being decorated — double injection within a turn, and a steer framed as a fresh " +
      "turn. CONCEPTION §3.2, §8.",
  );
  // CONTROL: K3 is the same instrument with the same payload and the flag ON, where the nonce
  // IS present. Without that pairing, this row passes on a build where the seam never works.
  assert.equal(operations[0].text?.includes(nonce), false);
});
