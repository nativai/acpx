import { CodexSubscriptionCapError } from "../../errors.js";
import type { CodexSubscriptionCapDetail } from "../../types.js";

const WEEKLY_WINDOW_MINUTES = 10_080;
const MAX_OBSERVATION_AGE_MS = 120_000;
const ADMISSION_TIMEOUT_MS = 2_000;
const LOCAL_ACPX_UI_ORIGIN = "http://127.0.0.1:3456";

type CodexQuotaWindow = {
  windowMinutes?: unknown;
  usedPercent?: unknown;
  elapsed?: unknown;
};

type CodexQuotaObservation = {
  capturedAt?: unknown;
  secondary?: CodexQuotaWindow | null;
};

function failedDetail(
  weeklyCapPercent: number,
  status: CodexSubscriptionCapDetail["status"],
  observation?: { usedPercent?: number; capturedAt?: string },
): CodexSubscriptionCapDetail {
  return {
    code: "codex-subscription-cap",
    providerSubmitted: false,
    weeklyCapPercent,
    status,
    ...(observation?.usedPercent === undefined
      ? {}
      : { observedWeeklyPercent: observation.usedPercent }),
    ...(observation?.capturedAt === undefined ? {} : { capturedAt: observation.capturedAt }),
  };
}

function parseCapturedAt(value: unknown): { value: string; ms: number } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { value, ms } : undefined;
}

function parseWeeklyWindow(value: unknown): { usedPercent: number; elapsed: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const window = value as CodexQuotaWindow;
  if (!isValidWeeklyWindow(window)) {
    return undefined;
  }
  return { usedPercent: window.usedPercent, elapsed: window.elapsed };
}

function isValidWeeklyWindow(window: CodexQuotaWindow): window is {
  windowMinutes: number;
  usedPercent: number;
  elapsed: boolean;
} {
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

function classifyObservation(
  observation: unknown,
  weeklyCapPercent: number,
  now: number,
): CodexSubscriptionCapDetail | undefined {
  const quota = asCodexQuotaObservation(observation);
  if (!quota) {
    return failedDetail(weeklyCapPercent, "absent");
  }
  const captured = parseCapturedAt(quota.capturedAt);
  const weekly = parseWeeklyWindow(quota.secondary);
  if (!captured || !weekly) {
    return failedDetail(weeklyCapPercent, "absent");
  }
  const facts = { usedPercent: weekly.usedPercent, capturedAt: captured.value };
  if (weekly.elapsed) {
    return failedDetail(weeklyCapPercent, "elapsed", facts);
  }
  if (isStale(captured, now)) {
    return failedDetail(weeklyCapPercent, "stale", facts);
  }
  return facts.usedPercent >= weeklyCapPercent
    ? failedDetail(weeklyCapPercent, "at-cap", facts)
    : undefined;
}

function asCodexQuotaObservation(value: unknown): CodexQuotaObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as CodexQuotaObservation;
}

function isStale(captured: { ms: number }, now: number): boolean {
  return now - captured.ms > MAX_OBSERVATION_AGE_MS || captured.ms > now;
}

/**
 * Admission depends only on the same-box acpx-ui quota endpoint. It neither
 * talks to Codex nor examines rollout files itself, so unavailable telemetry is
 * a hold rather than an opportunity to bypass the cap.
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

async function readLocalQuota(fetchImpl: typeof fetch | undefined): Promise<unknown> {
  const response = await (fetchImpl ?? fetch)(`${LOCAL_ACPX_UI_ORIGIN}/api/usage/codex/quota`, {
    headers: { "User-Agent": "acpx/codex-subscription-cap" },
    signal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json();
}
