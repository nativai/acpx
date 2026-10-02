/**
 * THE ONE derivation of a Claude model's display label (brick ebfe4c3c, CONTRACT §1).
 *
 * The Claude Code binary bundled in claude-agent-acp advertises, per session, a
 * `model` select whose options carry `{value, name, description}` — and the
 * description's first `" · "` segment is the binary's own short name for what
 * that alias currently resolves to ("Opus 5.5 · Best for everyday, complex
 * tasks"). That string is the single source of truth for "which model and
 * version"; nothing in acpx or acpx-ui holds a version table any more.
 *
 * Two callers, and only two — nothing else derives a label in either repo:
 *   (a) the session-index projection (`toSessionIndexEntry`), for running and
 *       closed sessions, from the record's own stored advertisement;
 *   (b) the catalogue row builder (`harnessNativeModels(advert)`), for every
 *       pre-session surface and for `acpx models`, from the cached probe.
 *
 * PURE: no I/O. An SDK bump that renames a version needs ZERO edits here.
 *
 * ⚠️ THE SHAPE GATE IS THE POINT, NOT A NICETY. Segment 1 is PROSE on four real
 * advertised shapes ("Newer version available", "Best for everyday, complex
 * tasks (claude-opus-4-8)", "Custom model", "Sonnet 5 for long sessions"). An
 * "always take the first segment" rule would print those as model names. If the
 * binary rewords a template, the result degrades to `undefined` — the caller's
 * version-free alias display — and is never wrong.
 */

import { isClaudeAcpAgentCommand } from "../acp/agent-command.js";
import type { SessionRecord } from "../types.js";

export type AdvertisedModelOption = { value: string; name?: string; description?: string | null };

const SEGMENT_SEPARATOR = " · ";

/**
 * The binary's fixed sentence for `default` when it advertises in API form (no
 * subscription credential): "Use the default model (currently Opus 5.5) · $4/$20
 * per Mtok". Measured on the deployed adapter with no credential (CONTRACT §4.1
 * iii) and on 11 live records.
 */
const DEFAULT_ROW_TEMPLATE = /^Use the default model \(currently (.+)\)$/;

const WITH_CONTEXT_SUFFIX = /\s+with\s+(\d+(?:\.\d+)?[KkMm])\s+context$/;
const PAREN_CONTEXT_SUFFIX = /\s*\((\d+(?:\.\d+)?[KkMm])\s+context\)$/;

/**
 * Capitalised words and version tokens, plus an optional "(1M)". Any lowercase
 * word ("for", "version", "model") disqualifies — that is what rejects prose.
 */
const LABEL_SHAPE = /^[A-Z][A-Za-z0-9.-]*(?: [A-Z0-9][A-Za-z0-9.-]*)*(?: \(\d+(?:\.\d+)?[KM]\))?$/;

function normaliseContextSuffix(text: string): string {
  return text
    .replace(WITH_CONTEXT_SUFFIX, (_match, size: string) => ` (${size.toUpperCase()})`)
    .replace(PAREN_CONTEXT_SUFFIX, (_match, size: string) => ` (${size.toUpperCase()})`);
}

/** Rules 3–4: normalise the context suffix, then accept only the label shape. */
function shapedLabel(text: string): string | undefined {
  const candidate = normaliseContextSuffix(text.trim());
  return LABEL_SHAPE.test(candidate) ? candidate : undefined;
}

function descriptionSegments(option: AdvertisedModelOption): string[] {
  return typeof option.description === "string" ? option.description.split(SEGMENT_SEPARATOR) : [];
}

/** Rules 1–4 applied to the description alone; `undefined` when it does not carry a label. */
function labelFromDescription(option: AdvertisedModelOption): string | undefined {
  const first = descriptionSegments(option)[0]?.trim();
  if (!first) {
    return undefined;
  }
  const templated = DEFAULT_ROW_TEMPLATE.exec(first);
  return shapedLabel(templated?.[1] ?? first);
}

/** The ONE derivation (CONTRACT §1.2). Pure. `undefined` ⇒ no clean label can be read off this option. */
export function labelFromAdvertisedOption(option: AdvertisedModelOption): string | undefined {
  const fromDescription = labelFromDescription(option);
  if (fromDescription !== undefined) {
    return fromDescription;
  }
  return typeof option.name === "string" ? shapedLabel(option.name) : undefined;
}

