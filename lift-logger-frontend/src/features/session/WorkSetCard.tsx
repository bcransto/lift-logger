import type { Cursor, SessionSetRow, SnapshotSetTarget } from '../../types/schema'
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
}: Props) {
  const isTimed = target.target_duration_sec != null
  const cls = [
    styles.card,
    isFocused ? styles.focused : '',
    isDone ? styles.done : '',
    target.is_peak && !isFocused ? styles.peak : '',
    onTap ? styles.tappable : '',
    onRecord ? styles.cardWithRecord : '',
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

  const body = (
    <>
      {showExName ? <div className={styles.exName}>{beName}</div> : null}
      <div className={styles.label}>
        SET {target.set_number}
        {round != null && totalRounds != null ? ` · R${round}/${totalRounds}` : ''}
        {target.is_peak ? ' ★' : ''}
        {isFocused ? ' · NOW' : isDone ? ' ✓' : ''}
      </div>
      <div className={styles.values}>
        <span className={styles.weight}>{weightDisplay}</span>
        <span className={styles.reps}>{repsDisplay}</span>
      </div>
      {isDone && actual ? (
        <div className={styles.actual}>
          Actual: {actual.actual_weight ?? '—'}
          {' · '}
          {actual.actual_reps ?? actual.actual_duration_sec ?? '—'}
        </div>
      ) : null}
    </>
  )
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
