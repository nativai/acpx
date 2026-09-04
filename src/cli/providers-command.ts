import type { Command } from "commander";
import {
  BOX_PROVIDER_EXPIRY_WARNING_DAYS,
  boxProvidersPath,
  describeBoxProviders,
  type BoxProviderStatus,
} from "../config/providers.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";

// `acpx providers list` — the acpx-side read of ~/.acpx/providers.json.
//
// ⚠️ THIS IS A CREDENTIAL FILE AND THIS COMMAND RENDERS NO CREDENTIAL. It prints
// `describeBoxProviders()`, whose type has no slot for one; `grantId` and
// `keyHash` are audit references and safe (`keyHash` exists precisely so a key
// can be revoked without holding it). Do not add a key, or a prefix of one, to
// any output path here — `test/box-providers.test.ts` asserts the rendered text
// and JSON carry no `sk-`-shaped value.

function expiryPhrase(status: BoxProviderStatus): string {
  if (status.expiresInDays === undefined) {
    return "no expiry recorded";
  }
  if (status.expired) {
    return `EXPIRED ${Math.abs(status.expiresInDays)}d ago (${status.expiresAt})`;
  }
  const phrase = `expires in ${status.expiresInDays}d (${status.expiresAt})`;
  // The two-week warning. When a box key expires with nothing renewing it, every
  // OpenCode and Pi session on the box fails at the provider with a 401 that
  // surfaces as an unhelpful `UnknownError` — this line is what makes that a
  // warning instead of a fleet-wide surprise.
  return status.expiringSoon ? `⚠ ${phrase} — RENEW` : phrase;
}

function renderProvidersText(statuses: BoxProviderStatus[]): string {
  if (statuses.length === 0) {
    // Absent/empty is the NORMAL case, and the message says which file was read
    // so "none" cannot be confused with "looked in the wrong place".
    return `no box provider credentials (${boxProvidersPath()})\n`;
  }
  const lines = statuses.map((status) => {
    const parts = [
      `${status.name}  ${status.env}`,
      status.hasCredential ? "credential: present" : "credential: MISSING",
      expiryPhrase(status),
    ];
    if (status.budgetUsd !== undefined) {
      parts.push(`budget $${status.budgetUsd}${status.limitReset ? `/${status.limitReset}` : ""}`);
    }
    if (status.source !== undefined) {
      parts.push(`source ${status.source}`);
    }
    if (status.grantId !== undefined) {
      parts.push(`grant ${status.grantId}`);
    }
    return parts.join("  ·  ");
  });
  return `${lines.join("\n")}\n`;
}

function handleProvidersList(command: Command, config: ResolvedAcpxConfig): void {
  const { format } = resolveGlobalFlags(command, config);
  const statuses = describeBoxProviders();

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        path: boxProvidersPath(),
        warningDays: BOX_PROVIDER_EXPIRY_WARNING_DAYS,
        providers: statuses,
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    process.stdout.write(statuses.map((status) => `${status.name}\n`).join(""));
    return;
  }

  process.stdout.write(renderProvidersText(statuses));
}

/**
 * ⚠️ A NEW TOP-LEVEL VERB NEEDS TWO REGISTRATIONS. This one, and `"providers"`
 * in `TOP_LEVEL_VERBS` (`src/cli-core.ts`) — IN THE SAME COMMIT. Register only
 * here and `configurePublicCli` absorbs the token as an AGENT NAME instead, so
 * `acpx providers list` becomes a prompt delivery in a session-bearing cwd
 * rather than an error. `test/top-level-verbs.test.ts` enumerates what this
 * function registers and goes red if the set is not updated.
 */
export function registerProvidersCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const providersCommand = parent
    .command("providers")
    .description(
      "Box-scoped provider credentials (~/.acpx/providers.json): which providers this box can " +
        "reach and when each credential expires. Never prints a credential.",
    );

  providersCommand
    .command("list")
    .description(
      `List this box's provider credentials with days-to-expiry (warns at ${BOX_PROVIDER_EXPIRY_WARNING_DAYS} days or fewer)`,
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command) {
      handleProvidersList(this, config);
    });

  providersCommand.action(function (this: Command) {
    handleProvidersList(this, config);
  });
}
