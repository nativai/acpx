import fs from "node:fs";
import path from "node:path";
import { AcpxOperationalError } from "../errors.js";
import { lockHostPlace } from "./identity.js";
import { resolvedPath } from "./placement.js";
import type { SqliteDatabaseName } from "./sqlite-loader.js";

/**
 * A-83 / block A7 (brick 231b61db) — wherever atrium's directory is set, the spawn ledger (`brick-outbox.db`) and the model
 * preferences (`ui-prefs.db`) live in the directory atrium's databases are in, NOT in the exported
 * `~/.acpx` that pool pods mount read-write. The one place that names that directory and the one place
 * that decides where a control-only database opens.
 *
 * ⚠️ THE TWO FILE NAMES ARE PLACED ONLY THROUGH `controlDatabase`. `test/pod-db-dir.test.ts` discovers
 * every `"brick-outbox.db"` / `"ui-prefs.db"` literal in `src/` and fails on one that is not the first
 * argument of `controlDatabase(` — a fixed-path opener would open a second, empty database beside the
 * full one.
 */

/** The pointer atrium writes when its databases live outside the state home: `<root>/.db-dir.json`. */
export const DB_DIR_POINTER_FILE = ".db-dir.json";

/**
 * The directory atrium's SQLite databases are in, resolved as atrium resolves it (atrium S6, brick
 * 6b93b95e; sub-HoD ruling): `ACPX_UI_DB_DIR` if set, else the `dir` the pointer file
 * `<root>/.db-dir.json` names, else `<root>` — the state home THIS PROCESS resolved, so an isolated HOME
 * or a rig slot still reads its own. A pointer that is absent, unparsable or does not name an absolute
 * directory is as good as none: today's place. Read-only — nothing here creates a file.
 */
export function atriumDbDirOfRoot(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.ACPX_UI_DB_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const pointer = JSON.parse(fs.readFileSync(path.join(root, DB_DIR_POINTER_FILE), "utf8")) as {
      dir?: unknown;
    };
    if (typeof pointer.dir === "string" && path.isAbsolute(pointer.dir.trim())) {
      return pointer.dir.trim();
    }
  } catch {
    // no pointer, or not readable JSON: the default place
  }
  return root;
}

/** `atriumDbDirOfRoot` for a hot directory (`<root>/sessions`): the root is its parent. */
export function atriumDbDirFor(hotDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return atriumDbDirOfRoot(path.dirname(hotDir), env);
}

export const DB_AT_OLD_PLACE_REASON = "db_at_old_place";

/** A control-only database found only at its old place, though atrium's directory is set: acpx refuses; atrium's start moves it. */
export class DatabaseAtOldPlaceError extends AcpxOperationalError {
  constructor(
    readonly database: SqliteDatabaseName,
    readonly legacyPath: string,
    readonly dbPath: string,
  ) {
    super(
      `acpx: REFUSED reason=${DB_AT_OLD_PLACE_REASON} db=${database} — atrium's directory holds this database: ` +
        `${dbPath}, but only the old place ${legacyPath} holds one. acpx never moves a WAL database a ` +
        `process may hold open and never opens an empty one beside the full one: atrium's start moves ` +
        `it into place. Nothing was opened, made or moved.`,
      { outputCode: "USAGE", detailCode: DB_AT_OLD_PLACE_REASON, origin: "cli" },
    );
    this.name = "DatabaseAtOldPlaceError";
  }
}

export const DB_DIR_UNUSABLE_REASON = "db_dir_unusable";
export type DbDirSource = "env" | "pointer";
export type DbDirWhy = "unreadable" | "not_json" | "no_dir_string" | "relative" | "dir_not_found";

/**
 * A-84 / C7.2: the directory setting exists but names no usable directory. acpx REFUSES — it never falls
 * back to `~/.acpx` (an empty ledger beside the full one), never creates atrium's directory, and opens,
 * makes and moves nothing. The repair is the setting's: the text says so and never suggests taking a
 * damaged pointer away (an acpx without the variable would then open a new ledger in `~/.acpx` while the
 * databases sit in the directory the pointer named).
 */
