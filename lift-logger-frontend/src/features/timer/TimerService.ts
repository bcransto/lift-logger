// Timer math — pure functions. No state; components + sessionStore supply inputs.
//
// Phase 2 model:
//   - Rest timer is DERIVED from the last logged session_set: `logged_at +
//     rest_after_sec`. No separate `startedAt` needed; rest "starts" when the
//     set is logged and "ends" when that sum passes now.
//   - Work timer (HIIT / timed work) uses two persisted columns on the
//     sessions row — `work_timer_started_at` + `work_timer_duration_sec` —
//     so the countdown survives reload.
//   - Pause freezes any timer: whenever `pausedAt` is set, the effective
//     "now" used in the math is substituted with `pausedAt`, so remaining
//     stops advancing. Resume clears `pausedAt`.

export type TimerKind = 'rest' | 'work' | 'setup' | null

export type DerivedTimer = {
  kind: Exclude<TimerKind, null>
  startedAt: number
  durationSec: number
  remainingSec: number // clamped ≥ 0
  elapsedSec: number
  frozen: boolean // true when paused
}

// ─── legacy shape (still referenced by sessionStore for pendingEdits flow) ───

export type TimerSnapshot = {
  kind: TimerKind
  startedAt: number | null
  durationSec: number | null
}

export const IDLE_TIMER: TimerSnapshot = { kind: null, startedAt: null, durationSec: null }

/** Remaining seconds on a legacy TimerSnapshot. Pass `pausedAt` to freeze. */
export function remainingSec(
  t: TimerSnapshot,
  now: number = Date.now(),
  pausedAt: number | null = null,
): number {
  if (!t.startedAt || !t.durationSec) return 0
  const effectiveNow = pausedAt ?? now
  return t.durationSec - (effectiveNow - t.startedAt) / 1000
}

export function elapsedSec(
  t: TimerSnapshot,
  now: number = Date.now(),
  pausedAt: number | null = null,
): number {
  if (!t.startedAt) return 0
  const effectiveNow = pausedAt ?? now
  return (effectiveNow - t.startedAt) / 1000
}

export function crossedZero(prevRemaining: number, nextRemaining: number): boolean {
  return prevRemaining > 0 && nextRemaining <= 0
}

// ─── Phase 2 derivations ─────────────────────────────────────────────────

/**
 * Derive the rest timer from the last logged session_set.
 * Returns null if no rest is active (no last set, rest_after_sec is 0/null,
 * or rest has already elapsed).
 */
export function deriveRestTimer(
  lastLoggedAt: number | null,
  restAfterSec: number | null | undefined,
  pausedAt: number | null,
  now: number = Date.now(),
): DerivedTimer | null {
  if (!lastLoggedAt || !restAfterSec || restAfterSec <= 0) return null
  const effectiveNow = pausedAt ?? now
  const endsAt = lastLoggedAt + restAfterSec * 1000
  if (effectiveNow >= endsAt) return null
  const elapsed = (effectiveNow - lastLoggedAt) / 1000
  return {
    kind: 'rest',
    startedAt: lastLoggedAt,
    durationSec: restAfterSec,
    remainingSec: Math.max(0, restAfterSec - elapsed),
    elapsedSec: elapsed,
    frozen: pausedAt !== null,
  }
}

/** Derive the work timer from session row's persisted fields. */
export function deriveWorkTimer(
  workTimerStartedAt: number | null,
  workTimerDurationSec: number | null,
  pausedAt: number | null,
  now: number = Date.now(),
): DerivedTimer | null {
  if (!workTimerStartedAt || !workTimerDurationSec) return null
  const effectiveNow = pausedAt ?? now
  const elapsed = (effectiveNow - workTimerStartedAt) / 1000
  return {
    kind: 'work',
    startedAt: workTimerStartedAt,
    durationSec: workTimerDurationSec,
    remainingSec: Math.max(0, workTimerDurationSec - elapsed),
    elapsedSec: elapsed,
    frozen: pausedAt !== null,
  }
}

/**
 * Returns whichever timer is active (rest or work). Rest wins if both somehow
 * apply — you're between sets, not yet in the next work interval.
 */
export function deriveActiveTimer(
  args: {
    lastLoggedAt: number | null
    lastLoggedRestAfterSec: number | null | undefined
    workTimerStartedAt: number | null
    workTimerDurationSec: number | null
    pausedAt: number | null
  },
  now: number = Date.now(),
): DerivedTimer | null {
  return (
    deriveRestTimer(args.lastLoggedAt, args.lastLoggedRestAfterSec, args.pausedAt, now) ??
    deriveWorkTimer(args.workTimerStartedAt, args.workTimerDurationSec, args.pausedAt, now)
  )
}

/**
 * Adjusting a running work timer by ±delta seconds. Returns the new
 * durationSec. Minimum 0. Does nothing if the work timer isn't running.
 */
export function adjustWorkTimerDuration(
  current: number | null,
  deltaSec: number,
): number | null {
  if (current == null) return null
  return Math.max(0, current + deltaSec)
}
