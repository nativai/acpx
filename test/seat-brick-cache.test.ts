import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { maybeStampBrickLink } from "../src/cli/session/brick-link.js";
import { withConnectedSession } from "../src/runtime/engine/connected-session.js";
import { readSeatStore, seatFromStore, withSeatStoreWrite } from "../src/session/persistence.js";
import { readSessionIndex } from "../src/session/persistence/index.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// brick fb1a7a9c — a seated session's brick is decided by its SEAT's brick_id; `metadata.brick`
// on the record is a CACHE (Daniel, D-BRICK-ON-SEAT: "in future a session doesn't have a brick
// connection, instead the seat has"). Every row below is a seated record whose SEAT brick
// disagrees with its stale cache — the shape in which "metadata.brick is the session's link"
// and "the seat decides" give different answers.

const SEAT_BRICK = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const STALE_BRICK = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SEAT_ID = "11111111-2222-4333-8444-555555555555";
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const BRICK_SHIM_DIR = path.join(process.cwd(), "test", "fixtures", "brick-shim");

function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  return withTempHomeFixture("acpx-seat-brick-cache-", run);
}

async function plantSeat(
  homeDir: string,
  overrides: { brickId?: { ref: string; validated: boolean }; activeHolderId?: string } = {},
): Promise<void> {
  await withSeatStoreWrite(path.join(homeDir, ".acpx", "sessions"), () => ({
    mutation: {
      kind: "write" as const,
      seats: new Map([
        [
          SEAT_ID,
          {
            seatId: SEAT_ID,
            createdAt: "2026-10-02T00:00:00.000Z",
            activeHolderId: overrides.activeHolderId ?? null,
            nextOrdinal: 2,
            closedAt: null,
            name: undefined,
            brickId: overrides.brickId,
            favorite: false,
          },
        ],
      ]),
    },
    result: undefined,
  }));
}

function seatedRecord(
  homeDir: string,
  id: string,
  metadata: Record<string, string> | undefined,
  seated = true,
): SessionRecord {
  return {
    ...makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `acp-${id}`,
      agentCommand: MOCK_AGENT_COMMAND,
      cwd: path.join(homeDir, "workspace"),
      metadata,
    }),
    ...(seated ? { seatId: SEAT_ID, holderOrdinal: 1, holderActive: true } : {}),
  };
}

/** Run the REAL env-builder in `withConnectedSession` far enough to see the sessionContext it
 * hands the client (the throw stops the run right after — nothing past it is under test). */
async function connectedSessionContext(
  record: SessionRecord,
): Promise<{ brick?: string | null; brickPath?: string | null } | undefined> {
  let seen: { brick?: string | null; brickPath?: string | null } | undefined;
  const stop = new Error("captured");
  await assert.rejects(
    withConnectedSession({
      sessionRecordId: record.acpxRecordId,
      loadRecord: async () => record,
      saveRecord: async () => {},
      createClient: (options) => {
        seen = options.sessionContext;
        throw stop;
      },
      run: async () => undefined,
    }),
    (error) => error === stop,
  );
  return seen;
}

test("(a) a seated session whose seat brick ≠ its stale metadata.brick gets ACPX_BRICK = the SEAT's brick", async () => {
  await withTempHome(async (homeDir) => {
    await plantSeat(homeDir, { brickId: { ref: SEAT_BRICK, validated: true } });
    const ctx = await connectedSessionContext(
      seatedRecord(homeDir, "seated-stale", { brick: STALE_BRICK }),
    );
    assert.equal(ctx?.brick, SEAT_BRICK);
  });
});

test("(a) a seated session whose record carries NO metadata.brick still gets the seat's brick", async () => {
  await withTempHome(async (homeDir) => {
    await plantSeat(homeDir, { brickId: { ref: SEAT_BRICK, validated: false } });
    const ctx = await connectedSessionContext(seatedRecord(homeDir, "seated-bare", undefined));
    assert.equal(ctx?.brick, SEAT_BRICK);
  });
});

test("(b) a seat-less record still gets metadata.brick", async () => {
  await withTempHome(async (homeDir) => {
    await plantSeat(homeDir, { brickId: { ref: SEAT_BRICK, validated: true } });
    const ctx = await connectedSessionContext(
      seatedRecord(homeDir, "seatless", { brick: STALE_BRICK }, false),
    );
    assert.equal(ctx?.brick, STALE_BRICK);
  });
});

