import { reapSessionScratch, SCRATCH_MAX_AGE_MS } from "../session/scratch-reaper.js";

/**
 * `acpx __scratch-reap [--max-age-days <n>]` — one pass of the 14-day scratch reaper over this state
 * home's `session-tmp/` (block A8). Called by the control pod's janitor; refuses in an agent pod
 * (`control_pod_only`, exit 2). JSON on stdout, exit 0; any other failure exit 1 with the reason on stderr.
 */
const FLAG = "--max-age-days";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The ONLY accepted arguments: none, `--max-age-days <n>`, or `--max-age-days=<n>`. Every other token — an
 * unknown flag (`--dry-run`!), a stray word, a repeated flag — is refused ("bad"), so the caller exits 2
 * BEFORE anything is judged or removed (TE finding F3: a `--dry-run` that deleted was a trap).
 */
function flagValue(args: string[]): string | undefined {
  const first = args[0] ?? "";
  if (first === FLAG && args.length === 2) {
    return args[1];
  }
  return first.startsWith(`${FLAG}=`) && args.length === 1
    ? first.slice(FLAG.length + 1)
    : undefined;
}

function maxAgeMsFrom(args: string[]): number | "bad" {
  if (args.length === 0) {
    return SCRATCH_MAX_AGE_MS;
  }
  const value = flagValue(args);
  const days = value?.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(days) && days > 0 ? days * DAY_MS : "bad";
}

export async function runScratchReap(args: string[] = []): Promise<void> {
  try {
    const maxAgeMs = maxAgeMsFrom(args);
    if (maxAgeMs === "bad") {
      process.stderr.write(
        "[acpx] scratch reap: usage: acpx __scratch-reap [--max-age-days <n>] (any other argument is refused)\n",
      );
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