/**
 * The tagline: the 2nd `" · "` segment — only when the label came from the
 * DESCRIPTION (so a name-fallback row's "select Opus for Opus 5" is never a
 * tagline) and the segment is not a price ("$4/$20 per Mtok").
 */
export function taglineFromAdvertisedOption(option: AdvertisedModelOption): string | undefined {
  if (labelFromDescription(option) === undefined) {
    return undefined;
  }
  const second = descriptionSegments(option)[1]?.trim();
  return second && !second.startsWith("$") ? second : undefined;
}

function asAdvertisedOption(entry: unknown): AdvertisedModelOption | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { value, name, description } = entry as Record<string, unknown>;
  if (typeof value !== "string") {
    return undefined;
  }
  return {
    value,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof description === "string" || description === null ? { description } : {}),
  };
}

/** A select option, or every option of a select GROUP, flattened. */
function flattenSelectEntry(entry: unknown): AdvertisedModelOption[] {
  const grouped = (entry as { options?: unknown } | null)?.options;
  if (Array.isArray(grouped)) {
    return grouped.flatMap((inner) => {
      const option = asAdvertisedOption(inner);
      return option ? [option] : [];
    });
  }
  const option = asAdvertisedOption(entry);
  return option ? [option] : [];
}

function findModelConfigOption(
  configOptions: readonly unknown[] | undefined,
): Record<string, unknown> | undefined {
  if (!Array.isArray(configOptions)) {
    return undefined;
  }
  return configOptions.find(
    (option): option is Record<string, unknown> =>
      typeof option === "object" && option !== null && (option as { id?: unknown }).id === "model",
  );
}

/** Well-formed select options out of untrusted entries (a stored cache, a fixture); groups flattened. */
export function parseAdvertisedOptions(entries: readonly unknown[]): AdvertisedModelOption[] {
  return entries.flatMap(flattenSelectEntry);
}

/** Flat options of the `model` select in a config_options array (id === "model"; grouped options flattened). */
export function advertisedModelOptions(
  configOptions: readonly unknown[] | undefined,
): AdvertisedModelOption[] | undefined {
  const modelOption = findModelConfigOption(configOptions);
  if (!modelOption || !Array.isArray(modelOption.options)) {
    return undefined;
  }
  return parseAdvertisedOptions(modelOption.options as unknown[]);
}

