import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord,
  sessionFilePath,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";
import { withTempHome } from "./temp-home.js";

// PERSON-CONTRACT C8.3 / C8.6, CONCEPTION §4.2 + §6.1, through the REAL compiled CLI and a mock ACP agent under a
// temp HOME: what each acpx create path records as `principal_*`, what a child's agent environment carries, and
// the guarantees with their committed negatives — a copy takes the CALLER's principal and never its source's
// (G2), a bare-shell child has NO ACPX_PRINCIPAL_* even when the caller's env carries one.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

const P_ID = "p-9df6e3afab610ff30d1a"; // Brammertz (V1)
const Q_ID = "p-fb566154c0bf245b7538"; // Laatz (V2)
const P = { principal_via: "started", principal_id: P_ID, principal_name: "Daniel Brammertz" };
const Q = { principal_via: "started", principal_id: Q_ID, principal_name: "Daniel Laatz" };

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(
  args: string[],
  homeDir: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
      "ACPX_PRINCIPAL_ID",
      "ACPX_PRINCIPAL_NAME",
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

type Fixture = { home: string; cwd: string; envDump: string; agentCommand: string };

async function withMockHome<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  return await withTempHome("acpx-principal-spawn-", async (home) => {
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

async function seed(
  fixture: Fixture,
  id: string,
  metadata: Record<string, string> | undefined,
  overrides: Partial<SessionRecord> = {},
): Promise<void> {
  await writeSessionRecordFile(
    fixture.home,
    makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `acp-${id}`,
      agentCommand: fixture.agentCommand,
      cwd: fixture.cwd,
      metadata,
      ...overrides,
    }),
  );
}

async function metadataOf(home: string, id: string): Promise<Record<string, string>> {
  const stored = JSON.parse(await fs.readFile(sessionFilePath(home, id), "utf8")) as {
    metadata?: Record<string, string>;
  };
  return stored.metadata ?? {};
}

function principalKeys(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => key.startsWith("principal_")),
  );
}

const urlOf = (id: string): string => `http://localhost:3456/?session=${id}`;

