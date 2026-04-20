// In-memory mock backend for local dev until the IRON server is live.
// Seeds a handful of exercises + one pyramid workout + one superset workout
// so Home/Overview render something realistic.

import type {
  BlockExerciseRow,
  BlockExerciseSetRow,
  ExerciseRow,
  ExercisePrRow,
  SessionRow,
  SessionSetRow,
  SyncRequest,
  SyncResponse,
  WorkoutBlockRow,
  WorkoutRow,
} from '../types/schema'
import type {
  BlockExerciseId,
  BlockExerciseSetId,
  ExerciseId,
  WorkoutBlockId,
  WorkoutId,
} from '../types/ids'

const now = () => Date.now()

function seed(): {
  exercises: ExerciseRow[]
  workouts: WorkoutRow[]
  workout_blocks: WorkoutBlockRow[]
  block_exercises: BlockExerciseRow[]
  block_exercise_sets: BlockExerciseSetRow[]
  sessions: SessionRow[]
  session_sets: SessionSetRow[]
  exercise_prs: ExercisePrRow[]
} {
  const t = now() - 60_000 // a minute ago so client upserts aren't no-ops

  const ex = (id: string, name: string, equip: string[], mg: string[], uni = false): ExerciseRow => ({
    id: id as ExerciseId,
    name,
    equipment: JSON.stringify(equip),
    muscle_groups: JSON.stringify(mg),
    movement_type: null,
    is_unilateral: uni ? 1 : 0,
    starred: 0,
    notes: null,
    created_at: t,
    updated_at: t,
  })

  const exercises: ExerciseRow[] = [
    ex('ex_smith_squat', 'Smith Machine Squat', ['smith_machine'], ['quads', 'glutes']),
    ex('ex_rdl', 'Romanian Deadlift', ['db'], ['hamstrings', 'glutes']),
    ex('ex_bulgarian_split', 'Bulgarian Split Squat', ['db'], ['quads', 'glutes'], true),
    ex('ex_leg_ext', 'Leg Extensions', ['machine'], ['quads']),
    ex('ex_leg_curl', 'Leg Curls', ['machine'], ['hamstrings']),
    ex('ex_calf_raise', 'Standing Calf Raise', ['db'], ['calves']),
    ex('ex_curl', 'DB Curl', ['db'], ['biceps']),
    ex('ex_tricep_ext', 'Tricep Extension', ['db'], ['triceps']),
  ]

  // Workout A: Lower Body — Heavy (pyramid + superset)
  const workoutA: WorkoutRow = {
    id: 'wk_lower_heavy' as WorkoutId,
    name: 'Lower Body — Heavy',
    description: 'Squat pyramid, then accessories.',
    tags: JSON.stringify(['lower', 'heavy', 'pyramid']),
    starred: 1,
    est_duration: 45,
    created_by: 'agent',
    created_at: t,
    updated_at: t,
    last_performed: t - 3 * 24 * 60 * 60 * 1000,
  }

  const blockA1: WorkoutBlockRow = {
    id: 'wb_a1' as WorkoutBlockId,
    workout_id: workoutA.id,
    position: 1,
    kind: 'single',
    rounds: 1,
    rest_after_sec: 180,
    setup_cue: 'Set safety pins at squat depth.\nStart with **135** loaded.',
    created_at: t,
    updated_at: t,
  }
  const blockA2: WorkoutBlockRow = {
    id: 'wb_a2' as WorkoutBlockId,
    workout_id: workoutA.id,
    position: 2,
    kind: 'superset',
    rounds: 3,
    rest_after_sec: 120,
    setup_cue: 'Leg ext **80×12**, then curl **70×12**. No rest between.',
    created_at: t,
    updated_at: t,
  }

  const beA1: BlockExerciseRow = {
    id: 'be_a1_squat' as BlockExerciseId,
    block_id: blockA1.id,
    exercise_id: 'ex_smith_squat' as ExerciseId,
    position: 1,
    alt_exercise_ids: JSON.stringify([]),
    created_at: t,
    updated_at: t,
  }
  const beA2a: BlockExerciseRow = {
    id: 'be_a2_ext' as BlockExerciseId,
    block_id: blockA2.id,
    exercise_id: 'ex_leg_ext' as ExerciseId,
    position: 1,
    alt_exercise_ids: JSON.stringify([]),
    created_at: t,
    updated_at: t,
  }
  const beA2b: BlockExerciseRow = {
    id: 'be_a2_curl' as BlockExerciseId,
    block_id: blockA2.id,
    exercise_id: 'ex_leg_curl' as ExerciseId,
    position: 2,
    alt_exercise_ids: JSON.stringify([]),
    created_at: t,
    updated_at: t,
  }

  const mkSet = (
    id: string,
    be: BlockExerciseRow,
    n: number,
    w: number | null,
    reps: number | null,
    peak = false,
  ): BlockExerciseSetRow => ({
    id: id as BlockExerciseSetId,
    block_exercise_id: be.id,
    set_number: n,
    target_weight: w,
    target_pct_1rm: null,
    target_reps: reps,
    target_reps_each: 0,
    target_duration_sec: null,
    target_rpe: null,
    is_peak: peak ? 1 : 0,
    rest_after_sec: null,
    notes: null,
    created_at: t,
    updated_at: t,
  })

  const block_exercise_sets: BlockExerciseSetRow[] = [
    mkSet('bes_a1_1', beA1, 1, 135, 12),
    mkSet('bes_a1_2', beA1, 2, 155, 10),
    mkSet('bes_a1_3', beA1, 3, 175, 8),
    mkSet('bes_a1_4', beA1, 4, 185, 6, true),
    mkSet('bes_a2a_1', beA2a, 1, 80, 12),
    mkSet('bes_a2b_1', beA2b, 1, 70, 12),
  ]

  // Workout B: Arm Day — Superset
  const workoutB: WorkoutRow = {
    id: 'wk_arms' as WorkoutId,
    name: 'Arm Day — Superset',
    description: 'Biceps + triceps paired for 4 rounds.',
    tags: JSON.stringify(['upper', 'superset', 'arms']),
    starred: 0,
    est_duration: 30,
    created_by: 'agent',
    created_at: t,
    updated_at: t,
    last_performed: null,
  }

  const blockB1: WorkoutBlockRow = {
    id: 'wb_b1' as WorkoutBlockId,
    workout_id: workoutB.id,
    position: 1,
    kind: 'superset',
    rounds: 4,
    rest_after_sec: 90,
    setup_cue: 'Alternate without rest, then **90s** between rounds.',
    created_at: t,
    updated_at: t,
  }
  const beB1a: BlockExerciseRow = {
    id: 'be_b1_curl' as BlockExerciseId,
    block_id: blockB1.id,
    exercise_id: 'ex_curl' as ExerciseId,
    position: 1,
    alt_exercise_ids: JSON.stringify([]),
    created_at: t,
    updated_at: t,
  }
  const beB1b: BlockExerciseRow = {
    id: 'be_b1_tri' as BlockExerciseId,
    block_id: blockB1.id,
    exercise_id: 'ex_tricep_ext' as ExerciseId,
    position: 2,
    alt_exercise_ids: JSON.stringify([]),
    created_at: t,
    updated_at: t,
  }

  block_exercise_sets.push(
    mkSet('bes_b1a_1', beB1a, 1, 30, 12),
    mkSet('bes_b1b_1', beB1b, 1, 40, 12),
  )

  return {
    exercises,
    workouts: [workoutA, workoutB],
    workout_blocks: [blockA1, blockA2, blockB1],
    block_exercises: [beA1, beA2a, beA2b, beB1a, beB1b],
    block_exercise_sets,
    sessions: [],
    session_sets: [],
    exercise_prs: [],
  }
}

