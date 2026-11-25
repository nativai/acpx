import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentSpawnOptions } from "../src/acp/client.js";
import { withInheritedSeatAutoName } from "../src/cli/session/inherited-metadata.js";
import {
  SEAT_AUTO_NAME_KEY,
  seatNameIsGeneric,
  withVerifiedSeatAutoName,
} from "../src/session/seat-display-name.js";
import type { SessionRecord } from "../src/types.js";
import { sessionFilePath } from "./runtime-test-helpers.js";
import { withTempHome } from "./temp-home.js";

// Brick fac2128a §4.2 (goal 3) — the generic-seat-name marker. A seat whose name no person gave is
// GENERIC (`seatNameIsGeneric`: unnamed, or equal to the holder's `metadata.seat_auto_name`), and only
// then does its agent learn `ACPX_SEAT_NAME_GENERIC=1` / `seats show … nameGeneric: true`. The rows that
// matter most are the negatives: a person-named seat must never read generic, or its agent renames it.

// ─── The predicate ──────────────────────────────────────────────────────────

const holder = (metadata?: Record<string, string>): Pick<SessionRecord, "metadata"> => ({
  metadata,
});

test("predicate: an unnamed seat is generic — with or without a holder, with or without a marker", () => {
  for (const name of [undefined, "", "   "]) {
    assert.equal(seatNameIsGeneric({ name }, undefined), true, JSON.stringify(name));
    assert.equal(seatNameIsGeneric({ name }, holder()), true, JSON.stringify(name));
    assert.equal(
      seatNameIsGeneric({ name }, holder({ [SEAT_AUTO_NAME_KEY]: "x" })),
      true,
      JSON.stringify(name),
    );
  }
});

test("predicate: a named seat is generic ONLY while the holder's marker equals its current name", () => {
  const marked = holder({ [SEAT_AUTO_NAME_KEY]: "alpha (fork)" });
  assert.equal(seatNameIsGeneric({ name: "alpha (fork)" }, marked), true, "equal ⇒ generic");
  assert.equal(seatNameIsGeneric({ name: "Steuer 2026" }, marked), false, "renamed ⇒ not generic");
  assert.equal(seatNameIsGeneric({ name: "alpha (fork)" }, holder()), false, "no key ⇒ not");
  assert.equal(seatNameIsGeneric({ name: "alpha (fork)" }, undefined), false, "no holder ⇒ not");
});

test("predicate: a person-chosen name that looks machine-made is not generic (no pattern matching)", () => {
  // Live seats carry these shapes as names agents and people CHOSE (CONCEPTION §4.1): without the
  // marker none of them may read generic, whatever it looks like.
  for (const name of ["alpha (fork)", "alpha (fork 2)", "tg-images-conception", "Beta · voice"]) {
    assert.equal(seatNameIsGeneric({ name }, holder({ brick: "x" })), false, name);
  }
});

test("withVerifiedSeatAutoName keeps the marker only when it names the stored name", () => {
  const meta = { [SEAT_AUTO_NAME_KEY]: "Foo", brick: "b" };
  assert.deepEqual(withVerifiedSeatAutoName(meta, "Foo"), meta, "equal ⇒ kept");
  assert.deepEqual(withVerifiedSeatAutoName(meta, "  Foo "), meta, "the -s trim is applied");
  assert.deepEqual(withVerifiedSeatAutoName(meta, "Bar"), { brick: "b" }, "differs ⇒ dropped");
  assert.deepEqual(withVerifiedSeatAutoName(meta, undefined), { brick: "b" }, "unnamed ⇒ dropped");
  assert.equal(withVerifiedSeatAutoName({ [SEAT_AUTO_NAME_KEY]: "Foo" }, "Bar"), undefined);
  assert.equal(withVerifiedSeatAutoName(undefined, "Foo"), undefined);
  assert.deepEqual(withVerifiedSeatAutoName({ brick: "b" }, "Foo"), { brick: "b" });
});

