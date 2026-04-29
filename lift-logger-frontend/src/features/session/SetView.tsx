// Set view overlay — opened via the right-header button in Block view or by
// tapping the currently focused set card. Paginate between sets within the
// current block via the up/down arrows (round-major). Closed via the header
// Back button.
//
// Three edit modes, derived from where the viewing cursor lands:
//   - Focused set   → edits stash to sessions.pending_actuals; logSet applies
//                     them on Next / work-timer zero.
//   - Done set      → edits directly upsert the existing session_sets row.
//   - Pending/future→ read-only. Hint: "Edits apply when you reach this set."

import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import { NumberStepper } from '../../shared/components/NumberStepper'
import { SessionHeader } from '../../shared/components/SessionHeader'
import { TimerDock } from './TimerDock'
import {
  cursorsEqual,
  iterateBlockCursors,
  nextCursorInBlock,
  prevCursorInBlock,
} from './sessionEngine'
import type {
  Cursor,
  PendingActuals,
  SessionSetRow,
  SnapshotSetTarget,
  WorkoutSnapshot,
} from '../../types/schema'
import type { SessionSetId } from '../../types/ids'
import { uuid } from '../../shared/utils/uuid'
import styles from './SetView.module.css'

export function SetViewOverlay({ onClose }: { onClose: () => void }) {
  const sessionId = useSessionStore((s) => s.sessionId)
  const executionCursor = useSessionStore((s) => s.cursor)
  const pendingActuals = useSessionStore((s) => s.pendingActuals)
  const setPending = useSessionStore((s) => s.setPendingActuals)

  const session = useLiveQuery(() => (sessionId ? db.sessions.get(sessionId) : undefined), [sessionId])
  const logged = useLiveQuery<SessionSetRow[]>(
    async () => (sessionId ? await db.session_sets.where('session_id').equals(sessionId).toArray() : []),
    [sessionId],
  )

  const snapshot = useMemo<WorkoutSnapshot | null>(() => {
    if (!session?.workout_snapshot) return null
    try { return JSON.parse(session.workout_snapshot) as WorkoutSnapshot } catch { return null }
  }, [session])

  // Viewing cursor is local — starts at the execution cursor and moves via up/down.
  const [viewingCursor, setViewingCursor] = useState<Cursor | null>(executionCursor)
  useEffect(() => {
    // Reset viewing cursor whenever the execution cursor jumps (e.g., user
    // closed + reopened after Next). Preserves in-session navigation while
    // the overlay is open.
    setViewingCursor(executionCursor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionCursor?.blockPosition, executionCursor?.blockExercisePosition,
      executionCursor?.roundNumber, executionCursor?.setNumber])

  const target = useMemo<{ be: { name: string }; t: SnapshotSetTarget } | null>(() => {
    if (!snapshot || !viewingCursor) return null
    const b = snapshot.blocks.find((x) => x.position === viewingCursor.blockPosition)
    const be = b?.exercises.find((e) => e.position === viewingCursor.blockExercisePosition)
    // Round-aware target lookup: prefer the per-round row; fall back to the
    // round-1 anchor if this round has no explicit override.
    const t =
      be?.sets.find(
        (s) =>
          s.set_number === viewingCursor.setNumber &&
          (s.round_number ?? 1) === viewingCursor.roundNumber,
      )
      ?? be?.sets.find((s) => s.set_number === viewingCursor.setNumber && (s.round_number ?? 1) === 1)
    return be && t ? { be, t } : null
  }, [snapshot, viewingCursor])

  const doneRow = useMemo<SessionSetRow | undefined>(() => {
    if (!viewingCursor) return undefined
    return (logged ?? []).find(
      (r) =>
        r.block_position === viewingCursor.blockPosition &&
        r.block_exercise_position === viewingCursor.blockExercisePosition &&
        r.round_number === viewingCursor.roundNumber &&
        r.set_number === viewingCursor.setNumber,
    )
  }, [logged, viewingCursor])

  const isFocused = viewingCursor && executionCursor && cursorsEqual(viewingCursor, executionCursor)
  const isDone = Boolean(doneRow)
  const isFutureReadonly = !isFocused && !isDone

  const [weight, setWeight] = useState<number | null>(null)
  const [reps, setReps] = useState<number | null>(null)
  const [duration, setDuration] = useState<number | null>(null)

  useEffect(() => {
    if (!target) return
    if (isDone && doneRow) {
      setWeight(doneRow.actual_weight ?? target.t.target_weight ?? null)
      setReps(doneRow.actual_reps ?? target.t.target_reps ?? null)
      setDuration(doneRow.actual_duration_sec ?? target.t.target_duration_sec ?? null)
    } else {
      setWeight(pendingActuals?.actual_weight ?? target.t.target_weight ?? null)
      setReps(pendingActuals?.actual_reps ?? target.t.target_reps ?? null)
      setDuration(pendingActuals?.actual_duration_sec ?? target.t.target_duration_sec ?? null)
    }
  }, [target, doneRow, isDone, pendingActuals])

  // Commit strategy varies by edit mode.
  const commit = async (patch: { w?: number | null; r?: number | null; d?: number | null }) => {
    if (!viewingCursor || !target || !sessionId) return
    if (isFutureReadonly) return // no-op — readonly hint explains

    const nextWeight = patch.w !== undefined ? patch.w : weight
    const nextReps = patch.r !== undefined ? patch.r : reps
    const nextDuration = patch.d !== undefined ? patch.d : duration

    if (isFocused) {
      // Stash to session.pending_actuals; logSet consumes on Next.
      await setPending({
        actual_weight: nextWeight,
        actual_reps: nextReps,
        actual_duration_sec: nextDuration,
      } satisfies PendingActuals)
      return
    }

    // Done set — direct upsert-by-tuple to the existing row.
    if (doneRow) {
      const now = Date.now()
      const updated: SessionSetRow = {
        ...doneRow,
        actual_weight: nextWeight,
        actual_reps: nextReps,
        actual_duration_sec: nextDuration,
        updated_at: now,
      }
      await db.session_sets.put(updated)
      // Also bump the session so sync picks up the edit.
      const ses = await db.sessions.get(sessionId)
      if (ses) await db.sessions.put({ ...ses, updated_at: now })
    } else {
      // Defensive — shouldn't hit this branch because isFutureReadonly catches it.
      const now = Date.now()
      const newRow: SessionSetRow = {
        id: uuid('ss') as SessionSetId,
        session_id: sessionId,
        exercise_id: (() => {
          const be = snapshot!.blocks
            .find((x) => x.position === viewingCursor.blockPosition)!
            .exercises.find((e) => e.position === viewingCursor.blockExercisePosition)!
          return be.exercise_id
        })(),
        block_position: viewingCursor.blockPosition,
        block_exercise_position: viewingCursor.blockExercisePosition,
        round_number: viewingCursor.roundNumber,
        set_number: viewingCursor.setNumber,
        target_weight: target.t.target_weight ?? null,
        target_reps: target.t.target_reps ?? null,
        target_duration_sec: target.t.target_duration_sec ?? null,
        actual_weight: nextWeight,
        actual_reps: nextReps,
        actual_duration_sec: nextDuration,
        rpe: null,
        rest_taken_sec: null,
        is_pr: 0,
        was_swapped: 0,
        logged_at: now,
        created_at: now,
        updated_at: now,
        skipped: 0,
      }
      await db.session_sets.put(newRow)
    }
  }

  // Navigation
  const totalInBlock = snapshot && viewingCursor
    ? iterateBlockCursors(snapshot, viewingCursor.blockPosition).length
    : 0
  const indexInBlock = snapshot && viewingCursor
    ? iterateBlockCursors(snapshot, viewingCursor.blockPosition)
        .findIndex((c) => cursorsEqual(c, viewingCursor)) + 1
    : 0
  const canUp = snapshot && viewingCursor ? prevCursorInBlock(snapshot, viewingCursor) !== null : false
  const canDown = snapshot && viewingCursor ? nextCursorInBlock(snapshot, viewingCursor) !== null : false
  const onUp = () => {
    if (!snapshot || !viewingCursor) return
    const p = prevCursorInBlock(snapshot, viewingCursor)
    if (p) setViewingCursor(p)
  }
  const onDown = () => {
    if (!snapshot || !viewingCursor) return
    const n = nextCursorInBlock(snapshot, viewingCursor)
    if (n) setViewingCursor(n)
  }

  // Block context for block-kind tag (shows R/total for superset/circuit).
  const block = useMemo(() => {
    if (!snapshot || !viewingCursor) return null
    return snapshot.blocks.find((b) => b.position === viewingCursor.blockPosition) ?? null
  }, [snapshot, viewingCursor])

  const isTimed = target?.t.target_duration_sec != null
  const lastRestAfter = useMemo(() => {
    // TimerDock input still tied to the execution cursor's latest log.
    const latest = (logged ?? [])
      .filter((r) => r.block_position === executionCursor?.blockPosition)
      .sort((a, b) => b.logged_at - a.logged_at)[0]
    if (!latest || !snapshot) return null
    const b = snapshot.blocks.find((x) => x.position === latest.block_position)
    const be = b?.exercises.find((e) => e.position === latest.block_exercise_position)
    if (!be) return null
    const match =
      be.sets.find(
        (s) => s.set_number === latest.set_number && (s.round_number ?? 1) === latest.round_number,
      )
      ?? be.sets.find((s) => s.set_number === latest.set_number && (s.round_number ?? 1) === 1)
    return match?.rest_after_sec ?? null
  }, [logged, executionCursor, snapshot])

  if (!target || !viewingCursor) return null

  const status = isFocused ? 'NOW' : isDone ? '✓' : null
  const roundPill = block && block.kind !== 'single'
    ? `R${viewingCursor.roundNumber}/${block.rounds}`
    : null

  return (
    <div className={styles.overlay}>
      <SessionHeader backLabel="Block" onBack={onClose}>
        EDIT SET · {indexInBlock} / {totalInBlock}
      </SessionHeader>

      <TimerDock
        lastLoggedAt={(logged ?? [])
          .filter((r) => r.block_position === executionCursor?.blockPosition)
          .sort((a, b) => b.logged_at - a.logged_at)[0]?.logged_at ?? null}
        lastLoggedRestAfterSec={lastRestAfter}
        workTimerStartedAt={session?.work_timer_started_at ?? null}
        workTimerDurationSec={session?.work_timer_duration_sec ?? null}
      />

      <h1 className={styles.display}>{target.be.name}</h1>

      <div className={styles.navRow}>
        <button
          type="button"
          className={styles.navArrow}
          onClick={onUp}
          disabled={!canUp}
          aria-label="Previous set"
        >
          ▲
        </button>
        <div className={styles.setLabel}>
          SET {viewingCursor.setNumber}
          {roundPill ? ` · ${roundPill}` : ''}
          {status ? ` · ${status}` : ''}
          {target.t.is_peak ? ' ★' : ''}
        </div>
        <button
          type="button"
          className={styles.navArrow}
          onClick={onDown}
          disabled={!canDown}
          aria-label="Next set"
        >
          ▼
        </button>
      </div>

      {isTimed ? (
        <NumberStepper
          label="Duration"
          value={duration}
          step={5}
          min={0}
          unit="sec"
          onChange={(v) => { setDuration(v); void commit({ d: v }) }}
          allowNull
        />
      ) : (
        <div className={styles.stack}>
          <NumberStepper
            label="Weight"
            value={weight}
            step={5}
            unit="lb"
            onChange={(v) => { setWeight(v); void commit({ w: v }) }}
            allowNull
          />
          <NumberStepper
            label={target.t.target_reps_each ? 'Reps (each side)' : 'Reps'}
            value={reps}
            step={1}
            min={0}
            onChange={(v) => { setReps(v); void commit({ r: v }) }}
            allowNull
          />
        </div>
      )}

      <p className={styles.hint}>
        {isFutureReadonly ? (
          <>This set hasn't been reached yet. Edits apply when you reach it.</>
        ) : isDone ? (
          <>Editing the logged values for this set. Changes save automatically.</>
        ) : null}
      </p>
    </div>
  )
}
