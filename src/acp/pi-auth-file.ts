import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxProvidersPath, loadBoxProviders, resolveBoxProviderKey } from "../config/providers.js";

// pi's box OpenRouter credential — through its `auth.json`, never the environment
// (brick 1dc24c1c, Daniel 2026-10-24).
//
// pi resolves a provider key from `<agentDir>/auth.json` before any environment
// variable, and a key value that starts with `!` is a shell command pi runs once per
// process, using its stdout (pi 0.84.4 `dist/core/resolve-config-value.js`:
// `execSync(command)` with pi's own environment, 10 s timeout, result cached for the
// process lifetime). So the entry written here is a COMMAND THAT READS
// `~/.acpx/providers.json` — the key itself is never copied anywhere, and a re-minted
// key reaches the next pi process with no acpx involvement.
//
// WHICH auth.json: `<agentDir>` is `PI_CODING_AGENT_DIR`, which acpx re-points at the
// session's own config dir (`writePiConfigDir`). So the file pi reads is
// `<per-session dir>/auth.json` — NOT the box's `~/.pi/agent/auth.json` (or
// `ACPX_PI_BOX_AGENT_DIR`), which an acpx-spawned pi never opens.
//
// ⚠️ THE BOX auth.json IS DELIBERATELY NOT CARRIED FORWARD. No acpx pi session has ever
// read it (the per-session dir hides it), so copying its entries in would be a new
// behaviour — and it would copy whatever secrets it holds into a `/tmp` directory per
// session, the exact multiplication of copies this file exists to avoid. The
// per-session file is the destination and it is authoritative, the same rule as the
// rest of the per-session dir: entries already in it (a resumed session's dir, or a
// `/login` pi wrote during the session) are kept, and only `openrouter` is (re)written.

/** pi's provider id for OpenRouter — also the `providers.json` entry name. */
const OPENROUTER_PROVIDER = "openrouter";

/**
 * Prints the box key on stdout. Mirrors `resolveBoxProviderKey`'s precedence
 * (`apiKeyEnv` beats a literal `apiKey`), evaluated against pi's own environment.
 * Plain CommonJS for `node -e`; contains no single quote so the shell quoting below
 * stays trivially correct.
 */
const READ_KEY_SCRIPT =
  `const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));` +
  `const e=(f.providers||{})[${JSON.stringify(OPENROUTER_PROVIDER)}]||{};` +
  `const v=e.apiKeyEnv&&process.env[e.apiKeyEnv];` +
  `process.stdout.write(String(v&&v.trim()?v:e.apiKey||"").trim())`;

/** POSIX single-quote: the only shell quoting that needs no further escaping. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `auth.json` key value for the box OpenRouter credential: a `!command` that
 * reads `providersPath` with THIS node binary.
 *
 * ⚠️ AN ABSOLUTE NODE PATH, NOT `node` OR `jq`. pi runs the command with
 * `/bin/sh -c` under its own `PATH`; `process.execPath` is the binary acpx itself
 * runs on, on the same pod, so it exists wherever pi does. `jq` is not guaranteed
 * on every image. The file is rewritten at every spawn, so a moved binary is
 * picked up by the next one.
 */
export function piOpenRouterKeyCommand(
  providersPath: string,
  nodePath: string = process.execPath,
): string {
  return `!${shellQuote(nodePath)} -e ${shellQuote(READ_KEY_SCRIPT)} ${shellQuote(providersPath)}`;
}

/** The existing per-session file's entries; anything unreadable starts from empty. */
function readAuthEntries(authPath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Absent is the normal first-spawn case; a malformed file would make pi refuse
    // to start ("Invalid auth.json"), so replacing it loses nothing usable.
  }
  return {};
}

/**
 * Ensure `<dir>/auth.json` carries the box OpenRouter credential as a command
 * reference. Idempotent: the same spawn input writes the same bytes.
 *
 * Writes NOTHING when the box declares no `openrouter` provider, or declares one
 * whose credential does not resolve against `env` (the agent env the command will
 * run in) — an entry whose command prints nothing would only replace pi's own
 * "no key" error with a less clear one.
 *
 * @returns the path written, or `undefined` when nothing was written.
 */
export function writePiAuthFile(
  dir: string,
  env: NodeJS.ProcessEnv,
  providersPath: string = boxProvidersPath(),
): string | undefined {
  const entry = loadBoxProviders({ providersPath }).providers.find(
    (provider) => provider.name === OPENROUTER_PROVIDER,
  );
  if (!entry || resolveBoxProviderKey(entry, env) === undefined) {
    return undefined;
  }
  const authPath = join(dir, "auth.json");
  const entries = readAuthEntries(authPath);
  entries[OPENROUTER_PROVIDER] = { type: "api_key", key: piOpenRouterKeyCommand(providersPath) };
  writeFileSync(authPath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  return authPath;
}
