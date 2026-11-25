import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  getUiPrefsStore,
  openUiPrefsStore,
  readFavoriteKeysSafely,
} from "../src/models/ui-prefs-store.js";
import { DatabaseAtOldPlaceError, DB_AT_OLD_PLACE_REASON } from "../src/pod/db-dir.js";
import { podModeVerdictNow } from "../src/pod/placement.js";
import { PodNoSqliteError } from "../src/pod/sqlite-loader.js";
import { SpawnLedger } from "../src/spawn-ledger.js";

// A-83 / block A7 (brick 231b61db), rows 83.1 and 83.2 (acpx's half): the spawn ledger
// (`brick-outbox.db`) and the model preferences (`ui-prefs.db`) open in the directory atrium's databases
// are in — `ACPX_UI_DB_DIR`, else the `dir` of `<root>/.db-dir.json`, else `<root>` — in pod mode AND
// out of it (the key is the directory setting; atrium's pointer survives a revert), never in an agent pod, and never a second
// ledger: a file found only at the old place is REFUSED (acpx never moves a WAL database that a live
// process may hold open; atrium's start does the move, behind its fence).
//
// The pod is the C1.1 test seam: `ACPX_POD_TEST_HOME` leads into a sandbox that IS the canonical home.

const ENV_NAMES = [
  "HOME",
  "ACPX_STATE_HOME",
  "ACPX_POD_TEST_HOME",
  "ACPX_POD_SA_DIR",
  "ACPX_UI_PREFS_DB",
  "ACPX_UI_DB_DIR",
  "ACPX_OWNER_PLACEMENT",
  "NV_POD_NAME",
  "NV_POD_UID",
  "NV_NODE_NAME",
] as const;
const SAVED = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

test.afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = SAVED[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

type Box = { home: string; acpx: string; dbDir: string; otherDir: string };

function sandbox(
  options: {
    place?: "control" | "agent-pod";
    switched?: boolean;
    pointer?: boolean;
  } = {},
): Box {
  const { place = "control", switched = true, pointer = true } = options;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-dbdir-")));
  const acpx = path.join(home, ".acpx");
  const dbDir = path.join(home, "control", "db");
  const otherDir = path.join(home, "control", "other-db");
  fs.mkdirSync(acpx, { recursive: true });
  if (place === "agent-pod") {
    fs.writeFileSync(path.join(home, ".nv-agent"), "ag-dbdir\n");
  }
  if (pointer) {
    fs.writeFileSync(path.join(acpx, ".db-dir.json"), JSON.stringify({ dir: dbDir }));
  }
  const saDir = path.join(home, "sa");
  fs.mkdirSync(saDir);
  fs.writeFileSync(path.join(saDir, "namespace"), "dev-kit\n");
  process.env.HOME = home;
  for (const name of ["ACPX_STATE_HOME", "ACPX_UI_PREFS_DB", "ACPX_UI_DB_DIR"]) {
    delete process.env[name];
  }
  process.env.ACPX_POD_TEST_HOME = home;
  process.env.ACPX_POD_SA_DIR = saDir;
  process.env.NV_POD_NAME = "ctl-dbdir";
  process.env.NV_POD_UID = "uid-dbdir";
  process.env.NV_NODE_NAME = "node-a";
  if (switched) {
    process.env.ACPX_OWNER_PLACEMENT = "pod";
  } else {
    delete process.env.ACPX_OWNER_PLACEMENT;
  }
  // Never a vacuous pass: the sandbox must really be (or really not be) in pod mode.
  assert.equal(podModeVerdictNow().mode, switched ? "pod" : "off", "the sandbox's pod mode");
  return { home, acpx, dbDir, otherDir };
}

const SUFFIXES = ["", "-wal", "-shm"] as const;
const present = (dir: string, base: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith(base)) : [];
const sha = (file: string): string =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

type RawDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { get: (...p: unknown[]) => Record<string, unknown> | undefined };
  close: () => void;
};
function rawOpen(file: string): RawDb {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (p: string) => RawDb;
  };
  return new DatabaseSync(file);
}

const INSTANCE = "i-111111111111";
function admit(box: Box): void {
  fs.writeFileSync(
    path.join(box.acpx, "instance.json"),
    JSON.stringify({ instance_id: INSTANCE, home: box.home }),
  );
}

