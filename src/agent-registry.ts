import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ⚠️ THESE ARE EXACT PINS, NOT RANGES — **BUT THE CARET IS NOT WHAT MAKES THEM
 * SO, AND COPYING IT ONTO A 1.x PACKAGE PRODUCES A RANGE.**
 *
 * Under npm semver a caret on a `0.0.x` version allows **only that patch**
 * (`^0.0.26` resolves to `0.0.26` and nothing else), because npm treats
 * `0.0.x` as fully pinned. On a `1.y.z` version the same caret allows **any
 * later 1.x** — `^1.18.28` would accept `1.19.0`. So:
 *
 *   - `0.0.x` entries carry `^` and are exact. Read `^` as `==` for THOSE rows.
 *   - **a `1.x` entry must carry a BARE version and no caret.** Adding a caret
 *     there silently converts the pin into a range while the row still looks
 *     like its neighbours.
 *
 * A version here therefore tracks nothing and every bump is a deliberate code
 * change.
 *
 * `pi`: bumped `0.0.26` → `0.0.33` (npm latest, published 2026-07-30) by B0.2.
 * ⚠️ **A bump is not progress on any other row.** I2 measured 0.0.33 fixing
 * NONE of the four Pi gaps: still no `fork` capability (the string appears zero
 * times in either version), still a hardcoded `~/.pi/pi-acp` session map, still
 * no MCP, still no primer channel. The nativai fork is what closes those (B5).
 * The bump's only claim is that acpx launches the newest published adapter, and
 * `G1-PIN-01` verifies it by the SPAWN LINE — the registry string is the intent,
 * the spawn line is the fact.
 */
export const ACP_ADAPTER_PACKAGE_RANGES = {
  pi: "^0.0.33",
  // ⚠️ `codex: "^0.0.44"` WAS HERE AND IS REMOVED — it was a stale pin that
  // pinned nothing. It was referenced NOWHERE (codex launches from the built
  // `/opt/codex-acp`, not from npm), and it named a version the deployed build
  // was already past: `/opt/codex-acp` is `0.0.45`. So it was a version claim
  // that governed no behaviour and could not be shown to have expired — exactly
  // what `measuredAgainst` (brick 4791a88c) exists to eliminate, sitting in the
  // pinning table itself.
  //
  // It is REMOVED rather than corrected because there is nothing to correct it
  // TO: no npm spec governs a container-built artifact. Codex's version claim
  // lives where it can be checked — `HARNESS_FACTS.codex.measuredAgainst`, which
  // names the commit and the bundled CLI and says how to re-derive both.
  //
  // ⚠️ THIS TABLE IS FOR npx-LAUNCHED ADAPTERS ONLY. claude, claude-pty and codex
  // are `/opt` builds and must not gain rows here; a row for one of them would
  // read as a pin while governing nothing, which is how this entry arose.
} as const;

type BuiltInAgentPackageSpec = {
  packageName: string;
  packageRange: string;
  preferredBinName: string;
  fallbackCommand: string;
  legacyFallbackCommands?: string[];
};

type BuiltInAgentLaunch = {
  source: "installed" | "package-exec";
  command: string;
  args: string[];
  packageName: string;
  packageRange: string;
  packageVersion?: string;
  binPath?: string;
  npmCliPath?: string;
};

type BuiltInLaunchResolverOptions = {
  existsSync?: (path: string) => boolean;
  readFileSync?: typeof fs.readFileSync;
  resolvePackageRoot?: (packageName: string) => string;
  execPath?: string;
  resolveNpmCliPath?: (execPath: string) => string;
};

