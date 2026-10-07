/**
 * `acpx context` — how full is this session's context, where does its alarm ring, and where
 * does its harness auto-compact (brick 4f3fa88c, Daniel's item D). `--alarm <n|0|default>`
 * sets the SEAT's level: a successor in the seat inherits it; `0` turns the alarm off;
 * `default` restores 90.
 *
 * With no address it reads the CALLER's own session (`$ACPX_SESSION_URL`), so an agent asked
 * "how full is your context?" needs no id.
 */
import { Command } from "commander";
import {
  contextFillFromState,
  readSeatContextAlarmLevel,
} from "../session/context-alarm-detector.js";
import {
  type ContextAlarm,
  type ContextFill,
  contextUsedPct,
  formatContextLine,
  parseContextAlarmArgument,
  pastCompactionWarning,
  resolveContextAlarm,
} from "../session/context-alarm.js";
import { sessionBaseDir } from "../session/persistence/repository.js";
import { setSeatContextAlarm } from "../session/persistence/seat-store.js";
import type { SessionRecord } from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";
import {
  addSeatSelectorOption,
  addSessionNameOption,
  resolveGlobalFlags,
  type StatusFlags,
} from "./flags.js";
import { emitJsonResult } from "./output/json-output.js";
import {
  NoSessionError,
  parseSessionIdFromUrl,
  requireExplicitSessionRecord,
  resolveSessionTargetSelector,
  type SessionTargetSelector,
} from "./session-selector.js";

type ContextFlags = StatusFlags & { alarm?: string };

export type SessionContextReport = {
  readonly fill: ContextFill;
  readonly alarm: ContextAlarm;
};

/** The session's fill as last reported, and its seat's alarm. Unknown ⇒ 0 / 0. */
export async function readSessionContext(record: SessionRecord): Promise<SessionContextReport> {
  const fill = contextFillFromState(record.acpx?.context_fill) ?? {
    used: 0,
    window: 0,
    compactAt: undefined,
  };
  const level = await readSeatContextAlarmLevel(sessionBaseDir(), record.seatId);
  return { fill, alarm: resolveContextAlarm(level, fill) };
}

/** The `context:` line `acpx status` prints. */
export async function sessionContextLine(record: SessionRecord): Promise<string> {
  const { fill, alarm } = await readSessionContext(record);
  return formatContextLine(fill, alarm);
}

export function sessionContextJson(report: SessionContextReport): Record<string, unknown> {
  const { fill, alarm } = report;
  return {
    usedTokens: fill.used,
    windowTokens: fill.window,
    usedPct: contextUsedPct(fill),
    compactionTokens: fill.compactAt ?? null,
    alarm: {
      levelPct: alarm.levelPct,
      default: !alarm.explicit,
      atTokens: alarm.atTokens ?? null,
      pastCompaction: alarm.pastCompaction,
    },
  };
}

function ownSessionSelector(selector: SessionTargetSelector): SessionTargetSelector {
  if (selector.sessionId || selector.sessionUrl || selector.seat) {
    return selector;
  }
  const own = parseSessionIdFromUrl(process.env.ACPX_SESSION_URL?.trim() || undefined);
  if (!own) {
    throw new NoSessionError(
      "⚠ acpx context: no session given and $ACPX_SESSION_URL names none — pass --session-id <id> (or --session-url / --seat)",
    );
  }
  return { sessionId: own };
}

async function writeAlarmLevel(record: SessionRecord, raw: string): Promise<string> {
  const level = parseContextAlarmArgument(raw);
  if (!record.seatId) {
    throw new Error(
      `session ${record.acpxRecordId} has no seat, and the context alarm is a seat setting — nothing was changed`,
    );
  }
  const outcome = await setSeatContextAlarm(sessionBaseDir(), record.seatId, level);
  if (outcome === "no-row") {
    throw new Error(
      `seat ${record.seatId} has no row in the seat store (run \`acpx seats backfill\`) — nothing was changed`,
    );
  }
  return `seat ${record.seatId}: context alarm = ${level === undefined ? "default" : `${level} %`}`;
}

async function handleContext(flags: ContextFlags, command: Command, config: ResolvedAcpxConfig) {
  const { format } = resolveGlobalFlags(command, config);
  const selector = ownSessionSelector(resolveSessionTargetSelector({ flags, command }));
  const record = await requireExplicitSessionRecord(selector, config.defaultAgent);
  const changed =
    flags.alarm === undefined ? undefined : await writeAlarmLevel(record, flags.alarm);
  const report = await readSessionContext(record);
  if (
    emitJsonResult(format, {
      action: "context",
      acpxRecordId: record.acpxRecordId,
      seatId: record.seatId ?? null,
      ...sessionContextJson(report),
    })
  ) {
    return;
  }
  if (format === "quiet") {
    return;
  }
  if (changed) {
    process.stdout.write(`${changed}\n`);
  }
  process.stdout.write(`context: ${formatContextLine(report.fill, report.alarm)}\n`);
  const warning = pastCompactionWarning(report.alarm);
  if (warning) {
    process.stdout.write(`${warning}\n`);
  }
}

export function registerContextCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const contextCommand = parent
    .command("context")
    .description(
      "Show a session's context fill (used / window / %), its alarm level and where its harness auto-compacts — your own session by default",
    )
    .option(
      "--alarm <level>",
      "Set the SEAT's context alarm: a percentage 0-100 (0 = off) or `default` (90)",
    );
  addSessionNameOption(contextCommand);
  addSeatSelectorOption(contextCommand);
  contextCommand.action(async function (this: Command, flags: ContextFlags) {
    await handleContext(flags, this, config);
  });
}
