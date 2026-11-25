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

export type ControlDatabase = {
  /** Where this process opens the database. */
  readonly path: string;
  /** Where it always was: `<state root>/<file name>`. */
  readonly legacyPath: string;
  /** True when `path` is the database directory rather than the legacy place. */
  readonly relocated: boolean;
};

/**
 * Does atrium's database directory apply to this process? EVERYWHERE BUT AN AGENT POD, pod mode or not
 * (acpx sub-HoD #10 on atrium sub-HoD #9's measurement, 2026-11-25, devbox-staging): atrium's move runs
 * wherever its directory is set and the pointer `<root>/.db-dir.json` — written after the move — survives
 * a revert to pod mode off, so "pointer present, files moved, pod mode off" is a real state, and an acpx
 * keyed on pod mode would make a fresh ledger at the old place there. The key is the directory setting
 * (`ACPX_UI_DB_DIR` or the pointer), which `atriumDbDirOfRoot` reads; with neither it falls back to the
 * root, which is today's place — a box that never switched behaves as before, byte for byte.
 *
 * ⚠️ AN AGENT POD NEVER LEARNS THE DIRECTORY. Pod mode includes agent pods (the place file stands for
 * the switch), and the SQLite loader's refusal covers only files UNDER THE STATE HOME: handing an agent
 * pod the directory's path would walk it past C1.2 rule 5. It keeps the legacy path, so the loader
 * refuses it exactly as before. `test/pod-db-dir.test.ts` holds this ("an agent pod never learns").
 * THIS IS THE ONE PREDICATE of the key: a ruling that changes it (A-83 says "in pod mode") changes here.
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
  const dbPath = path.join(atriumDbDirOfRoot(stateRoot, env), fileName);
  return { path: dbPath, legacyPath, relocated: resolvedPath(dbPath) !== resolvedPath(legacyPath) };
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
