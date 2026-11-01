import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { konsiqPair, peopleDocument } from "./people-test-helpers.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// TEMPLATES CONCEPTION §2 AC1, AC3, AC5, AC6, AC9, AC15 (acpx half), AC16 and §11.5 #2-#5, against the REAL
// compiled CLI and a temp HOME. Every published guarantee has a committed NEGATIVE beside its positive.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const CLAUDE_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)} --claude-agent-acp --advertise-models --advertise-config-options --advertise-output-style --supports-fork-session`;

type CliResult = { code: number | null; stdout: string; stderr: string };

// With `--format json` a failure is a JSON-RPC error on STDOUT; the text form is on stderr. Read both.
function out(result: CliResult): string {
  return `${result.stdout}${result.stderr}`;
}

const SCRUBBED = [
  "ACPX_SESSION_URL",
  "ACPX_SESSION_NAME",
  "ACPX_PARENT_SESSION_URL",
  "ACPX_SEAT_URL",
  "ACPX_PARENT_SEAT_URL",
  "ACPX_TASK_FOLDER",
  "ACPX_BRICK",
  "ACPX_BRICK_PATH",
  "ACPX_OWNER_LOG",
  "ACPX_PEOPLE_FILE",
  "ACPX_PRINCIPAL_ID",
  "ACPX_PRINCIPAL_NAME",
  "ACPX_ACTOR_B64",
];

function runCli(
  args: string[],
  homeDir: string,
  extraEnv: Record<string, string | undefined> = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    for (const key of SCRUBBED) {
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

async function writeConfig(homeDir: string): Promise<void> {
  const subscriptionsRoot = path.join(homeDir, ".acpx", "subscriptions");
  await fs.mkdir(path.join(subscriptionsRoot, "sub1"), { recursive: true });
  await fs.writeFile(
    path.join(subscriptionsRoot, "registry.json"),
    `${JSON.stringify({
      version: 3,
      default: "sub1",
      profiles: [
        {
          id: "sub1",
          label: "sub1",
          authMode: "subscription",
          adapter: "claude",
          account: "acct-sub1",
          credentialSource: path.join(subscriptionsRoot, "sub1"),
        },
      ],
    })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({ agents: { claude: { command: CLAUDE_COMMAND } } })}\n`,
    "utf8",
  );
}

async function seedPeople(homeDir: string): Promise<{ brammertz: string; laatz: string }> {
  const { brammertz, laatz } = await konsiqPair();
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "people.json"),
    peopleDocument([brammertz, laatz]),
    "utf8",
  );
  return { brammertz: brammertz.id, laatz: laatz.id };
}

type Seed = {
  id: string;
  key?: string;
  version?: number;
  enabled?: boolean;
  closed?: boolean;
  createdAt?: string;
  extraTemplate?: Record<string, unknown>;
};

async function seedTemplate(homeDir: string, seed: Seed): Promise<void> {
  const cwd = path.join(homeDir, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const record = makeSessionRecord({
    acpxRecordId: seed.id,
    acpSessionId: `${seed.id}-acp`,
    agentName: "claude",
    agentCommand: CLAUDE_COMMAND,
    cwd,
    closed: seed.closed ?? true,
  });
  record.template = {
    enabled: seed.enabled ?? true,
    created_at: seed.createdAt ?? "2026-06-01T00:00:00.000Z",
    source_session_id: `${seed.id}-acp`,
    ...(seed.key === undefined ? {} : { slug: seed.key }),
    ...(seed.version === undefined ? {} : { version: seed.version }),
    ...seed.extraTemplate,
  };
  await writeSessionRecordFile(homeDir, record);
}

async function readTemplate(homeDir: string, id: string): Promise<Record<string, unknown>> {
  const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as {
    template?: Record<string, unknown>;
  };
  assert.ok(stored.template, `record ${id} has no template block`);
  return stored.template;
}

async function recordFiles(homeDir: string): Promise<string[]> {
  const dir = path.join(homeDir, ".acpx", "sessions");
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".json") && name !== "index.json").toSorted();
}

