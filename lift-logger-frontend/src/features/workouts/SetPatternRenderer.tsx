import type { SnapshotBlockExercise, SnapshotSetTarget } from '../../types/schema'
import styles from './SetPatternRenderer.module.css'

type Props = {
  blockExercise: SnapshotBlockExercise
  isUnilateral?: boolean
}

/**
 * Render a compact pattern summary:
 *   pyramid   → 135×12 → 155×10 → 175×8 → 185×6 ★
 *   straight  → 40 × 10 × 3   (all sets identical)
 *   varied    → 40 × 10, 10, 10  (same weight, different reps)
 *   time      → BW · 40s × 3
 *   unilateral→ 37.5 × 10 ea × 3
 */
export function SetPatternRenderer({ blockExercise, isUnilateral }: Props) {
  // Template summary shows "one round" of the pattern. With v3 per-round
  // snapshots, filter to round-1 anchor rows; callers that want a per-round
  // preview should pass a be with the round-specific slice already filtered.
  const sets = blockExercise.sets.filter((s) => (s.round_number ?? 1) === 1)
  if (!sets.length) return <span className={styles.empty}>—</span>

  const allDuration = sets.every((s) => s.target_duration_sec != null)
  if (allDuration) {
    return (
      <span className={styles.pattern}>
        {formatTime(sets, isUnilateral)}
        {anyPeak(sets) ? <span className={styles.peak}> ★</span> : null}
      </span>
    )
  }

  const identical = sets.every(
    (s) => s.target_weight === sets[0]!.target_weight && s.target_reps === sets[0]!.target_reps,
  )
  const sameWeight = sets.every((s) => s.target_weight === sets[0]!.target_weight)

  if (identical) {
    return (
      <span className={styles.pattern}>
        {formatStraight(sets[0]!, sets.length, isUnilateral)}
        {anyPeak(sets) ? <span className={styles.peak}> ★</span> : null}
      </span>
    )
  }

  if (sameWeight) {
    return (
      <span className={styles.pattern}>
        {formatVariedReps(sets, isUnilateral)}
        {anyPeak(sets) ? <span className={styles.peak}> ★</span> : null}
      </span>
    )
  }

  // Pyramid / wave / anything with varying weight.
  return (
    <span className={styles.pattern}>
      {sets.map((s, i) => {
        const w = weightLabel(s)
        const r = repsLabel(s, isUnilateral)
        const peak = s.is_peak ? <span className={styles.peak}> ★</span> : null
        return (
          <span key={i}>
            {i > 0 ? <span className={styles.arrow}> → </span> : null}
            <span>
              {w}×{r}
            </span>
            {peak}
          </span>
        )
      })}
    </span>
  )
}

function weightLabel(s: SnapshotSetTarget): string {
  if (s.target_weight != null) return String(s.target_weight)
  if (s.target_pct_1rm != null) return `${Math.round(s.target_pct_1rm * 100)}%`
  return 'BW'
}

function repsLabel(s: SnapshotSetTarget, isUnilateral?: boolean): string {
  if (s.target_reps != null) return isUnilateral || s.target_reps_each ? `${s.target_reps} ea` : String(s.target_reps)
  if (s.target_duration_sec != null) return `${s.target_duration_sec}s`
  return '—'
}

function anyPeak(sets: SnapshotSetTarget[]): boolean {
  return sets.some((s) => s.is_peak)
}

function formatStraight(set: SnapshotSetTarget, count: number, isUnilateral?: boolean): string {
  return `${weightLabel(set)} × ${repsLabel(set, isUnilateral)} × ${count}`
}

function formatVariedReps(sets: SnapshotSetTarget[], isUnilateral?: boolean): string {
  const w = weightLabel(sets[0]!)
  const reps = sets.map((s) => repsLabel(s, isUnilateral)).join(', ')
  return `${w} × ${reps}`
}

function formatTime(sets: SnapshotSetTarget[], isUnilateral?: boolean): string {
  const first = sets[0]!
  const allSame = sets.every((s) => s.target_duration_sec === first.target_duration_sec)
  if (allSame) {
    return `${weightLabel(first)} · ${first.target_duration_sec}s × ${sets.length}${isUnilateral ? ' ea' : ''}`
  }
  return sets.map((s) => `${weightLabel(s)} · ${s.target_duration_sec}s`).join(' → ')
}
