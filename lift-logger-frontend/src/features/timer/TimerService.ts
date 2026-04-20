// Pure helpers for startedAt-based timers. State persistence lives in sessionStore.
//
// The running countdown is computed from wall-clock deltas, so a backgrounded or
// reloaded tab just recomputes remaining time — no running counter to lose.

export type TimerKind = 'setup' | 'rest' | 'block_rest' | 'work' | null

export type TimerSnapshot = {
  kind: TimerKind
  startedAt: number | null
  durationSec: number | null
}

export const IDLE_TIMER: TimerSnapshot = { kind: null, startedAt: null, durationSec: null }

/** Remaining seconds; negative values mean the timer has passed zero. */
export function remainingSec(t: TimerSnapshot, now: number = Date.now()): number {
  if (!t.startedAt || !t.durationSec) return 0
  return t.durationSec - (now - t.startedAt) / 1000
}

/** Elapsed seconds since the timer started. */
export function elapsedSec(t: TimerSnapshot, now: number = Date.now()): number {
  if (!t.startedAt) return 0
  return (now - t.startedAt) / 1000
}

/** True if remaining time just crossed zero between `prevRemaining` and `nextRemaining`. */
export function crossedZero(prevRemaining: number, nextRemaining: number): boolean {
  return prevRemaining > 0 && nextRemaining <= 0
}