/**
 * Pi's adapter command — the nativai fork when the box has it, upstream's
 * published package otherwise (B5, brick ef5999ca).
 *
 * ⚠️ THIS IS THE ONE REGISTRY ENTRY THAT IS NOT A CONSTANT, AND THE REASON IS A
 * TRANSITION, NOT A PREFERENCE. `claude`/`codex`/`claude-pty` point at their
 * `/opt` forks unconditionally because every box's bootstrap builds them. Pi's
 * fork is new: a box whose bootstrap predates it has no `/opt/pi-acp`, and an
 * unconditional path there would break `pi` outright on that box rather than
 * degrade. So the fork is used when it is present and upstream when it is not —
 * and **the spawn line, not this string, is what tells you which one ran**
 * (`G4-PI-01`).
 *
 * The upstream fallback is REMOVABLE ONLY once every box in the fleet builds
 * `/opt/pi-acp`; until then, deleting it silently converts "this box is behind"
 * into "pi does not work here".
 *
 * ⚠️ The capability descriptor (`harness-capabilities.ts`) describes the FORK —
 * `session/set_model`, `session/fork`, usage over ACP. On a box still falling
 * back to upstream those three are advertised and refused at the wire, which is
 * exactly the drift `G4-PI-01` exists to catch. The fallback is a safety net for
 * a box mid-rollout, not a supported configuration.
 */
export const PI_ACP_FORK_PATH = "/opt/pi-acp/dist/index.js";

export function resolvePiAcpCommand(
  env: NodeJS.ProcessEnv = process.env,
  existsSync: (path: string) => boolean = fs.existsSync,
): string {
  const override = env.ACPX_PI_ACP_COMMAND?.trim();
  if (override) {
    return override;
  }
  return existsSync(PI_ACP_FORK_PATH)
    ? `node ${PI_ACP_FORK_PATH}`
    : `npx pi-acp@${ACP_ADAPTER_PACKAGE_RANGES.pi}`;
}

const CODEX_ACP_FORK_COMMAND = `node /opt/codex-acp/dist/index.js`;
const CLAUDE_ACP_FORK_COMMAND = `node /opt/claude-agent-acp/dist/index.js`;
const CLAUDE_PTY_ACP_FORK_COMMAND = `node /opt/claude-pty-acp/dist/index.js`;

export const AGENT_REGISTRY: Record<string, string> = {
  pi: resolvePiAcpCommand(),
  openclaw: "openclaw acp",
  codex: process.env.ACPX_CODEX_ACP_COMMAND || CODEX_ACP_FORK_COMMAND,
  claude: process.env.ACPX_CLAUDE_ACP_COMMAND || CLAUDE_ACP_FORK_COMMAND,
  gemini: "gemini --acp",
  cursor: "cursor-agent acp",
  copilot: "copilot --acp --stdio",
  // Same built /opt-fork env-seam pattern as claude/codex; alphabetical-tail
  // position per the listBuiltInAgents ordering convention.
  "claude-pty": process.env.ACPX_CLAUDE_PTY_ACP_COMMAND || CLAUDE_PTY_ACP_FORK_COMMAND,
  droid: "droid exec --output-format acp",
  iflow: "iflow --experimental-acp",
  kilocode: "npx -y @kilocode/cli acp",
  kimi: "kimi acp",
  kiro: "kiro-cli-chat acp",
  qoder: "qodercli --acp",
  qwen: "qwen --acp",
  trae: "traecli acp serve",
};

