import type {
  SessionAcpxState,
  SessionEventLog,
  SessionMessagesLogState,
  SessionRecord,
  SessionConversation,
  SubagentRef,
} from "../../types.js";
import { SESSION_RECORD_SCHEMA } from "../../types.js";
import { defaultSessionEventLog } from "../event-log.js";
import { normalizeSessionOwnerOptions } from "../owner-options.js";
import { normalizeRuntimeSessionId } from "../runtime-session-id.js";
import { rememberSessionMetadataBaseline } from "./metadata-merge.js";
import { rememberSessionModelBaseline } from "./model-merge.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseTokenUsage(
  raw: unknown,
): SessionConversation["cumulative_token_usage"] | null | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const usage: SessionConversation["cumulative_token_usage"] = {};
  const fields: Array<keyof SessionConversation["cumulative_token_usage"]> = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ];

  for (const field of fields) {
    const value = record[field];
    if (value === undefined) {
      continue;
    }
    if (!isNonNegativeFiniteNumber(value)) {
      return null;
    }
    usage[field] = value;
  }

  return usage;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function parseRequestTokenUsage(
  raw: unknown,
): SessionConversation["request_token_usage"] | null | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  const usage: SessionConversation["request_token_usage"] = {};
  for (const [key, value] of Object.entries(record)) {
    const parsed = parseTokenUsage(value);
    if (parsed == null) {
      return null;
    }
    usage[key] = parsed;
  }

  return usage;
}

function isSessionMessageImage(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record || typeof record.source !== "string") {
    return false;
  }

  if (record.size === undefined || record.size === null) {
    return true;
  }

  const size = asRecord(record.size);
  return !!size && isFiniteNumber(size.width) && isFiniteNumber(size.height);
}

function isSessionMessageAudio(raw: unknown): boolean {
  const record = asRecord(raw);
  return !!record && typeof record.source === "string" && typeof record.mime_type === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUserContent(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record) {
    return false;
  }

  if (typeof record.Text === "string") {
    return true;
  }

  if (record.Mention !== undefined) {
    const mention = asRecord(record.Mention);
    return !!mention && typeof mention.uri === "string" && typeof mention.content === "string";
  }

  if (record.Image !== undefined) {
    return isSessionMessageImage(record.Image);
  }

  if (record.Audio !== undefined) {
    return isSessionMessageAudio(record.Audio);
  }

  return false;
}

function isToolUse(raw: unknown): boolean {
  const record = asRecord(raw);
  return (
    !!record &&
    hasStringFields(record, ["id", "name", "raw_input"]) &&
    hasOwn(record, "input") &&
    typeof record.is_input_complete === "boolean" &&
    isOptionalString(record.thought_signature)
  );
}

function hasStringFields(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof record[key] === "string");
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isToolResultContent(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record) {
    return false;
  }

  if (typeof record.Text === "string") {
    return true;
  }

  if (record.Image !== undefined) {
    return isSessionMessageImage(record.Image);
  }

  return false;
}

function isToolResult(raw: unknown): boolean {
  const record = asRecord(raw);
  return (
    !!record &&
    typeof record.tool_use_id === "string" &&
    typeof record.tool_name === "string" &&
    typeof record.is_error === "boolean" &&
    isToolResultContent(record.content)
  );
}

function isAgentContent(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record) {
    return false;
  }

  if (typeof record.Text === "string") {
    return true;
  }

  if (record.Thinking !== undefined) {
    return isThinkingContent(record.Thinking);
  }

  if (typeof record.RedactedThinking === "string") {
    return true;
  }

  if (record.ToolUse !== undefined) {
    return isToolUse(record.ToolUse);
  }

  return false;
}

function isThinkingContent(raw: unknown): boolean {
  const thinking = asRecord(raw);
  return !!thinking && typeof thinking.text === "string" && isOptionalString(thinking.signature);
}

function isUserMessage(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record || record.User === undefined) {
    return false;
  }

  const user = asRecord(record.User);
  return (
    !!user &&
    typeof user.id === "string" &&
    Array.isArray(user.content) &&
    user.content.every((entry) => isUserContent(entry))
  );
}