test("(b) a seat with NO link falls back to metadata.brick — absence is unknown, not none", async () => {
  await withTempHome(async (homeDir) => {
    await plantSeat(homeDir, { brickId: undefined });
    const ctx = await connectedSessionContext(
      seatedRecord(homeDir, "seat-unlinked", { brick: STALE_BRICK }),
    );
    assert.equal(ctx?.brick, STALE_BRICK);
  });
});

test("(b) a seatId whose seat row is missing FAILS OPEN to metadata.brick — a spawn is never refused over a label", async () => {
  await withTempHome(async (homeDir) => {
    // No seats.json at all.
    const ctx = await connectedSessionContext(
      seatedRecord(homeDir, "seat-missing", { brick: STALE_BRICK }),
    );
    assert.equal(ctx?.brick, STALE_BRICK);
  });
});

test("(b) a malformed seats.json FAILS OPEN to metadata.brick", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, ".acpx", "sessions"), { recursive: true });
    await fs.writeFile(path.join(homeDir, ".acpx", "sessions", "seats.json"), "{ not json", "utf8");
    const ctx = await connectedSessionContext(
      seatedRecord(homeDir, "seat-corrupt", { brick: STALE_BRICK }),
    );
    assert.equal(ctx?.brick, STALE_BRICK);
  });
});

test("(e) the session-started stamp lands on the SEAT's brick, not the stale cache", async () => {
  await withTempHome(async (homeDir) => {
    await plantSeat(homeDir, { brickId: { ref: SEAT_BRICK, validated: true } });
    const log = path.join(homeDir, "brick.log");
    const originalPath = process.env.PATH;
    process.env.PATH = `${BRICK_SHIM_DIR}:${originalPath ?? ""}`;
    process.env.BRICK_SHIM_LOG = log;
    try {
      await maybeStampBrickLink(seatedRecord(homeDir, "stamp-seated", { brick: STALE_BRICK }));
    } finally {
      process.env.PATH = originalPath;
      delete process.env.BRICK_SHIM_LOG;
    }
    const lines = (await fs.readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(lines, [
      ["stamp", SEAT_BRICK, "session-started", "--by", "session:stamp-seated"],
    ]);
  });
});

test("(c) a child spawned into a NEW seat inherits the parent's SEAT brick when the parent's metadata.brick is stale", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await plantSeat(homeDir, {
      brickId: { ref: SEAT_BRICK, validated: true },
      activeHolderId: "parent-stale",
    });
    await writeSessionRecordFile(
      homeDir,
      seatedRecord(homeDir, "parent-stale", { brick: STALE_BRICK }),
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
      ACPX_SESSION_URL: "https://test-ui.example/?session=parent-stale",
    };
    delete env.ACPX_STATE_HOME;
    for (const key of ["ACPX_BRICK", "ACPX_BRICK_PATH", "ACPX_SEAT_URL", "ACPX_OWNER_LOG"]) {
      delete env[key];
    }
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(
          process.execPath,
          [
            CLI_PATH,
            "--cwd",
            cwd,
            "--agent",
            MOCK_AGENT_COMMAND,
            "--approve-all",
            "--format",
            "json",
            "sessions",
            "new",
            "-s",
            "child-of-stale",
          ],
          { env, stdio: ["pipe", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (c: string) => (stdout += c));
        child.stderr.on("data", (c: string) => (stderr += c));
        child.stdin.end();
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      },
    );
    assert.equal(result.code, 0, result.stderr);
    const childId = String(
      (JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = JSON.parse(
      await fs.readFile(path.join(homeDir, ".acpx", "sessions", `${childId}.json`), "utf8"),
    ) as { seat_id?: string; metadata?: Record<string, string> };
    assert.notEqual(
      onDisk.seat_id,
      SEAT_ID,
      "the child must be in a NEW seat for this row to mean anything",
    );
    assert.equal(onDisk.metadata?.brick, SEAT_BRICK, "the child's cache");
    const childSeat = seatFromStore(
      await readSeatStore(path.join(homeDir, ".acpx", "sessions")),
      String(onDisk.seat_id),
    );
    assert.equal(childSeat?.brickId?.ref, SEAT_BRICK, "the child's own seat");
  });
});

test("(b) a schema-invalid (non-string) metadata.brick decides to nothing rather than throwing", async () => {
  await withTempHome(async (homeDir) => {
    const ctx = await connectedSessionContext(
      seatedRecord(homeDir, "garbage-cache", { brick: 42 as unknown as string }, false),
    );
    assert.equal(ctx?.brick, null);
  });
});

