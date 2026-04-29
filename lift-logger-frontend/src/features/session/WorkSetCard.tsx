import { useEffect, useRef, useState } from 'react'
import { useTick } from '../../shared/hooks/useVisibility'
import { playChime, vibrate } from '../timer/chime'
import type { Cursor, SessionSetRow, SnapshotSetTarget } from '../../types/schema'
import { mmss } from '../../shared/utils/format'
import styles from './WorkSetCard.module.css'

type Props = {
  target: SnapshotSetTarget
  cursor: Cursor
  isFocused: boolean
  isDone: boolean
  actual?: SessionSetRow
  beName: string
  /** Show the exercise name on the card (helpful when block has multiple BEs). */
  showExName?: boolean
  round: number | null
  totalRounds: number | null
  /** If provided, card is tappable (hotlink to Set view). Legacy superset/circuit path. */
  onTap?: () => void
  /** If provided, renders a Record button inside the card (single-block flow). */
  onRecord?: () => void
  /** Superset/circuit focused-card action. When supplied and the card is
      focused + not yet done, renders a single "Done" button on the right that
      opens the SetLogger (the user confirms or modifies there). Unfocused
      and already-logged cards stay button-less. */
  onDone?: () => void
  /** For timed sets (target_duration_sec != null) on the focused card: the
      active work-timer fields on `sessions`. When both are set and the card
      is focused, the reps slot renders a live mm:ss countdown in place of the
      static `20s` label. */
  workTimerStartedAt?: number | null
  workTimerDurationSec?: number | null
  /** Fired once on zero-cross when the inline countdown hits zero. Legacy
      flow passes a callback that auto-logs the set. */
  onTimerZero?: () => void
}

export function WorkSetCard({
  target,
  isFocused,
  isDone,
  actual,
  beName,
  showExName,
  round,
  totalRounds,
  onTap,
  onRecord,
  onDone,
  workTimerStartedAt,
  workTimerDurationSec,
  onTimerZero,
}: Props) {
  const showFocusedActions = isFocused && !isDone && Boolean(onDone)
  const isTimed = target.target_duration_sec != null
  const timerRunning =
    isFocused &&
    isTimed &&
    !isDone &&
    workTimerStartedAt != null &&
    workTimerDurationSec != null
  const cls = [
    styles.card,
    isFocused ? styles.focused : '',
    isDone ? styles.done : '',
    target.is_peak && !isFocused ? styles.peak : '',
    onTap ? styles.tappable : '',
    onRecord ? styles.cardWithRecord : '',
    showFocusedActions ? styles.cardWithActions : '',
  ].filter(Boolean).join(' ')

  const weightDisplay =
    target.target_weight != null
      ? `${target.target_weight} LB`
      : target.target_pct_1rm != null
        ? `${Math.round(target.target_pct_1rm * 100)}%`
        : 'BW'

  const repsDisplay =
    target.target_reps != null
      ? `× ${target.target_reps}${target.target_reps_each ? ' ea' : ''}`
      : isTimed
        ? `${target.target_duration_sec}s`
        : '—'

  const showInlineCounter = timerRunning && target.target_reps == null

  const isSkipped = actual?.skipped === 1
  // After a set is logged, the prominent display flips to the actuals — the
  // user is reviewing what they did, not what was planned. Target moves to a
  // small "TARGET …" line above for comparison.
  const showActualProminent = isDone && Boolean(actual) && !isSkipped
  const actualWeightDisplay =
    actual?.actual_weight != null ? `${actual.actual_weight} LB` : weightDisplay
  const actualRepsDisplay =
    actual?.actual_reps != null
      ? `× ${actual.actual_reps}`
      : actual?.actual_duration_sec != null
        ? `${actual.actual_duration_sec}s`
        : repsDisplay
  const body = (
    <>
      {showExName ? <div className={styles.exName}>{beName}</div> : null}
      <div className={styles.label}>
        SET {target.set_number}
        {round != null && totalRounds != null ? ` · R${round}/${totalRounds}` : ''}
        {target.is_peak ? ' ★' : ''}
        {isFocused ? ' · NOW' : isSkipped ? ' · SKIPPED' : isDone ? ' ✓' : ''}
      </div>
      {showActualProminent ? (
        <div className={styles.targetCompare}>
          TARGET {weightDisplay} {repsDisplay}
        </div>
      ) : null}
      <div className={styles.values}>
        <span className={styles.weight}>
          {showActualProminent ? actualWeightDisplay : weightDisplay}
        </span>
        {showInlineCounter ? (
          <InlineCountdown
            startedAt={workTimerStartedAt!}
            durationSec={workTimerDurationSec!}
            onZero={onTimerZero}
          />
        ) : (
          <span className={styles.reps}>
            {showActualProminent ? actualRepsDisplay : repsDisplay}
          </span>
        )}
      </div>
    </>
  )
  if (showFocusedActions) {
    // 2-column layout: body on the left, single Done button on the right.
    // The button opens SetLogger so the user can confirm target values or
    // modify them before committing. The card body itself is not interactive.
    return (
      <div className={cls}>
        <div className={styles.cardBody}>{body}</div>
        <button type="button" className={styles.doneBtn} onClick={onDone}>
          Done
        </button>
      </div>
    )
  }
  if (onRecord) {
    // 2-column layout: body on the left, Record button on the right.
    return (
      <div className={cls}>
        <div className={styles.cardBody}>{body}</div>
        <button type="button" className={styles.recordBtn} onClick={onRecord}>
          Record
        </button>
      </div>
    )
  }
  if (onTap) {
    return (
      <button type="button" className={cls} onClick={onTap}>
        {body}
      </button>
    )
  }
  return <div className={cls}>{body}</div>
}

