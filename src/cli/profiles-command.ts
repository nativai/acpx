import { Command } from "commander";
import { getValidEffortsForProfile, loadProfileRegistry } from "../config/profiles.js";
import type { ProfileEntry } from "../config/profiles.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";

type ProfileDisplayEntry = {
  id: string;
  label: string;
  account: string;
  accountEmail: string | null;
  adapter: string;
  authMode: string;
  model: string | null;
  reasoningSupported: boolean;
  validEfforts: readonly string[] | null;
};

function toDisplayEntry(p: ProfileEntry): ProfileDisplayEntry {
  return {
    id: p.id,
    label: p.label,
    account: p.account,
    accountEmail: p.accountEmail ?? null,
    adapter: p.adapter,
    authMode: p.authMode,
    model: p.model ?? null,
    reasoningSupported: p.authMode === "openrouter" ? (p.reasoningSupported ?? false) : false,
    validEfforts: getValidEffortsForProfile(p),
  };
}

function renderProfileListEntry(entry: ProfileDisplayEntry, defaultId?: string): string {
  const marker = entry.id === defaultId ? "*" : " ";
  const efforts = entry.validEfforts ? entry.validEfforts.join("/") : "n/a";
  const model = entry.model ? `  model=${entry.model}` : "";
  const email = entry.accountEmail ? ` (${entry.accountEmail})` : "";
  return (
    `  ${marker} ${entry.id}\t[${entry.adapter}/${entry.authMode}]\t${entry.label}${model}\n` +
    `      account: ${entry.account}${email}\n` +
    `      reasoning: ${entry.reasoningSupported ? "supported" : "not supported"}  valid-efforts: ${efforts}\n`
  );
}

function renderProfilesListText(entries: ProfileDisplayEntry[], defaultId?: string): string {
  if (entries.length === 0) {
    return "No profiles registered (~/.acpx/subscriptions/registry.json absent or empty).\n";
  }
  let out = `Profiles (default: ${defaultId ?? "-"}):\n`;
  for (const e of entries) {
    out += renderProfileListEntry(e, defaultId);
  }
  return out;
}

function handleProfilesList(command: Command, config: ResolvedAcpxConfig): void {
  const { format } = resolveGlobalFlags(command, config);
  const registry = loadProfileRegistry();
  const entries = registry.profiles.map(toDisplayEntry);

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({ default: registry.default ?? null, profiles: entries })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    process.stdout.write(entries.map((e) => `${e.id}\n`).join(""));
    return;
  }

  process.stdout.write(renderProfilesListText(entries, registry.default));
}

function handleProfileShow(command: Command, id: string, config: ResolvedAcpxConfig): void {
  const { format } = resolveGlobalFlags(command, config);
  const registry = loadProfileRegistry();
  const profile = registry.profiles.find((p) => p.id === id.trim());

  if (!profile) {
    process.stderr.write(`[acpx] profile "${id}" not found in registry\n`);
    process.exit(1);
  }

  const entry = toDisplayEntry(profile);

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
    return;
  }

  const efforts = entry.validEfforts ? entry.validEfforts.join(", ") : "n/a";
  process.stdout.write(
    `Profile: ${entry.id}\n` +
      `  label:            ${entry.label}\n` +
      `  account:          ${entry.account}\n` +
      `  accountEmail:     ${entry.accountEmail ?? "-"}\n` +
      `  adapter:          ${entry.adapter}\n` +
      `  authMode:         ${entry.authMode}\n` +
      `  model:            ${entry.model ?? "-"}\n` +
      `  reasoningSupported: ${String(entry.reasoningSupported)}\n` +
      `  valid efforts:    ${efforts}\n`,
  );
}

export function registerProfilesCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const profilesCommand = parent
    .command("profiles")
    .description(
      "List profiles and their reasoning support/valid effort levels (for agent discovery)",
    );

  profilesCommand
    .command("list")
    .description(
      "List all profiles: id, authMode, model, reasoningSupported, valid --reasoning-effort levels",
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command) {
      handleProfilesList(this, config);
    });

  profilesCommand
    .command("show <id>")
    .description("Show a single profile with its reasoning support and valid effort levels")
    .option("--format <fmt>", "Output format: text, json", parseOutputFormat)
    .action(function (this: Command, id: string) {
      handleProfileShow(this, id, config);
    });

  // Default action (no subcommand): behave like `profiles list`
  profilesCommand.action(function (this: Command) {
    handleProfilesList(this, config);
  });
}