function isAgentMessage(raw: unknown): boolean {
  const record = asRecord(raw);
  if (!record || record.Agent === undefined) {
    return false;
  }

  const agent = asRecord(record.Agent);
  if (!agent || !Array.isArray(agent.content) || !agent.content.every(isAgentContent)) {
    return false;
  }

  const toolResults = asRecord(agent.tool_results);
  if (!toolResults) {
    return false;
  }

  return Object.values(toolResults).every(isToolResult);
}

function isConversationMessage(raw: unknown): boolean {
  return raw === "Resume" || isUserMessage(raw) || isAgentMessage(raw);
}

function parseConversationRecord(record: Record<string, unknown>): SessionConversation | undefined {
  if (!hasValidConversationCore(record)) {
    return undefined;
  }

  const title = parseConversationTitle(record.title);
  if (title === INVALID_VALUE) {
    return undefined;
  }

  const cumulativeTokenUsage = parseTokenUsage(record.cumulative_token_usage);
  const requestTokenUsage = parseRequestTokenUsage(record.request_token_usage);
  if (cumulativeTokenUsage === null || requestTokenUsage === null) {
    return undefined;
  }

  return {
    title,
    messages: record.messages,
    updated_at: record.updated_at,
    cumulative_token_usage: cumulativeTokenUsage ?? {},
    request_token_usage: requestTokenUsage ?? {},
  };
}

const INVALID_VALUE = Symbol("invalid");

function parseConversationTitle(value: unknown): string | null | undefined | typeof INVALID_VALUE {
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  return INVALID_VALUE;
}

function hasValidConversationCore(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  messages: SessionConversation["messages"];
  updated_at: string;
} {
  return (
    Array.isArray(record.messages) &&
    record.messages.every(isConversationMessage) &&
    typeof record.updated_at === "string"
  );
}

function parseAcpxState(raw: unknown): SessionAcpxState | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }

  const state: SessionAcpxState = {};

  assignBooleanTrue(state, "reset_on_next_ensure", record.reset_on_next_ensure);
  assignStringState(state, "current_mode_id", record.current_mode_id);
  assignStringState(state, "desired_mode_id", record.desired_mode_id);

  assignDesiredConfigOptions(state, record.desired_config_options);

  assignStringState(state, "current_model_id", record.current_model_id);

  // Fix A (brick 92a994a0): the persisted authoritative context window + its
  // model tag MUST round-trip back on a cold disk reload, or every owner
  // respawn loses them and resolveContextWindowHint returns undefined — so a
  // resumed 1M session re-guesses 200k. Mirror serialize's passthrough here.
  if (
    typeof record.context_window_size === "number" &&
    Number.isFinite(record.context_window_size) &&
    record.context_window_size > 0
  ) {
    state.context_window_size = record.context_window_size;
  }
  assignStringState(state, "context_window_model_id", record.context_window_model_id);

  if (isStringArray(record.available_models)) {
    state.available_models = [...record.available_models];
  }

  if (isStringArray(record.available_commands)) {
    state.available_commands = [...record.available_commands];
  }

  if (Array.isArray(record.config_options)) {
    state.config_options = record.config_options as SessionAcpxState["config_options"];
  }

  assignParsedOwnerOptions(state, record.owner_options);
  assignParsedSessionOptions(state, record.session_options);

  // brick://07dd62c9: the live served block + floor breadcrumbs MUST round-trip on
  // a cold disk reload (mirror context_window_size), or every queue-owner delivery
  // / owner respawn strips them — the served-truth surface goes blank and the
  // durable park (⭐ retry-across-time) does not survive a respawn.
  assignServedState(state, record.served);
  assignServedBelowFloor(state, record.served_below_floor);
  assignFloorParked(state, record.floor_parked);

  return state;
}

// Copy the optional string fields of the live served block. Best-effort passthrough
// of an acpx-authored object (mirror the lenient config_options passthrough).
function assignServedState(state: SessionAcpxState, raw: unknown): void {
  const served = asRecord(raw);
  if (!served) {
    return;
  }
  const parsed: Record<string, unknown> = {};
  copyStringField(parsed, served, "model");
  copyStringField(parsed, served, "effort");
  copyStringField(parsed, served, "at");
  copyStringField(parsed, served, "source");
  if (Object.keys(parsed).length > 0) {
    state.served = parsed as NonNullable<SessionAcpxState["served"]>;
  }
}

