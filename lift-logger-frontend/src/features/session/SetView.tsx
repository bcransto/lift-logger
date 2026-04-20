// Set view overlay — swipe-right-to-left from Block view. Always targets the
// currently focused set (cursor). Weight / reps / duration steppers. Edits
// stash on sessions.pending_actuals; logSet consumes them on Next or timer
// zero. Active timer pinned at top.

import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useSwipeable } from 'react-swipeable'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import { NumberStepper } from '../../shared/components/NumberStepper'
import { TimerDock } from './TimerDock'
import type { PendingActuals, SessionSetRow, WorkoutSnapshot } from '../../types/schema'
import styles from './SetView.module.css'

export function SetViewOverlay({ onClose }: { onClose: () => void }) {
  const sessionId = useSessionStore((s) => s.sessionId)
  const cursor = useSessionStore((s) => s.cursor)
  const pendingActuals = useSessionStore((s) => s.pendingActuals)
  const setPending = useSessionStore((s) => s.setPendingActuals)

  const session = useLiveQuery(() => (sessionId ? db.sessions.get(sessionId) : undefined), [sessionId])
  const lastSet = useLiveQuery<SessionSetRow | undefined>(
    async () => {
      if (!sessionId) return undefined
      const rows = await db.session_sets.where('session_id').equals(sessionId).toArray()
      return rows.sort((a, b) => b.logged_at - a.logged_at)[0]
    },
    [sessionId],
  )

  const snapshot = useMemo<WorkoutSnapshot | null>(() => {
    if (!session?.workout_snapshot) return null
    try { return JSON.parse(session.workout_snapshot) as WorkoutSnapshot } catch { return null }
  }, [session])

  const target = useMemo(() => {
    if (!snapshot || !cursor) return null
    const b = snapshot.blocks.find((x) => x.position === cursor.blockPosition)
    const be = b?.exercises.find((e) => e.position === cursor.blockExercisePosition)
    return be?.sets.find((s) => s.set_number === cursor.setNumber) ?? null
  }, [snapshot, cursor])

  const [weight, setWeight] = useState<number | null>(null)
  const [reps, setReps] = useState<number | null>(null)
  const [duration, setDuration] = useState<number | null>(null)

  // Seed the fields from pendingActuals (if any), then from target.
  useEffect(() => {
    if (!target) return
    setWeight(pendingActuals?.actual_weight ?? target.target_weight ?? null)
    setReps(pendingActuals?.actual_reps ?? target.target_reps ?? null)
    setDuration(pendingActuals?.actual_duration_sec ?? target.target_duration_sec ?? null)
  }, [target, pendingActuals])

  // Swipe left-to-right closes the overlay (back to Block view).
  const swipe = useSwipeable({
    onSwipedRight: onClose,
    delta: 40,
    preventScrollOnSwipe: false,
  })

  const commit = async () => {
    const patch: PendingActuals = {
      actual_weight: weight,
      actual_reps: reps,
      actual_duration_sec: duration,
    }
    await setPending(patch)
  }

  const beName = (() => {
    if (!snapshot || !cursor) return ''
    const b = snapshot.blocks.find((x) => x.position === cursor.blockPosition)
    const be = b?.exercises.find((e) => e.position === cursor.blockExercisePosition)
    return be?.name ?? ''
  })()

  const isTimed = target?.target_duration_sec != null
  const lastRestAfter = lastSet && target ? target.rest_after_sec ?? null : null

  if (!target) return null
  return (
    <div className={styles.overlay} {...swipe}>
      <header className={styles.header}>
        <button className={styles.back} onClick={onClose}>← Back</button>
        <div className={styles.eyebrow}>EDIT SET {target.set_number}</div>
        <div />
      </header>
      <h1 className={styles.display}>{beName}</h1>

      <TimerDock
        lastLoggedAt={lastSet?.logged_at ?? null}
        lastLoggedRestAfterSec={lastRestAfter}
        workTimerStartedAt={session?.work_timer_started_at ?? null}
        workTimerDurationSec={session?.work_timer_duration_sec ?? null}
      />

      {isTimed ? (
        <NumberStepper label="Duration" value={duration} step={5} min={0} unit="sec" onChange={(v) => { setDuration(v); void commit() }} allowNull />
      ) : (
        <div className={styles.grid}>
          <NumberStepper label="Weight" value={weight} step={5} unit="lb" onChange={(v) => { setWeight(v); void commit() }} allowNull />
          <NumberStepper label="Reps" value={reps} step={1} min={0} onChange={(v) => { setReps(v); void commit() }} allowNull />
        </div>
      )}

      <p className={styles.hint}>
        Edits save automatically. They apply when you tap <strong>Next</strong> (or when a timer hits zero).
      </p>
    </div>
  )
}