async function spawnFrom(
  homeDir: string,
  selector: string,
  env: Record<string, string | undefined> = {},
): Promise<{ result: CliResult; templateSource?: string }> {
  const result = await runCli(
    [
      "--format",
      "json",
      "--approve-all",
      "claude",
      "sessions",
      "new",
      "--from-template",
      selector,
      "--no-prompt",
    ],
    homeDir,
    env,
  );
  if (result.code !== 0) {
    return { result };
  }
  const created = (JSON.parse(result.stdout.trim()) as { acpxRecordId: string }).acpxRecordId;
  const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, created), "utf8")) as {
    metadata?: Record<string, string>;
  };
  return { result, templateSource: stored.metadata?.template_source };
}

// ---------------------------------------------------------------------------
// AC1 + AC3 — a personal template is reached by name, whoever asks
// ---------------------------------------------------------------------------

test("AC1/AC3: `--from-template laatz/reviewer` is Laatz's latest ENABLED version, for every caller, beside a higher machine-wide reviewer", async () => {
  await withTempHome("acpx-t1-ac1-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "mach-5", key: "reviewer", version: 5 });
    await seedTemplate(homeDir, { id: "laatz-1", key: `${ids.laatz}/reviewer`, version: 1 });
    await seedTemplate(homeDir, { id: "laatz-2", key: `${ids.laatz}/reviewer`, version: 2 });
    await seedTemplate(homeDir, {
      id: "laatz-3-off",
      key: `${ids.laatz}/reviewer`,
      version: 3,
      enabled: false,
    });
    await seedTemplate(homeDir, {
      id: "brammertz-1",
      key: `${ids.brammertz}/reviewer`,
      version: 9,
    });

    const callers: Array<[string, Record<string, string | undefined>]> = [
      ["Laatz's own agent", { ACPX_PRINCIPAL_ID: ids.laatz }],
      ["Brammertz's agent", { ACPX_PRINCIPAL_ID: ids.brammertz }],
      ["a bare shell (no principal)", {}],
    ];
    for (const [who, env] of callers) {
      const { result, templateSource } = await spawnFrom(homeDir, "laatz/reviewer", env);
      assert.equal(result.code, 0, `${who}: ${out(result)}`);
      assert.equal(
        templateSource,
        "laatz-2",
        `${who}: the trap is machine-wide reviewer (mach-5, higher version)`,
      );
    }
    // the plain name is still machine-wide, whatever personal chains exist
    const plain = await spawnFrom(homeDir, "reviewer", { ACPX_PRINCIPAL_ID: ids.laatz });
    assert.equal(plain.templateSource, "mach-5");
  });
});

test("AC1: the handle may be a former handle; the id of the template's record still works", async () => {
  await withTempHome("acpx-t1-former-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "laatz-1", key: `${ids.laatz}/reviewer`, version: 1 });
    const document = JSON.parse(
      await fs.readFile(path.join(homeDir, ".acpx", "people.json"), "utf8"),
    ) as {
      people: Record<string, { handle: string; former_handles: string[] }>;
    };
    document.people[ids.laatz].handle = "dlaatz";
    document.people[ids.laatz].former_handles = ["laatz"];
    await fs.writeFile(
      path.join(homeDir, ".acpx", "people.json"),
      JSON.stringify(document),
      "utf8",
    );
    assert.equal(
      (await spawnFrom(homeDir, "laatz/reviewer")).templateSource,
      "laatz-1",
      "a charter that wrote the old handle keeps working",
    );
    assert.equal((await spawnFrom(homeDir, "dlaatz/reviewer")).templateSource, "laatz-1");
    assert.equal(
      (await spawnFrom(homeDir, "laatz-1")).templateSource,
      "laatz-1",
      "an exact record id still resolves",
    );
  });
});

// ---------------------------------------------------------------------------
// AC5 — no hijack
// ---------------------------------------------------------------------------

test("AC5: a personal laatz/intaker at v99 never answers `--from-template intaker`", async () => {
  await withTempHome("acpx-t1-ac5-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "mach-38", key: "intaker", version: 38 });
    await seedTemplate(homeDir, { id: "laatz-99", key: `${ids.laatz}/intaker`, version: 99 });
    for (const env of [{ ACPX_PRINCIPAL_ID: ids.laatz }, {}]) {
      assert.equal((await spawnFrom(homeDir, "intaker", env)).templateSource, "mach-38");
    }
    // positive control: the personal record IS visible to resolution, so the negative above means something
    assert.equal((await spawnFrom(homeDir, "laatz/intaker")).templateSource, "laatz-99");
  });
});

