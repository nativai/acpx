/**
 * `acpx models` — the catalogue, the matcher and the favorites store as a CLI.
 *
 * Grammar: a bare plural noun, then a verb — the shape `acpx profiles`,
 * `acpx sessions new` and `acpx subscriptions lock` already use (C5 §6). The
 * structural precedent in this repo is `src/cli/profiles-command.ts`.
 *
 * ⚠️ REGISTRATION IS LOAD-BEARING, NOT COSMETIC. An unknown top-level token
 * falls through to the AGENT registry and is treated as an agent name: before
 * this command existed, `acpx models list` printed "No acpx session found"
 * (rc 4 in a session-free cwd) and, in a session-bearing cwd, would be parsed
 * as a PROMPT to an agent called "models". So `models` must be registered
 * top-level AND named in `TOP_LEVEL_VERBS` (`src/cli-core.ts`), and an
 * unrecognised subverb must fail loudly here rather than fall through to that
 * same delivery path.
 *
 * Everything printed is derived by `src/models/*`; this file only formats.
 */

import os from "node:os";
import { Command } from "commander";
import {
  decorateFavorites,
  findModelByKey,
  findModelsById,
  loadCatalogue,
} from "../models/catalogue.js";
import { describeDepth } from "../models/depth.js";
import { bandModels, isAvailableForAgent, searchModels } from "../models/matcher.js";
import { nearestModels, parseModelRef, searchToken } from "../models/model-slug-validation.js";
import type { CatalogueModel, ModelCatalogue } from "../models/types.js";
import { getUiPrefsStore } from "../models/ui-prefs-store.js";
import type { ResolvedAcpxConfig } from "./config.js";

const KNOWN_SUBVERBS = ["list", "show", "fav", "star", "unstar"];

type ModelsFlags = {
  search?: string;
  agent?: string;
  all?: boolean;
  json?: boolean;
  refresh?: boolean;
};

function out(text: string): void {
  process.stdout.write(text);
}

/** Diagnostics go to stderr so `--json` stdout stays strictly parseable. */
function diag(text: string): void {
  process.stderr.write(text);
}

function failUsage(message: string): never {
  diag(message.endsWith("\n") ? message : `${message}\n`);
  process.exit(2);
}

