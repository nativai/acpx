import os from "node:os";
import path from "node:path";
import { ensureTranscriptAtConfigDir } from "../../config/subscription-transcript.js";
import {
  chooseSubscriptionConfigDir,
  findSubscription,
  isSubscriptionLocked,
  loadSubscriptionRegistry,
  subscriptionConfigDirExists,
  type SubscriptionLookupOptions,
  type SubscriptionRegistry,
} from "../../config/subscriptions.js";
import { SubscriptionLockedError } from "../../errors.js";
import { isoNow } from "../../session/persistence/repository.js";
import type { SessionRecord } from "../../types.js";
import { sessionHasAgentMessages } from "./lifecycle.js";

// The switch primitive: change a session's active Claude subscription IN PLACE,
// reused by both the manual `set subscription` CLI and auto-failover. PURE record
// + fs — it does NOT touch the live client. The respawn (close+reopen, which
// re-resolves CLAUDE_CONFIG_DIR from the now-updated record) is the caller's job:
// the failover retry (manager.ts) for `reason:"failover"`, the queue-owner
// close+reopen (or next cold spawn) for `reason:"manual"`.
//
// Continuity (CONCEPTION §0): before the caller respawns, this copies the
// transcript JSONL into the target account's projects/ tree so the close+reopen
// resumes WITH context instead of hitting the empty-account trap.

export class SubscriptionSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionSwitchError";
  }
}

export type SwitchSessionSubscriptionResult = {
  from?: string;
  to: string;
  /** True when a transcript JSONL was copied src→dst (false for a fresh session). */
  transcriptCopied: boolean;
};

/**
 * Resolve the CLAUDE_CONFIG_DIR that a session is CURRENTLY served from (the
 * source for transcript portability): the explicitly-selected sub's dir, else
 * the registry default's dir, else the raw global ~/.claude. Mirrors
 * auth-env.ts's applySubscriptionConfigDir resolution.
 */
function resolveCurrentConfigDir(record: SessionRecord, registry: SubscriptionRegistry): string {
  const explicit = record.acpx?.session_options?.subscription?.trim();
  const choice = chooseSubscriptionConfigDir(
    explicit && explicit.length > 0 ? explicit : undefined,
    registry,
    subscriptionConfigDirExists,
  );
  return choice.configDir ?? path.join(os.homedir(), ".claude");
}

/**
 * Validate a target id against the registry and return its configDir. Throws a
 * SubscriptionSwitchError (not registered / dir missing) so the caller surfaces
 * a clear message rather than a silent mis-resolve.
 */
function resolveTargetConfigDir(targetSubId: string, registry: SubscriptionRegistry): string {
  const target = findSubscription(targetSubId, registry);
  if (!target) {
    throw new SubscriptionSwitchError(`subscription "${targetSubId}" not found in registry`);
  }
  if (isSubscriptionLocked(target, registry)) {
    throw new SubscriptionLockedError(targetSubId);
  }
  if (!subscriptionConfigDirExists(target.configDir)) {
    throw new SubscriptionSwitchError(
      `subscription "${targetSubId}" configDir not found at ${target.configDir}`,
    );
  }
  return target.configDir;
}

/**
 * Apply the new selection + the switch breadcrumb onto the record (pure edit;
 * mirrors the set-metadata record edit in command-handlers.ts). The caller
 * persists via writeSessionRecord and triggers the respawn.
 */
function recordSwitch(
  record: SessionRecord,
  from: string | undefined,
  to: string,
  reason: "manual" | "failover" | "locked" | "selection",
): void {
  const acpx = record.acpx ?? {};
  const sessionOptions = { ...acpx.session_options };
  sessionOptions.subscription = to;
  sessionOptions.subscription_switch = {
    ...(from !== undefined ? { from } : {}),
    to,
    reason,
    at: isoNow(),
  };
  record.acpx = { ...acpx, session_options: sessionOptions };
}

export async function switchSessionSubscription(args: {
  record: SessionRecord;
  targetSubId: string;
  reason: "manual" | "failover" | "locked" | "selection";
  loadOpts?: SubscriptionLookupOptions;
}): Promise<SwitchSessionSubscriptionResult> {
  const targetSubId = args.targetSubId.trim();
  if (!targetSubId) {
    throw new SubscriptionSwitchError("target subscription id is empty");
  }

  const registry = loadSubscriptionRegistry(args.loadOpts);
  const dstConfigDir = resolveTargetConfigDir(targetSubId, registry);
  const from = args.record.acpx?.session_options?.subscription?.trim() || undefined;

  const transcriptCopied = await portSwitchTranscript({
    record: args.record,
    targetSubId,
    dstConfigDir,
    registry,
    loadOpts: args.loadOpts,
  });

  recordSwitch(args.record, from, targetSubId, args.reason);

  return { from, to: targetSubId, transcriptCopied };
}

async function portSwitchTranscript(args: {
  record: SessionRecord;
  targetSubId: string;
  dstConfigDir: string;
  registry: SubscriptionRegistry;
  loadOpts?: SubscriptionLookupOptions;
}): Promise<boolean> {
  // Port the transcript so the respawn resumes with context (no-op for a fresh
  // session that never ran a turn -- no acpSessionId / no source JSONL).
  const acpSessionId = args.record.acpSessionId?.trim();
  if (!acpSessionId) {
    return false;
  }

  const recovery = await ensureTranscriptAtConfigDir(args.record, args.dstConfigDir, {
    ...args.loadOpts,
    registry: args.registry,
    sourceConfigDirs: [resolveCurrentConfigDir(args.record, args.registry)],
  });
  if (recovery.status === "missing" && sessionHasAgentMessages(args.record)) {
    throw new SubscriptionSwitchError(
      `cannot switch session ${args.record.acpSessionId} to subscription "${args.targetSubId}": ${missingTranscriptMessage(recovery)}`,
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
