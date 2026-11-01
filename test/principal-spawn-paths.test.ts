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

// O1 (brick 509d3884): a session created INTO an existing seat from a bare shell, then activated. C8.2 rule 3
// makes its creator the seat's FIRST HOLDER, so it records that holder's answer — never `none`, which beat
// rule 3 in every reader and made the seat answer `no-creator`.
const QX = [
  "--metadata",
  "principal_via=started",
  "--metadata",
  `principal_id=${Q_ID}`,
  "--metadata",
  "principal_name=Daniel Laatz",
];

async function seatOf(f: Fixture, id: string): Promise<string> {
  const stored = JSON.parse(await fs.readFile(sessionFilePath(f.home, id), "utf8")) as {
    seat_id?: string;
  };
  assert.ok(stored.seat_id, `${id} holds a seat`);
  return stored.seat_id;
}

async function activate(f: Fixture, seat: string, successor: string): Promise<void> {
  const result = await runCli(
    ["--cwd", f.cwd, "--format", "json", "sessions", "activate", seat, successor, "--no-notify"],
    f.home,
  );
  assert.equal(result.code, 0, result.stderr);
}

test("O1: a bare-shell `sessions new --seat` + `sessions activate` answers the FIRST HOLDER's person, not `none`; the handover's create step still answers its predecessor's", async () => {
  await withMockHome(async (f) => {
    const first = await createChild(f, QX);
    const seat = await seatOf(f, first);
    const successor = await createChild(f, ["--seat", seat]);
    await activate(f, seat, successor);
    const stored = JSON.parse(await fs.readFile(sessionFilePath(f.home, successor), "utf8")) as {
      holder_ordinal?: number;
    };
    assert.equal(stored.holder_ordinal, 2, "the control: it really is the seat's second holder");
    assert.deepEqual(principalKeys(await metadataOf(f.home, successor)), {
      principal_via: "inherited",
      principal_id: Q_ID,
      principal_name: "Daniel Laatz",
      principal_from: first,
    });
    const read = await runCli(
      ["--format", "json", "people", "principal", "--session", successor],
      f.home,
    );
    assert.equal(read.code, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout), {
      principal: { id: Q_ID, name: "Daniel Laatz" },
      via: "inherited",
      from: first,
    });
    // the control beside it: `--from` (what `sessions handover` does) copies the PREDECESSOR's answer
    const handedOver = await createChild(f, ["--from", first]);
    assert.deepEqual(principalKeys(await metadataOf(f.home, handedOver)), {
      principal_via: "inherited",
      principal_id: Q_ID,
      principal_name: "Daniel Laatz",
      principal_from: first,
    });
  });
});

test("O1: the CALLER is not the creator of a seat successor — a person's session running `sessions new --seat` records the seat's first holder (C8.2 rule 3 outranks rule 4)", async () => {
  await withMockHome(async (f) => {
    const first = await createChild(f, QX);
    const seat = await seatOf(f, first);
    await seed(f, "caller-p", P);
    const successor = await createChild(f, ["--seat", seat], {
      ACPX_SESSION_URL: urlOf("caller-p"),
    });
    assert.deepEqual(principalKeys(await metadataOf(f.home, successor)), {
      principal_via: "inherited",
      principal_id: Q_ID,
      principal_name: "Daniel Laatz",
      principal_from: first,
    });
  });
});