async function readCatalogue(flags: ModelsFlags): Promise<ModelCatalogue> {
  const catalogue = await loadCatalogue({ refresh: flags.refresh === true });
  let favorites: { key: string; favoritedAt: string }[] = [];
  try {
    favorites = getUiPrefsStore().listFavorites();
  } catch (error) {
    diag(`[acpx] warning: could not read the favorites store: ${asMessage(error)}\n`);
  }
  return decorateFavorites(catalogue, favorites);
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Formatting ───────────────────────────────────────────────────────────────

const SOURCE_TAGS: Record<string, string> = {
  openrouter: "or",
  "claude-subscription": "plan",
  "claude-home": "home",
  "claude-pty": "pty",
  chatgpt: "codex",
};

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function formatContext(length: number | null): string {
  if (length === null) {
    return "";
  }
  if (length >= 1_000_000) {
    return `${(length / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (length >= 1_000) {
    return `${Math.round(length / 1_000)}k`;
  }
  return String(length);
}

function formatPrice(value: number | null): string {
  if (value === null) {
    return "?";
  }
  if (value === 0) {
    return "0";
  }
  return value >= 1 ? String(Number(value.toFixed(2))) : String(Number(value.toFixed(4)));
}

function formatBilling(model: CatalogueModel): string {
  const billing = model.billing;
  if (billing.kind === "metered") {
    return `$${formatPrice(billing.inPerM)} / $${formatPrice(billing.outPerM)}`;
  }
  if (billing.kind === "plan") {
    return "on plan";
  }
  return billing.kind;
}

function formatRow(model: CatalogueModel, agentType: string | undefined): string {
  const star = model.favorite ? "★" : " ";
  const tag = SOURCE_TAGS[model.source] ?? model.source;
  const line =
    `  ${star} ${pad(tag, 5)} ${pad(truncate(model.id, 40), 40)} ` +
    `${pad(truncate(model.name, 30), 30)} ${pad(formatContext(model.contextLength), 7)} ` +
    `${pad(describeDepth(model.depth), 18)} ${formatBilling(model)}`;

  const blocked = blockingReason(model, agentType);
  return blocked ? `${line.trimEnd()}\n${" ".repeat(10)}↳ ${blocked}\n` : `${line.trimEnd()}\n`;
}

function blockingReason(model: CatalogueModel, agentType: string | undefined): string | null {
  if (!model.selectable) {
    return model.unavailableReasons.map((reason) => reason.message).join(" · ");
  }
  if (agentType) {
    const availability = model.availability[agentType];
    if (availability && !availability.ok) {
      return availability.message ?? availability.reason ?? "unavailable";
    }
  }
  return null;
}

function renderList(catalogue: ModelCatalogue, flags: ModelsFlags): string {
  const agentType = flags.agent?.trim() || undefined;
  const favoriteKeys = catalogue.models
    .filter((model) => model.favorite)
    .toSorted((a, b) => (b.favoritedAt ?? "").localeCompare(a.favoritedAt ?? ""))
    .map((model) => model.key);

  const bands = bandModels(catalogue.models, {
    favoriteKeys,
    agentType,
    includeUnavailable: flags.all === true,
  });

  let text = "";
  for (const band of bands) {
    text += `${band.label.toUpperCase()}  (${band.models.length})\n`;
    for (const model of band.models) {
      text += formatRow(model, agentType);
    }
  }
  if (bands.length === 0) {
    text +=
      "No models. The OpenRouter catalogue could not be read and no harness models are known.\n";
  }
  return text + renderFooter(catalogue, flags, agentType);
}

function renderFooter(
  catalogue: ModelCatalogue,
  flags: ModelsFlags,
  agentType: string | undefined,
): string {
  const box = os.hostname();
  const agentNote = agentType
    ? ` · ${catalogue.models.filter((model) => isAvailableForAgent(model, agentType)).length} available to ${agentType}`
    : "";
  const hidden = flags.all === true ? "" : " (acpx models --all to see them and why)";
  const freshness = catalogue.stale
    ? ` · catalogue STALE (fetched ${catalogue.fetchedAt}${catalogue.error ? `; last refresh failed: ${catalogue.error}` : ""})`
    : ` · catalogue fetched ${catalogue.fetchedAt}`;
  return (
    `${catalogue.counts.selectable} selectable on ${box} · ${catalogue.counts.unavailable} unavailable${hidden}` +
    `${agentNote}${freshness}\n`
  );
}

function renderSearch(catalogue: ModelCatalogue, flags: ModelsFlags): string {
  const agentType = flags.agent?.trim() || undefined;
  const favorites = new Set(catalogue.models.filter((model) => model.favorite).map((m) => m.key));
  const matches = searchModels(catalogue.models, flags.search ?? "", favorites).filter(
    (match) => flags.all === true || isAvailableForAgent(match.model, agentType),
  );

  let text = "";
  for (const match of matches) {
    text += formatRow(match.model, agentType);
  }
  if (matches.length === 0) {
    text += `No model matches "${flags.search}". ${catalogue.counts.total} in the catalogue — try a vendor name, or part of the id.\n`;
  }
  return `${text}  ${matches.length} of ${catalogue.counts.total}\n`;
}

/**
 * `acpx models show` MUST print the ladder and the default — Daniel,
 * 2026-09-03 23:00:02Z: "models to provide what thinking depths". Each of the
 * three descriptor kinds prints something honest; none of them prints nothing.
 */
function showDepthLines(model: CatalogueModel): string {
  const depth = model.depth;
  if (depth.kind === "ladder") {
    const mandatory = depth.mandatory ? "   (mandatory — no off rung)" : "";
    const dflt = depth.default ?? "the harness's own default";
    return `  depths      ${depth.levels.join(", ")}${mandatory}\n  depth dflt  ${dflt}\n`;
  }
  if (depth.kind === "boolean") {
    return (
      `  depths      no ladder — reasoning is on/off only\n` +
      `  depth dflt  ${depth.defaultEnabled ? "on" : "off"}\n`
    );
  }
  return `  depths      none — this model does not accept a reasoning setting\n  depth dflt  -\n`;
}

function showAvailabilityLine(model: CatalogueModel): string {
  if (Object.keys(model.availability).length === 0) {
    return "unknown — acpx has no harness-capability table on this build";
  }
  return Object.entries(model.availability)
    .map(([agent, value]) => `${agent}: ${value.ok ? "yes" : `no (${value.reason})`}`)
    .join(" · ");
}

function showExtraLines(model: CatalogueModel): string {
  let text = "";
  if (model.aliasTarget !== null) {
    text += `  alias of    ${model.aliasTarget.id}\n`;
  }
  if (model.equivalentTo.length > 0) {
    text += `  same model  ${model.equivalentTo.join(", ")}\n`;
  }
  if (model.badges.length > 0) {
    text += `  badges      ${model.badges.join(", ")}\n`;
  }
  return text;
}

function renderShow(model: CatalogueModel): string {
  const context = model.contextLength === null ? "-" : model.contextLength.toLocaleString("en-US");
  const selectable = model.selectable
    ? "yes"
    : `no — ${model.unavailableReasons.map((reason) => reason.message).join(" · ")}`;

  return (
    `  key         ${model.key}\n` +
    `  name        ${model.name}\n` +
    `  id          ${model.id}\n` +
    `  source      ${model.source}\n` +
    `  vendor      ${model.vendor}\n` +
    `  context     ${context}\n` +
    `  price       ${formatBilling(model)} per M\n` +
    `  tools       ${model.tools ? "yes" : "no"}\n` +
    showDepthLines(model) +
    `  selectable  ${selectable}\n` +
    `  available   ${showAvailabilityLine(model)}\n` +
    `  favorite    ${model.favorite ? `yes — starred ${model.favoritedAt}` : "no"}\n` +
    showExtraLines(model)
  );
}

// ── Reference resolution, shared by `show` and `fav add|rm` ──────────────────

/**
 * Resolve `source:id` or a bare `id` to exactly one model, or fail with the
 * SAME two error shapes the create path uses (C5 §6) — an unknown ref prints
 * the nearest matches, an ambiguous one prints both `source:id` forms with
 * their billing rather than guessing.
 */
function resolveOne(catalogue: ModelCatalogue, ref: string): CatalogueModel {
  const byKey = findModelByKey(catalogue, ref);
  if (byKey !== undefined) {
    return byKey;
  }

  const parsed = parseModelRef(ref);
  const byId = findModelsById(catalogue, parsed.id);
  const candidates =
    parsed.source === null ? byId : byId.filter((model) => model.source === parsed.source);

  const only = candidates[0];
  if (candidates.length === 1 && only !== undefined) {
    return only;
  }

  if (candidates.length === 0) {
    const list = nearestModels(catalogue, parsed.id)
      .map((model) => `    ${model.key}  —  ${model.name}${model.favorite ? "  ★ favorite" : ""}`)
      .join("\n");
    return failUsage(
      `[acpx] no model "${ref}" in this box's catalogue.\n` +
        (list === "" ? "" : `  did you mean:\n${list}\n`) +
        `  try: acpx models --search ${searchToken(parsed.id)}`,
    );
  }

  const sources = new Set(candidates.map((model) => model.source)).size;
  return failUsage(
    `[acpx] "${ref}" is served by ${sources} sources — a model is (source, id); say which:\n` +
      candidates.map((model) => `    ${model.key}  —  ${formatBilling(model)}`).join("\n"),
  );
}

