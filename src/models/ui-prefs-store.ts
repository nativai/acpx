/**
 * `~/.acpx/ui-prefs.db` — the per-box model preferences store: favorites, and
 * the last-used model per agent type.
 *
 * WHY A DATABASE AND NOT A JSON FILE (C4 §7.5): it has TWO writers in two
 * processes — acpx-ui and `acpx models fav` — and a whole-document rewrite makes
 * a lost update by construction, silently. Per-row writes compose; WAL keeps
 * concurrent readers safe. The acceptance criterion (C4 §15.7) is exactly that:
 * a star set through each writer inside the same window, both surviving.
 *
 * Built on the seven-step module pattern of acpx-ui's `server/wakeups/store.ts`
 * (I3 capability map §9.2): path resolver with env override → mkdir + open →
 * pragmas → one `CREATE TABLE IF NOT EXISTS` schema → additive migration →
 * statements prepared once at open → a singleton opened once, not per call.
 *
 * The engine is `node:sqlite`, NOT better-sqlite3: acpx has zero SQLite
 * dependency today and is bootstrapped onto every box in the fleet, so a native
 * module would be a new compile step in `bootstrap.sh`. `node:sqlite` is a
 * builtin (node v22.23.1 on devbox) that `tsdown --platform node` externalises
 * for free.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { loadSqlite } from "../pod/sqlite-loader.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS favorite_models (
  source TEXT NOT NULL, model_id TEXT NOT NULL, favorited_at INTEGER NOT NULL,
  PRIMARY KEY (source, model_id));
CREATE TABLE IF NOT EXISTS last_used_model (
  agent_type TEXT PRIMARY KEY, model_key TEXT NOT NULL, updated_at INTEGER NOT NULL);
`;

export type FavoriteModel = {
  /** `source:id` — the favorite key (C5 D2). */
  key: string;
  source: string;
  id: string;
  /** ISO-8601. */
  favoritedAt: string;
};

export type LastUsedModel = {
  agentType: string;
  modelKey: string;
  updatedAt: string;
};

export type UiPrefsStore = {
  readonly dbPath: string;
  /** Most-recently-starred FIRST — computed here so the CLI and the UI band identically. */
  listFavorites(): FavoriteModel[];
  favoriteKeys(): string[];
  isFavorite(source: string, id: string): boolean;
  /** Idempotent. */
  addFavorite(source: string, id: string, favoritedAt?: number): void;
  /** Idempotent. */
  removeFavorite(source: string, id: string): void;
  getLastUsedModel(agentType: string): LastUsedModel | undefined;
  /** The whole per-agent-type map. Empty when nothing has been recorded yet. */
  listLastUsedModels(): LastUsedModel[];
  /** Written on SUCCESSFUL session creation only (C4 §7.5). */
  setLastUsedModel(agentType: string, modelKey: string, updatedAt?: number): void;
  close(): void;
};

/** `ACPX_UI_PREFS_DB` overrides the file; `ACPX_STATE_HOME` moves the whole `.acpx` tree. */
export function defaultUiPrefsDbPath(): string {
  const explicit = process.env.ACPX_UI_PREFS_DB?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(process.env.ACPX_STATE_HOME || os.homedir(), ".acpx", "ui-prefs.db");
}

// The one `node:sqlite` loader (and its agent-pod refusal) lives in `pod/sqlite-loader.ts`; the
// warning predicate is re-exported from here because tests and older callers import it from this file.
export { isSqliteExperimentalWarning } from "../pod/sqlite-loader.js";

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function openUiPrefsStore(dbPath: string = defaultUiPrefsDbPath()): UiPrefsStore {
  // Before the directory is created: an agent pod's refusal leaves nothing behind.
  const { DatabaseSync: Database } = loadSqlite("ui-prefs", dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  // WAL is what makes the two-writer case safe for concurrent readers.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);

  const statements = {
    listFavorites: db.prepare(
      "SELECT source, model_id, favorited_at FROM favorite_models ORDER BY favorited_at DESC, source ASC, model_id ASC",
    ),
    isFavorite: db.prepare(
      "SELECT 1 AS present FROM favorite_models WHERE source = ? AND model_id = ?",
    ),
    addFavorite: db.prepare(
      // ⚠️ DO NOTHING ON CONFLICT, NOT `INSERT OR REPLACE`: a repeated star must keep its ORIGINAL
      // `favorited_at`. REPLACE re-stamped it, and the list is ordered by it, so a repeated `fav add` reordered the
      // favorites — yet `models fav add` is marked repeatSafe (a CALL_HOME unknown outcome says "repeat it").
      // Held by test/ui-prefs-store.test.ts ("a repeated star keeps its original time").
      "INSERT INTO favorite_models (source, model_id, favorited_at) VALUES (?, ?, ?) ON CONFLICT(source, model_id) DO NOTHING",
    ),
    removeFavorite: db.prepare("DELETE FROM favorite_models WHERE source = ? AND model_id = ?"),
    getLastUsed: db.prepare(
      "SELECT agent_type, model_key, updated_at FROM last_used_model WHERE agent_type = ?",
    ),
    setLastUsed: db.prepare(
      "INSERT OR REPLACE INTO last_used_model (agent_type, model_key, updated_at) VALUES (?, ?, ?)",
    ),
    listLastUsed: db.prepare(
      "SELECT agent_type, model_key, updated_at FROM last_used_model ORDER BY agent_type ASC",
    ),
  } satisfies Record<string, StatementSync>;

  function toLastUsed(row: Record<string, unknown>): LastUsedModel {
    return {
      agentType: String(row.agent_type),
      modelKey: String(row.model_key),
      updatedAt: toIso(Number(row.updated_at)),
    };
  }

  function readFavorites(): FavoriteModel[] {
    return statements.listFavorites.all().map((row) => {
      const source = String(row.source);
      const id = String(row.model_id);
      return { key: `${source}:${id}`, source, id, favoritedAt: toIso(Number(row.favorited_at)) };
    });
  }

  return {
    dbPath,
    listFavorites: readFavorites,
    favoriteKeys: () => readFavorites().map((favorite) => favorite.key),
    isFavorite(source, id) {
      return statements.isFavorite.get(source, id) !== undefined;
    },
    addFavorite(source, id, favoritedAt = Date.now()) {
      statements.addFavorite.run(source, id, favoritedAt);
    },
    removeFavorite(source, id) {
      statements.removeFavorite.run(source, id);
    },
    getLastUsedModel(agentType) {
      const row = statements.getLastUsed.get(agentType);
      return row === undefined ? undefined : toLastUsed(row);
    },
    listLastUsedModels() {
      return statements.listLastUsed.all().map((row) => toLastUsed(row));
    },
    setLastUsedModel(agentType, modelKey, updatedAt = Date.now()) {
      statements.setLastUsed.run(agentType, modelKey, updatedAt);
    },
    close() {
      db.close();
    },
  };
}

let singleton: UiPrefsStore | undefined;

/** Opened ONCE per process, like every other acpx-owned store — never per call. */
export function getUiPrefsStore(): UiPrefsStore {
  const dbPath = defaultUiPrefsDbPath();
  if (!singleton || singleton.dbPath !== dbPath) {
    singleton?.close();
    singleton = openUiPrefsStore(dbPath);
  }
  return singleton;
}

/**
 * Favorites must never be the reason a command fails: an unreadable or locked
 * DB degrades to "no favorites", which changes ordering and nothing else.
 */
export function readFavoriteKeysSafely(): string[] {
  try {
    return getUiPrefsStore().favoriteKeys();
  } catch {
    return [];
  }
}
