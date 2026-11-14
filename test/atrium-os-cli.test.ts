// P3a — per-session OS through the REAL CLI: `sessions new --os`, the creation precedence, `set-os`, the
// fallback notice and the primer alarm, asserted on what the spawned adapter actually received (the
// mock's env dump) and on the record AFTER A REAL TURN through the queue owner (acpx PROJECT.md: a new
// record key must survive a turn, not only `sessions new`). Spec: /wisdom/Bricks/f87fa15b-…/conception/
// IMPLEMENTATION-SPEC.md §12 (T1, T2, T4, T6, T7, T10, T11, T18, T21, T30).

import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { queuePaths } from "./queue-test-helpers.js";
import { sessionFilePath } from "./runtime-test-helpers.js";
import { withTempHome } from "./temp-home.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type CliResult = { code: number | null; stdout: string; stderr: string };
type Fixture = { home: string; cwd: string; envDump: string; osBase: string };

function runCli(
  args: string[],
  homeDir: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
      "ACPX_PRINCIPAL_ID",
      "ACPX_PRINCIPAL_NAME",
      "ACPX_SUBSCRIPTION",
      "ACPX_PROFILE",
      "CLAUDE_CONFIG_DIR",
      // the box's own OS knobs: every run here states its OS explicitly
      "ATRIUM_OS",
      "ATRIUM_OS_DEFAULT",
      "ACPX_AGENT_OS_BIN",
      "ACPX_SESSION_PRIMER_COMMAND",
      // a box default owner names a person the throwaway HOME's people file does not know
      "ACPX_DEFAULT_OWNER",
    ]) {
      delete env[key];
    }
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
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

/** An OS root (agents.md + a marked bin/ with a send-message.sh) under /workspace (§1.4 rule 4). */
function makeOsRoot(base: string, name: string, opts: { git?: boolean } = {}): string {
  const root = path.join(base, `${name} OS`);
  mkdirSync(path.join(root, "bin"), { recursive: true });
  writeFileSync(path.join(root, "agents.md"), `# ${name}\n`);
  writeFileSync(path.join(root, "bin", ".atrium-os-bin"), "");
  writeFileSync(path.join(root, "bin", "send-message.sh"), "#!/bin/sh\n", { mode: 0o755 });
  if (opts.git) {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    git("init", "-q");
    git("add", "-A");
    git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "os");
  }
  return root;
}

function headOf(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  // Explicit OS choices must be under /workspace/ with no dot-folder, so the roots live in projects/temp.
  mkdirSync("/workspace/projects/temp", { recursive: true });
  const osBase = mkdtempSync("/workspace/projects/temp/acpx-atrium-os-cli-");
  try {
    await withTempHome("acpx-atrium-os-cli-", async (home) => {
      const cwd = path.join(home, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const envDump = path.join(home, "adapter-env.json");
      // The mock at a real Claude adapter's path shape, so acpx renders the OS primer for it
      // (`resolvePrimerChannel` keys on the claude-agent-acp path).
      const entry = path.join(home, "claude-agent-acp", "dist", "index.mjs");
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.writeFile(
        entry,
        `await import(${JSON.stringify(pathToFileURL(MOCK_AGENT_PATH).href)});\n`,
      );
      const agentCommand =
        `node ${JSON.stringify(entry)} --supports-fork-session --supports-load-session ` +
        `--env-dump-file ${JSON.stringify(envDump)} ` +
        "--env-dump-extra ATRIUM_OS,ATRIUM_OS_DEFAULT,PATH";
      await fs.mkdir(path.join(home, ".acpx"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".acpx", "config.json"),
        `${JSON.stringify({ agents: { claude: { command: agentCommand } } })}\n`,
      );
      await run({ home, cwd, envDump, osBase });
    });
  } finally {
    rmSync(osBase, { recursive: true, force: true });
  }
}

/** The env the box default stands for in these tests: a fixture root, so nothing reads the real OS. */
function boxEnv(fixture: Fixture, extra: Record<string, string | undefined> = {}) {
  return {
    ATRIUM_OS_DEFAULT: path.join(fixture.osBase, "box OS"),
    // a fast primer that always renders, unless a test says otherwise
    ACPX_SESSION_PRIMER_COMMAND: path.join(fixture.osBase, "primer.sh"),
    ...extra,
  };
}

async function prepareBox(fixture: Fixture): Promise<string> {
  const box = makeOsRoot(fixture.osBase, "box");
  await fs.writeFile(path.join(fixture.osBase, "primer.sh"), "#!/bin/sh\necho PRIMER-OK\n", {
    mode: 0o755,
  });
  return box;
}

async function create(
  fixture: Fixture,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<string> {
  const result = await runCli(
    ["--cwd", fixture.cwd, "--format", "json", "claude", "sessions", "new", ...args],
    fixture.home,
    env,
  );
  assert.equal(result.code, 0, result.stderr);
  return (JSON.parse(result.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;
}

async function prompt(
  fixture: Fixture,
  id: string,
  text: string,
  env: Record<string, string | undefined>,
  ttl = "0.01",
): Promise<CliResult> {
  await fs.rm(fixture.envDump, { force: true });
  const result = await runCli(
    [
      "--cwd",
      fixture.cwd,
      "--approve-all",
      "--ttl",
      ttl,
      "--format",
      "quiet",
      "claude",
      "prompt",
      "--session-id",
      id,
      text,
    ],
    fixture.home,
    // A short-ttl turn is one whose owner should go away right after it: release at the next
    // idle check (5 s cadence) instead of the 5-minute default.
    ttl === "0.01" ? { ACPX_OWNER_IDLE_RELEASE_MS: "1", ...env } : env,
  );
  if (ttl === "0.01") {
    // The owner's idle exit is not instant: wait until its lease is gone, so the NEXT prompt is a
    // fresh agent start (a respawn) rather than a turn on the same owner — which is what these rows
    // mean by "the next agent start".
    await waitForOwnerGone(fixture, id);
  }
  return result;
}

async function waitForOwnerGone(fixture: Fixture, id: string): Promise<void> {
  const lockPath = queuePaths(fixture.home, id).lockPath;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const present = await fs.stat(lockPath).then(
      () => true,
      () => false,
    );
    if (!present) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`the queue owner of ${id} did not exit within 20 s`);
}

async function metadataOf(fixture: Fixture, id: string): Promise<Record<string, string>> {
  const stored = JSON.parse(await fs.readFile(sessionFilePath(fixture.home, id), "utf8")) as {
    metadata?: Record<string, string>;
  };
  return stored.metadata ?? {};
}

function osKeys(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => key.startsWith("atrium_os")),
  );
}

async function adapterEnv(fixture: Fixture): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(fixture.envDump, "utf8")) as Record<string, string>;
}