// Live mm:ss countdown that drives the reps slot when a timed set is focused
// and its work timer is running. Fires chime + vibrate + onZero once on the
// 0 crossing. Styled to match `.reps` so the card's visual weight doesn't
// jump when the timer starts.
function InlineCountdown({
  startedAt,
  durationSec,
  onZero,
}: {
  startedAt: number
  durationSec: number
  onZero?: () => void
}) {
  // Initialize remaining from wall-clock on first render so a freshly-mounted
  // counter (e.g. a new focused card taking over an in-flight timer) doesn't
  // spuriously count down from `durationSec`.
  const firstRemaining = Math.max(
    0,
    durationSec - Math.floor((Date.now() - startedAt) / 1000),
  )
  const remainingRef = useRef<number>(firstRemaining)
  // If we mounted on an already-expired timer, mark this startedAt as
  // already-fired so we don't fire `onZero` for a transition the user already
  // experienced on a previous card. This is the single-counter-per-card
  // analogue of TimerDock's firedForRef guard.
  const firedForRef = useRef<number | null>(firstRemaining <= 0 ? startedAt : null)

  // Re-render on tick using a small local counter.
  const [, force] = useCounter()
  useTick(true, () => {
    const next = Math.max(0, durationSec - Math.floor((Date.now() - startedAt) / 1000))
    const prev = remainingRef.current
    if (prev > 0 && next <= 0 && firedForRef.current !== startedAt) {
      firedForRef.current = startedAt
      playChime()
      vibrate([120, 60, 120])
      onZero?.()
    }
    remainingRef.current = next
    force()
  }, 250)

  // Reset baseline when a new timer starts (different startedAt/duration).
  useEffect(() => {
    const fresh = Math.max(
      0,
      durationSec - Math.floor((Date.now() - startedAt) / 1000),
    )
    remainingRef.current = fresh
    firedForRef.current = fresh <= 0 ? startedAt : null
  }, [startedAt, durationSec])

  const remaining = remainingRef.current
  const ready = remaining <= 0
  return (
    <span className={`${styles.counter} ${ready ? styles.counterReady : ''}`}>
      {mmss(remaining)}
    </span>
  )
}

function useCounter(): [number, () => void] {
  const [n, setN] = useState(0)
  return [n, () => setN((v) => v + 1)]
}