/**
 * Runs `make` as an old build would have: no database directory yet (the pointer hidden, the env
 * unset), so the file is made at the old place — then everything is put back.
 */
function atTheOldPlace<T>(box: Box, make: () => T): T {
  const pointer = path.join(box.acpx, ".db-dir.json");
  const kept = fs.existsSync(pointer) ? fs.readFileSync(pointer) : undefined;
  const keptEnv = process.env.ACPX_UI_DB_DIR;
  fs.rmSync(pointer, { force: true });
  delete process.env.ACPX_UI_DB_DIR;
  try {
    return make();
  } finally {
    if (kept !== undefined) {
      fs.writeFileSync(pointer, kept);
    }
    if (keptEnv !== undefined) {
      process.env.ACPX_UI_DB_DIR = keptEnv;
    }
  }
}

/** A ledger the way today's build leaves it: at the old place, with a committed row still in its WAL. */
function fullLedgerAtOldPlace(box: Box): SpawnLedger {
  return atTheOldPlace(box, () => {
    admit(box);
    const ledger = new SpawnLedger();
    assert.equal(ledger.dbPath, path.join(box.acpx, "brick-outbox.db"));
    ledger.bindIdentity({ instance_id: INSTANCE });
    return ledger; // left open: its -wal holds the committed row
  });
}

function fullPrefsAtOldPlace(box: Box): ReturnType<typeof openUiPrefsStore> {
  return atTheOldPlace(box, () => {
    const store = openUiPrefsStore();
    assert.equal(store.dbPath, path.join(box.acpx, "ui-prefs.db"));
    store.addFavorite("openrouter", "acme/model-1", 1000);
    return store;
  });
}

/** The two states the key must hold in: pod mode on, and pod mode off (a revert keeps the pointer). */
const MODES = [true, false] as const;
const modeLabel = (switched: boolean): string => `pod mode ${switched ? "on" : "off"}`;
function eachMode(title: string, run: (switched: boolean) => void | Promise<void>): void {
  for (const switched of MODES) {
    test(`${title} [${modeLabel(switched)}]`, () => run(switched));
  }
}

const refusedAtOldPlace = (database: string) => (error: unknown) =>
  error instanceof DatabaseAtOldPlaceError &&
  error.database === database &&
  error.message.startsWith(`acpx: REFUSED reason=${DB_AT_OLD_PLACE_REASON} db=${database}`) &&
  error.outputCode === "USAGE";

// ---------------------------------------------------------------- 83.1 — where the files go

test("83.1 the spawn ledger opens in the pointer's directory; its sessions directory and nothing else stays under ~/.acpx", () => {
  const box = sandbox();
  const ledger = new SpawnLedger();
  try {
    assert.equal(ledger.dbPath, path.join(box.dbDir, "brick-outbox.db"));
    assert.equal(ledger.sessionsDir, path.join(box.acpx, "sessions"));
    assert.ok(fs.statSync(ledger.sessionsDir).isDirectory());
  } finally {
    ledger.close();
  }
  assert.deepEqual(
    present(box.acpx, "brick-outbox"),
    [],
    "no ledger file, -wal or -shm under ~/.acpx",
  );
  assert.ok(present(box.dbDir, "brick-outbox").includes("brick-outbox.db"));
});

test("83.1 ACPX_UI_DB_DIR wins over the pointer, for the ledger and for the preferences", () => {
  const box = sandbox();
  process.env.ACPX_UI_DB_DIR = box.otherDir;
  const ledger = new SpawnLedger();
  const store = openUiPrefsStore();
  try {
    assert.equal(ledger.dbPath, path.join(box.otherDir, "brick-outbox.db"));
    assert.equal(store.dbPath, path.join(box.otherDir, "ui-prefs.db"));
    store.addFavorite("openrouter", "acme/model-1", 1000);
  } finally {
    ledger.close();
    store.close();
  }
  assert.deepEqual(
    present(box.dbDir, ""),
    [],
    "the pointer's directory is not used (and not made)",
  );
  assert.deepEqual(present(box.acpx, "brick-outbox"), []);
  assert.deepEqual(present(box.acpx, "ui-prefs"), []);
});

