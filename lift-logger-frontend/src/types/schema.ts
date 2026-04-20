// Shared schema types — mirror of the 8 IRON backend tables.
// Keys are snake_case (backend column names). Timestamps are epoch millis (number).
// Booleans are 0|1 at the DB boundary; normalized to `boolean` at the app edge.
//
// See: docs/iron-backend-plan.md (Schema section).

import type {
  BlockExerciseId,
  BlockExerciseSetId,
  ExerciseId,
  ExercisePrId,
  SessionId,
  SessionSetId,
  WorkoutBlockId,
  WorkoutId,
} from './ids'

// ─── enums & aliases ──────────────────────────────────────────────────

export type BlockKind = 'single' | 'superset' | 'circuit'
export type SessionStatus = 'active' | 'completed' | 'abandoned'
export type SavePreference = 'session_only' | 'template' | null
export type PrType = 'weight' | 'reps' | 'volume' | '1rm_est'
export type CreatedBy = 'user' | 'agent'
export type MovementType =
  | 'squat'
  | 'hinge'
  | 'push'
  | 'pull'
  | 'carry'
  | 'iso'
  | 'plyo'
  | 'cardio'
export type Bool01 = 0 | 1

// ─── table rows ───────────────────────────────────────────────────────

export type ExerciseRow = {
  id: ExerciseId
  name: string
  equipment: string // JSON array string
  muscle_groups: string // JSON array string
  movement_type: MovementType | null
  is_unilateral: Bool01
  starred: Bool01
  notes: string | null
  created_at: number
  updated_at: number
}

export type WorkoutRow = {
  id: WorkoutId
  name: string
  description: string | null
  tags: string // JSON array string
  starred: Bool01
  est_duration: number | null // minutes
  created_by: CreatedBy
  created_at: number
  updated_at: number
  last_performed: number | null
}

export type WorkoutBlockRow = {
  id: WorkoutBlockId
  workout_id: WorkoutId
  position: number
  kind: BlockKind
  rounds: number
  rest_after_sec: number | null
  setup_cue: string | null
  created_at: number
  updated_at: number
}

export type BlockExerciseRow = {
  id: BlockExerciseId
  block_id: WorkoutBlockId
  exercise_id: ExerciseId
  position: number
  alt_exercise_ids: string // JSON array string
  created_at: number
  updated_at: number
}

export type BlockExerciseSetRow = {
  id: BlockExerciseSetId
  block_exercise_id: BlockExerciseId
  set_number: number
  target_weight: number | null
  target_pct_1rm: number | null
  target_reps: number | null
  target_reps_each: Bool01
  target_duration_sec: number | null
  target_rpe: number | null
  is_peak: Bool01
  rest_after_sec: number | null
  notes: string | null
  created_at: number
  updated_at: number
}

export type SessionRow = {
  id: SessionId
  workout_id: WorkoutId | null
  workout_snapshot: string // JSON string of WorkoutSnapshot
  started_at: number
  ended_at: number | null
  duration_sec: number | null
  status: SessionStatus
  notes: string | null
  save_preference: SavePreference
  created_at: number
  updated_at: number
}

export type SessionSetRow = {
  id: SessionSetId
  session_id: SessionId
  exercise_id: ExerciseId
  block_position: number
  block_exercise_position: number
  round_number: number
  set_number: number
  target_weight: number | null
  target_reps: number | null
  target_duration_sec: number | null
  actual_weight: number | null
  actual_reps: number | null
  actual_duration_sec: number | null
  rpe: number | null
  rest_taken_sec: number | null
  is_pr: Bool01
  was_swapped: Bool01
  logged_at: number
  created_at: number
  updated_at: number
}

export type ExercisePrRow = {
  id: ExercisePrId
  exercise_id: ExerciseId
  pr_type: PrType
  value: number
  reps: number | null
  weight: number | null
  achieved_at: number
  session_id: SessionId | null
  created_at: number
  updated_at: number
}

// ─── workout snapshot (nested JSON stored on sessions.workout_snapshot) ──

export type SnapshotSetTarget = {
  set_number: number
  target_weight?: number | null
  target_pct_1rm?: number | null
  target_reps?: number | null
  target_reps_each?: boolean
  target_duration_sec?: number | null
  target_rpe?: number | null
  is_peak?: boolean
  rest_after_sec?: number | null
  notes?: string | null
}

export type SnapshotBlockExercise = {
  id: BlockExerciseId
  exercise_id: ExerciseId
  name: string
  position: number
  alt_exercise_ids: ExerciseId[]
  sets: SnapshotSetTarget[]
}

export type SnapshotBlock = {
  id: WorkoutBlockId
  position: number
  kind: BlockKind
  rounds: number
  rest_after_sec: number | null
  setup_cue: string | null
  exercises: SnapshotBlockExercise[]
}

export type WorkoutSnapshot = {
  workout_id: WorkoutId
  name: string
  snapshot_at: number
  blocks: SnapshotBlock[]
}

// ─── sync payload ─────────────────────────────────────────────────────

export type SyncTable =
  | 'exercises'
  | 'workouts'
  | 'workout_blocks'
  | 'block_exercises'
  | 'block_exercise_sets'
  | 'sessions'
  | 'session_sets'
  | 'exercise_prs'

export type SyncTablePayload<T> = {
  lastSync: number
  changes: T[]
}

export type SyncRequest = {
  tables: Partial<{
    exercises: SyncTablePayload<ExerciseRow>
    workouts: SyncTablePayload<WorkoutRow>
    workout_blocks: SyncTablePayload<WorkoutBlockRow>
    block_exercises: SyncTablePayload<BlockExerciseRow>
    block_exercise_sets: SyncTablePayload<BlockExerciseSetRow>
    sessions: SyncTablePayload<SessionRow>
    session_sets: SyncTablePayload<SessionSetRow>
    exercise_prs: SyncTablePayload<ExercisePrRow>
  }>
}

export type SyncTableResponse<T> = {
  syncTimestamp: number
  changes: T[]
}

export type SyncResponse = {
  tables: Partial<{
    exercises: SyncTableResponse<ExerciseRow>
    workouts: SyncTableResponse<WorkoutRow>
    workout_blocks: SyncTableResponse<WorkoutBlockRow>
    block_exercises: SyncTableResponse<BlockExerciseRow>
    block_exercise_sets: SyncTableResponse<BlockExerciseSetRow>
    sessions: SyncTableResponse<SessionRow>
    session_sets: SyncTableResponse<SessionSetRow>
    exercise_prs: SyncTableResponse<ExercisePrRow>
  }>
}

// ─── session cursor (app-side) ────────────────────────────────────────

export type Cursor = {
  blockPosition: number // 1-indexed (matches DB)
  blockExercisePosition: number
  roundNumber: number
  setNumber: number
}

export type CursorWithTarget = {
  cursor: Cursor
  block: SnapshotBlock
  blockExercise: SnapshotBlockExercise
  target: SnapshotSetTarget
}
