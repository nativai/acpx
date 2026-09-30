/**
 * Codex subscription-cap admission.
 *
 * 🛑 THE INVARIANT: hold ONLY on positive evidence of being at or over the cap.
 * Absence or staleness of evidence is NOT evidence of breach.
 *
 * Why that is structural here, not a preference: the observation this gate reads
 * (`/api/usage/codex/quota`) is derived exclusively from Codex's own rollout
 * logs, which advance ONLY when an admitted Codex turn makes a backend request.
 * So the freshness signal can only ever be produced by the very action a
 * freshness check forbids. Hold on `stale` and the gate feeds itself: no turn
 * runs, so no observation is written, so the reading stays stale, so no turn
 * runs — permanently, and it re-arms after every idle gap longer than
 * MAX_OBSERVATION_AGE_MS. Hold on `absent` and a box that has never run Codex
 * can never start one. Hold on an elapsed window — which means the quota
 * RENEWED, the most permissive state there is — and not even a weekly reset
 * clears the lock.
 *
 * ⚠️ DO NOT "restore fail-closed enforcement" by making staleness, absence or an
 * elapsed window a hold again. It reads as the safe direction and it is the bug:
 * measured on devbox 2026-09-28, a subscription at 0% real weekly usage was
 * blocked by a 4-day-old 75% reading, and Codex was already dead on four of five
 * boxes. Strict fail-closed becomes correct only once the reading comes from a
 * source that refreshes independently of admission (codex app-server
 * `account/rateLimits/read`) — not before. Every row of the table below is
 * pinned by a case in `test/codex-subscription-cap.test.ts`; weakening one reds
 * the suite.
 *
 *   observation                              | decision
 *   -----------------------------------------|----------------------------------
 *   no usable weekly window (absent)          | ADMIT
 *   window elapsed / past resetsAt (renewed)  | ADMIT
 *   below cap — fresh or stale                | ADMIT
 *   at or over cap, window not yet reset      | HOLD  (status "at-cap")
 *   quota endpoint unreadable                 | HOLD  (status "read-failed")
 *
 * Accepted, bounded residual: the quota is account-global, so a stale below-cap
 * reading can admit one turn while another client has already pushed real usage
 * over the cap. That turn immediately writes a fresh snapshot, so the next turn
 * is gated on truth — a one-turn overshoot per idle gap.
 */
import { CodexSubscriptionCapError } from "../../errors.js";
import type { CodexSubscriptionCapDetail } from "../../types.js";

const WEEKLY_WINDOW_MINUTES = 10_080;
// Freshness bound. This is a REPORTED classification only — it decorates a hold
// with `observationFreshness` so the API and UI can say "this reading is old".
// ⚠️ It must never gate admission on its own; see the invariant above for why.
const MAX_OBSERVATION_AGE_MS = 120_000;
// A cold acpx-ui quota cache may need to stat and parse every historical Codex
// rollout.  Two seconds is shorter than that normal first read, which turns a
// fresh below-cap observation into a false fail-closed hold.  Keep the bound so
// an unavailable control plane cannot block a turn forever, but leave enough
// time for that bounded local scan to complete.
const ADMISSION_TIMEOUT_MS = 45_000;
const LOCAL_ACPX_UI_ORIGIN = "http://127.0.0.1:3456";

type CodexQuotaWindow = {
  windowMinutes?: unknown;
  usedPercent?: unknown;
  elapsed?: unknown;
  resetsAt?: unknown;
  resetsAtEpoch?: unknown;
};

type WeeklyObservation = {
  usedPercent: number;
  elapsed: boolean;
  resetsAt?: string;
  resetsAtEpoch?: number;
};

type CodexQuotaObservation = {
  capturedAt?: unknown;
  secondary?: CodexQuotaWindow | null;
};

function failedDetail(
  weeklyCapPercent: number,
  status: CodexSubscriptionCapDetail["status"],
): CodexSubscriptionCapDetail {
  return {
    code: "codex-subscription-cap",
    providerSubmitted: false,
    weeklyCapPercent,
    status,
  };
}

function atCapDetail(
  weeklyCapPercent: number,
  facts: {
    usedPercent: number;
    capturedAt: string;
    observationFreshness: NonNullable<CodexSubscriptionCapDetail["observationFreshness"]>;
    resetsAt?: string;
  },
): CodexSubscriptionCapDetail {
  return {
    ...failedDetail(weeklyCapPercent, "at-cap"),
    observedWeeklyPercent: facts.usedPercent,
    capturedAt: facts.capturedAt,
    observationFreshness: facts.observationFreshness,
    ...(facts.resetsAt === undefined ? {} : { resetsAt: facts.resetsAt }),
  };
}

function parseCapturedAt(value: unknown): { value: string; ms: number } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { value, ms } : undefined;
}

