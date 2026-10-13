export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Port of openclaw/acpx e1a0795b. Only ESRCH proves a pid number is unused IN THIS PID
 * NAMESPACE; EPERM means a live process we may not signal. Never judge a RECORDED pid with
 * this alone — a pid recorded in another namespace reads ESRCH here while its process lives
 * (process-identity.ts `observeProcessIncarnation` scopes it first).
 */
export function isProcessDefinitelyDead(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
