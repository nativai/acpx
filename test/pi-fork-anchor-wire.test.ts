import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acpAdapterKind } from "../src/acp/agent-command.js";
import { HARNESS_FACTS } from "../src/acp/harness-capabilities.js";
import type { SessionMessage } from "../src/types.js";
import {
  type Fixture,
  loadFixture,
  toJsonl,
  totalViolations,
  violations,
} from "./pi-cut-helpers.js";
import { type Staged, adapterOps, forkFiles, forkOps, stage } from "./pi-wire-helpers.js";
import { withTempHome } from "./runtime-test-helpers.js";

// brick 4bf088a7 (TEST-PLAN A17–A20, §3) — the Pi cut through the REAL compiled CLI against a FAKE
// pi-acp that implements DESIGN §3 over a real (derived) pi file. The fake's command shape is
// `node …/pi-acp/dist/index.js`, the shape of `/opt/pi-acp/dist/index.js`: a synthetic `agent`
// command would never be classified as Pi and would prove nothing (acpx PROJECT.md).
//
// Every refusal row asserts all of: the named code, exit ≠ 0, NO record written, and no new file in
// the adapter's output directory (TEST-PLAN §0).

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

const SCRUBBED_ENV = [
  "ACPX_SESSION_URL",
  "ACPX_SESSION_RECORD_ID",
  "ACPX_SEAT_URL",
  "ACPX_SESSION_NAME",
  "ACPX_PARENT_SESSION_URL",
  "ACPX_PARENT_SEAT_URL",
  "ACPX_TASK_FOLDER",
  "ACPX_BRICK",
  "ACPX_BRICK_PATH",
  "ACPX_OWNER_LOG",
];

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ACPX_STATE_HOME: homeDir,
      ACPX_PI_BOX_AGENT_DIR: path.join(homeDir, "pi-agent"),
      ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    };
    for (const key of SCRUBBED_ENV) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const copyArgs = (s: Staged, extra: string[]): string[] => [
  "--cwd",
  s.cwd,
  "--agent",
  s.agentCommand,
  "--approve-all",
  "--format",
  "json",
  "sessions",
  "copy",
  "--from",
  s.id,
  "--ephemeral",
  ...extra,
];

async function recordIds(homeDir: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(homeDir, ".acpx", "sessions"));
  return entries.filter((n) => n.endsWith(".json") && n !== "index.json").toSorted();
}

type Copied = { id: string; record: Record<string, unknown>; stderr: string };

