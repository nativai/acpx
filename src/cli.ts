#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listBuiltInAgents } from "./agent-registry.js";
import { runPlacementStep } from "./pod/placement-step.js";
// Block A2 registers the `record-only-create` branch (C1.3); a light module, see its header.
import "./pod/record-only-create-branch.js";

// ⚠️ THIS ENTRY STAYS LIGHT, AND ITS RE-EXPORTS OF `cli-core` WERE REMOVED FOR IT (brick b479441f).
// Pod mode decides where a command runs BEFORE acpx loads the world (CONTRACTS-r4 C1.2, CONCEPTION r4
// §12 "route before loading the world"): the static graph of this file is node builtins, the agent
// registry and `src/pod/`. A static import of `cli-core.js` here — or an `export … from` it, which
// is the same thing to the module loader — costs every invocation ~0.5 s before the decision is made.
// `classifyConnectionStatus`, `formatPromptSessionBannerLine`, `parseAllowedTools`, `parseMaxTurns`
// and `parseTtlSeconds` are exported by `cli-core.js`. Held by `test/pod-command-classes.test.ts`
// ("the CLI entry's static graph does not reach commander").

function installBrokenPipeHandler(stream: NodeJS.WritableStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }

    throw error;
  });
}

function isCliEntrypoint(argv: string[]): boolean {
  const entry = argv[1];
  if (!entry) {
    return false;
  }

  try {
    // Resolve symlinks so global npm installs match (argv[1] is the
    // symlink in node_modules/.bin, import.meta.url is the real path).
    const resolved = pathToFileURL(realpathSync(entry)).href;
    return import.meta.url === resolved;
  } catch {
    return false;
  }
}

/** The same normalization `main` applies (`normalizeLifecycleScriptArgs` in cli-core). */
function placementArgv(argv: string[]): string[] {
  const raw = argv.slice(2);
  return raw[0] === "--" && (process.env.npm_lifecycle_event || process.env.npm_lifecycle_script)
    ? raw.slice(1)
    : raw;
}

async function start(): Promise<void> {
  const outcome = await runPlacementStep({
    argv: placementArgv(process.argv),
    builtInAgents: () => listBuiltInAgents(),
    loadTargetResolver: async () => (await import("./pod/target-resolver.js")).targetResolver,
    write: (line) => process.stderr.write(`${line}\n`),
  });
  if (outcome !== "proceed") {
    process.exitCode = outcome.exitCode;
    return;
  }

  const { buildQueueOwnerArgOverride } = await import("./cli/session/queue-owner-process.js");
  const queueOwnerArgOverride = buildQueueOwnerArgOverride(fileURLToPath(import.meta.url));
  if (queueOwnerArgOverride) {
    process.env.ACPX_QUEUE_OWNER_ARGS ??= queueOwnerArgOverride;
  }

  const { main } = await import("./cli-core.js");
  await main(process.argv);
}

if (isCliEntrypoint(process.argv)) {
  installBrokenPipeHandler(process.stdout);
  installBrokenPipeHandler(process.stderr);

  if (process.argv.length === 3 && process.argv[2] === "__spawn-ledger-module") {
    process.stdout.write(`${new URL("./spawn-ledger.js", import.meta.url).href}\n`);
  } else if (process.argv.length === 3 && process.argv[2] === "__command-classes-module") {
    // atrium loads the class table in-process from the acpx it runs (C6.2; brick b479441f
    // reports/EXPORT-class-table.md) — the spawn-ledger pattern.
    process.stdout.write(`${new URL("./pod/command-classes.js", import.meta.url).href}\n`);
  } else {
    void start();
  }
}
