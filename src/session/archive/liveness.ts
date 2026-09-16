import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { hasActiveSidecar } from "./identity.js";

/**
 * The liveness gate — BRIEF §6.5. A RUN-TIME QUERY, not a static exclude list,
 * re-checked per id immediately before that id's renames.
 *
 * ⚠️ FAILS CLOSED. If a signal cannot be evaluated, the id is LIVE and is skipped
 * — consistent with `record-unparseable`. A guard that cannot run must never
 * read as "nothing to guard against".
 */

export type LivenessVerdict = { live: boolean; signal?: string };

type SqliteModule = {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
    close: () => void;
  };
};

/**
 * Copied deliberately from `models/ui-prefs-store.ts`: `node:sqlite` is flagged
 * experimental in node 22 and emits ONE `ExperimentalWarning` on stderr, which
 * would break `--json-strict`'s promise of machine-clean stderr. The filter is
 * installed around the require and removed immediately, so an unrelated warning
 * in the same window still gets through.
 */
function requireSqlite(): SqliteModule {
  const original = process.emitWarning.bind(process);
  const filtered = (warning: unknown, ...rest: unknown[]): void => {
    const name = typeof warning === "string" ? rest[0] : (warning as Error | undefined)?.name;
    const text =
      typeof warning === "string" ? warning : ((warning as Error | undefined)?.message ?? "");
    if (name === "ExperimentalWarning" && text.includes("SQLite")) {
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

/**
 * `<root>/.acpx/wakeups.db`, derived as a sibling of the hot dir THIS PROCESS
 * resolved — the same rule as the archive dir, so an isolated HOME or a rig slot
 * reads its own wakeups rather than the box's.
 */
export function wakeupsDbPathFor(hotDir: string): string {
  return path.join(path.dirname(hotDir), "wakeups.db");
}

export type WakeupLiveness =
  | { status: "absent" }
  | { status: "ok"; ids: ReadonlySet<string> }
  /** Present but unusable — every id is treated as LIVE while this holds. */
  | { status: "unevaluable"; detail: string };

/**
 * One query per RUN, not per id: a non-terminal wakeup row names its session in
 * `callback_url` as `/api/sessions/<id>/message`.
 *
 * ⚠️ NON-TERMINAL, NOT "HAS ANY ROW". The rig's `NOTCLOSED-WAKEUP-TERMINAL`
 * fixture is the control for exactly this: its only row is `cancelled`, and an
 * implementation keying on row PRESENCE keeps a session it should archive. The
 * terminal statuses are `completed`, `cancelled`, `dead_letter`.
 */
export async function loadWakeupLiveness(hotDir: string): Promise<WakeupLiveness> {
  const dbPath = wakeupsDbPathFor(hotDir);
  try {
    await fs.access(dbPath);
  } catch {
    // A box with no wakeups store has no wakeups. This is an evaluated "no",
    // not an unevaluable signal — distinct from the branch below.
    return { status: "absent" };
  }
  try {
    const { DatabaseSync: Database } = requireSqlite();
    const db = new Database(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT callback_url FROM wakeups WHERE status NOT IN ('completed','cancelled','dead_letter')",
        )
        .all() as Array<{ callback_url?: unknown }>;
      const ids = new Set<string>();
      for (const row of rows) {
        const url = typeof row.callback_url === "string" ? row.callback_url : "";
        const match = /\/api\/sessions\/([^/?#]+)\//.exec(url);
        if (match) {
          ids.add(decodeURIComponent(match[1]));
        }
      }
      return { status: "ok", ids };
    } finally {
      db.close();
    }
  } catch (error) {
    return { status: "unevaluable", detail: (error as Error).message };
  }
}

/**
 * A liveness test ONLY — never a kill.
 *
 * `EPERM` counts as alive: the process exists and belongs to someone else.
 *
 * ⚠️ A bare pid match is NOT ownership, and this function makes no ownership
 * claim. It is safe here precisely because the consequence of a false "alive" is
 * that a session is KEPT — the conservative direction. Do not lift this helper
 * into any path that signals a pid: acpx qualifies a pid with
 * `isLikelyMatchingProcess(pid, record.agentCommand)` before it ever signals one,
 * and that check is not optional there.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type PrimaryLivenessProbe = (id: string) => Promise<LivenessVerdict | "unavailable">;

/** `state` values acpx-ui uses for a session that is mid-turn or wedged mid-turn. */
const LIVE_STATES: ReadonlySet<string> = new Set(["working", "red", "interrupted"]);

export function verdictFromStatusBody(body: {
  ownerAlive?: unknown;
  state?: unknown;
}): LivenessVerdict {
  if (body.ownerAlive === true) {
    return { live: true, signal: "owner-alive" };
  }
  if (typeof body.state === "string" && LIVE_STATES.has(body.state)) {
    return { live: true, signal: `state:${body.state}` };
  }
  return { live: false };
}

/**
 * The PRIMARY signal (BRIEF §6.5): `GET <base>/api/sessions/<id>/status` must not
 * report `ownerAlive: true`, nor a `state` of `working` / `red` / `interrupted`.
 *
 * ⚠️ PREFER THIS OVER RE-DERIVING LIVENESS. It is the same judgement acpx-ui itself
 * makes, so the retention job cannot drift from what the UI shows a human.
 *
 * It is ONE of two channels for live state the CLI cannot see for itself; the other
 * is `--exclude-ids <file>` (`LivenessGateOptions.excludedIds`), which the acpx-ui
 * scheduler uses to pass the same knowledge when it invokes the mechanism directly.
 * This probe covers the case where acpx-ui is merely REACHABLE rather than the
 * caller; `--exclude-ids` covers the case where it IS the caller. Neither replaces
 * the on-disk blockers, which run either way.
 */
export function createHttpLivenessProbe(baseUrl: string, timeoutMs = 2_000): PrimaryLivenessProbe {
  return async (id: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(id)}/status`,
        { signal: controller.signal },
      );
      if (!response.ok) {
        // 404 means acpx-ui does not know this id — which for a session that is
        // about to be archived is the expected answer, not an outage. Any other
        // non-2xx is an outage and must fall through to the fallbacks, not be
        // read as "not live".
        return response.status === 404 ? { live: false } : "unavailable";
      }
      return verdictFromStatusBody(
        (await response.json()) as { ownerAlive?: unknown; state?: unknown },
      );
    } catch {
      // ⚠️ A CONNECTION FAILURE IS NOT A 404. acpx-ui is restarted routinely (the
      // supervisor relaunches it in 2-5 minutes), and during that window every
      // probe throws. "unavailable" routes to the filesystem fallbacks, which
      // themselves fail closed — so a restart degrades the gate's precision, never
      // its safety.
      return "unavailable";
    } finally {
      clearTimeout(timer);
    }
  };
}

export type LivenessGateOptions = {
  primary?: PrimaryLivenessProbe;
  wakeups: WakeupLiveness;
  /**
   * Live-state exclusions supplied by the CALLER — `--exclude-ids <file>`, one id
   * per line. The acpx-ui scheduler's channel into this gate.
   *
   * 🛑 THE DIVISION OF LABOUR IS THE LOAD-BEARING HALF, because this is exactly the
   * seam where each side would assume the other handled it:
   *
   * - **acpx-ui owns ONLY what needs a LIVE PROCESS** — owner liveness, the
   *   executor lease, non-terminal `wakeups.db` rows, `GET /api/sessions/:id/status`.
   *   Those are unavailable to a CLI invocation, which is the entire reason this
   *   flag exists.
   * - **The CLI owns everything derivable from ON-DISK state** — the manifest fold,
   *   `effectiveEndedAt`, the `recently-restored` grace period, templates,
   *   favorites, the delivery family for T1-T3, the 60-minute quiet window,
   *   `record-unparseable`. NONE of that may be taken from the caller: two sources
   *   of truth for one on-disk fact is how they drift.
   *
   * ⚠️ AN ABSENT FLAG MEANS "NO LIVE-STATE EXCLUSIONS KNOWN", NOT "NO EXCLUSIONS
   * APPLY". Every on-disk blocker above still runs — which is what makes
   * `acpx sessions archive` fully usable standalone with no scheduler behind it,
   * as D1 requires.
   */
  excludedIds?: ReadonlySet<string>;
};

/**
 * Evaluate liveness for one id, at APPLY time.
 *
 * ⚠️ RE-VALIDATE AGAINST THE LIVE RECORD, NOT AGAINST THE PLAN. `files` and `pid`
 * must be read immediately before the renames; that is the difference between a
 * safe run and one acting on a snapshot minutes old — and it is what makes a
 * just-restored session (whose files were renamed seconds ago) safe against a
 * retention run that planned to archive it.
 */
export async function evaluateLiveness(
  id: string,
  safeId: string,
  files: readonly string[],
  pid: number | undefined,
  options: LivenessGateOptions,
  /**
   * ⚠️ GATES THE ACTIVE-SIDECAR SIGNAL, AND IT IS NOT OPTIONAL POLISH. An ORPHAN
   * has no record, so nothing can ever deliver to it — a `.delivery.json` beside an
   * orphan is reseeding something unresumable. Counting it as liveness makes those
   * ids permanently unarchivable (measured: 113 orphans carry one), which is the
   * same carve-out `staticBlockerFor` makes for the `active-delivery-sidecar`
   * blocker. FIXING ONLY ONE OF THE TWO SITES LEAVES THE IDS BLOCKED BY THE OTHER,
   * which is exactly how this would survive a partial fix.
   */
  hasRecord = true,
): Promise<LivenessVerdict> {
  const reported = await reportedLiveness(id, options);
  if (reported) {
    return reported;
  }
  if (pid != null && isPidAlive(pid)) {
    return { live: true, signal: "pid-alive" };
  }
  if (hasRecord && hasActiveSidecar(safeId, files)) {
    return { live: true, signal: "active-sidecar" };
  }
  return wakeupVerdict(id, options.wakeups);
}

/** The two signals that come from OUTSIDE this process: the caller's exclusion
 *  list and acpx-ui's status endpoint. */
async function reportedLiveness(
  id: string,
  options: LivenessGateOptions,
): Promise<LivenessVerdict | undefined> {
  // The caller's live-state exclusions win outright: acpx-ui knows things about a
  // running process that no filesystem read can recover.
  if (options.excludedIds?.has(id) === true) {
    return { live: true, signal: "excluded-by-caller" };
  }
  // A reachable acpx-ui that says "live" ends it. One that says "not live" is
  // authoritative only for the two signals only it can see (executor lease, live
  // hub set); the filesystem fallbacks still run afterwards, because they are cheap
  // and they cover the window between acpx-ui's view and disk.
  const primary = await options.primary?.(id);
  return primary != null && primary !== "unavailable" && primary.live ? primary : undefined;
}

function wakeupVerdict(id: string, wakeups: WakeupLiveness): LivenessVerdict {
  // ⚠️ FAILS CLOSED, AND THE BLAST RADIUS IS THE WHOLE RUN ON PURPOSE. A wakeups
  // store that exists and cannot be read makes every id LIVE, so the run archives
  // nothing and says why. That is the doctrine (`record-unparseable`: the error
  // path IS the guard) applied to a signal whose failure is store-wide. An ABSENT
  // store is a different thing entirely — a box with no wakeups genuinely has no
  // pending wakeups, which is an evaluated "no", not an unevaluable signal.
  if (wakeups.status === "unevaluable") {
    return { live: true, signal: "wakeups-unevaluable" };
  }
  if (wakeups.status === "ok" && wakeups.ids.has(id)) {
    return { live: true, signal: "wakeup-pending" };
  }
  return { live: false };
}
