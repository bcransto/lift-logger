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
    const totalRounds = b.kind === 'single' ? 1 : Math.max(1, b.rounds)
    for (const be of beRows) {
      const setRows = await db.block_exercise_sets
        .where('block_exercise_id')
        .equals(be.id as unknown as string)
        .toArray()

      const ex = exMap.get(be.exercise_id)
      beSnapshots.push({
        id: be.id,
        exercise_id: be.exercise_id,
        name: ex?.name ?? '(unknown)',
        position: be.position,
        alt_exercise_ids: parseJsonArray(be.alt_exercise_ids) as (typeof be.exercise_id)[],
        sets: expandSetsAcrossRounds(setRows, totalRounds),
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

function rowToSetTarget(r: BlockExerciseSetRow, roundOverride?: number): SnapshotSetTarget {
  return {
    set_number: r.set_number,
    round_number: roundOverride ?? r.round_number ?? 1,
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

/**
 * Round-expand a BE's raw rows into a fully-resolved `SnapshotSetTarget[]`.
 *
 * Rules (v3, partial-override semantics):
 *   - round_number = 1 rows are the mandatory anchor per (block_exercise_id, set_number).
 *   - Rows with round_number > 1 are PARTIAL overrides — any non-null column
 *     wins over the anchor; null columns inherit from the anchor.
 *   - Output has one entry per (round r ∈ 1..totalRounds, set_number from anchor),
 *     with overrides merged in place. Consumers (engine, UI) never have to
 *     re-resolve inheritance.
 *   - Orphan rows with round_number > totalRounds are filtered out (preserve-
 *     and-orphan policy when block.rounds is shrunk).
 *   - If no anchor exists for a given set_number (malformed data), that set
 *     is omitted — matches the prior "no rows, no sets" behavior.
 */
function expandSetsAcrossRounds(rows: BlockExerciseSetRow[], totalRounds: number): SnapshotSetTarget[] {
  if (rows.length === 0) return []
  const anchorRows = rows
    .filter((r) => (r.round_number ?? 1) === 1)
    .sort((a, b) => a.set_number - b.set_number)
  if (anchorRows.length === 0) {
    // No explicit round-1 rows but data exists — treat every row as its own
    // anchor. This preserves behavior on DBs where the Dexie upgrade hasn't
    // landed yet (round_number is undefined, treated as 1).
    return rows
      .slice()
      .sort((a, b) => a.set_number - b.set_number)
      .map((r) => rowToSetTarget(r, 1))
  }

  // Index override rows by (round, set_number) for O(1) lookup during expansion.
  const overrideIndex = new Map<string, BlockExerciseSetRow>()
  for (const r of rows) {
    const rn = r.round_number ?? 1
    if (rn === 1 || rn > totalRounds) continue
    overrideIndex.set(`${rn}.${r.set_number}`, r)
  }

  const out: SnapshotSetTarget[] = []
  for (let r = 1; r <= totalRounds; r++) {
    for (const anchor of anchorRows) {
      if (r === 1) {
        out.push(rowToSetTarget(anchor, 1))
        continue
      }
      const override = overrideIndex.get(`${r}.${anchor.set_number}`)
      out.push(mergeAnchorWithOverride(anchor, override, r))
    }
  }
  return out
}

/**
 * Merge a round-1 anchor with an optional override row for round `r`. Non-null
 * override fields win; null override fields inherit from the anchor. For bool
 * flags (target_reps_each, is_peak) the override row IS stored as 0/1 in the
 * DB, so a 0 explicitly overrides a 1 — callers expressing "keep anchor's
 * flag" should omit the override row, not set the flag to null.
 */
function mergeAnchorWithOverride(
  anchor: BlockExerciseSetRow,
  override: BlockExerciseSetRow | undefined,
  roundNumber: number,
): SnapshotSetTarget {
  if (!override) {
    return rowToSetTarget(anchor, roundNumber)
  }
  const pick = <T,>(a: T | null, o: T | null): T | null => (o === null || o === undefined ? a : o)
  return {
    set_number: anchor.set_number,
    round_number: roundNumber,
    target_weight: pick(anchor.target_weight, override.target_weight),
    target_pct_1rm: pick(anchor.target_pct_1rm, override.target_pct_1rm),
    target_reps: pick(anchor.target_reps, override.target_reps),
    target_reps_each:
      (override.target_reps_each ?? anchor.target_reps_each) === 1,
    target_duration_sec: pick(anchor.target_duration_sec, override.target_duration_sec),
    target_rpe: pick(anchor.target_rpe, override.target_rpe),
    is_peak: (override.is_peak ?? anchor.is_peak) === 1,
    rest_after_sec: pick(anchor.rest_after_sec, override.rest_after_sec),
    notes: pick(anchor.notes, override.notes),
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
