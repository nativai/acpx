import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  harnessIdForAgentCommand,
  resolveHarnessCapabilities,
} from "../../acp/harness-capabilities.js";
import type { SessionRecord } from "../../types.js";
import { withSessionIndexLock } from "./index-lock.js";
import { parseSessionRecord } from "./parse.js";

const SESSION_INDEX_SCHEMA = "acpx.session-index.v1";

export type SessionIndexSubscriptionSwitch = {
  from?: string;
  to: string;
  reason: "manual" | "failover" | "locked" | "selection";
  at: string;
};

export type SessionIndexAccountSwitch = {
  fromProfile?: string;
  toProfile: string;
  fromAccount?: string;
  toAccount: string;
  effectiveAccount?: string;
  effectiveProfile?: string;
  effectiveAuthMode?: string;
  effectiveAnchor?: string;
  effectiveResolutionMethod?: "path" | "selection";
  reason: "manual" | "failover" | "locked" | "selection";
  at: string;
};

export type SessionIndexEntry = {
  file: string;
  acpxRecordId: string;
  acpSessionId: string;
  agentName?: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  closed: boolean;
  lastUsedAt: string;
  kind?: "session" | "subagent";
  // ── Hot-path enrichment (perf/index-entry-enrichment) ───────────────────────
  // Scalar fields acpx-ui's ~2 Hz session-list rebuild needs per session,
  // projected into this sidecar so the hot path reads index.json (already
  // stat-gated + cached) instead of decoding + JSON.parsing each multi-MB
  // session record. All optional + additive — NO schema bump: an old index, or
  // an acpx-ui-written partial entry, simply lacks them and acpx-ui falls back
  // to the per-record read for those fields, self-healing on the next daemon
  // rewrite. Kept as fresh as the record itself (written in the same atomic
  // index rewrite as the record write — see repository.ts).
  lastWriteAt?: string;
  activePath?: string;
  lastPromptAt?: string;
  favorite?: boolean;
  title?: string | null;
  createdAt?: string;
  parentSessionId?: string;
  /**
   * Full parent acpx-ui URL (host+id) for a cross-box parent; absent for same-box
   * parents. acpx-ui's own SessionIndexEntry already declares this field and its
   * comment says it is "projected by acpx into index.json" — it reads it here to
   * link a remote parent in the relations tree, so the LIST path needs it just as
   * much as the record does. (brick://c6e3618b)
   */
  parentSessionUrl?: string;
  forkedFromSessionId?: string;
  /** The EFFECTIVE fork boundary (see SessionRecord.forkedAtMessageIndex). */
  forkedAtMessageIndex?: number;
  /**
   * The REQUESTED fork boundary, present only when it differs from the
   * effective one. Projected onto the index entry — NOT only into the detail
   * view — because the chat header reads its view from the entry on the enriched
   * hot path (acpx-ui `projectEntryToRawView`, where `sessionData` is null), so a
   * field that stops here fails only at RUNTIME while typecheck and build stay
   * green. CONCEPTION 9.3 leg 4.
   */
  forkedAtMessageIndexRequested?: number;
  metadataTaskFolder?: string;
  metadataBrick?: string;
  // Infra-label (brick 2ac729a4): metadata.infra projected as hot-path scalars so
  // acpx-ui's fleet-list ⚙ infra badge renders without a per-record read. Additive,
  // no schema bump — mirrors metadataBrick. Preserved across reconcile by
  // parseIndexEntry below so an acpx-ui-written entry survives the daemon rewrite.
  metadataInfra?: boolean;
  metadataInfraPurpose?: string;
  metadataInfraWakeupId?: string;
  // A byway is stored as a normal kind:"session" fork flagged metadata.byway==="1"
  // (acpx-ui convention). Projected so acpx-ui's kind resolution can run from the
  // entry without reading the record. Byway *lineage* (byway_parent/byway_at)
  // stays on acpx-ui's record-fallback for the rare byway case.
  byway?: boolean;
  currentModelId?: string;
  sessionModel?: string;
  // Agent's advertised image-prompt capability (record agentCapabilities
  // .promptCapabilities.image), projected so acpx-ui drives the chat image-attach
  // affordance from this entry instead of reading the multi-MB record on every
  // ~2 Hz session-list rebuild. undefined = the agent never advertised a boolean
  // (older record / capability not captured) → acpx-ui treats absent as off.
  promptImageSupported?: boolean;
  desiredEffort?: string;
  /**
   * What the depth request ACTUALLY produced — the outcome kind, and the value
   * served when one was (B3, CONCEPTION §6.2).
   *
   * ⚠️ Projected onto the INDEX ENTRY, not only into the detail view, and the
   * reason is the same one `forkedAtMessageIndexRequested` documents above: the
   * chat header reads its view from the entry on the enriched hot path (acpx-ui
   * `projectEntryToRawView`, where `sessionData` is null), so a field that stops
   * at the record fails only at RUNTIME while typecheck and build stay green.
   *
   * ⚠️ `desiredEffort` above is the REQUEST. Without these two the header can
   * show a request that was never honoured with nothing to say so — which is the
   * silent drop this block exists to end, relocated one layer up.
   */
  depthOutcome?: string;
  depthServed?: string;
  /**
   * The DESCRIPTOR's `canSetModelLive`, REFINED by this session's own
   * advertisement (F-12). The UI's live-model control reads this, not the static
   * table — see {@link canSetModelLiveFromRecord}.
   *
   * `undefined` means acpx cannot classify the adapter and makes no claim.
   */
  canSetModelLive?: boolean;
  // brick://874fee67 — projected so acpx-ui's hot-path (record-skipping) session
  // rebuild shows the real style in the chat header instead of a UI default
  // (the brick://4d517be2 failure class: passes typecheck+build, fails only at
  // runtime). `outputStyle` is the DURABLE session_options value, not the live
  // desired_config_options one — the durable field is what a respawn re-applies.
  outputStyleDesired?: string;
  // Whether this session's agent advertises the `outputStyle` config option.
  // THREE-VALUED ON PURPOSE: true / false / undefined = UNKNOWN (the record never
  // captured config_options — an old session, or an adapter that predates the
  // feature). Collapsing unknown into either neighbour produces either a control
  // that silently does nothing or a hidden working feature (design §6).
  outputStyleSupported?: boolean;
  // APPLIED: the style the session's CURRENT LIVE QUERY was built with
  // (acpx-level `applied_output_style`). Projected alongside `outputStyleDesired` because the two together are what the header renders: equal =
  // installed, differing = a change is pending until the owner recycles. Without
  // this on the hot path the chip cannot distinguish those states without a
  // per-record read on every ~2 Hz list rebuild.
  // ⚠️ This is OUR action record, never the harness `output_style` readback —
  // keep the two names distinct all the way to the client (spec §7).
  outputStyleApplied?: string;
  // REFUSED: a style the agent DECLINED because it does not exist under the
  // subscription this session moved to (`refused_output_style`). We stamp
  // `applied = "default"` and RETIRE THE RETRY, so `desired !== applied` stays true
  // forever — which means a consumer that sees only that pair on the hot path
  // renders the refusal as a pending install and promises it on every message,
  // permanently. Projected for exactly that reason: it is the term that turns the
  // promise off and lets the UI say "unavailable on this subscription" instead
  // (brick://874fee67 TESTER-PLAN §R5; found live in acpx-ui as brick://31af5eaf
  // F-2, where the field stopped dead at this boundary).
  outputStyleRefused?: string;
  autoFailover?: boolean;
  // brick://4d517be2 — projected so acpx-ui's hot-path (record-skipping) session
  // rebuild surfaces the two new policy toggles + the degrade marker in the chat
  // header without a per-record read (mirrors autoFailover). `degradedFrom` is the
  // pre-degrade Fable id, projected only while model_source==='explicit-degrade'.
  autoSubscription?: boolean;
  fableDegradeOk?: boolean;
  modelSource?: string;
  degradedFrom?: string;
  subscription?: string;
  profile?: string;
  subscriptionSwitch?: SessionIndexSubscriptionSwitch;
  accountSwitch?: SessionIndexAccountSwitch;
  templateEnabled?: boolean;
  templateCreatedAt?: string;
  templateAutoPrompt?: string;
  // Slug + version (W13-01). Projected so the latest-per-slug collapse + slug
  // resolution run off the index with no per-record read. effectiveSlug =
  // templateSlug ?? slugify(name); the comparator (template-slug.ts Appendix B)
  // uses templateVersion/templateCreatedAt to pick the latest.
  templateSlug?: string;
  templateVersion?: number;
};

