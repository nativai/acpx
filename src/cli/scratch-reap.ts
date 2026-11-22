import { reapSessionScratch, SCRATCH_MAX_AGE_MS } from "../session/scratch-reaper.js";

/**
 * `acpx __scratch-reap [--max-age-days <n>]` — one pass of the 14-day scratch reaper over this state
 * home's `session-tmp/` (block A8). Called by the control pod's janitor; refuses in an agent pod
 * (`control_pod_only`, exit 2). JSON on stdout, exit 0; any other failure exit 1 with the reason on stderr.
 */
function maxAgeMsFrom(args: string[]): number | "bad" {
  const flag = args.indexOf("--max-age-days");
  if (flag < 0) {
    return SCRATCH_MAX_AGE_MS;
  }
  const days = Number(args[flag + 1]);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : "bad";
}

export async function runScratchReap(args: string[] = []): Promise<void> {
  try {
    const maxAgeMs = maxAgeMsFrom(args);
    if (maxAgeMs === "bad") {
      process.stderr.write("[acpx] scratch reap: --max-age-days needs a positive number\n");
      process.exitCode = 2;
      return;
    }
    const result = await reapSessionScratch({ maxAgeMs });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const detail = (error as { detailCode?: string }).detailCode;
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = detail === "control_pod_only" ? 2 : 1;
  }
}