test("83.1 the model preferences open in the pointer's directory, WAL files included, nothing under ~/.acpx", () => {
  const box = sandbox();
  const store = openUiPrefsStore();
  try {
    assert.equal(store.dbPath, path.join(box.dbDir, "ui-prefs.db"));
    store.addFavorite("openrouter", "acme/model-1", 1000);
    assert.deepEqual(
      SUFFIXES.map((suffix) => fs.existsSync(path.join(box.dbDir, `ui-prefs.db${suffix}`))),
      [true, true, true],
      "ui-prefs.db, -wal and -shm are all in the database directory while the store is open",
    );
    assert.deepEqual(
      present(box.acpx, "ui-prefs"),
      [],
      "no ui-prefs file of any suffix under ~/.acpx",
    );
  } finally {
    store.close();
  }
});

// The key is the directory setting, not pod mode (atrium sub-HoD #9 measured the pointer and the moved
// files surviving a revert to pod mode off on devbox-staging): both states, both ways.
for (const switched of MODES) {
  test(`83.1 the pointer is followed in ${modeLabel(switched)}: both files in its directory, nothing under ~/.acpx`, () => {
    const box = sandbox({ switched });
    const ledger = new SpawnLedger();
    const store = openUiPrefsStore();
    try {
      assert.equal(ledger.dbPath, path.join(box.dbDir, "brick-outbox.db"));
      assert.equal(store.dbPath, path.join(box.dbDir, "ui-prefs.db"));
      store.addFavorite("openrouter", "acme/model-1", 1000);
    } finally {
      ledger.close();
      store.close();
    }
    assert.deepEqual(present(box.acpx, "brick-outbox"), []);
    assert.deepEqual(present(box.acpx, "ui-prefs"), []);
  });

  test(`83.1 ACPX_UI_DB_DIR alone (no pointer) is followed in ${modeLabel(switched)}`, () => {
    const box = sandbox({ switched, pointer: false });
    process.env.ACPX_UI_DB_DIR = box.otherDir;
    const ledger = new SpawnLedger();
    try {
      assert.equal(ledger.dbPath, path.join(box.otherDir, "brick-outbox.db"));
    } finally {
      ledger.close();
    }
    assert.deepEqual(present(box.acpx, "brick-outbox"), []);
  });

  test(`83.1 NEGATIVE: with no pointer and no ACPX_UI_DB_DIR the place is today's, in ${modeLabel(switched)}`, () => {
    const box = sandbox({ switched, pointer: false });
    const ledger = new SpawnLedger();
    const store = openUiPrefsStore();
    try {
      assert.equal(ledger.dbPath, path.join(box.acpx, "brick-outbox.db"));
      assert.equal(store.dbPath, path.join(box.acpx, "ui-prefs.db"));
    } finally {
      ledger.close();
      store.close();
    }
    assert.equal(fs.existsSync(path.join(box.home, "control")), false);
  });
}

test("83.1 an explicit ACPX_UI_PREFS_DB still names the preferences file, in pod mode too", () => {
  const box = sandbox();
  const explicit = path.join(box.home, "elsewhere", "prefs.db");
  process.env.ACPX_UI_PREFS_DB = explicit;
  const store = openUiPrefsStore();
  try {
    assert.equal(store.dbPath, explicit);
  } finally {
    store.close();
  }
  assert.deepEqual(present(box.dbDir, ""), []);
});

test("83.1 NEGATIVE: an agent pod never learns the directory — both open as before and are refused, nothing is made", () => {
  const box = sandbox({ place: "agent-pod" });
  assert.throws(
    () => new SpawnLedger(),
    (error) => error instanceof PodNoSqliteError,
  );
  assert.throws(
    () => openUiPrefsStore(),
    (error) => error instanceof PodNoSqliteError,
  );
  assert.equal(
    fs.existsSync(path.join(box.home, "control")),
    false,
    "the database directory is not made",
  );
  assert.deepEqual(present(box.acpx, "brick-outbox"), []);
  assert.deepEqual(present(box.acpx, "ui-prefs"), []);
});

// ---------------------------------------------------------------- 83.2 — never two ledgers

eachMode(
  `83.2 a ledger found only at the old place is refused: nothing is opened, made or moved`,
  (switched) => {
    const box = sandbox({ switched });
    const holder = fullLedgerAtOldPlace(box);
    const old = path.join(box.acpx, "brick-outbox.db");
    try {
      assert.ok(fs.existsSync(`${old}-wal`), "the committed row is still in the WAL");
      const before = { main: sha(old), wal: sha(`${old}-wal`) };
      assert.throws(() => new SpawnLedger(), refusedAtOldPlace("spawn-ledger"));
      assert.deepEqual(
        present(box.dbDir, ""),
        [],
        "no empty ledger beside the full one — nothing in the directory",
      );
      assert.equal(fs.existsSync(box.dbDir), false);
      assert.deepEqual(
        { main: sha(old), wal: sha(`${old}-wal`) },
        before,
        "the old files are untouched",
      );
    } finally {
      holder.close();
    }
  },
);