export class DatabaseDirUnusableError extends AcpxOperationalError {
  constructor(
    readonly database: SqliteDatabaseName,
    readonly source: DbDirSource,
    readonly why: DbDirWhy,
    /** The pointer's path (source=pointer) or the variable's value (source=env), and the named dir if any. */
    readonly subject: Subject,
  ) {
    const what = describeUnusable(source, why, subject);
    const repair =
      source === "env"
        ? "Fix the setting: ACPX_UI_DB_DIR must be the absolute path of the directory atrium's databases are in."
        : "Fix the setting: the pointer must name, as an absolute path, the directory atrium's databases are in, " +
          "as atrium writes it (and that directory must be mounted).";
    super(
      `acpx: REFUSED reason=${DB_DIR_UNUSABLE_REASON} db=${database} source=${source} why=${why} — ${what}. ` +
        `${repair} Nothing was opened, made or moved.`,
      { outputCode: "USAGE", detailCode: DB_DIR_UNUSABLE_REASON, origin: "cli" },
    );
    this.name = "DatabaseDirUnusableError";
  }
}

type Subject = { pointer?: string; value?: string; errno?: string };

function describeUnusable(source: DbDirSource, why: DbDirWhy, subject: Subject): string {
  const env = source === "env";
  const named = env
    ? `ACPX_UI_DB_DIR=${JSON.stringify(subject.value)}`
    : `the pointer ${subject.pointer}`;
  const text: Record<DbDirWhy, string> = {
    unreadable: `${named} exists but cannot be read (${subject.errno ?? "error"})`,
    not_json: `${named} is empty or not JSON`,
    no_dir_string: `${named} has no non-blank string "dir"`,
    relative: env
      ? `${named} is not an absolute path`
      : `${named} names the relative directory ${JSON.stringify(subject.value)}`,
    dir_not_found: env
      ? `${named} is not an existing directory`
      : `${named} names ${JSON.stringify(subject.value)}, which is not an existing directory`,
  };
  return text[why];
}

/**
 * The directory setting as A-84 reads it — STRICT, and used only by `controlDatabase` (NEVER by `wakeups`'
 * liveness read, which keeps `atriumDbDirOfRoot`'s pass-over byte for byte). `undefined` = no setting:
 * today's place. `ACPX_UI_DB_DIR` set and non-blank names the directory and must be absolute — while it is
 * set the pointer is never read; else a pointer that EXISTS must be usable (no entry at all is "no pointer"; a dead link is an entry).
 * Whether the directory exists is `assertPlaced`'s, after the old-place check.
 */
function strictDbDirSetting(
  database: SqliteDatabaseName,
  root: string,
  env: NodeJS.ProcessEnv,
): { dir: string; source: DbDirSource } | undefined {
  const fromEnv = env.ACPX_UI_DB_DIR?.trim();
  if (fromEnv) {
    if (!path.isAbsolute(fromEnv)) {
      throw new DatabaseDirUnusableError(database, "env", "relative", { value: fromEnv });
    }
    return { dir: fromEnv, source: "env" };
  }
  const file = path.join(root, DB_DIR_POINTER_FILE);
  const text = readPointerText(database, file);
  if (text === undefined) {
    return undefined;
  }
  return { dir: pointerDir(database, file, text), source: "pointer" };
}

/** Does an entry of any kind (a dangling link included) exist at `file`? lstat, which never follows. */
function entryExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The pointer's text, `undefined` when no entry exists at all (no pointer); any other read failure, a dead link included, is `unreadable`. */
function readPointerText(database: SqliteDatabaseName, file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ⚠️ ENOENT ALONE IS NOT "NO POINTER": a DANGLING SYMLINK reads ENOENT too, and the entry exists.
    // lstat decides, as atrium's `pointerProblem` does (joint A-84 check, F-A84-2) — taken for "absent",
    // a dead link would send this process to `~/.acpx` to make an empty ledger beside the full one.
    if (code === "ENOENT" && !entryExists(file)) {
      return undefined;
    }
    throw new DatabaseDirUnusableError(database, "pointer", "unreadable", {
      pointer: file,
      errno: code,
    });
  }
}

/** The absolute `dir` a pointer's text names, or the refusal for the way it fails to. */
function pointerDir(database: SqliteDatabaseName, file: string, text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DatabaseDirUnusableError(database, "pointer", "not_json", { pointer: file });
  }
  const dir =
    typeof parsed === "object" && parsed !== null ? (parsed as { dir?: unknown }).dir : undefined;
  const named = typeof dir === "string" ? dir.trim() : "";
  if (!named) {
    throw new DatabaseDirUnusableError(database, "pointer", "no_dir_string", { pointer: file });
  }
  if (!path.isAbsolute(named)) {
    throw new DatabaseDirUnusableError(database, "pointer", "relative", {
      pointer: file,
      value: named,
    });
  }
  return named;
}

