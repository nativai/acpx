import type { SessionContextFill } from "../types.js";
/**
 * The context alarm's DETECTOR — the per-session state between two usage reports (brick
 * 4f3fa88c). One per running session, in the process that runs its turns.
 *
 * - `observe` runs on EVERY `usage_update` (mid-turn on all three harnesses) and resolves
 *   to the notice on the update that crosses the alarm — once per crossing.
 * - `lineForTurnStart` is what the turn-context channel puts at the top of EVERY later
 *   turn while the fill stays past the alarm, with the numbers last reported.
 *
 * The level is the SEAT's, re-read from the seat store on every observation, so
 * `acpx context --alarm 0` takes effect on the very next usage report — mid-turn included.
 */
import {
  type ContextAlarm,
  type ContextFill,
  ContextAlarmLatch,
  formatContextAlarmNotice,
  isPastContextAlarm,
  resolveContextAlarm,
} from "./context-alarm.js";
import { readSeatStore, seatFromStore } from "./persistence/seat-store.js";

export function contextFillFromState(
  state: SessionContextFill | undefined,
): ContextFill | undefined {
  return state === undefined
    ? undefined
    : { used: state.used_tokens, window: state.window_tokens, compactAt: state.compaction_tokens };
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

export class ContextAlarmDetector {
  private readonly latch = new ContextAlarmLatch();
  private fill: ContextFill | undefined;
  private level: number | undefined;
  private chain: Promise<unknown> = Promise.resolve();

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
   * waits on a store read. Resolves to the notice exactly when this report crossed.
   */
  observe(fill: ContextFill): Promise<string | undefined> {
    const next = this.chain.then(async () => {
      await this.refreshLevel();
      this.fill = fill;
      const alarm = this.alarm(fill);
      return this.latch.observe(fill, alarm) ? formatContextAlarmNotice(fill, alarm) : undefined;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * The notice for the top of a turn, while the fill is past the alarm. Counts as the
   * crossing having been spoken, so the same crossing is not repeated mid-turn.
   */
  lineForTurnStart(): string | undefined {
    const fill = this.fill;
    if (fill === undefined) {
      return undefined;
    }
    const alarm = this.alarm(fill);
    if (!isPastContextAlarm(fill, alarm)) {
      return undefined;
    }
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