async function copyOk(homeDir: string, s: Staged, extra: string[]): Promise<Copied> {
  const result = await runCli(copyArgs(s, extra), homeDir);
  assert.equal(result.code, 0, `copy ${extra.join(" ")}: ${result.stderr}${result.stdout}`);
  const id = String(
    (JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as { acpxRecordId?: unknown })
      .acpxRecordId,
  );
  const record = JSON.parse(
    await fs.readFile(
      path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(id)}.json`),
      "utf8",
    ),
  ) as Record<string, unknown>;
  return { id, record, stderr: result.stderr };
}

/** Every refusal: the code, exit ≠ 0, no record written, nothing new in the adapter's output dir. */
async function copyRefused(
  homeDir: string,
  s: Staged,
  extra: string[],
  code: string,
): Promise<CliResult> {
  const records = await recordIds(homeDir);
  const files = await forkFiles(s);
  const result = await runCli(copyArgs(s, extra), homeDir);
  assert.notEqual(result.code, 0, `expected ${code}: ${result.stdout}`);
  assert.ok(
    (result.stdout + result.stderr).includes(code),
    `the refusal names ${code}: ${result.stderr}${result.stdout}`,
  );
  assert.deepEqual(await recordIds(homeDir), records, "no record was written");
  assert.deepEqual(await forkFiles(s), files, "no file appeared in the adapter's output dir");
  return result;
}

const INCIDENT = loadFixture("59f799ee");

test("the fake adapter's command is classified as Pi by acpx's own classifier (so these rows take the Pi branch)", async () => {
  await withTempHome("acpx-pi-wire-", async (homeDir) => {
    const s = await stage(homeDir, INCIDENT);
    assert.equal(acpAdapterKind(s.agentCommand), "pi");
  });
});
const lineOf = (n: number): number => INCIDENT.answers.find((a) => a.n === n)?.line as number;
const entryIdOf = (n: number): string => INCIDENT.answers.find((a) => a.n === n)?.entryId as string;

async function forkFileOf(s: Staged): Promise<string> {
  const files = await forkFiles(s);
  assert.equal(files.length, 1, `one fork file, got ${files.join(",")}`);
  return await fs.readFile(path.join(s.outDir, files[0]), "utf8");
}

/** pi appends its own `thinking_level_change` after a file it opens: the last MESSAGE is the cut. */
function lastMessageId(forkFile: string): string | undefined {
  const messages = forkFile
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { id?: string; type?: string; message?: unknown })
    .filter((row) => row.type === "message");
  return messages.at(-1)?.id;
}

// ── A17 + negative 1: a fork at a cut after a mid-turn steer holds exactly the copy and nothing later ──

for (const n of [16, 17, 18, 19, 20, 21]) {
  test(`A2–A5 end to end: --at-log-index ${n} sends forkAfterEntryId ${entryIdOf(n)} and the fork file ends there`, async () => {
    await withTempHome("acpx-pi-wire-", async (homeDir) => {
      const s = await stage(homeDir, INCIDENT);
      const copied = await copyOk(homeDir, s, ["--at-log-index", String(n)]);
      const forks = await forkOps(s);
      assert.equal(forks.length, 1);
      // A17: the entry id, and NEVER an index — the request is the whole contract.
      assert.deepEqual(forks[0].meta?.acpx, { forkAfterEntryId: entryIdOf(n) });
      const forkFile = await forkFileOf(s);
      assert.equal(
        lastMessageId(forkFile),
        entryIdOf(n),
        "the fork's last message is the proved entry",
      );
      // The fork file is the source's prefix, line for line — and nothing later.
      const source = (await fs.readFile(s.piFile, "utf8")).split("\n").filter((l) => l.trim());
      const through = source.slice(
        0,
        source.findIndex((l) => l.includes(`"id":"${entryIdOf(n)}"`)) + 1,
      );
      assert.deepEqual(
        forkFile
          .split("\n")
          .filter((l) => l.trim())
          .slice(0, through.length),
        through,
      );
      // The independent checker: no pi user message the copy lacks, no tool id only later entries carry.
      const answer = INCIDENT.answers.find((a) => a.n === n);
      assert.equal(
        totalViolations(violations(INCIDENT, n, lineOf(n), answer?.contextEndLogIndex)),
        0,
      );
      // The record carries the cut, and the shortfall where there is one.
      const metadata = copied.record.metadata as Record<string, string> | undefined;
      assert.equal(metadata?.fork_context_end_log_index, answer?.contextEndLogIndex?.toString());
      assert.equal(copied.record.forked_at_message_index, n);
    });
  });
}

test("A3: right after the steer, the shortfall is on the record AND on stderr — it is never silent", async () => {
  await withTempHome("acpx-pi-wire-", async (homeDir) => {
    const s = await stage(homeDir, INCIDENT);
    const copied = await copyOk(homeDir, s, ["--at-log-index", "19"]);
    assert.equal(
      (copied.record.metadata as Record<string, string>).fork_context_end_log_index,
      "18",
    );
    assert.match(copied.stderr, /agent context ends at log index 18, before the record cut at 19/u);
  });
});

test("A3 negative: a cut with no shortfall writes no fork_context_end_log_index and prints no warning", async () => {
  await withTempHome("acpx-pi-wire-", async (homeDir) => {
    const s = await stage(homeDir, INCIDENT);
    const copied = await copyOk(homeDir, s, ["--at-log-index", "18"]);
    assert.equal(
      (copied.record.metadata as Record<string, string> | undefined)?.fork_context_end_log_index,
      undefined,
    );
    assert.doesNotMatch(copied.stderr, /agent context ends at/u);
  });
});

// ── negative 2: an unknown entry id refuses loudly ────────────────────────────────────────────

test("an unknown entry id is refused FORK_ENTRY_NOT_FOUND by the adapter and passes through: exit ≠ 0, no record, no fork file", async () => {
  await withTempHome("acpx-pi-wire-", async (homeDir) => {
    // The adapter's file carries different entry ids than the file acpx proved against: the id acpx
    // sends is unknown to it — exactly what pi-acp's validation exists for.
    const renamed = toJsonl(INCIDENT.pi).replaceAll(`"id":"${entryIdOf(18)}"`, '"id":"00000000"');
    const s = await stage(homeDir, INCIDENT);
    const adapterFile = path.join(homeDir, "adapter-view.jsonl");
    await fs.writeFile(adapterFile, renamed);
    const withOtherFile = {
      ...s,
      agentCommand: s.agentCommand.replace(JSON.stringify(s.piFile), JSON.stringify(adapterFile)),
    };
    await rewriteRecordCommand(homeDir, s.id, withOtherFile.agentCommand);
    const result = await copyRefused(
      homeDir,
      withOtherFile,
      ["--at-log-index", "18"],
      "FORK_ENTRY_NOT_FOUND",
    );
    assert.match(
      result.stdout + result.stderr,
      /"detailCode":"FORK_ENTRY_NOT_FOUND"|FORK_ENTRY_NOT_FOUND/u,
    );
  });
});

async function rewriteRecordCommand(
  homeDir: string,
  id: string,
  agentCommand: string,
): Promise<void> {
  const file = path.join(homeDir, ".acpx", "sessions", `${id}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8")) as { agent_command: string };
  record.agent_command = agentCommand;
  await fs.writeFile(file, `${JSON.stringify(record)}\n`);
}

// ── negative 3: an old adapter is never used by position ──────────────────────────────────────

test("an adapter that does not advertise fork-after-entry is refused FORK_ENTRY_UNSUPPORTED with ZERO session/fork calls, even on a misaligned cut", async () => {
  await withTempHome("acpx-pi-wire-", async (homeDir) => {
    const s = await stage(homeDir, INCIDENT, ["--no-advertise"]);
    const result = await copyRefused(
      homeDir,
      s,
      ["--at-log-index", "18"],
      "FORK_ENTRY_UNSUPPORTED",
    );
    assert.match(result.stdout + result.stderr, /does not advertise fork-after-entry/u);
    assert.deepEqual(
      await forkOps(s),
      [],
      "the adapter was never asked to fork — no index fallback",
    );
    assert.ok(
      (await adapterOps(s)).some((op) => op.method === "initialize"),
      "the adapter was reached and asked its capabilities",
    );
  });
});

test("an adapter that advertises the capability but drops the echo is refused FORK_ENTRY_UNSUPPORTED after the fork, and no record is written", async () => {
  await withTempHome("acpx-pi-wire-", async (homeDir) => {
    const s = await stage(homeDir, INCIDENT, ["--drop-echo"]);
    const records = await recordIds(homeDir);
    const result = await runCli(copyArgs(s, ["--at-log-index", "18"]), homeDir);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /FORK_ENTRY_UNSUPPORTED/u);
    assert.match(result.stdout + result.stderr, /did not echo the entry/u);
    assert.equal((await forkOps(s)).length, 1, "it WAS asked once: only the echo can tell");
    assert.deepEqual(await recordIds(homeDir), records, "no record was written");
  });
});