test("AC5: with no machine-wide `reviewer`, the plain name finds nothing — it is never answered by a personal one", async () => {
  await withTempHome("acpx-t1-ac5b-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "laatz-1", key: `${ids.laatz}/reviewer`, version: 1 });
    const { result } = await spawnFrom(homeDir, "reviewer", { ACPX_PRINCIPAL_ID: ids.laatz });
    assert.notEqual(result.code, 0);
    assert.match(out(result), /no template matches 'reviewer'/);
  });
});

// ---------------------------------------------------------------------------
// AC9 — an unknown owner fails loudly and never falls back
// ---------------------------------------------------------------------------

test("AC9: `nosuch/reviewer` is an error naming the person; no session is created and nothing falls back", async () => {
  await withTempHome("acpx-t1-ac9-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "mach-1", key: "reviewer", version: 1 });
    await seedTemplate(homeDir, { id: "laatz-1", key: `${ids.laatz}/reviewer`, version: 1 });
    const before = await recordFiles(homeDir);

    const positive = await spawnFrom(homeDir, "laatz/reviewer");
    assert.equal(positive.templateSource, "laatz-1", "positive control");
    const afterPositive = await recordFiles(homeDir);
    assert.ok(afterPositive.length > before.length, "the positive control created its session");

    const { result } = await spawnFrom(homeDir, "nosuch/reviewer");
    assert.notEqual(result.code, 0);
    assert.match(out(result), /unknown person 'nosuch' in 'nosuch\/reviewer'/);
    assert.deepEqual(await recordFiles(homeDir), afterPositive, "nothing was created");
  });
});

test("AC9: a person with NO template of that name is 'no template matches' — never the machine-wide one", async () => {
  await withTempHome("acpx-t1-ac9b-", async (homeDir) => {
    await writeConfig(homeDir);
    await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "mach-1", key: "reviewer", version: 1 });
    const { result } = await spawnFrom(homeDir, "laatz/reviewer");
    assert.notEqual(result.code, 0);
    assert.match(out(result), /no template matches 'laatz\/reviewer'/);
  });
});

test("AC9: another box's person, and an ambiguous full name, are errors with their own words", async () => {
  await withTempHome("acpx-t1-ac9c-", async (homeDir) => {
    await writeConfig(homeDir);
    await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "mach-1", key: "reviewer", version: 1 });
    const other = await spawnFrom(homeDir, "laatz@otherbox/reviewer");
    assert.notEqual(other.result.code, 0);
    assert.match(
      out(other.result),
      /templates are per box: 'laatz@otherbox' names a person on otherbox/,
    );
    const suggest = await spawnFrom(homeDir, "laat/reviewer");
    assert.notEqual(suggest.result.code, 0);
    assert.match(out(suggest.result), /unknown person 'laat'/);
    assert.match(
      out(suggest.result),
      /did you mean:(?:\\n|\n)\s*laatz \(Daniel Laatz\) p-/,
      "the resolver's suggestions are shown, never chosen",
    );
  });
});

// ---------------------------------------------------------------------------
// AC16 — the id form needs no people list; the handle form never falls back
// ---------------------------------------------------------------------------

test("AC16: the id form resolves to the same record as the handle form, also with people.json absent", async () => {
  await withTempHome("acpx-t1-ac16-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "laatz-1", key: `${ids.laatz}/reviewer`, version: 1 });
    const viaHandle = await spawnFrom(homeDir, "laatz/reviewer");
    const viaId = await spawnFrom(homeDir, `${ids.laatz}/reviewer`);
    assert.equal(viaId.templateSource, viaHandle.templateSource);
    assert.equal(viaId.templateSource, "laatz-1");

    await fs.rm(path.join(homeDir, ".acpx", "people.json"));
    assert.equal(
      (await spawnFrom(homeDir, `${ids.laatz}/reviewer`)).templateSource,
      "laatz-1",
      "the id form reads no people list",
    );
    // the handle form with the list ABSENT is "unknown person" (an absent file is an empty list), never a fallback
    await seedTemplate(homeDir, { id: "mach-1", key: "reviewer", version: 1 });
    const absent = await spawnFrom(homeDir, "laatz/reviewer");
    assert.notEqual(absent.result.code, 0);
    assert.match(out(absent.result), /unknown person 'laatz'/);
  });
});

