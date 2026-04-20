import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import { buildWorkoutSnapshot } from '../../db/queries'
import { useSessionStore } from '../../stores/sessionStore'
import { Button } from '../../shared/components/Button'
import { SetPatternRenderer } from './SetPatternRenderer'
import { parseJsonArray, relativeDate } from '../../shared/utils/format'
import type { SnapshotBlock, WorkoutSnapshot } from '../../types/schema'
import styles from './OverviewScreen.module.css'

export function OverviewScreen() {
  const { workoutId } = useParams<{ workoutId: string }>()
  const navigate = useNavigate()
  const startSession = useSessionStore((s) => s.startSession)

  const workout = useLiveQuery(() => (workoutId ? db.workouts.get(workoutId) : undefined), [workoutId])
  const snapshot = useLiveQuery<WorkoutSnapshot | null | undefined>(
    async () => (workoutId ? await buildWorkoutSnapshot(workoutId) : undefined),
    [workoutId],
  )

  const exerciseMap = useLiveQuery(async () => {
    if (!snapshot) return new Map<string, { equipment: string[]; is_unilateral: boolean }>()
    const ids = new Set<string>()
    for (const b of snapshot.blocks) for (const be of b.exercises) ids.add(be.exercise_id)
    const rows = await db.exercises.where('id').anyOf([...ids]).toArray()
    return new Map(
      rows.map((r) => [
        r.id,
        {
          equipment: parseJsonArray(r.equipment) as string[],
          is_unilateral: r.is_unilateral === 1,
        },
      ]),
    )
  }, [snapshot])

  const totalLifts = useMemo(
    () => (snapshot ? snapshot.blocks.reduce((n, b) => n + b.exercises.length, 0) : 0),
    [snapshot],
  )

  if (!workout || !snapshot) {
    return <div className={styles.empty}>Loading…</div>
  }

  const onStart = async () => {
    const id = await startSession(workout.id)
    if (id) navigate(`/session/${id}/transition/1`, { replace: true })
  }

  return (
    <div className={styles.root}>
      <button type="button" className={styles.back} onClick={() => navigate('/')}>
        ← Back
      </button>

      <div className={styles.eyebrow}>OVERVIEW · {totalLifts} {totalLifts === 1 ? 'LIFT' : 'LIFTS'}</div>
      <h1 className={styles.display}>{workout.name}</h1>
      {workout.description ? <p className={styles.desc}>{workout.description}</p> : null}

      <div className={styles.pills}>
        {workout.est_duration ? <span className={styles.pill}>≈ {workout.est_duration} MIN</span> : null}
        {workout.last_performed ? (
          <span className={styles.pill}>LAST: {relativeDate(workout.last_performed).toUpperCase()}</span>
        ) : null}
        {workout.starred ? <span className={styles.pill}>★</span> : null}
      </div>

      <ol className={styles.blocks}>
        {snapshot.blocks.map((b, bi) => (
          <BlockRow
            key={b.id}
            block={b}
            startNumber={computeStartNumber(snapshot.blocks, bi)}
            exerciseMeta={exerciseMap}
          />
        ))}
      </ol>

      <div className={styles.startRow}>
        <Button variant="primary" block onClick={onStart}>
          Start Workout →
        </Button>
      </div>
    </div>
  )
}

function computeStartNumber(blocks: SnapshotBlock[], index: number): number {
  let n = 0
  for (let i = 0; i < index; i++) n += blocks[i]!.exercises.length
  return n + 1
}

function BlockRow({
  block,
  startNumber,
  exerciseMeta,
}: {
  block: SnapshotBlock
  startNumber: number
  exerciseMeta: Map<string, { equipment: string[]; is_unilateral: boolean }> | undefined
}) {
  const grouped = block.kind === 'superset' || block.kind === 'circuit'
  const label = block.kind === 'superset' ? 'SUPERSET' : block.kind === 'circuit' ? 'CIRCUIT' : null

  return (
    <li className={`${styles.block} ${grouped ? styles.grouped : ''}`}>
      {grouped ? <div className={styles.groupLabel}>┃ {label} × {block.rounds}</div> : null}
      <ul className={styles.exList}>
        {block.exercises.map((be, bei) => {
          const num = pad2(startNumber + bei)
          const subLabel = grouped ? String.fromCharCode(0x61 + bei) : ''
          const meta = exerciseMeta?.get(be.exercise_id)
          return (
            <li key={be.id} className={styles.exRow}>
              <div className={styles.num}>{num}{subLabel}</div>
              <div className={styles.exBody}>
                <div className={styles.exName}>
                  {be.name}
                  {meta?.equipment?.length ? (
                    <span className={styles.equipTags}>
                      {meta.equipment.map((e) => (
                        <span key={e} className={styles.equipTag}>{e.toUpperCase()}</span>
                      ))}
                    </span>
                  ) : null}
                </div>
                <SetPatternRenderer blockExercise={be} isUnilateral={meta?.is_unilateral} />
              </div>
            </li>
          )
        })}
      </ul>
    </li>
  )
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}
