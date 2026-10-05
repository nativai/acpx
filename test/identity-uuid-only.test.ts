// brick 61dc1302 — D-IDENTITY: identity is the UUID; a name is a label.
//
// One committed RED per removed resolution path (R10/R11), each driven through the REAL CLI
// against the mock agent and asserted on the STORE (the other session's own bytes), never on
// a CLI line. Acceptance rows: AC-ID1..AC-ID4 of the conception's D-IDENTITY amendment.
//
// What each row guards, and what it is RED against (seat/program 1280ab60):
//   AC-ID1  a nameless `sessions new` changes NOTHING about an open session in the cwd
//           — GREEN on the old tree too: it is the eviction fix's row (4e58b35c), KEPT as the
//           control that the removal did not reintroduce a slot.
//   AC-ID2  `acpx <agent> "<prompt>"` with no session id is REFUSED, create form named
//           — red on old: the cwd walk found the session and delivered to it.
//   AC-ID3  one row per removed path (cwd walk · `-s` selector · positional name · cross-cwd
//           close-by-name · `sessions ensure` · cwd/name export · the library resolvers)
//   AC-ID4  `-s` names the SEAT on a fresh create and is REFUSED with `--seat`
//           — red on old: it named the session and was silently ignored on a join (F5).
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type CliRunResult = { code: number | null; stdout: string; stderr: string };

