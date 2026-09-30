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

import { Command, InvalidArgumentError } from "commander";
import { resolveAcpxUiBaseUrl } from "../acp/auth-env.js";
import { resolveOpenRouterBoxCredential } from "../acp/openrouter-routing.js";
import {
  decorateFavorites,
  findModelByKey,
  findModelsById,
  loadCatalogue,
} from "../models/catalogue.js";
import { describeDepth } from "../models/depth.js";
import { bandModels, isAvailableForAgent, searchModels } from "../models/matcher.js";
import { nearestModels, parseModelRef, searchToken } from "../models/model-slug-validation.js";
import {
  loadOpenRouterEndpoints,
  type OpenRouterEndpoint,
  type OpenRouterEndpointsResult,
} from "../models/openrouter-endpoints.js";
import type { CatalogueModel, ModelCatalogue } from "../models/types.js";
import { getUiPrefsStore } from "../models/ui-prefs-store.js";
import type { ResolvedAcpxConfig } from "./config.js";

type ModelsFlags = {
  search?: string;
  agent?: string;
  all?: boolean;
  json?: boolean;
  format?: string;
  refresh?: boolean;
};

/**
 * `--json` is shorthand for `--format json` — the same flag surface the sibling
 * `acpx agents` verb uses, so a user who learns one has learned the other.
 */
function wantsJson(flags: ModelsFlags): boolean {
  return flags.json === true || flags.format === "json";
}

/** Only the two formats this verb actually renders; `quiet` would have no meaning here. */
function parseModelsFormat(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "json" && normalized !== "text") {
    throw new InvalidArgumentError(`Invalid format "${value}". Expected one of: text, json`);
  }
  return normalized;
}

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

/**
 * Which box this store belongs to, for the user-facing lines.
 *
 * ⚠️ resolveAcpxUiBaseUrl, NEVER os.hostname() — the repo already ruled on this
 * and the rule is carried at `src/session/persistence/deletion-manifest.ts:260`:
 * on a dev box the hostname is the EPHEMERAL POD NAME and changes on every
 * restart, and *"acpx calls os.hostname() nowhere in src/, which is itself the
 * tell"*. I had seven calls to it here and every one of them printed
 * `dev-server-85fcff8f94-wwl67`, which after a pod restart reads to a user as
 * "my favorites moved" — from an event that changed nothing, on a store that is
 * genuinely per-box. This resolver is the single point that decides the host
 * agents see, survives the ssh-with-empty-env case, and covers the boxes served
 * on a third TLD, which no hostname rule can. It is also self-describing
 * off-box, so a line pasted elsewhere still names the box it came from.
 */