function parseWeeklyWindow(value: unknown): WeeklyObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const window = value as CodexQuotaWindow;
  if (!isValidWeeklyWindow(window)) {
    return undefined;
  }
  // `resetsAt*` are optional on purpose: the weekly window is usable without
  // them, and the renewal check below falls back to the server-stamped
  // `elapsed` flag when they are missing.
  return {
    usedPercent: window.usedPercent,
    elapsed: window.elapsed,
    ...(typeof window.resetsAt === "string" ? { resetsAt: window.resetsAt } : {}),
    ...(typeof window.resetsAtEpoch === "number" && Number.isFinite(window.resetsAtEpoch)
      ? { resetsAtEpoch: window.resetsAtEpoch }
      : {}),
  };
}

function isValidWeeklyWindow(
  window: CodexQuotaWindow,
): window is CodexQuotaWindow & { windowMinutes: number; usedPercent: number; elapsed: boolean } {
  if (window.windowMinutes !== WEEKLY_WINDOW_MINUTES) {
    return false;
  }
  if (typeof window.usedPercent !== "number") {
    return false;
  }
  if (!Number.isFinite(window.usedPercent)) {
    return false;
  }
  if (window.usedPercent < 0) {
    return false;
  }
  if (window.usedPercent > 100) {
    return false;
  }
  return typeof window.elapsed === "boolean";
}

/**
 * The admission decision. Returns a hold detail, or `undefined` to admit.
 *
 * Read the table in the file header before changing any branch here — each
 * `return undefined` below is a deliberate ADMIT that the pre-2026-09-28 code
 * got wrong, and the self-deadlock it caused is invisible to any test that only
 * exercises the hold path.
 */
function classifyObservation(
  observation: unknown,
  weeklyCapPercent: number,
  now: number,
): CodexSubscriptionCapDetail | undefined {
  const quota = asCodexQuotaObservation(observation);
  if (!quota) {
    return undefined; // no telemetry at all — absence is not evidence of breach
  }
  const captured = parseCapturedAt(quota.capturedAt);
  const weekly = parseWeeklyWindow(quota.secondary);
  if (!captured || !weekly) {
    return undefined; // no usable weekly window — same reason
  }
  if (isWindowRenewed(weekly, now)) {
    return undefined; // the quota window reset; the recorded % is void, not a breach
  }
  if (weekly.usedPercent < weeklyCapPercent) {
    return undefined; // below the cap, however old the reading is
  }
  // Positive evidence of being at or over the cap, inside a window that has not
  // yet reset. Stale readings hold here too — nothing ran in the gap, so our own
  // usage cannot have fallen — and self-heal at `resetsAt` via the branch above.
  return atCapDetail(weeklyCapPercent, {
    usedPercent: weekly.usedPercent,
    capturedAt: captured.value,
    observationFreshness: isStale(captured, now) ? "stale" : "fresh",
    ...(weekly.resetsAt === undefined ? {} : { resetsAt: weekly.resetsAt }),
  });
}

// True when the weekly quota window has rolled over — the server's stamp, or our
// own comparison against `resetsAt` for a reading that was cached across the
// boundary. A renewed window carries no usage evidence at all.
function isWindowRenewed(weekly: WeeklyObservation, now: number): boolean {
  if (weekly.elapsed) {
    return true;
  }
  return weekly.resetsAtEpoch !== undefined && now >= weekly.resetsAtEpoch * 1000;
}

function asCodexQuotaObservation(value: unknown): CodexQuotaObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as CodexQuotaObservation;
}

// Freshness of a reading, REPORTED on a hold and never a hold reason itself.
// A future `capturedAt` counts as stale: the clock disagreement makes the age
// unknowable, which is exactly what "do not trust this number" means.
function isStale(captured: { ms: number }, now: number): boolean {
  return now - captured.ms > MAX_OBSERVATION_AGE_MS || captured.ms > now;
}

/**
 * Admits a Codex turn unless the same-box acpx-ui quota endpoint gives positive
 * evidence that the weekly cap is reached.
 *
 * An unreadable endpoint is still a hold: that is a real dependency outage,
 * independent of Codex activity, and it clears on its own when acpx-ui returns.
 * Missing, stale or post-reset telemetry is NOT a hold — see the invariant at
 * the top of this file.
 */
