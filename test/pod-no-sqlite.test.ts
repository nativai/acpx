import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openUiPrefsStore } from "../src/models/ui-prefs-store.js";
import {
  loadSqlite,
  PodNoSqliteError,
  POD_NO_SQLITE_REASON,
  type SqliteDatabaseName,
} from "../src/pod/sqlite-loader.js";
import { loadWakeupLiveness } from "../src/session/archive/liveness.js";
import { createContext, planArchiveRun } from "../src/session/archive/operations.js";
import { resolveBoundaries } from "../src/session/archive/retention.js";
import { SpawnLedger } from "../src/spawn-ledger.js";

// block A7 / C1.2 rule 5: no SQLite in an agent pod. The agent pod here is the C1.1 test seam:
// `ACPX_POD_TEST_HOME` leads into a sandbox whose `.nv-agent` is the place file, and the state home IS
// that sandbox (`<sandbox>/.acpx`). The refusal is thrown BEFORE the module loads, and before any
// directory or file of the database is made.

const SAVED = {
  HOME: process.env.HOME,
  ACPX_STATE_HOME: process.env.ACPX_STATE_HOME,
  ACPX_POD_TEST_HOME: process.env.ACPX_POD_TEST_HOME,
  ACPX_UI_PREFS_DB: process.env.ACPX_UI_PREFS_DB,
  ACPX_UI_DB_DIR: process.env.ACPX_UI_DB_DIR,
  ACPX_OWNER_PLACEMENT: process.env.ACPX_OWNER_PLACEMENT,
};

function sandbox(place: "agent-pod" | "control"): { home: string; acpx: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-nosql-")));
  if (place === "agent-pod") {
    fs.writeFileSync(path.join(home, ".nv-agent"), "ag-nosql\n");
  }
  process.env.HOME = home;
  delete process.env.ACPX_STATE_HOME;
  delete process.env.ACPX_UI_PREFS_DB;
  delete process.env.ACPX_UI_DB_DIR;
  delete process.env.ACPX_OWNER_PLACEMENT;
  process.env.ACPX_POD_TEST_HOME = home;
  return { home, acpx: path.join(home, ".acpx") };
}

