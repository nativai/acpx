import {
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import { PermissionPromptUnavailableError } from "./errors.js";
import { promptForPermission } from "./permission-prompt.js";
import type {
  AcpPermissionDecision,
  NonInteractivePermissionPolicy,
  PermissionEscalationEvent,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyAction,
} from "./types.js";

type PermissionDecision = "approved" | "denied" | "cancelled";
type PermissionPolicyMatch = {
  action: PermissionPolicyAction;
  matchedRule?: string;
};
export type ResolvedPermissionRequest = {
  response: RequestPermissionResponse;
  escalation?: PermissionEscalationEvent;
};
const PERMISSION_MODE_RANK: Record<PermissionMode, number> = {
  "deny-all": 0,
  "approve-reads": 1,
  "approve-all": 2,
};

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

function cancelled(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function withEscalationMetadata(
  response: RequestPermissionResponse,
  event: PermissionEscalationEvent,
): RequestPermissionResponse {
  return {
    ...response,
    _meta: {
      ...response._meta,
      acpx: {
        ...(response._meta?.acpx &&
        typeof response._meta.acpx === "object" &&
        !Array.isArray(response._meta.acpx)
          ? response._meta.acpx
          : {}),
        permissionEscalation: event,
      },
    },
  };
}

function pickOption(
  options: PermissionOption[],
  kinds: PermissionOption["kind"][],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match;
    }
  }
  return undefined;
}

export function inferToolKind(params: RequestPermissionRequest): ToolKind | undefined {
  if (params.toolCall.kind) {
    return params.toolCall.kind;
  }

  const title = params.toolCall.title?.trim().toLowerCase();
  if (!title) {
    return undefined;
  }

  const head = title.split(":", 1)[0]?.trim();
  if (!head) {
    return undefined;
  }

  if (head.includes("read") || head.includes("cat")) {
    return "read";
  }
  if (head.includes("search") || head.includes("find") || head.includes("grep")) {
    return "search";
  }
  if (head.includes("write") || head.includes("edit") || head.includes("patch")) {
    return "edit";
  }
  if (head.includes("delete") || head.includes("remove")) {
    return "delete";
  }
  if (head.includes("move") || head.includes("rename")) {
    return "move";
  }
  if (head.includes("run") || head.includes("execute") || head.includes("bash")) {
    return "execute";
  }
  if (head.includes("fetch") || head.includes("http") || head.includes("url")) {
    return "fetch";
  }
  if (head.includes("think")) {
    return "think";
  }

  return "other";
}

function isAutoApprovedReadKind(kind: ToolKind | undefined): boolean {
  return kind === "read" || kind === "search";
}

async function promptForToolPermission(params: RequestPermissionRequest): Promise<boolean> {
  const toolName = params.toolCall.title ?? "tool";
  const toolKind = inferToolKind(params) ?? "other";
  return await promptForPermission({
    prompt: `\n[permission] Allow ${toolName} [${toolKind}]? (y/N) `,
  });
}

function canPromptForPermission(): boolean {
  return process.stdin.isTTY && process.stderr.isTTY;
}

function readStringProperty(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const entry = record[key];
    if (typeof entry === "string" && entry.trim().length > 0) {
      return entry.trim();
    }
  }
  return undefined;
}

function readToolName(params: RequestPermissionRequest): string | undefined {
  const rawInputName = readStringProperty(params.toolCall.rawInput, ["name", "tool", "toolName"]);
  if (rawInputName) {
    return rawInputName;
  }

  const title = params.toolCall.title?.trim();
  const head = title?.split(/[:\s]/, 1)[0]?.trim();
  return head && head.length > 0 ? head : undefined;
}

function normalizeMatcher(value: string): string {
  return value.trim().toLowerCase();
}

function permissionMatchTokens(params: RequestPermissionRequest): string[] {
  const tokens = new Set<string>();
  const kind = inferToolKind(params);
  const rawKind = params.toolCall.kind;
  const title = params.toolCall.title?.trim();
  const toolName = readToolName(params);

  for (const value of [kind, rawKind, title, toolName]) {
    if (typeof value === "string" && value.trim().length > 0) {
      tokens.add(normalizeMatcher(value));
    }
  }

  if (title) {
    const head = title.split(/[:\s]/, 1)[0]?.trim();
    if (head) {
      tokens.add(normalizeMatcher(head));
    }
  }

  return [...tokens];
}

function findPolicyRule(
  rules: string[] | undefined,
  params: RequestPermissionRequest,
): string | undefined {
  if (!rules || rules.length === 0) {
    return undefined;
  }

  const tokens = permissionMatchTokens(params);
  for (const rule of rules) {
    const normalized = normalizeMatcher(rule);
    if (normalized === "*" || tokens.includes(normalized)) {
      return rule;
    }
  }
  return undefined;
}

function matchPermissionPolicy(
  params: RequestPermissionRequest,
  policy: PermissionPolicy | undefined,
): PermissionPolicyMatch | undefined {
  if (!policy) {
    return undefined;
  }

  const denyRule = findPolicyRule(policy.autoDeny, params);
  if (denyRule) {
    return { action: "deny", matchedRule: denyRule };
  }

  const approveRule = findPolicyRule(policy.autoApprove, params);
  if (approveRule) {
    return { action: "approve", matchedRule: approveRule };
  }

  const escalateRule = findPolicyRule(policy.escalate, params);
  if (escalateRule) {
    return { action: "escalate", matchedRule: escalateRule };
  }

  return policy.defaultAction ? { action: policy.defaultAction } : undefined;
}

