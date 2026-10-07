/**
 * THE CONTEXT ALARM — brick 4f3fa88c, decided by Daniel 2026-10-07 (brick 7f61daf9
 * `decision/DECISION.md`, items A–D).
 *
 * An agent whose context fills is told so early enough to hand its work to a successor in
 * its seat, instead of being silently squeezed by its harness's auto-compaction.
 *
 * - **The level is a SEAT field** (`SeatRecord.contextAlarm`): default 90, `0` = off. A
 *   successor shares it by construction; children and forks have their own seats.
 * - **The default fires at 90 %, never later than the compaction point minus a runway**
 *   of 40,000 tokens (at most 10 % of the window). An EXPLICIT level is honoured as given,
 *   with a warning when it sits at or past the compaction point.
 * - **The compaction point is read at runtime from each harness** — every adapter names it
 *   in `usage_update._meta.contextCompaction.atTokens`. No static table.
 * - **Unknown window ⇒ window 0, usage 0 %, no alarm** — and no "unconfirmed" wording.
 * - **Once per crossing**: speaks once when the fill crosses, re-arms when it drops back.
 *
 * Pure: no I/O here. The detector lives in the turn runtime, the delivery in the
 * mid-turn injector and the turn-context channel.
 */

export const DEFAULT_CONTEXT_ALARM_PCT = 90;
export const CONTEXT_ALARM_RUNWAY_TOKENS = 40_000;
export const CONTEXT_ALARM_RUNWAY_MAX_FRACTION = 0.1;
/** The fixed marker the agent (and acpx-ui's chat) recognises the notice by. */
export const CONTEXT_ALARM_MARKER = "⟦CONTEXT-ALARM⟧";

/** What the harness last reported. `window: 0` is UNKNOWN, never a guess. */
export type ContextFill = {
  readonly used: number;
  readonly window: number;
  /** Where the harness auto-compacts, in tokens, when it said so. */
  readonly compactAt: number | undefined;
};

export type ContextAlarm = {
  /** The effective level in percent; `0` = off. */
  readonly levelPct: number;
  /** The seat carries its own level (vs. the default). */
  readonly explicit: boolean;
  /** The fill, in tokens, at which the alarm speaks — `undefined` = never (off, or window unknown). */
  readonly atTokens: number | undefined;
  /** The default was moved earlier to keep the runway before compaction. */
  readonly movedForRunway: boolean;
  /** An explicit level at or past the compaction point — honoured, with a warning. */
  readonly pastCompaction: boolean;
};

/** A seat's level, validated: an integer 0–100. */
export function isContextAlarmLevel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

/**
 * Parse `acpx context --alarm <n|0|default>`. `"default"` ⇒ `undefined` (the seat carries no
 * level of its own). Anything else must be an integer 0–100.
 */
