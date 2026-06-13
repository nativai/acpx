import { SessionOwnerRestoreError } from "../errors.js";
import {
  AUTH_POLICIES,
  NON_INTERACTIVE_PERMISSION_POLICIES,
  PERMISSION_MODES,
  type AuthPolicy,
  type NonInteractivePermissionPolicy,
  type PermissionMode,
  type SessionOwnerOptions,
  type SessionRecord,
} from "../types.js";

export type SessionOwnerBehaviorInput = {
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
};

export type ResolveSessionOwnerOptionsParams = {
  permissionModeExplicit?: boolean;
};

const EMPTY_OPTIONAL_OWNER_BEHAVIOR: Omit<SessionOwnerBehaviorInput, "permissionMode"> = {};

export function captureSessionOwnerOptions(input: SessionOwnerBehaviorInput): SessionOwnerOptions {
  const ownerOptions: SessionOwnerOptions = {
    permission_mode: input.permissionMode,
  };
  if (input.nonInteractivePermissions !== undefined) {
    ownerOptions.non_interactive_permissions = input.nonInteractivePermissions;
  }
  if (input.authPolicy !== undefined) {
    ownerOptions.auth_policy = input.authPolicy;
  }
  if (input.terminal !== undefined) {
    ownerOptions.terminal = input.terminal;
  }
  return ownerOptions;
}

export function persistSessionOwnerOptions(
  record: SessionRecord,
  input: SessionOwnerBehaviorInput,
): SessionOwnerOptions {
  const ownerOptions = captureSessionOwnerOptions(input);
  record.acpx = record.acpx
    ? { ...record.acpx, owner_options: ownerOptions }
    : { owner_options: ownerOptions };
  return ownerOptions;
}

export function resolveSessionOwnerOptions(
  record: SessionRecord,
  input: SessionOwnerBehaviorInput,
  params: ResolveSessionOwnerOptionsParams = {},
): SessionOwnerOptions {
  const stored = normalizeSessionOwnerOptions(record.acpx?.owner_options);
  const explicitPermissionMode = params.permissionModeExplicit === true;
  assertRestorableOwnerMode(record, stored, explicitPermissionMode);

  return captureSessionOwnerOptions({
    permissionMode: restoredPermissionMode(stored, input, explicitPermissionMode),
    ...restoreOptionalOwnerBehavior(stored, input),
  });
}

export function ownerOptionsToInput(options: SessionOwnerOptions): SessionOwnerBehaviorInput {
  return {
    permissionMode: options.permission_mode,
    nonInteractivePermissions: options.non_interactive_permissions,
    authPolicy: options.auth_policy,
    terminal: options.terminal,
  };
}

function assertRestorableOwnerMode(
  record: SessionRecord,
  stored: SessionOwnerOptions | undefined,
  explicitPermissionMode: boolean,
): void {
  if (explicitPermissionMode || stored?.permission_mode || !sessionHasAgentMessages(record)) {
    return;
  }
  throw new SessionOwnerRestoreError(
    `Session ${record.acpxRecordId} has agent history but no persisted owner permission_mode; rerun with an explicit permission flag to establish the session owner mode.`,
  );
}

function restoredPermissionMode(
  stored: SessionOwnerOptions | undefined,
  input: SessionOwnerBehaviorInput,
  explicitPermissionMode: boolean,
): PermissionMode {
  if (explicitPermissionMode || !stored?.permission_mode) {
    return input.permissionMode;
  }
  return stored.permission_mode;
}

function restoreOptionalOwnerBehavior(
  stored: SessionOwnerOptions | undefined,
  input: SessionOwnerBehaviorInput,
): Omit<SessionOwnerBehaviorInput, "permissionMode"> {
  const storedInput = stored ? ownerOptionsToInput(stored) : EMPTY_OPTIONAL_OWNER_BEHAVIOR;
  return {
    nonInteractivePermissions: restoreOptionalValue(
      storedInput.nonInteractivePermissions,
      input.nonInteractivePermissions,
    ),
    authPolicy: restoreOptionalValue(storedInput.authPolicy, input.authPolicy),
    terminal: restoreOptionalValue(storedInput.terminal, input.terminal),
  };
}

function restoreOptionalValue<T>(stored: T | undefined, input: T | undefined): T | undefined {
  return stored === undefined ? input : stored;
}

export function normalizeSessionOwnerOptions(
  value: SessionOwnerOptions | undefined,
): SessionOwnerOptions | undefined {
  if (!value || !isPermissionMode(value.permission_mode)) {
    return undefined;
  }

  return captureSessionOwnerOptions({
    permissionMode: value.permission_mode,
    nonInteractivePermissions: isNonInteractivePermissionPolicy(value.non_interactive_permissions)
      ? value.non_interactive_permissions
      : undefined,
    authPolicy: isAuthPolicy(value.auth_policy) ? value.auth_policy : undefined,
    terminal: typeof value.terminal === "boolean" ? value.terminal : undefined,
  });
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

function isNonInteractivePermissionPolicy(value: unknown): value is NonInteractivePermissionPolicy {
  return (
    typeof value === "string" &&
    (NON_INTERACTIVE_PERMISSION_POLICIES as readonly string[]).includes(value)
  );
}

function isAuthPolicy(value: unknown): value is AuthPolicy {
  return typeof value === "string" && (AUTH_POLICIES as readonly string[]).includes(value);
}

function sessionHasAgentMessages(record: Pick<SessionRecord, "messages">): boolean {
  return record.messages.some(
    (message) => typeof message === "object" && message !== null && "Agent" in message,
  );
}
