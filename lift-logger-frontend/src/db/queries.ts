// Reactive queries over Dexie. Thin wrappers around useLiveQuery.

import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import type {
  BlockExerciseId,
  ExerciseId,
  SessionId,
  WorkoutBlockId,
  WorkoutId,
} from '../types/ids'
import type {
  BlockExerciseRow,
  BlockExerciseSetRow,
  ExerciseRow,
  SessionRow,
  SessionSetRow,
  SnapshotBlock,
  SnapshotBlockExercise,
  SnapshotSetTarget,
  WorkoutBlockRow,
  WorkoutRow,
  WorkoutSnapshot,
} from '../types/schema'
import { parseJsonArray } from '../shared/utils/format'

export function useAllWorkouts(): WorkoutRow[] | undefined {
  return useLiveQuery(() => db.workouts.orderBy('updated_at').reverse().toArray(), [])
}

export function useWorkout(id: WorkoutId | string | undefined): WorkoutRow | undefined {
  return useLiveQuery(async () => {
    if (!id) return undefined
    return db.workouts.get(id)
  }, [id])
}

export function useAllExercises(): ExerciseRow[] | undefined {
  return useLiveQuery(() => db.exercises.orderBy('name').toArray(), [])
}

export function useExercisesByIds(ids: string[]): Map<string, ExerciseRow> | undefined {
  return useLiveQuery(async () => {
    const rows = await db.exercises.where('id').anyOf(ids).toArray()
    return new Map(rows.map((r) => [r.id, r]))
  }, [ids.join(',')])
}

export function useActiveSession(): SessionRow | undefined {
  return useLiveQuery(async () => {
    const rows = await db.sessions.where('status').equals('active').toArray()
    return rows.sort((a, b) => b.started_at - a.started_at)[0]
  }, [])
}

export function useSession(id: SessionId | string | undefined): SessionRow | undefined {
  return useLiveQuery(async () => {
    if (!id) return undefined
    return db.sessions.get(id)
  }, [id])
}

export function useSessionSets(sessionId: SessionId | string | undefined): SessionSetRow[] | undefined {
  return useLiveQuery(async () => {
    if (!sessionId) return []
    return db.session_sets
      .where('session_id')
      .equals(sessionId)
      .sortBy('logged_at')
  }, [sessionId])
}

// ─── snapshot assembly (used when starting a session) ─────────────────

export async function buildWorkoutSnapshot(workoutId: WorkoutId | string): Promise<WorkoutSnapshot | null> {
  const workout = await db.workouts.get(workoutId)
  if (!workout) return null

  const blocks = await db.workout_blocks
    .where('workout_id')
    .equals(workoutId)
    .sortBy('position')

  const snapshotBlocks: SnapshotBlock[] = []
  for (const b of blocks) {
    const beRows = await db.block_exercises
      .where('block_id')
      .equals(b.id as unknown as string)
      .sortBy('position')

    const exerciseIds = beRows.map((r) => r.exercise_id)
    const exRows = await db.exercises.where('id').anyOf(exerciseIds).toArray()
    const exMap = new Map(exRows.map((r) => [r.id, r]))

    const beSnapshots: SnapshotBlockExercise[] = []
    for (const be of beRows) {
      const setRows = await db.block_exercise_sets
        .where('block_exercise_id')
        .equals(be.id as unknown as string)
        .sortBy('set_number')

      const ex = exMap.get(be.exercise_id)
      beSnapshots.push({
        id: be.id,
        exercise_id: be.exercise_id,
        name: ex?.name ?? '(unknown)',
        position: be.position,
        alt_exercise_ids: parseJsonArray(be.alt_exercise_ids) as (typeof be.exercise_id)[],
        sets: setRows.map(rowToSetTarget),
      })
    }

    snapshotBlocks.push({
      id: b.id,
      position: b.position,
      kind: b.kind,
      rounds: b.rounds,
      rest_after_sec: b.rest_after_sec,
      setup_cue: b.setup_cue,
      exercises: beSnapshots,
    })
  }

  return {
    workout_id: workout.id,
    name: workout.name,
    snapshot_at: Date.now(),
    blocks: snapshotBlocks,
  }
}

function rowToSetTarget(r: BlockExerciseSetRow): SnapshotSetTarget {
  return {
    set_number: r.set_number,
    target_weight: r.target_weight,
    target_pct_1rm: r.target_pct_1rm,
    target_reps: r.target_reps,
    target_reps_each: r.target_reps_each === 1,
    target_duration_sec: r.target_duration_sec,
    target_rpe: r.target_rpe,
    is_peak: r.is_peak === 1,
    rest_after_sec: r.rest_after_sec,
    notes: r.notes,
  }
}

// ─── helpers for Overview/Transition rendering ────────────────────────

export function useWorkoutBlocks(workoutId: WorkoutId | string | undefined): WorkoutBlockRow[] | undefined {
  return useLiveQuery(async () => {
    if (!workoutId) return []
    return db.workout_blocks.where('workout_id').equals(workoutId).sortBy('position')
  }, [workoutId])
}

export function useBlockExercises(blockId: WorkoutBlockId | string | undefined): BlockExerciseRow[] | undefined {
  return useLiveQuery(async () => {
    if (!blockId) return []
    return db.block_exercises.where('block_id').equals(blockId).sortBy('position')
  }, [blockId])
}

export function useBlockExerciseSets(beId: BlockExerciseId | string | undefined): BlockExerciseSetRow[] | undefined {
  return useLiveQuery(async () => {
    if (!beId) return []
    return db.block_exercise_sets.where('block_exercise_id').equals(beId).sortBy('set_number')
  }, [beId])
}

// Most recent actuals for a given exercise, limited. Used to show "Last time" hints.
export async function lastActualForExercise(
  exerciseId: ExerciseId | string,
): Promise<SessionSetRow | null> {
  const rows = await db.session_sets
    .where('exercise_id')
    .equals(exerciseId)
    .filter((r) => r.actual_weight !== null || r.actual_reps !== null || r.actual_duration_sec !== null)
    .reverse()
    .sortBy('logged_at')
  return rows[0] ?? null
}