test.afterEach(() => {
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const refused = (database: SqliteDatabaseName) => (error: unknown) =>
  error instanceof PodNoSqliteError &&
  error.database === database &&
  error.message.startsWith(`acpx: REFUSED reason=${POD_NO_SQLITE_REASON} db=${database}`) &&
  error.outputCode === "USAGE";

test("the loader refuses in an agent pod for every database name, before it loads anything", () => {
  const { acpx } = sandbox("agent-pod");
  for (const name of ["spawn-ledger", "ui-prefs", "wakeups"] as const) {
    assert.throws(() => loadSqlite(name, path.join(acpx, `${name}.db`)), refused(name));
  }
});

test("the spawn ledger's constructor refuses in an agent pod and makes no directory", () => {
  const { acpx } = sandbox("agent-pod");
  assert.throws(() => new SpawnLedger(), refused("spawn-ledger"));
  assert.equal(fs.existsSync(acpx), false, "not even the .acpx directory");
});

test("the model-preferences store refuses in an agent pod and makes no directory", () => {
  const { acpx } = sandbox("agent-pod");
  assert.throws(() => openUiPrefsStore(), refused("ui-prefs"));
  assert.equal(fs.existsSync(acpx), false, "not even the .acpx directory");
});

test("archive liveness cannot read wakeups.db in an agent pod: unevaluable, so every id stays LIVE", async () => {
  const { acpx } = sandbox("agent-pod");
  const hot = path.join(acpx, "sessions");
  fs.mkdirSync(hot, { recursive: true });
  fs.writeFileSync(path.join(acpx, "wakeups.db"), "");
  const verdict = await loadWakeupLiveness(hot);
  assert.equal(verdict.status, "unevaluable");
  assert.ok(
    verdict.status === "unevaluable" &&
      verdict.detail.startsWith(`acpx: REFUSED reason=${POD_NO_SQLITE_REASON} db=wakeups`),
    JSON.stringify(verdict),
  );
});

test("NEGATIVE: the same three open on the control pod (the guard is the agent pod's alone)", async () => {
  const { acpx } = sandbox("control");
  const ledger = new SpawnLedger();
  ledger.close();
  const prefs = openUiPrefsStore();
  prefs.close();
  assert.equal(fs.existsSync(path.join(acpx, "brick-outbox.db")), true);
  assert.equal(fs.existsSync(path.join(acpx, "ui-prefs.db")), true);
  assert.equal(
    (await loadWakeupLiveness(path.join(acpx, "sessions"))).status,
    "absent",
    "no wakeups.db, nothing to refuse",
  );
});

test("NEGATIVE: an agent pod opening a database of a state home OF ITS OWN (a suite, a rig) is not stopped (A-26)", () => {
  sandbox("agent-pod");
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-nosql-own-"));
  const prefs = openUiPrefsStore(path.join(own, ".acpx", "ui-prefs.db"));
  prefs.close();
  assert.equal(fs.existsSync(path.join(own, ".acpx", "ui-prefs.db")), true);
});

test("the module is NOT LOADED in an agent pod, and IS on the control pod — a fresh process each", () => {
  const loader = fileURLToPath(new URL("../src/pod/sqlite-loader.js", import.meta.url));
  const script = `
    const { loadSqlite } = await import(${JSON.stringify(loader)});
    let threw = false;
    try { loadSqlite("ui-prefs", process.env.HOME + "/.acpx/ui-prefs.db"); } catch { threw = true; }
    const loaded = process.moduleLoadList.some((name) => /sqlite/i.test(name));
    process.stdout.write(JSON.stringify({ threw, loaded }));
  `;
  const run = (place: "agent-pod" | "control") => {
    const { home } = sandbox(place);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: home, ACPX_POD_TEST_HOME: home, NODE_TEST_CONTEXT: "child-v8" },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as { threw: boolean; loaded: boolean };
  };
  assert.deepEqual(run("agent-pod"), { threw: true, loaded: false });
  // positive control: the same probe sees the module when the guard lets it load.
  assert.deepEqual(run("control"), { threw: false, loaded: true });
});

test("an EMPTY NODE_TEST_CONTEXT honours no seam: the same sandbox is not an agent pod", () => {
  const { acpx } = sandbox("agent-pod");
  assert.doesNotThrow(() =>
    loadSqlite("ui-prefs", path.join(acpx, "ui-prefs.db"), {
      ...process.env,
      NODE_TEST_CONTEXT: "",
    }),
  );
});

// ---- archive liveness: in pod mode a missing wakeups.db is "cannot tell" (rule 5) ------------------

async function planWith(acpx: string): Promise<{
  liveness: Awaited<ReturnType<typeof loadWakeupLiveness>>;
  selected: number;
  degraded: boolean;
}> {
  const hot = path.join(acpx, "sessions");
  fs.mkdirSync(hot, { recursive: true });
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const closedAt = old.toISOString();
  const record = path.join(hot, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.json");
  fs.writeFileSync(
    record,
    JSON.stringify({
      acpx_record_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      closed: true,
      closed_at: closedAt,
      last_used_at: closedAt,
      cwd: "/tmp",
    }),
  );
  fs.utimesSync(record, old, old);
  const liveness = await loadWakeupLiveness(hot);
  const context = createContext(hot, "a7-liveness");
  const plan = await planArchiveRun(context, resolveBoundaries(context.nowMs), {
    includeOrphans: false,
    liveness: { primary: undefined, wakeups: liveness },
  });
  return { liveness, selected: plan.selected.length, degraded: plan.livenessDegraded };
}

test("pod mode on the control pod: a MISSING wakeups.db is 'cannot tell' — the plan is degraded and archives nothing", async () => {
  const { acpx } = sandbox("control");
  process.env.ACPX_OWNER_PLACEMENT = "pod"; // the switch; the verdict is `pod` or `refuse`, never `off`
  const planned = await planWith(acpx);
  assert.equal(planned.liveness.status, "unevaluable");
  assert.ok(
    planned.liveness.status === "unevaluable" &&
      planned.liveness.detail.includes("a missing database is"),
    JSON.stringify(planned.liveness),
  );
  assert.equal(planned.degraded, true);
  assert.equal(planned.selected, 0, "every id is treated as LIVE");
});

test("NEGATIVE: the same box with the switch off keeps today's 'absent' — no wake-ups, the old session IS selected", async () => {
  const { acpx } = sandbox("control");
  const planned = await planWith(acpx);
  assert.equal(planned.liveness.status, "absent");
  assert.equal(planned.degraded, false);
  assert.equal(planned.selected, 1);
});

test("the wakeups.db is found through the directory setting before 'missing' is judged (pod mode, ACPX_UI_DB_DIR)", async () => {
  const { acpx } = sandbox("control");
  process.env.ACPX_OWNER_PLACEMENT = "pod";
  const dbDir = path.join(acpx, "elsewhere");
  fs.mkdirSync(dbDir, { recursive: true });
  process.env.ACPX_UI_DB_DIR = dbDir;
  const hot = path.join(acpx, "sessions");
  fs.mkdirSync(hot, { recursive: true });
  const detail = await loadWakeupLiveness(hot);
  assert.ok(
    detail.status === "unevaluable" && detail.detail.includes(path.join(dbDir, "wakeups.db")),
  );
});

// ---- the structural check: the require lives ONLY in the loader (discovering) --------------------

/** Every non-type load of `node:sqlite` under `root`: a call `("node:sqlite")` or a value import. */
export function findSqliteLoads(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (file.endsWith(".ts")) {
        // Comment lines carry the text of a require as prose (this guard's own header does): drop them.
        const source = fs
          .readFileSync(file, "utf8")
          .split("\n")
          .map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? "" : line))
          .join("\n");
        for (const match of source.matchAll(
          /(?<!import type [^;]*)(?:\(\s*|from\s+|import\s+)["'`]node:sqlite["'`]/g,
        )) {
          found.push(`${path.relative(root, file)}@${match.index}`);
        }
      }
    }
  };
  walk(root);
  return found;
}

