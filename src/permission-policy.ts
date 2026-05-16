import fs from "node:fs/promises";
import path from "node:path";
import {
  PERMISSION_POLICY_ACTIONS,
  type PermissionPolicy,
  type PermissionPolicyAction,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseRuleList(value: unknown, key: string, source: string): string[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${source}: permission policy ${key} must be an array of strings`);
  }

  const parsed = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${source}: permission policy ${key} must contain only non-empty strings`);
    }
    return entry.trim();
  });

  return parsed;
}

export function parsePermissionPolicy(
  value: unknown,
  source = "permission policy",
): PermissionPolicy {
  const record = asRecord(value);
  if (!record) {
    throw new Error(`${source}: permission policy must be a JSON object`);
  }

  const defaultAction = record.defaultAction;
  if (
    defaultAction != null &&
    (typeof defaultAction !== "string" ||
      !PERMISSION_POLICY_ACTIONS.includes(defaultAction as PermissionPolicyAction))
  ) {
    throw new Error(
      `${source}: permission policy defaultAction must be one of ${PERMISSION_POLICY_ACTIONS.join(", ")}`,
    );
  }

  const policy: PermissionPolicy = {};
  const autoApprove = parseRuleList(record.autoApprove, "autoApprove", source);
  const autoDeny = parseRuleList(record.autoDeny, "autoDeny", source);
  const escalate = parseRuleList(record.escalate, "escalate", source);

  if (autoApprove) {
    policy.autoApprove = autoApprove;
  }
  if (autoDeny) {
    policy.autoDeny = autoDeny;
  }
  if (escalate) {
    policy.escalate = escalate;
  }
  if (typeof defaultAction === "string") {
    policy.defaultAction = defaultAction as PermissionPolicy["defaultAction"];
  }

  return policy;
}

export async function loadPermissionPolicySpec(
  spec: string | undefined,
  cwd: string,
): Promise<PermissionPolicy | undefined> {
  const trimmed = spec?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("{")) {
    return parsePermissionPolicy(JSON.parse(trimmed), "--permission-policy");
  }

  const policyPath = path.resolve(cwd, trimmed);
  const raw = await fs.readFile(policyPath, "utf8");
  return parsePermissionPolicy(JSON.parse(raw), policyPath);
}
