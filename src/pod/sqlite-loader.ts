import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { AcpxOperationalError } from "../errors.js";
import { isBoxWideFileInAgentPod } from "./foreign-write-guard.js";

/**
 * C1.2 rule 5 — NO SQLITE IN AGENT PODS (block A7, brick 9289d7c4). The one place `node:sqlite` is
 * required, and it refuses in an agent pod BEFORE the module loads: a path nobody classified fails
 * loudly (`acpx: REFUSED reason=pod_no_sqlite db=<name>`, exit 2) instead of opening a database file
 * over a network mount, where SQLite's locking is not reliable.
 *
 * ⚠️ THE GUARDED OPERATION LIVES ONLY HERE. `test/pod-no-sqlite.test.ts` discovers every `node:sqlite`
 * require in `src/` by scanning and fails on one outside this file — so a fourth loader cannot be
 * added without the guard, and a leftover import or comment cannot keep a guard "present" after its
 * call is gone. DO NOT add a second `createRequire(…)("node:sqlite")` anywhere; call `loadSqlite`.
 *
 * Which pod: the box-wide writers' rule (A-8, `isBoxWideFileInAgentPod`) — the place file or an
 * `ag-…` hostname, and only for a database UNDER THE BOX'S STATE HOME. A suite or rig that points acpx
 * at a state home of its own (A-26) opens its databases as today, as does the control pod.
 */

export const POD_NO_SQLITE_REASON = "pod_no_sqlite";

/** Which database a caller was about to open — for the refusal line only. */
export type SqliteDatabaseName = "spawn-ledger" | "ui-prefs" | "wakeups";

export class PodNoSqliteError extends AcpxOperationalError {
  constructor(readonly database: SqliteDatabaseName) {
    super(
      `acpx: REFUSED reason=${POD_NO_SQLITE_REASON} db=${database} — this is an agent pod; ` +
        `SQLite databases are opened on the control pod only (C1.2 rule 5). Nothing was opened.`,
      { outputCode: "USAGE", detailCode: POD_NO_SQLITE_REASON, origin: "cli" },
    );
  }
}

export type SqliteModule = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
};

/**
 * `node:sqlite` is still flagged experimental in node 22, so importing it emits ONE
 * `ExperimentalWarning` on stderr — which would break `--json-strict`'s promise of machine-clean
 * stderr.
 *
 * ⚠️ DO NOT "fix" this with `--no-warnings`, a tsdown banner, or
 * `process.removeAllListeners('warning')`. acpx runs for every agent on every box in the fleet; a
 * blanket suppression there would silence genuine deprecation and security warnings everywhere,
 * forever, to hide one line. The filter below is installed around the require call and removed
 * immediately, and it drops exactly one warning — an unrelated warning emitted in the same window
 * still gets through (there is a test for that half; it is the positive control that proves this
 * suppressed one warning, not all of them).
 */
export function isSqliteExperimentalWarning(warning: unknown, rest: unknown[]): boolean {
  const name = typeof warning === "string" ? rest[0] : (warning as Error | undefined)?.name;
  const text =
    typeof warning === "string" ? warning : ((warning as Error | undefined)?.message ?? "");
  return name === "ExperimentalWarning" && text.includes("SQLite");
}

let sqliteModule: SqliteModule | undefined;

/**
 * The SQLite module, for a database at `target`; throws `PodNoSqliteError` in an agent pod when the
 * target is a file of the box's state home. The guard runs on EVERY call, before the memo — a
 * module an earlier call loaded is not a permit.
 *
 * The module is required lazily: importing it at CLI-module time would put the warning on every
 * `--version` / `--help`.
 */
export function loadSqlite(
  database: SqliteDatabaseName,
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): SqliteModule {
  if (isBoxWideFileInAgentPod(target, env)) {
    throw new PodNoSqliteError(database);
  }
  if (sqliteModule) {
    return sqliteModule;
  }
  const original = process.emitWarning.bind(process);
  const filtered = (warning: unknown, ...rest: unknown[]): void => {
    if (isSqliteExperimentalWarning(warning, rest)) {
      return;
    }
    (original as (...args: unknown[]) => void)(warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    sqliteModule = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}