function boxLabel(): string {
  // Where this box's acpx-ui URL is unknown the label degrades to a deictic rather
  // than a hostname. "this box" is imprecise but TRUE — and the alternative that
  // looks better, a constructed `acpx.<something>` host, is the fabrication the
  // resolver exists to refuse. Every use of this is human-facing prose
  // ("… on <box>"), so nothing downstream parses it as an address.
  return resolveAcpxUiBaseUrl(process.env) ?? "this box";
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

/**
 * The rendered `acpx models list` text, for tests only (brick ecfb0461).
 *
 * ⚠️ **A SEAM, NOT API** — hence the name, matching `setHarnessCapabilitiesForTesting`.
 * It exists because the entitlement-state footer has to be asserted on the BYTES this
 * verb prints: checking only `catalogue.entitlement.source` would stay green on a
 * renderer that stopped printing it, which is precisely the regression the row guards.
 */
export function renderModelsListForTesting(catalogue: ModelCatalogue, flags: ModelsFlags): string {
  return renderList(catalogue, flags);
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
  const box = boxLabel();
  const agentNote = agentType
    ? ` · ${catalogue.models.filter((model) => isAvailableForAgent(model, agentType)).length} available to ${agentType}`
    : "";
  const hidden = flags.all === true ? "" : " (acpx models --all to see them and why)";
  return (
    `${catalogue.counts.selectable} selectable on ${box} · ${catalogue.counts.unavailable} unavailable${hidden}` +
    `${agentNote}${describeFreshness(catalogue)}\n`
  );
}

/**
 * ⚠️ A DEGRADED CATALOGUE IS `error != null`, NEVER `stale` ALONE. C5 §4.9 has
 * two failure rows — fetch failed WITH a cache and fetch failed WITHOUT one —
 * and `stale` cannot tell them apart, because it means only "served from cache
 * after a failed refresh". Keying the warning on `stale` would print a healthy
 * footer over a catalogue that never loaded.
 */
function describeFreshness(catalogue: ModelCatalogue): string {
  const entitlement = describeEntitlementState(catalogue);
  if (catalogue.fetchedAt === null) {
    return ` · ⚠ OpenRouter catalogue NOT LOADED${catalogue.error === null ? "" : ` (${catalogue.error})`} — harness models only${entitlement}`;
  }
  if (catalogue.stale) {
    const why = catalogue.error === null ? "" : `; last refresh failed: ${catalogue.error}`;
    return ` · catalogue STALE (fetched ${catalogue.fetchedAt}${why})${entitlement}`;
  }
  return ` · catalogue fetched ${catalogue.fetchedAt}${entitlement}`;
}

/**
 * The READ-PATH half of *"permits everything and says so"* (brick ecfb0461).
 *
 * 🛑 **WITHOUT THIS, THE LISTING OVERSTATES WHAT AN AGENT MAY USE — SILENTLY, AND
 * ONLY IN A FAILURE STATE.** Fail-open leaves every OpenRouter row available when
 * acpx cannot read the key's set, which is byte-identical to a key that genuinely
 * allows everything. So `acpx models list` answered *"what are the available
 * models?"* with ~310 rows and no hedge on a cold / corrupt / 401'd read. The spawn
 * path said so on stderr all along; this verb — the one an agent actually queries —
 * did not.
 *
 * ⚠️ **SILENT ON THE HEALTHY PATH, DELIBERATELY.** A footer that always carried a
 * caveat would be ignored within a day, and then the failure state would be
 * invisible again for a new reason. `test/openrouter-entitlement.test.ts` asserts
 * both directions, so a build that always warns cannot pass.
 */
function describeEntitlementState(catalogue: ModelCatalogue): string {
  if (catalogue.entitlement.source === "unknown") {
    return ` · ⚠ KEY'S ALLOWED SET UNKNOWN — this list is NOT narrowed to it${
      catalogue.entitlement.note === null ? "" : ` (${catalogue.entitlement.note})`
    }`;
  }
  return catalogue.entitlement.stale
    ? ` · ⚠ allowed set STALE${catalogue.entitlement.note === null ? "" : ` (${catalogue.entitlement.note})`}`
    : "";
}

/**
 * ⚠️ SEARCH SHOWS UNAVAILABLE MATCHES, ALWAYS — `--all` governs the UNSEARCHED
 * list, not this.
 *
 * The two specs each rule on their own surface and they do not conflict once
 * scoped: C5 §6 says the CLI hides unavailable rows by default (that is the
 * banded list), and C5 D4 says *"unavailable rows still appear in search
 * results, ranked last — silently dropping a model the user typed the exact
 * name of teaches them the picker is broken."* Someone who types a slug has
 * named a specific model; answering "no match" when it exists and cannot be
 * used is the one outcome that teaches the wrong lesson. The reason is printed
 * under the row, so the constraint is taught where it bites.
 */
function renderSearch(catalogue: ModelCatalogue, flags: ModelsFlags): string {
  const agentType = flags.agent?.trim() || undefined;
  const favorites = new Set(catalogue.models.filter((model) => model.favorite).map((m) => m.key));
  const matches = searchModels(catalogue.models, flags.search ?? "", favorites);

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
    // `null` is upstream silence, and saying "off" for it would be a claim
    // OpenRouter never made on 109 of the 146 boolean rows.
    const dflt =
      depth.defaultEnabled === null ? "not stated upstream" : depth.defaultEnabled ? "on" : "off";
    return `  depths      no ladder — reasoning is on/off only\n  depth dflt  ${dflt}\n`;
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
  if (wantsJson(flags)) {
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
  if (wantsJson(flags)) {
    out(`${JSON.stringify(model)}\n`);
    return;
  }
  out(renderShow(model));
}

/**
 * `acpx models endpoints <slug>` — WHICH PROVIDERS SERVE THIS MODEL, and how
 * well (brick 4c272cab §7.1 / acceptance A4).
 *
 * The agent-facing half of provider routing: an orchestrator told *"this model
 * is slow on this box"* can run this, read `providerSlug`, `quantization`,
 * `throughput_last_30m.p50` and `uptime_last_1d` off one row, and name a better
 * provider — instead of guessing, or abandoning the model as the founding
 * incident did.
 *
 * ⚠️ **A BOX WITH NO CREDENTIAL STILL GETS THE ROWS** (HoD ruling O-1). This
 * endpoint is PUBLIC — measured by the test engineer: no `Authorization` header
 * at all returns `200` and 26 rows. An earlier cut refused here with `rc 2`
 * because CONCEPTION §7.1 said the key was required; it is not, and degrading a
 * freely-reachable answer because this box holds no credential helps nobody. The
 * key is sent when present and its absence is reported as a NOTE.
 *
 * ⚠️ **A real failure is still `null`, never `[]`** — a model can genuinely have
 * no endpoints, and a silent empty would tell an agent "this model has no
 * providers" when the truth is "the read failed".
 */
async function handleEndpoints(slug: string, flags: ModelsFlags): Promise<void> {
  const credential = resolveOpenRouterBoxCredential();
  const result = await loadOpenRouterEndpoints(slug, credential?.key, {
    refresh: flags.refresh === true,
  });
  const note = credentialNote(credential !== undefined);
  if (wantsJson(flags)) {
    out(`${JSON.stringify(endpointsEnvelope(slug, result, credential !== undefined, note))}\n`);
    return;
  }
  if (!result.snapshot) {
    failUsage(`[acpx] could not read endpoints for ${slug}: ${result.error ?? "unknown error"}`);
  }
  if (note) {
    // stderr, so `--format text` stdout stays a clean table and a piped reader
    // is not handed a note it did not ask for.
    diag(`[acpx] note: ${note}\n`);
  }
  out(renderEndpoints(slug, result));
}

/** The `--json` envelope: staleness, provenance and the rows, in one shape. */
function endpointsEnvelope(
  slug: string,
  result: OpenRouterEndpointsResult,
  hasCredential: boolean,
  note: string | null,
): Record<string, unknown> {
  return {
    slug,
    fetchedAt: result.snapshot?.fetchedAt ?? null,
    stale: result.stale,
    error: result.error,
    credential: hasCredential ? "box" : "missing",
    note,
    // `null`, never `[]`, on every failure — see the module header.
    endpoints: result.snapshot ? result.snapshot.endpoints : null,
  };
}

/**
 * A machine-readable NOTE, not an error: the rows are complete either way.
 *
 * It still says something worth saying — a box with no OpenRouter credential can
 * read these metrics but cannot route or spend on anything, so an agent reading
 * this verb to plan a change learns that here rather than at the first spawn.
 */
function credentialNote(present: boolean): string | null {
  return present
    ? null
    : `OPENROUTER_BOX_CREDENTIAL_MISSING — no OpenRouter credential on ${boxLabel()}. ` +
        `The endpoint is public, so every provider row is here, and so are uptime and pricing — ` +
        `but THROUGHPUT IS KEY-GATED: throughput_last_30m is null on all 26 rows unauthenticated ` +
        `and populated on all 26 with the key (measured 2026-09-10). Nothing on this box will route either.`;
}

function renderEndpoints(slug: string, result: OpenRouterEndpointsResult): string {
  const snapshot = result.snapshot;
  if (!snapshot) {
    return "";
  }
  const rows = snapshot.endpoints.toSorted((a, b) => throughputP50(b) - throughputP50(a));
  const header =
    `  ${slug} — ${rows.length} endpoints ${describeEndpointsFreshness(result)}\n` +
    `  ${pad("provider", 18)} ${pad("quant", 8)} ${pad("p50 tok/s", 10)} ${pad("uptime 1d", 10)} ${pad("ctx", 8)} $/M in\n`;
  return header + rows.map((row) => endpointRow(row)).join("");
}

/** Staleness is SURFACED, never hidden: a 5-minute TTL still has a stale leg. */
function describeEndpointsFreshness(result: OpenRouterEndpointsResult): string {
  const fetchedAt = result.snapshot?.fetchedAt ?? "never";
  if (!result.stale) {
    return `(fetched ${fetchedAt})`;
  }
  return `(STALE, fetched ${fetchedAt}${result.error ? `; ${result.error}` : ""})`;
}

function endpointRow(row: OpenRouterEndpoint): string {
  return (
    `  ${pad(truncate(row.providerSlug, 18), 18)} ${pad(row.quantization ?? "?", 8)} ` +
    `${pad(formatMetric(throughputP50(row)), 10)} ${pad(formatMetric(row.uptime_last_1d ?? null), 10)} ` +
    `${pad(formatContext(row.context_length ?? null), 8)} ${formatPricePerMillion(row.pricing?.prompt)}\n`
  );
}

/** `-1` sorts a metric-less row (measured: Morph reports null) to the bottom. */
function throughputP50(endpoint: OpenRouterEndpoint): number {
  const value = endpoint.throughput_last_30m?.p50;
  return typeof value === "number" ? value : -1;
}

function formatMetric(value: number | null): string {
  return value === null || value < 0 ? "—" : String(Math.round(value * 10) / 10);
}

function formatPricePerMillion(rate: string | undefined): string {
  const value = rate === undefined ? Number.NaN : Number.parseFloat(rate);
  return Number.isFinite(value) ? `$${Number((value * 1_000_000).toFixed(4))}` : "?";
}

async function handleFavList(flags: ModelsFlags): Promise<void> {
  const favorites = getUiPrefsStore().listFavorites();
  if (wantsJson(flags)) {
    out(`${JSON.stringify({ favorites })}\n`);
    return;
  }
  if (favorites.length === 0) {
    out(`No favorite models on ${boxLabel()}. Star one: acpx models fav add <source>:<id>\n`);
    return;
  }
  for (const favorite of favorites) {
    out(`  ${favorite.key}\n`);
  }
}

/**
 * `acpx models last-used` — the per-box sticky preselect (C5 §8.3 / §D9),
 * spelled to mirror `fav`: the bare verb READS, the sub-verb WRITES.
 *
 * ⚠️ THE READ NEVER ERRORS. Nothing set is an empty map and exit 0 — a missing
 * preselect must degrade the preselect, not take down the caller that also
 * wanted the favorites list.
 */
function handleLastUsedList(flags: ModelsFlags): void {
  let entries: { agentType: string; modelKey: string; updatedAt: string }[] = [];
  try {
    entries = getUiPrefsStore().listLastUsedModels();
  } catch (error) {
    diag(`[acpx] warning: could not read the preferences store: ${asMessage(error)}\n`);
  }

  if (wantsJson(flags)) {
    const map: Record<string, string> = {};
    for (const entry of entries) {
      map[entry.agentType] = entry.modelKey;
    }
    out(`${JSON.stringify({ lastUsedModelKey: map, entries })}\n`);
    return;
  }
  if (entries.length === 0) {
    out(`No last-used model recorded on ${boxLabel()}.\n`);
    return;
  }
  for (const entry of entries) {
    out(`  ${pad(entry.agentType, 14)} ${entry.modelKey}   (${entry.updatedAt})\n`);
  }
}

function handleLastUsedSet(agentType: string, key: string): void {
  const agent = agentType.trim();
  if (agent === "") {
    failUsage(
      "[acpx] an agent type is required: acpx models last-used set <agent-type> <source>:<id>",
    );
  }
  // The key is (source, id) — the same unit of choice a favorite uses, and the
  // reason a bare id is refused here as it is everywhere else.
  const parsed = parseModelRef(key);
  if (parsed.source === null || parsed.id.trim() === "") {
    failUsage(
      `[acpx] "${key}" is not a model key. The shape is <source>:<id>, where the id may contain "/" —\n` +
        `  e.g. openrouter:moonshotai/kimi-k3, claude-subscription:opus, chatgpt:gpt-5.6-sol.`,
    );
  }
  getUiPrefsStore().setLastUsedModel(agent, `${parsed.source}:${parsed.id}`);
  out(`  last-used for ${agent} is now ${parsed.source}:${parsed.id} on ${boxLabel()}\n`);
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
      `  ☆ unstarred ${parsed.source}:${parsed.id} — ${store.listFavorites().length} favorites on ${boxLabel()}\n`,
    );
    return;
  }

  const catalogue = await readCatalogue(flags);
  const model = resolveOne(catalogue, ref);
  if (action === "add") {
    store.addFavorite(model.source, model.id);
    out(`  ★ starred ${model.key} — ${store.listFavorites().length} favorites on ${boxLabel()}\n`);
  } else {
    store.removeFavorite(model.source, model.id);
    out(
      `  ☆ unstarred ${model.key} — ${store.listFavorites().length} favorites on ${boxLabel()}\n`,
    );
  }
}

