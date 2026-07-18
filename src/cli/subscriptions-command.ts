import { Command } from "commander";
import { getSubscriptionsUsage, type SubscriptionUsage } from "../config/subscription-usage.js";
import {
  findSubscription,
  isSubscriptionLocked,
  loadSubscriptionRegistry,
  setSubscriptionLockState,
  type SubscriptionLockMutationResult,
  type SubscriptionRegistry,
} from "../config/subscriptions.js";
import { SubscriptionUnknownError } from "../errors.js";
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
    const locked = isSubscriptionLocked(entry, registry) ? "\tlocked" : "";
    out += `  ${marker} ${entry.id}\t${entry.label}\t${entry.configDir}${locked}\n`;
  }
  return out;
}

function handleSubscriptionsList(command: Command, config: ResolvedAcpxConfig): void {
  const { format } = resolveGlobalFlags(command, config);
  const registry = loadSubscriptionRegistry();

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
  const usage = await getSubscriptionsUsage(loadSubscriptionRegistry().subscriptions);

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

function printSubscriptionLockResult(
  result: SubscriptionLockMutationResult,
  format: ReturnType<typeof resolveGlobalFlags>["format"],
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${result.subscription}\n`);
    return;
  }
  const state = result.locked ? "locked" : "unlocked";
  const affected = result.affected.length > 1 ? ` (${result.affected.length} linked entries)` : "";
  process.stdout.write(`subscription ${state}: ${result.subscription}${affected}\n`);
}

function handleSubscriptionLockSet(
  subscriptionId: string,
  locked: boolean,
  command: Command,
  config: ResolvedAcpxConfig,
): void {
  const { format } = resolveGlobalFlags(command, config);
  const id = subscriptionId.trim();
  const registry = loadSubscriptionRegistry();
  if (!findSubscription(id, registry)) {
    throw new SubscriptionUnknownError(
      id,
      registry.subscriptions.map((entry) => entry.id),
    );
  }
  const lockedBy = process.env.ACPX_LOCKED_BY?.trim();
  const result = setSubscriptionLockState(id, locked, lockedBy ? { lockedBy } : {});
  if (!result) {
    throw new SubscriptionUnknownError(
      id,
      registry.subscriptions.map((entry) => entry.id),
    );
  }
  printSubscriptionLockResult(result, format);
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

  subscriptionsCommand
    .command("lock")
    .description("Lock a Claude SDK subscription so new turns cannot use it")
    .argument("<id>", "Subscription id")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command, id: string) {
      handleSubscriptionLockSet(id, true, this, config);
    });

  subscriptionsCommand
    .command("unlock")
    .description("Unlock a Claude SDK subscription")
    .argument("<id>", "Subscription id")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command, id: string) {
      handleSubscriptionLockSet(id, false, this, config);
    });

  subscriptionsCommand.action(async function (this: Command) {
    handleSubscriptionsList(this, config);
  });
}
