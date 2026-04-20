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
import {
  advance,
  cursorsEqual,
  firstCursor,
  firstUnloggedCursorInBlock,
  iterateSets,
} from '../features/session/sessionEngine'
import { IDLE_TIMER, type TimerKind, type TimerSnapshot } from '../features/timer/TimerService'
import type {
  Cursor,
  PendingActuals,
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

  // Phase 2 state
  pausedAt: number | null
  skippedBlockIds: Set<string>
  accumulatedPausedMs: number
  pendingActuals: PendingActuals | null

  // actions
  hydrate: () => Promise<void>
  startSession: (workoutId: string) => Promise<SessionId | null>
  logSet: (input?: Partial<LoggedSetInput>) => Promise<void>
  jumpTo: (cursor: Cursor) => void
  startTimer: (kind: Exclude<TimerKind, null>, durationSec: number) => void
  adjustTimer: (deltaSec: number) => void
  cancelTimer: () => void
  applyEdit: (edit: StructuralEdit) => void
  pickSavePreference: (choice: Exclude<SavePreference, null>) => Promise<void>
  completeSession: (notes?: string | null) => Promise<void>
  abandonSession: () => Promise<void>
  resetLocal: () => void

  // Phase 2 actions
  pause: () => Promise<void>
  resume: () => Promise<void>
  skipCurrentSet: () => Promise<{ undoCursor: Cursor } | null>
  undoSkip: (cursor: Cursor) => void
  skipBlock: (blockId: string) => Promise<void>
  returnToBlock: (blockId: string) => Promise<void>
  endWorkout: (notes?: string | null) => Promise<void>
  setPendingActuals: (patch: PendingActuals | null) => Promise<void>
  startWorkTimer: (durationSec: number) => Promise<void>
  adjustWorkTimer: (deltaSec: number) => Promise<void>
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

/**
 * Find the first unlogged, unskipped cursor in the snapshot. Used on hydrate
 * to restore execution position after a reload. Skipped blocks are ignored so
 * we don't land the user inside a block they explicitly chose to bypass.
 */
function cursorFromLogged(
  snapshot: WorkoutSnapshot,
  logged: SessionSetRow[],
  skippedBlockIds: ReadonlySet<string>,
): Cursor | null {
  const doneKeys = new Set(
    logged.map(
      (r) => `${r.block_position}.${r.block_exercise_position}.${r.round_number}.${r.set_number}`,
    ),
  )
  for (const entry of iterateSets(snapshot)) {
    if (skippedBlockIds.has(entry.block.id)) continue
    const key = `${entry.cursor.blockPosition}.${entry.cursor.blockExercisePosition}.${entry.cursor.roundNumber}.${entry.cursor.setNumber}`
    if (!doneKeys.has(key)) return entry.cursor
  }
  return null
}

function parseSkippedBlocks(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const v = JSON.parse(raw)
    return new Set(Array.isArray(v) ? (v as string[]) : [])
  } catch {
    return new Set()
  }
}

