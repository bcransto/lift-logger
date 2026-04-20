import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import { lastActualForExercise } from '../../db/queries'
import { useSessionStore } from '../../stores/sessionStore'
import { Button } from '../../shared/components/Button'
import { NumberStepper } from '../../shared/components/NumberStepper'
import { RestTimerCard } from './RestTimerCard'
import { parseSetKey, targetAt, totalSetCount } from './sessionEngine'
import type { WorkoutSnapshot } from '../../types/schema'
import type { ExerciseId } from '../../types/ids'
import { unlockAudio } from '../timer/chime'
import styles from './ActiveLiftScreen.module.css'

export function ActiveLiftScreen() {
  const { sessionId, blockPosition: bpStr, setKey } = useParams<{
    sessionId: string
    blockPosition: string
    setKey: string
  }>()
  const navigate = useNavigate()

  const session = useLiveQuery(() => (sessionId ? db.sessions.get(sessionId) : undefined), [sessionId])
  const snapshot = useMemo<WorkoutSnapshot | null>(() => {
    if (!session?.workout_snapshot) return null
    try {
      return JSON.parse(session.workout_snapshot) as WorkoutSnapshot
    } catch {
      return null
    }
  }, [session])

  const cursor = useSessionStore((s) => s.cursor)
  const logSet = useSessionStore((s) => s.logSet)
  const loggedCount = useSessionStore((s) => s.loggedCount)
  const jumpTo = useSessionStore((s) => s.jumpTo)

  // Sync cursor FROM the URL on URL changes (mount, browser back/forward, direct
  // navigate from logSet). Intentionally does NOT depend on cursor — otherwise
  // logSet's store update would race the URL change and the effect would snap
  // cursor back to the stale URL before navigate lands.
  useEffect(() => {
    const bp = Number.parseInt(bpStr ?? '1', 10)
    const parsed = parseSetKey(setKey ?? '')
    if (!parsed) return
    jumpTo({
      blockPosition: bp,
      blockExercisePosition: parsed.blockExercisePosition,
      roundNumber: parsed.roundNumber,
      setNumber: parsed.setNumber,
    })
  }, [bpStr, setKey, jumpTo])

  const entry = snapshot && cursor ? targetAt(snapshot, cursor) : null
  const total = snapshot ? totalSetCount(snapshot) : 0

  const [weight, setWeight] = useState<number | null>(null)
  const [reps, setReps] = useState<number | null>(null)
  const [durationSec, setDurationSec] = useState<number | null>(null)
  const [rpe, setRpe] = useState<number | null>(null)
  const [lastActual, setLastActual] = useState<{ w: number | null; r: number | null } | null>(null)

  // Reset inputs when the cursor changes to a new set. `entry` itself is a
  // fresh object reference every render — listing it here would re-run this
  // effect on every render and clobber user input. Depend only on the cursor
  // coordinates.
  useEffect(() => {
    if (!entry) return
    setWeight(entry.target.target_weight ?? null)
    setReps(entry.target.target_reps ?? null)
    setDurationSec(entry.target.target_duration_sec ?? null)
    setRpe(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entry?.cursor.blockPosition,
    entry?.cursor.blockExercisePosition,
    entry?.cursor.roundNumber,
    entry?.cursor.setNumber,
  ])

  // Look up "Last time" actual for this exercise.
  useEffect(() => {
    if (!entry) return
    void lastActualForExercise(entry.blockExercise.exercise_id as ExerciseId).then((r) => {
      setLastActual(r ? { w: r.actual_weight, r: r.actual_reps } : null)
    })
  }, [entry])

  if (!session || !snapshot) return <div className={styles.empty}>Loading…</div>
  if (!entry) {
    // Cursor missed — likely done.
    return (
      <div className={styles.empty}>
        <p>Workout complete.</p>
        <Button variant="primary" onClick={() => navigate(`/session/${sessionId}/summary`)}>
          See summary →
        </Button>
      </div>
    )
  }

  const isDuration = entry.target.target_duration_sec != null
  const setsInThisBE = entry.block.kind === 'single'
    ? entry.blockExercise.sets.length
    : entry.blockExercise.sets.length * entry.block.rounds
  const setsDoneInThisBE = computeDoneInBE(entry, loggedCount)

  const liftNumber = snapshot.blocks
    .filter((b) => b.position < entry.cursor.blockPosition)
    .reduce((n, b) => n + b.exercises.length, 0) + entry.blockExercise.position
  const totalLifts = snapshot.blocks.reduce((n, b) => n + b.exercises.length, 0)

  const onLog = async () => {
    unlockAudio()
    await logSet({
      actualWeight: weight,
      actualReps: reps,
      actualDurationSec: durationSec,
      rpe,
      restTakenSec: null,
    })
    // Determine next step from fresh store state.
    const next = useSessionStore.getState().cursor
    if (!next) {
      navigate(`/session/${sessionId}/summary`)
      return
    }
    if (next.blockPosition !== entry.cursor.blockPosition) {
      navigate(`/session/${sessionId}/transition/${next.blockPosition}`)
      return
    }
    const key = `${next.blockExercisePosition}.${next.roundNumber}.${next.setNumber}`
    navigate(`/session/${sessionId}/active/${next.blockPosition}/${key}`)
  }

  return (
    <div className={styles.root}>
      <div className={styles.progress}>
        <div className={styles.progressBar} style={{ width: `${(loggedCount / Math.max(1, total)) * 100}%` }} />
      </div>
      <div className={styles.topRow}>
        <span className={`${styles.badge} ${styles.accent}`}>LIFTING</span>
        <span className={styles.eyebrow}>LIFT {liftNumber} / {totalLifts}</span>
      </div>

      <h1 className={styles.display}>{entry.blockExercise.name}</h1>
      <div className={styles.eyebrow}>
        SET {setsDoneInThisBE + 1} OF {setsInThisBE}
        {entry.block.kind !== 'single' ? ` · ROUND ${entry.cursor.roundNumber}/${entry.block.rounds}` : ''}
      </div>

      <div className={styles.target}>
        <div className={styles.targetLabel}>TODAY'S TARGET</div>
        <div className={styles.targetMain}>
          {entry.target.target_weight ?? (entry.target.target_pct_1rm ? `${Math.round(entry.target.target_pct_1rm * 100)}%` : 'BW')}
          {' × '}
          {entry.target.target_reps ?? (entry.target.target_duration_sec ? `${entry.target.target_duration_sec}s` : '—')}
          {entry.target.is_peak ? ' ★' : ''}
        </div>
        {lastActual?.w != null && lastActual?.r != null ? (
          <div className={styles.targetLast}>Last time: {lastActual.w} × {lastActual.r}</div>
        ) : null}
      </div>

      {isDuration ? (
        <NumberStepper
          label="Duration"
          value={durationSec}
          step={5}
          min={0}
          unit="sec"
          onChange={setDurationSec}
          allowNull
        />
      ) : (
        <div className={styles.grid}>
          <NumberStepper label="Weight" value={weight} step={5} unit="lb" onChange={setWeight} allowNull />
          <NumberStepper label="Reps Done" value={reps} step={1} min={0} onChange={setReps} allowNull />
        </div>
      )}

      <RestTimerCard
        title="REST"
        manualDurationSec={entry.target.rest_after_sec ?? entry.block.rest_after_sec ?? 90}
      />

      <div className={styles.footer}>
        <Button variant="primary" block onClick={onLog}>
          Log Set →
        </Button>
      </div>
    </div>
  )
}

function computeDoneInBE(
  entry: ReturnType<typeof targetAt> extends infer T ? T extends null ? never : T : never,
  _loggedCount: number,
): number {
  // Sets already done in this block_exercise across all rounds up to and
  // including this one. For round-major execution, = (round - 1) * sets_per_round
  // + (set - 1). Reduces to (set - 1) for single-round blocks.
  const setsPerRound = entry.blockExercise.sets.length
  const roundIndex = (entry.cursor.roundNumber ?? 1) - 1
  const setIndex = (entry.cursor.setNumber ?? 1) - 1
  return roundIndex * setsPerRound + setIndex
}