test("AC16: the handle form with people.json UNREADABLE fails loudly and never falls back to `reviewer`", async () => {
  await withTempHome("acpx-t1-ac16b-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "mach-1", key: "reviewer", version: 1 });
    await seedTemplate(homeDir, { id: "laatz-1", key: `${ids.laatz}/reviewer`, version: 1 });
    const file = path.join(homeDir, ".acpx", "people.json");
    for (const broken of ["{not json", JSON.stringify({ v: 2, people: {} })]) {
      await fs.writeFile(file, broken, "utf8");
      const before = await recordFiles(homeDir);
      const { result } = await spawnFrom(homeDir, "laatz/reviewer");
      assert.notEqual(result.code, 0);
      assert.match(out(result), /cannot resolve person 'laatz': people list unreadable/);
      assert.deepEqual(await recordFiles(homeDir), before, "no session was created");
      // the id form is unaffected by a broken list, and a plain name still works
      assert.equal((await spawnFrom(homeDir, `${ids.laatz}/reviewer`)).templateSource, "laatz-1");
      assert.equal((await spawnFrom(homeDir, "reviewer")).templateSource, "mach-1");
    }
  });
});

// ---------------------------------------------------------------------------
// The separator grammar's rejects
// ---------------------------------------------------------------------------

test("a qualified name must be exactly <person>/<canonical base>; the id leg is never tried for it", async () => {
  await withTempHome("acpx-t1-grammar-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "laatz-1", key: `${ids.laatz}/reviewer`, version: 1 });
    for (const typed of [
      "laatz/",
      "/reviewer",
      "laatz/reviewer/x",
      "laatz/Reviewer",
      "laatz/re viewer",
      `laatz/${"a".repeat(65)}`,
      "a/b/c",
    ]) {
      const before = await recordFiles(homeDir);
      const { result } = await spawnFrom(homeDir, typed);
      assert.notEqual(result.code, 0, typed);
      assert.match(out(result), /is not a template name/, typed);
      assert.deepEqual(await recordFiles(homeDir), before, typed);
    }
  });
});

// ---------------------------------------------------------------------------
// AC15 (acpx half) — an invalid owner never becomes machine-wide
// ---------------------------------------------------------------------------

test("AC15: a hand-edited `!!bad/reviewer` is in no list, never answers `reviewer`, and is reachable by exact id", async () => {
  await withTempHome("acpx-t1-ac15-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "bad-1", key: "!!bad/reviewer", version: 1 });
    // negative first: with NO machine-wide reviewer the plain name must find nothing
    const none = await spawnFrom(homeDir, "reviewer");
    assert.notEqual(none.result.code, 0);
    const list = await runCli(["--format", "json", "claude", "sessions", "templates"], homeDir, {
      ACPX_PRINCIPAL_ID: ids.laatz,
    });
    assert.equal(list.code, 0, out(list));
    assert.doesNotMatch(list.stdout, /bad-1/, "listed nowhere");
    assert.equal(
      (await spawnFrom(homeDir, "bad-1")).templateSource,
      "bad-1",
      "a trigger holding its exact id still fires",
    );
  });
});

// ---------------------------------------------------------------------------
// `sessions templates` — machine-wide plus the caller's own
// ---------------------------------------------------------------------------

