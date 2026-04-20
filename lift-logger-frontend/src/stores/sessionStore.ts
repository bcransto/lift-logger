// Active session state — cursor, timer, logged set cache, pending edits, save preference.
//
// Persistence model:
//   - The `sessions` row in Dexie is the durable home for `status`, `started_at`,
//     `workout_snapshot`, `save_preference`, etc. sessionStore writes through.
//   - `session_sets` rows are the log; each logSet() writes one.
//   - The cursor + timer are derived from the session row + logged rows on cold
//     start (see hydrateFromActiveSession).

import { create } from 'zustand'
import { db } from '../db/db'
import { buildWorkoutSnapshot } from '../db/queries'
import { advance, cursorsEqual, firstCursor, iterateSets } from '../features/session/sessionEngine'
import { IDLE_TIMER, type TimerKind, type TimerSnapshot } from '../features/timer/TimerService'
import type {
  Cursor,
  SavePreference,
  SessionRow,
  SessionSetRow,
  SnapshotSetTarget,
  WorkoutSnapshot,
} from '../types/schema'
import type { ExerciseId, SessionId, SessionSetId, WorkoutId } from '../types/ids'
import { uuid } from '../shared/utils/uuid'

// ─── types ────────────────────────────────────────────────────────────

export type LoggedSetInput = {
  actualWeight: number | null
  actualReps: number | null
  actualDurationSec: number | null
  rpe: number | null
  restTakenSec: number | null
  notes?: string | null
}

export type StructuralEdit =
  | {
      kind: 'editSetTarget'
      blockPosition: number
      blockExercisePosition: number
      setNumber: number
      patch: Partial<SnapshotSetTarget>
    }
  | {
      kind: 'addSet'
      blockPosition: number
      blockExercisePosition: number
      target: SnapshotSetTarget
    }
  | {
      kind: 'deleteSet'
      blockPosition: number
      blockExercisePosition: number
      setNumber: number
    }

export type SessionState = {
  sessionId: SessionId | null
  snapshot: WorkoutSnapshot | null
  cursor: Cursor | null
  savePreference: SavePreference
  timer: TimerSnapshot
  pendingEdits: StructuralEdit[]
  loggedCount: number // convenience for progress bar
  hydrated: boolean

  // actions
  hydrate: () => Promise<void>
  startSession: (workoutId: string) => Promise<SessionId | null>
  logSet: (input: LoggedSetInput) => Promise<void>
  jumpTo: (cursor: Cursor) => void
  startTimer: (kind: Exclude<TimerKind, null>, durationSec: number) => void
  adjustTimer: (deltaSec: number) => void
  cancelTimer: () => void
  applyEdit: (edit: StructuralEdit) => void
  pickSavePreference: (choice: Exclude<SavePreference, null>) => Promise<void>
  completeSession: (notes?: string | null) => Promise<void>
  abandonSession: () => Promise<void>
  resetLocal: () => void
}

// ─── helpers (pure, exported for tests) ───────────────────────────────

export function applyEditToSnapshot(
  snapshot: WorkoutSnapshot,
  edit: StructuralEdit,
): WorkoutSnapshot {
  const blocks = snapshot.blocks.map((block) => {
    if (block.position !== edit.blockPosition) return block
    const exercises = block.exercises.map((be) => {
      if (be.position !== edit.blockExercisePosition) return be
      let sets = be.sets.slice()
      if (edit.kind === 'editSetTarget') {
        sets = sets.map((s) => (s.set_number === edit.setNumber ? { ...s, ...edit.patch } : s))
      } else if (edit.kind === 'addSet') {
        sets.push(edit.target)
        sets.sort((a, b) => a.set_number - b.set_number)
      } else if (edit.kind === 'deleteSet') {
        sets = sets.filter((s) => s.set_number !== edit.setNumber)
        // Renumber contiguously after delete so advance() stays valid.
        sets = sets.map((s, i) => ({ ...s, set_number: i + 1 }))
      }
      return { ...be, sets }
    })
    return { ...block, exercises }
  })
  return { ...snapshot, blocks }
}

function cursorFromLogged(
  snapshot: WorkoutSnapshot,
  logged: SessionSetRow[],
): Cursor | null {
  // Map logged rows to their matching cursor entries, find the first unlogged.
  const doneKeys = new Set(
    logged.map(
      (r) => `${r.block_position}.${r.block_exercise_position}.${r.round_number}.${r.set_number}`,
    ),
  )
  for (const entry of iterateSets(snapshot)) {
    const key = `${entry.cursor.blockPosition}.${entry.cursor.blockExercisePosition}.${entry.cursor.roundNumber}.${entry.cursor.setNumber}`
    if (!doneKeys.has(key)) return entry.cursor
  }
  return null
}

