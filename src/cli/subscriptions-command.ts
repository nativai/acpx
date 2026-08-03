import { Command } from "commander";
import {
  getSubscriptionsUsageWithFable,
  type SubscriptionUsage,
} from "../config/subscription-usage.js";
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

// Render the Fable-share cell (brick://1badc6f1). The probe is now truthful — a
// Claude-Code-shaped request returns the REAL Fable weekly window — so the reading
// is a genuine percentage, not the old advisory "flappy" verdict. `undefined` =
// not probed; `error` = the reading failed (UNKNOWN, not exhausted); `available:
// false` = a 429 that carried rate-limit headers, i.e. real exhaustion — which
// still shows its percentage, the one case where the number matters most.
export function formatFable(entry: SubscriptionUsage): string {
  const f = entry.fable;
  if (!f) {
    return "fable -";
  }
  if (f.error) {
    return `fable ? (${f.error})`;
  }
  const pct = f.utilization != null ? `${(f.utilization * 100).toFixed(1)}%` : null;
  const reset = f.reset ? `, resets ${f.reset}` : "";
  if (!f.available) {
    return pct ? `fable exhausted (${pct}${reset})` : "fable exhausted";
  }
  return pct ? `fable ${pct}${reset}` : "fable available";
}

/** The quiet fable field: `ok` | `exhausted` | `-` (not probed). */
function quietFable(entry: SubscriptionUsage): string {
  if (!entry.fable) {
    return "-";
  }
  return entry.fable.available ? "ok" : "exhausted";
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
    `\t7d ${formatPercent(entry.sevenDay)}${sevenReset}` +
    `\t${formatFable(entry)}\n`
  );
}

export function renderUsageText(usage: SubscriptionUsage[]): string {
  if (usage.length === 0) {
    return NO_REGISTRY_MESSAGE;
  }
  let out = "Subscription usage (5h / 7d / fable):\n";
  out +=
    "  (fable = the REAL Fable-5 weekly share, read from a 1-token claude-fable-5 probe and " +
    "served from a per-account snapshot at most 2h old; --reprobe forces a fresh read)\n";
  for (const entry of usage) {
    out += renderUsageEntryText(entry);
  }
  return out;
}

/** Quiet output for a subscription-usage list: one `id\t5h%\t7d%\tfable:<state>` line each. */
export function renderSubscriptionsUsageQuiet(usage: SubscriptionUsage[]): string {
  return usage
    .map(
      (entry) =>
        `${entry.id}\t${formatPercent(entry.fiveHour)}\t${formatPercent(entry.sevenDay)}\tfable:${quietFable(entry)}\n`,
    )
    .join("");
}

async function handleSubscriptionsUsage(
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  // Fable is served from the persisted per-account snapshot and only re-probed
  // when that snapshot is stale — so repeating this command inside the fresh
  // window issues NO outbound fable probe. `--reprobe` is the explicit override.
  const reprobe = command.opts<{ reprobe?: boolean }>().reprobe === true;
  const usage = await getSubscriptionsUsageWithFable(loadSubscriptionRegistry().subscriptions, {
    fableMode: reprobe ? "force" : "gated",
  });

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
    .description(
      "Per-subscription 5h + 7d utilization plus the REAL Fable-5 weekly share. " +
        "The 5h/7d windows are probed on every run; the Fable share is served from a " +
        "per-account snapshot (~/.acpx/usage/fable) and re-probed only when it is stale — " +
        "older than 2h, past its reset, or superseded by local Fable activity, and then at " +
        "most once every 5 minutes per account.",
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .option(
      "--reprobe",
      "Force a fresh Fable probe, bypassing the staleness gate (still collapsed to one " +
        "probe per 30s per account). NOT the default and not a routine habit: use it only " +
        "when you have concrete reason to believe the current reading is outdated (e.g. " +
        "suspected spend from another box, or a reading that contradicts a real turn).",
    )
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
