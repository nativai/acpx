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
 *   - **`1.x` entries carry a BARE version and no caret** (`opencode` below).
 *     Adding a caret there silently converts the pin into a range while the row
 *     still looks like its neighbours.
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
const ACP_ADAPTER_PACKAGE_RANGES = {
  pi: "^0.0.33",
  codex: "^0.0.44",
  /**
   * ⚠️ BARE, NOT `^1.18.28` — see the caret rule above. opencode-ai is a 1.x
   * package, so a caret here would accept every later 1.x and the row would read
   * as a pin while behaving as a range.
   *
   * Pinned at the version the registry was ALREADY serving as `latest` on
   * 2026-09-04, and which both npx caches on this box already held, so the pin
   * FREEZES today's behaviour rather than moving it. Before this, the entry was
   * `npx -y opencode-ai acp` with no version at all: every box resolved
   * `latest` independently, at spawn, so two boxes could run different OpenCode
   * builds while every descriptor claim about OpenCode read identically
   * (brick 0ededc52).
   */
  opencode: "1.18.28",
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

export const AGENT_REGISTRY: Record<string, string> = {
  pi: `npx pi-acp@${ACP_ADAPTER_PACKAGE_RANGES.pi}`,
  openclaw: "openclaw acp",
  codex: process.env.ACPX_CODEX_ACP_COMMAND || `node /opt/codex-acp/dist/index.js`,
  claude: process.env.ACPX_CLAUDE_ACP_COMMAND || `node /opt/claude-agent-acp/dist/index.js`,
  gemini: "gemini --acp",
  cursor: "cursor-agent acp",
  copilot: "copilot --acp --stdio",
  // Same built /opt-fork env-seam pattern as claude/codex; alphabetical-tail
  // position per the listBuiltInAgents ordering convention.
  "claude-pty": process.env.ACPX_CLAUDE_PTY_ACP_COMMAND || `node /opt/claude-pty-acp/dist/index.js`,
  droid: "droid exec --output-format acp",
  iflow: "iflow --experimental-acp",
  kilocode: "npx -y @kilocode/cli acp",
  kimi: "kimi acp",
  kiro: "kiro-cli-chat acp",
  opencode: `npx -y opencode-ai@${ACP_ADAPTER_PACKAGE_RANGES.opencode} acp`,
  qoder: "qodercli --acp",
  qwen: "qwen --acp",
  trae: "traecli acp serve",
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