export function parseContextAlarmArgument(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === "default") {
    return undefined;
  }
  const value = /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!isContextAlarmLevel(value)) {
    throw new Error(
      `--alarm takes a whole percentage 0-100 (0 = off) or "default", not ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/** The runway the default keeps before compaction: 40,000 tokens, at most 10 % of the window. */
export function contextAlarmRunway(window: number): number {
  return Math.min(
    CONTEXT_ALARM_RUNWAY_TOKENS,
    Math.floor(window * CONTEXT_ALARM_RUNWAY_MAX_FRACTION),
  );
}

export function resolveContextAlarm(
  seatLevel: number | undefined,
  fill: Pick<ContextFill, "window" | "compactAt">,
): ContextAlarm {
  const explicit = seatLevel !== undefined;
  const levelPct = seatLevel ?? DEFAULT_CONTEXT_ALARM_PCT;
  const silent = { levelPct, explicit, movedForRunway: false, pastCompaction: false };
  if (levelPct === 0 || fill.window <= 0) {
    return { ...silent, atTokens: undefined };
  }
  const atLevel = Math.floor((fill.window * levelPct) / 100);
  const compactAt = fill.compactAt;
  if (compactAt === undefined || compactAt <= 0) {
    return { ...silent, atTokens: atLevel };
  }
  if (explicit) {
    return { ...silent, atTokens: atLevel, pastCompaction: atLevel >= compactAt };
  }
  const latest = compactAt - contextAlarmRunway(fill.window);
  return latest < atLevel
    ? { ...silent, atTokens: Math.max(1, latest), movedForRunway: true }
    : { ...silent, atTokens: atLevel };
}

/** Percent of the window, one decimal; `0` when the window is unknown (Daniel's rule). */
export function contextUsedPct(fill: Pick<ContextFill, "used" | "window">): number {
  return fill.window > 0 ? Math.round((fill.used / fill.window) * 1000) / 10 : 0;
}

/** Fires while the fill is at or past the alarm. */
export function isPastContextAlarm(fill: ContextFill, alarm: ContextAlarm): boolean {
  return alarm.atTokens !== undefined && fill.used >= alarm.atTokens;
}

/**
 * ONCE PER CROSSING. `observe` returns `true` exactly on the update that crosses the
 * alarm, then stays quiet while the fill stays past it; a fill below the alarm (after a
 * compaction, say) — or the alarm switched off — re-arms it.
 */
export class ContextAlarmLatch {
  private spoken = false;

  observe(fill: ContextFill, alarm: ContextAlarm): boolean {
    if (!isPastContextAlarm(fill, alarm)) {
      this.spoken = false;
      return false;
    }
    if (this.spoken) {
      return false;
    }
    this.spoken = true;
    return true;
  }

  /** The crossing was announced another way (the top of a turn). */
  markSpoken(): void {
    this.spoken = true;
  }
}

function tokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function pct(n: number): string {
  return `${n.toFixed(1)} %`;
}

function alarmClause(fill: ContextFill, alarm: ContextAlarm): string {
  const at = alarm.atTokens ?? 0;
  if (alarm.movedForRunway) {
    return `your alarm (${alarm.levelPct} %, moved to ${tokens(at)} to keep a ${tokens(
      contextAlarmRunway(fill.window),
    )}-token runway before auto-compaction)`;
  }
  return `your ${alarm.levelPct} % alarm`;
}

/**
 * The fixed one-line notice (CONCEPTION.md D6, as approved). Numbers filled in; it teaches
 * by itself, so an agent that never read the skill still knows what to do.
 */
export function formatContextAlarmNotice(fill: ContextFill, alarm: ContextAlarm): string {
  const compaction =
    fill.compactAt !== undefined ? `; auto-compaction at ≈ ${tokens(fill.compactAt)}` : "";
  const warning = alarm.pastCompaction
    ? " Your alarm sits at or past auto-compaction, which may come first."
    : "";
  return (
    `${CONTEXT_ALARM_MARKER} Context ${tokens(fill.used)} / ${tokens(fill.window)} tokens ` +
    `(${pct(contextUsedPct(fill))}) is past ${alarmClause(fill, alarm)}${compaction}.${warning} ` +
    `Finish this step, then hand over to a successor (skill: context-succession). ` +
    `Off: acpx context --alarm 0`
  );
}

/** The `acpx context` / `acpx status` line. */
export function formatContextLine(fill: ContextFill, alarm: ContextAlarm): string {
  const used = `${tokens(fill.used)} / ${tokens(fill.window)} tokens (${pct(contextUsedPct(fill))})`;
  let level: string;
  if (alarm.levelPct === 0) {
    level = "alarm off";
  } else {
    const where = alarm.atTokens !== undefined ? ` at ${tokens(alarm.atTokens)}` : "";
    const how = alarm.explicit ? "" : " (default)";
    level = `alarm ${alarm.levelPct} %${how}${where}`;
  }
  const compaction =
    fill.compactAt !== undefined ? ` · auto-compaction at ${tokens(fill.compactAt)}` : "";
  return `${used} · ${level}${compaction}`;
}

/** The one-line warning for an explicit level at or past the compaction point. */
export function pastCompactionWarning(alarm: ContextAlarm): string | undefined {
  return alarm.pastCompaction
    ? `⚠ alarm ${alarm.levelPct} % sits at or past this session's auto-compaction point — it is honoured, but compaction may come first`
    : undefined;
}