// ─── store ────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionState>((set, get) => ({
  sessionId: null,
  snapshot: null,
  cursor: null,
  savePreference: null,
  timer: IDLE_TIMER,
  pendingEdits: [],
  loggedCount: 0,
  hydrated: false,

  async hydrate() {
    const actives = await db.sessions.where('status').equals('active').toArray()
    const active = actives.sort((a, b) => b.started_at - a.started_at)[0]
    if (!active) {
      set({ hydrated: true })
      return
    }
    let snapshot: WorkoutSnapshot
    try {
      snapshot = JSON.parse(active.workout_snapshot) as WorkoutSnapshot
    } catch {
      set({ hydrated: true })
      return
    }
    const logged = await db.session_sets.where('session_id').equals(active.id).toArray()
    set({
      sessionId: active.id,
      snapshot,
      cursor: cursorFromLogged(snapshot, logged) ?? firstCursor(snapshot),
      savePreference: active.save_preference,
      timer: IDLE_TIMER,
      pendingEdits: [],
      loggedCount: logged.length,
      hydrated: true,
    })
  },

  async startSession(workoutId: string) {
    const snapshot = await buildWorkoutSnapshot(workoutId as WorkoutId)
    if (!snapshot) return null
    const now = Date.now()
    const id = uuid('ses') as SessionId
    const row: SessionRow = {
      id,
      workout_id: workoutId as WorkoutId,
      workout_snapshot: JSON.stringify(snapshot),
      started_at: now,
      ended_at: null,
      duration_sec: null,
      status: 'active',
      notes: null,
      save_preference: null,
      created_at: now,
      updated_at: now,
      // Phase 2 fields — all start null.
      paused_at: null,
      skipped_block_ids: null,
      work_timer_started_at: null,
      work_timer_duration_sec: null,
      accumulated_paused_ms: null,
      pending_actuals: null,
    }
    await db.sessions.put(row)
    // Mark workout.last_performed for Home sort ordering.
    const w = await db.workouts.get(workoutId)
    if (w) {
      await db.workouts.put({ ...w, last_performed: now, updated_at: now })
    }
    set({
      sessionId: id,
      snapshot,
      cursor: firstCursor(snapshot),
      savePreference: null,
      timer: IDLE_TIMER,
      pendingEdits: [],
      loggedCount: 0,
      hydrated: true,
    })
    return id
  },

  async logSet(input) {
    const { sessionId, snapshot, cursor } = get()
    if (!sessionId || !snapshot || !cursor) return
    const entry = [...iterateSets(snapshot)].find((e) => cursorsEqual(e.cursor, cursor))
    if (!entry) return
    const now = Date.now()
    const row: SessionSetRow = {
      id: uuid('ss') as SessionSetId,
      session_id: sessionId,
      exercise_id: entry.blockExercise.exercise_id as ExerciseId,
      block_position: cursor.blockPosition,
      block_exercise_position: cursor.blockExercisePosition,
      round_number: cursor.roundNumber,
      set_number: cursor.setNumber,
      target_weight: entry.target.target_weight ?? null,
      target_reps: entry.target.target_reps ?? null,
      target_duration_sec: entry.target.target_duration_sec ?? null,
      actual_weight: input.actualWeight,
      actual_reps: input.actualReps,
      actual_duration_sec: input.actualDurationSec,
      rpe: input.rpe,
      rest_taken_sec: input.restTakenSec,
      is_pr: 0, // server decides on sync
      was_swapped: 0,
      logged_at: now,
      created_at: now,
      updated_at: now,
    }
    await db.session_sets.put(row)
    const next = advance(snapshot, cursor)
    // Bump session.updated_at so sync picks it up.
    const ses = await db.sessions.get(sessionId)
    if (ses) await db.sessions.put({ ...ses, updated_at: now })
    set({ cursor: next, loggedCount: get().loggedCount + 1, timer: IDLE_TIMER })
  },

  jumpTo(cursor) {
    set({ cursor })
  },

  startTimer(kind, durationSec) {
    set({ timer: { kind, startedAt: Date.now(), durationSec } })
  },

  adjustTimer(deltaSec) {
    const t = get().timer
    if (!t.startedAt || !t.durationSec) return
    const next: TimerSnapshot = { ...t, durationSec: Math.max(0, t.durationSec + deltaSec) }
    set({ timer: next })
  },

  cancelTimer() {
    set({ timer: IDLE_TIMER })
  },

  applyEdit(edit) {
    const { snapshot, savePreference } = get()
    if (!snapshot) return
    if (savePreference === null) {
      set({ pendingEdits: [...get().pendingEdits, edit] })
      return
    }
    void flushEdits([edit], savePreference, get, set)
  },

  async pickSavePreference(choice) {
    const { sessionId, pendingEdits } = get()
    if (!sessionId) return
    set({ savePreference: choice })
    const ses = await db.sessions.get(sessionId)
    if (ses) {
      const now = Date.now()
      await db.sessions.put({ ...ses, save_preference: choice, updated_at: now })
    }
    if (pendingEdits.length) {
      await flushEdits(pendingEdits, choice, get, set)
      set({ pendingEdits: [] })
    }
  },

  async completeSession(notes) {
    const { sessionId } = get()
    if (!sessionId) return
    const now = Date.now()
    const ses = await db.sessions.get(sessionId)
    if (ses) {
      await db.sessions.put({
        ...ses,
        status: 'completed',
        ended_at: now,
        duration_sec: Math.round((now - ses.started_at) / 1000),
        notes: notes ?? ses.notes ?? null,
        updated_at: now,
      })
    }
    get().resetLocal()
  },

  async abandonSession() {
    const { sessionId } = get()
    if (!sessionId) return
    const now = Date.now()
    const ses = await db.sessions.get(sessionId)
    if (ses) {
      await db.sessions.put({ ...ses, status: 'abandoned', ended_at: now, updated_at: now })
    }
    get().resetLocal()
  },

  resetLocal() {
    set({
      sessionId: null,
      snapshot: null,
      cursor: null,
      savePreference: null,
      timer: IDLE_TIMER,
      pendingEdits: [],
      loggedCount: 0,
    })
  },
}))

