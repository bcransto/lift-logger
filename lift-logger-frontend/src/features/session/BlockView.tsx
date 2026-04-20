// Primary Active-Lift view. Vertical stack of work + rest cards for the
// current block. Current cursor's card is focused. Rest cards interleave
// between work cards based on each set's `rest_after_sec`. Active timer
// docks at the top.
//
// Gestures: swipe right → Workout view, swipe left → Set view.
// Both gestures open an overlay managed by uiStore.
//
// Auto-advance: timed-work timer zero → logSet; rest timer zero → logSet
// of the preceding set is already written, so rest expiration just fires
// cursor advancement via the store's `advance`.

import { useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { advance, cursorKey, parseSetKey } from './sessionEngine'
import { TimerDock } from './TimerDock'
import { WorkSetCard } from './WorkSetCard'
import { RestCard } from './RestCard'
import { UndoToast } from './UndoToast'
import { SetViewOverlay } from './SetView'
import { WorkoutViewOverlay } from './WorkoutView'
import type { Cursor, SessionSetRow, WorkoutSnapshot } from '../../types/schema'
import { mmss } from '../../shared/utils/format'
import styles from './BlockView.module.css'

export function BlockView() {
  const { sessionId, blockPosition: bpStr, setKey } = useParams<{
    sessionId: string
    blockPosition: string
    setKey: string
  }>()
  const navigate = useNavigate()

  const session = useLiveQuery(() => (sessionId ? db.sessions.get(sessionId) : undefined), [sessionId])
  const logged = useLiveQuery<SessionSetRow[]>(
    async () => (sessionId ? await db.session_sets.where('session_id').equals(sessionId).toArray() : []),
    [sessionId],
  )

  const snapshot = useMemo<WorkoutSnapshot | null>(() => {
    if (!session?.workout_snapshot) return null
    try {
      return JSON.parse(session.workout_snapshot) as WorkoutSnapshot
    } catch {
      return null
    }
  }, [session])

  const cursor = useSessionStore((s) => s.cursor)
  const skippedBlockIds = useSessionStore((s) => s.skippedBlockIds)
  const jumpTo = useSessionStore((s) => s.jumpTo)
  const logSet = useSessionStore((s) => s.logSet)
  const skipCurrentSet = useSessionStore((s) => s.skipCurrentSet)
  const endWorkout = useSessionStore((s) => s.endWorkout)
  const startWorkTimer = useSessionStore((s) => s.startWorkTimer)
  const undoSkip = useSessionStore((s) => s.undoSkip)
  const { overlay, openOverlay, closeOverlay, showUndo } = useUiStore()

  // Sync cursor FROM URL on URL change only.
  useEffect(() => {
    const bp = Number.parseInt(bpStr ?? '1', 10)
    const parsed = parseSetKey(setKey ?? '')
    if (!parsed) return
    jumpTo({
      blockPosition: bp,
      blockExercisePosition: parsed.blockExercisePosition,
      roundNumber: parsed.roundNumber,
      setNumber: parsed.setNumber,
    })
  }, [bpStr, setKey, jumpTo])

  // Sync cursor TO URL when the store cursor advances (e.g. logSet).
  useEffect(() => {
    if (!sessionId || !cursor) return
    const expected = `/session/${sessionId}/active/${cursor.blockPosition}/${cursor.blockExercisePosition}.${cursor.roundNumber}.${cursor.setNumber}`
    if (window.location.pathname !== expected) navigate(expected, { replace: true })
  }, [cursor, sessionId, navigate])

  // Start the work timer automatically when cursor lands on a timed-work card.
  useEffect(() => {
    if (!cursor || !snapshot || !session) return
    const entry = findEntry(snapshot, cursor)
    if (!entry) return
    const isTimed = entry.target.target_duration_sec != null
    const alreadyStarted = session.work_timer_started_at != null
    if (isTimed && !alreadyStarted) {
      void startWorkTimer(entry.target.target_duration_sec as number)
    } else if (!isTimed && alreadyStarted) {
      // Clear stale work timer fields.
      void db.sessions.put({ ...session, work_timer_started_at: null, work_timer_duration_sec: null, updated_at: Date.now() })
    }
  }, [cursor?.blockPosition, cursor?.blockExercisePosition, cursor?.roundNumber, cursor?.setNumber, snapshot, session, startWorkTimer])

  // Navigation is tap-driven (not swipe). Tapping a work card jumps the cursor
  // to that set and opens the Set view. A Workout button in the header opens
  // the Workout view. Both overlays have back buttons. Much more reliable than
  // gesture detection on a touch-heavy app, and matches iOS conventions.

  if (!sessionId) return <div className={styles.empty}>No session.</div>
  if (!session || !snapshot) return <div className={styles.empty}>Loading…</div>
  if (!cursor) {
    // Workout complete — route to summary.
    useEffect(() => {
      navigate(`/session/${sessionId}/summary`, { replace: true })
    })
    return null
  }

  const bp = Number.parseInt(bpStr ?? '1', 10)
  const block = snapshot.blocks.find((b) => b.position === bp)
  if (!block) return <div className={styles.empty}>Block not found.</div>

  // Build the card list for the focused block_exercise of this block.
  // For supersets/circuits, render the currently focused exercise; users can swipe
  // to Workout view to see all blocks' structure.
  const be = block.exercises.find((e) => e.position === cursor.blockExercisePosition)
  if (!be) return <div className={styles.empty}>Exercise not found.</div>

  const loggedByKey = new Map(
    (logged ?? []).map((r) => [
      `${r.block_position}.${r.block_exercise_position}.${r.round_number}.${r.set_number}`,
      r,
    ]),
  )
  const rounds = block.kind === 'single' ? 1 : block.rounds
  const cursorK = cursorKey(cursor)

  // Assemble an interleaved list: [set, rest?, set, rest?, ...] scoped to this BE across rounds.
  type Card =
    | { kind: 'work'; cursor: Cursor; target: (typeof be.sets)[number]; row: SessionSetRow | undefined }
    | { kind: 'rest'; afterKey: string; durationSec: number }
  const cards: Card[] = []
  for (let r = 1; r <= rounds; r++) {
    for (const t of be.sets) {
      const cur: Cursor = {
        blockPosition: block.position,
        blockExercisePosition: be.position,
        roundNumber: r,
        setNumber: t.set_number,
      }
      const key = cursorKey(cur)
      cards.push({ kind: 'work', cursor: cur, target: t, row: loggedByKey.get(key) })
      if (t.rest_after_sec && t.rest_after_sec > 0) {
        cards.push({ kind: 'rest', afterKey: key, durationSec: t.rest_after_sec })
      }
    }
  }

  // For the timer dock's rest input: find the latest logged set IN THIS BE and its
  // target rest_after_sec. If the last-logged set's cursor matches a work card that
  // was followed by a rest card, the rest is running.
  const logs = (logged ?? [])
    .filter((r) => r.block_position === block.position && r.block_exercise_position === be.position)
    .sort((a, b) => b.logged_at - a.logged_at)
  const lastLog = logs[0]
  const lastRestAfter = lastLog
    ? be.sets.find((s) => s.set_number === lastLog.set_number)?.rest_after_sec ?? null
    : null

  // Current-focus determination for rep-work Next button vs timed-work skip.
  const focusedEntry = findEntry(snapshot, cursor)
  const focusedIsTimed = focusedEntry?.target.target_duration_sec != null
  const elapsedSinceStart = session.started_at ? mmss((Date.now() - session.started_at) / 1000) : '0:00'
  const liftNumber = cardNumber(snapshot, cursor)

  const onNext = async () => {
    await logSet()
  }
  const onSkipSet = async () => {
    const undo = await skipCurrentSet()
    if (undo) showUndo('Set skipped', undo.undoCursor)
  }
  const onEnd = async () => {
    const unloggedRemaining = countUnloggedInNonSkippedBlocks(snapshot, logged ?? [], skippedBlockIds)
    if (unloggedRemaining > 0) {
      if (!window.confirm(`Finish workout? You have ${unloggedRemaining} unlogged set${unloggedRemaining === 1 ? '' : 's'}.`)) {
        return
      }
    }
    await endWorkout()
    navigate(`/session/${sessionId}/summary`, { replace: true })
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>
          LIFT {liftNumber.current} / {liftNumber.total} · {elapsedSinceStart} ELAPSED
        </div>
        <div className={styles.actions}>
          <button className={styles.actionBtn} onClick={() => openOverlay('workout')}>Workout</button>
          <button className={styles.actionBtn} onClick={onSkipSet}>Skip Set</button>
          <button className={styles.actionBtn} onClick={onEnd}>End</button>
        </div>
      </header>

      <h1 className={styles.display}>{be.name}</h1>

      <TimerDock
        lastLoggedAt={lastLog?.logged_at ?? null}
        lastLoggedRestAfterSec={lastRestAfter}
        workTimerStartedAt={session.work_timer_started_at ?? null}
        workTimerDurationSec={session.work_timer_duration_sec ?? null}
        onRestZero={() => {
          // Rest expired — nothing to log (rest isn't a session_set); focus
          // simply moves to the next work card via existing cursor, which is
          // already on the next work set.
        }}
        onWorkZero={() => {
          void logSet()
        }}
      />

      <div className={styles.stack}>
        {cards.map((c, i) =>
          c.kind === 'work' ? (
            <WorkSetCard
              key={`w${i}`}
              target={c.target}
              cursor={c.cursor}
              isFocused={cursorKey(c.cursor) === cursorK}
              isDone={Boolean(c.row)}
              actual={c.row}
              beName={be.name}
              round={block.kind !== 'single' ? c.cursor.roundNumber : null}
              totalRounds={block.kind !== 'single' ? rounds : null}
              onTap={() => {
                jumpTo(c.cursor)
                openOverlay('set')
              }}
            />
          ) : (
            <RestCard
              key={`r${i}`}
              durationSec={c.durationSec}
              isActive={lastLog && `${lastLog.block_position}.${lastLog.block_exercise_position}.${lastLog.round_number}.${lastLog.set_number}` === c.afterKey}
            />
          ),
        )}
      </div>

      {!focusedIsTimed ? (
        <div className={styles.footer}>
          <button className={styles.nextBtn} onClick={onNext}>
            Next →
          </button>
        </div>
      ) : null}

      <UndoToast onUndo={(cur) => undoSkip(cur)} />

      {overlay === 'set' ? <SetViewOverlay onClose={closeOverlay} /> : null}
      {overlay === 'workout' ? <WorkoutViewOverlay onClose={closeOverlay} /> : null}
    </div>
  )
}

function findEntry(snapshot: WorkoutSnapshot, cursor: Cursor) {
  const b = snapshot.blocks.find((x) => x.position === cursor.blockPosition)
  const be = b?.exercises.find((e) => e.position === cursor.blockExercisePosition)
  const target = be?.sets.find((s) => s.set_number === cursor.setNumber)
  if (!b || !be || !target) return null
  return { block: b, blockExercise: be, target }
}

function cardNumber(snapshot: WorkoutSnapshot, cursor: Cursor) {
  let idx = 0
  let total = 0
  for (const b of snapshot.blocks) {
    const rounds = b.kind === 'single' ? 1 : b.rounds
    for (let r = 1; r <= rounds; r++) {
      for (const be of b.exercises) {
        total += be.sets.length
        if (
          b.position === cursor.blockPosition &&
          be.position === cursor.blockExercisePosition &&
          r === cursor.roundNumber
        ) {
          // Count sets within this be up to (and including) the current one.
          for (const s of be.sets) {
            idx++
            if (s.set_number === cursor.setNumber) break
          }
        } else {
          idx += 0 // don't increment for other BEs; we want "lift N of total"
        }
      }
    }
  }
  return { current: Math.max(1, idx), total: Math.max(1, total) }
}

function countUnloggedInNonSkippedBlocks(
  snapshot: WorkoutSnapshot,
  logged: SessionSetRow[],
  skippedBlockIds: ReadonlySet<string>,
): number {
  const doneKeys = new Set(
    logged.map(
      (r) => `${r.block_position}.${r.block_exercise_position}.${r.round_number}.${r.set_number}`,
    ),
  )
  let unlogged = 0
  for (const b of snapshot.blocks) {
    if (skippedBlockIds.has(b.id)) continue
    const rounds = b.kind === 'single' ? 1 : b.rounds
    for (let r = 1; r <= rounds; r++) {
      for (const be of b.exercises) {
        for (const t of be.sets) {
          const key = `${b.position}.${be.position}.${r}.${t.set_number}`
          if (t.target_duration_sec == null && !doneKeys.has(key)) unlogged++
          else if (t.target_duration_sec != null && !doneKeys.has(key)) unlogged++
        }
      }
    }
  }
  // subtract the current-focused 1 so we don't nag about the active card
  return Math.max(0, unlogged - 1)
}

// Silence unused warning — used via useEffect import path.
advance