async function indexEntryOf(
  fixture: Fixture,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const index = JSON.parse(
    await fs.readFile(path.join(fixture.home, ".acpx", "sessions", "index.json"), "utf8"),
  ) as { entries: Record<string, unknown>[] };
  return index.entries.find((entry) => entry.acpxRecordId === id);
}

const urlOf = (id: string): string => `http://localhost:3456/?session=${id}`;

test("T1/T28 a session created without --os carries no atrium_os* key and no index atriumOs", async () => {
  await withFixture(async (f) => {
    const box = await prepareBox(f);
    const id = await create(f, [], boxEnv(f));
    assert.deepEqual(osKeys(await metadataOf(f, id)), {});
    assert.equal((await indexEntryOf(f, id))?.atriumOs, undefined);
    // ...and its agent runs on the box default root, with that root's bin first.
    const turn = await prompt(f, id, "echo hi", boxEnv(f));
    assert.equal(turn.code, 0, turn.stderr);
    const env = await adapterEnv(f);
    assert.equal(env.ATRIUM_OS, box);
    assert.equal(env.PATH?.split(":")[0], `${box}/bin`);
    // still no key after a real turn (the default root is a live folder: no revision)
    assert.deepEqual(osKeys(await metadataOf(f, id)), {});
  });
});

test("T1 negative: a caller whose own ATRIUM_OS differs from the box default stores it (rule 4)", async () => {
  await withFixture(async (f) => {
    await prepareBox(f);
    const b = makeOsRoot(f.osBase, "B");
    const id = await create(f, [], boxEnv(f, { ATRIUM_OS: b }));
    assert.equal((await metadataOf(f, id)).atrium_os, b);
  });
});

test("T21 --os survives a REAL TURN: the agent runs on it, the revision lands, the index projects both", async () => {
  await withFixture(async (f) => {
    await prepareBox(f);
    const b = makeOsRoot(f.osBase, "B", { git: true });
    const id = await create(f, ["--os", b], boxEnv(f));
    assert.equal((await metadataOf(f, id)).atrium_os, b);

    const turn = await prompt(f, id, "echo hi", boxEnv(f));
    assert.equal(turn.code, 0, turn.stderr);
    assert.match(turn.stdout, /hi/);
    const env = await adapterEnv(f);
    assert.equal(env.ATRIUM_OS, b);
    assert.equal(
      env.ATRIUM_OS_DEFAULT,
      path.join(f.osBase, "box OS"),
      "never written from a choice",
    );
    assert.equal(env.PATH?.split(":")[0], `${b}/bin`);
    assert.equal(env.PATH?.includes(path.join(f.osBase, "box OS", "bin")), false);

    const after = osKeys(await metadataOf(f, id));
    assert.deepEqual(after, { atrium_os: b, atrium_os_revision: headOf(b) });
    assert.deepEqual((await indexEntryOf(f, id))?.atriumOs, after);
  });
});