test("`sessions templates` lists machine-wide + the principal's own; a bare shell sees machine-wide only", async () => {
  await withTempHome("acpx-t1-list-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "mach-1", key: "reviewer", version: 1 });
    await seedTemplate(homeDir, { id: "legacy-1" }); // slug-less: id-only, machine-wide
    await seedTemplate(homeDir, { id: "laatz-1", key: `${ids.laatz}/reviewer`, version: 1 });
    await seedTemplate(homeDir, {
      id: "brammertz-1",
      key: `${ids.brammertz}/reviewer`,
      version: 1,
    });
    const listed = async (env: Record<string, string | undefined>): Promise<string[]> => {
      const result = await runCli(
        ["--format", "json", "claude", "sessions", "templates"],
        homeDir,
        env,
      );
      assert.equal(result.code, 0, out(result));
      return (JSON.parse(result.stdout.trim()) as Array<{ acpxRecordId: string }>)
        .map((row) => row.acpxRecordId)
        .toSorted();
    };
    assert.deepEqual(await listed({}), ["legacy-1", "mach-1"], "bare shell: machine-wide only");
    assert.deepEqual(await listed({ ACPX_PRINCIPAL_ID: ids.laatz }), [
      "laatz-1",
      "legacy-1",
      "mach-1",
    ]);
    assert.deepEqual(await listed({ ACPX_PRINCIPAL_ID: ids.brammertz }), [
      "brammertz-1",
      "legacy-1",
      "mach-1",
    ]);
    assert.deepEqual(
      await listed({ ACPX_PRINCIPAL_ID: "not-a-person-id" }),
      ["legacy-1", "mach-1"],
      "a malformed principal is no principal",
    );
  });
});

// ---------------------------------------------------------------------------
// The mark verb: --owner, the fixed owner, a per-owner chain
// ---------------------------------------------------------------------------