type SessionIndex = {
  schema: typeof SESSION_INDEX_SCHEMA;
  files: string[];
  entries: SessionIndexEntry[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const INDEX_SUBSCRIPTION_SWITCH_REASONS = new Set<string>([
  "manual",
  "failover",
  "locked",
  "selection",
]);

function isIndexSubscriptionSwitchReason(
  value: unknown,
): value is SessionIndexSubscriptionSwitch["reason"] {
  return typeof value === "string" && INDEX_SUBSCRIPTION_SWITCH_REASONS.has(value);
}

function parseIndexSubscriptionSwitch(value: unknown): SessionIndexSubscriptionSwitch | undefined {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.to !== "string" ||
    !isIndexSubscriptionSwitchReason(record.reason) ||
    typeof record.at !== "string"
  ) {
    return undefined;
  }
  return {
    ...(typeof record.from === "string" ? { from: record.from } : {}),
    to: record.to,
    reason: record.reason,
    at: record.at,
  };
}

function isValidIndexAccountSwitch(record: Record<string, unknown>): record is {
  fromProfile?: string;
  toProfile: string;
  fromAccount?: string;
  toAccount: string;
  effectiveAccount?: string;
  effectiveProfile?: string;
  effectiveAuthMode?: string;
  effectiveAnchor?: string;
  effectiveResolutionMethod?: "path" | "selection";
  reason: "manual" | "failover" | "locked" | "selection";
  at: string;
} {
  return (
    typeof record.toProfile === "string" &&
    typeof record.toAccount === "string" &&
    (record.reason === "manual" ||
      record.reason === "failover" ||
      record.reason === "locked" ||
      record.reason === "selection") &&
    typeof record.at === "string"
  );
}

type IndexAccountSwitchStringKey = Exclude<
  keyof Omit<SessionIndexAccountSwitch, "reason" | "at">,
  "effectiveResolutionMethod"
>;

function assignOptionalAccountSwitchString(
  target: Partial<SessionIndexAccountSwitch>,
  key: IndexAccountSwitchStringKey,
  value: unknown,
): void {
  if (typeof value === "string") {
    target[key] = value;
  }
}

function accountSwitchMetadata(
  record: Record<string, unknown>,
): Partial<SessionIndexAccountSwitch> {
  const metadata: Partial<SessionIndexAccountSwitch> = {};
  assignOptionalAccountSwitchString(metadata, "fromProfile", record.fromProfile);
  assignOptionalAccountSwitchString(metadata, "fromAccount", record.fromAccount);
  assignOptionalAccountSwitchString(metadata, "effectiveAccount", record.effectiveAccount);
  assignOptionalAccountSwitchString(metadata, "effectiveProfile", record.effectiveProfile);
  assignOptionalAccountSwitchString(metadata, "effectiveAuthMode", record.effectiveAuthMode);
  assignOptionalAccountSwitchString(metadata, "effectiveAnchor", record.effectiveAnchor);
  if (
    record.effectiveResolutionMethod === "path" ||
    record.effectiveResolutionMethod === "selection"
  ) {
    metadata.effectiveResolutionMethod = record.effectiveResolutionMethod;
  }
  return metadata;
}

function parseIndexAccountSwitch(value: unknown): SessionIndexAccountSwitch | undefined {
  const record = asRecord(value);
  if (!record || !isValidIndexAccountSwitch(record)) {
    return undefined;
  }
  return {
    toProfile: record.toProfile,
    toAccount: record.toAccount,
    ...accountSwitchMetadata(record),
    reason: record.reason,
    at: record.at,
  };
}

// eslint-disable-next-line complexity -- flat field-by-field projection of the optional hot-path enrichment scalars; linear, not branchy logic
function parseIndexEntry(raw: unknown): SessionIndexEntry | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  if (!hasRequiredIndexEntryFields(record)) {
    return undefined;
  }
  if (record.name !== undefined && typeof record.name !== "string") {
    return undefined;
  }
  if (record.kind !== undefined && record.kind !== "session" && record.kind !== "subagent") {
    return undefined;
  }
  // Preserve the optional hot-path enrichment fields untouched. This is
  // load-bearing: writeSessionRecordInternal rebuilds only the touched entry via
  // toSessionIndexEntry and writes back every OTHER entry exactly as parsed here
  // — so dropping these on parse would strip enrichment off all untouched
  // sessions on every record write. Lenient: a wrong-typed optional field is
  // dropped, never rejects the entry.
  return {
    file: record.file,
    acpxRecordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId,
    agentName: optionalString(record.agentName),
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name: record.name,
    closed: record.closed,
    lastUsedAt: record.lastUsedAt,
    kind: record.kind,
    lastWriteAt: optionalString(record.lastWriteAt),
    activePath: optionalString(record.activePath),
    lastPromptAt: optionalString(record.lastPromptAt),
    favorite: optionalBoolean(record.favorite),
    title: typeof record.title === "string" ? record.title : undefined,
    createdAt: optionalString(record.createdAt),
    parentSessionId: optionalString(record.parentSessionId),
    parentSessionUrl: optionalString(record.parentSessionUrl),
    forkedFromSessionId: optionalString(record.forkedFromSessionId),
    forkedAtMessageIndex: optionalFiniteNumber(record.forkedAtMessageIndex),
    forkedAtMessageIndexRequested: optionalFiniteNumber(record.forkedAtMessageIndexRequested),
    metadataTaskFolder: optionalString(record.metadataTaskFolder),
    metadataBrick: optionalString(record.metadataBrick),
    metadataInfra: optionalBoolean(record.metadataInfra),
    metadataInfraPurpose: optionalString(record.metadataInfraPurpose),
    metadataInfraWakeupId: optionalString(record.metadataInfraWakeupId),
    byway: optionalBoolean(record.byway),
    currentModelId: optionalString(record.currentModelId),
    sessionModel: optionalString(record.sessionModel),
    promptImageSupported: optionalBoolean(record.promptImageSupported),
    desiredEffort: optionalString(record.desiredEffort),
    depthOutcome: optionalString(record.depthOutcome),
    depthServed: optionalString(record.depthServed),
    canSetModelLive:
      typeof record.canSetModelLive === "boolean" ? record.canSetModelLive : undefined,
    // brick://874fee67: BOTH index legs. This parser reconstructs an entry from
    // index.json on reconcile — miss it and an acpx-ui-written entry is stripped
    // on the next daemon rewrite, exactly as autoSubscription is parsed above.
    outputStyleDesired: optionalString(record.outputStyleDesired),
    outputStyleSupported: optionalBoolean(record.outputStyleSupported),
    outputStyleApplied: optionalString(record.outputStyleApplied),
    outputStyleRefused: optionalString(record.outputStyleRefused),
    autoFailover: optionalBoolean(record.autoFailover),
    autoSubscription: optionalBoolean(record.autoSubscription),
    fableDegradeOk: optionalBoolean(record.fableDegradeOk),
    modelSource: optionalString(record.modelSource),
    degradedFrom: optionalString(record.degradedFrom),
    subscription: optionalString(record.subscription),
    profile: optionalString(record.profile),
    subscriptionSwitch: parseIndexSubscriptionSwitch(record.subscriptionSwitch),
    accountSwitch: parseIndexAccountSwitch(record.accountSwitch),
    templateEnabled: optionalBoolean(record.templateEnabled),
    templateCreatedAt: optionalString(record.templateCreatedAt),
    templateAutoPrompt: optionalString(record.templateAutoPrompt),
    templateSlug: optionalString(record.templateSlug),
    templateVersion: optionalFiniteNumber(record.templateVersion),
  };
}