test("DISCOVERY: exactly one place in src/ loads node:sqlite, and it is the guarded loader", () => {
  const src = path.resolve("src");
  const loads = findSqliteLoads(src).map((entry) => entry.split("@")[0]);
  assert.deepEqual(loads, [path.join("pod", "sqlite-loader.ts")]);
});

test("DISCOVERY NEGATIVE: a fresh file that loads node:sqlite is flagged without being registered anywhere", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-nosql-scan-"));
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(
    path.join(root, "nested", "fourth-loader.ts"),
    'import { createRequire } from "node:module";\nexport const db = createRequire(import.meta.url)("node:sqlite");\n',
  );
  fs.writeFileSync(
    path.join(root, "type-only.ts"),
    'import type { DatabaseSync } from "node:sqlite";\n',
  );
  fs.writeFileSync(
    path.join(root, "comment.ts"),
    '// DO NOT call createRequire(import.meta.url)("node:sqlite") here\n/**\n * from "node:sqlite"\n */\n',
  );
  fs.writeFileSync(
    path.join(root, "value-import.ts"),
    'import { DatabaseSync } from "node:sqlite";\n',
  );
  assert.deepEqual(
    findSqliteLoads(root)
      .map((entry) => entry.split("@")[0])
      .toSorted(),
    [path.join("nested", "fourth-loader.ts"), "value-import.ts"],