export async function admitCodexSubscriptionTurn(params: {
  weeklyCapPercent: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  try {
    const observation = await readLocalQuota(params.fetchImpl);
    const hold = classifyObservation(
      observation,
      params.weeklyCapPercent,
      (params.now ?? Date.now)(),
    );
    if (hold) {
      throw new CodexSubscriptionCapError(hold);
    }
  } catch (error) {
    if (error instanceof CodexSubscriptionCapError) {
      throw error;
    }
    throw new CodexSubscriptionCapError(failedDetail(params.weeklyCapPercent, "read-failed"));
  }
}

/**
 * brick://c028c10e — THE TEST SEAM, AND WHY IT IS AN INPUT RATHER THAN A SWITCH.
 *
 * `ACPX_TEST_CODEX_QUOTA_JSON` supplies a canned observation in place of the HTTP
 * read. It does NOT disable the gate: the value is classified by exactly the same
 * `classifyObservation` as a real reading, so a canned at-cap window still HOLDs.
 * That is deliberate — a skip flag would make the admission path untested, while a
 * canned input leaves every branch live.
 *
 * WHY IT EXISTS. The gate is reached by CHILD PROCESSES in the suite (a test spawns
 * a real CLI, which takes a Codex turn), and `globalThis.fetch` cannot be
 * monkeypatched across a process boundary the way `test/runtime-test-helpers.ts`
 * does for in-process rows. The previous answer was an HTTP fixture server on a
 * hardcoded `127.0.0.1:3456` in `scripts/run-tests.mjs` — which is also real
 * acpx-ui's port, so two lanes could not run the suite at once and the lane that
 * took the heavy-gate mutex was the one that died (`EADDRINUSE`, `GATE_RC=1`, no
 * tally). Measured 2026-09-29; removed under this brick.
 *
 * ⚠️ IT IS ALSO A BACKDOOR, so it is deliberately hard to trip by accident and loud
 * when tripped:
 *   - it is honoured ONLY when the value parses as a usable quota observation
 *     (same `asCodexQuotaObservation` + `parseWeeklyWindow` the real path uses), so
 *     a stray or truncated value falls through to the real read rather than
 *     silently admitting;
 *   - every honoured read logs to stderr, so a leak into a box environment is
 *     visible in the logs instead of silently un-capping real spend.
 *
 * WHERE IT IS SET: `scripts/run-tests.mjs`, for the test run only. It is deliberately
 * suite-wide rather than per-test. Measured under this brick: FIVE rows across two
 * files need it, not one — and four of them are `cli.test.ts` BRICK tests whose agent
 * is `node <mock-agent.js>`, Codex-classified only because `isCodexAcpCommand`
 * substring-matches an `--operation-log …/codex-acp-ops.jsonl` argument
 * (brick://5a7cf1f0). Renaming that log file to de-classify them was tried and
 * REVERTED: the same classifier drives `resolvePrimerChannel`
 * (`src/acp/agent-command.ts:151`), so the substring is also what selects the
 * `developer-instructions` primer channel, and removing it dropped the
 * brick-context resolution those tests assert — 5 rows red with a missing
 * `brick context … --format inject`.
 *
 * ⚠️ NEVER set this in a box or pod environment. It belongs to the test harness only.
 */
// Returns a WRAPPER rather than the observation itself: the value is `unknown`, and
// `unknown | undefined` collapses to `unknown` (oxlint `no-redundant-type-constituents`
// rejects it), which would make "absent" indistinguishable from "a canned `undefined`".
function cannedQuotaFromEnv(): { observation: unknown } | undefined {
  const raw = process.env.ACPX_TEST_CODEX_QUOTA_JSON?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const quota = asCodexQuotaObservation(parsed);
  if (!quota || !parseWeeklyWindow(quota.secondary)) {
    return undefined;
  }
  process.stderr.write(
    "[acpx] codex subscription cap: using ACPX_TEST_CODEX_QUOTA_JSON instead of the acpx-ui quota endpoint\n",
  );
  return { observation: parsed };
}

async function readLocalQuota(fetchImpl: typeof fetch | undefined): Promise<unknown> {
  // PRECEDENCE: an explicitly injected `fetchImpl` > the canned env value > the real
  // read. An explicit injection is a caller saying exactly what this read must see,
  // and it must never be shadowed. Measured under brick://c028c10e: with the env
  // checked first, the suite-wide value silently overrode the injected responses in
  // `test/codex-subscription-cap.test.ts` and five HOLD rows went green-path — the
  // canned below-cap reading admitted turns the rows exist to prove are BLOCKED.
  // That is the exact shape of a test backdoor defeating the tests that guard it.
  // The env seam exists only for the case that has no `fetchImpl` at all: a child
  // process, where nothing can be injected across the boundary.
  if (fetchImpl === undefined) {
    const canned = cannedQuotaFromEnv();
    if (canned !== undefined) {
      return canned.observation;
    }
  }
  const response = await (fetchImpl ?? fetch)(`${LOCAL_ACPX_UI_ORIGIN}/api/usage/codex/quota`, {
    headers: { "User-Agent": "acpx/codex-subscription-cap" },
    signal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json();
}
