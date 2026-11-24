import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sessionFilePath, withTempHome } from "./runtime-test-helpers.js";

// Brick 4bc23c1e — `acpx sessions handover` is at most once when it dies between writing the
// successor and activating it. Every row drives the compiled CLI against an isolated HOME and reads
// the result back from DISK and from the acpx-ui stand-in the delivery is POSTed to.
//
// The window is made by `ACPX_TEST_HANDOVER_DIE_AFTER_CREATE=1` (honoured only under NODE_TEST_CONTEXT):
// the handover SIGKILLs itself right after its create wrote the successor, before the activation.
//
// The contract (CONTRACTS-r4 C6.2) gives a handover no call id: "its retry safety rests on the seat".
// So the retry finds its own prepared successor by what the seat and the record say, and the rows
// below pin each side of that rule: adopt only this caller's never-activated, open successor.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const CLAUDE_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)} --claude-agent-acp --advertise-models --advertise-config-options --advertise-output-style`;
const ROW_TIMEOUT_MS = 300_000;
const OTHER_PREDECESSOR = "00000000-0000-4000-8000-000000000000";

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
      "ACPX_TEST_HANDOVER_DIE_AFTER_CREATE",
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
  id: string;
  seat_id?: string;
  holder_active?: boolean;
  holder_ordinal?: number;
  closed?: boolean;
  metadata?: Record<string, string>;
};

async function readStored(homeDir: string, id: string): Promise<Stored> {
  const record = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Stored;
  return { ...record, id };
}

async function sessionIds(homeDir: string): Promise<string[]> {
  const files = await fs.readdir(path.join(homeDir, ".acpx", "sessions"));
  return files
    .filter((f) => /^[0-9a-f-]{36}\.json$/.test(f))
    .map((f) => f.slice(0, -5))
    .toSorted();
}

/** Every record of `seatId`, in creation order of their ids' files. */
async function holdersOf(homeDir: string, seatId: string | undefined): Promise<Stored[]> {
  const out: Stored[] = [];
  for (const id of await sessionIds(homeDir)) {
    const record = await readStored(homeDir, id);
    if (record.seat_id === seatId) {
      out.push(record);
    }
  }
  return out;
}

/** A holder that exists in the seat but was never activated: no ordinal, not the active one, open. */
const isPrepared = (r: Stored): boolean =>
  r.holder_ordinal === undefined && r.holder_active !== true && r.closed !== true;

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

async function newHolder(homeDir: string, cwd: string): Promise<string> {
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
      ],
      homeDir,
    ),
  );
}

const url = (id: string): string => `https://atrium.example.test/?session=${id}`;

async function writeBrief(homeDir: string): Promise<string> {
  const file = path.join(homeDir, "HANDOVER.md");
  await fs.writeFile(file, `# Handover\n${"x".repeat(1_000)}`, "utf8");
  return file;
}

async function handover(
  homeDir: string,
  callerId: string,
  origin: string,
  brief: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return await runCli(
    ["--format", "json", "--approve-all", "claude", "sessions", "handover", "--brief", brief],
    homeDir,
    {
      ACPX_SESSION_URL: url(callerId),
      ACPX_UI_INTERNAL_URL: origin,
      ACPX_UI_BASE_URL: "https://atrium.example.test",
      ...extraEnv,
    },
  );
}

const DIE = { ACPX_TEST_HANDOVER_DIE_AFTER_CREATE: "1" };

