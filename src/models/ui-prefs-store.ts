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
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";

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

type SqliteModule = { DatabaseSync: new (path: string) => DatabaseSync };

/**
 * `node:sqlite` is still flagged experimental in node 22, so importing it emits
 * ONE `ExperimentalWarning` on stderr — which would break `--json-strict`'s
 * promise of machine-clean stderr.
 *
 * ⚠️ DO NOT "fix" this with `--no-warnings`, a tsdown banner, or
 * `process.removeAllListeners('warning')`. acpx runs for every agent on every
 * box in the fleet; a blanket suppression there would silence genuine
 * deprecation and security warnings everywhere, forever, to hide one line.
 * The filter below is installed around the require call and removed
 * immediately, and it drops exactly one warning — an unrelated warning emitted
 * in the same window still gets through (there is a test for that half; it is
 * the positive control that proves this suppressed one warning, not all of them).
 */
export function isSqliteExperimentalWarning(warning: unknown, rest: unknown[]): boolean {
  const name = typeof warning === "string" ? rest[0] : (warning as Error | undefined)?.name;
  const text =
    typeof warning === "string" ? warning : ((warning as Error | undefined)?.message ?? "");
  return name === "ExperimentalWarning" && text.includes("SQLite");
}

function requireSqlite(): SqliteModule {
  const original = process.emitWarning.bind(process);
  const filtered = (warning: unknown, ...rest: unknown[]): void => {
    if (isSqliteExperimentalWarning(warning, rest)) {
      return;
    }
    (original as (...args: unknown[]) => void)(warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
}

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export function openUiPrefsStore(dbPath: string = defaultUiPrefsDbPath()): UiPrefsStore {
  const { DatabaseSync: Database } = requireSqlite();
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
      "INSERT OR REPLACE INTO favorite_models (source, model_id, favorited_at) VALUES (?, ?, ?)",
    ),
    removeFavorite: db.prepare("DELETE FROM favorite_models WHERE source = ? AND model_id = ?"),
    getLastUsed: db.prepare(
      "SELECT agent_type, model_key, updated_at FROM last_used_model WHERE agent_type = ?",
    ),
    setLastUsed: db.prepare(
      "INSERT OR REPLACE INTO last_used_model (agent_type, model_key, updated_at) VALUES (?, ?, ?)",
    ),
  } satisfies Record<string, StatementSync>;

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
      if (!row) {
        return undefined;
      }
      return {
        agentType: String(row.agent_type),
        modelKey: String(row.model_key),
        updatedAt: toIso(Number(row.updated_at)),
      };
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
