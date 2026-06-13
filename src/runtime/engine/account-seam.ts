import {
  loadProfileRegistry,
  transcriptAnchorDir,
  type AccountId,
  type ProfileEntry,
  type ProfileId,
} from "../../config/profiles.js";
import { portTranscript } from "../../config/subscription-transcript.js";
import type { SubscriptionLookupOptions } from "../../config/subscriptions.js";
import { isoNow } from "../../session/persistence/repository.js";
import type { SessionRecord } from "../../types.js";

export {
  getResolvedProfile,
  loadResolvedProfiles,
  resolvePhysicalAccount,
  siblingProfiles,
  transcriptAnchorDir,
  verifyEffectiveResolution,
  type EffectiveResolution,
  type ResolvedProfile,
} from "../../config/profiles.js";
export {
  getAccountHealth,
  markAccountDead,
  markSubscriptionDead,
  type AccountHealth,
} from "../../config/known-dead-subscriptions.js";

export class AccountSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountSwitchError";
  }
}

export type SwitchSessionAccountResult = {
  fromProfile?: ProfileId;
  toProfile: ProfileId;
  fromAccount?: AccountId;
  toAccount: AccountId;
  transcriptCopied: boolean;
};

function selectedProfileId(record: SessionRecord): string | undefined {
  const options = record.acpx?.session_options;
  return nonEmptyString(options?.profile) ?? nonEmptyString(options?.subscription);
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireProfile(
  registryProfiles: readonly ProfileEntry[],
  id: string | undefined,
  label: string,
): ProfileEntry {
  if (!id) {
    throw new AccountSwitchError(`${label} profile is not selected`);
  }
  const profile = registryProfiles.find((entry) => entry.id === id);
  if (!profile) {
    throw new AccountSwitchError(`${label} profile "${id}" not found in registry`);
  }
  return profile;
}

function assertFailoverSibling(from: ProfileEntry, to: ProfileEntry): void {
  if (from.authMode !== to.authMode || from.account === to.account) {
    throw new AccountSwitchError(
      `target profile "${to.id}" is not an account sibling of "${from.id}"`,
    );
  }
}

function requireAnchor(profile: ProfileEntry, role: string): string {
  const anchor = transcriptAnchorDir(profile);
  if (anchor === null) {
    throw new AccountSwitchError(
      `${role} profile "${profile.id}" has no transcript anchor; account switch is not portable`,
    );
  }
  return anchor;
}

function recordAccountSwitch(
  record: SessionRecord,
  fromProfile: ProfileEntry,
  toProfile: ProfileEntry,
  reason: "manual" | "failover",
): void {
  const acpx = record.acpx ?? {};
  const sessionOptions = { ...acpx.session_options };
  sessionOptions.profile = toProfile.id;
  delete sessionOptions.subscription;
  sessionOptions.account_switch = {
    fromProfile: fromProfile.id,
    toProfile: toProfile.id,
    fromAccount: fromProfile.account,
    toAccount: toProfile.account,
    reason,
    at: isoNow(),
  };
  record.acpx = { ...acpx, session_options: sessionOptions };
}

export async function switchSessionAccount(
  record: SessionRecord,
  toProfileId: ProfileId,
  reason: "manual" | "failover",
  loadOpts?: SubscriptionLookupOptions,
): Promise<SwitchSessionAccountResult> {
  const targetId = toProfileId.trim();
  if (!targetId) {
    throw new AccountSwitchError("target profile id is empty");
  }

  const registry = loadProfileRegistry(loadOpts);
  const fromProfile = requireProfile(registry.profiles, selectedProfileId(record), "current");
  const toProfile = requireProfile(registry.profiles, targetId, "target");
  if (reason === "failover") {
    assertFailoverSibling(fromProfile, toProfile);
  }

  const srcAnchor = requireAnchor(fromProfile, "current");
  const dstAnchor = requireAnchor(toProfile, "target");
  let transcriptCopied = false;
  const acpSessionId = record.acpSessionId?.trim();
  if (acpSessionId) {
    const result = await portTranscript({
      srcConfigDir: srcAnchor,
      dstConfigDir: dstAnchor,
      cwd: record.cwd,
      acpSessionId,
    });
    transcriptCopied = result.copied;
  }

  recordAccountSwitch(record, fromProfile, toProfile, reason);
  return {
    fromProfile: fromProfile.id,
    toProfile: toProfile.id,
    fromAccount: fromProfile.account,
    toAccount: toProfile.account,
    transcriptCopied,
  };
}