function assignServedBelowFloor(state: SessionAcpxState, raw: unknown): void {
  const crumb = asRecord(raw);
  if (!crumb || typeof crumb.at !== "string" || crumb.at.length === 0) {
    return;
  }
  const parsed: Record<string, unknown> = { at: crumb.at };
  copyStringField(parsed, crumb, "served_model");
  copyStringField(parsed, crumb, "served_effort");
  copyStringField(parsed, crumb, "pinned_model");
  copyStringField(parsed, crumb, "pinned_effort");
  state.served_below_floor = parsed as NonNullable<SessionAcpxState["served_below_floor"]>;
}

function assignFloorParked(state: SessionAcpxState, raw: unknown): void {
  const parked = asRecord(raw);
  if (
    !parked ||
    typeof parked.at !== "string" ||
    parked.at.length === 0 ||
    typeof parked.reason !== "string" ||
    parked.reason.length === 0
  ) {
    return;
  }
  const parsed: Record<string, unknown> = { at: parked.at, reason: parked.reason };
  copyStringField(parsed, parked, "observed_model");
  state.floor_parked = parsed as NonNullable<SessionAcpxState["floor_parked"]>;
}

// Copy `source[key]` onto `target[key]` when it is a non-empty string. A small
// helper so the served/breadcrumb passthroughs stay flat (lint complexity ≤ 8).
function copyStringField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "string" && value.length > 0) {
    target[key] = value;
  }
}

function assignBooleanTrue(
  state: SessionAcpxState,
  key: "reset_on_next_ensure",
  value: unknown,
): void {
  if (value === true) {
    state[key] = true;
  }
}

function assignStringState(
  state: SessionAcpxState,
  key: "current_mode_id" | "desired_mode_id" | "current_model_id" | "context_window_model_id",
  value: unknown,
): void {
  if (typeof value === "string") {
    state[key] = value;
  }
}

function assignDesiredConfigOptions(state: SessionAcpxState, raw: unknown): void {
  const desiredConfigOptions = asRecord(raw);
  if (!desiredConfigOptions) {
    return;
  }

  const parsed = Object.fromEntries(
    Object.entries(desiredConfigOptions).filter((entry): entry is [string, string] => {
      const [, value] = entry;
      return typeof value === "string";
    }),
  );
  if (Object.keys(parsed).length > 0) {
    state.desired_config_options = parsed;
  }
}

function assignParsedOwnerOptions(state: SessionAcpxState, raw: unknown): void {
  const ownerOptions = normalizeSessionOwnerOptions(raw as SessionAcpxState["owner_options"]);
  if (ownerOptions) {
    state.owner_options = ownerOptions;
  }
}

function assignParsedSessionOptions(state: SessionAcpxState, raw: unknown): void {
  const sessionOptions = asRecord(raw);
  if (!sessionOptions) {
    return;
  }

  const parsedSessionOptions: NonNullable<SessionAcpxState["session_options"]> = {};
  assignSessionOptionModel(parsedSessionOptions, sessionOptions.model);
  assignSessionOptionAllowedTools(parsedSessionOptions, sessionOptions.allowed_tools);
  assignSessionOptionMaxTurns(parsedSessionOptions, sessionOptions.max_turns);
  assignSessionOptionSystemPrompt(parsedSessionOptions, sessionOptions.system_prompt);
  assignSessionOptionSubscription(parsedSessionOptions, sessionOptions.subscription);
  assignSessionOptionProfile(parsedSessionOptions, sessionOptions.profile);
  assignSessionOptionEffort(parsedSessionOptions, sessionOptions.effort);
  assignSessionOptionAutoFailover(parsedSessionOptions, sessionOptions.auto_failover);
  assignSessionOptionFloorHard(parsedSessionOptions, sessionOptions.floor_hard);
  assignSessionOptionSubscriptionSwitch(parsedSessionOptions, sessionOptions.subscription_switch);
  assignSessionOptionAccountSwitch(parsedSessionOptions, sessionOptions.account_switch);
  assignSessionOptionProvisioningWarning(parsedSessionOptions, sessionOptions.provisioning_warning);

  if (Object.keys(parsedSessionOptions).length > 0) {
    state.session_options = parsedSessionOptions;
  }
}

