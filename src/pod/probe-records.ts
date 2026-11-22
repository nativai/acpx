import os from "node:os";
import path from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { acpAdapterKind } from "../acp/agent-command.js";
import { findProfile, loadProfileRegistry } from "../config/profiles.js";
import { defaultAccountBindingForAgent } from "../runtime/engine/default-account-binding.js";
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
 * agent asked about, prefer a record started with the very agent command this box launches (`exact`),
 * then any other command of the harness (`harness`), each newest first by `lastUsedAt`; the first
 * whose record carries the advertisement wanted answers. `match`:
 *   exact    the record's agent command is the SAME COMMAND STRING as this box's deployed one. Real
 *            commands are the stable link `node /opt/<adapter>/dist/index.js`, which a deploy does not
 *            change: `exact` is NOT "the same adapter version" — a record written before a deploy is
 *            still `exact`. Records hold no version.
 *   harness  another command of the same harness (a dev or rig worktree adapter): a good-faith answer.
 * Output styles and Claude's model list are served whatever account the record ran under — which is an
 * approximation (output styles DO vary by account directory: `<account>/output-styles/*.md`); `profile`
 * filters the model list of a harness whose catalogue differs by account (Codex), where a record with
 * no profile counts as the default profile (see `profileMatches`).
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
  noProfileMatches?: NoProfileMatches;
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

/**
 * Order of preference: a record of the very adapter command this box launches (`exact`) before any
 * other command of the harness (`harness` — a dev or rig worktree), each newest first. A newer rig
 * record must never hide what the deployed adapter's own sessions advertise (TE F-G).
 */
function newestExactFirst(agentCommand: string) {
  return (a: SessionIndexEntry, b: SessionIndexEntry): number =>
    Number(b.agentCommand === agentCommand) - Number(a.agentCommand === agentCommand) ||
    b.lastUsedAt.localeCompare(a.lastUsedAt);
}

/** The candidates: sessions that have run, of the harness asked about, in the order above. */
async function candidateEntries(
  harness: string,
  agentCommand: string,
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
    .toSorted(newestExactFirst(agentCommand))
    .slice(0, RECORD_ADVERTISEMENT_MAX_READS);
}

/**
 * `--profile P` matches a record started under P — and a record that names NO profile, when P is
 * what "no profile" means on this box: the profile no selection binds to for this agent
 * (`defaultAccountBindingForAgent`, the creation seam), or a profile whose Codex home is the native
 * `~/.codex` a raw login uses. 233 of 236 real Codex records carry no profile (a default-profile
 * session writes none), while atrium always asks for the active one (TE F-A).
 */
function profileMatches(
  record: SessionRecord,
  query: RecordAdvertisementQuery,
  noProfileMatches: NoProfileMatches,
): boolean {
  if (query.profile === undefined) {
    return true;
  }
  const own = recordProfile(record);
  return own === undefined
    ? noProfileMatches(query.profile, query.agentCommand)
    : own === query.profile;
}

/** Whether a record with no profile ran as the asked profile. Injected in tests; the box's registry otherwise. */
export type NoProfileMatches = (profile: string, agentCommand: string) => boolean;

export const noProfileMatchesOnThisBox: NoProfileMatches = (profile, agentCommand) => {
  try {
    if (defaultAccountBindingForAgent(agentCommand)?.profile === profile) {
      return true;
    }
    const entry = findProfile(profile, loadProfileRegistry());
    return (
      entry?.authMode === "chatgpt" &&
      path.resolve(entry.codexHome) ===
        path.resolve(process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex"))
    );
  } catch {
    return false;
  }
};

function answers(
  record: SessionRecord,
  query: RecordAdvertisementQuery,
  noProfileMatches: NoProfileMatches,
): boolean {
  return satisfies(record, query.need) && profileMatches(record, query, noProfileMatches);
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
  for (const entry of await candidateEntries(harness, query.agentCommand, deps.entries)) {
    const record = await loadQuietly(deps.load ?? resolveSessionRecord, entry.acpxRecordId);
    if (record && answers(record, query, deps.noProfileMatches ?? noProfileMatchesOnThisBox)) {
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