/**
 * The commands acpx SHIPS for the agents whose {@link AGENT_REGISTRY} entry is
 * not a constant — every form each can resolve to, with both the env seam and
 * the box probe at their defaults.
 *
 * ## ⚠️ WHY THIS EXISTS, AND WHAT IT COSTS TO NOT HAVE IT (brick 82a18653)
 *
 * `AGENT_REGISTRY` is a SNAPSHOT of what THIS box resolves at import, and for
 * `pi` that snapshot flips the moment a box builds `/opt/pi-acp`. Two assertions
 * — the pin-table row in `test/adapter-version-pins.test.ts` and the anti-drift
 * row in `test/harness-measurement-citations.test.ts` — read the snapshot as if
 * it were the registry's whole behaviour. They therefore passed on all five
 * boxes on 2026-09-05 and failed on all five on 2026-09-06, with nothing about
 * the registry, the pin table or the citations having changed: the bootstrap
 * rolled out `/opt/pi-acp`, and the tests were measuring the box.
 *
 * **A rule that must hold FLEET-WIDE cannot be computed from one box's
 * resolution**, and the repair is not to skip on box state — a test that passes
 * by not looking would re-hide the drift those rows exist to catch. It is to
 * check every form the registry CAN launch, which is what this table names.
 *
 * ⚠️ The env seam (`ACPX_PI_ACP_COMMAND`, `ACPX_CODEX_ACP_COMMAND`, …) is
 * deliberately EXCLUDED here: it is an operator escape hatch pointing acpx at
 * something acpx does not ship, so it is not a form the shipped pin table or the
 * shipped citations can be expected to describe. `AGENT_REGISTRY` still honours
 * it, and `listAgentLaunchForms` reports it — see there.
 */
const BUILT_IN_LAUNCH_FORMS: Record<string, readonly string[]> = {
  // Both arms of the resolver, derived from it rather than restated, so a change
  // to either arm cannot leave this table describing the old one.
  pi: [resolvePiAcpCommand({}, () => true), resolvePiAcpCommand({}, () => false)],
  codex: [CODEX_ACP_FORK_COMMAND],
  claude: [CLAUDE_ACP_FORK_COMMAND],
  "claude-pty": [CLAUDE_PTY_ACP_FORK_COMMAND],
};

/**
 * Every command the built-in registry can launch `agentName` with, **on any
 * box** — box-independent and env-independent by construction, so a check
 * written against it holds fleet-wide.
 *
 * Returns `[]` for an agent the registry does not know.
 *
 * ⚠️ **This is what acpx SHIPS, which is not always what this box RUNS.** An
 * `ACPX_*_ACP_COMMAND` override replaces the shipped command at runtime and is
 * not listed here; `agentCommandEnvSeam` names the variable that does it, and
 * `test/agent-registry.test.ts` pins that `AGENT_REGISTRY` never resolves to
 * anything outside `listAgentLaunchForms(agent) ∪ {that override}` — the control
 * that keeps this enumeration answerable to the live box rather than merely
 * self-consistent.
 */
export function listAgentLaunchForms(agentName: string): string[] {
  const normalized = normalizeAgentName(agentName);
  const builtIn = BUILT_IN_LAUNCH_FORMS[normalized];
  if (builtIn) {
    return [...new Set(builtIn)];
  }
  const snapshot = AGENT_REGISTRY[normalized];
  return snapshot === undefined ? [] : [snapshot];
}

/** The env var that replaces `agentName`'s shipped command, where one exists. */
export function agentCommandEnvSeam(agentName: string): string | undefined {
  return AGENT_COMMAND_ENV_SEAMS[normalizeAgentName(agentName)];
}

const AGENT_COMMAND_ENV_SEAMS: Record<string, string> = {
  pi: "ACPX_PI_ACP_COMMAND",
  codex: "ACPX_CODEX_ACP_COMMAND",
  claude: "ACPX_CLAUDE_ACP_COMMAND",
  "claude-pty": "ACPX_CLAUDE_PTY_ACP_COMMAND",
};

// `claude`, `codex`, and `claude-pty` are intentionally absent here. Their
// AGENT_REGISTRY entries point at the container-built forks
// (`node /opt/claude-agent-acp/dist/index.js`, `node /opt/codex-acp/dist/index.js`,
// `node /opt/claude-pty-acp/dist/index.js`); with no built-in-package spec,
// findBuiltInAgentPackage() returns undefined for those commands, both resolvers
// bail, and the client spawns the /opt command verbatim. Adding a spec whose
// fallbackCommand equals the /opt command would make resolveInstalledBuiltInAgentLaunch
// prefer an installed npm package and silently shadow the fork — this exact
// collision once broke Codex session copy.
export const BUILT_IN_AGENT_PACKAGES = {} as const satisfies Record<
  string,
  BuiltInAgentPackageSpec