// Isolated by CONSTRUCTION: ACPX_STATE_HOME is pinned alongside HOME or an inherited value
// would win and these rows would run against the real store (brick://dd4cb0e8).
async function runCli(
  args: string[],
  homeDir: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_SEAT_URL",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A hang must read as a FAILURE (code null), never as a pending test.
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill("SIGKILL");
          }, options.timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end();
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const originalHome = process.env.HOME;
  const originalStateHome = process.env.ACPX_STATE_HOME;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-identity-"));
  process.env.HOME = tempHome;
  process.env.ACPX_STATE_HOME = tempHome;
  try {
    await fs.mkdir(path.join(tempHome, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(tempHome, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { codex: { command: MOCK_AGENT_COMMAND } } }, null, 2)}\n`,
      "utf8",
    );
    await run(tempHome);
  } finally {
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalStateHome == null) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = originalStateHome;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

const sessionsDir = (homeDir: string): string => path.join(homeDir, ".acpx", "sessions");
const recordPath = (homeDir: string, id: string): string =>
  path.join(sessionsDir(homeDir), `${encodeURIComponent(id)}.json`);

async function recordBytes(homeDir: string, id: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(recordPath(homeDir, id)))
    .digest("hex");
}

async function readRecord(homeDir: string, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(recordPath(homeDir, id), "utf8")) as Record<string, unknown>;
}

async function recordIds(homeDir: string): Promise<string[]> {
  const entries = await fs.readdir(sessionsDir(homeDir)).catch(() => [] as string[]);
  return entries
    .filter((name) => name.endsWith(".json") && name !== "index.json" && name !== "seats.json")
    .map((name) => decodeURIComponent(name.slice(0, -".json".length)))
    .toSorted();
}

type Created = { id: string; seatId: string };

async function newSession(
  homeDir: string,
  cwd: string,
  extra: string[] = [],
): Promise<Created & { result: CliRunResult }> {
  const result = await runCli(
    ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", ...extra],
    homeDir,
    { cwd },
  );
  assert.equal(result.code, 0, `sessions new failed: ${result.stderr}`);
  const id = (JSON.parse(result.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;
  const seatId = (await readRecord(homeDir, id)).seat_id;
  assert.equal(typeof seatId, "string", "the new record carries its seat id");
  return { id, seatId: seatId as string, result };
}

// seats.json is a flat map: seat id → persisted row.
async function seatRows(homeDir: string): Promise<Record<string, { name?: string }>> {
  return JSON.parse(
    await fs.readFile(path.join(sessionsDir(homeDir), "seats.json"), "utf8"),
  ) as Record<string, { name?: string }>;
}

async function workdir(homeDir: string, name: string): Promise<string> {
  const dir = path.join(homeDir, name);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

// ───────────────────────────────── AC-ID1 ─────────────────────────────────

test("AC-ID1: a nameless `sessions new` in a cwd holding an open session changes NOTHING about it", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const first = await newSession(homeDir, cwd);
    const before = await recordBytes(homeDir, first.id);

    const second = await newSession(homeDir, cwd);

    assert.notEqual(second.id, first.id);
    assert.equal(await recordBytes(homeDir, first.id), before, "the occupant's own bytes moved");
    assert.equal((await readRecord(homeDir, first.id)).closed, false);
    // And the same label twice is just two sessions (HOD-R43: a name is not a slot).
    const labelled = await newSession(homeDir, cwd, ["-s", "twin"]);
    const labelledBefore = await recordBytes(homeDir, labelled.id);
    const twin = await newSession(homeDir, cwd, ["-s", "twin"]);
    assert.notEqual(twin.id, labelled.id);
    assert.equal(await recordBytes(homeDir, labelled.id), labelledBefore);
  });
});

// ───────────────────────────────── AC-ID2 ─────────────────────────────────

test('AC-ID2: `acpx <agent> "<prompt>"` with no session id is REFUSED, create form named, nothing delivered', async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const occupant = await newSession(homeDir, cwd);
    const before = await recordBytes(homeDir, occupant.id);

    const result = await runCli(["--cwd", cwd, "codex", "hello there"], homeDir, { cwd });

    assert.notEqual(result.code, 0, "an id-less prompt must not succeed");
    assert.match(result.stderr, /--session-id/, "the refusal names the working form");
    assert.match(result.stderr, /acpx codex sessions new/, "the refusal names the create form");
    assert.equal(
      await recordBytes(homeDir, occupant.id),
      before,
      "the cwd's open session received a delivery it was never addressed for",
    );
  });
});

// ───────────────────────────────── AC-ID3 ─────────────────────────────────

test("AC-ID3 · cwd walk: a prompt from a SUBDIRECTORY of the session's cwd no longer routes up to it", async () => {
  await withTempHome(async (homeDir) => {
    const repo = await workdir(homeDir, "repo");
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    const sub = await workdir(homeDir, path.join("repo", "pkg", "deep"));
    const occupant = await newSession(homeDir, repo);
    const before = await recordBytes(homeDir, occupant.id);

    const result = await runCli(["--cwd", sub, "codex", "hello"], homeDir, { cwd: sub });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /sessions new/);
    assert.equal(await recordBytes(homeDir, occupant.id), before);
  });
});

test("AC-ID3 · `-s <name>` selector: refused, never looked up", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const named = await newSession(homeDir, cwd, ["-s", "alpha"]);
    const before = await recordBytes(homeDir, named.id);

    for (const args of [
      ["codex", "-s", "alpha", "hello"],
      ["codex", "cancel", "-s", "alpha"],
      ["codex", "status", "-s", "alpha"],
    ]) {
      const result = await runCli(["--cwd", cwd, ...args], homeDir, { cwd });
      assert.notEqual(result.code, 0, `${args.join(" ")} must be refused`);
      assert.match(result.stderr, /--session-id/, `${args.join(" ")}: ${result.stderr}`);
    }
    assert.equal(await recordBytes(homeDir, named.id), before, "a name addressed a session");
  });
});

test("AC-ID3 · positional name: `sessions close <name>` and `sessions close <uuid>` are refused and close NOTHING", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const named = await newSession(homeDir, cwd, ["-s", "worker"]);
    const before = await recordBytes(homeDir, named.id);

    const byName = await runCli(["--cwd", cwd, "codex", "sessions", "close", "worker"], homeDir, {
      cwd,
    });
    assert.notEqual(byName.code, 0);
    assert.match(byName.stderr, /--session-id/);

    const byUuid = await runCli(["--cwd", cwd, "codex", "sessions", "close", named.id], homeDir, {
      cwd,
    });
    assert.notEqual(byUuid.code, 0);
    assert.match(
      byUuid.stderr,
      new RegExp(`--session-id ${named.id}`),
      "a uuid positional gets the hint",
    );

    assert.equal(await recordBytes(homeDir, named.id), before);
    assert.equal((await readRecord(homeDir, named.id)).closed, false);
  });
});

test("AC-ID3 · cross-cwd close-by-name (L3 TE finding): from ANOTHER cwd, a name closes nothing", async () => {
  await withTempHome(async (homeDir) => {
    const cwdA = await workdir(homeDir, "repo-a");
    const cwdB = await workdir(homeDir, "repo-b");
    const victim = await newSession(homeDir, cwdA, ["-s", "shared-label"]);
    const before = await recordBytes(homeDir, victim.id);

    const result = await runCli(
      ["--cwd", cwdB, "codex", "sessions", "close", "shared-label"],
      homeDir,
      { cwd: cwdB },
    );

    assert.notEqual(result.code, 0, "the global name resolver is gone");
    assert.equal(await recordBytes(homeDir, victim.id), before, "another cwd's session was closed");
    assert.equal((await readRecord(homeDir, victim.id)).closed, false);
  });
});

test("AC-ID3 · every session-targeting verb with no id is refused with --session-id named", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const occupant = await newSession(homeDir, cwd);
    const before = await recordBytes(homeDir, occupant.id);

    for (const args of [
      ["codex", "status"],
      ["codex", "cancel"],
      ["codex", "set-mode", "plan"],
      ["codex", "sessions", "show"],
      ["codex", "sessions", "history"],
      ["codex", "sessions", "close"],
      ["codex", "sessions", "export", "--output", path.join(homeDir, "out.json")],
    ]) {
      const result = await runCli(["--cwd", cwd, ...args], homeDir, { cwd });
      assert.notEqual(result.code, 0, `${args.join(" ")} must be refused`);
      assert.match(result.stderr, /--session-id/, `${args.join(" ")}: ${result.stderr}`);
    }
    assert.equal(await recordBytes(homeDir, occupant.id), before);
    await assert.rejects(fs.access(path.join(homeDir, "out.json")), "an export wrote a file");
  });
});

test("AC-ID3 · `sessions ensure` is gone: refused, creates nothing, not listed", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const idsBefore = await recordIds(homeDir);

    const result = await runCli(
      ["--cwd", cwd, "codex", "sessions", "ensure", "--name", "backend"],
      homeDir,
      { cwd },
    );

    assert.notEqual(result.code, 0);
    assert.deepEqual(await recordIds(homeDir), idsBefore, "a deleted verb created a session");
    const help = await runCli(["--cwd", cwd, "codex", "sessions", "--help"], homeDir, { cwd });
    assert.doesNotMatch(help.stdout, /^\s+ensure\b/m);
  });
});

test("O10 · `sessions --help` no longer describes the deleted `ensure` verb", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const help = await runCli(["--cwd", cwd, "codex", "sessions", "--help"], homeDir, { cwd });
    assert.match(
      help.stdout,
      /create, or close sessions/,
      "positive control: the description line",
    );
    assert.doesNotMatch(help.stdout, /ensure/i);
  });
});

test("AC-ID3 · the library resolvers are gone from the session module", async () => {
  const persistence = (await import("../src/session/persistence.js")) as Record<string, unknown>;
  const session = (await import("../src/session/session.js")) as Record<string, unknown>;
  for (const name of [
    "findSession",
    "findSessionByDirectoryWalk",
    "findClosedSessionsByDirectoryWalk",
    "resolveSessionByExactName",
    "resolveGlobalSessionByName",
    "listCoClaimantSessions",
  ]) {
    assert.equal(persistence[name], undefined, `persistence still exports ${name}`);
    assert.equal(session[name], undefined, `session still exports ${name}`);
  }
  // Positive control: the id resolver this block must NOT have removed.
  assert.equal(typeof persistence.resolveSessionRecord, "function");
});

// ───────────────────────────────── AC-ID4 ─────────────────────────────────

test("AC-ID4: `-s` names the SEAT on a fresh create; the record carries NO name", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const created = await newSession(homeDir, cwd, ["-s", "alpha"]);

    assert.equal((await seatRows(homeDir))[created.seatId]?.name, "alpha");
    assert.equal("name" in (await readRecord(homeDir, created.id)), false, "a session got a name");
    const unnamed = await newSession(homeDir, cwd);
    assert.equal((await seatRows(homeDir))[unnamed.seatId]?.name, undefined);
  });
});

test("AC-ID4: `-s` with `--seat` is REFUSED, creates nothing, leaves the seat's name alone", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const first = await newSession(homeDir, cwd, ["-s", "alpha"]);
    const idsBefore = await recordIds(homeDir);

    const refused = await runCli(
      ["--cwd", cwd, "codex", "sessions", "new", "--seat", first.seatId, "-s", "beta"],
      homeDir,
      { cwd },
    );

    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /seats rename/, "the refusal names the verb that renames a seat");
    assert.deepEqual(await recordIds(homeDir), idsBefore, "a refused create left a record");
    assert.equal((await seatRows(homeDir))[first.seatId]?.name, "alpha");

    // Control: the same join WITHOUT `-s` works — the refusal is attributable to the flag.
    const joined = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--seat", first.seatId],
      homeDir,
      { cwd },
    );
    assert.equal(joined.code, 0, joined.stderr);
  });
});

// ───────────────────────── legacy `name` on old records ─────────────────────────

test("a legacy `name` on an old record is NOT surfaced and a rewrite drops it (D-NAME-HARD-MIGRATION)", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const created = await newSession(homeDir, cwd);
    // Age the record: an older acpx wrote `name` into it.
    const raw = await readRecord(homeDir, created.id);
    raw.name = "legacy label";
    await fs.writeFile(
      recordPath(homeDir, created.id),
      `${JSON.stringify(raw, null, 2)}\n`,
      "utf8",
    );

    const { resolveSessionRecord, writeSessionRecord } =
      await import("../src/session/persistence.js");
    const loaded = await resolveSessionRecord(created.id);
    // Read through a loose view: the type has no such field, which is the point.
    const view = loaded as unknown as Record<string, unknown>;
    assert.equal("name" in view, false);
    assert.equal("legacyName" in view, false);

    await writeSessionRecord(loaded);
    assert.equal(
      Object.hasOwn(await readRecord(homeDir, created.id), "name"),
      false,
      "a rewrite kept the name on the record",
    );

    // A WRONG-TYPED legacy name does not reject the record either.
    raw.name = 42;
    await fs.writeFile(
      recordPath(homeDir, created.id),
      `${JSON.stringify(raw, null, 2)}\n`,
      "utf8",
    );
    assert.equal((await resolveSessionRecord(created.id)).acpxRecordId, created.id);
  });
});

// ───────── GUARDS KEPT ALIVE (TE retirement audit, brick 61dc1302) ─────────
//
// Four legs rode inside rows that asserted the deleted name behaviour and were retired with
// them, while the behaviour itself is NOT deleted: it still holds at the tip, and nothing
// asserted it. Re-asserted here as id-addressed rows, GREEN on both sides of this change
// (they are not new behaviour), each pinning the TEXT and not only the exit code.

test("LG1: --session-id together with --session-url is refused, text names both flags", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const session = await newSession(homeDir, cwd);

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "codex",
        "sessions",
        "show",
        "--session-id",
        session.id,
        "--session-url",
        `https://acpx.devbox.nativai.de/?session=${session.id}`,
      ],
      homeDir,
      { cwd },
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /only one of --session-id or --session-url/i);
    // Control: either flag alone resolves the same session (so the refusal is the pair's).
    for (const selector of [
      ["--session-id", session.id],
      ["--session-url", `https://acpx.devbox.nativai.de/?session=${session.id}`],
    ]) {
      const ok = await runCli(
        ["--cwd", cwd, "--format", "json", "codex", "sessions", "show", ...selector],
        homeDir,
        { cwd },
      );
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal(
        (JSON.parse(ok.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId,
        session.id,
      );
    }
  });
});