export type ControlDatabase = {
  /** Where this process opens the database. */
  readonly path: string;
  /** Where it always was: `<state root>/<file name>`. */
  readonly legacyPath: string;
  /** True when `path` is the database directory rather than the legacy place. */
  readonly relocated: boolean;
  /** The setting that named the directory (A-84), when one did. */
  readonly setting?: { dir: string; source: DbDirSource };
};

/**
 * Does atrium's database directory apply to this process? EVERYWHERE BUT AN AGENT POD, pod mode or not
 * (acpx sub-HoD #10 on atrium sub-HoD #9's measurement, 2026-11-25, devbox-staging): atrium's move runs
 * wherever its directory is set and the pointer `<root>/.db-dir.json` — written after the move — survives
 * a revert to pod mode off, so "pointer present, files moved, pod mode off" is a real state, and an acpx
 * keyed on pod mode would make a fresh ledger at the old place there. The key is the directory setting
 * (`ACPX_UI_DB_DIR` or the pointer), read STRICTLY by `strictDbDirSetting`; with neither, today's place —
 * a box that never switched behaves as before, byte for byte.
 *
 * ⚠️ AN AGENT POD NEVER LEARNS THE DIRECTORY, AND NEVER READS THE SETTING. Pod mode includes agent pods
 * (the place file stands for the switch), and the SQLite loader's refusal covers only files UNDER THE
 * STATE HOME: handing an agent pod the directory's path would walk it past C1.2 rule 5. It keeps the
 * legacy path, so the loader refuses it exactly as before — and this predicate decides BEFORE a damaged
 * setting can be judged, so the loader's refusal still comes first there. `test/pod-db-dir.test.ts` holds
 * both ("an agent pod never learns", A-84's agent-pod negative).
 * THIS IS THE ONE PREDICATE of the key: a ruling that changes it changes here.
 */
function dbDirApplies(env: NodeJS.ProcessEnv): boolean {
  return lockHostPlace(env) !== "agent-pod";
}

/** Where a control-only database opens: the directory if it applies, else the legacy place. */
export function controlDatabase(
  fileName: "brick-outbox.db" | "ui-prefs.db",
  stateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ControlDatabase {
  const legacyPath = path.join(stateRoot, fileName);
  if (!dbDirApplies(env)) {
    return { path: legacyPath, legacyPath, relocated: false };
  }
  const database = fileName === "brick-outbox.db" ? "spawn-ledger" : "ui-prefs";
  const setting = strictDbDirSetting(database, stateRoot, env);
  if (!setting) {
    return { path: legacyPath, legacyPath, relocated: false };
  }
  const dbPath = path.join(setting.dir, fileName);
  return {
    path: dbPath,
    legacyPath,
    relocated: resolvedPath(dbPath) !== resolvedPath(legacyPath),
    setting,
  };
}

/**
 * NEVER A SECOND LEDGER (A-83 rule 3). Called before the database is opened: a relocated database that
 * is absent from its directory while the old place holds data (the main file, or a `-wal` that may hold
 * committed rows) is REFUSED — never opened empty beside the full one, and never moved from here (a move
 * under a live WAL holder is the hazard `spawn-ledger.ts` names; atrium's start moves, behind its fence).
 *
 * A file in the directory is the one that opens, whatever the old place holds (atrium sets a stray at the
 * old place aside); a lone old `-shm` is a derived index, not data.
 */
export function assertNotAtOldPlace(database: SqliteDatabaseName, placed: ControlDatabase): void {
  if (!placed.relocated || fs.existsSync(placed.path)) {
    return;
  }
  if (fs.existsSync(placed.legacyPath) || fs.existsSync(`${placed.legacyPath}-wal`)) {
    throw new DatabaseAtOldPlaceError(database, placed.legacyPath, placed.path);
  }
}

/**
 * The checks between placing a database and opening it, IN THIS ORDER (A-84): a pending move reads
 * `db_at_old_place` (A-83 (3)); only then must the named directory EXIST — acpx never creates atrium's
 * directory, not even one level, so a setting that names none refuses `dir_not_found`. The `mkdir` of the
 * callers stays for the legacy place only.
 */
export function assertPlaced(database: SqliteDatabaseName, placed: ControlDatabase): void {
  assertNotAtOldPlace(database, placed);
  if (!placed.relocated || !placed.setting) {
    return;
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(placed.setting.dir).isDirectory();
  } catch {
    // not there: the same refusal
  }
  if (!isDirectory) {
    throw new DatabaseDirUnusableError(database, placed.setting.source, "dir_not_found", {
      pointer: path.join(path.dirname(placed.legacyPath), DB_DIR_POINTER_FILE),
      value: placed.setting.dir,
    });
  }
}