test("an advertising adapter with the echo gets the entry id in the request even when an index would have aligned (n=16)", async () => {
  await withTempHome("acpx-pi-wire-", async (homeDir) => {
    const s = await stage(homeDir, INCIDENT);
    await copyOk(homeDir, s, ["--at-log-index", "16"]);
    const [fork] = await forkOps(s);
    assert.equal(fork.meta?.acpx?.forkAtMessageIndex, undefined, "never an index, aligned or not");
    assert.equal(fork.meta?.acpx?.forkAfterEntryId, "dd600183");
  });
});

// ── A18: copy-all and a cut at 0 are unchanged ────────────────────────────────────────────────

test("A18: copy-all sends no cut field at all, and a cut at 0 is a fresh session (no fork)", async () => {
  await withTempHome("acpx-pi-wire-", async (homeDir) => {
    const s = await stage(homeDir, INCIDENT);
    await copyOk(homeDir, s, []);
    const [all] = await forkOps(s);
    assert.equal(all.meta?.acpx?.forkAfterEntryId, undefined);
    assert.equal(all.meta?.acpx?.forkAtMessageIndex, undefined);
  });
  await withTempHome("acpx-pi-wire-", async (homeDir) => {
    const s = await stage(homeDir, INCIDENT);
    await copyOk(homeDir, s, ["--at-log-index", "0"]);
    assert.deepEqual(await forkOps(s), [], "a cut at 0 forks nothing");
    assert.ok((await adapterOps(s)).some((op) => op.method === "session/new"));
  });
});