async function seedCandidate(homeDir: string, id: string, closed = true): Promise<void> {
  const cwd = path.join(homeDir, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  await writeSessionRecordFile(
    homeDir,
    makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-acp`,
      agentName: "claude",
      agentCommand: CLAUDE_COMMAND,
      cwd,
      closed,
    }),
  );
}

type MarkResult = {
  slug?: string;
  owner?: string;
  agent_name?: string;
  version?: number;
  created_actor?: unknown;
  updated_actor?: unknown;
};

async function mark(
  homeDir: string,
  id: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ result: CliResult; json?: MarkResult }> {
  const result = await runCli(
    ["--format", "json", "claude", "sessions", "template", id, ...args],
    homeDir,
    env,
  );
  return result.code === 0
    ? { result, json: JSON.parse(result.stdout.trim()) as MarkResult }
    : { result };
}

test("--owner laatz --slug reviewer writes <id>/reviewer as v1 of Laatz's own chain, beside machine-wide v38", async () => {
  await withTempHome("acpx-t1-mark-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "mach-38", key: "reviewer", version: 38 });
    await seedCandidate(homeDir, "cand-1");
    await seedCandidate(homeDir, "cand-2");

    const first = await mark(homeDir, "cand-1", [
      "--enable",
      "--slug",
      "Reviewer",
      "--owner",
      "laatz",
    ]);
    assert.equal(first.result.code, 0, out(first.result));
    assert.equal(first.json?.slug, `${ids.laatz}/reviewer`);
    assert.equal(first.json?.owner, ids.laatz);
    assert.equal(first.json?.agent_name, "laatz/reviewer");
    assert.equal(
      first.json?.version,
      1,
      "a personal chain is not numbered after the machine-wide one",
    );

    const second = await mark(homeDir, "cand-2", [
      "--enable",
      "--slug",
      "reviewer",
      "--owner",
      ids.laatz,
    ]);
    assert.equal(second.json?.version, 2, "--owner takes the id too");
    assert.equal((await readTemplate(homeDir, "mach-38")).slug, "reviewer");

    const human = await runCli(
      ["claude", "sessions", "template", "cand-2", "--enable", "--slug", "reviewer"],
      homeDir,
    );
    assert.match(
      human.stdout,
      /enabled \(closed\) \[laatz\/reviewer v2\]/,
      "the agent name, never the person id",
    );
  });
});

test("a machine-wide mark (no --owner) is unchanged: plain key, owner box", async () => {
  await withTempHome("acpx-t1-mark-mw-", async (homeDir) => {
    await writeConfig(homeDir);
    await seedCandidate(homeDir, "cand-1");
    const marked = await mark(homeDir, "cand-1", ["--enable", "--slug", "Daily Triage"]);
    assert.equal(marked.json?.slug, "daily-triage");
    assert.equal(marked.json?.owner, "box");
    assert.equal(marked.json?.agent_name, "daily-triage");
  });
});

test("K8: a re-mark keeps the owner; a different --owner is refused BEFORE the session is closed and writes nothing", async () => {
  await withTempHome("acpx-t1-fixed-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedCandidate(homeDir, "cand-1");
    assert.equal(
      (await mark(homeDir, "cand-1", ["--enable", "--slug", "reviewer", "--owner", "laatz"])).json
        ?.version,
      1,
    );
    // re-open it, as a person would by working in it again, so the refusal's "stays open" is observable
    const file = sessionFilePath(homeDir, "cand-1");
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    stored.closed = false;
    delete stored.closed_at;
    await fs.writeFile(file, JSON.stringify(stored), "utf8");
    const before = await fs.readFile(file, "utf8");

    const refused = await mark(homeDir, "cand-1", [
      "--enable",
      "--slug",
      "reviewer",
      "--owner",
      "brammertz",
    ]);
    assert.notEqual(refused.result.code, 0);
    assert.match(out(refused.result), /a template's owner is fixed/);
    assert.equal(
      await fs.readFile(file, "utf8"),
      before,
      "byte-identical: not closed, not marked, not rewritten",
    );

    // positive controls: the SAME owner is fine, and no --owner keeps it
    assert.equal(
      (await mark(homeDir, "cand-1", ["--enable", "--owner", ids.laatz])).json?.slug,
      `${ids.laatz}/reviewer`,
    );
    assert.equal(
      (await mark(homeDir, "cand-1", ["--enable", "--slug", "reviewer"])).json?.version,
      1,
    );
  });
});

test("--owner needs a real person and a base: unknown, unlisted-id and slug-less marks are refused, session untouched", async () => {
  await withTempHome("acpx-t1-owner-bad-", async (homeDir) => {
    await writeConfig(homeDir);
    await seedPeople(homeDir);
    await seedCandidate(homeDir, "cand-1", false);
    const file = sessionFilePath(homeDir, "cand-1");
    const before = await fs.readFile(file, "utf8");
    const cases: Array<[string[], RegExp]> = [
      [
        ["--enable", "--slug", "reviewer", "--owner", "nosuch"],
        /unknown person 'nosuch' \(--owner\)/,
      ],
      [
        ["--enable", "--slug", "reviewer", "--owner", "p-0123456789abcdef0123"],
        /unknown person 'p-0123456789abcdef0123'/,
      ],
      [["--enable", "--slug", "reviewer", "--owner", "box"], /unknown person 'box'/],
      [["--enable", "--owner", "laatz"], /--owner needs --slug/],
      [["--enable", "--slug", "laatz/reviewer"], /contains '\/'/],
      [["--enable", "--slug", "a/b", "--owner", "laatz"], /contains '\/'/],
    ];
    for (const [args, message] of cases) {
      const { result } = await mark(homeDir, "cand-1", args);
      assert.notEqual(result.code, 0, args.join(" "));
      assert.match(out(result), message, args.join(" "));
      assert.equal(
        await fs.readFile(file, "utf8"),
        before,
        `${args.join(" ")}: the record is byte-identical`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// --disable is a soft retract (K10)
// ---------------------------------------------------------------------------

test("--disable keeps the block, slug, version and actors; --enable restores the SAME version; a disabled template never resolves", async () => {
  await withTempHome("acpx-t1-soft-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedCandidate(homeDir, "cand-1");
    const actor = { kind: "human", channel: "web", verified: true, name: "Daniel Laatz" };
    const env = { ACPX_ACTOR_B64: Buffer.from(JSON.stringify(actor)).toString("base64url") };
    await mark(
      homeDir,
      "cand-1",
      ["--enable", "--slug", "reviewer", "--owner", "laatz", "--auto-prompt", "review it"],
      env,
    );
    assert.equal((await spawnFrom(homeDir, "laatz/reviewer")).templateSource, "cand-1");

    const off = await runCli(
      ["--format", "json", "claude", "sessions", "template", "cand-1", "--disable"],
      homeDir,
    );
    assert.equal(off.code, 0, out(off));
    const block = await readTemplate(homeDir, "cand-1");
    assert.equal(block.enabled, false);
    assert.equal(block.slug, `${ids.laatz}/reviewer`);
    assert.equal(block.version, 1);
    assert.equal(block.auto_prompt, "review it");
    assert.deepEqual(block.created_actor, actor);
    const retracted = await spawnFrom(homeDir, "laatz/reviewer");
    assert.notEqual(retracted.result.code, 0, "negative: a retracted template resolves nowhere");
    assert.match(out(retracted.result), /no template matches 'laatz\/reviewer'/);

    const back = await mark(homeDir, "cand-1", ["--enable"]);
    assert.equal(back.json?.version, 1, "re-enable restores the version, it does not mint v2");
    assert.equal((await readTemplate(homeDir, "cand-1")).enabled, true);
    assert.equal((await spawnFrom(homeDir, "laatz/reviewer")).templateSource, "cand-1");
  });
});

test("--disable on a session that was never a template changes nothing (no block is invented)", async () => {
  await withTempHome("acpx-t1-soft-none-", async (homeDir) => {
    await writeConfig(homeDir);
    await seedCandidate(homeDir, "cand-1");
    const result = await runCli(["claude", "sessions", "template", "cand-1", "--disable"], homeDir);
    assert.equal(result.code, 0, out(result));
    const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, "cand-1"), "utf8")) as {
      template?: unknown;
    };
    assert.equal(stored.template, undefined);
  });
});

// ---------------------------------------------------------------------------
// rollback by name
// ---------------------------------------------------------------------------

test("`templates rollback laatz/reviewer` retracts Laatz's latest only; `rollback reviewer` leaves his chain alone", async () => {
  await withTempHome("acpx-t1-rollback-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    await seedTemplate(homeDir, { id: "mach-1", key: "reviewer", version: 1 });
    await seedTemplate(homeDir, { id: "mach-2", key: "reviewer", version: 2 });
    await seedTemplate(homeDir, { id: "laatz-1", key: `${ids.laatz}/reviewer`, version: 1 });
    await seedTemplate(homeDir, { id: "laatz-2", key: `${ids.laatz}/reviewer`, version: 2 });

    const plain = await runCli(
      ["claude", "sessions", "templates", "rollback", "reviewer"],
      homeDir,
    );
    assert.equal(plain.code, 0, out(plain));
    assert.equal((await readTemplate(homeDir, "mach-2")).enabled, false);
    assert.equal(
      (await readTemplate(homeDir, "laatz-2")).enabled,
      true,
      "negative: a plain-name rollback never reaches a personal chain",
    );

    const personal = await runCli(
      ["claude", "sessions", "templates", "rollback", "laatz/reviewer"],
      homeDir,
    );
    assert.equal(personal.code, 0, out(personal));
    assert.equal((await readTemplate(homeDir, "laatz-2")).enabled, false);
    assert.equal((await readTemplate(homeDir, "laatz-1")).enabled, true);
    assert.equal(
      (await readTemplate(homeDir, "mach-1")).enabled,
      true,
      "machine-wide v1 is untouched by it",
    );

    const unknown = await runCli(
      ["claude", "sessions", "templates", "rollback", "nosuch/reviewer"],
      homeDir,
    );
    assert.notEqual(unknown.code, 0);
    assert.match(out(unknown), /unknown person 'nosuch'/);
    assert.equal(
      (await readTemplate(homeDir, "laatz-1")).enabled,
      true,
      "an unknown person retracts nothing",
    );
  });
});

// ---------------------------------------------------------------------------
// AC6 — the old-reader round trip, on THIS build (the baseline-binary run is in the brick's evidence)
// ---------------------------------------------------------------------------

test("AC6: an 87-byte <id>/<64-char base> key is byte-identical through the five verbs an old reader runs", async () => {
  await withTempHome("acpx-t1-ac6-", async (homeDir) => {
    await writeConfig(homeDir);
    const ids = await seedPeople(homeDir);
    const base = `${"a".repeat(31)}-${"b".repeat(32)}`;
    const key = `${ids.laatz}/${base}`;
    assert.equal(Buffer.byteLength(key), 87);
    await seedTemplate(homeDir, { id: "wide-1", key, version: 1 });
    await seedTemplate(homeDir, { id: "peer-1", key: base, version: 1 });
    await seedTemplate(homeDir, { id: "peer-2", key: base, version: 2 });

    const slugOf = async (): Promise<unknown> => (await readTemplate(homeDir, "wide-1")).slug;
    const steps: Array<[string, string[]]> = [
      ["enable, no --slug", ["claude", "sessions", "template", "wide-1", "--enable"]],
      [
        "auto-prompt edit",
        ["claude", "sessions", "template", "wide-1", "--enable", "--auto-prompt", "new prompt"],
      ],
      ["rollback of a machine-wide peer", ["claude", "sessions", "templates", "rollback", base]],
      ["migrate-slugs", ["claude", "sessions", "templates", "migrate-slugs"]],
      ["reindex", ["claude", "sessions", "reindex"]],
    ];
    for (const [label, args] of steps) {
      const result = await runCli(args, homeDir);
      assert.equal(result.code, 0, `${label}: ${out(result)}`);
      assert.equal(await slugOf(), key, `${label}: the key changed`);
    }
    assert.equal(
      (await readTemplate(homeDir, "peer-2")).enabled,
      false,
      "the rollback did hit the machine-wide peer",
    );
    assert.equal((await readTemplate(homeDir, "wide-1")).version, 1);

    // instrument control: an explicit --slug is a real change, and the comparison above would report it
    const renamed = await runCli(
      ["claude", "sessions", "template", "wide-1", "--enable", "--slug", "other"],
      homeDir,
    );
    assert.equal(renamed.code, 0, out(renamed));
    assert.notEqual(await slugOf(), key);
    assert.equal(
      await slugOf(),
      `${ids.laatz}/other`,
      "this build keeps the owner when the base is renamed",
    );
  });
});

// ---------------------------------------------------------------------------
// Attribution (K9): who wrote the template
// ---------------------------------------------------------------------------

test("actors: ACPX_ACTOR_B64 wins, then the caller's ACPX_SESSION_URL as an agent, else none; garbage falls through", async () => {
  await withTempHome("acpx-t1-actors-", async (homeDir) => {
    await writeConfig(homeDir);
    await seedPeople(homeDir);
    const human = { kind: "human", channel: "web", verified: true, name: "Daniel Laatz" };
    const sessionUrl =
      "https://atrium.devbox.nativai.de/?session=4f0f4674-76ad-46c7-975e-909a0a7e8978";
    const cases: Array<[string, Record<string, string | undefined>, unknown]> = [
      [
        "a header",
        {
          ACPX_ACTOR_B64: Buffer.from(JSON.stringify(human)).toString("base64url"),
          ACPX_SESSION_URL: sessionUrl,
        },
        human,
      ],
      [
        "a session url",
        { ACPX_SESSION_URL: sessionUrl },
        {
          kind: "agent",
          session_id: "4f0f4674-76ad-46c7-975e-909a0a7e8978",
          session_url: sessionUrl,
        },
      ],
      [
        "a garbage header",
        { ACPX_ACTOR_B64: "%%%not-base64-json%%%", ACPX_SESSION_URL: sessionUrl },
        {
          kind: "agent",
          session_id: "4f0f4674-76ad-46c7-975e-909a0a7e8978",
          session_url: sessionUrl,
        },
      ],
      [
        "a camelCase header",
        {
          ACPX_ACTOR_B64: Buffer.from(JSON.stringify({ kind: "human", sessionId: "x" })).toString(
            "base64url",
          ),
        },
        undefined,
      ],
      ["nobody", {}, undefined],
    ];
    let n = 0;
    for (const [label, env, expected] of cases) {
      const id = `cand-${(n += 1)}`;
      await seedCandidate(homeDir, id);
      const { result, json } = await mark(homeDir, id, ["--enable", "--slug", `t-${n}`], env);
      assert.equal(result.code, 0, `${label}: ${out(result)}`);
      assert.deepEqual(json?.created_actor, expected, label);
      assert.deepEqual(json?.updated_actor, expected, label);
      assert.deepEqual(
        (await readTemplate(homeDir, id)).created_actor,
        expected,
        `${label}: on disk`,
      );
    }
  });
});
