import { Command, InvalidArgumentError } from "commander";
import {
  HARNESS_IDS,
  type HarnessCapabilities,
  isHarnessId,
  listHarnessCapabilities,
  resolveHarnessCapabilities,
} from "../acp/harness-capabilities.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";

/** The JSON envelope. Keyed `agents` so acpx-ui can assign it to `/api/config.agents` unchanged. */
export interface AgentsListPayload {
  agents: HarnessCapabilities[];
}

const COLUMNS = [
  { header: "ID", read: (c: HarnessCapabilities) => c.id },
  { header: "MODEL", read: (c: HarnessCapabilities) => c.model.mechanism },
  { header: "LIVE", read: (c: HarnessCapabilities) => (c.canSetModelLive ? "yes" : "no") },
  { header: "DEPTH", read: (c: HarnessCapabilities) => c.depth.mechanism },
  { header: "LIVE", read: (c: HarnessCapabilities) => (c.canSetDepthLive ? "yes" : "no") },
  {
    header: "FORK@INDEX",
    read: (c: HarnessCapabilities) => (c.fork.supported ? c.fork.atIndex : "no fork"),
  },
  { header: "PRIMER", read: (c: HarnessCapabilities) => c.primerChannel },
  { header: "CREDENTIAL", read: (c: HarnessCapabilities) => c.credential.tier },
  { header: "MODEL ID", read: (c: HarnessCapabilities) => c.defaultModelKey },
] as const;

function renderTable(capabilities: HarnessCapabilities[]): string {
  const rows = capabilities.map((capability) => COLUMNS.map((column) => column.read(capability)));
  const widths = COLUMNS.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd() + "\n";

  const footnotes: string[] = [];
  for (const capability of capabilities) {
    if (capability.liveModelChangeReason) {
      footnotes.push(`  ${capability.id}: model is locked — ${capability.liveModelChangeReason}\n`);
    }
    if (capability.fork.atIndex === "turn-granular") {
      footnotes.push(
        `  ${capability.id}: fork --at-index rounds ${capability.fork.atIndexRounding ?? "down"} to ` +
          `every ${capability.fork.atIndexGranularityMessages ?? "?"} messages, so an odd index ` +
          "does NOT land where it was asked to.\n",
      );
    }
  }

  return (
    "Harness capabilities, declared in acpx (src/acp/harness-capabilities.ts).\n\n" +
    line(COLUMNS.map((column) => column.header)) +
    rows.map(line).join("") +
    (footnotes.length > 0 ? `\nNotes:\n${footnotes.join("")}` : "")
  );
}

function renderDetail(capability: HarnessCapabilities): string {
  const providers = capability.credential.providers?.join(", ") ?? "-";
  const forkIndex =
    capability.fork.atIndex +
    (capability.fork.atIndex === "turn-granular"
      ? ` (rounds ${capability.fork.atIndexRounding ?? "down"} to every ${
          capability.fork.atIndexGranularityMessages ?? "?"
        } messages)`
      : "");
  return (
    `${capability.id}  (${capability.label})\n` +
    `  model:            ${capability.model.mechanism}  catalogue=${capability.model.catalogue}  live=${capability.canSetModelLive}\n` +
    (capability.liveModelChangeReason
      ? `  model locked:     ${capability.liveModelChangeReason}\n`
      : "") +
    `  depth:            ${capability.depth.mechanism}  ladder=${capability.depth.ladder}  live=${capability.canSetDepthLive}\n` +
    `  arbitrary models: ${capability.acceptsArbitraryModelIds} (${capability.arbitraryModelSupport})\n` +
    `  default model:    ${capability.defaultModelKey}\n` +
    `  credential:       ${capability.credential.tier}  providers=${providers}\n` +
    `  fork:             supported=${capability.fork.supported}  at-index=${forkIndex}\n` +
    `  primer:           ${capability.primerChannel}\n` +
    `  mid-turn steer:   ${capability.midTurnSteering}\n` +
    `  profiles=${capability.supportsProfiles}  output-styles=${capability.supportsOutputStyles}  usage=${capability.usageReporting}  images=${capability.promptImages}\n`
  );
}