eachMode(`83.2 the refusal names both places and says who moves the file`, (switched) => {
  const box = sandbox({ switched });
  const holder = fullLedgerAtOldPlace(box);
  try {
    assert.throws(
      () => new SpawnLedger(),
      (error) =>
        error instanceof DatabaseAtOldPlaceError &&
        error.message.includes(path.join(box.acpx, "brick-outbox.db")) &&
        error.message.includes(path.join(box.dbDir, "brick-outbox.db")) &&
        error.message.includes("atrium"),
    );
  } finally {
    holder.close();
  }
});

eachMode(
  `83.2 NEGATIVE: only the old place's -wal (main file gone) is data too — refused`,
  (switched) => {
    const box = sandbox({ switched });
    const holder = fullLedgerAtOldPlace(box);
    const old = path.join(box.acpx, "brick-outbox.db");
    fs.copyFileSync(`${old}-wal`, path.join(box.home, "wal.keep"));
    holder.close();
    fs.rmSync(old, { force: true });
    fs.rmSync(`${old}-shm`, { force: true });
    fs.rmSync(`${old}-wal`, { force: true });
    fs.copyFileSync(path.join(box.home, "wal.keep"), `${old}-wal`);
    assert.throws(() => new SpawnLedger(), refusedAtOldPlace("spawn-ledger"));
    assert.equal(fs.existsSync(box.dbDir), false);
  },
);

test("83.2 a stray -shm alone at the old place is not data: the open goes ahead at the new place", () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.acpx, "brick-outbox.db-shm"), "");
  const ledger = new SpawnLedger();
  try {
    assert.equal(ledger.dbPath, path.join(box.dbDir, "brick-outbox.db"));
  } finally {
    ledger.close();
  }
});

eachMode(
  `83.2 the model preferences found only at the old place are refused the same way`,
  (switched) => {
    const box = sandbox({ switched });
    const holder = fullPrefsAtOldPlace(box);
    const old = path.join(box.acpx, "ui-prefs.db");
    try {
      const before = { main: sha(old), wal: sha(`${old}-wal`) };
      assert.throws(() => openUiPrefsStore(), refusedAtOldPlace("ui-prefs"));
      assert.equal(fs.existsSync(box.dbDir), false, "no empty preferences beside the full ones");
      assert.deepEqual({ main: sha(old), wal: sha(`${old}-wal`) }, before);
    } finally {
      holder.close();
    }
  },
);

test("83.2 files at both places: the directory's file is the one opened, the old ones are not touched", () => {
  const box = sandbox();
  fs.mkdirSync(box.dbDir, { recursive: true });
  admit(box);
  // the directory's own ledger and preferences first (pod mode on)
  const real = new SpawnLedger();
  real.bindIdentity({ instance_id: INSTANCE });
  real.close();
  const realPrefs = openUiPrefsStore();
  realPrefs.addFavorite("openrouter", "acme/in-the-directory", 1000);
  realPrefs.close();
  // then a leftover at the old place, as a re-created or old-build file
  fs.writeFileSync(path.join(box.acpx, "brick-outbox.db"), "old ledger bytes");
  fs.writeFileSync(path.join(box.acpx, "ui-prefs.db"), "old prefs bytes");
  const oldShas = [
    sha(path.join(box.acpx, "brick-outbox.db")),
    sha(path.join(box.acpx, "ui-prefs.db")),
  ];

  const ledger = new SpawnLedger();
  const store = openUiPrefsStore();
  try {
    assert.equal(ledger.dbPath, path.join(box.dbDir, "brick-outbox.db"));
    assert.equal(store.dbPath, path.join(box.dbDir, "ui-prefs.db"));
    assert.equal(store.isFavorite("openrouter", "acme/in-the-directory"), true);
  } finally {
    ledger.close();
    store.close();
  }
  assert.deepEqual(
    [sha(path.join(box.acpx, "brick-outbox.db")), sha(path.join(box.acpx, "ui-prefs.db"))],
    oldShas,
  );
});