// ── Registration ─────────────────────────────────────────────────────────────

function addListFlags(command: Command): Command {
  return command
    .option("--search <query>", "Filter with the same matcher the picker uses (token-AND)")
    .option("--agent <type>", "Only what THIS agent type can run")
    .option("--all", "Include unavailable models, each with its reason (default: hidden)")
    .option("--json", "Shorthand for --format json")
    .option("--format <fmt>", "Output format: text, json", parseModelsFormat)
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

  // ⚠️ A SUBCOMMAND OF `models`, WHICH IS ALREADY IN `TOP_LEVEL_VERBS` — so the
  // two-registration trap does NOT apply here and adding a second entry would be
  // wrong. The trap is about a new FIRST token: an unregistered one is absorbed
  // by the agent catch-all and becomes a prompt. `models endpoints …` is parsed
  // by commander under an already-registered verb, and a typo'd subverb fails
  // loudly with "too many arguments for 'models'".
  modelsCommand
    .command("endpoints")
    .description(
      "Which providers serve an OpenRouter model, with quantization, price, p50 throughput and uptime",
    )
    .argument("<slug>", "OpenRouter model slug, e.g. z-ai/glm-5.3-flash")
    .option("--json", "Shorthand for --format json")
    .option("--format <fmt>", "Output format: text, json", parseModelsFormat)
    .option("--refresh", "Force a fetch instead of serving the 5-minute cache")
    .action(async function (this: Command, slug: string, flags: ModelsFlags) {
      await handleEndpoints(slug, flags);
    });

  const favCommand = modelsCommand
    .command("fav")
    .description("List this box's favorite models (subcommands: add, rm)")
    .option("--json", "Shorthand for --format json")
    .option("--format <fmt>", "Output format: text, json", parseModelsFormat)
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

  const lastUsedCommand = modelsCommand
    .command("last-used")
    .description(
      "Show this box's last-used model per agent type (the sticky preselect); subcommand: set",
    )
    .option("--json", "Shorthand for --format json")
    .option("--format <fmt>", "Output format: text, json", parseModelsFormat)
    .action(function (this: Command, flags: ModelsFlags) {
      handleLastUsedList(flags);
    });

  lastUsedCommand
    .command("set")
    .description("Record the last-used model for an agent type (idempotent)")
    .argument("<agent-type>", "Agent type, e.g. claude / codex")
    .argument("<key>", "<source>:<id>")
    .action(function (this: Command, agentType: string, key: string) {
      handleLastUsedSet(agentType, key);
    });

  // Default action (no subcommand): behave like `models list`.
  //
  // A TYPO'd subverb must NEVER reach this silently — before `models` existed,
  // `acpx models bogusverb` was parsed as a PROMPT to an agent named "models",
  // and a typo that turns into a delivery is the failure mode this command
  // exists to close. MEASURED on this build: commander refuses the excess
  // argument itself — `acpx models bogusverb` exits 1 with
  // "error: too many arguments for 'models'" and prints the valid Commands list
  // (list / show / fav). That is the loud failure, so there is deliberately no
  // hand-rolled check here duplicating it; the test pins the behaviour, not this
  // comment.
  modelsCommand.action(async function (this: Command, flags: ModelsFlags) {
    await handleList(flags);
  });
}