/** Rewrite (or remove) the record's handover marker, as an older acpx or another predecessor would have left it. */
async function setMarker(homeDir: string, id: string, value: string | undefined): Promise<void> {
  const file = sessionFilePath(homeDir, id);
  const record = JSON.parse(await fs.readFile(file, "utf8")) as Omit<Stored, "id">;
  const metadata = { ...record.metadata };
  if (value === undefined) {
    delete metadata.handover_from;
  } else {
    metadata.handover_from = value;
  }
  record.metadata = metadata;
  await fs.writeFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

/** Kill a handover after its create; return the record id of the prepared successor it left. */
async function dieOnce(
  homeDir: string,
  seatId: string | undefined,
  callerId: string,
  origin: string,
  brief: string,
): Promise<string> {
  const known = new Set((await holdersOf(homeDir, seatId)).map((r) => r.id));
  const died = await handover(homeDir, callerId, origin, brief, DIE);
  assert.notEqual(died.code, 0, "fixture: the run died");
  const fresh = (await holdersOf(homeDir, seatId)).filter((r) => !known.has(r.id));
  assert.equal(fresh.length, 1, "fixture: the death left exactly one new record");
  return fresh[0].id;
}

test(
  "H1 a handover killed between the successor's write and its activation, then retried, ends with ONE successor — the first, activated — and one turn",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-handover-once-", async (homeDir) => {
      const cwd = await rig(homeDir);
      const callerId = await newHolder(homeDir, cwd);
      const seatId = (await readStored(homeDir, callerId)).seat_id;
      const brief = await writeBrief(homeDir);

      await withAcpxUi(async (origin, posted) => {
        const firstId = await dieOnce(homeDir, seatId, callerId, origin, brief);
        assert.equal(posted.length, 0, "fixture: the dying run delivered nothing");
        assert.ok(isPrepared(await readStored(homeDir, firstId)), "fixture: prepared");
        assert.equal(
          (await readStored(homeDir, callerId)).holder_active,
          true,
          "fixture: the caller is still the active holder",
        );

        const retry = await handover(homeDir, callerId, origin, brief);
        assert.equal(retry.code, 0, retry.stderr);
        const out = JSON.parse(retry.stdout.trim()) as { successorId: string };

        const holders = await holdersOf(homeDir, seatId);
        assert.equal(holders.length, 2, "the caller and ONE successor — no second successor");
        assert.equal(out.successorId, firstId, "the retry adopted the first successor");
        assert.equal(holders.filter(isPrepared).length, 0, "no prepared holder is left over");
        const successor = await readStored(homeDir, firstId);
        assert.equal(successor.holder_active, true, "activated");
        assert.equal(successor.holder_ordinal, 2);
        assert.equal((await readStored(homeDir, callerId)).holder_active, false, "caller retired");
        assert.equal(posted.length, 1, "exactly one turn, delivered by the retry");
        assert.equal(posted[0]?.url, `/api/sessions/${firstId}/message`);
        assert.ok(posted[0]?.body.text?.includes("⟦HANDOVER⟧"));
      });
    });
  },
);

test(
  "H2 a retry after a COMPLETED handover is still refused NOT_HOLDER and creates nothing",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-handover-once-done-", async (homeDir) => {
      const cwd = await rig(homeDir);
      const callerId = await newHolder(homeDir, cwd);
      const brief = await writeBrief(homeDir);
      await withAcpxUi(async (origin, posted) => {
        const first = await handover(homeDir, callerId, origin, brief);
        assert.equal(first.code, 0, first.stderr);
        const before = await sessionIds(homeDir);
        const turns = posted.length;

        const again = await handover(homeDir, callerId, origin, brief);
        assert.notEqual(again.code, 0);
        assert.equal((JSON.parse(again.stdout.trim()) as { code: string }).code, "NOT_HOLDER");
        assert.deepEqual(await sessionIds(homeDir), before, "nothing created");
        assert.equal(posted.length, turns, "nothing delivered");
      });
    });
  },
);

test(
  "H3 a prepared holder this handover did not make (a hand-run `sessions new --from`) is NOT adopted — a new successor is made and the other is named",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-handover-once-foreign-", async (homeDir) => {
      const cwd = await rig(homeDir);
      const callerId = await newHolder(homeDir, cwd);
      const seatId = (await readStored(homeDir, callerId)).seat_id;
      const handRunId = createdId(
        await runCli(
          [
            "--cwd",
            cwd,
            "--format",
            "json",
            "--approve-all",
            "claude",
            "sessions",
            "new",
            "--from",
            callerId,
          ],
          homeDir,
        ),
      );
      assert.ok(isPrepared(await readStored(homeDir, handRunId)), "fixture: a prepared holder");

      await withAcpxUi(async (origin) => {
        const res = await handover(homeDir, callerId, origin, await writeBrief(homeDir));
        assert.equal(res.code, 0, res.stderr);
        const successorId = String(JSON.parse(res.stdout.trim()).successorId);
        assert.notEqual(successorId, handRunId, "the hand-run holder was not adopted");
        assert.equal((await holdersOf(homeDir, seatId)).length, 3);
        assert.ok(isPrepared(await readStored(homeDir, handRunId)), "…and is left as it was");
        assert.ok(
          res.stderr.includes(handRunId),
          `the prepared holder is named on stderr: ${res.stderr}`,
        );
      });
    });
  },
);

