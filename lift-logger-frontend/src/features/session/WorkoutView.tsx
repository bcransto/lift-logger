// Workout view overlay — opened via the "Workout" button in Block view header.
// Shows all blocks with status (done/current/skipped/pending). Actions: Skip
// Block, Return to skipped block, End Workout. Closed via the header Back
// button.

import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import type { SessionSetRow, WorkoutSnapshot } from '../../types/schema'
import styles from './WorkoutView.module.css'

type Props = { onClose: () => void }

export function WorkoutViewOverlay({ onClose }: Props) {
  const sessionId = useSessionStore((s) => s.sessionId)
  const cursor = useSessionStore((s) => s.cursor)
  const skippedBlockIds = useSessionStore((s) => s.skippedBlockIds)
  const skipBlock = useSessionStore((s) => s.skipBlock)
  const returnToBlock = useSessionStore((s) => s.returnToBlock)
  const endWorkout = useSessionStore((s) => s.endWorkout)
  const navigate = useNavigate()

  const session = useLiveQuery(() => (sessionId ? db.sessions.get(sessionId) : undefined), [sessionId])
  const logged = useLiveQuery<SessionSetRow[]>(
    async () => (sessionId ? await db.session_sets.where('session_id').equals(sessionId).toArray() : []),
    [sessionId],
  )

  const snapshot = useMemo<WorkoutSnapshot | null>(() => {
    if (!session?.workout_snapshot) return null
    try { return JSON.parse(session.workout_snapshot) as WorkoutSnapshot } catch { return null }
  }, [session])

  // Close via the header "← Back" button. No swipe gestures.

  if (!snapshot) return null

  const loggedKeys = new Set(
    (logged ?? []).map((r) => `${r.block_position}.${r.block_exercise_position}.${r.round_number}.${r.set_number}`),
  )

  const blockStatus = (blockPos: number, blockId: string): 'done' | 'current' | 'skipped' | 'pending' => {
    if (skippedBlockIds.has(blockId)) return 'skipped'
    const b = snapshot.blocks.find((x) => x.position === blockPos)!
    const rounds = b.kind === 'single' ? 1 : b.rounds
    let totalSets = 0
    let doneSets = 0
    for (let r = 1; r <= rounds; r++) {
      for (const be of b.exercises) {
        for (const t of be.sets) {
          totalSets++
          const key = `${b.position}.${be.position}.${r}.${t.set_number}`
          if (loggedKeys.has(key)) doneSets++
        }
      }
    }
    if (doneSets >= totalSets && totalSets > 0) return 'done'
    if (cursor && cursor.blockPosition === blockPos) return 'current'
    return 'pending'
  }

  const onEnd = async () => {
    let unlogged = 0
    for (const b of snapshot.blocks) {
      if (skippedBlockIds.has(b.id)) continue
      const rounds = b.kind === 'single' ? 1 : b.rounds
      for (let r = 1; r <= rounds; r++) {
        for (const be of b.exercises) {
          for (const t of be.sets) {
            const key = `${b.position}.${be.position}.${r}.${t.set_number}`
            if (!loggedKeys.has(key)) unlogged++
          }
        }
      }
    }
    if (unlogged > 0 && !window.confirm(`Finish workout? ${unlogged} unlogged set${unlogged === 1 ? '' : 's'}.`)) return
    await endWorkout()
    if (sessionId) navigate(`/session/${sessionId}/summary`, { replace: true })
  }

  return (
    <div className={styles.overlay}>
      <header className={styles.header}>
        <button className={styles.back} onClick={onClose}>← Back</button>
        <div className={styles.eyebrow}>WORKOUT</div>
        <div />
      </header>

      <ol className={styles.list}>
        {snapshot.blocks.map((b, i) => {
          const status = blockStatus(b.position, b.id)
          return (
            <li key={b.id} className={`${styles.row} ${styles[status]}`}>
              <div className={styles.rowHead}>
                <span className={styles.num}>{String(i + 1).padStart(2, '0')}</span>
                <div className={styles.body}>
                  <div className={styles.exList}>
                    {b.exercises.map((e) => e.name).join(' + ')}
                  </div>
                  <div className={styles.meta}>
                    {b.kind === 'single' ? 'Straight' : `${b.kind} × ${b.rounds}`}
                    {status !== 'pending' ? ` · ${status.toUpperCase()}` : ''}
                  </div>
                </div>
              </div>
              <div className={styles.rowActions}>
                {status === 'current' ? (
                  <button className={styles.actionBtn} onClick={() => skipBlock(b.id)}>Skip Block</button>
                ) : null}
                {status === 'skipped' ? (
                  <button className={styles.actionBtn} onClick={() => returnToBlock(b.id)}>Return</button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>

      <div className={styles.footer}>
        <button className={styles.endBtn} onClick={onEnd}>End Workout</button>
      </div>
    </div>
  )
}