test("withInheritedSeatAutoName carries the predecessor's marker; a caller's own wins", () => {
  const source = { [SEAT_AUTO_NAME_KEY]: "gen (fork)", worktree_path: "/w" };
  assert.deepEqual(withInheritedSeatAutoName({ brick: "b" }, source), {
    brick: "b",
    [SEAT_AUTO_NAME_KEY]: "gen (fork)",
  });
  assert.deepEqual(withInheritedSeatAutoName(undefined, source), {
    [SEAT_AUTO_NAME_KEY]: "gen (fork)",
  });
  const own = { [SEAT_AUTO_NAME_KEY]: "mine" };
  assert.deepEqual(withInheritedSeatAutoName(own, source), own);
  assert.equal(withInheritedSeatAutoName(undefined, { brick: "b" }), undefined);
});

// ─── The spawn env ──────────────────────────────────────────────────────────

function withEnvVar<T>(name: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("env: seatNameGeneric=true exports ACPX_SEAT_NAME_GENERIC=1; false and no context STRIP an inherited one", () => {
  withEnvVar("ACPX_SEAT_NAME_GENERIC", "1", () => {
    const on = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "r",
      seatNameGeneric: true,
    });
    assert.equal(on.env.ACPX_SEAT_NAME_GENERIC, "1");
    const off = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, {
      acpxRecordId: "r",
      seatNameGeneric: false,
    });
    assert.equal(Object.hasOwn(off.env, "ACPX_SEAT_NAME_GENERIC"), false, "false ⇒ unset");
    const bare = buildAgentSpawnOptions("/tmp/acpx-agent", undefined, undefined);
    assert.equal(Object.hasOwn(bare.env, "ACPX_SEAT_NAME_GENERIC"), false, "no context ⇒ unset");
  });
});

// ─── Real CLI: create paths, seats show, rename, handover ──────────────────

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type CliResult = { code: number | null; stdout: string; stderr: string };
type Fixture = { home: string; cwd: string; envDump: string; agentCommand: string };

