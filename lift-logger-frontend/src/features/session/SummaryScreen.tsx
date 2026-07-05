import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import { syncService } from '../../sync/syncService'
import { Button } from '../../shared/components/Button'
import { dowShort, monShort, timeShort, mmss } from '../../shared/utils/format'
import { setsForRound } from './sessionEngine'
import type { SessionSetRow, WorkoutSnapshot } from '../../types/schema'
import styles from './SummaryScreen.module.css'

export function SummaryScreen() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const complete = useSessionStore((s) => s.completeSession)
  const reopenSession = useSessionStore((s) => s.reopenSession)
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

  // Skipped rows (skipped:1) are placeholders, not work — exclude them from
  // stats, volume, and the per-exercise set lines.
  const realLogs = (sets ?? []).filter((r) => r.skipped !== 1)

  const totalVolume = realLogs.reduce(
    (sum, r) => sum + (r.actual_weight ?? 0) * (r.actual_reps ?? 0),
    0,
  )

  const prs = realLogs.filter((r) => r.is_pr === 1)

  // Session log — one entry per (block, exercise) in workout order, built
  // from the frozen snapshot so unreached/skipped exercises still appear.
  // Status derives purely from planned-vs-logged counts; block dispositions
  // (done_block_ids / skipped_block_ids) deliberately don't change the
  // label — once the workout is over, "2 of 5 sets" is the fact that
  // matters, not which button abandoned the block.
  type EntryStatus = 'done' | 'partial' | 'skipped'
  const entries = (snapshot?.blocks ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .flatMap((b) => {
      const rounds = b.kind === 'single' ? 1 : b.rounds
      return b.exercises
        .slice()
        .sort((x, y) => x.position - y.position)
        .map((be) => {
          let planned = 0
          for (let r = 1; r <= rounds; r++) planned += setsForRound(be, r).length
          const rows = realLogs.filter(
            (r) => r.block_position === b.position && r.block_exercise_position === be.position,
          )
          const total = Math.max(planned, rows.length)
          const status: EntryStatus =
            rows.length === 0 ? 'skipped' : rows.length >= total ? 'done' : 'partial'
          return {
            key: `${b.position}.${be.position}`,
            name: be.name,
            rows,
            done: rows.length,
            total,
            status,
            hasPr: rows.some((r) => r.is_pr === 1),
            vol: rows.reduce((s, r) => s + (r.actual_weight ?? 0) * (r.actual_reps ?? 0), 0),
          }
        })
    })

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

  // Undo an accidental End Workout (issue #30): flip the session back to
  // active and land on the workout's OverviewScreen, where Resume takes the
  // user back to their exact block.
  const onReturnToWorkout = async () => {
    if (completing || !session.workout_id) return
    await reopenSession(session.id)
    navigate(`/workout/${session.workout_id}`, { replace: true })
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
        <StatCell value={String(realLogs.length)} label="Sets" />
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
        {entries.map((e) => (
          <div key={e.key} className={styles.logRow}>
            <div className={styles.logName}>
              {e.name}
              {e.hasPr ? ' ★' : ''}
            </div>
            <div className={`${styles.statusPill} ${styles[`status_${e.status}`]}`}>
              {e.status.toUpperCase()} {e.done}/{e.total}
            </div>
            <div className={styles.logSets}>
              {e.rows.length === 0
                ? '—'
                : e.rows.map((r, i) => (
                    <span key={r.id}>
                      {i > 0 ? ' · ' : ''}
                      {r.actual_weight ?? '—'}×{r.actual_reps ?? r.actual_duration_sec ?? '—'}
                    </span>
                  ))}
            </div>
            <div className={styles.logVol}>{e.vol > 0 ? formatVolume(e.vol) : ''}</div>
          </div>
        ))}
      </div>

      <div className={styles.footer}>
        <Button variant="primary" block onClick={onDone}>
          Done
        </Button>
        {session.workout_id ? (
          <Button variant="ghost" block onClick={() => void onReturnToWorkout()}>
            ← Return to workout
          </Button>
        ) : null}
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