>;

const AGENT_ALIASES: Record<string, string> = {
  "factory-droid": "droid",
  factorydroid: "droid",
};

export const DEFAULT_AGENT_NAME = "codex";

export function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase();
}

export function mergeAgentRegistry(overrides?: Record<string, string>): Record<string, string> {
  if (!overrides) {
    return { ...AGENT_REGISTRY };
  }

  const merged = { ...AGENT_REGISTRY };
  for (const [name, command] of Object.entries(overrides)) {
    const normalized = normalizeAgentName(name);
    if (!normalized || !command.trim()) {
      continue;
    }
    merged[normalized] = command.trim();
  }
  return merged;
}

export function resolveAgentCommand(agentName: string, overrides?: Record<string, string>): string {
  const normalized = normalizeAgentName(agentName);
  const registry = mergeAgentRegistry(overrides);
  return registry[normalized] ?? registry[AGENT_ALIASES[normalized] ?? normalized] ?? agentName;
}

// Reverse of resolveAgentCommand: the registry agent name whose command equals
// `agentCommand`, or undefined for a raw/unknown command (e.g. an `--agent`
// escape hatch). Used only to label an INHERITED agent in spawn banners; the
// record's `agentCommand` remains the source of truth.
export function resolveAgentNameFromCommand(
  agentCommand: string,
  overrides?: Record<string, string>,
): string | undefined {
  const normalized = agentCommand.trim();
  if (!normalized) {
    return undefined;
  }
  const registry = mergeAgentRegistry(overrides);
  for (const [name, command] of Object.entries(registry)) {
    if (command === normalized) {
      return name;
    }
  }
  return undefined;
}

export function findBuiltInAgentPackage(agentCommand: string): BuiltInAgentPackageSpec | undefined {
  const normalized = agentCommand.trim();
  const builtInAgentPackages = Object.values(BUILT_IN_AGENT_PACKAGES) as BuiltInAgentPackageSpec[];
  return builtInAgentPackages.find(
    (spec) =>
      spec.fallbackCommand === normalized || spec.legacyFallbackCommands?.includes(normalized),
  );
}

function defaultResolvePackageRoot(packageName: string): string {
  const segments = packageName.split("/");
  let cursor = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    const candidateRoot = path.join(cursor, "node_modules", ...segments);
    const manifestPath = path.join(candidateRoot, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          name?: string;
        };
        if (parsed.name === packageName) {
          return candidateRoot;
        }
      } catch {
        // best effort; keep walking upward
      }
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`Built-in agent package not found: ${packageName}`);
    }
    cursor = parent;
  }
}

function resolvePackageBin(
  spec: BuiltInAgentPackageSpec,
  manifest: {
    bin?: string | Record<string, string>;
  },
): string | undefined {
  if (typeof manifest.bin === "string") {
    return manifest.bin;
  }
  if (!manifest.bin || typeof manifest.bin !== "object") {
    return undefined;
  }
  return (
    manifest.bin[spec.preferredBinName] ??
    (Object.keys(manifest.bin).length === 1 ? Object.values(manifest.bin)[0] : undefined)
  );
}