function isValidSubscriptionSwitch(
  record: Record<string, unknown>,
): record is { from?: string; to: string; reason: "manual" | "failover" | "locked"; at: string } {
  return (
    typeof record.to === "string" &&
    record.to.length > 0 &&
    (record.reason === "manual" || record.reason === "failover" || record.reason === "locked") &&
    typeof record.at === "string" &&
    record.at.length > 0
  );
}

function assignSessionOptionSubscriptionSwitch(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  const record = asRecord(value);
  if (!record || !isValidSubscriptionSwitch(record)) {
    return;
  }
  options.subscription_switch = {
    ...(typeof record.from === "string" ? { from: record.from } : {}),
    to: record.to,
    reason: record.reason,
    at: record.at,
  };
}

function nonEmptyStringValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAccountSwitchReason(value: unknown): value is "manual" | "failover" | "locked" {
  return value === "manual" || value === "failover" || value === "locked";
}

function isValidAccountSwitch(record: Record<string, unknown>): record is {
  fromProfile?: string;
  toProfile: string;
  fromAccount?: string;
  toAccount: string;
  effectiveAccount?: string;
  effectiveProfile?: string;
  effectiveAuthMode?: string;
  effectiveAnchor?: string;
  effectiveResolutionMethod?: "path" | "selection";
  reason: "manual" | "failover" | "locked";
  at: string;
} {
  return (
    nonEmptyStringValue(record.toProfile) &&
    nonEmptyStringValue(record.toAccount) &&
    isAccountSwitchReason(record.reason) &&
    nonEmptyStringValue(record.at)
  );
}

type ParsedAccountSwitch = NonNullable<
  NonNullable<SessionAcpxState["session_options"]>["account_switch"]
>;

type ParsedAccountSwitchStringKey = Exclude<
  keyof Omit<ParsedAccountSwitch, "reason" | "at">,
  "effectiveResolutionMethod"
>;

function assignOptionalAccountSwitchString(
  target: Partial<ParsedAccountSwitch>,
  key: ParsedAccountSwitchStringKey,
  value: unknown,
): void {
  if (typeof value === "string") {
    target[key] = value;
  }
}

function accountSwitchMetadata(record: Record<string, unknown>): Partial<ParsedAccountSwitch> {
  const metadata: Partial<ParsedAccountSwitch> = {};
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

function assignSessionOptionAccountSwitch(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  const record = asRecord(value);
  if (!record || !isValidAccountSwitch(record)) {
    return;
  }
  options.account_switch = {
    toProfile: record.toProfile,
    toAccount: record.toAccount,
    ...accountSwitchMetadata(record),
    reason: record.reason,
    at: record.at,
  };
}

function isValidProvisioningWarning(record: Record<string, unknown>): record is {
  at: string;
  profileId?: string;
  authMode?: string;
  adapter?: string;
  anchor?: string;
  message: string;
} {
  return (
    typeof record.at === "string" &&
    record.at.length > 0 &&
    typeof record.message === "string" &&
    record.message.length > 0
  );
}

function assignSessionOptionProvisioningWarning(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  const record = asRecord(value);
  if (!record || !isValidProvisioningWarning(record)) {
    return;
  }
  options.provisioning_warning = {
    at: record.at,
    ...(typeof record.profileId === "string" ? { profileId: record.profileId } : {}),
    ...(typeof record.authMode === "string" ? { authMode: record.authMode } : {}),
    ...(typeof record.adapter === "string" ? { adapter: record.adapter } : {}),
    ...(typeof record.anchor === "string" ? { anchor: record.anchor } : {}),
    message: record.message,
  };
}

function assignSessionOptionModel(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (typeof value === "string") {
    options.model = value;
  }
}

function assignSessionOptionSubscription(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) {
    options.subscription = value;
  }
}

function assignSessionOptionProfile(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) {
    options.profile = value;
  }
}

function assignSessionOptionEffort(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) {
    options.effort = value;
  }
}

function assignSessionOptionAutoFailover(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (typeof value === "boolean") {
    options.auto_failover = value;
  }
}

// brick://07dd62c9: floor_hard is a durable policy flag — it MUST round-trip back
// on a cold disk reload (mirror auto_failover), or every queue-owner delivery /
// owner respawn strips it → floorHardEnabled=false → the airtight quarantine
// silently stops firing.
function assignSessionOptionFloorHard(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (typeof value === "boolean") {
    options.floor_hard = value;
  }
}