function parsePendingActuals(raw: string | null): PendingActuals | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as PendingActuals
  } catch {
    return null
  }
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

  // Phase 2 state — initialized empty; populated by hydrate + actions.
  pausedAt: null,
  skippedBlockIds: new Set<string>(),
  accumulatedPausedMs: 0,
  pendingActuals: null,

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
    const skippedBlockIds = parseSkippedBlocks(active.skipped_block_ids)
    set({
      sessionId: active.id,
      snapshot,
      cursor: cursorFromLogged(snapshot, logged, skippedBlockIds) ?? firstCursor(snapshot),
      savePreference: active.save_preference,
      timer: IDLE_TIMER,
      pendingEdits: [],
      loggedCount: logged.length,
      hydrated: true,
      pausedAt: active.paused_at,
      skippedBlockIds,
      accumulatedPausedMs: active.accumulated_paused_ms ?? 0,
      pendingActuals: parsePendingActuals(active.pending_actuals),
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
      pausedAt: null,
      skippedBlockIds: new Set<string>(),
      accumulatedPausedMs: 0,
      pendingActuals: null,
    })
    return id
  },

  /**
   * Log a set at the current cursor. Upsert-by-tuple: if a row already exists
   * for this cursor (edited set, re-fired advance, sync echo), reuse its id
   * and preserve created_at / logged_at / is_pr / was_swapped. Actuals merge
   * in this priority: explicit input > pendingActuals stash > target defaults.
   *
   * After writing, the cursor advances through skipped blocks and pendingActuals
   * + timer are cleared. A companion `sessions.pending_actuals = null` write
   * keeps the DB in sync.
   */
  async logSet(input) {
    const { sessionId, snapshot, cursor, pendingActuals, skippedBlockIds } = get()
    if (!sessionId || !snapshot || !cursor) return
    const entry = [...iterateSets(snapshot)].find((e) => cursorsEqual(e.cursor, cursor))
    if (!entry) return
    const now = Date.now()

    // Merge priority: explicit input > pendingActuals stash > targets.
    const actualWeight =
      input?.actualWeight ??
      pendingActuals?.actual_weight ??
      entry.target.target_weight ??
      null
    const actualReps =
      input?.actualReps ?? pendingActuals?.actual_reps ?? entry.target.target_reps ?? null
    const actualDurationSec =
      input?.actualDurationSec ??
      pendingActuals?.actual_duration_sec ??
      entry.target.target_duration_sec ??
      null
    const rpe = input?.rpe ?? pendingActuals?.rpe ?? null
    const restTakenSec = input?.restTakenSec ?? null
    // Future: propagate notes when SessionSetRow gains a notes column; for now
    // pendingActuals.notes is captured but unused in the row. Intentional.

    // Upsert-by-tuple: find an existing row keyed on
    // (session_id, block_position, block_exercise_position, round_number, set_number).
    // The Dexie compound index (v2) makes this O(log n). Server-side UNIQUE
    // constraint on the same tuple catches any drift.
    const existing = await db.session_sets
      .where('[session_id+block_position+block_exercise_position+round_number+set_number]')
      .equals([
        sessionId,
        cursor.blockPosition,
        cursor.blockExercisePosition,
        cursor.roundNumber,
        cursor.setNumber,
      ])
      .first()

    const row: SessionSetRow = {
      id: (existing?.id ?? uuid('ss')) as SessionSetId,
      session_id: sessionId,
      exercise_id: entry.blockExercise.exercise_id as ExerciseId,
      block_position: cursor.blockPosition,
      block_exercise_position: cursor.blockExercisePosition,
      round_number: cursor.roundNumber,
      set_number: cursor.setNumber,
      target_weight: entry.target.target_weight ?? null,
      target_reps: entry.target.target_reps ?? null,
      target_duration_sec: entry.target.target_duration_sec ?? null,
      actual_weight: actualWeight,
      actual_reps: actualReps,
      actual_duration_sec: actualDurationSec,
      rpe,
      rest_taken_sec: restTakenSec,
      is_pr: existing?.is_pr ?? 0, // server re-decides on sync if actuals changed
      was_swapped: existing?.was_swapped ?? 0,
      logged_at: existing?.logged_at ?? now, // preserve original log time on edit
      created_at: existing?.created_at ?? now,
      updated_at: now,
    }
    await db.session_sets.put(row)

    const next = advance(snapshot, cursor, skippedBlockIds)
    const ses = await db.sessions.get(sessionId)
    if (ses) {
      await db.sessions.put({
        ...ses,
        pending_actuals: null, // consumed by this log
        updated_at: now,
      })
    }
    set({
      cursor: next,
      loggedCount: existing ? get().loggedCount : get().loggedCount + 1,
      timer: IDLE_TIMER,
      pendingActuals: null,
    })
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
    const { sessionId, pausedAt, accumulatedPausedMs } = get()
    if (!sessionId) return
    const now = Date.now()
    // Fold any open pause interval into the accumulator so duration_sec
    // reflects active workout time, not calendar time.
    const finalAccum = accumulatedPausedMs + (pausedAt != null ? now - pausedAt : 0)
    const ses = await db.sessions.get(sessionId)
    if (ses) {
      const rawDurationSec = Math.round((now - ses.started_at) / 1000)
      const activeDurationSec = Math.max(0, rawDurationSec - Math.round(finalAccum / 1000))
      await db.sessions.put({
        ...ses,
        status: 'completed',
        ended_at: now,
        duration_sec: activeDurationSec,
        accumulated_paused_ms: finalAccum,
        paused_at: null,
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
      pausedAt: null,
      skippedBlockIds: new Set(),
      accumulatedPausedMs: 0,
      pendingActuals: null,
    })
  },

  // ─── Phase 2 actions ──────────────────────────────────────────────────

  async pause() {
    const { sessionId, pausedAt } = get()
    if (!sessionId || pausedAt != null) return
    const now = Date.now()
    const ses = await db.sessions.get(sessionId)
    if (!ses) return
    await db.sessions.put({ ...ses, paused_at: now, updated_at: now })
    set({ pausedAt: now })
  },

  async resume() {
    const { sessionId, pausedAt, accumulatedPausedMs } = get()
    if (!sessionId || pausedAt == null) return
    const now = Date.now()
    const delta = now - pausedAt
    const newAccum = accumulatedPausedMs + delta
    const ses = await db.sessions.get(sessionId)
    if (!ses) return
    // Carry pause forward for work timer: shift its startedAt so remaining is unchanged.
    const shiftedWorkTimerStart =
      ses.work_timer_started_at != null ? ses.work_timer_started_at + delta : null
    await db.sessions.put({
      ...ses,
      paused_at: null,
      accumulated_paused_ms: newAccum,
      work_timer_started_at: shiftedWorkTimerStart,
      updated_at: now,
    })
    set({ pausedAt: null, accumulatedPausedMs: newAccum })
  },

  async skipCurrentSet() {
    const { sessionId, snapshot, cursor, skippedBlockIds } = get()
    if (!sessionId || !snapshot || !cursor) return null
    const undoCursor = cursor
    const next = advance(snapshot, cursor, skippedBlockIds)
    const now = Date.now()
    const ses = await db.sessions.get(sessionId)
    if (ses) {
      await db.sessions.put({
        ...ses,
        work_timer_started_at: null,
        work_timer_duration_sec: null,
        pending_actuals: null,
        updated_at: now,
      })
    }
    set({ cursor: next, pendingActuals: null, timer: IDLE_TIMER })
    return { undoCursor }
  },

  undoSkip(cursor) {
    set({ cursor })
  },

  async skipBlock(blockId) {
    const { sessionId, snapshot, skippedBlockIds } = get()
    if (!sessionId || !snapshot) return
    const nextSkipped = new Set(skippedBlockIds)
    nextSkipped.add(blockId)
    // Find the next non-skipped block's first cursor.
    const cur = get().cursor
    const nextCursor = cur ? advance(snapshot, cur, nextSkipped) : null
    const now = Date.now()
    const ses = await db.sessions.get(sessionId)
    if (ses) {
      await db.sessions.put({
        ...ses,
        skipped_block_ids: JSON.stringify([...nextSkipped]),
        work_timer_started_at: null,
        work_timer_duration_sec: null,
        updated_at: now,
      })
    }
    set({ skippedBlockIds: nextSkipped, cursor: nextCursor, timer: IDLE_TIMER })
  },

  async returnToBlock(blockId) {
    const { sessionId, snapshot, skippedBlockIds } = get()
    if (!sessionId || !snapshot) return
    const nextSkipped = new Set(skippedBlockIds)
    nextSkipped.delete(blockId)
    // Land on the first unlogged set of this block (reviewer catch #5 from the plan).
    const logged = await db.session_sets.where('session_id').equals(sessionId).toArray()
    const loggedKeys = new Set(
      logged.map((r) => `${r.block_position}.${r.block_exercise_position}.${r.round_number}.${r.set_number}`),
    )
    const blockPosition = snapshot.blocks.find((b) => b.id === blockId)?.position
    const target = blockPosition != null
      ? firstUnloggedCursorInBlock(snapshot, blockPosition, loggedKeys)
      : null
    const now = Date.now()
    const ses = await db.sessions.get(sessionId)
    if (ses) {
      await db.sessions.put({
        ...ses,
        skipped_block_ids: nextSkipped.size > 0 ? JSON.stringify([...nextSkipped]) : null,
        updated_at: now,
      })
    }
    set({ skippedBlockIds: nextSkipped, cursor: target ?? get().cursor, timer: IDLE_TIMER })
  },

  async endWorkout(notes) {
    // Delegate to completeSession; duration_sec accounting subtracts paused time below.
    const { sessionId, pausedAt, accumulatedPausedMs } = get()
    if (!sessionId) return
    // If the session is paused when the user hits End, fold the current pause interval
    // into accumulatedPausedMs so it doesn't count toward duration_sec.
    let finalAccum = accumulatedPausedMs
    if (pausedAt != null) finalAccum += Date.now() - pausedAt
    const now = Date.now()
    const ses = await db.sessions.get(sessionId)
    if (ses) {
      const rawDurationSec = Math.round((now - ses.started_at) / 1000)
      const activeDurationSec = Math.max(0, rawDurationSec - Math.round(finalAccum / 1000))
      await db.sessions.put({
        ...ses,
        status: 'completed',
        ended_at: now,
        duration_sec: activeDurationSec,
        accumulated_paused_ms: finalAccum,
        paused_at: null,
        notes: notes ?? ses.notes ?? null,
        updated_at: now,
      })
    }
    get().resetLocal()
  },

  async setPendingActuals(patch) {
    const { sessionId } = get()
    if (!sessionId) return
    const now = Date.now()
    const ses = await db.sessions.get(sessionId)
    if (!ses) return
    await db.sessions.put({
      ...ses,
      pending_actuals: patch ? JSON.stringify(patch) : null,
      updated_at: now,
    })
    set({ pendingActuals: patch })
  },

  async startWorkTimer(durationSec) {
    const { sessionId } = get()
    if (!sessionId) return
    const now = Date.now()
    const ses = await db.sessions.get(sessionId)
    if (!ses) return
    await db.sessions.put({
      ...ses,
      work_timer_started_at: now,
      work_timer_duration_sec: durationSec,
      updated_at: now,
    })
  },

  async adjustWorkTimer(deltaSec) {
    const { sessionId } = get()
    if (!sessionId) return
    const now = Date.now()
    const ses = await db.sessions.get(sessionId)
    if (!ses || ses.work_timer_duration_sec == null) return
    const nextDuration = Math.max(0, ses.work_timer_duration_sec + deltaSec)
    await db.sessions.put({
      ...ses,
      work_timer_duration_sec: nextDuration,
      updated_at: now,
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