const state = seed()

/** Return all rows across all 8 tables with updated_at > the per-table lastSync. */
export function mockSyncCall(req: SyncRequest): SyncResponse {
  const t = now()

  // Merge any client-sent changes into the mock state (LWW by updated_at).
  for (const [tableName, payload] of Object.entries(req.tables ?? {})) {
    if (!payload?.changes?.length) continue
    const table = tableName as keyof typeof state
    const list = state[table] as { id: string; updated_at: number }[]
    for (const incoming of payload.changes as { id: string; updated_at: number }[]) {
      const idx = list.findIndex((r) => r.id === incoming.id)
      if (idx === -1) {
        list.push(incoming)
      } else if (incoming.updated_at > list[idx]!.updated_at) {
        list[idx] = incoming
      }
    }
  }

  const pick = <T extends { updated_at: number }>(rows: T[], since: number): T[] =>
    rows.filter((r) => r.updated_at > since)

  return {
    tables: {
      exercises: { syncTimestamp: t, changes: pick(state.exercises, req.tables.exercises?.lastSync ?? 0) },
      workouts: { syncTimestamp: t, changes: pick(state.workouts, req.tables.workouts?.lastSync ?? 0) },
      workout_blocks: { syncTimestamp: t, changes: pick(state.workout_blocks, req.tables.workout_blocks?.lastSync ?? 0) },
      block_exercises: { syncTimestamp: t, changes: pick(state.block_exercises, req.tables.block_exercises?.lastSync ?? 0) },
      block_exercise_sets: { syncTimestamp: t, changes: pick(state.block_exercise_sets, req.tables.block_exercise_sets?.lastSync ?? 0) },
      sessions: { syncTimestamp: t, changes: pick(state.sessions, req.tables.sessions?.lastSync ?? 0) },
      session_sets: { syncTimestamp: t, changes: pick(state.session_sets, req.tables.session_sets?.lastSync ?? 0) },
      exercise_prs: { syncTimestamp: t, changes: pick(state.exercise_prs, req.tables.exercise_prs?.lastSync ?? 0) },
    },
  }
}
