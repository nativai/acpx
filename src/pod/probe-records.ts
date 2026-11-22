import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { acpAdapterKind } from "../acp/agent-command.js";
import { listSessionIndexEntries, resolveSessionRecord } from "../session/persistence.js";
import type { SessionIndexEntry } from "../session/persistence/index.js";
import type { SessionRecord } from "../types.js";
import { podMode, thisPodFile } from "./placement.js";

/**
 * A10 — what the create dialog asks (output styles, model lists) is answered from what owners
 * ALREADY record in their session records at connect, never from a bridge the control pod starts
 * (CONCEPTION r4 §K2 "Probes and one-shot runs", criterion 1; CONTRACTS-r4 C1.2 `one-shot`:
 * "from records where possible").
 *
 * The rule, one place: of the sessions that have run (an `acpSessionId`), of the SAME harness as the
 * agent asked about, take the newest — by `lastUsedAt` — whose record carries the advertisement
 * wanted. `match` says how close it is:
 *   exact    the record was started with the very agent command the box would launch now — its
 *            adapter version is the deployed one;
 *   harness  an older or different command of the same harness (an adapter that was deployed since,
 *            or a different registry entry): a good-faith answer, labelled so.
 * A record is NOT filtered by account for output styles and Claude's model list (those do not vary by
 * account); `profile` filters the model list of a harness whose catalogue does (Codex).
 *
 * ⚠️ This module is the HEAVY side (record reads); the placement step (light graph) only imports it
 * dynamically.
 */

export type RecordAdvertisement = {
  recordId: string;
  agentCommand: string;
  lastUsedAt: string;
  match: "exact" | "harness";
  configOptions: SessionConfigOption[];
  availableModels: string[];
  currentModelId: string | undefined;
};

/** What the answer needs: `config_options` (output styles, Claude's model select) or `available_models`. */
export type AdvertisementNeed = "config_options" | "available_models";

export type RecordAdvertisementQuery = {
  agentCommand: string;
  need: AdvertisementNeed;
  /** Only records started under this profile (Codex's model list differs by ChatGPT profile). */
  profile?: string;
};

/** How many of the newest candidates are opened before giving up: a bound on the reads, not a policy. */
export const RECORD_ADVERTISEMENT_MAX_READS = 25;

export type RecordAdvertisementDeps = {
  entries?: typeof listSessionIndexEntries;
  load?: (id: string) => Promise<SessionRecord>;
};

function satisfies(record: SessionRecord, need: AdvertisementNeed): boolean {
  const acpx = record.acpx;
  return need === "config_options"
    ? (acpx?.config_options?.length ?? 0) > 0
    : (acpx?.available_models?.length ?? 0) > 0;
}

function recordProfile(record: SessionRecord): string | undefined {
  const options = record.acpx?.session_options as { profile?: unknown } | undefined;
  return typeof options?.profile === "string" ? options.profile : undefined;
}

/** The candidates, newest first: sessions that have run, of the harness asked about. */
async function candidateEntries(
  harness: string,
  entries: RecordAdvertisementDeps["entries"],
): Promise<SessionIndexEntry[]> {
  const all = await (entries ?? listSessionIndexEntries)();
  return all
    .filter(
      (entry) =>
        entry.kind !== "subagent" &&
        entry.acpSessionId.length > 0 &&
        acpAdapterKind(entry.agentCommand) === harness,
    )
    .toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    .slice(0, RECORD_ADVERTISEMENT_MAX_READS);
}

function answers(record: SessionRecord, query: RecordAdvertisementQuery): boolean {
  return (
    satisfies(record, query.need) &&
    (query.profile === undefined || recordProfile(record) === query.profile)
  );
}

async function loadQuietly(
  load: (id: string) => Promise<SessionRecord>,
  id: string,
): Promise<SessionRecord | undefined> {
  try {
    return await load(id);
  } catch {
    return undefined;
  }
}

function advertisementOf(
  entry: SessionIndexEntry,
  record: SessionRecord,
  query: RecordAdvertisementQuery,
): RecordAdvertisement {
  return {
    recordId: entry.acpxRecordId,
    agentCommand: entry.agentCommand,
    lastUsedAt: entry.lastUsedAt,
    match: entry.agentCommand === query.agentCommand ? "exact" : "harness",
    configOptions: record.acpx?.config_options ?? [],
    availableModels: record.acpx?.available_models ?? [],
    currentModelId: record.acpx?.current_model_id,
  };
}

/** The newest record that can answer, or undefined — "records cannot answer" (the caller routes to the utility pod). */
export async function newestRecordAdvertisement(
  query: RecordAdvertisementQuery,
  deps: RecordAdvertisementDeps = {},
): Promise<RecordAdvertisement | undefined> {
  const harness = acpAdapterKind(query.agentCommand);
  if (harness === undefined) {
    return undefined;
  }
  for (const entry of await candidateEntries(harness, deps.entries)) {
    const record = await loadQuietly(deps.load ?? resolveSessionRecord, entry.acpxRecordId);
    if (record && answers(record, query)) {
      return advertisementOf(entry, record, query);
    }
  }
  return undefined;
}

/**
 * True on the control pod in pod mode — the one place where no bridge starts, so a probe is served
 * from records (or, by the placement step, by the utility pod). Everywhere else (pod mode off; an
 * agent pod, where a one-shot is the caller's own load) a probe runs as it always did.
 */
export function probesServedFromRecordsHere(): boolean {
  return podMode().mode === "pod" && thisPodFile().kind === "absent";
}

/**
 * The refusal a probe that REACHES a bridge-free control pod without an answer raises. Unreachable
 * through the placement step (it routes to the utility pod first); the typed error is the second line,
 * so a path nobody routed never spawns a bridge — `AcpClient.spawnAgentProcess` is the third
 * (`assertBridgeMayStartHere`).
 */
const RECORDS_CANNOT_ANSWER_LINE =
  "acpx: REFUSED reason=probe_needs_utility_pod nothing_started=true protocol=1";

export class RecordsCannotAnswerError extends Error {
  readonly stderrLine = RECORDS_CANNOT_ANSWER_LINE;
  constructor(what: string) {
    super(
      `${RECORDS_CANNOT_ANSWER_LINE}\nNo session record carries ${what}; in pod mode the control pod starts no bridge for a probe.`,
    );
  }
}
