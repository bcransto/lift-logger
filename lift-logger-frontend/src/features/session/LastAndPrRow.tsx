import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { mmss } from '../../shared/utils/format'
import styles from './LastAndPrRow.module.css'

type LastSet = { weight: number | null; reps: number | null; duration: number | null }
type Pr = { weight: number; reps: number | null }

export function useLastAndPr(
  exerciseId: string,
  currentSessionId: string | null,
): { last: LastSet | null; pr: Pr | null } {
  const data = useLiveQuery(async () => {
    // Most-recent prior session's best set for this exercise. "Best" ranks
    // weight, then reps, then duration — so weighted exercises show the
    // heaviest set while bodyweight (reps-only) and timed sets still get a
    // LAST value instead of "no history".
    const rows = await db.session_sets.where('exercise_id').equals(exerciseId).toArray()
    const candidates = rows.filter(
      (r) =>
        r.session_id !== currentSessionId &&
        r.skipped !== 1 &&
        (r.actual_weight != null || r.actual_reps != null || r.actual_duration_sec != null),
    )
    let last: LastSet | null = null
    if (candidates.length > 0) {
      // Group by session, pick the session with the most recent logged_at.
      const bySession = new Map<string, typeof candidates>()
      for (const r of candidates) {
        const arr = bySession.get(r.session_id) ?? []
        arr.push(r)
        bySession.set(r.session_id, arr)
      }
      let bestSession: typeof candidates = []
      let bestLoggedAt = -Infinity
      for (const arr of bySession.values()) {
        const maxAt = Math.max(...arr.map((r) => r.logged_at))
        if (maxAt > bestLoggedAt) {
          bestLoggedAt = maxAt
          bestSession = arr
        }
      }
      // Best set: heaviest, tiebreak by reps desc, then duration desc.
      const best = bestSession
        .slice()
        .sort((a, b) =>
          (b.actual_weight ?? -1) - (a.actual_weight ?? -1) ||
          (b.actual_reps ?? -1) - (a.actual_reps ?? -1) ||
          (b.actual_duration_sec ?? -1) - (a.actual_duration_sec ?? -1),
        )[0]
      if (best) {
        last = {
          weight: best.actual_weight,
          reps: best.actual_reps,
          duration: best.actual_duration_sec,
        }
      }
    }

    const prRow = await db.exercise_prs
      .where('[exercise_id+pr_type]')
      .equals([exerciseId, 'weight'])
      .first()
    const pr: Pr | null = prRow ? { weight: prRow.value, reps: prRow.reps } : null

    return { last, pr }
  }, [exerciseId, currentSessionId])

  return data ?? { last: null, pr: null }
}

export function LastAndPrRow({
  exerciseId,
  sessionId,
  exerciseName,
  showName,
}: {
  exerciseId: string
  sessionId: string | null
  exerciseName: string
  /** Prefix the row with the exercise name (use in multi-exercise blocks). */
  showName: boolean
}) {
  const { last, pr } = useLastAndPr(exerciseId, sessionId)
  if (!last && !pr) {
    return showName ? (
      <div className={styles.row}>
        <span className={styles.name}>{exerciseName}</span>
        <span className={styles.empty}>no history</span>
      </div>
    ) : null
  }
  return (
    <div className={styles.row}>
      {showName ? <span className={styles.name}>{exerciseName}</span> : null}
      {last ? (
        <span className={styles.stat}>
          <span className={styles.label}>LAST</span> {fmtLast(last)}
        </span>
      ) : null}
      {pr ? (
        <span className={styles.stat}>
          <span className={styles.label}>PR</span> {fmt(pr.weight, pr.reps)}
        </span>
      ) : null}
    </div>
  )
}

function fmt(weight: number, reps: number | null): string {
  return reps != null ? `${weight} × ${reps}` : `${weight}`
}

function fmtLast(last: { weight: number | null; reps: number | null; duration: number | null }): string {
  if (last.weight != null) return fmt(last.weight, last.reps)
  if (last.reps != null) return `× ${last.reps}`
  if (last.duration != null) return mmss(last.duration)
  return ''
}