test("LG2: a --session-url without ?session=<id> is refused, text names the missing query parameter", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    await newSession(homeDir, cwd);

    const result = await runCli(
      [
        "--cwd",
        cwd,
        "codex",
        "sessions",
        "show",
        "--session-url",
        "https://acpx.devbox.nativai.de/",
      ],
      homeDir,
      { cwd },
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /must include a non-empty \?session=<id>/i);
  });
});

test("LG3: a CLOSED session stays readable BY ID — status, show, history, export", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    const session = await newSession(homeDir, cwd);
    const closed = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "close", "--session-id", session.id],
      homeDir,
      { cwd },
    );
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal((await readRecord(homeDir, session.id)).closed, true, "precondition: closed");
    const bytes = await recordBytes(homeDir, session.id);
    const byId = ["--session-id", session.id];

    const show = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "show", ...byId],
      homeDir,
      { cwd },
    );
    assert.equal(show.code, 0, show.stderr);
    const shown = JSON.parse(show.stdout.trim()) as { acpxRecordId?: string; closed?: boolean };
    assert.equal(shown.acpxRecordId, session.id);
    assert.equal(shown.closed, true);

    const status = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "status", ...byId],
      homeDir,
      { cwd },
    );
    assert.equal(status.code, 0, status.stderr);
    const snapshot = JSON.parse(status.stdout.trim()) as { action?: string; status?: string };
    assert.equal(snapshot.action, "status_snapshot");
    assert.notEqual(snapshot.status, "no-session", "a closed session reads as absent by id");

    const history = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "history", ...byId],
      homeDir,
      { cwd },
    );
    assert.equal(history.code, 0, history.stderr);
    assert.equal((JSON.parse(history.stdout.trim()) as { id?: string }).id, session.id);

    const archivePath = path.join(homeDir, "closed-export.json");
    const exported = await runCli(
      [
        "--cwd",
        cwd,
        "--format",
        "json",
        "codex",
        "sessions",
        "export",
        ...byId,
        "--output",
        archivePath,
      ],
      homeDir,
      { cwd },
    );
    assert.equal(exported.code, 0, exported.stderr);
    const archive = JSON.parse(await fs.readFile(archivePath, "utf8")) as {
      session?: { record_id?: string };
    };
    assert.equal(archive.session?.record_id, session.id);

    assert.equal(await recordBytes(homeDir, session.id), bytes, "a read changed the record");
  });
});

test("LG4: `sessions new` exits even when the adapter ignores SIGTERM, and the record is stored", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = await workdir(homeDir, "repo");
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify(
        { agents: { codex: { command: `${MOCK_AGENT_COMMAND} --ignore-sigterm` } } },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new"],
      homeDir,
      { cwd, timeoutMs: 8_000 },
    );

    assert.equal(result.code, 0, `hung or failed (null = killed at 8s): ${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim()) as {
      action?: string;
      created?: boolean;
      acpxRecordId?: string;
    };
    assert.equal(payload.action, "session_ensured");
    assert.equal(payload.created, true);
    assert.equal(typeof payload.acpxRecordId, "string");
    const stored = await readRecord(homeDir, String(payload.acpxRecordId));
    assert.equal(stored.closed, false);
    assert.equal(stored.agent_command, `${MOCK_AGENT_COMMAND} --ignore-sigterm`);
  });
});
