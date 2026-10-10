import type { SessionContextFill } from "../types.js";
/**
 * The context alarm's DETECTOR — the per-session state between two usage reports (brick
 * 4f3fa88c). One per running session, in the process that runs its turns.
 *
 * - `observe` runs on EVERY `usage_update` (mid-turn on all three harnesses) and resolves
 *   to the notice on the update that crosses the alarm — once per crossing — or to the
 *   CLEARED notice on the update that drops far below an alarm that had spoken (a
 *   compaction: brick bbe2bc47), once.
 * - `lineForTurnStart` is what the turn-context channel puts at the top of EVERY later
 *   turn while the fill stays past the alarm, with the numbers last reported — or, once,
 *   a cleared notice that found no injector.
 *
 * The level is the SEAT's, re-read from the seat store on every observation, so
 * `acpx context --alarm 0` takes effect on the very next usage report — mid-turn included.
 */
import {
  type ContextAlarm,
  type ContextFill,
  ContextAlarmLatch,
  formatContextAlarmClearedNotice,
  formatContextAlarmNotice,
  isPastContextAlarm,
  resolveContextAlarm,
} from "./context-alarm.js";
import { readSeatStore, seatFromStore } from "./persistence/seat-store.js";

/**
 * The stored fill as the alarm reads it. Brick 4a6716b5: a fill past its KNOWN window is no
 * fill — the same rule `rememberContextFill` applies to a fresh report, applied here too
 * because a record persisted by an older build can still carry one (a false turn-start
 * alarm after the next owner respawn).
 */
export function contextFillFromState(
  state: SessionContextFill | undefined,
): ContextFill | undefined {
  if (state === undefined) {
    return undefined;
  }
  if (state.window_tokens > 0 && state.used_tokens > state.window_tokens) {
    return undefined;
  }
  return {
    used: state.used_tokens,
    window: state.window_tokens,
    compactAt: state.compaction_tokens,
  };
}

/**
 * The seat's level: `undefined` = the default — also for a session with no seat, a seat
 * with no row, or a store that cannot be read (the alarm then still rings at the default;
 * it must never go silent because a store read failed).
 */
export async function readSeatContextAlarmLevel(
  sessionDir: string,
  seatId: string | undefined,
): Promise<number | undefined> {
  if (!seatId) {
    return undefined;
  }
  try {
    return seatFromStore(await readSeatStore(sessionDir), seatId)?.contextAlarm;
  } catch {
    return undefined;
  }
}

/**
 * A6 backstop: `acpx sessions handover` from a context that is already far below the seat's
 * alarm — compacted after the alarm — prints this one line and proceeds (never a refusal: a
 * handover is a legitimate choice, and the stored fill can be stale).
 */
export function handoverBelowAlarmWarning(
  stored: SessionContextFill | undefined,
  seatLevel: number | undefined,
): string | undefined {
  const fill = contextFillFromState(stored);
  if (fill === undefined) {
    return undefined;
  }
  const alarm = resolveContextAlarm(seatLevel, fill);
  if (alarm.atTokens === undefined || fill.used >= alarm.atTokens / 2) {
    return undefined;
  }
  return (
    `handover: your context is ${fill.used.toLocaleString("en-US")} / ` +
    `${fill.window.toLocaleString("en-US")} tokens, far below your alarm — if it was compacted after the ` +
    `alarm, a handover is not needed: continuing is the default. Proceeding anyway.`
  );
}

export class ContextAlarmDetector {
  private readonly latch = new ContextAlarmLatch();
  private fill: ContextFill | undefined;
  private level: number | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * A detector is built per task from the STORED fill. Whether the alarm had already spoken is
   * not stored, so the first observation derives it: a stored fill past the alarm was announced
   * (this turn's top line, or a mid-turn notice of the previous turn) — a compaction after an
   * owner respawn must still clear. Lazy, not in the constructor: the level is a seat read.
   */
  private seeded = false;
  private clearedNotice: string | undefined;
  private clearedForTurnStart: string | undefined;

  constructor(
    private readonly readLevel: () => Promise<number | undefined>,
    initialFill: ContextFill | undefined,
  ) {
    this.fill = initialFill;
  }

  private alarm(fill: ContextFill): ContextAlarm {
    return resolveContextAlarm(this.level, fill);
  }

  /** Re-read the seat's level (at turn start, and inside every observation). */
  async refreshLevel(): Promise<void> {
    this.level = await this.readLevel();
  }

  /**
   * One usage report. Serialized, so reports are judged in arrival order even though each
   * waits on a store read. Resolves to the notice exactly when this report crossed, or to
   * the cleared notice exactly when it dropped far below an alarm that had spoken.
   */
  observe(fill: ContextFill): Promise<string | undefined> {
    const next = this.chain.then(async () => {
      await this.refreshLevel();
      if (!this.seeded) {
        this.seeded = true;
        const stored = this.fill;
        if (stored !== undefined && isPastContextAlarm(stored, this.alarm(stored))) {
          this.latch.markSpoken();
        }
      }
      this.fill = fill;
      const alarm = this.alarm(fill);
      const event = this.latch.observe(fill, alarm);
      if (event === "crossed") {
        this.clearedForTurnStart = undefined;
        return formatContextAlarmNotice(fill, alarm);
      }
      if (event === "cleared") {
        this.clearedNotice = formatContextAlarmClearedNotice(fill);
        return this.clearedNotice;
      }
      return undefined;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * A notice `observe` resolved to found no turn accepting injections: keep it for the top
   * of the next turn. Only the cleared notice is kept — a crossing is recomputed there from
   * the fill, so it needs no keeping.
   */
  holdForTurnStart(notice: string): void {
    if (notice === this.clearedNotice) {
      this.clearedForTurnStart = notice;
    }
  }

  /**
   * The notice for the top of a turn, while the fill is past the alarm. Counts as the
   * crossing having been spoken, so the same crossing is not repeated mid-turn. Below the
   * alarm it is the held cleared notice, exactly once.
   */
  lineForTurnStart(): string | undefined {
    const fill = this.fill;
    if (fill === undefined) {
      return undefined;
    }
    const alarm = this.alarm(fill);
    if (!isPastContextAlarm(fill, alarm)) {
      const held = this.clearedForTurnStart;
      this.clearedForTurnStart = undefined;
      return held;
    }
    this.clearedForTurnStart = undefined;
    this.latch.markSpoken();
    return formatContextAlarmNotice(fill, alarm);
  }
}

/** Detectors of the turns now running in this process, by ACP session id. */
const runningDetectors = new Map<string, ContextAlarmDetector>();

/** Make a detector visible to the turn-context channel for one turn; returns the undo. */
export function registerContextAlarmDetector(
  acpSessionId: string,
  detector: ContextAlarmDetector,
): () => void {
  runningDetectors.set(acpSessionId, detector);
  return () => {
    if (runningDetectors.get(acpSessionId) === detector) {
      runningDetectors.delete(acpSessionId);
    }
  };
}

export function contextAlarmLineForTurnStart(acpSessionId: string): string | undefined {
  return runningDetectors.get(acpSessionId)?.lineForTurnStart();
}