function hasRequiredIndexEntryFields(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  file: string;
  acpxRecordId: string;
  acpSessionId: string;
  agentName?: string;
  agentCommand: string;
  cwd: string;
  lastUsedAt: string;
  closed: boolean;
} {
  return (
    ["file", "acpxRecordId", "acpSessionId", "agentCommand", "cwd", "lastUsedAt"].every(
      (key) => typeof record[key] === "string",
    ) && typeof record.closed === "boolean"
  );
}

export function sessionIndexPath(sessionDir: string): string {
  return path.join(sessionDir, "index.json");
}

// Agent's advertised image-prompt capability, derived from the record's
// agentCapabilities.promptCapabilities.image. Mirrors acpx-ui's
// extractPromptImageSupported EXACTLY (`typeof boolean ? value : undefined`) so the
// projected index field and acpx-ui's record-read derivation agree byte-for-byte —
// this is one half of the cross-repo W13-18 contract (the other half: acpx-ui reads
// `entry.promptImageSupported` and drops its per-record fallback). undefined = the
// agent never advertised a boolean (older record / capability never captured).
function promptImageSupportedFromRecord(record: SessionRecord): boolean | undefined {
  const image = record.agentCapabilities?.promptCapabilities?.image;
  return typeof image === "boolean" ? image : undefined;
}

