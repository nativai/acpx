/**
 * Compact, human-readable "how long since this timestamp" formatter for CLI
 * session output. Turns an ISO timestamp (e.g. a session's `lastUsedAt`) plus a
 * reference `now` into a short idle duration like `45s`, `47m`, `2h13m`, or
 * `3d4h`.
 *
 * Returns `null` when the input is not a parseable timestamp, so callers can
 * omit the field rather than print a bogus value. Future timestamps (clock
 * skew) clamp to `0s`.
 */
export function formatIdleDuration(iso: string, nowMs: number): string | null {
  const thenMs = Date.parse(iso);
  if (Number.isNaN(thenMs)) {
    return null;
  }

  const diffMs = Math.max(0, nowMs - thenMs);
  const totalSeconds = Math.floor(diffMs / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return `${totalHours}h${minutes}m`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d${hours}h`;
}
