// Dexie table definitions. Columns mirror the backend exactly (snake_case).
// Only the indexes are declared here; all non-indexed columns live in the row object.

import Dexie, { type Table } from 'dexie'
import type {
  BlockExerciseRow,
  BlockExerciseSetRow,
  ExercisePrRow,
  ExerciseRow,
  SessionRow,
  SessionSetRow,
  SyncTable,
  WorkoutBlockRow,
  WorkoutRow,
} from '../types/schema'

export type SyncMetaRow = {
  table: SyncTable
  lastSync: number
}

export type SettingsRow = {
  key: string
  value: unknown
}

export class IronDb extends Dexie {
  exercises!: Table<ExerciseRow, string>
  workouts!: Table<WorkoutRow, string>
  workout_blocks!: Table<WorkoutBlockRow, string>
  block_exercises!: Table<BlockExerciseRow, string>
  block_exercise_sets!: Table<BlockExerciseSetRow, string>
  sessions!: Table<SessionRow, string>
  session_sets!: Table<SessionSetRow, string>
  exercise_prs!: Table<ExercisePrRow, string>
  sync_meta!: Table<SyncMetaRow, string>
  settings!: Table<SettingsRow, string>

  constructor() {
    super('iron')
    this.version(1).stores({
      exercises: 'id, starred, updated_at',
      workouts: 'id, starred, last_performed, updated_at',
      workout_blocks: 'id, workout_id, [workout_id+position], updated_at',
      block_exercises: 'id, block_id, [block_id+position], updated_at',
      block_exercise_sets: 'id, block_exercise_id, [block_exercise_id+set_number], updated_at',
      sessions: 'id, workout_id, status, started_at, updated_at',
      session_sets: 'id, session_id, exercise_id, logged_at, updated_at',
      exercise_prs: 'id, exercise_id, [exercise_id+pr_type], updated_at',
      sync_meta: 'table',
      settings: 'key',
    })
    // v2 — Phase 2: compound index on session_sets tuple so logSet's upsert-by-tuple
    // lookup is O(log n) instead of a full scan. No data migration needed — non-indexed
    // fields on other tables (SessionRow gains 6 nullable columns) are tolerated by Dexie.
    this.version(2).stores({
      session_sets:
        'id, session_id, exercise_id, logged_at, updated_at, ' +
        '[session_id+block_position+block_exercise_position+round_number+set_number]',
    })
  }
}