/** `--json` is a shorthand for the repo's own `--format json`; both are accepted. */
function wantsJson(command: Command, format: string): boolean {
  // optsWithGlobals, not opts: commander binds a flag to the ANCESTOR that
  // declares it, so `agents show <id> --json` lands `json` on `agents`, and a
  // plain `.opts()` on the subcommand reads an empty object and silently
  // prints text. Measured against commander directly, 2026-09-04.
  return format === "json" || command.optsWithGlobals().json === true;
}

function handleAgentsList(command: Command, config: ResolvedAcpxConfig): void {
  const { format } = resolveGlobalFlags(command, config);
  const capabilities = listHarnessCapabilities();

  if (wantsJson(command, format)) {
    const payload: AgentsListPayload = { agents: capabilities };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (format === "quiet") {
    process.stdout.write(capabilities.map((capability) => `${capability.id}\n`).join(""));
    return;
  }
  process.stdout.write(renderTable(capabilities));
}

function handleAgentShow(command: Command, id: string, config: ResolvedAcpxConfig): void {
  const { format } = resolveGlobalFlags(command, config);
  const requested = id.trim();
  if (!isHarnessId(requested)) {
    throw new InvalidArgumentError(
      `Unknown agent "${requested}" — acpx declares capabilities for: ${HARNESS_IDS.join(", ")}`,
    );
  }
  const capability = resolveHarnessCapabilities(requested);

  if (wantsJson(command, format)) {
    process.stdout.write(`${JSON.stringify(capability)}\n`);
    return;
  }
  process.stdout.write(renderDetail(capability));
}

/**
 * `acpx agents` / `acpx agents show <id>` — the CLI read of the per-harness
 * capability descriptor, for humans and for agents (Daniel, 2026-09-03
 * 22:58:57Z: acpx exposes it "to the web app (API) and to humans and agents
 * (CLI)"; 23:00:02Z: it must be BROWSABLE BY AGENTS via the CLI, which is why
 * this is a plural noun with a `show` subcommand like `profiles` and
 * `subscriptions` rather than a verb of its own shape).
 *
 * ⚠️ The noun MUST also be listed in `TOP_LEVEL_VERBS` (src/cli-core.ts).
 * Without that, `configurePublicCli` registers an unrecognised first token as an
 * AGENT NAME, and `acpx agents` prints "No acpx session found (searched up to
 * /tmp)" and exits 0 — a command that looks like it works and reads nothing.
 * That is why the program TEST-PLAN's IR-2 asserts this command on STDOUT
 * CONTENT with "No acpx session found" as the negative control, never on rc.
 *
 * ⚠️ The list form's JSON is the ENVELOPE `{"agents": [...]}`, not a bare array:
 * it is the exact shape acpx-ui serves as `GET /api/config`'s `agents` field, so
 * the consumer assigns `parsed.agents` with no reshaping, and the envelope can
 * grow a sibling field later without breaking every consumer.
 */
export function registerAgentsCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const agentsCommand = parent
    .command("agents")
    .description(
      `Show what each harness can do (${HARNESS_IDS.join(
        ", ",
      )}): model/depth mechanism, fork, primer, credential tier`,
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .option("--json", "Shorthand for --format json");

  agentsCommand
    .command("list")
    .description("List every harness acpx declares capabilities for")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .option("--json", "Shorthand for --format json")
    .action(function (this: Command) {
      handleAgentsList(this, config);
    });

  agentsCommand
    .command("show <id>")
    .description("Show one harness's capability descriptor in full")
    .option("--format <fmt>", "Output format: text, json", parseOutputFormat)
    .option("--json", "Shorthand for --format json")
    .action(function (this: Command, id: string) {
      handleAgentShow(this, id, config);
    });

  // Default action (no subcommand): behave like `agents list`, matching `profiles`.
  agentsCommand.action(function (this: Command) {
    handleAgentsList(this, config);
  });
}