async function createChild(
  fixture: Fixture,
  extraArgs: string[] = [],
  env: Record<string, string | undefined> = {},
): Promise<string> {
  const result = await runCli(
    ["--cwd", fixture.cwd, "--format", "json", "codex", "sessions", "new", ...extraArgs],
    fixture.home,
    env,
  );
  assert.equal(result.code, 0, result.stderr);
  return (JSON.parse(result.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;
}

test("sessions new inside a person's session: the child is `inherited`, carries the person, and principal_from names the creator", async () => {
  await withMockHome(async (f) => {
    await seed(f, "par-p", P);
    const child = await createChild(f, [], { ACPX_SESSION_URL: urlOf("par-p") });
    const metadata = await metadataOf(f.home, child);
    assert.deepEqual(principalKeys(metadata), {
      principal_via: "inherited",
      principal_id: P_ID,
      principal_name: "Daniel Brammertz",
      principal_from: "par-p",
    });
    // the grandchild copies the child's answer; principal_from is the IMMEDIATE creator
    const grandchild = await createChild(f, [], { ACPX_SESSION_URL: urlOf(child) });
    assert.deepEqual(principalKeys(await metadataOf(f.home, grandchild)), {
      principal_via: "inherited",
      principal_id: P_ID,
      principal_name: "Daniel Brammertz",
      principal_from: child,
    });
    // and the offline verb reads it back through the real store
    const read = await runCli(
      ["--format", "json", "people", "principal", "--session", grandchild],
      f.home,
    );
    assert.equal(read.code, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), {
      principal: { id: P_ID, name: "Daniel Brammertz" },
      via: "inherited",
      from: child,
    });
  });
});

test("a creator that predates the keys gives nothing to copy: the child carries NO principal_* keys (the walk answers)", async () => {
  await withMockHome(async (f) => {
    await seed(f, "par-legacy", { brick: "11111111-2222-3333-4444-555555555555" });
    const child = await createChild(f, [], { ACPX_SESSION_URL: urlOf("par-legacy") });
    assert.deepEqual(principalKeys(await metadataOf(f.home, child)), {});
    const read = await runCli(["people", "principal", "--session", child], f.home);
    assert.equal(read.code, 6);
  });
});

test("a raw CLI in a bare shell records principal_via=none and nothing else; its child inherits `nobody`", async () => {
  await withMockHome(async (f) => {
    const top = await createChild(f);
    assert.deepEqual(principalKeys(await metadataOf(f.home, top)), { principal_via: "none" });
    const child = await createChild(f, [], { ACPX_SESSION_URL: urlOf(top) });
    assert.deepEqual(principalKeys(await metadataOf(f.home, child)), {
      principal_via: "inherited",
      principal_from: top,
    });
    const read = await runCli(
      ["--format", "json", "people", "principal", "--session", child],
      f.home,
    );
    assert.deepEqual(JSON.parse(read.stdout), { principal: null, via: "inherited", from: top });
  });
});

test("--no-parent drops the parent edge but the CALLER is still the creator: its principal is copied", async () => {
  await withMockHome(async (f) => {
    await seed(f, "par-np", P);
    const child = await createChild(f, ["--no-parent"], { ACPX_SESSION_URL: urlOf("par-np") });
    const stored = JSON.parse(await fs.readFile(sessionFilePath(f.home, child), "utf8")) as {
      parent_session_id?: string;
      spawned_by_session_id?: string;
    };
    assert.equal(stored.parent_session_id, undefined, "control: no parent edge was recorded");
    assert.equal(
      stored.spawned_by_session_id,
      "par-np",
      "control: the caller is the recorded creator",
    );
    assert.deepEqual(principalKeys(await metadataOf(f.home, child)), {
      principal_via: "inherited",
      principal_id: P_ID,
      principal_name: "Daniel Brammertz",
      principal_from: "par-np",
    });
  });
});

test("sessions new --from <old> (the handover create step) answers the OLD session's principal, not the caller's", async () => {
  await withMockHome(async (f) => {
    await seed(f, "old-q", Q);
    await seed(f, "caller-p", P);
    // the caller (P's session) creates a successor of Q's session: a seat successor answers its seat's principal
    const successor = await createChild(f, ["--from", "old-q"], {
      ACPX_SESSION_URL: urlOf("caller-p"),
    });
    assert.deepEqual(principalKeys(await metadataOf(f.home, successor)), {
      principal_via: "inherited",
      principal_id: Q_ID,
      principal_name: "Daniel Laatz",
      principal_from: "old-q",
    });
  });
});

test("explicit --metadata principal_* wins over the creator, byte for byte — atrium's own create paths pass it", async () => {
  await withMockHome(async (f) => {
    await seed(f, "par-x", P);
    const child = await createChild(
      f,
      [
        "--metadata",
        "principal_via=telegram",
        "--metadata",
        `principal_id=${Q_ID}`,
        "--metadata",
        "principal_name=Daniel Laatz",
      ],
      { ACPX_SESSION_URL: urlOf("par-x") },
    );
    assert.deepEqual(principalKeys(await metadataOf(f.home, child)), {
      principal_via: "telegram",
      principal_id: Q_ID,
      principal_name: "Daniel Laatz",
    });
  });
});

test("atrium creating for someone (started_by_*) leaves the principal to atrium: no `none` over its walk, no inheritance", async () => {
  await withMockHome(async (f) => {
    await seed(f, "par-y", P);
    const byAtrium = ["--metadata", "started_by_kind=human", "--metadata", "started_by_name=Ada"];
    const bare = await createChild(f, byAtrium);
    assert.deepEqual(principalKeys(await metadataOf(f.home, bare)), {});
    const underParent = await createChild(f, byAtrium, { ACPX_SESSION_URL: urlOf("par-y") });
    assert.deepEqual(principalKeys(await metadataOf(f.home, underParent)), {});
  });
});

const SOURCE_MESSAGES: SessionRecord["messages"] = [
  { User: { id: "user-1", content: [{ Text: "remember alpha" }] } },
  { Agent: { content: [{ Text: "alpha noted" }], tool_results: {} } },
];

async function copyOf(
  f: Fixture,
  source: string,
  env: Record<string, string | undefined>,
): Promise<{ id: string; stored: Record<string, unknown> }> {
  const result = await runCli(
    ["--cwd", f.cwd, "--format", "json", "codex", "sessions", "copy", "--from", source],
    f.home,
    env,
  );
  assert.equal(result.code, 0, result.stderr);
  const id = (JSON.parse(result.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;
  const stored = JSON.parse(await fs.readFile(sessionFilePath(f.home, id), "utf8")) as Record<
    string,
    unknown
  >;
  return { id, stored };
}

test("sessions copy takes the CALLER's principal, never the source's: source P, caller Q → the copy records Q (G2, PM-C8.3 n1)", async () => {
  await withMockHome(async (f) => {
    await seed(f, "src-p", P, { messages: SOURCE_MESSAGES, lastSeq: SOURCE_MESSAGES.length });
    await seed(f, "caller-q", Q);
    const { id, stored } = await copyOf(f, "src-p", { ACPX_SESSION_URL: urlOf("caller-q") });
    const metadata = (stored.metadata ?? {}) as Record<string, string>;
    assert.deepEqual(principalKeys(metadata), {
      principal_via: "inherited",
      principal_id: Q_ID,
      principal_name: "Daniel Laatz",
      principal_from: "caller-q",
    });
    // PM-C8.3 n2: the fork lineage is recorded, and never followed
    assert.equal(stored.forked_from_session_id, "src-p");
    for (const [key, value] of Object.entries(metadata)) {
      assert.ok(
        !value.includes(P_ID) && !value.includes("Brammertz"),
        `${key} leaks the source's person`,
      );
    }
    assert.ok(
      !JSON.stringify(metadata).includes("src-p"),
      "no principal key names the source session",
    );
    const read = await runCli(["--format", "json", "people", "principal", "--session", id], f.home);
    assert.equal((JSON.parse(read.stdout) as { principal: { id: string } }).principal.id, Q_ID);
  });
});

test("a copy made from a bare shell records `none` — still never the source's person (G2)", async () => {
  await withMockHome(async (f) => {
    await seed(f, "src-p2", P, { messages: SOURCE_MESSAGES, lastSeq: SOURCE_MESSAGES.length });
    const { stored } = await copyOf(f, "src-p2", {});
    assert.deepEqual(principalKeys((stored.metadata ?? {}) as Record<string, string>), {
      principal_via: "none",
    });
  });
});

async function readEnvDump(file: string): Promise<Record<string, string>> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, string>;
}

test("REAL OWNER PATH: ACPX_PRINCIPAL_* reaches the agent of a person-created session's child — and is absent in a bare-shell child even though the caller's env carries a person", async () => {
  await withMockHome(async (f) => {
    await seed(f, "par-env", Q);
    const personChild = await createChild(f, [], { ACPX_SESSION_URL: urlOf("par-env") });
    const bareChild = await createChild(f, [], {});

    for (const [id, expectPerson] of [
      [personChild, true],
      [bareChild, false],
    ] as const) {
      await fs.rm(f.envDump, { force: true });
      // The caller's OWN env carries Brammertz: a stale value must be replaced, or stripped, never inherited.
      const turn = await runCli(
        [
          "--cwd",
          f.cwd,
          "--approve-all",
          "--ttl",
          "0.01",
          "codex",
          "prompt",
          "--session-id",
          id,
          "hi",
        ],
        f.home,
        { ACPX_PRINCIPAL_ID: P_ID, ACPX_PRINCIPAL_NAME: "Daniel Brammertz" },
      );
      assert.equal(turn.code, 0, turn.stderr);
      const dump = await readEnvDump(f.envDump);
      const names = Object.keys(dump).filter((name) => name.startsWith("ACPX_PRINCIPAL_"));
      if (expectPerson) {
        assert.deepEqual(
          Object.fromEntries(names.map((name) => [name, dump[name]])),
          { ACPX_PRINCIPAL_ID: Q_ID, ACPX_PRINCIPAL_NAME: "Daniel Laatz" },
          "the child works for the creator chain's person, not for the caller's env",
        );
      } else {
        assert.deepEqual(
          names,
          [],
          "a bare-shell child has NO ACPX_PRINCIPAL_* — unset, not empty, and not the caller's",
        );
      }
    }
  });
});

// A stand-in for this box's acpx-ui message route (the handover POSTs its activation notice there): answers 202.
async function withAcpxUiStandIn(run: (origin: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ delivery_id: "delivery-1", status: "queued" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("sessions handover (the real verb): the successor answers its seat's principal — the predecessor's, G3", async () => {
  await withMockHome(async (f) => {
    // The predecessor is a real seated session carrying Q (atrium's shape: explicit principal_*).
    const old = await createChild(f, [
      "--metadata",
      "principal_via=started",
      "--metadata",
      `principal_id=${Q_ID}`,
      "--metadata",
      "principal_name=Daniel Laatz",
    ]);
    const brief = path.join(f.home, "brief.md");
    await fs.writeFile(brief, "Continue the work.\n", "utf8");
    await withAcpxUiStandIn(async (origin) => {
      const result = await runCli(
        [
          "--cwd",
          f.cwd,
          "--format",
          "json",
          "--approve-all",
          "codex",
          "sessions",
          "handover",
          "--brief",
          brief,
        ],
        f.home,
        {
          ACPX_SESSION_URL: urlOf(old),
          ACPX_UI_INTERNAL_URL: origin,
          ACPX_UI_BASE_URL: "https://atrium.example.test",
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const successor = (JSON.parse(result.stdout.trim()) as { successorId: string }).successorId;
      assert.notEqual(successor, old);
      assert.deepEqual(principalKeys(await metadataOf(f.home, successor)), {
        principal_via: "inherited",
        principal_id: Q_ID,
        principal_name: "Daniel Laatz",
        principal_from: old,
      });
    });
  });
});