function runCli(
  args: string[],
  homeDir: string,
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    for (const key of Object.keys(env)) {
      // The caller's own session identity must not leak into the fixture — and a stale
      // ACPX_SEAT_NAME_GENERIC in the runner's env is exactly what the strip must defeat.
      if (key.startsWith("ACPX_") && key !== "ACPX_STATE_HOME" && !key.startsWith("ACPX_TEST_")) {
        delete env[key];
      }
    }
    Object.assign(env, { ACPX_SEAT_NAME_GENERIC: "1" }, extraEnv);
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: homeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withMockHome<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  return await withTempHome("acpx-seat-name-generic-", async (home) => {
    const cwd = path.join(home, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const envDump = path.join(home, "adapter-env.json");
    const agentCommand =
      `node ${JSON.stringify(MOCK_AGENT_PATH)} --supports-fork-session ` +
      `--env-dump-file ${JSON.stringify(envDump)}`;
    await fs.mkdir(path.join(home, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { codex: { command: agentCommand } } })}\n`,
      "utf8",
    );
    return await run({ home, cwd, envDump, agentCommand });
  });
}

type Created = { id: string; seatId: string };

function parseCreated(result: CliResult): Created {
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim()) as { acpxRecordId: string; seatId: string };
  assert.equal(typeof parsed.seatId, "string", result.stdout);
  return { id: parsed.acpxRecordId, seatId: parsed.seatId };
}

async function create(f: Fixture, extraArgs: string[] = []): Promise<Created> {
  await fs.rm(f.envDump, { force: true });
  return parseCreated(
    await runCli(
      ["--cwd", f.cwd, "--format", "json", "codex", "sessions", "new", ...extraArgs],
      f.home,
    ),
  );
}

async function copy(f: Fixture, from: string, extraArgs: string[] = []): Promise<Created> {
  await fs.rm(f.envDump, { force: true });
  return parseCreated(
    await runCli(
      [
        "--cwd",
        f.cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "copy",
        "--from",
        from,
        ...extraArgs,
      ],
      f.home,
    ),
  );
}

async function seatShow(
  f: Fixture,
  seatId: string,
): Promise<{ name: string | null; nameGeneric: boolean }> {
  const result = await runCli(["--format", "json", "seats", "show", seatId], f.home);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as { name: string | null; nameGeneric: boolean };
}

async function metadataOf(f: Fixture, id: string): Promise<Record<string, string>> {
  const stored = JSON.parse(await fs.readFile(sessionFilePath(f.home, id), "utf8")) as {
    metadata?: Record<string, string>;
  };
  return stored.metadata ?? {};
}

/** The env the adapter of the LAST spawn saw: `undefined` = the variable was not set. */
async function spawnedGenericVar(f: Fixture): Promise<string | undefined> {
  // readFile throws when no spawn wrote the dump — an absent var is only evidence if a spawn ran.
  const dump = JSON.parse(await fs.readFile(f.envDump, "utf8")) as Record<string, string>;
  return dump.ACPX_SEAT_NAME_GENERIC;
}

/**
 * A real record-backed turn — the spawn every later prompt takes. A create or copy leaves a WARM queue owner
 * whose adapter was spawned in the background (env = a spawn-time snapshot, by design), so `recover` first
 * kills it: the turn must cold-spawn an adapter from the record as it stands NOW. The dump must then name
 * this session's record id — proof it is that record-backed spawn, not the creation spawn's leftover.
 */
async function turnEnv(f: Fixture, id: string): Promise<string | undefined> {
  const recovered = await runCli(["--format", "json", "sessions", "recover", id], f.home);
  assert.equal(recovered.code, 0, recovered.stderr);
  await fs.rm(f.envDump, { force: true });
  const turn = await runCli(
    ["--cwd", f.cwd, "--approve-all", "--ttl", "0.01", "codex", "prompt", "--session-id", id, "hi"],
    f.home,
  );
  assert.equal(turn.code, 0, turn.stderr);
  const dump = JSON.parse(await fs.readFile(f.envDump, "utf8")) as Record<string, string>;
  assert.equal(dump.ACPX_SESSION_RECORD_ID, id, "the dump is this session's record-backed spawn");
  return dump.ACPX_SEAT_NAME_GENERIC;
}

test("REAL CLI: an unnamed `sessions new` is generic — creation env, turn env and seats show agree", async () => {
  await withMockHome(async (f) => {
    const s = await create(f);
    assert.equal(await spawnedGenericVar(f), "1", "creation spawn");
    const shown = await seatShow(f, s.seatId);
    assert.deepEqual(
      { name: shown.name, nameGeneric: shown.nameGeneric },
      { name: null, nameGeneric: true },
    );
    assert.equal(await turnEnv(f, s.id), "1", "record-backed turn");
  });
});

test("REAL CLI (negative): `-s Foo` — a person's name — is never generic, and the runner's stale var is stripped", async () => {
  await withMockHome(async (f) => {
    const s = await create(f, ["-s", "Foo"]);
    assert.equal(await spawnedGenericVar(f), undefined, "creation spawn");
    const shown = await seatShow(f, s.seatId);
    assert.deepEqual(
      { name: shown.name, nameGeneric: shown.nameGeneric },
      { name: "Foo", nameGeneric: false },
    );
    assert.equal(await turnEnv(f, s.id), undefined, "record-backed turn");
    const text = await runCli(["seats", "show", s.seatId], f.home);
    assert.match(text.stdout, /\n {2}name_generic: {2}no\n/);
  });
});

test("REAL CLI: a caller-passed marker is kept when it equals -s, DROPPED when it differs", async () => {
  await withMockHome(async (f) => {
    const kept = await create(f, ["-s", "tg-x-1", "--metadata", "seat_auto_name=tg-x-1"]);
    assert.equal((await metadataOf(f, kept.id)).seat_auto_name, "tg-x-1");
    assert.equal((await seatShow(f, kept.seatId)).nameGeneric, true);
    assert.equal(await turnEnv(f, kept.id), "1");

    const dropped = await create(f, ["-s", "Mein Name", "--metadata", "seat_auto_name=Other"]);
    assert.equal(Object.hasOwn(await metadataOf(f, dropped.id), "seat_auto_name"), false);
    assert.equal((await seatShow(f, dropped.seatId)).nameGeneric, false);
    assert.equal(await turnEnv(f, dropped.id), undefined);

    const unnamed = await create(f, ["--metadata", "seat_auto_name=Other"]);
    assert.equal(Object.hasOwn(await metadataOf(f, unnamed.id), "seat_auto_name"), false);
    assert.equal((await seatShow(f, unnamed.seatId)).nameGeneric, true, "unnamed stays generic");
  });
});

test("REAL CLI: a copy without -s marks acpx's own `(fork)` default; with -s it is not marked and never inherits the source's", async () => {
  await withMockHome(async (f) => {
    const source = await create(f, ["-s", "gen", "--metadata", "seat_auto_name=gen"]);
    assert.equal((await seatShow(f, source.seatId)).nameGeneric, true, "control: source generic");

    const fork = await copy(f, source.id);
    assert.equal((await seatShow(f, fork.seatId)).name, "gen (fork)");
    assert.equal((await metadataOf(f, fork.id)).seat_auto_name, "gen (fork)", "acpx's default");
    assert.equal((await seatShow(f, fork.seatId)).nameGeneric, true);
    assert.equal(await turnEnv(f, fork.id), "1");

    const named = await copy(f, source.id, ["-s", "Typed"]);
    assert.equal(
      Object.hasOwn(await metadataOf(f, named.id), "seat_auto_name"),
      false,
      "a copy does NOT inherit the source's marker",
    );
    assert.equal((await seatShow(f, named.seatId)).nameGeneric, false);
    assert.equal(await turnEnv(f, named.id), undefined);
  });
});

test("REAL CLI: `seats rename` ends genericness with no write to the marker", async () => {
  await withMockHome(async (f) => {
    const source = await create(f, ["-s", "base"]);
    const fork = await copy(f, source.id);
    assert.equal((await seatShow(f, fork.seatId)).nameGeneric, true, "control");
    const renamed = await runCli(["seats", "rename", fork.seatId, "Umsatzsteuer Q3"], f.home);
    assert.equal(renamed.code, 0, renamed.stderr);
    assert.equal((await seatShow(f, fork.seatId)).nameGeneric, false);
    assert.equal((await metadataOf(f, fork.id)).seat_auto_name, "base (fork)", "marker untouched");
    assert.equal(await turnEnv(f, fork.id), undefined, "the next spawn no longer says generic");
  });
});

test("REAL CLI: a handover (--from) of a generic seat carries the marker — the successor is still generic", async () => {
  await withMockHome(async (f) => {
    const source = await create(f, ["-s", "base"]);
    const generic = await copy(f, source.id);
    const successor = await create(f, ["--from", generic.id]);
    assert.equal(successor.seatId, generic.seatId, "control: the successor joined the same seat");
    assert.equal(await spawnedGenericVar(f), "1", "successor's creation spawn");
    assert.equal((await metadataOf(f, successor.id)).seat_auto_name, "base (fork)");
    assert.equal((await seatShow(f, generic.seatId)).nameGeneric, true);
    assert.equal(await turnEnv(f, successor.id), "1", "successor's record-backed turn");
  });
});

test("REAL CLI (negative, JOIN rule): a handover of a NAMED seat is not generic — its absent seatName is not 'unnamed'", async () => {
  await withMockHome(async (f) => {
    const named = await create(f, ["-s", "Person Choice"]);
    const successor = await create(f, ["--from", named.id]);
    assert.equal(successor.seatId, named.seatId, "control: joined");
    assert.equal(await spawnedGenericVar(f), undefined, "successor's creation spawn (a JOIN)");
    assert.equal(await turnEnv(f, successor.id), undefined);
    assert.equal((await seatShow(f, named.seatId)).nameGeneric, false);

    // A marker gone stale (seat renamed after a generic start) is dropped at the handover, not carried.
    const base = await create(f, ["-s", "b2"]);
    const fork = await copy(f, base.id);
    assert.equal((await runCli(["seats", "rename", fork.seatId, "Renamed"], f.home)).code, 0);
    const next = await create(f, ["--from", fork.id]);
    assert.equal(Object.hasOwn(await metadataOf(f, next.id), "seat_auto_name"), false);
    assert.equal(await spawnedGenericVar(f), undefined);
  });
});

test("REAL CLI: a JOIN (--seat) of an UNNAMED seat is generic", async () => {
  await withMockHome(async (f) => {
    const unnamed = await create(f);
    const joined = await create(f, ["--seat", unnamed.seatId]);
    assert.equal(joined.seatId, unnamed.seatId, "control: joined");
    assert.equal(await spawnedGenericVar(f), "1");
  });
});
