import { Command, InvalidArgumentError } from "commander";
import {
  type HarnessCapabilities,
  HARNESS_IDS,
  isHarnessId,
  listHarnessCapabilities,
  resolveHarnessCapabilities,
} from "../acp/harness-capabilities.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";

function renderCapabilityText(capability: HarnessCapabilities): string {
  const providers = capability.credential.providers?.join(", ") ?? "-";
  const forkIndex =
    capability.fork.atIndex +
    (capability.fork.atIndex === "turn-granular"
      ? ` (rounds ${capability.fork.atIndexRounding ?? "down"} to every ${
          capability.fork.atIndexGranularityMessages ?? "?"
        } messages)`
      : "");
  return (
    `  ${capability.id}\t${capability.label}\n` +
    `      model:        ${capability.model.mechanism}  catalogue=${capability.model.catalogue}  live=${capability.canSetModelLive}\n` +
    (capability.liveModelChangeReason
      ? `      model locked: ${capability.liveModelChangeReason}\n`
      : "") +
    `      depth:        ${capability.depth.mechanism}  ladder=${capability.depth.ladder}  live=${capability.canSetDepthLive}\n` +
    `      models:       arbitrary=${capability.acceptsArbitraryModelIds} (${capability.arbitraryModelSupport})  default=${capability.defaultModelKey}\n` +
    `      credential:   ${capability.credential.tier}  providers=${providers}\n` +
    `      fork:         supported=${capability.fork.supported}  at-index=${forkIndex}\n` +
    `      primer:       ${capability.primerChannel}  mid-turn-steering=${capability.midTurnSteering}\n` +
    `      profiles=${capability.supportsProfiles}  output-styles=${capability.supportsOutputStyles}  usage=${capability.usageReporting}  images=${capability.promptImages}\n`
  );
}

function renderCapabilitiesListText(capabilities: HarnessCapabilities[]): string {
  return (
    "Harness capabilities (declared in acpx, src/acp/harness-capabilities.ts):\n" +
    capabilities.map(renderCapabilityText).join("")
  );
}

function writeCapabilities(
  command: Command,
  config: ResolvedAcpxConfig,
  capabilities: HarnessCapabilities[],
  single: boolean,
): void {
  const { format } = resolveGlobalFlags(command, config);
  const json = format === "json" || command.opts().json === true;

  if (json) {
    // The list form prints a BARE ARRAY on purpose: it is the exact value
    // acpx-ui serves as `agents` on `GET /api/config`, so the two views can be
    // diffed after `jq -S` without either side unwrapping the other.
    process.stdout.write(`${JSON.stringify(single ? capabilities[0] : capabilities)}\n`);
    return;
  }

  if (format === "quiet") {
    process.stdout.write(capabilities.map((capability) => `${capability.id}\n`).join(""));
    return;
  }

  process.stdout.write(renderCapabilitiesListText(capabilities));
}

/**
 * `acpx capabilities [agent]` — the CLI read of the per-harness capability
 * descriptor, for humans and for agents (Daniel, 2026-09-03 22:58:57Z: acpx
 * exposes it "to the web app (API) and to humans and agents (CLI)").
 *
 * ⚠️ The verb MUST also be listed in `TOP_LEVEL_VERBS` (src/cli-core.ts).
 * Without that, `configurePublicCli` registers an unrecognised first token as an
 * AGENT, and `acpx capabilities` prints "No acpx session found (searched up to
 * /tmp)" and exits 0 — a command that looks like it works and reads nothing.
 * That is why the program TEST-PLAN's IR-2 asserts this command on STDOUT
 * CONTENT with "No acpx session found" as the negative control, never on rc.
 */
export function registerCapabilitiesCommand(parent: Command, config: ResolvedAcpxConfig): void {
  parent
    .command("capabilities [agent]")
    .description(
      `Show what each harness can do (${HARNESS_IDS.join(
        ", ",
      )}): model/depth mechanism, fork, primer, credential tier`,
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .option("--json", "Shorthand for --format json")
    .action(function (this: Command, agent: string | undefined) {
      if (agent === undefined) {
        writeCapabilities(this, config, listHarnessCapabilities(), false);
        return;
      }
      const requested = agent.trim();
      if (!isHarnessId(requested)) {
        throw new InvalidArgumentError(
          `Unknown agent "${requested}" — acpx declares capabilities for: ${HARNESS_IDS.join(", ")}`,
        );
      }
      writeCapabilities(this, config, [resolveHarnessCapabilities(requested)], true);
    });
}