function defaultResolveNpmCliPath(execPath: string): string {
  const candidate = path.resolve(
    path.dirname(execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  if (!fs.existsSync(candidate)) {
    throw new Error(`npm CLI not found for execPath: ${execPath}`);
  }
  return candidate;
}

export function resolveInstalledBuiltInAgentLaunch(
  agentCommand: string,
  options: BuiltInLaunchResolverOptions = {},
): BuiltInAgentLaunch | undefined {
  const spec = findBuiltInAgentPackage(agentCommand);
  if (!spec) {
    return undefined;
  }

  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const resolvePackageRoot = options.resolvePackageRoot ?? defaultResolvePackageRoot;

  try {
    const resolved = resolveInstalledBuiltInAgentPackage(spec, {
      readFileSync,
      existsSync,
      resolvePackageRoot,
    });
    if (!resolved) {
      return undefined;
    }

    return {
      source: "installed",
      command: process.execPath,
      args: [resolved.binPath],
      packageName: spec.packageName,
      packageRange: spec.packageRange,
      packageVersion: resolved.packageVersion,
      binPath: resolved.binPath,
    };
  } catch {
    return undefined;
  }
}

function resolveInstalledBuiltInAgentPackage(
  spec: BuiltInAgentPackageSpec,
  options: Required<
    Pick<BuiltInLaunchResolverOptions, "readFileSync" | "existsSync" | "resolvePackageRoot">
  >,
): { packageVersion?: string; binPath: string } | undefined {
  const packageRoot = options.resolvePackageRoot(spec.packageName);
  const manifest = JSON.parse(
    options.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    name?: string;
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (manifest.name !== spec.packageName) {
    return undefined;
  }

  const relativeBinPath = resolvePackageBin(spec, manifest);
  if (!relativeBinPath) {
    return undefined;
  }

  const binPath = path.resolve(packageRoot, relativeBinPath);
  return options.existsSync(binPath) ? { packageVersion: manifest.version, binPath } : undefined;
}

export function resolvePackageExecBuiltInAgentLaunch(
  agentCommand: string,
  options: BuiltInLaunchResolverOptions = {},
): BuiltInAgentLaunch | undefined {
  const spec = findBuiltInAgentPackage(agentCommand);
  if (!spec) {
    return undefined;
  }

  const existsSync = options.existsSync ?? fs.existsSync;
  const execPath = options.execPath ?? process.execPath;
  const resolveNpmCliPath = options.resolveNpmCliPath ?? defaultResolveNpmCliPath;

  try {
    const npmCliPath = resolveNpmCliPath(execPath);
    if (!existsSync(npmCliPath)) {
      return undefined;
    }

    return {
      source: "package-exec",
      command: execPath,
      args: [
        npmCliPath,
        "exec",
        "--yes",
        `--package=${spec.packageName}@${spec.packageRange}`,
        "--",
        spec.preferredBinName,
      ],
      packageName: spec.packageName,
      packageRange: spec.packageRange,
      npmCliPath,
    };
  } catch {
    return undefined;
  }
}

export function resolveBuiltInAgentLaunch(
  agentCommand: string,
  options: BuiltInLaunchResolverOptions = {},
): BuiltInAgentLaunch | undefined {
  return (
    resolveInstalledBuiltInAgentLaunch(agentCommand, options) ??
    resolvePackageExecBuiltInAgentLaunch(agentCommand, options)
  );
}

export function listBuiltInAgents(overrides?: Record<string, string>): string[] {
  return Object.keys(mergeAgentRegistry(overrides));
}

/**
 * Every string `resolveAgentCommand` recognizes as a real agent selector --
 * registry keys (built-in + config overrides, from {@link listBuiltInAgents})
 * PLUS every {@link AGENT_ALIASES} key. Deliberately a SEPARATE function from
 * `listBuiltInAgents`, not a widening of it: that one drives CLI subcommand
 * registration and its exact shape is pinned by
 * `test/agent-registry.test.ts` ("preserves the required example prefix and
 * alphabetical tail") for help-text ordering, so folding aliases into it
 * would register them as their own top-level subcommands and reorder that
 * pinned list for an unrelated reason. This is for a caller that needs "would
 * this string be recognized as an agent at all" (e.g. refusing an ambiguous
 * `--agent` override, brick 618f1dbf) — spread from `AGENT_ALIASES` directly,
 * not enumerated, so an alias added there is covered here BY CONSTRUCTION.
 */
export function listKnownAgentSelectorNames(overrides?: Record<string, string>): string[] {
  return [...new Set([...listBuiltInAgents(overrides), ...Object.keys(AGENT_ALIASES)])];
}
