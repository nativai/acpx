import {
  AuthPolicyError,
  PermissionDeniedError,
  PermissionPromptUnavailableError,
} from "../errors.js";
import {
  EXIT_CODES,
  OUTPUT_ERROR_CODES,
  OUTPUT_ERROR_ORIGINS,
  type ExitCode,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
} from "../types.js";
import type { EffectiveAccountMetadata } from "./auth-env.js";
import {
  extractAcpError,
  extractAcpErrorDetails,
  formatAcpErrorMessage,
  formatUnknownErrorMessage,
  isAcpResourceNotFoundError,
} from "./error-shapes.js";

const AUTH_REQUIRED_ACP_CODES = new Set([-32000]);
const QUERY_CLOSED_BEFORE_RESPONSE_DETAIL = "query closed before response received";

type ErrorMeta = {
  outputCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
  effectiveAccount?: EffectiveAccountMetadata;
};

export type NormalizedOutputError = {
  code: OutputErrorCode;
  message: string;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
  effectiveAccount?: EffectiveAccountMetadata;
};

export type NormalizeOutputErrorOptions = {
  defaultCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
  effectiveAccount?: EffectiveAccountMetadata;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isAuthRequiredMessage(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return [
    "auth required",
    "authentication required",
    "authorization required",
    "credential required",
    "credentials required",
    "token required",
    "login required",
  ].some((needle) => normalized.includes(needle));
}

function isAcpAuthRequiredPayload(acp: OutputErrorAcpPayload | undefined): boolean {
  if (!acp) {
    return false;
  }
  if (!AUTH_REQUIRED_ACP_CODES.has(acp.code)) {
    return false;
  }
  if (isAuthRequiredMessage(acp.message)) {
    return true;
  }

  const data = asRecord(acp.data);
  if (!data) {
    return false;
  }

  return hasAuthRequiredData(data);
}

function hasAuthRequiredData(data: Record<string, unknown>): boolean {
  return (
    data.authRequired === true || hasNonEmptyString(data.methodId) || hasNonEmptyArray(data.methods)
  );
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function trimString(value: unknown): string | undefined {
  return hasNonEmptyString(value) ? value.trim() : undefined;
}

export function effectiveAccountMetadataFromValue(
  value: unknown,
): EffectiveAccountMetadata | undefined {
  const record = asRecord(value);
  if (!record) {
    const effectiveAccount = trimString(value);
    return effectiveAccount ? { effectiveAccount } : undefined;
  }

  const effectiveAccount = trimString(record.effectiveAccount);
  if (!effectiveAccount) {
    return undefined;
  }
  return effectiveAccountMetadataFromRecord(record, effectiveAccount);
}

function assignMetadataString(
  target: Partial<EffectiveAccountMetadata>,
  key: keyof Omit<EffectiveAccountMetadata, "effectiveAccount" | "effectiveResolutionMethod">,
  value: unknown,
): void {
  const trimmed = trimString(value);
  if (trimmed !== undefined) {
    target[key] = trimmed;
  }
}

function effectiveAccountMetadataFromRecord(
  record: Record<string, unknown>,
  effectiveAccount: string,
): EffectiveAccountMetadata {
  const metadata: EffectiveAccountMetadata = { effectiveAccount };
  const effectiveResolutionMethod =
    record.effectiveResolutionMethod === "path" || record.effectiveResolutionMethod === "selection"
      ? record.effectiveResolutionMethod
      : undefined;
  assignMetadataString(metadata, "effectiveProfile", record.effectiveProfile);
  assignMetadataString(metadata, "effectiveAdapter", record.effectiveAdapter);
  assignMetadataString(metadata, "effectiveAuthMode", record.effectiveAuthMode);
  assignMetadataString(metadata, "effectiveAnchor", record.effectiveAnchor);
  if (effectiveResolutionMethod !== undefined) {
    metadata.effectiveResolutionMethod = effectiveResolutionMethod;
  }
  return metadata;
}

function hasNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function isOutputErrorCode(value: unknown): value is OutputErrorCode {
  return typeof value === "string" && OUTPUT_ERROR_CODES.includes(value as OutputErrorCode);
}

function isOutputErrorOrigin(value: unknown): value is OutputErrorOrigin {
  return typeof value === "string" && OUTPUT_ERROR_ORIGINS.includes(value as OutputErrorOrigin);
}

function readOutputErrorMeta(error: unknown): ErrorMeta {
  const record = asRecord(error);
  if (!record) {
    return {};
  }

  const outputCode = isOutputErrorCode(record.outputCode) ? record.outputCode : undefined;
  const detailCode =
    typeof record.detailCode === "string" && record.detailCode.trim().length > 0
      ? record.detailCode
      : undefined;
  const origin = isOutputErrorOrigin(record.origin) ? record.origin : undefined;
  const retryable = typeof record.retryable === "boolean" ? record.retryable : undefined;
  const effectiveAccount = effectiveAccountMetadataFromValue(
    record.effectiveAccountMetadata ?? record.effectiveAccount,
  );

  const acp = extractAcpError(record.acp);
  return {
    outputCode,
    detailCode,
    origin,
    retryable,
    acp,
    effectiveAccount,
  };
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function isNoSessionLike(error: unknown): boolean {
  return error instanceof Error && error.name === "NoSessionError";
}

function isUsageLike(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "CommanderError" ||
    error.name === "InvalidArgumentError" ||
    asRecord(error)?.code === "commander.invalidArgument"
  );
}

export function formatErrorMessage(error: unknown): string {
  return formatUnknownErrorMessage(error);
}

export {
  extractAcpError,
  extractAcpErrorDetails,
  formatAcpErrorMessage,
  isAcpResourceNotFoundError,
};

export function isAcpQueryClosedBeforeResponseError(error: unknown): boolean {
  const acp = extractAcpError(error);
  if (!acp || acp.code !== -32603) {
    return false;
  }

  const data = asRecord(acp.data);
  const details = data?.details;
  if (typeof details !== "string") {
    return false;
  }

  return details.toLowerCase().includes(QUERY_CLOSED_BEFORE_RESPONSE_DETAIL);
}

function mapErrorCode(error: unknown): OutputErrorCode | undefined {
  if (error instanceof PermissionPromptUnavailableError) {
    return "PERMISSION_PROMPT_UNAVAILABLE";
  }
  if (error instanceof PermissionDeniedError) {
    return "PERMISSION_DENIED";
  }
  if (isTimeoutLike(error)) {
    return "TIMEOUT";
  }
  if (isNoSessionLike(error) || isAcpResourceNotFoundError(error)) {
    return "NO_SESSION";
  }
  if (isUsageLike(error)) {
    return "USAGE";
  }
  return undefined;
}

export function normalizeOutputError(
  error: unknown,
  options: NormalizeOutputErrorOptions = {},
): NormalizedOutputError {
  const meta = readOutputErrorMeta(error);
  const code = resolveOutputErrorCode(error, options, meta);
  const acp = options.acp ?? meta.acp ?? extractAcpError(error);
  return {
    code,
    message: formatErrorMessage(error),
    detailCode: resolveDetailCode(error, acp, options, meta),
    origin: meta.origin ?? options.origin,
    retryable: meta.retryable ?? options.retryable,
    acp,
    effectiveAccount: meta.effectiveAccount ?? options.effectiveAccount,
  };
}

function resolveOutputErrorCode(
  error: unknown,
  options: NormalizeOutputErrorOptions,
  meta: ErrorMeta,
): OutputErrorCode {
  const code = meta.outputCode ?? mapErrorCode(error) ?? options.defaultCode ?? "RUNTIME";
  if (code === "RUNTIME" && isAcpResourceNotFoundError(error)) {
    return "NO_SESSION";
  }
  return code;
}

function resolveDetailCode(
  error: unknown,
  acp: OutputErrorAcpPayload | undefined,
  options: NormalizeOutputErrorOptions,
  meta: ErrorMeta,
): string | undefined {
  return (
    meta.detailCode ??
    options.detailCode ??
    (error instanceof AuthPolicyError || isAcpAuthRequiredPayload(acp)
      ? "AUTH_REQUIRED"
      : undefined)
  );
}

// errorKind values (supplied by the adapter as data.errorKind) that mean the
// adapter already forwarded the prompt to the Claude API and Claude rejected it.
// These are the same values as FAILOVER_ERROR_KINDS in runtime/engine/failover.ts —
// kept in sync manually here to avoid a layering violation (acp/ ← runtime/engine/).
const POST_DELIVERY_ERROR_KINDS = new Set(["rate_limit", "authentication_failed", "billing_error"]);

/**
 * Returns true when an ACP error indicates the adapter already received and
 * processed the prompt before the error occurred (i.e. the user message is
 * already in the conversation). Retrying would produce a duplicate.
 *
 * Covers:
 * - Machine-readable `data.errorKind` from the adapter.
 * - Text patterns for weekly / rate-limit / quota / 429 responses that may
 *   arrive without errorKind (belt-and-suspenders fallback).
 */
export function isPostDeliveryAcpError(acp: OutputErrorAcpPayload): boolean {
  const data = asRecord(acp.data);
  const kind = data?.errorKind;
  if (typeof kind === "string" && POST_DELIVERY_ERROR_KINDS.has(kind)) {
    return true;
  }
  const lower = acp.message.toLowerCase();
  return (
    /\b429\b/u.test(acp.message) ||
    ["rate limit", "quota exceeded", "usage limit", "weekly limit", "session limit"].some((s) =>
      lower.includes(s),
    )
  );
}

/**
 * Returns true when an error from `client.prompt()` looks transient and
 * can reasonably be retried (e.g. model-API 400/500, network hiccups that
 * surface as ACP internal errors).
 *
 * Errors that are definitively non-recoverable (auth, missing session,
 * invalid params, timeout, permission) return false.
 */
export function isRetryablePromptError(error: unknown): boolean {
  if (isNonRetryablePromptError(error)) {
    return false;
  }

  // Extract ACP payload once and reuse for all subsequent checks.
  const acp = extractAcpError(error);
  if (!acp) {
    // Non-ACP errors (e.g. process crash) are not retried at the prompt level.
    return false;
  }

  if (isPermanentPromptAcpError(acp)) {
    return false;
  }

  // ACP internal errors (-32603) and parse errors (-32700) are retryable when
  // they represent transient pre-delivery failures. But if the adapter already
  // received and forwarded the prompt (post-delivery error), retrying re-sends
  // the same prompt → duplicate user message in the conversation.
  if (acp.code === -32603 || acp.code === -32700) {
    return !isPostDeliveryAcpError(acp);
  }

  return false;
}

function isNonRetryablePromptError(error: unknown): boolean {
  return (
    error instanceof PermissionDeniedError ||
    error instanceof PermissionPromptUnavailableError ||
    isTimeoutLike(error) ||
    isNoSessionLike(error) ||
    isUsageLike(error)
  );
}

function isPermanentPromptAcpError(acp: OutputErrorAcpPayload): boolean {
  return (
    acp.code === -32001 ||
    acp.code === -32002 ||
    acp.code === -32601 ||
    acp.code === -32602 ||
    isAcpAuthRequiredPayload(acp)
  );
}

export function exitCodeForOutputErrorCode(code: OutputErrorCode): ExitCode {
  switch (code) {
    case "USAGE":
      return EXIT_CODES.USAGE;
    case "TIMEOUT":
      return EXIT_CODES.TIMEOUT;
    case "NO_SESSION":
      return EXIT_CODES.NO_SESSION;
    case "PERMISSION_DENIED":
    case "PERMISSION_PROMPT_UNAVAILABLE":
      return EXIT_CODES.PERMISSION_DENIED;
    case "RUNTIME":
    default:
      return EXIT_CODES.ERROR;
  }
}