// X-1 (brick 509d3884, TE): C8.2 rule 2 (`spawned_by_session_id`, which `--no-parent` writes) outranks rule 3,
// and atrium's walk has the same order — so the record must equal the walk: the CALLER, not the first holder.
test("X-1: `sessions new --seat <seat> --no-parent` inside another person's session records the CALLER (rule 2 over rule 3); the bare-shell `--no-parent` control records the first holder", async () => {
  await withMockHome(async (f) => {
    const first = await createChild(f, QX); // Laatz's seat
    const seat = await seatOf(f, first);
    await seed(f, "caller-p", P); // Brammertz's session
    const viaCaller = await createChild(f, ["--seat", seat, "--no-parent"], {
      ACPX_SESSION_URL: urlOf("caller-p"),
    });
    const stored = JSON.parse(await fs.readFile(sessionFilePath(f.home, viaCaller), "utf8")) as {
      spawned_by_session_id?: string;
      parent_session_id?: string;
    };
    assert.equal(
      stored.spawned_by_session_id,
      "caller-p",
      "the control: rule 2's field is written",
    );
    assert.equal(stored.parent_session_id, undefined, "and --no-parent dropped the parent edge");
    assert.deepEqual(principalKeys(await metadataOf(f.home, viaCaller)), {
      principal_via: "inherited",
      principal_id: P_ID,
      principal_name: "Daniel Brammertz",
      principal_from: "caller-p",
    });
    // the control: no caller means no spawned-by session, so rule 3 answers even with --no-parent
    const bare = await createChild(f, ["--seat", seat, "--no-parent"]);
    assert.deepEqual(principalKeys(await metadataOf(f.home, bare)), {
      principal_via: "inherited",
      principal_id: Q_ID,
      principal_name: "Daniel Laatz",
      principal_from: first,
    });
  });
});

test("O1: a first holder that answers nobody is inherited as nobody; one that predates the keys leaves NO principal_* (the walk answers) — never `none` over rule 3", async () => {
  await withMockHome(async (f) => {
    const nobody = await createChild(f); // a bare shell: records principal_via=none
    const nobodySeat = await seatOf(f, nobody);
    const onNobody = await createChild(f, ["--seat", nobodySeat]);
    assert.deepEqual(principalKeys(await metadataOf(f.home, onNobody)), {
      principal_via: "inherited",
      principal_from: nobody,
    });

    // a seat whose first holder records no principal (atrium's `started_by_*` create leaves it to atrium)
    const legacy = await createChild(f, ["--metadata", "started_by_kind=system"]);
    assert.deepEqual(
      principalKeys(await metadataOf(f.home, legacy)),
      {},
      "the control: none recorded",
    );
    const onLegacy = await createChild(f, ["--seat", await seatOf(f, legacy)]);
    assert.deepEqual(principalKeys(await metadataOf(f.home, onLegacy)), {});
  });
});

test("O1: explicit principal_* metadata on a create into a seat still wins byte for byte (atrium's own create paths)", async () => {
  await withMockHome(async (f) => {
    const first = await createChild(f, QX);
    const seat = await seatOf(f, first);
    const explicit = await createChild(f, [
      "--seat",
      seat,
      "--metadata",
      "principal_via=started",
      "--metadata",
      `principal_id=${P_ID}`,
      "--metadata",
      "principal_name=Daniel Brammertz",
    ]);
    assert.deepEqual(principalKeys(await metadataOf(f.home, explicit)), P);
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

test("no verb rewrites a recorded principal: sessions set-metadata refuses principal_* and leaves the record unchanged (C8.3, G1)", async () => {
  await withMockHome(async (f) => {
    await seed(f, "rec-wo", Q);
    const before = await fs.readFile(sessionFilePath(f.home, "rec-wo"), "utf8");
    for (const [key, value] of [
      ["principal_id", P_ID],
      ["principal_name", "Daniel Brammertz"],
      ["principal_via", "none"],
      ["principal_x", "anything"],
    ]) {
      const result = await runCli(
        ["--cwd", f.cwd, "codex", "sessions", "set-metadata", "--session-id", "rec-wo", key, value],
        f.home,
      );
      assert.equal(result.code, 2, `${key}: ${result.stderr}`);
      assert.match(result.stderr, /recorded once/u, key);
    }
    assert.equal(await fs.readFile(sessionFilePath(f.home, "rec-wo"), "utf8"), before);

    // positive control: the same verb writes an ordinary key, and the principal is untouched
    const ok = await runCli(
      [
        "--cwd",
        f.cwd,
        "codex",
        "sessions",
        "set-metadata",
        "--session-id",
        "rec-wo",
        "note",
        "hello",
      ],
      f.home,
    );
    assert.equal(ok.code, 0, ok.stderr);
    const metadata = await metadataOf(f.home, "rec-wo");
    assert.equal(metadata.note, "hello");
    assert.deepEqual(principalKeys(metadata), Q);
  });
});