function assignSessionOptionAllowedTools(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (isStringArray(value)) {
    options.allowed_tools = [...value];
  }
}

function assignSessionOptionMaxTurns(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    options.max_turns = value;
  }
}

function assignSessionOptionSystemPrompt(
  options: NonNullable<SessionAcpxState["session_options"]>,
  value: unknown,
): void {
  if (typeof value === "string" && value.length > 0) {
    options.system_prompt = value;
    return;
  }

  const appendRecord = asRecord(value);
  if (appendRecord && typeof appendRecord.append === "string" && appendRecord.append.length > 0) {
    options.system_prompt = { append: appendRecord.append };
  }
}

function parseEventLog(raw: unknown, sessionId: string): SessionEventLog {
  const record = asRecord(raw);
  if (!record || !hasValidEventLogCore(record)) {
    return defaultSessionEventLog(sessionId);
  }

  return {
    active_path: record.active_path,
    segment_count: record.segment_count,
    max_segment_bytes: record.max_segment_bytes,
    max_segments: record.max_segments,
    last_write_at: typeof record.last_write_at === "string" ? record.last_write_at : undefined,
    last_write_error:
      record.last_write_error == null || typeof record.last_write_error === "string"
        ? record.last_write_error
        : null,
  };
}

function hasValidEventLogCore(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  active_path: string;
  segment_count: number;
  max_segment_bytes: number;
  max_segments: number;
} {
  return (
    typeof record.active_path === "string" &&
    isPositiveInteger(record.segment_count) &&
    isPositiveInteger(record.max_segment_bytes) &&
    isPositiveInteger(record.max_segments)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseImportedFrom(raw: unknown): SessionRecord["importedFrom"] | null | undefined {
  if (raw == null) {
    return undefined;
  }

  const record = asRecord(raw);
  if (
    !record ||
    typeof record.record_id !== "string" ||
    typeof record.cwd_original !== "string" ||
    typeof record.exported_by !== "string" ||
    typeof record.exported_at !== "string"
  ) {
    return null;
  }

  return {
    recordId: record.record_id,
    cwdOriginal: record.cwd_original,
    exportedBy: record.exported_by,
    exportedAt: record.exported_at,
  };
}

function parseSessionRecordMetadata(record: Record<string, unknown>): {
  lastRequestId: string | undefined;
  importedFrom: SessionRecord["importedFrom"];
} | null {
  const lastRequestId = normalizeOptionalString(record.last_request_id);
  if (lastRequestId === null) {
    return null;
  }

  const importedFrom = parseImportedFrom(record.imported_from);
  if (importedFrom === null) {
    return null;
  }

  return { lastRequestId, importedFrom };
}

function normalizeOptionalName(value: unknown): string | undefined | null {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalPid(value: unknown): number | undefined | null {
  if (value == null) {
    return undefined;
  }

  if (!Number.isInteger(value) || (value as number) <= 0) {
    return null;
  }

  return value as number;
}

// Like normalizeOptionalPid but allows 0 (a fork at message index 0 is valid).
function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined | null {
  if (value == null) {
    return undefined;
  }

  if (!Number.isInteger(value) || (value as number) < 0) {
    return null;
  }

  return value as number;
}

function normalizeOptionalBoolean(value: unknown, fallback = false): boolean | null {
  if (value == null) {
    return fallback;
  }
  return typeof value === "boolean" ? value : null;
}

function normalizeOptionalBooleanField(value: unknown): boolean | undefined | null {
  if (value == null) {
    return undefined;
  }
  return typeof value === "boolean" ? value : null;
}

function normalizeOptionalString(value: unknown): string | undefined | null {
  if (value == null) {
    return undefined;
  }
  return typeof value === "string" ? value : null;
}

function normalizeOptionalExitCode(value: unknown): number | null | undefined | symbol {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (Number.isInteger(value)) {
    return value as number;
  }
  return Symbol("invalid");
}

function normalizeOptionalSignal(value: unknown): NodeJS.Signals | null | undefined | symbol {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value as NodeJS.Signals;
  }
  return Symbol("invalid");
}

function parseSubagentRef(raw: unknown): SubagentRef | null {
  const record = asRecord(raw);
  if (
    !record ||
    typeof record.acpx_record_id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.spawned_at !== "string"
  ) {
    return null;
  }
  return {
    acpxRecordId: record.acpx_record_id,
    name: record.name,
    color: typeof record.color === "string" ? record.color : undefined,
    spawnedAt: record.spawned_at,
    claudeJsonlPath:
      typeof record.claude_jsonl_path === "string" ? record.claude_jsonl_path : undefined,
  };
}

function parseSubagentRefs(raw: unknown): SubagentRef[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const refs: SubagentRef[] = [];
  for (const entry of raw) {
    const ref = parseSubagentRef(entry);
    if (ref === null) {
      return undefined;
    }
    refs.push(ref);
  }
  return refs;
}

function parseMetadata(raw: unknown): Record<string, string> | undefined | null {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof key !== "string" || key.length === 0) {
      return null;
    }
    if (typeof value !== "string") {
      return null;
    }
    parsed[key] = value;
  }
  return parsed;
}

