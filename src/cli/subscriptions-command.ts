import { Command } from "commander";
import { getSubscriptionsUsage, type SubscriptionUsage } from "../config/subscription-usage.js";
import type { SubscriptionRegistry } from "../config/subscriptions.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";

const NO_REGISTRY_MESSAGE =
  "No subscriptions registered (~/.acpx/subscriptions/registry.json absent or empty).\n";

function renderSubscriptionsListText(registry: SubscriptionRegistry): string {
  if (registry.subscriptions.length === 0) {
    return NO_REGISTRY_MESSAGE;
  }
  let out = `Subscriptions (default: ${registry.default ?? "-"}):\n`;
  for (const entry of registry.subscriptions) {
    const marker = entry.id === registry.default ? "*" : " ";
    out += `  ${marker} ${entry.id}\t${entry.label}\t${entry.configDir}\n`;
  }
  return out;
}

function handleSubscriptionsList(command: Command, config: ResolvedAcpxConfig): void {
  const { format } = resolveGlobalFlags(command, config);
  const registry = config.subscriptions;

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        default: registry.default ?? null,
        subscriptions: registry.subscriptions,
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    process.stdout.write(registry.subscriptions.map((entry) => `${entry.id}\n`).join(""));
    return;
  }

  process.stdout.write(renderSubscriptionsListText(registry));
}

export function formatPercent(window: SubscriptionUsage["fiveHour"]): string {
  if (!window) {
    return "-";
  }
  return `${(window.utilization * 100).toFixed(1)}%`;
}

function renderUsageEntryText(entry: SubscriptionUsage): string {
  if (entry.error) {
    return `  ${entry.id}\t${entry.label}\tERROR: ${entry.error}\n`;
  }
  const fiveReset = entry.fiveHour?.reset ? ` (resets ${entry.fiveHour.reset})` : "";
  const sevenReset = entry.sevenDay?.reset ? ` (resets ${entry.sevenDay.reset})` : "";
  return (
    `  ${entry.id}\t${entry.label}` +
    `\t5h ${formatPercent(entry.fiveHour)}${fiveReset}` +
    `\t7d ${formatPercent(entry.sevenDay)}${sevenReset}\n`
  );
}

export function renderUsageText(usage: SubscriptionUsage[]): string {
  if (usage.length === 0) {
    return NO_REGISTRY_MESSAGE;
  }
  let out = "Subscription usage (5h / 7d utilization):\n";
  for (const entry of usage) {
    out += renderUsageEntryText(entry);
  }
  return out;
}

/** Quiet output for a subscription-usage list: one `id\t5h%\t7d%` line each. */
export function renderSubscriptionsUsageQuiet(usage: SubscriptionUsage[]): string {
  return usage
    .map(
      (entry) =>
        `${entry.id}\t${formatPercent(entry.fiveHour)}\t${formatPercent(entry.sevenDay)}\n`,
    )
    .join("");
}

async function handleSubscriptionsUsage(
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  const usage = await getSubscriptionsUsage(config.subscriptions.subscriptions);

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(usage)}\n`);
    return;
  }

  if (format === "quiet") {
    process.stdout.write(renderSubscriptionsUsageQuiet(usage));
    return;
  }

  process.stdout.write(renderUsageText(usage));
}

export function registerSubscriptionsCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const subscriptionsCommand = parent
    .command("subscriptions")
    .description("List Claude subscriptions and per-subscription usage");

  subscriptionsCommand
    .command("list")
    .description("List registered subscriptions (ids, labels, default)")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command) {
      handleSubscriptionsList(this, config);
    });

  subscriptionsCommand
    .command("usage")
    .description("Per-subscription 5h + 7d utilization (probes each subscription's token)")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command) {
      await handleSubscriptionsUsage(this, config);
    });

  subscriptionsCommand.action(async function (this: Command) {
    handleSubscriptionsList(this, config);
  });
}
