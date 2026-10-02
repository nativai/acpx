import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveBrickContext } from "../src/acp/brick-context.js";
import { AcpClient } from "../src/acp/client.js";
import { resetSessionPrimerMemoForTests } from "../src/acp/session-primer.js";
import {
  deriveAgentFolders,
  resolveAndEnsureAgentFolder,
} from "../src/cli/session/agent-folder.js";
import type { SessionRecord } from "../src/types.js";

// C7 (brick 09197f03) row 3 — `fef74c74` closed: the "Your workspace:" line the injected primer renders
// and `$ACPX_AGENT_FOLDER` must name the SAME directory. acpx cannot render the line (the brick CLI does),
// so what acpx owns is the INPUT: the child's own session id AND its own seat id must reach `brick
// context` — through the env, never a new flag, because the deployed brick CLI rejects unknown flags
// (measured: `brick context X --bogusflag` → rc 2 `unknown flag`, which would blank the whole brick block
// on every box where acpx runs ahead of acpx-ui).

const BRICK_SHIM_DIR = path.join(process.cwd(), "test", "fixtures", "brick-shim");
const BRICK_ID = "11111111-2222-3333-4444-555555555555";
const CHILD_SESSION = "cccccccc-1111-4222-8333-444444444444";
const CHILD_SEAT = "dddddddd-5555-4666-8777-888888888888";
const SPAWNER_SESSION_URL =
  "https://atrium.example.test/?session=ssssssss-0000-4000-8000-000000000000";
const SPAWNER_SEAT_URL = "https://atrium.example.test/?seat=eeeeeeee-0000-4000-8000-000000000000";

type ShimEnvRow = {
  verb: string;
  ACPX_SESSION_URL: string | null;
  ACPX_SEAT_URL: string | null;
};

/** The id carried by an `ACPX_*_URL` value — a bare uuid or a `?session=` / `?seat=` URL. */
function idOf(value: string | null, param: "session" | "seat"): string | null {
  if (value === null) {
    return null;
  }
  try {
    return new URL(value).searchParams.get(param);
  } catch {
    return value;
  }
}

async function withShim<T>(
  run: (logs: { argsLog: string; envLog: string }) => Promise<T>,
  extraEnv: Record<string, string | undefined> = {},
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-brick-ctx-identity-"));
  const argsLog = path.join(dir, "args.jsonl");
  const envLog = path.join(dir, "env.jsonl");
  const entries: Record<string, string | undefined> = {
    PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
    BRICK_SHIM_MODE: "ok",
    BRICK_SHIM_CONTEXT: "BRICK BLOCK",
    BRICK_SHIM_LOG: argsLog,
    BRICK_SHIM_ENV_LOG: envLog,
    ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    // The SPAWNER's identity — what the queue owner's ambient env carries and the child must never inherit.
    ACPX_SESSION_URL: SPAWNER_SESSION_URL,
    ACPX_SEAT_URL: SPAWNER_SEAT_URL,
    ...extraEnv,
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run({ argsLog, envLog });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetSessionPrimerMemoForTests();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readJsonl<T>(file: string): Promise<T[]> {
  const raw = await fs.readFile(file, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

test("resolveBrickContext hands the CHILD's session and seat to brick through env, and adds NO flag", async () => {
  await withShim(async ({ argsLog, envLog }) => {
    const text = await resolveBrickContext(BRICK_ID, {
      sessionId: CHILD_SESSION,
      seatId: CHILD_SEAT,
    });
    assert.equal(text, "BRICK BLOCK", "the shim never answered — this arm measured nothing");
    assert.deepEqual(await readJsonl<string[]>(argsLog), [
      // `--session` stays (an old brick CLI understands it); there is NO `--seat`.
      ["context", BRICK_ID, "--session", CHILD_SESSION, "--format", "inject"],
    ]);
    const [row] = await readJsonl<ShimEnvRow>(envLog);
    assert.equal(idOf(row.ACPX_SESSION_URL, "session"), CHILD_SESSION);
    assert.equal(idOf(row.ACPX_SEAT_URL, "seat"), CHILD_SEAT);
  });
});

test("a seat-less child gets NO seat in brick's env — the spawner's ACPX_SEAT_URL is deleted, not inherited", async () => {
  for (const seatId of [undefined, "", "   "]) {
    await withShim(async ({ envLog }) => {
      await resolveBrickContext(BRICK_ID, { sessionId: CHILD_SESSION, seatId });
      const [row] = await readJsonl<ShimEnvRow>(envLog);
      assert.equal(idOf(row.ACPX_SESSION_URL, "session"), CHILD_SESSION);
      assert.equal(
        row.ACPX_SEAT_URL,
        null,
        `seatId=${JSON.stringify(seatId)}: the parent's seat leaked into a seat-less child's primer`,
      );
    });
  }
});

test("the transient creation spawn (no own ids) never names the SPAWNER's session or seat to brick", async () => {
  await withShim(async ({ argsLog, envLog }) => {
    await resolveBrickContext(BRICK_ID, {});
    // No own id ⇒ no `--session` flag (unchanged — sessions new --brick asserts this shape)…
    assert.deepEqual(await readJsonl<string[]>(argsLog), [
      ["context", BRICK_ID, "--format", "inject"],
    ]);
    // …and, new: the spawner's ambient identity is stripped, so the rendered "Your workspace" line is the
    // honest placeholder instead of the SPAWNER's own folder (which a persisted codex primer would keep).
    const [row] = await readJsonl<ShimEnvRow>(envLog);
    assert.equal(row.ACPX_SESSION_URL, null);
    assert.equal(row.ACPX_SEAT_URL, null);
  });
});

test("AcpClient renders the brick block from the SAME seat and session $ACPX_AGENT_FOLDER is derived from (row 3)", async () => {
  const brickDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-row3-brick-"));
  try {
    const record = {
      acpxRecordId: CHILD_SESSION,
      seatId: CHILD_SEAT,
    } as unknown as SessionRecord;
    const folders = resolveAndEnsureAgentFolder(record, brickDir);
    assert.ok(folders, "no folders resolved — the arm measured nothing");

    const client = new AcpClient({
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: process.cwd(),
      permissionMode: "approve-reads",
      sessionContext: {
        acpxRecordId: record.acpxRecordId,
        seatId: record.seatId,
        brick: BRICK_ID,
        brickPath: brickDir,
        agentFolder: folders.agentFolder,
      },
    });
    (client as unknown as { connection: unknown }).connection = {
      newSession: async () => ({ sessionId: "session-row3" }),
    };

    await withShim(async ({ argsLog, envLog }) => {
      await client.createSession(process.cwd());
      assert.deepEqual(await readJsonl<string[]>(argsLog), [
        ["context", BRICK_ID, "--session", CHILD_SESSION, "--format", "inject"],
      ]);
      const [row] = await readJsonl<ShimEnvRow>(envLog);
      const renderedFor = deriveAgentFolders({
        brickPath: brickDir,
        sessionId: idOf(row.ACPX_SESSION_URL, "session") ?? "",
        seatId: idOf(row.ACPX_SEAT_URL, "seat"),
      });
      assert.deepEqual(
        renderedFor,
        folders,
        "the primer's folder and $ACPX_AGENT_FOLDER disagree — fef74c74 is live",
      );
    });
  } finally {
    await fs.rm(brickDir, { recursive: true, force: true });
  }
});
