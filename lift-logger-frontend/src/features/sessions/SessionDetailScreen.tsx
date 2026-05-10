// SessionDetailScreen — read-only view of a completed session.
//
// Renders the workout_snapshot block-by-block, overlaying actual session_sets
// values on each set. Footer has a delete button that hits the API endpoint
// and pulls fresh exercise_prs after the recompute.

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import type { SessionSetRow, WorkoutSnapshot } from '../../types/schema'
import { Button } from '../../shared/components/Button'
import { dowShort, monShort, timeShort, mmss } from '../../shared/utils/format'
import { cursorKeyFromRow } from '../session/sessionEngine'
import { deleteSession } from './deleteSession'
import styles from './SessionDetailScreen.module.css'

const CONFIRM_COPY =
  'Delete this session? Any PRs it set will be recomputed from your remaining history. This can\'t be undone.'

export function SessionDetailScreen() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const session = useLiveQuery(
    () => (id ? db.sessions.get(id) : undefined),
    [id],
  )
  const sets = useLiveQuery<SessionSetRow[]>(
    async () => (id ? await db.session_sets.where('session_id').equals(id).toArray() : []),
    [id],
  )

  // Index actuals by cursor key for O(1) lookup during render.
  const setByKey = useMemo(() => {
    const m = new Map<string, SessionSetRow>()
    for (const r of sets ?? []) m.set(cursorKeyFromRow(r), r)
    return m
  }, [sets])

  const snapshot = useMemo<WorkoutSnapshot | null>(() => {
    if (!session?.workout_snapshot) return null
    try {
      return JSON.parse(session.workout_snapshot) as WorkoutSnapshot
    } catch {
      return null
    }
  }, [session])

  if (!id) return <div className={styles.empty}>Missing session id.</div>
  if (session === undefined) return <div className={styles.empty}>Loading…</div>
  if (session === null || !session) {
    return (
      <div className={styles.root}>
        <div className={styles.empty}>Session not found.</div>
        <Button variant="secondary" block onClick={() => navigate('/sessions')}>
          Back to Sessions
        </Button>
      </div>
    )
  }

  const durationSec =
    session.duration_sec ??
    (session.ended_at
      ? Math.round((session.ended_at - session.started_at) / 1000)
      : 0)

  const onDelete = async () => {
    if (deleting) return
    if (!window.confirm(CONFIRM_COPY)) return
    setError(null)
    setDeleting(true)
    try {
      await deleteSession(id)
      navigate('/sessions', { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDeleting(false)
    }
  }

  const prs = (sets ?? []).filter((r) => r.is_pr === 1).length

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => navigate('/sessions')}
          aria-label="Back to sessions"
        >
          ← Sessions
        </button>
      </header>

      <h1 className={styles.title}>{snapshot?.name ?? 'Workout'}</h1>
      <div className={styles.date}>
        {dowShort(session.started_at)} · {monShort(session.started_at)}{' '}
        {new Date(session.started_at).getDate()} · {timeShort(session.started_at)}
      </div>

      <div className={styles.stats}>
        <Stat label="Duration" value={mmss(durationSec)} />
        <Stat label="Sets" value={String((sets ?? []).filter((r) => r.skipped !== 1).length)} />
        <Stat label="PRs" value={String(prs)} />
      </div>

      {snapshot ? (
        <div className={styles.body}>
          {snapshot.blocks.map((block) => (
            <section key={block.id} className={styles.block}>
              <div className={styles.blockHeader}>
                <span className={styles.blockKind}>{block.kind.toUpperCase()}</span>
                {block.rounds > 1 ? (
                  <span className={styles.blockMeta}>· {block.rounds} rounds</span>
                ) : null}
              </div>

              {block.exercises.map((be) => {
                // Group sets-for-this-exercise by their snapshot order. Snapshot
                // sets already have round_number + set_number on them post-v3.
                return (
                  <div key={be.id} className={styles.exercise}>
                    <div className={styles.exerciseName}>{be.name}</div>
                    <ul className={styles.setList}>
                      {be.sets.map((target) => {
                        const round = target.round_number ?? 1
                        const key = `${block.position}.${be.position}.${round}.${target.set_number}`
                        const actual = setByKey.get(key)
                        return (
                          <SetLine
                            key={key}
                            roundLabel={block.rounds > 1 ? `R${round}` : null}
                            setNumber={target.set_number}
                            target={target}
                            actual={actual}
                          />
                        )
                      })}
                    </ul>
                  </div>
                )
              })}
            </section>
          ))}
        </div>
      ) : (
        <div className={styles.empty}>Snapshot unavailable for this session.</div>
      )}

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.footer}>
        <Button variant="danger" block disabled={deleting} onClick={onDelete}>
          {deleting ? 'Deleting…' : 'Delete session'}
        </Button>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statValue}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  )
}

function SetLine({
  roundLabel,
  setNumber,
  target,
  actual,
}: {
  roundLabel: string | null
  setNumber: number
  target: { target_weight?: number | null; target_reps?: number | null; target_duration_sec?: number | null }
  actual: SessionSetRow | undefined
}) {
  const targetText = formatTarget(target)
  const actualText = formatActual(actual)
  const skipped = actual?.skipped === 1
  const isPr = actual?.is_pr === 1

  return (
    <li className={`${styles.setLine} ${skipped ? styles.skipped : ''}`}>
      <span className={styles.setIdx}>
        {roundLabel ? `${roundLabel} · ` : ''}#{setNumber}
      </span>
      <span className={styles.setTarget}>{targetText || '—'}</span>
      <span className={styles.setArrow}>→</span>
      <span className={`${styles.setActual} ${skipped ? styles.skippedText : ''}`}>
        {skipped ? 'SKIPPED' : actualText || '—'}
      </span>
      {isPr ? <span className={styles.prBadge}>★</span> : null}
    </li>
  )
}

function formatTarget(t: {
  target_weight?: number | null
  target_reps?: number | null
  target_duration_sec?: number | null
}): string {
  const parts: string[] = []
  if (t.target_weight != null) parts.push(`${t.target_weight}`)
  if (t.target_reps != null) {
    parts.push(parts.length ? `× ${t.target_reps}` : `${t.target_reps} reps`)
  } else if (t.target_duration_sec != null) {
    parts.push(parts.length ? `× ${mmss(t.target_duration_sec)}` : mmss(t.target_duration_sec))
  }
  return parts.join(' ')
}

function formatActual(a: SessionSetRow | undefined): string {
  if (!a) return ''
  if (a.skipped === 1) return ''
  const parts: string[] = []
  if (a.actual_weight != null) parts.push(`${a.actual_weight}`)
  if (a.actual_reps != null) {
    parts.push(parts.length ? `× ${a.actual_reps}` : `${a.actual_reps} reps`)
  } else if (a.actual_duration_sec != null) {
    parts.push(parts.length ? `× ${mmss(a.actual_duration_sec)}` : mmss(a.actual_duration_sec))
  }
  return parts.join(' ')
}
