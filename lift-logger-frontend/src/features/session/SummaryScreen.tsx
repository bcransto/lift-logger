import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import { syncService } from '../../sync/syncService'
import { Button } from '../../shared/components/Button'
import { dowShort, monShort, timeShort, mmss } from '../../shared/utils/format'
import type { SessionSetRow, WorkoutSnapshot } from '../../types/schema'
import styles from './SummaryScreen.module.css'

export function SummaryScreen() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const complete = useSessionStore((s) => s.completeSession)
  const [completing, setCompleting] = useState(false)

  const session = useLiveQuery(() => (sessionId ? db.sessions.get(sessionId) : undefined), [sessionId])
  const sets = useLiveQuery<SessionSetRow[]>(
    async () => (sessionId ? await db.session_sets.where('session_id').equals(sessionId).sortBy('logged_at') : []),
    [sessionId],
  )

  const snapshot = useMemo<WorkoutSnapshot | null>(() => {
    if (!session?.workout_snapshot) return null
    try {
      return JSON.parse(session.workout_snapshot) as WorkoutSnapshot
    } catch {
      return null
    }
  }, [session])

  // Kick off one final sync on mount (best effort).
  useEffect(() => {
    void syncService.sync()
  }, [])

  if (!session) return <div className={styles.empty}>Loading…</div>

  const durationSec = session.ended_at
    ? Math.round((session.ended_at - session.started_at) / 1000)
    : Math.round((Date.now() - session.started_at) / 1000)

  const totalVolume = (sets ?? []).reduce(
    (sum, r) => sum + (r.actual_weight ?? 0) * (r.actual_reps ?? 0),
    0,
  )

  const prs = (sets ?? []).filter((r) => r.is_pr === 1)

  // Group sets by exercise_id for the log.
  const exerciseOrder: string[] = []
  const byExercise = new Map<string, SessionSetRow[]>()
  for (const r of sets ?? []) {
    if (!byExercise.has(r.exercise_id)) {
      byExercise.set(r.exercise_id, [])
      exerciseOrder.push(r.exercise_id)
    }
    byExercise.get(r.exercise_id)!.push(r)
  }

  const nameOf = (exerciseId: string): string => {
    if (!snapshot) return exerciseId
    for (const b of snapshot.blocks)
      for (const be of b.exercises)
        if (be.exercise_id === exerciseId) return be.name
    return exerciseId
  }

  const onDone = async () => {
    if (completing) return
    setCompleting(true)
    await complete()
    void syncService.sync()
    navigate('/', { replace: true })
  }

  const now = Date.now()

  return (
    <div className={styles.root}>
      <div className={styles.eyebrow}>WORKOUT COMPLETE</div>
      <h1 className={styles.display}>
        Done<span className={styles.dot}>.</span>
      </h1>
      <div className={styles.date}>
        {dowShort(session.started_at)} · {monShort(session.started_at)} {new Date(session.started_at).getDate()} · {timeShort(now)}
      </div>

      <div className={styles.stats}>
        <StatCell value={mmss(durationSec)} label="Duration" />
        <StatCell value={formatVolume(totalVolume)} label="Vol lbs" />
        <StatCell value={String(sets?.length ?? 0)} label="Sets" />
      </div>

      {prs.length > 0 ? (
        <div className={styles.prs}>
          <div className={styles.prsLabel}>★ {prs.length} PERSONAL {prs.length === 1 ? 'RECORD' : 'RECORDS'}</div>
          <ul className={styles.prsList}>
            {prs.map((r) => (
              <li key={r.id}>
                {nameOf(r.exercise_id).toUpperCase()} {r.actual_weight}×{r.actual_reps}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.log}>
        <div className={styles.logLabel}>SESSION LOG</div>
        {exerciseOrder.map((exId) => {
          const rows = byExercise.get(exId)!
          const hasPr = rows.some((r) => r.is_pr === 1)
          const vol = rows.reduce((s, r) => s + (r.actual_weight ?? 0) * (r.actual_reps ?? 0), 0)
          return (
            <div key={exId} className={styles.logRow}>
              <div className={styles.logName}>
                {nameOf(exId)}
                {hasPr ? ' ★' : ''}
              </div>
              <div className={styles.logSets}>
                {rows.map((r, i) => (
                  <span key={r.id}>
                    {i > 0 ? ' · ' : ''}
                    {r.actual_weight ?? '—'}×{r.actual_reps ?? r.actual_duration_sec ?? '—'}
                  </span>
                ))}
              </div>
              <div className={styles.logVol}>{formatVolume(vol)}</div>
            </div>
          )
        })}
      </div>

      <div className={styles.footer}>
        <Button variant="primary" block onClick={onDone}>
          Done
        </Button>
        <Button variant="ghost" block onClick={() => alert('Notes — coming soon')}>
          Add note
        </Button>
      </div>
    </div>
  )
}

function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  )
}

function formatVolume(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}