// ── Actions ──────────────────────────────────────────────────────────────────

async function handleList(flags: ModelsFlags): Promise<void> {
  const catalogue = await readCatalogue(flags);
  if (flags.json === true) {
    const payload = flags.search
      ? {
          ...catalogue,
          models: searchModels(
            catalogue.models,
            flags.search,
            new Set(catalogue.models.filter((m) => m.favorite).map((m) => m.key)),
          ).map((match) => match.model),
        }
      : catalogue;
    out(`${JSON.stringify(payload)}\n`);
    return;
  }
  out(flags.search ? renderSearch(catalogue, flags) : renderList(catalogue, flags));
}

async function handleShow(ref: string, flags: ModelsFlags): Promise<void> {
  const catalogue = await readCatalogue(flags);
  const model = resolveOne(catalogue, ref);
  if (flags.json === true) {
    out(`${JSON.stringify(model)}\n`);
    return;
  }
  out(renderShow(model));
}

async function handleFavList(flags: ModelsFlags): Promise<void> {
  const favorites = getUiPrefsStore().listFavorites();
  if (flags.json === true) {
    out(`${JSON.stringify({ favorites })}\n`);
    return;
  }
  if (favorites.length === 0) {
    out(`No favorite models on ${os.hostname()}. Star one: acpx models fav add <source>:<id>\n`);
    return;
  }
  for (const favorite of favorites) {
    out(`  ${favorite.key}\n`);
  }
}