test(
  "H4 a prepared successor with another predecessor's marker, with no marker (an older crash), or CLOSED is not adopted — the open ones are named, the closed one is not",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-handover-once-other-", async (homeDir) => {
      const cwd = await rig(homeDir);
      const callerId = await newHolder(homeDir, cwd);
      const seatId = (await readStored(homeDir, callerId)).seat_id;
      const brief = await writeBrief(homeDir);

      await withAcpxUi(async (origin) => {
        // Three deaths leave three orphans; each is changed, right after its death, to a shape the
        // retry must refuse (a run that left its orphan marked would adopt it on the next death).
        const oldCrash = await dieOnce(homeDir, seatId, callerId, origin, brief);
        await setMarker(homeDir, oldCrash, undefined);
        const otherPredecessor = await dieOnce(homeDir, seatId, callerId, origin, brief);
        await setMarker(homeDir, otherPredecessor, OTHER_PREDECESSOR);
        const closed = await dieOnce(homeDir, seatId, callerId, origin, brief);
        const closeRes = await runCli(
          ["--format", "json", "claude", "sessions", "close", "--session-id", closed],
          homeDir,
        );
        assert.equal(closeRes.code, 0, closeRes.stderr);
        assert.equal((await readStored(homeDir, closed)).closed, true, "fixture: closed");

        const res = await handover(homeDir, callerId, origin, brief);
        assert.equal(res.code, 0, res.stderr);
        const successorId = String(JSON.parse(res.stdout.trim()).successorId);
        assert.ok(
          ![oldCrash, otherPredecessor, closed].includes(successorId),
          "none of the three was adopted",
        );
        assert.equal((await holdersOf(homeDir, seatId)).length, 5, "a NEW successor was made");
        assert.ok(res.stderr.includes(oldCrash), `the unmarked orphan is named: ${res.stderr}`);
        assert.ok(
          res.stderr.includes(otherPredecessor),
          `the other predecessor's is named: ${res.stderr}`,
        );
        assert.ok(!res.stderr.includes(closed), "a closed holder is not a prepared one: not named");
      });
    });
  },
);

test(
  "H5 several of this caller's prepared successors: the NEWEST is adopted and the older one is named",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-handover-once-several-", async (homeDir) => {
      const cwd = await rig(homeDir);
      const callerId = await newHolder(homeDir, cwd);
      const seatId = (await readStored(homeDir, callerId)).seat_id;
      const brief = await writeBrief(homeDir);

      await withAcpxUi(async (origin, posted) => {
        const older = await dieOnce(homeDir, seatId, callerId, origin, brief);
        // Hide the first orphan from the second run, so the second death makes a second one.
        await setMarker(homeDir, older, OTHER_PREDECESSOR);
        const newer = await dieOnce(homeDir, seatId, callerId, origin, brief);
        await setMarker(homeDir, older, callerId);
        assert.notEqual(older, newer);

        const res = await handover(homeDir, callerId, origin, brief);
        assert.equal(res.code, 0, res.stderr);
        assert.equal(String(JSON.parse(res.stdout.trim()).successorId), newer, "the newest");
        assert.equal((await holdersOf(homeDir, seatId)).length, 3, "no third successor");
        assert.ok(res.stderr.includes(older), `the older orphan is named: ${res.stderr}`);
        assert.equal(posted.length, 1);
      });
    });
  },
);

// ── TE F1 (brick 4bc23c1e): two OVERLAPPING handovers from one caller ──────────────────────────────
// A pass-through repeat after a `255` can start while the first run is still alive. The activation
// compares against the CALLER: only the run that finds the seat still naming it activates; the other
// refuses and names its own prepared successor. Staggers include 0 (the two start together).