// ─── internal: edit flush ─────────────────────────────────────────────

async function flushEdits(
  edits: StructuralEdit[],
  choice: Exclude<SavePreference, null>,
  get: () => SessionState,
  set: (partial: Partial<SessionState>) => void,
): Promise<void> {
  const { sessionId } = get()
  let snapshot = get().snapshot
  if (!sessionId || !snapshot) return
  for (const edit of edits) snapshot = applyEditToSnapshot(snapshot, edit)

  const now = Date.now()
  // Always write the snapshot back to the session row.
  const ses = await db.sessions.get(sessionId)
  if (ses) {
    await db.sessions.put({
      ...ses,
      workout_snapshot: JSON.stringify(snapshot),
      updated_at: now,
    })
  }

  if (choice === 'template') {
    // Propagate to the underlying template tables.
    await propagateEditsToTemplate(edits, snapshot.workout_id, now)
  }

  set({ snapshot })
}

async function propagateEditsToTemplate(
  edits: StructuralEdit[],
  workoutId: WorkoutId,
  now: number,
): Promise<void> {
  for (const edit of edits) {
    const block = await db.workout_blocks
      .where({ workout_id: workoutId, position: edit.blockPosition })
      .first()
    if (!block) continue
    const be = await db.block_exercises
      .where({ block_id: block.id, position: edit.blockExercisePosition })
      .first()
    if (!be) continue

    if (edit.kind === 'editSetTarget') {
      const bes = await db.block_exercise_sets
        .where({ block_exercise_id: be.id, set_number: edit.setNumber })
        .first()
      if (!bes) continue
      await db.block_exercise_sets.put({
        ...bes,
        target_weight: edit.patch.target_weight ?? bes.target_weight,
        target_pct_1rm: edit.patch.target_pct_1rm ?? bes.target_pct_1rm,
        target_reps: edit.patch.target_reps ?? bes.target_reps,
        target_reps_each:
          edit.patch.target_reps_each !== undefined
            ? edit.patch.target_reps_each
              ? 1
              : 0
            : bes.target_reps_each,
        target_duration_sec: edit.patch.target_duration_sec ?? bes.target_duration_sec,
        target_rpe: edit.patch.target_rpe ?? bes.target_rpe,
        is_peak: edit.patch.is_peak !== undefined ? (edit.patch.is_peak ? 1 : 0) : bes.is_peak,
        rest_after_sec: edit.patch.rest_after_sec ?? bes.rest_after_sec,
        notes: edit.patch.notes ?? bes.notes,
        updated_at: now,
      })
    } else if (edit.kind === 'addSet') {
      await db.block_exercise_sets.put({
        id: uuid('bes') as unknown as ReturnType<typeof uuid> & string as never,
        block_exercise_id: be.id,
        set_number: edit.target.set_number,
        target_weight: edit.target.target_weight ?? null,
        target_pct_1rm: edit.target.target_pct_1rm ?? null,
        target_reps: edit.target.target_reps ?? null,
        target_reps_each: edit.target.target_reps_each ? 1 : 0,
        target_duration_sec: edit.target.target_duration_sec ?? null,
        target_rpe: edit.target.target_rpe ?? null,
        is_peak: edit.target.is_peak ? 1 : 0,
        rest_after_sec: edit.target.rest_after_sec ?? null,
        notes: edit.target.notes ?? null,
        created_at: now,
        updated_at: now,
      })
    } else if (edit.kind === 'deleteSet') {
      const bes = await db.block_exercise_sets
        .where({ block_exercise_id: be.id, set_number: edit.setNumber })
        .first()
      if (bes) await db.block_exercise_sets.delete(bes.id)
    }
  }

  // Bump workout.updated_at so sync pushes the change.
  const w = await db.workouts.get(workoutId)
  if (w) await db.workouts.put({ ...w, updated_at: now })
}