// brick://874fee67: support is derived from what the ADAPTER ADVERTISES, never
// from the agent name — during a rollout an updated acpx-ui talks to sessions on
// a not-yet-updated adapter, where agent-type sniffing would say "claude →
// supported" and show a control that does nothing (design §6). Absent
// config_options is UNKNOWN (undefined), not "unsupported".
function outputStyleSupportedFromRecord(acpx: SessionRecord["acpx"]): boolean | undefined {
  const advertised = acpx?.config_options;
  if (!Array.isArray(advertised)) {
    return undefined;
  }
  return advertised.some((option) => option?.id === "outputStyle");
}

/**
 * Whether THIS SESSION can actually have its model changed live (F-12, brick
 * 2dc93747) — the STATIC descriptor REFINED by what this session's adapter
 * actually advertised.
 *
 * ⚠️ THE STATIC FLAG OVER-CLAIMS AND THE UI READS IT. Staging served opencode
 * with `canSetModelLive: true` while its adapter had advertised NO selectable
 * `model` option, so the live-model control would be offered on a session where
 * it can only ever refuse. Daniel's requirement is "declared in acpx, REFINED by
 * what the adapter advertises at runtime"; only the first half was reaching a
 * consumer.
 *
 * ⚠️ IT IS PROJECTED ONTO THE INDEX ENTRY, not only into the detail view, for the
 * same reason `forkedAtMessageIndexRequested` and `depthOutcome` are: the chat
 * header reads its view from the entry on the enriched hot path (acpx-ui
 * `projectEntryToRawView`, where `sessionData` is null), so a value that stops at
 * the record fails only at RUNTIME while typecheck and build stay green.
 *
 * ⚠️ DERIVED AT PROJECTION, NOT PERSISTED. It is a function of the record's own
 * `agent_command` + `config_options`, so it cannot go stale against them and it
 * needs no round-trip, clone or parse leg — the three legs a new persisted field
 * would have needed, one of which has already been missed once in this block.
 *
 * `undefined` when the descriptor cannot classify the agent: acpx has no claim to
 * make about an adapter it has never seen, and answering `false` would hide a
 * control that may work perfectly.
 */
