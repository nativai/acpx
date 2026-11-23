#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listBuiltInAgents } from "./agent-registry.js";
import { runPlacementStep } from "./pod/placement-step.js";
import { registerRoutedBranches } from "./pod/routed-branches.js";
import { registerUtilityBranch } from "./pod/utility-branch.js";
// Block A2 registers the `record-only-create` branch (C1.3); a light module, see its header.
import "./pod/record-only-create-branch.js";
// Block A3 registers the `pass-through` and `message-route` branches (C6); a light module too.
import "./pod/pass-through-branch.js";

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

/**
 * K5 (brick 46b827ba): a pod's verdict re-run — the child the pass-through branch starts under the Node permission
 * model. Honoured ONLY in a process the runtime made read-only; anywhere else the variable is ignored and the
 * command is placed as always. In the armed child the placement step is skipped: acpx runs its real local path,
 * which stops at the resolver (`target-verdict.ts`).
 */
async function armedVerdictRun(): Promise<boolean> {
  if (!process.env.ACPX_POD_TARGET_VERDICT) {
    return false; // every ordinary invocation: nothing to load
  }
  const { VERDICT_ENV, armTargetVerdict, openSideChannel, parseVerdict, tellExit, tellParent } =
    await import("./pod/target-verdict.js");
  const guards = await import("./pod/armed-guards.js");
  const verdict = parseVerdict(process.env[VERDICT_ENV]);
  if (verdict === undefined || !guards.isReadOnlyProcess()) {
    return false;
  }
  delete process.env[VERDICT_ENV];
  armTargetVerdict(verdict);
  openSideChannel();
  guards.installArmedGuards();
  // The child's own word on how it ended: a normal end says so with its code; an uncaught exception says `crashed`.
  process.on("exit", (code) => tellExit(code));
  process.on("uncaughtExceptionMonitor", () => tellParent("crashed"));
  tellParent("readonly");
  return true;
}

async function start(): Promise<void> {
  registerRoutedBranches();
  registerUtilityBranch();
  const outcome = (await armedVerdictRun())
    ? "proceed"
    : await runPlacementStep({
        argv: placementArgv(process.argv),
        builtInAgents: () => listBuiltInAgents(),
        write: (line) => process.stderr.write(`${line}\n`),
        writeStdout: (line) => process.stdout.write(`${line}\n`),
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
  } else if (process.argv.length === 3 && process.argv[2] === "__pod-lock-module") {
    // The atrium server's loader for the lock module (pod-lock.ts; EXPORT-lock-module.md, brick 8d85cb47).
    process.stdout.write(`${new URL("./pod-lock.js", import.meta.url).href}\n`);
  } else if (process.argv.length === 3 && process.argv[2] === "__index-projection-module") {
    // The atrium server's loader for the index projection (index-projection.ts; block A8 → S5,
    // brick 88112988 reports/EXPORT-projection.md).
    process.stdout.write(`${new URL("./index-projection.js", import.meta.url).href}\n`);
  } else if (process.argv[2] === "__scratch-reap") {
    // One pass of the 14-day scratch reaper, for the control pod's janitor (block A8, TE F7).
    void import("./cli/scratch-reap.js").then(({ runScratchReap }) =>
      runScratchReap(process.argv.slice(3)),
    );
  } else if (process.argv[2] === "__pod-lock-sweep") {
    // One pass of the pod lock sweep over this state home (+ named dirs), for the idle loop (C3.2).
    // A DYNAMIC import: this entry's static graph stays light (see the ⚠️ above).
    void import("./cli/pod-lock-sweep.js").then(({ runPodLockSweep }) =>
      runPodLockSweep(process.argv.slice(3)),
    );
  } else {
    void start();
  }
}