// ─── THE WRITERS (TE verdict te-fail on 4423697c: the cache goes out of sync) ─────────────────
// For a SEATED record the seat is the authority and the cache is ALWAYS written WITH it, by ONE
// function (`applySeatBrick`, src/session/seat-brick.ts). Every row below drives the REAL CLI
// against a throwaway HOME and reads the seat, the record, the index and the next-turn env back.

const NEW_BRICK = "cccccccc-3333-4333-8333-cccccccccccc";

type CliOut = { code: number | null; stdout: string; stderr: string };

async function runCli(
  homeDir: string,
  args: string[],
  shim: Record<string, string> = { BRICK_SHIM_MODE: "ok" },
): Promise<CliOut> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
    ...shim,
  };
  delete env.ACPX_STATE_HOME;
  for (const key of ["ACPX_SESSION_URL", "ACPX_BRICK", "ACPX_BRICK_PATH", "ACPX_SEAT_URL"]) {
    delete env[key];
  }
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function plantLinkedSeatAndHolder(
  homeDir: string,
  holderId: string,
  seatLink: { ref: string; validated: boolean } | undefined,
  cache: Record<string, string> | undefined,
): Promise<void> {
  await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
  await plantSeat(homeDir, { brickId: seatLink, activeHolderId: holderId });
  await writeSessionRecordFile(homeDir, seatedRecord(homeDir, holderId, cache));
}

async function readSeatBrick(homeDir: string) {
  return seatFromStore(await readSeatStore(path.join(homeDir, ".acpx", "sessions")), SEAT_ID)
    ?.brickId;
}

async function readCache(homeDir: string, id: string): Promise<Record<string, string> | undefined> {
  const raw = JSON.parse(
    await fs.readFile(path.join(homeDir, ".acpx", "sessions", `${id}.json`), "utf8"),
  ) as { metadata?: Record<string, string> };
  return raw.metadata;
}

async function readIndexBrick(homeDir: string, id: string) {
  const entry = (await readSessionIndex(path.join(homeDir, ".acpx", "sessions")))?.entries.find(
    (e) => e.acpxRecordId === id,
  );
  assert.ok(entry, `positive control: the index has an entry for ${id}`);
  return {
    brick: entry.metadataBrick,
    validation: (entry as unknown as Record<string, unknown>).metadataBrickValidation,
  };
}

const SET_METADATA = (homeDir: string, id: string, value: string) => [
  "--cwd",
  path.join(homeDir, "workspace"),
  "--agent",
  MOCK_AGENT_COMMAND,
  "--format",
  "json",
  "sessions",
  "set-metadata",
  "--session-id",
  id,
  "brick",
  value,
];

test("F1 · `sessions set-metadata brick X` on a SEATED record re-points the SEAT: the next turn's ACPX_BRICK is X", async () => {
  await withTempHome(async (homeDir) => {
    await plantLinkedSeatAndHolder(
      homeDir,
      "f1-holder",
      { ref: SEAT_BRICK, validated: true },
      {
        brick: SEAT_BRICK,
        brick_validation: "validated",
      },
    );
    const out = await runCli(homeDir, SET_METADATA(homeDir, "f1-holder", NEW_BRICK));
    assert.equal(out.code, 0, out.stderr);
    assert.equal((await readSeatBrick(homeDir))?.ref, NEW_BRICK, "the seat row");
    assert.equal((await readCache(homeDir, "f1-holder"))?.brick, NEW_BRICK, "the cache");
    const reread = JSON.parse(
      await fs.readFile(path.join(homeDir, ".acpx", "sessions", "f1-holder.json"), "utf8"),
    ) as { seat_id?: string; metadata?: Record<string, string> };
    const ctx = await connectedSessionContext(seatedRecord(homeDir, "f1-holder", reread.metadata));
    assert.equal(ctx?.brick, NEW_BRICK, "the next turn's env");
  });
});

test("O3 · `sessions set-metadata brick X` of a container brick (full card over 1 MiB) writes the seat link VALIDATED", async () => {
  await withTempHome(async (homeDir) => {
    await plantLinkedSeatAndHolder(
      homeDir,
      "o3-holder",
      { ref: SEAT_BRICK, validated: true },
      {
        brick: SEAT_BRICK,
        brick_validation: "validated",
      },
    );
    const out = await runCli(homeDir, SET_METADATA(homeDir, "o3-holder", NEW_BRICK), {
      BRICK_SHIM_MODE: "ok",
      BRICK_SHIM_ID: NEW_BRICK,
      BRICK_SHIM_CARD_BYTES: String(2 * 1024 * 1024),
    });
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(await readSeatBrick(homeDir), { ref: NEW_BRICK, validated: true });
    assert.equal((await readCache(homeDir, "o3-holder"))?.brick_validation, "validated");
  });
});