function canSetModelLiveFromRecord(record: SessionRecord): boolean | undefined {
  const harness = harnessIdForAgentCommand(record.agentCommand);
  if (harness === undefined) {
    return undefined;
  }
  const advertised = record.acpx?.config_options;
  return resolveHarnessCapabilities(harness, advertised ? { configOptions: advertised } : undefined)
    .canSetModelLive;
}

// eslint-disable-next-line complexity -- flat field-by-field projection of the optional hot-path enrichment scalars; linear, not branchy logic
export function toSessionIndexEntry(record: SessionRecord, fileName: string): SessionIndexEntry {
  const acpx = record.acpx;
  const sessionOptions = acpx?.session_options;
  const metadata = record.metadata;
  // undefined-valued fields are dropped by JSON.stringify in writeSessionIndex,
  // so the index stays lean — only fields the record actually carries are
  // persisted. Every field below is a small scalar (or the tiny subscription
  // switch breadcrumb); the bulky `messages` array is never projected.
  return {
    file: fileName,
    acpxRecordId: record.acpxRecordId,
    acpSessionId: record.acpSessionId,
    agentName: record.agentName,
    agentCommand: record.agentCommand,
    cwd: record.cwd,
    name: record.name,
    closed: record.closed === true,
    lastUsedAt: record.lastUsedAt,
    kind: record.kind,
    lastWriteAt: record.eventLog?.last_write_at,
    activePath: record.eventLog?.active_path,
    lastPromptAt: record.lastPromptAt,
    favorite: record.favorite,
    title: record.title ?? undefined,
    createdAt: record.createdAt,
    parentSessionId: record.parentSessionId,
    parentSessionUrl: record.parentSessionUrl,
    forkedFromSessionId: record.forkedFromSessionId,
    forkedAtMessageIndex: record.forkedAtMessageIndex,
    forkedAtMessageIndexRequested: record.forkedAtMessageIndexRequested,
    metadataTaskFolder: metadata?.task_folder,
    metadataBrick: metadata?.brick,
    // Infra label (brick 2ac729a4): flat string keys → hot-path index scalars.
    metadataInfra: metadata?.infra === "1" ? true : undefined,
    metadataInfraPurpose: metadata?.infra_purpose,
    metadataInfraWakeupId: metadata?.infra_wakeup_id,
    byway: metadata?.byway === "1" ? true : undefined,
    currentModelId: acpx?.current_model_id,
    sessionModel: sessionOptions?.model,
    promptImageSupported: promptImageSupportedFromRecord(record),
    desiredEffort: acpx?.desired_config_options?.effort,
    depthOutcome: acpx?.depth_projection?.outcome,
    depthServed: acpx?.depth_projection?.served,
    outputStyleDesired: sessionOptions?.output_style,
    canSetModelLive: canSetModelLiveFromRecord(record),
    outputStyleSupported: outputStyleSupportedFromRecord(acpx),
    outputStyleApplied: acpx?.applied_output_style,
    outputStyleRefused: acpx?.refused_output_style,
    autoFailover: sessionOptions?.auto_failover,
    autoSubscription: sessionOptions?.auto_subscription,
    fableDegradeOk: sessionOptions?.fable_degrade_ok,
    modelSource: sessionOptions?.model_source,
    degradedFrom:
      sessionOptions?.model_source === "explicit-degrade"
        ? sessionOptions?.fable_degrade?.from
        : undefined,
    subscription: sessionOptions?.subscription,
    profile: sessionOptions?.profile,
    subscriptionSwitch: sessionOptions?.subscription_switch,
    accountSwitch: sessionOptions?.account_switch,
    templateEnabled: record.template?.enabled,
    templateCreatedAt: record.template?.created_at,
    templateAutoPrompt: record.template?.auto_prompt,
    templateSlug: record.template?.slug,
    templateVersion: record.template?.version,
  };
}