const OVERLAP_STAGGERS_MS = [0, 0, 0, 10, 25, 50, 100, 200];

test(
  "H6 two overlapping handovers from one caller: exactly ONE successor is activated, exactly ONE turn goes out, the other run refuses and leaves nothing active",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    for (const [trial, staggerMs] of OVERLAP_STAGGERS_MS.entries()) {
      await withTempHome(`acpx-handover-overlap-${trial}-`, async (homeDir) => {
        const cwd = await rig(homeDir);
        const callerId = await newHolder(homeDir, cwd);
        const seatId = (await readStored(homeDir, callerId)).seat_id;
        const brief = await writeBrief(homeDir);
        const label = `trial ${trial} (stagger ${staggerMs} ms)`;

        await withAcpxUi(async (origin, posted) => {
          const first = handover(homeDir, callerId, origin, brief);
          await new Promise((resolve) => setTimeout(resolve, staggerMs));
          const second = handover(homeDir, callerId, origin, brief);
          const results = await Promise.all([first, second]);

          const winners = results.filter((r) => r.code === 0);
          const losers = results.filter((r) => r.code !== 0);
          assert.equal(winners.length, 1, `${label}: exactly one run succeeds`);
          assert.equal(losers.length, 1, `${label}: the other refuses`);
          const loserCode = (JSON.parse((losers[0]?.stdout ?? "").trim()) as { code: string }).code;
          assert.ok(
            ["CONCURRENT_HANDOVER", "NOT_HOLDER"].includes(loserCode),
            `${label}: the loser names a reason (${loserCode})`,
          );
          const winnerId = JSON.parse((winners[0]?.stdout ?? "").trim()).successorId as string;

          const holders = await holdersOf(homeDir, seatId);
          const activated = holders.filter((r) => r.holder_ordinal !== undefined);
          assert.deepEqual(
            activated.map((r) => r.id).toSorted(),
            [callerId, winnerId].toSorted(),
            `${label}: only the caller and the winner were ever activated`,
          );
          assert.deepEqual(
            holders.filter((r) => r.holder_active === true).map((r) => r.id),
            [winnerId],
            `${label}: the winner is the one active holder`,
          );
          assert.equal((await readStored(homeDir, winnerId)).holder_ordinal, 2, label);
          assert.equal(posted.length, 1, `${label}: exactly one turn`);
          assert.equal(posted[0]?.url, `/api/sessions/${winnerId}/message`, label);
        });
      });
    }
  },
);

test(
  "H7 the loser of an overlap names the successor it left prepared, and a later retry does NOT adopt it (the caller is no longer the holder)",
  { timeout: ROW_TIMEOUT_MS },
  async () => {
    await withTempHome("acpx-handover-overlap-orphan-", async (homeDir) => {
      const cwd = await rig(homeDir);
      const callerId = await newHolder(homeDir, cwd);
      const seatId = (await readStored(homeDir, callerId)).seat_id;
      const brief = await writeBrief(homeDir);

      await withAcpxUi(async (origin, posted) => {
        const results = await Promise.all([
          handover(homeDir, callerId, origin, brief),
          handover(homeDir, callerId, origin, brief),
        ]);
        const loser = results.find((r) => r.code !== 0);
        assert.ok(loser, "one run refused");
        const before = await sessionIds(homeDir);
        const turns = posted.length;
        const prepared = (await holdersOf(homeDir, seatId)).filter(isPrepared);
        // The loser either created a successor it could not activate (named on its stderr), or lost at
        // its caller check before creating one.
        for (const orphan of prepared) {
          assert.ok(loser.stderr.includes(orphan.id), `named: ${loser.stderr}`);
        }

        const retry = await handover(homeDir, callerId, origin, brief);
        assert.notEqual(retry.code, 0);
        assert.equal((JSON.parse(retry.stdout.trim()) as { code: string }).code, "NOT_HOLDER");
        assert.deepEqual(await sessionIds(homeDir), before, "nothing created");
        assert.equal(posted.length, turns, "nothing delivered");
        for (const orphan of prepared) {
          assert.ok(isPrepared(await readStored(homeDir, orphan.id)), "the orphan is untouched");
        }
      });
    });
  },
);