test("F2 · `seats set-brick` writes the holder's cache AND its validation; the index follows; --unset clears both", async () => {
  await withTempHome(async (homeDir) => {
    await plantLinkedSeatAndHolder(
      homeDir,
      "f2-holder",
      { ref: SEAT_BRICK, validated: true },
      {
        brick: SEAT_BRICK,
        brick_validation: "validated",
      },
    );
    const setValidated = await runCli(homeDir, [
      "--format",
      "json",
      "seats",
      "set-brick",
      SEAT_ID,
      NEW_BRICK,
      "--validated",
    ]);
    assert.equal(setValidated.code, 0, setValidated.stderr);
    assert.deepEqual(
      {
        brick: (await readCache(homeDir, "f2-holder"))?.brick,
        v: (await readCache(homeDir, "f2-holder"))?.brick_validation,
      },
      { brick: NEW_BRICK, v: "validated" },
    );
    assert.deepEqual(await readIndexBrick(homeDir, "f2-holder"), {
      brick: NEW_BRICK,
      validation: "validated",
    });

    const setBare = await runCli(homeDir, [
      "--format",
      "json",
      "seats",
      "set-brick",
      SEAT_ID,
      SEAT_BRICK,
    ]);
    assert.equal(setBare.code, 0, setBare.stderr);
    assert.deepEqual(await readIndexBrick(homeDir, "f2-holder"), {
      brick: SEAT_BRICK,
      validation: "unvalidated",
    });

    const unset = await runCli(homeDir, [
      "--format",
      "json",
      "seats",
      "set-brick",
      SEAT_ID,
      "--unset",
    ]);
    assert.equal(unset.code, 0, unset.stderr);
    assert.equal(await readSeatBrick(homeDir), undefined);
    const cache = await readCache(homeDir, "f2-holder");
    assert.equal(cache?.brick, undefined, "the cache is cleared with the seat");
    assert.equal(cache?.brick_validation, undefined, "and so is its state word");
    assert.deepEqual(await readIndexBrick(homeDir, "f2-holder"), {
      brick: undefined,
      validation: undefined,
    });
  });
});

test("F3 · the validation state is rewritten on EVERY ref change: a ref that did not resolve is never `validated`", async () => {
  await withTempHome(async (homeDir) => {
    await plantLinkedSeatAndHolder(
      homeDir,
      "f3-holder",
      { ref: SEAT_BRICK, validated: true },
      {
        brick: SEAT_BRICK,
        brick_validation: "validated",
      },
    );
    const notFound = await runCli(homeDir, SET_METADATA(homeDir, "f3-holder", NEW_BRICK), {
      BRICK_SHIM_MODE: "not-found",
    });
    assert.equal(notFound.code, 0, notFound.stderr);
    assert.deepEqual(await readIndexBrick(homeDir, "f3-holder"), {
      brick: NEW_BRICK,
      validation: "unvalidated",
    });
    assert.equal((await readSeatBrick(homeDir))?.validated, false, "the seat's own state");

    const resolved = await runCli(homeDir, SET_METADATA(homeDir, "f3-holder", SEAT_BRICK), {
      BRICK_SHIM_MODE: "ok",
      BRICK_SHIM_ID: SEAT_BRICK,
    });
    assert.equal(resolved.code, 0, resolved.stderr);
    assert.deepEqual(await readIndexBrick(homeDir, "f3-holder"), {
      brick: SEAT_BRICK,
      validation: "validated",
    });
    assert.equal((await readSeatBrick(homeDir))?.validated, true);
  });
});

test("F3 · a SEAT-LESS record gets the state word on every set-metadata ref change too", async () => {
  await withTempHome(async (homeDir) => {
    await fs.mkdir(path.join(homeDir, "workspace"), { recursive: true });
    await writeSessionRecordFile(
      homeDir,
      seatedRecord(
        homeDir,
        "f3-seatless",
        { brick: SEAT_BRICK, brick_validation: "validated" },
        false,
      ),
    );
    const out = await runCli(homeDir, SET_METADATA(homeDir, "f3-seatless", NEW_BRICK), {
      BRICK_SHIM_MODE: "not-found",
    });
    assert.equal(out.code, 0, out.stderr);
    const cache = await readCache(homeDir, "f3-seatless");
    assert.deepEqual(
      { brick: cache?.brick, v: cache?.brick_validation },
      { brick: NEW_BRICK, v: "unvalidated" },
    );
  });
});