function buildEscalationEvent(
  params: RequestPermissionRequest,
  matchedRule: string | undefined,
): PermissionEscalationEvent {
  const toolKind = inferToolKind(params);
  const toolTitle = params.toolCall.title?.trim() || "tool";
  const toolName = readToolName(params);
  return {
    type: "permission_escalation",
    sessionId: params.sessionId,
    toolCallId: params.toolCall.toolCallId,
    ...(toolName ? { toolName } : {}),
    toolTitle,
    ...(params.toolCall.rawInput !== undefined ? { toolInput: params.toolCall.rawInput } : {}),
    ...(toolKind ? { toolKind } : {}),
    action: "escalate",
    ...(matchedRule ? { matchedRule } : {}),
    message: `Permission escalation required for ${toolTitle}`,
    timestamp: new Date().toISOString(),
  };
}

export function permissionModeSatisfies(actual: PermissionMode, required: PermissionMode): boolean {
  return PERMISSION_MODE_RANK[actual] >= PERMISSION_MODE_RANK[required];
}

export async function resolvePermissionRequest(
  params: RequestPermissionRequest,
  mode: PermissionMode,
  nonInteractivePolicy: NonInteractivePermissionPolicy = "deny",
  policy?: PermissionPolicy,
): Promise<RequestPermissionResponse> {
  const result = await resolvePermissionRequestWithDetails(
    params,
    mode,
    nonInteractivePolicy,
    policy,
  );
  return result.response;
}

export async function resolvePermissionRequestWithDetails(
  params: RequestPermissionRequest,
  mode: PermissionMode,
  nonInteractivePolicy: NonInteractivePermissionPolicy = "deny",
  policy?: PermissionPolicy,
): Promise<ResolvedPermissionRequest> {
  const options = params.options ?? [];
  if (options.length === 0) {
    return { response: cancelled() };
  }

  const allowOption = pickOption(options, ["allow_once", "allow_always"]);
  const rejectOption = pickOption(options, ["reject_once", "reject_always"]);
  const policyMatch = matchPermissionPolicy(params, policy);

  if (policyMatch?.action === "approve") {
    if (allowOption) {
      return { response: selected(allowOption.optionId) };
    }
    return { response: selected(options[0].optionId) };
  }

  if (policyMatch?.action === "deny") {
    if (rejectOption) {
      return { response: selected(rejectOption.optionId) };
    }
    return { response: cancelled() };
  }

  if (policyMatch?.action === "escalate") {
    if (canPromptForPermission()) {
      const approved = await promptForToolPermission(params);
      if (approved && allowOption) {
        return { response: selected(allowOption.optionId) };
      }
      if (!approved && rejectOption) {
        return { response: selected(rejectOption.optionId) };
      }
      return { response: cancelled() };
    }

    const escalation = buildEscalationEvent(params, policyMatch.matchedRule);
    const response = rejectOption ? selected(rejectOption.optionId) : cancelled();
    return {
      response: withEscalationMetadata(response, escalation),
      escalation,
    };
  }

  if (mode === "approve-all") {
    if (allowOption) {
      return { response: selected(allowOption.optionId) };
    }
    return { response: selected(options[0].optionId) };
  }

  if (mode === "deny-all") {
    if (rejectOption) {
      return { response: selected(rejectOption.optionId) };
    }
    return { response: cancelled() };
  }

  const kind = inferToolKind(params);
  if (isAutoApprovedReadKind(kind) && allowOption) {
    return { response: selected(allowOption.optionId) };
  }

  if (!canPromptForPermission()) {
    if (nonInteractivePolicy === "fail") {
      throw new PermissionPromptUnavailableError();
    }
    if (rejectOption) {
      return { response: selected(rejectOption.optionId) };
    }
    return { response: cancelled() };
  }

  const approved = await promptForToolPermission(params);
  if (approved && allowOption) {
    return { response: selected(allowOption.optionId) };
  }
  if (!approved && rejectOption) {
    return { response: selected(rejectOption.optionId) };
  }
  return { response: cancelled() };
}

const DECISION_FALLBACK_ORDER: Record<
  Exclude<AcpPermissionDecision["outcome"], "cancel">,
  PermissionOption["kind"][]
> = {
  allow_once: ["allow_once", "allow_always"],
  allow_always: ["allow_always", "allow_once"],
  reject_once: ["reject_once", "reject_always"],
  reject_always: ["reject_always", "reject_once"],
};

export function decisionToResponse(
  params: RequestPermissionRequest,
  decision: AcpPermissionDecision,
): RequestPermissionResponse {
  if (decision.outcome === "cancel") {
    return cancelled();
  }
  const matched = pickOption(params.options ?? [], DECISION_FALLBACK_ORDER[decision.outcome]);
  return matched ? selected(matched.optionId) : cancelled();
}

export function classifyPermissionDecision(
  params: RequestPermissionRequest,
  response: RequestPermissionResponse,
): PermissionDecision {
  if (response.outcome.outcome !== "selected") {
    return "cancelled";
  }

  const selectedOptionId = response.outcome.optionId;
  const selectedOption = params.options.find((option) => option.optionId === selectedOptionId);

  if (!selectedOption) {
    return "cancelled";
  }

  if (selectedOption.kind === "allow_once" || selectedOption.kind === "allow_always") {
    return "approved";
  }

  return "denied";
}
