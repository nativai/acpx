import { isClaudeFamilyAgent } from "../../acp/agent-command.js";
import {
  isSubscriptionProfileLocked,
  loadProfileRegistry,
  transcriptAnchorDir,
  type AccountId,
  type ProfileEntry,
  type ProfileId,
} from "../../config/profiles.js";
import { ensureTranscriptAtConfigDir } from "../../config/subscription-transcript.js";
import type { SubscriptionLookupOptions } from "../../config/subscriptions.js";
import { SubscriptionLockedError } from "../../errors.js";
import { isoNow } from "../../session/persistence/repository.js";
import type { SessionRecord } from "../../types.js";
import { sessionHasRealAgentTurn } from "./lifecycle.js";

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

/**
 * THE WRITER END of the Claude-family gate (CONCEPTION §5.5). Refuses before any
 * work — before the transcript port, before `recordAccountSwitch` — so a
 * non-Claude record can never acquire `session_options.profile` /
 * `session_options.account_switch`. Those two fields are what
 * `ensurePendingSwitchTranscript` (the resume end, `reconnect.ts`) then reads to
 * demand a Claude SDK transcript JSONL that an OpenCode or Pi session can never
 * have — the defect that kills every one of their sessions after turn 1
 * (I1 D1 / I2 §5).
 *
 * ⚠️ This throws rather than no-opping ON PURPOSE. A silent no-op would let
 * `switchSessionAccount` return a `SwitchSessionAccountResult` naming a switch
 * that did not happen — the same class of silent wrong answer this programme
 * exists to end. The automatic callers (`enforceSubscriptionLockBeforeTurn`,
 * `selectSubscriptionBeforeTurn`, reactive failover) never reach it, because
 * `selectedProfileId` in `failover.ts` withholds the default-profile fallback
 * from a non-Claude record; the caller that DOES reach it is the manual
 * `acpx <agent> set profile …`, which should indeed fail loudly.
 */
function assertClaudeFamilySeam(record: SessionRecord): void {
  if (isClaudeFamilyAgent(record.agentCommand)) {
    return;
  }
  throw new AccountSwitchError(
    `session ${record.acpxRecordId} runs agent command "${record.agentCommand}", which is not a ` +
      `Claude-family adapter: profiles and account switching are Claude-family only (its credential ` +
      `is not a Claude account, and it has no Claude transcript to port).`,
  );
}

function recordAccountSwitch(
  record: SessionRecord,
  fromProfile: ProfileEntry,
  toProfile: ProfileEntry,
  reason: "manual" | "failover" | "locked" | "selection",
): void {
  const acpx = record.acpx ?? {};
  const sessionOptions = { ...acpx.session_options };
  sessionOptions.profile = toProfile.id;
  delete sessionOptions.subscription;
  delete sessionOptions.subscription_switch;
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

async function portSwitchTranscript(args: {
  record: SessionRecord;
  toProfile: ProfileEntry;
  srcAnchor: string;
  dstAnchor: string;
  loadOpts?: SubscriptionLookupOptions;
}): Promise<boolean> {
  const acpSessionId = args.record.acpSessionId?.trim();
  if (!acpSessionId) {
    return false;
  }

  const recovery = await ensureTranscriptAtConfigDir(args.record, args.dstAnchor, {
    ...args.loadOpts,
    sourceConfigDirs: [args.srcAnchor],
  });
  // Gate on REAL turns, not raw Agent entries: a breadcrumb-only session never
  // produced a transcript, so there is nothing to port and the switch is safe —
  // the next connect creates the transcript fresh on the target anchor
  // (brick://509b4ee1; previously the guard breadcrumb made proactive selection
  // skip with "missing transcript" on every fresh guard-forced session).
  if (recovery.status === "missing" && sessionHasRealAgentTurn(args.record)) {
    throw new AccountSwitchError(
      `cannot switch session ${args.record.acpSessionId} to profile "${args.toProfile.id}": ${missingTranscriptMessage(recovery)}`,
    );
  }
  return recovery.status === "ported";
}

function missingTranscriptMessage(
  recovery: Awaited<ReturnType<typeof ensureTranscriptAtConfigDir>>,
): string {
  const searched =
    recovery.searchedPaths.length > 0 ? `; searched: ${recovery.searchedPaths.join(", ")}` : "";
  return `missing transcript at ${recovery.activePath}${searched}`;
}

export async function switchSessionAccount(
  record: SessionRecord,
  toProfileId: ProfileId,
  reason: "manual" | "failover" | "locked" | "selection",
  loadOpts?: SubscriptionLookupOptions,
): Promise<SwitchSessionAccountResult> {
  assertClaudeFamilySeam(record);
  const targetId = toProfileId.trim();
  if (!targetId) {
    throw new AccountSwitchError("target profile id is empty");
  }

  const registry = loadProfileRegistry(loadOpts);
  const fromProfile = requireProfile(
    registry.profiles,
    selectedProfileId(record) ?? registry.default,
    "current",
  );
  const toProfile = requireProfile(registry.profiles, targetId, "target");
  if (isSubscriptionProfileLocked(toProfile, registry)) {
    throw new SubscriptionLockedError(toProfile.id);
  }
  if (reason === "failover" || reason === "locked") {
    assertFailoverSibling(fromProfile, toProfile);
  }

  const srcAnchor = requireAnchor(fromProfile, "current");
  const dstAnchor = requireAnchor(toProfile, "target");
  const transcriptCopied = await portSwitchTranscript({
    record,
    toProfile,
    srcAnchor,
    dstAnchor,
    loadOpts,
  });

  recordAccountSwitch(record, fromProfile, toProfile, reason);
  return {
    fromProfile: fromProfile.id,
    toProfile: toProfile.id,
    fromAccount: fromProfile.account,
    toAccount: toProfile.account,
    transcriptCopied,
  };
}