async function handleFavWrite(
  action: "add" | "rm",
  ref: string,
  flags: ModelsFlags,
): Promise<void> {
  const store = getUiPrefsStore();
  const parsed = parseModelRef(ref);

  // Unstarring must work for a model the catalogue no longer carries — the row
  // is gone but the star is still in the box's store, and refusing to remove it
  // would strand it forever.
  if (action === "rm" && parsed.source) {
    store.removeFavorite(parsed.source, parsed.id);
    out(
      `  ☆ unstarred ${parsed.source}:${parsed.id} — ${store.listFavorites().length} favorites on ${os.hostname()}\n`,
    );
    return;
  }

  const catalogue = await readCatalogue(flags);
  const model = resolveOne(catalogue, ref);
  if (action === "add") {
    store.addFavorite(model.source, model.id);
    out(
      `  ★ starred ${model.key} — ${store.listFavorites().length} favorites on ${os.hostname()}\n`,
    );
  } else {
    store.removeFavorite(model.source, model.id);
    out(
      `  ☆ unstarred ${model.key} — ${store.listFavorites().length} favorites on ${os.hostname()}\n`,
    );
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

function addListFlags(command: Command): Command {
  return command
    .option("--search <query>", "Filter with the same matcher the picker uses (token-AND)")
    .option("--agent <type>", "Only what THIS agent type can run")
    .option("--all", "Include unavailable models, each with its reason (default: hidden)")
    .option("--json", "Emit the machine-readable catalogue payload on stdout")
    .option("--refresh", "Force a catalogue fetch instead of serving the cache");
}

export function registerModelsCommand(parent: Command, _config: ResolvedAcpxConfig): void {
  const modelsCommand = parent
    .command("models")
    .description(
      "Browse the model catalogue: every model acpx can run, its thinking-depth ladder, its price, and this box's favorites",
    );
  addListFlags(modelsCommand);

  addListFlags(modelsCommand.command("list"))
    .description(
      "List models, banded: favorites first, then each harness, then OpenRouter by vendor",
    )
    .action(async function (this: Command, flags: ModelsFlags) {
      await handleList(flags);
    });

  addListFlags(modelsCommand.command("show"))
    .description(
      "Show one model in full: its ladder and default, price, context, availability, favorite",
    )
    .argument("<ref>", "<source>:<id> or a bare <id>")
    .action(async function (this: Command, ref: string, flags: ModelsFlags) {
      await handleShow(ref, flags);
    });

  const favCommand = modelsCommand
    .command("fav")
    .description("List this box's favorite models (subcommands: add, rm)")
    .option("--json", "Emit the favorites as JSON")
    .action(async function (this: Command, flags: ModelsFlags) {
      await handleFavList(flags);
    });

  favCommand
    .command("add")
    .alias("star")
    .description("Star a model on this box (idempotent)")
    .argument("<ref>", "<source>:<id> or a bare <id>")
    .action(async function (this: Command, ref: string) {
      await handleFavWrite("add", ref, {});
    });

  favCommand
    .command("rm")
    .alias("unstar")
    .description("Unstar a model on this box (idempotent)")
    .argument("<ref>", "<source>:<id> or a bare <id>")
    .action(async function (this: Command, ref: string) {
      await handleFavWrite("rm", ref, {});
    });

  // Default action (no subcommand): behave like `models list`. A TYPO'd subverb
  // must NOT reach this silently — before `models` existed it would have been
  // parsed as a prompt to an agent named "models", and a create-a-delivery
  // failure mode is exactly what a typo must not have.
  modelsCommand.action(async function (this: Command, flags: ModelsFlags, command: Command) {
    const extra = command.args.filter((arg) => !arg.startsWith("-"));
    if (extra.length > 0) {
      failUsage(
        `[acpx] unknown "models" subcommand "${extra[0]}". Valid: ${KNOWN_SUBVERBS.join(", ")}.\n` +
          `  try: acpx models --search ${extra[0]}`,
      );
    }
    await handleList(flags);
  });
}