eachMode(
  `83.2 after atrium's move (sidecars first, then the main file) both open with their committed rows`,
  (switched) => {
    const box = sandbox({ switched });
    const ledgerHolder = fullLedgerAtOldPlace(box);
    const prefsHolder = fullPrefsAtOldPlace(box);
    // The move, as atrium's S6 does it for a unit whose process is gone: here the holders' handles
    // are abandoned in place (no checkpoint), so the WAL is still the only home of the rows.
    fs.mkdirSync(box.dbDir, { recursive: true });
    for (const base of ["brick-outbox.db", "ui-prefs.db"]) {
      for (const suffix of ["-wal", "-shm", ""]) {
        const from = path.join(box.acpx, `${base}${suffix}`);
        if (fs.existsSync(from)) {
          fs.copyFileSync(from, path.join(box.dbDir, `${base}${suffix}`));
          fs.rmSync(from);
        }
      }
    }
    ledgerHolder.close();
    prefsHolder.close();
    fs.rmSync(path.join(box.acpx, "brick-outbox.db-wal"), { force: true });
    fs.rmSync(path.join(box.acpx, "ui-prefs.db-wal"), { force: true });
    const ledger = new SpawnLedger();
    const store = openUiPrefsStore();
    try {
      assert.equal(ledger.dbPath, path.join(box.dbDir, "brick-outbox.db"));
      assert.equal(
        store.isFavorite("openrouter", "acme/model-1"),
        true,
        "the committed preference row survived",
      );
      const raw = rawOpen(ledger.dbPath);
      try {
        assert.equal(
          raw.prepare("SELECT value FROM meta WHERE key='instance_id'").get()?.value,
          INSTANCE,
        );
        assert.equal(raw.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      } finally {
        raw.close();
      }
    } finally {
      ledger.close();
      store.close();
    }
  },
);

test("83.2 a box with nothing to move starts as today: the files are created in the directory", () => {
  const box = sandbox();
  const ledger = new SpawnLedger();
  const store = openUiPrefsStore();
  try {
    assert.ok(fs.existsSync(path.join(box.dbDir, "brick-outbox.db")));
    assert.ok(fs.existsSync(path.join(box.dbDir, "ui-prefs.db")));
  } finally {
    ledger.close();
    store.close();
  }
});

// ---------------------------------------------------------------- the library open (atrium's own process)

test("83.1 the PACKAGE export `acpx/spawn-ledger` (dist) resolves through the pointer too, for an in-process importer", async () => {
  const box = sandbox();
  const specifier = "acpx/spawn-ledger";
  const mod = (await import(specifier)) as { SpawnLedger: new () => SpawnLedger };
  const ledger = new mod.SpawnLedger();
  try {
    assert.equal(ledger.dbPath, path.join(box.dbDir, "brick-outbox.db"));
    assert.ok(fs.existsSync(ledger.dbPath));
  } finally {
    ledger.close();
  }
  assert.deepEqual(present(box.acpx, "brick-outbox"), [], "nothing appears under ~/.acpx");
});

eachMode(
  `83.2 the PACKAGE export refuses a ledger found only at the old place, and makes no second one`,
  async (switched) => {
    const box = sandbox({ switched });
    const holder = fullLedgerAtOldPlace(box);
    try {
      const specifier = "acpx/spawn-ledger";
      const mod = (await import(specifier)) as { SpawnLedger: new () => SpawnLedger };
      assert.throws(
        () => new mod.SpawnLedger(),
        (error) => (error as Error).name === "DatabaseAtOldPlaceError",
      );
      assert.equal(fs.existsSync(box.dbDir), false);
    } finally {
      holder.close();
    }
  },
);

eachMode(
  `83.2 the per-process singleton places itself too: old-place-only is refused there, and favorites degrade to none`,
  (switched) => {
    const box = sandbox({ switched });
    const holder = fullPrefsAtOldPlace(box);
    try {
      assert.throws(() => getUiPrefsStore(), refusedAtOldPlace("ui-prefs"));
      assert.deepEqual(readFavoriteKeysSafely(), []);
      assert.equal(fs.existsSync(box.dbDir), false);
    } finally {
      holder.close();
    }
  },
);

// ---------------------------------------------------------------- every opener goes through the placement

/** Every `"brick-outbox.db"` / `"ui-prefs.db"` literal in `source` that is not the first argument of `controlDatabase(`. */
function fixedPathOccurrences(text: string): string[] {
  const found: string[] = [];
  const source = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const literal = /["'`](?:brick-outbox|ui-prefs)\.db["'`]/g;
  for (let match = literal.exec(source); match; match = literal.exec(source)) {
    const before = source.slice(0, match.index);
    if (!/controlDatabase\(\s*$/.test(before)) {
      found.push(match[0]);
    }
  }
  return found;
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

test("83.1 DISCOVERY: no file in src/ names either database as a fixed path — only controlDatabase places them", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const files = walk(path.join(root, "src"));
  assert.ok(files.length > 200, `scanned ${files.length} files — the walk found src/`);
  const offenders = files
    .filter((file) => !file.endsWith(path.join("pod", "db-dir.ts")))
    .flatMap((file) =>
      fixedPathOccurrences(fs.readFileSync(file, "utf8")).map((hit) => `${file}: ${hit}`),
    );
  assert.deepEqual(offenders, []);
  // positive control: the two real call sites are seen, and each as an allowed one
  const placed = files.filter((file) =>
    /controlDatabase\(\s*"(?:brick-outbox|ui-prefs)\.db"/.test(fs.readFileSync(file, "utf8")),
  );
  assert.deepEqual(placed.map((file) => path.basename(file)).toSorted(), [
    "spawn-ledger.ts",
    "ui-prefs-store.ts",
  ]);
});

test("83.1 the scan ignores comments (a name in prose is not an opener)", () => {
  assert.deepEqual(
    fixedPathOccurrences("// the `brick-outbox.db` file\n/** `ui-prefs.db` */\nconst x = 1;"),
    [],
  );
});

test("83.1 the scan's NEGATIVE: a fresh fixed-path opener is flagged without being registered anywhere", () => {
  assert.deepEqual(fixedPathOccurrences('const f = path.join(dir, "brick-outbox.db");'), [
    '"brick-outbox.db"',
  ]);
  assert.deepEqual(fixedPathOccurrences("const f = path.join(dir, `ui-prefs.db`);"), [
    "`ui-prefs.db`",
  ]);
  assert.deepEqual(
    fixedPathOccurrences('const ok = controlDatabase(\n    "ui-prefs.db",\n    root);'),
    [],
  );
  assert.deepEqual(
    fixedPathOccurrences('a(controlDatabase("brick-outbox.db", r), "ui-prefs.db")'),
    ['"ui-prefs.db"'],
  );
});

// ---------------------------------------------------------------- the real CLI (dist/cli.js)

const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "cli.js",
);

function childEnv(box: Box): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "ACPX_STATE_HOME",
    "ACPX_UI_PREFS_DB",
    "ACPX_UI_DB_DIR",
    "ACPX_UI_INTERNAL_URL",
  ]) {
    delete env[name];
  }
  return { ...env, HOME: box.home };
}