test("A18: a no-advertise adapter still does a WHOLE copy — only the cut is refused", async () => {
  await withTempHome("acpx-pi-wire-", async (homeDir) => {
    const s = await stage(homeDir, INCIDENT, ["--no-advertise"]);
    await copyOk(homeDir, s, []);
    assert.equal((await forkOps(s)).length, 1);
  });
});

// ── A16: legacy --at-index on Pi ──────────────────────────────────────────────────────────────

test("A16: --at-index k on a source within its window is the same fork as --at-log-index k", async () => {
  const forkMeta = async (flag: string): Promise<unknown> =>
    await withTempHome("acpx-pi-wire-", async (homeDir) => {
      const s = await stage(homeDir, INCIDENT);
      await copyOk(homeDir, s, [flag, "18"]);
      return (await forkOps(s))[0].meta?.acpx;
    });
  assert.deepEqual(await forkMeta("--at-index"), await forkMeta("--at-log-index"));
  assert.deepEqual(await forkMeta("--at-index"), { forkAfterEntryId: entryIdOf(18) });
});

test("A16 negative: --at-index on a Pi source longer than its 200-entry window is refused — pi would count from the start of its file", async () => {
  await withTempHome("acpx-pi-wire-", async (homeDir) => {
    const long: SessionMessage[] = Array.from({ length: 260 }, (_, i) =>
      i % 2 === 0
        ? { User: { id: `u${i}`, content: [{ Text: `question ${i}` }] } }
        : { Agent: { content: [{ Text: `answer ${i}` }], tool_results: {} } },
    );
    const fixture: Fixture = {
      ...INCIDENT,
      id: "00000000-long-source",
      entries: long,
      pi: [],
      answers: [],
    };
    const s = await stage(homeDir, fixture, [], long, "");
    const result = await copyRefused(homeDir, s, ["--at-index", "100"], "--at-log-index");
    assert.match(result.stdout + result.stderr, /pi counts from the start of its file/u);
    assert.deepEqual(
      (await adapterOps(s)).filter((op) => op.method !== "initialize"),
      [],
      "refused before the adapter was asked to create or fork anything",
    );
  });
});

// ── A20: the capability cell ──────────────────────────────────────────────────────────────────

test("A20: pi's fork.atIndex stays 'exact' with its MEASURED citation — it moves to the entry-id build only after the round trip", () => {
  const pi = HARNESS_FACTS.pi;
  assert.equal(pi.fork.atIndex, "exact");
  assert.equal(pi.fork.supported, true);
  const cited = pi.measuredAgainst.cellOverrides?.["fork.atIndex"];
  assert.ok(cited, "the cell is cited");
  assert.equal(cited.kind, "resolved-commit");
  // The citation names a commit someone MEASURED. A build nobody has round-tripped must not be cited
  // (harness-capabilities.ts, the `PI_FORK_BUILD` comment): this row goes red the day the cell is
  // moved without the TE's round trip being recorded in brick 4bf088a7's VERIFICATION.md.
  assert.equal((cited as { commit?: string }).commit, "af431c6");
});