export async function readSessionIndex(sessionDir: string): Promise<SessionIndex | undefined> {
  const filePath = sessionIndexPath(sessionDir);
  try {
    const payload = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(payload) as unknown;
    const record = asRecord(parsed);
    if (!record || record.schema !== SESSION_INDEX_SCHEMA || !Array.isArray(record.files)) {
      return undefined;
    }
    const files = record.files.filter((entry): entry is string => typeof entry === "string");
    if (files.length !== record.files.length || !Array.isArray(record.entries)) {
      return undefined;
    }
    const entries = record.entries
      .map((entry) => parseIndexEntry(entry))
      .filter((entry): entry is SessionIndexEntry => Boolean(entry));
    if (entries.length !== record.entries.length) {
      return undefined;
    }
    return {
      schema: SESSION_INDEX_SCHEMA,
      files,
      entries,
    };
  } catch {
    return undefined;
  }
}

export async function writeSessionIndex(
  sessionDir: string,
  index: {
    files: string[];
    entries: SessionIndexEntry[];
  },
): Promise<void> {
  const filePath = sessionIndexPath(sessionDir);
  // Per-call randomUUID: `${pid}.${Date.now()}` alone is NOT unique. Two writes
  // from this process in the same millisecond build the identical temp path, so
  // the first rename wins and the second hits ENOENT — turning a concurrent
  // index write into a thrown error. Broader exposure than the per-session
  // record (repository.ts): the temp path derives only from `sessionDir`, so
  // EVERY concurrent index write in the store collides, not just same-record
  // ones — and there are two independent async writers (reconcileSessionIndex
  // below, and the index-update-queue flush). Uniqueness, not serialization:
  // this is a filename collision, and ordering here is deliberately free.
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  // Compact JSON (no pretty-print): parses identically for every consumer,
  // saves ~30-40% of bytes and stringify CPU per rewrite.
  const payload = JSON.stringify({
    schema: SESSION_INDEX_SCHEMA,
    files: [...index.files].toSorted(),
    entries: [...index.entries].toSorted((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt)),
  });
  await fs.writeFile(tempFile, `${payload}\n`, "utf8");
  await fs.rename(tempFile, filePath);
}