for (const format of ["text", "json"] as const) {
  test(`83.2 the real CLI: \`models fav\` with the preferences only at the old place exits 2 with the refusal as its first stderr line (${format})`, () => {
    const box = sandbox();
    const holder = fullPrefsAtOldPlace(box);
    holder.close();
    const old = path.join(box.acpx, "ui-prefs.db");
    const before = sha(old);
    const run = spawnSync(
      process.execPath,
      [CLI, "models", "fav", ...(format === "json" ? ["--format", "json"] : [])],
      {
        env: childEnv(box),
        encoding: "utf8",
      },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 2, output);
    const firstLine = run.stderr.split("\n")[0] ?? "";
    assert.ok(
      firstLine.startsWith(`acpx: REFUSED reason=${DB_AT_OLD_PLACE_REASON} db=ui-prefs`) ||
        (format === "json" && run.stdout.includes(DB_AT_OLD_PLACE_REASON)),
      output,
    );
    assert.equal(fs.existsSync(box.dbDir), false, "nothing made in the directory");
    assert.equal(sha(old), before, "the old file is untouched");
  });
}

test("83.1 the real CLI: `models fav` in pod mode opens the preferences in the pointer's directory and nothing under ~/.acpx", () => {
  const box = sandbox();
  const run = spawnSync(process.execPath, [CLI, "models", "fav"], {
    env: childEnv(box),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(fs.existsSync(path.join(box.dbDir, "ui-prefs.db")));
  assert.deepEqual(present(box.acpx, "ui-prefs"), []);
});
