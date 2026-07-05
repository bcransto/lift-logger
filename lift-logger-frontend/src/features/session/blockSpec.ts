// NewBlockSpec — structural description of a block as collected by
// AddBlockOverlay (issue #4). Deliberately store-free: the overlay emits a
// spec and the *caller* commits it. appendBlockToCurrentSession writes it
// into the session snapshot; issue #32's appendBlockToWorkout will write
// template rows from the same spec.

import type {
  SnapshotBlock,
  SnapshotBlockExercise,
  SnapshotSetTarget,
} from '../../types/schema'
import { uuid } from '../../shared/utils/uuid'

export type NewBlockExerciseSpec = {
  exerciseId: string
  name: string
  /** Prefilled from the exercise's LAST (prior session's best set); null = no target. */
  targetWeight: number | null
  targetReps: number | null
}

export type NewBlockSpec =
  | {
      kind: 'single'
      exercise: NewBlockExerciseSpec
      setCount: number
      restBetweenSetsSec: number
    }
  | {
      kind: 'superset'
      exercises: NewBlockExerciseSpec[]
      rounds: number
      restBetweenRoundsSec: number
    }
  | {
      kind: 'circuit'
      exercises: NewBlockExerciseSpec[]
      rounds: number
      work: { mode: 'timed'; durationSec: number } | { mode: 'reps' }
      restBetweenStationsSec: number
      restBetweenRoundsSec: number
    }

function exerciseFromSpec(
  ex: NewBlockExerciseSpec,
  position: number,
  sets: SnapshotSetTarget[],
): SnapshotBlockExercise {
  return {
    id: uuid('be') as unknown as SnapshotBlockExercise['id'],
    exercise_id: ex.exerciseId as unknown as SnapshotBlockExercise['exercise_id'],
    name: ex.name,
    position,
    alt_exercise_ids: [],
    sets,
  }
}

/**
 * Build a SnapshotBlock from a NewBlockSpec at the given block position.
 * Superset/circuit generate round-1 anchor sets only — rounds 2+ inherit
 * via setsForRound, the same mechanism template-authored blocks use.
 */
export function blockFromSpec(spec: NewBlockSpec, position: number): SnapshotBlock {
  const id = uuid('block') as unknown as SnapshotBlock['id']

  if (spec.kind === 'single') {
    const sets: SnapshotSetTarget[] = []
    for (let s = 1; s <= spec.setCount; s++) {
      sets.push({
        set_number: s,
        round_number: 1,
        target_weight: spec.exercise.targetWeight,
        target_reps: spec.exercise.targetReps,
        target_duration_sec: null,
        target_reps_each: false,
        is_peak: false,
        rest_after_sec: spec.restBetweenSetsSec,
      })
    }
    return {
      id,
      position,
      kind: 'single',
      rounds: 1,
      // Between-block rest: none configured → count-up after the last set.
      rest_after_sec: null,
      setup_cue: null,
      exercises: [exerciseFromSpec(spec.exercise, 1, sets)],
    }
  }

  if (spec.kind === 'superset') {
    return {
      id,
      position,
      kind: 'superset',
      rounds: spec.rounds,
      rest_after_sec: spec.restBetweenRoundsSec,
      setup_cue: null,
      exercises: spec.exercises.map((ex, i) =>
        exerciseFromSpec(ex, i + 1, [
          {
            set_number: 1,
            round_number: 1,
            target_weight: ex.targetWeight,
            target_reps: ex.targetReps,
            target_duration_sec: null,
            target_reps_each: false,
            is_peak: false,
            // No rest within the round; the round boundary falls back to
            // block rest because 0 is not > 0 in restAtBoundary.
            rest_after_sec: 0,
          },
        ]),
      ),
    }
  }

  const lastIdx = spec.exercises.length - 1
  const timed = spec.work.mode === 'timed'
  const workSec = spec.work.mode === 'timed' ? spec.work.durationSec : null
  return {
    id,
    position,
    kind: 'circuit',
    rounds: spec.rounds,
    rest_after_sec: spec.restBetweenRoundsSec,
    setup_cue: null,
    exercises: spec.exercises.map((ex, i) =>
      exerciseFromSpec(ex, i + 1, [
        {
          set_number: 1,
          round_number: 1,
          target_weight: ex.targetWeight,
          target_reps: timed ? null : ex.targetReps,
          target_duration_sec: workSec,
          target_reps_each: false,
          is_peak: false,
          // Last station: null so restAtBoundary falls back to the block's
          // between-rounds rest — a set rest > 0 would win at the boundary.
          rest_after_sec: i === lastIdx ? null : spec.restBetweenStationsSec,
        },
      ]),
    ),
  }
}
