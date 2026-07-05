// Template-table mutations (issue #32). Rows written here sync to the
// server via the generic LWW upsert — appends land at fresh positions, so
// there's no UNIQUE(position) collision risk (that only bites reorders,
// which is why block reorder stays session-only).

import { db } from './db'
import { blockFromSpec, type NewBlockSpec } from '../features/session/blockSpec'
import { uuid } from '../shared/utils/uuid'
import type {
  BlockExerciseRow,
  BlockExerciseSetRow,
  WorkoutBlockRow,
  WorkoutRow,
} from '../types/schema'

/** Insert an empty user-created workout and return its id. */
export async function createEmptyWorkout(name: string): Promise<string> {
  const now = Date.now()
  const id = uuid('wk')
  const row: WorkoutRow = {
    id: id as unknown as WorkoutRow['id'],
    name,
    description: null,
    tags: '[]',
    starred: 0,
    est_duration: null,
    created_by: 'user',
    created_at: now,
    updated_at: now,
    last_performed: null,
    deleted_at: null,
  }
  await db.workouts.put(row)
  return id
}

/**
 * Append a block to a workout's template tables (pre-session + Add Block).
 * Reuses blockFromSpec so the generated structure is identical to the
 * session-snapshot path (appendBlockToCurrentSession) — one builder, two
 * committers. Bumps workouts.updated_at so other clients pull the change.
 */
export async function appendBlockToWorkout(workoutId: string, spec: NewBlockSpec): Promise<void> {
  const now = Date.now()
  const existing = await db.workout_blocks.where('workout_id').equals(workoutId).toArray()
  const nextPosition = existing.reduce((m, b) => Math.max(m, b.position), 0) + 1
  const block = blockFromSpec(spec, nextPosition)

  const blockRow: WorkoutBlockRow = {
    id: block.id,
    workout_id: workoutId as unknown as WorkoutBlockRow['workout_id'],
    position: block.position,
    kind: block.kind,
    rounds: block.rounds,
    rest_after_sec: block.rest_after_sec,
    setup_cue: block.setup_cue,
    created_at: now,
    updated_at: now,
  }
  await db.workout_blocks.put(blockRow)

  for (const be of block.exercises) {
    const beRow: BlockExerciseRow = {
      id: be.id,
      block_id: block.id,
      exercise_id: be.exercise_id,
      position: be.position,
      alt_exercise_ids: JSON.stringify(be.alt_exercise_ids),
      created_at: now,
      updated_at: now,
    }
    await db.block_exercises.put(beRow)

    for (const s of be.sets) {
      const setRow: BlockExerciseSetRow = {
        id: uuid('bes') as unknown as BlockExerciseSetRow['id'],
        block_exercise_id: be.id,
        set_number: s.set_number,
        round_number: s.round_number ?? 1,
        target_weight: s.target_weight ?? null,
        target_pct_1rm: s.target_pct_1rm ?? null,
        target_reps: s.target_reps ?? null,
        target_reps_each: s.target_reps_each ? 1 : 0,
        target_duration_sec: s.target_duration_sec ?? null,
        target_rpe: s.target_rpe ?? null,
        is_peak: s.is_peak ? 1 : 0,
        rest_after_sec: s.rest_after_sec ?? null,
        notes: s.notes ?? null,
        created_at: now,
        updated_at: now,
      }
      await db.block_exercise_sets.put(setRow)
    }
  }

  const w = await db.workouts.get(workoutId)
  if (w) await db.workouts.put({ ...w, updated_at: now })
}