async function listSessionRecordFiles(sessionDir: string): Promise<string[]> {
  return (await fs.readdir(sessionDir, { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "index.json",
    )
    .map((entry) => entry.name)
    .toSorted();
}

async function readIndexEntryFromDisk(
  sessionDir: string,
  file: string,
): Promise<SessionIndexEntry | undefined> {
  try {
    const payload = await fs.readFile(path.join(sessionDir, file), "utf8");
    const parsed = parseSessionRecord(JSON.parse(payload));
    if (!parsed) {
      return undefined;
    }
    return toSessionIndexEntry(parsed, file);
  } catch {
    // corrupt, or vanished between readdir and read — treated the same as the
    // full-rebuild path: the file keeps its file-list row but gets no entry
    return undefined;
  }
}

// --json-strict guarantees machine-clean stderr; the CLI entrypoint suppresses
// the rebuild notice for those invocations (same class as session banners).
let rebuildLogSuppressed = false;

export function setSessionIndexRebuildLogSuppressed(suppressed: boolean): void {
  rebuildLogSuppressed = suppressed;
}

export async function rebuildSessionIndex(
  sessionDir: string,
  reason: string,
): Promise<SessionIndex> {
  // Full-store re-parse — the prod observable for the "zero full-store
  // rebuilds on new-file creation" target (VERIFICATION-ANNEX S4 greps for it).
  if (!rebuildLogSuppressed) {
    process.stderr.write(`[acpx] full session-index rebuild (reason: ${reason})\n`);
  }
  // Advisory lock (re-entrant under a caller already holding it). A rebuild
  // over a very large store can outlive the 5 s stale threshold and lose the
  // lock to a takeover — acceptable: that degrades to the pre-lock racing
  // behaviour for this rare reserve path.
  return await withSessionIndexLock(sessionDir, async () => {
    const files = await listSessionRecordFiles(sessionDir);

    const indexEntries: SessionIndexEntry[] = [];
    for (const file of files) {
      const entry = await readIndexEntryFromDisk(sessionDir, file);
      if (entry) {
        indexEntries.push(entry);
      }
    }

    const index: SessionIndex = {
      schema: SESSION_INDEX_SCHEMA,
      files,
      entries: indexEntries,
    };
    await writeSessionIndex(sessionDir, index);
    return index;
  });
}

export type ReconciledSessionIndex = {
  index: SessionIndex;
  /** True when the on-disk file list and index.files disagreed (the returned
   * index reflects disk but has NOT been written back — membership changes
   * persist via the caller's index write). */
  drift: boolean;
};

/**
 * Load the session index, reconciling file-list drift incrementally: records
 * absent from the index are read and parsed individually; index rows whose
 * files vanished are dropped without any read. The full-store re-parse
 * (`rebuildSessionIndex`) is reserved for a missing or unparseable index.json.
 *
 * `providedEntries` lets a caller that already holds a fresh entry for a file
 * (e.g. the record writer that just created it) supply it directly, so the
 * reconcile does not re-read the multi-MB record it was derived from.
 */
export async function reconcileSessionIndex(
  sessionDir: string,
  providedEntries?: ReadonlyMap<string, SessionIndexEntry>,
): Promise<ReconciledSessionIndex> {
  const files = await listSessionRecordFiles(sessionDir);
  const existing = await readSessionIndex(sessionDir);
  if (!existing) {
    return {
      index: await rebuildSessionIndex(sessionDir, "index.json missing or unparseable"),
      drift: true,
    };
  }
  if (existing.files.length === files.length && existing.files.every((f, i) => f === files[i])) {
    return { index: existing, drift: false };
  }

  return {
    index: {
      schema: SESSION_INDEX_SCHEMA,
      files,
      entries: await reconcileDriftedEntries(sessionDir, existing, files, providedEntries),
    },
    drift: true,
  };
}

async function reconcileDriftedEntries(
  sessionDir: string,
  existing: SessionIndex,
  files: string[],
  providedEntries: ReadonlyMap<string, SessionIndexEntry> | undefined,
): Promise<SessionIndexEntry[]> {
  const diskFiles = new Set(files);
  const indexedFiles = new Set(existing.files);
  // Vanished files: drop their entries; no reads.
  const entries = existing.entries.filter((entry) => diskFiles.has(entry.file));
  // New files: parse only those records (last-wins on duplicate entries,
  // matching the existing filter+push replace behaviour).
  for (const file of files) {
    if (indexedFiles.has(file)) {
      continue;
    }
    const entry = providedEntries?.get(file) ?? (await readIndexEntryFromDisk(sessionDir, file));
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

export async function loadOrRebuildSessionIndex(sessionDir: string): Promise<SessionIndex> {
  return (await reconcileSessionIndex(sessionDir)).index;
}