/** The option whose `value` matches `alias` (trimmed, case-insensitive), or undefined. */
export function findAdvertisedOption(
  options: readonly AdvertisedModelOption[],
  alias: string,
): AdvertisedModelOption | undefined {
  const needle = alias.trim().toLowerCase();
  if (needle === "") {
    return undefined;
  }
  return options.find((option) => option.value.trim().toLowerCase() === needle);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Which alias a running session's label is computed for (CONTRACT §1.4):
 * `current_model_id`, else the durable pin, else the advertisement's
 * `currentValue`.
 *
 * ⚠️ DO NOT PROMOTE `currentValue` ABOVE THE PIN. It is a stale creation snapshot:
 * on devbox 1,266 of 1,671 claude records carry a `currentValue` that disagrees
 * with the pin (922 of them `"default"` against an `opus` pin), so reading it
 * first would label most sessions with the wrong model.
 */
function effectiveAlias(record: SessionRecord): string | undefined {
  const acpx = record.acpx;
  return (
    nonEmpty(acpx?.current_model_id) ??
    nonEmpty(acpx?.session_options?.model) ??
    nonEmpty(findModelConfigOption(acpx?.config_options)?.currentValue)
  );
}

/**
 * The claude gate, made TOTAL for the projection.
 *
 * ⚠️ `isClaudeAcpAgentCommand` THROWS on an empty command ("Invalid --agent
 * command: empty command"), and subagent shadow records are written with
 * `agentCommand: ""` (`runtime.ts`, teammate_spawned). Called bare from
 * `toSessionIndexEntry`, that throw failed the shadow record's write — inside a
 * best-effort block, so silently — and the parent never listed its subagent
 * (caught by `seat-creation-paths.test.ts` G2/path 3). A projection must never
 * throw over one record.
 */
function isClaudeRecordCommand(agentCommand: unknown): boolean {
  if (typeof agentCommand !== "string" || agentCommand.trim() === "") {
    return false;
  }
  try {
    return isClaudeAcpAgentCommand(agentCommand);
  } catch {
    return false;
  }
}

/**
 * Index projection helper: claude-only gate + effective alias + the derivation.
 *
 * DERIVED AT PROJECTION, NOT PERSISTED (the `canSetModelLive` precedent): every
 * input already survives `cloneSessionAcpxState` and the parse leg, so this needs
 * no new record field — and therefore cannot be destroyed by the turn path's
 * allowlist rebuild the way four persisted fields have been.
 *
 * The SEGMENT-matched claude gate keeps codex, pi and every other harness
 * byte-identical: they never carry this field.
 */
export function resolvedModelLabelForRecord(record: SessionRecord): string | undefined {
  if (!isClaudeRecordCommand(record.agentCommand)) {
    return undefined;
  }
  const options = advertisedModelOptions(record.acpx?.config_options);
  const option = aliasOption(record, options);
  const label = option ? labelFromAdvertisedOption(option) : undefined;
  if (!options || !option || label === undefined) {
    return undefined;
  }
  return versionedByServedModel(label, option, options, servedModelOf(record)) ?? label;
}

function aliasOption(
  record: SessionRecord,
  options: AdvertisedModelOption[] | undefined,
): AdvertisedModelOption | undefined {
  const alias = effectiveAlias(record);
  return alias === undefined || options === undefined
    ? undefined
    : findAdvertisedOption(options, alias);
}

/**
 * Claude Code stamps `<synthetic>` on assistant entries it generates LOCALLY; it
 * is never a served model. Shared by the served-model reader (`model-floor.ts`)
 * and the index projection, which must not relay one an older acpx recorded.
 */
export const SYNTHETIC_ASSISTANT_MODEL = "<synthetic>";

/** `acpx.served.model`, trimmed — absent when missing or `<synthetic>`. */
export function servedModelOf(record: SessionRecord): string | undefined {
  const served = nonEmpty(record.acpx?.served?.model);
  return served === SYNTHETIC_ASSISTANT_MODEL ? undefined : served;
}

const CONTEXT_SUFFIX = / \(\d+(?:\.\d+)?[KM]\)$/;

function familyOf(label: string): string {
  return label.split(" ")[0]?.toLowerCase() ?? "";
}

/**
 * A VERSION-LESS alias label, versioned by what the session actually SERVED
 * (brick ebfe4c3c follow-up P-2, HoD rule 2026-10-02).
 *
 * The binary can advertise an alias without a version ("fable" → "Fable (1M
 * context)") beside a concrete id that names it ("claude-fable-5-1" → "Fable 5.1
 * · …"). Measured on Daniel's session 67f2803e: pin `fable`, served
 * `claude-fable-5-1`, header "Fable (1M)" — the binary DID name the version, on
 * another row. So, only when ALL hold:
 *   · the alias label carries no digit;
 *   · the served model equals the `value` of ANOTHER advertised option;
 *   · that option's label passes the shape gate and is the SAME family;
 * the label becomes that option's, keeping the alias's context suffix when the
 * other lacks one ("Fable 5.1 (1M)").
 *
 * ⚠️ NEVER from `currentValue` alone (a stale creation snapshot — it reads
 * `claude-fable-5-1` on that very record, but it says nothing about what served),
 * never across families, never from a served id no option carries.
 */
function versionedByServedModel(
  aliasLabel: string,
  aliasOpt: AdvertisedModelOption,
  options: readonly AdvertisedModelOption[],
  served: string | undefined,
): string | undefined {
  const servedLabel = sameFamilyServedLabel(aliasLabel, aliasOpt, options, served);
  if (servedLabel === undefined) {
    return undefined;
  }
  const suffix = CONTEXT_SUFFIX.exec(aliasLabel)?.[0];
  return suffix && !CONTEXT_SUFFIX.test(servedLabel) ? `${servedLabel}${suffix}` : servedLabel;
}

/** The served option's clean label — only for a version-less alias, another option, same family. */
function sameFamilyServedLabel(
  aliasLabel: string,
  aliasOpt: AdvertisedModelOption,
  options: readonly AdvertisedModelOption[],
  served: string | undefined,
): string | undefined {
  if (/[0-9]/.test(aliasLabel) || served === undefined) {
    return undefined;
  }
  const servedOption = findAdvertisedOption(options, served);
  if (!servedOption || servedOption.value === aliasOpt.value) {
    return undefined;
  }
  const servedLabel = labelFromAdvertisedOption(servedOption);
  return servedLabel !== undefined && familyOf(servedLabel) === familyOf(aliasLabel)
    ? servedLabel
    : undefined;
}