test("T4 --os refusals exit 2 and create nothing", async () => {
  await withFixture(async (f) => {
    await prepareBox(f);
    const sessionsDir = path.join(f.home, ".acpx", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const before = (await fs.readdir(sessionsDir))
      .filter((name) => name !== "index.json")
      .toSorted();
    for (const bad of ["/tmp/not-an-os", path.join(f.osBase, "missing")]) {
      const result = await runCli(
        ["--cwd", f.cwd, "claude", "sessions", "new", "--os", bad],
        f.home,
        boxEnv(f),
      );
      assert.equal(result.code, 2, `${bad}: ${result.stderr}`);
      assert.match(result.stderr, /--os/);
    }
    const after = (await fs.readdir(sessionsDir))
      .filter((name) => name !== "index.json")
      .toSorted();
    assert.deepEqual(after, before);
  });
});

test("T2 a child takes its parent's choice; a child of a DEFAULT parent ignores the caller's ATRIUM_OS", async () => {
  await withFixture(async (f) => {
    await prepareBox(f);
    const b = makeOsRoot(f.osBase, "B");
    const parent = await create(f, ["--os", b], boxEnv(f));
    const child = await create(f, [], boxEnv(f, { ACPX_SESSION_URL: urlOf(parent) }));
    assert.equal((await metadataOf(f, child)).atrium_os, b);
    // NEGATIVE: rule 3 beats rule 4 — the caller's shell says B, its record says default.
    const defaultParent = await create(f, [], boxEnv(f));
    const child2 = await create(
      f,
      [],
      boxEnv(f, { ACPX_SESSION_URL: urlOf(defaultParent), ATRIUM_OS: b }),
    );
    assert.equal((await metadataOf(f, child2)).atrium_os, undefined);
  });
});

test("T6 a --from successor keeps the predecessor's choice even when its caller is on default (M7)", async () => {
  await withFixture(async (f) => {
    await prepareBox(f);
    const b = makeOsRoot(f.osBase, "B");
    const defaultParent = await create(f, [], boxEnv(f));
    const predecessor = await create(
      f,
      ["--os", b],
      boxEnv(f, { ACPX_SESSION_URL: urlOf(defaultParent) }),
    );
    const successor = await create(
      f,
      ["--from", predecessor],
      boxEnv(f, { ACPX_SESSION_URL: urlOf(defaultParent) }),
    );
    assert.equal((await metadataOf(f, successor)).atrium_os, b);
  });
});

test("T7 a fork and a by-the-way take the SOURCE's choice, made by a default caller", async () => {
  await withFixture(async (f) => {
    await prepareBox(f);
    const b = makeOsRoot(f.osBase, "B");
    const source = await create(f, ["--os", b], boxEnv(f));
    for (const extra of [[], ["--ephemeral"]]) {
      const result = await runCli(
        [
          "--cwd",
          f.cwd,
          "--format",
          "json",
          "claude",
          "sessions",
          "copy",
          "--from",
          source,
          ...extra,
        ],
        f.home,
        boxEnv(f),
      );
      assert.equal(result.code, 0, result.stderr);
      const copy = (
        JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}") as {
          acpxRecordId?: string;
        }
      ).acpxRecordId;
      assert.ok(copy, result.stdout);
      assert.equal((await metadataOf(f, copy)).atrium_os, b, extra.join(" "));
      // the observation keys are never copied
      assert.equal((await metadataOf(f, copy)).atrium_os_revision, undefined);
    }
  });
});

test("T11 set-os: sets, defaults (deletes), refuses invalid with the record untouched; set-metadata is guarded", async () => {
  await withFixture(async (f) => {
    await prepareBox(f);
    const b = makeOsRoot(f.osBase, "B");
    const id = await create(f, [], boxEnv(f));
    const set = await runCli(["--format", "json", "sessions", "set-os", id, b], f.home, boxEnv(f));
    assert.equal(set.code, 0, set.stderr);
    assert.deepEqual(JSON.parse(set.stdout.trim()), {
      acpxRecordId: id,
      previous: "default",
      choice: b,
    });
    assert.equal((await metadataOf(f, id)).atrium_os, b);
    // the next agent start runs on it
    assert.equal((await prompt(f, id, "echo hi", boxEnv(f))).code, 0);
    assert.equal((await adapterEnv(f)).ATRIUM_OS, b);

    const bytes = await fs.readFile(sessionFilePath(f.home, id), "utf8");
    const bad = await runCli(["sessions", "set-os", id, "/tmp/not-an-os"], f.home, boxEnv(f));
    assert.equal(bad.code, 2, bad.stderr);
    assert.equal(await fs.readFile(sessionFilePath(f.home, id), "utf8"), bytes);

    const guard = await runCli(
      ["--cwd", f.cwd, "claude", "sessions", "set-metadata", "--session-id", id, "atrium_os", b],
      f.home,
      boxEnv(f),
    );
    assert.notEqual(guard.code, 0);
    assert.match(guard.stderr, /use acpx sessions set-os/);

    const text = await runCli(["sessions", "set-os", urlOf(id), "default"], f.home, boxEnv(f));
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /takes effect at the session's next agent start/);
    assert.equal((await metadataOf(f, id)).atrium_os, undefined);
  });
});