// acpx-ui-owned passthrough. Parsed leniently: a malformed `template` block is
// dropped (returns undefined) rather than rejecting the whole record, since the
// daemon does not author or depend on it — it only round-trips it so it survives
// daemon rewrites and can be projected into the index sidecar.
// eslint-disable-next-line complexity -- flat field-by-field parse of the optional template block; linear, not branchy logic
function parseTemplateState(raw: unknown): SessionRecord["template"] {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const template: NonNullable<SessionRecord["template"]> = {};
  if (typeof record.enabled === "boolean") {
    template.enabled = record.enabled;
  }
  if (typeof record.created_at === "string") {
    template.created_at = record.created_at;
  }
  if (typeof record.source_session_id === "string") {
    template.source_session_id = record.source_session_id;
  }
  if (typeof record.auto_prompt === "string") {
    template.auto_prompt = record.auto_prompt;
  }
  // slug + version (W13-01). MUST be parsed here: the FW-16 read-preserve path
  // re-parses `template` on every plain daemon write, so an unparsed field is
  // silently dropped on the next checkpoint. version is a finite non-negative
  // integer (the monotonic per-slug counter); a malformed value is ignored.
  if (typeof record.slug === "string") {
    template.slug = record.slug;
  }
  if (isNonNegativeInteger(record.version)) {
    template.version = record.version;
  }
  return Object.keys(template).length > 0 ? template : undefined;
}

function parseSessionKind(value: unknown): "session" | "subagent" | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "session" || value === "subagent") {
    return value;
  }
  return null;
}

