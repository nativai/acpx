// D-IDENTITY (brick 61dc1302) — TEST-HARNESS addressing, not product behaviour.
//
// The product no longer resolves a session from the cwd or a name: every call names its
// session by id (AC-ID2). Hundreds of older CLI rows were written as "create a session in
// this cwd, then `prompt` / `status` / `set` with no selector". Those rows are about
// prompts, models and queues — not about how a session is FOUND — so the harness does what
// every caller must now do: it addresses the session it just made (or seeded) by
// `--session-id`. The refusal itself, and every removed resolution path, are pinned by the
// dedicated rows in test/identity-uuid-only.test.ts, which do NOT use this harness.
import fs from "node:fs";
import path from "node:path";

const TARGETING_VERBS = new Set([
  "prompt",
  "status",
  "cancel",
  "set-mode",
  "set",
  "output-styles",
  "set-metadata",
]);
const TARGETING_SESSIONS_VERBS = new Set(["show", "history", "read", "close", "export"]);
const NON_TARGETING_FIRST = new Set([
  "exec",
  "config",
  "agents",
  "models",
  "flow",
  "seats",
  "providers",
  "usage",
  "help",
]);

const created = new Map<string, string>();

function cwdOf(args: string[], optionsCwd: string | undefined): string {
  const index = args.indexOf("--cwd");
  return path.resolve(index >= 0 && args[index + 1] ? args[index + 1] : (optionsCwd ?? "."));
}

function isTargeting(args: string[]): boolean {
  if (args.includes("--session-id") || args.includes("--session-url") || args.includes("--help")) {
    return false;
  }
  const sessionsAt = args.indexOf("sessions");
  if (sessionsAt >= 0) {
    const verb = args[sessionsAt + 1];
    return verb !== undefined && TARGETING_SESSIONS_VERBS.has(verb);
  }
  if (args.some((token) => NON_TARGETING_FIRST.has(token))) {
    return false;
  }
  return args.some((token) => TARGETING_VERBS.has(token));
}

function newestOpenRecordIdFor(homeDir: string, cwd: string): string | undefined {
  const dir = path.join(homeDir, ".acpx", "sessions");
  let best: { id: string; at: string } | undefined;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith(".json") || name === "index.json" || name === "seats.json") {
      continue;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<
        string,
        unknown
      >;
      if (
        raw.cwd === cwd &&
        raw.closed !== true &&
        raw.kind !== "subagent" &&
        typeof raw.acpx_record_id === "string" &&
        (best === undefined || String(raw.last_used_at) > best.at)
      ) {
        best = { id: raw.acpx_record_id, at: String(raw.last_used_at) };
      }
    } catch {
      // unreadable fixture: not a candidate
    }
  }
  return best?.id;
}

/** Append `--session-id` to a session-targeting invocation that names none. */
export function addressByRememberedId(
  args: string[],
  homeDir: string,
  optionsCwd: string | undefined,
): string[] {
  if (!isTargeting(args)) {
    return args;
  }
  const cwd = cwdOf(args, optionsCwd);
  const id = created.get(`${homeDir}\0${cwd}`) ?? newestOpenRecordIdFor(homeDir, cwd);
  return id === undefined ? args : [...args, "--session-id", id];
}

/** Remember the session a successful `sessions new` just created, per (home, cwd). */
export function rememberCreatedSession(
  args: string[],
  homeDir: string,
  optionsCwd: string | undefined,
  result: { code: number | null; stdout: string; stderr: string },
): void {
  const sessionsAt = args.indexOf("sessions");
  if (result.code !== 0 || sessionsAt < 0 || args[sessionsAt + 1] !== "new") {
    return;
  }
  const match =
    /"acpxRecordId"\s*:\s*"([^"]+)"|created session ([0-9a-f-]{36})|^([0-9a-f-]{36})\b/m.exec(
      `${result.stdout}\n${result.stderr}`,
    );
  const id = match?.[1] ?? match?.[2] ?? match?.[3];
  if (id) {
    created.set(`${homeDir}\0${cwdOf(args, optionsCwd)}`, id);
  }
}