test("T30 `sessions set-os` with a missing argument is a usage error, never an agent prompt", async () => {
  await withFixture(async (f) => {
    const result = await runCli(["sessions", "set-os", "bogus"], f.home, {});
    assert.equal(result.code, 1, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /missing required argument 'choice'/);
  });
});

test("T10 a missing stored path falls back to the box default, says so once, and recovers by itself", async () => {
  await withFixture(async (f) => {
    const box = await prepareBox(f);
    const c = makeOsRoot(f.osBase, "C");
    const id = await create(f, ["--os", c], boxEnv(f));
    await fs.rm(path.join(c, "agents.md"));

    const first = await prompt(f, id, "echo hi", boxEnv(f), "30");
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /⟦OS-NOTICE⟧ This session's Operating System .*C OS was not found/);
    assert.equal((await adapterEnv(f)).ATRIUM_OS, box);
    const meta = await metadataOf(f, id);
    assert.equal(meta.atrium_os, c, "the stored choice is never changed by a fallback");
    assert.match(meta.atrium_os_fallback ?? "", /^\d{4}-\d{2}-\d{2}T/);
    // NEGATIVE: a second turn served by the SAME owner process carries no notice (once per spawn).
    const second = await prompt(f, id, "echo again", boxEnv(f), "30");
    assert.equal(second.code, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /OS-NOTICE/);
    assert.match(second.stdout, /again/);
  });
});

test("T10 recovery: once the path is back, the next agent start applies it and clears the fallback", async () => {
  await withFixture(async (f) => {
    await prepareBox(f);
    const c = makeOsRoot(f.osBase, "C");
    const id = await create(f, ["--os", c], boxEnv(f));
    await fs.rm(path.join(c, "agents.md"));
    assert.equal((await prompt(f, id, "echo hi", boxEnv(f))).code, 0);
    assert.ok((await metadataOf(f, id)).atrium_os_fallback);
    await fs.writeFile(path.join(c, "agents.md"), "# C\n");
    const back = await prompt(f, id, "echo hi", boxEnv(f));
    assert.equal(back.code, 0, back.stderr);
    assert.doesNotMatch(back.stdout, /OS-NOTICE/);
    assert.equal((await adapterEnv(f)).ATRIUM_OS, c);
    assert.equal((await metadataOf(f, id)).atrium_os_fallback, undefined);
  });
});

test("T18/T19 a failed primer render creates the session (real directory: alarm only), stamps it, notices it, and a good render clears it", async () => {
  await withFixture(async (f) => {
    await prepareBox(f);
    const failing = boxEnv(f, {
      ACPX_SESSION_PRIMER_COMMAND: path.join(f.osBase, "no-such-primer.sh"),
    });
    const id = await create(f, [], failing);
    const stamped = (await metadataOf(f, id)).atrium_os_primer_error;
    assert.match(stamped ?? "", /^\d{4}-\d{2}-\d{2}T\S+ (spawn failed|exec error)/);

    const turn = await prompt(f, id, "echo hi", failing);
    assert.equal(turn.code, 0, turn.stderr);
    assert.match(turn.stdout, /⟦OS-NOTICE⟧ Your Operating System primer did not load/);

    const good = await prompt(f, id, "echo hi", boxEnv(f));
    assert.equal(good.code, 0, good.stderr);
    assert.doesNotMatch(good.stdout, /OS-NOTICE/);
    assert.equal((await metadataOf(f, id)).atrium_os_primer_error, undefined);
  });
});

test("T18 negative: a deliberately suppressed primer (human --system-prompt) raises no alarm", async () => {
  await withFixture(async (f) => {
    await prepareBox(f);
    const failing = boxEnv(f, {
      ACPX_SESSION_PRIMER_COMMAND: path.join(f.osBase, "no-such-primer.sh"),
    });
    const result = await runCli(
      [
        "--cwd",
        f.cwd,
        "--format",
        "json",
        "--system-prompt",
        "You are a test.",
        "claude",
        "sessions",
        "new",
      ],
      f.home,
      failing,
    );
    assert.equal(result.code, 0, result.stderr);
    const id = (JSON.parse(result.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;
    assert.equal((await metadataOf(f, id)).atrium_os_primer_error, undefined);
  });
});