function parseMessagesLogState(raw: unknown): SessionMessagesLogState | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }

  if (
    record.v !== 1 ||
    !isNonNegativeInteger(record.count) ||
    !isNonNegativeInteger(record.base_index) ||
    !isNonNegativeInteger(record.bytes)
  ) {
    return undefined;
  }

  return {
    v: 1,
    count: record.count,
    base_index: record.base_index,
    bytes: record.bytes,
  };
}

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
export function parseSessionRecord(raw: unknown): SessionRecord | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }

  if (record.schema !== SESSION_RECORD_SCHEMA) {
    return null;
  }

  const name = normalizeOptionalName(record.name);
  const pid = normalizeOptionalPid(record.pid);
  const closed = normalizeOptionalBoolean(record.closed, false);
  const closedAt = normalizeOptionalString(record.closed_at);
  const favorite = normalizeOptionalBooleanField(record.favorite);
  const favoritedAt = normalizeOptionalString(record.favorited_at);
  const agentStartedAt = normalizeOptionalString(record.agent_started_at);
  const lastPromptAt = normalizeOptionalString(record.last_prompt_at);
  const lastAgentExitCode = normalizeOptionalExitCode(record.last_agent_exit_code);
  const lastAgentExitSignal = normalizeOptionalSignal(record.last_agent_exit_signal);
  const lastAgentExitAt = normalizeOptionalString(record.last_agent_exit_at);
  const lastAgentDisconnectReason = normalizeOptionalString(record.last_agent_disconnect_reason);
  const lastAgentUnexpectedDuringPrompt = normalizeOptionalBooleanField(
    record.last_agent_unexpected_during_prompt,
  );

  const kind = parseSessionKind(record.kind);
  if (kind === null) {
    return null;
  }

  // agent_command is required for regular sessions but absent for subagents
  const agentCommandRaw = record.agent_command;
  if (kind !== "subagent" && typeof agentCommandRaw !== "string") {
    return null;
  }
  const agentCommand = typeof agentCommandRaw === "string" ? agentCommandRaw : "";
  const agentName = normalizeOptionalString(record.agent_name);
  if (agentName === null) {
    return null;
  }

  // cwd is required for regular sessions but may be absent for subagents
  const cwdRaw = record.cwd;
  if (kind !== "subagent" && typeof cwdRaw !== "string") {
    return null;
  }
  const cwd = typeof cwdRaw === "string" ? cwdRaw : "";

  if (
    typeof record.acpx_record_id !== "string" ||
    typeof record.acp_session_id !== "string" ||
    typeof record.created_at !== "string" ||
    typeof record.last_used_at !== "string" ||
    typeof record.last_seq !== "number" ||
    !Number.isInteger(record.last_seq) ||
    record.last_seq < 0 ||
    name === null ||
    pid === null ||
    closed === null ||
    closedAt === null ||
    favorite === null ||
    favoritedAt === null ||
    agentStartedAt === null ||
    lastPromptAt === null ||
    typeof lastAgentExitCode === "symbol" ||
    typeof lastAgentExitSignal === "symbol" ||
    lastAgentExitAt === null ||
    lastAgentDisconnectReason === null ||
    lastAgentUnexpectedDuringPrompt === null
  ) {
    return null;
  }

  const conversation = parseConversationRecord(record);
  if (!conversation) {
    return null;
  }

  const eventLog = parseEventLog(record.event_log, record.acpx_record_id);

  // Upstream metadata helper: validates last_request_id and parses imported_from
  // (session export/import feature). Subsumes the fork's standalone lastRequestId check.
  const recordMetadata = parseSessionRecordMetadata(record);
  if (!recordMetadata) {
    return null;
  }

  const parentSessionId = normalizeOptionalString(record.parent_session_id);
  if (parentSessionId === null) {
    return null;
  }

  const forkedFromSessionId = normalizeOptionalString(record.forked_from_session_id);
  if (forkedFromSessionId === null) {
    return null;
  }

  const forkedAtMessageIndex = normalizeOptionalNonNegativeInteger(record.forked_at_message_index);
  if (forkedAtMessageIndex === null) {
    return null;
  }

  const metadata = parseMetadata(record.metadata);
  if (metadata === null) {
    return null;
  }

  return rememberSessionModelBaseline(
    rememberSessionMetadataBaseline({
      schema: SESSION_RECORD_SCHEMA,
      acpxRecordId: record.acpx_record_id,
      acpSessionId: record.acp_session_id,
      agentSessionId: normalizeRuntimeSessionId(record.agent_session_id),
      agentName: agentName ?? undefined,
      agentCommand,
      cwd,
      name,
      createdAt: record.created_at,
      lastUsedAt: record.last_used_at,
      lastSeq: record.last_seq,
      lastRequestId: recordMetadata.lastRequestId,
      eventLog,
      closed,
      closedAt,
      favorite,
      favoritedAt,
      pid,
      agentStartedAt,
      lastPromptAt,
      lastAgentExitCode,
      lastAgentExitSignal: lastAgentExitSignal,
      lastAgentExitAt,
      lastAgentDisconnectReason,
      lastAgentUnexpectedDuringPrompt,
      protocolVersion:
        typeof record.protocol_version === "number" ? record.protocol_version : undefined,
      agentCapabilities: asRecord(record.agent_capabilities) as SessionRecord["agentCapabilities"],
      title: conversation.title,
      messages: conversation.messages,
      messagesLog: parseMessagesLogState(record.messages_log),
      updated_at: conversation.updated_at,
      cumulative_token_usage: conversation.cumulative_token_usage,
      request_token_usage: conversation.request_token_usage,
      acpx: parseAcpxState(record.acpx),
      kind,
      parentSessionId: parentSessionId ?? undefined,
      forkedFromSessionId: forkedFromSessionId ?? undefined,
      forkedAtMessageIndex: forkedAtMessageIndex ?? undefined,
      subagents: parseSubagentRefs(record.subagents),
      metadata,
      importedFrom: recordMetadata.importedFrom,
      template: parseTemplateState(record.template),
    }),
  );
}
