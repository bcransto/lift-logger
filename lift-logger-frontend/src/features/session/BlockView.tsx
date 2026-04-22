// Primary Active-Lift view. Renders the current block's execution stack.
//
// Two layouts, branched on block.kind:
//
//   - 'single'         → new tap-to-log model (see plan addendum):
//                        pre-tap card → tap opens SetLogger + starts block
//                        timer → Record logs (no advance), card enters
//                        rest-with-Next state with timer below → Next advances
//                        + stops timer. On last set, Record opens the
//                        BlockCompleteOverlay instead of a rest card.
//   - 'superset'/'circuit' → legacy round-major stack with inline Next buttons
//                            and a terminal Finish Block card. Kept until the
//                            multi-kind flows get their own design pass.
//
// Header: LEFT = Workout view button, RIGHT = Set view button (for editing
// past sets).

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { cursorKey, cursorKeyFromRow, isLastSetOfBlock, isNewBlock, parseSetKey, setsForRound, targetAt } from './sessionEngine'
import { TimerDock } from './TimerDock'
import { WorkSetCard } from './WorkSetCard'
import { RestCard } from './RestCard'
import { UndoToast } from './UndoToast'
import { SetViewOverlay } from './SetView'
import { WorkoutViewOverlay } from './WorkoutView'
import { SetLogger, type SetLoggerActuals } from './SetLogger'
import { BlockCompleteOverlay } from './BlockCompleteOverlay'
import type {
  Cursor,
  SessionSetRow,
  SnapshotBlockExercise,
  SnapshotSetTarget,
  WorkoutSnapshot,
} from '../../types/schema'
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
    try { return JSON.parse(session.workout_snapshot) as WorkoutSnapshot } catch { return null }
  }, [session])

  const cursor = useSessionStore((s) => s.cursor)
  const skippedBlockIds = useSessionStore((s) => s.skippedBlockIds)
  const jumpTo = useSessionStore((s) => s.jumpTo)
  const logSet = useSessionStore((s) => s.logSet)
  const skipCurrentSet = useSessionStore((s) => s.skipCurrentSet)
  const endWorkout = useSessionStore((s) => s.endWorkout)
  const startWorkTimer = useSessionStore((s) => s.startWorkTimer)
  const startActiveTimer = useSessionStore((s) => s.startActiveTimer)
  const stopActiveTimer = useSessionStore((s) => s.stopActiveTimer)
  const advanceCursor = useSessionStore((s) => s.advanceCursor)
  const undoSkip = useSessionStore((s) => s.undoSkip)
  const { overlay, openOverlay, closeOverlay, showUndo } = useUiStore()

  // Block position to show BlockCompleteOverlay for (captured at Record-time
  // before the cursor advances, so the overlay shows the block we just finished).
  const [blockCompletePos, setBlockCompletePos] = useState<number | null>(null)

  // Cursor is the source of truth. URL is a derived projection.

  const mountSyncedRef = useRef(false)
  useEffect(() => {
    if (!sessionId) return
    if (mountSyncedRef.current) return
    mountSyncedRef.current = true
    if (cursor) {
      const expected = `/session/${sessionId}/active/${cursor.blockPosition}/${cursor.blockExercisePosition}.${cursor.roundNumber}.${cursor.setNumber}`
      if (window.location.pathname !== expected) {
        navigate(expected, { replace: true })
      }
    } else {
      const bp = Number.parseInt(bpStr ?? '1', 10)
      const parsed = parseSetKey(setKey ?? '')
      if (parsed) {
        jumpTo({
          blockPosition: bp,
          blockExercisePosition: parsed.blockExercisePosition,
          roundNumber: parsed.roundNumber,
          setNumber: parsed.setNumber,
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Cursor → URL on every subsequent cursor change.
  // When cursor crosses into a new block (first set of a block other than the
  // one in the URL), route through BlockIntroScreen so the user gets the
  // "UP NEXT · REST · I'm Ready" ceremony between blocks. Suppressed while
  // the BlockCompleteOverlay is open — the overlay owns the next-block nav.
  useEffect(() => {
    if (!sessionId || !cursor || !mountSyncedRef.current || !snapshot) return
    if (overlay === 'blockComplete') return
    const currentBpInUrl = Number.parseInt(bpStr ?? '1', 10)
    if (cursor.blockPosition !== currentBpInUrl && isNewBlock(snapshot, cursor)) {
      navigate(`/session/${sessionId}/intro/${cursor.blockPosition}`, { replace: true })
      return
    }
    const expected = `/session/${sessionId}/active/${cursor.blockPosition}/${cursor.blockExercisePosition}.${cursor.roundNumber}.${cursor.setNumber}`
    if (window.location.pathname !== expected) navigate(expected, { replace: true })
  }, [cursor, sessionId, navigate, snapshot, bpStr, overlay])

  // Work-timer lifecycle for legacy timed-work sets (superset/circuit only).
  useEffect(() => {
    if (!cursor || !snapshot || !session) return
    const entry = targetAt(snapshot, cursor)
    if (!entry) return
    if (entry.block.kind === 'single') return // single blocks use startActiveTimer on tap
    const isTimed = entry.target.target_duration_sec != null
    const alreadyStarted = session.work_timer_started_at != null
    if (isTimed && !alreadyStarted) {
      void startWorkTimer(entry.target.target_duration_sec as number)
    } else if (!isTimed && alreadyStarted) {
      void db.sessions.put({
        ...session,
        work_timer_started_at: null,
        work_timer_duration_sec: null,
        updated_at: Date.now(),
      })
    }
  }, [cursor?.blockPosition, cursor?.blockExercisePosition, cursor?.roundNumber, cursor?.setNumber, snapshot, session, startWorkTimer])

  // Workout complete: cursor becomes null after the final logSet advance.
  useEffect(() => {
    if (sessionId && snapshot && !cursor) {
      navigate(`/session/${sessionId}/summary`, { replace: true })
    }
  }, [cursor, sessionId, snapshot, navigate])

  // Clear the captured block-complete position whenever the overlay variant
  // is no longer 'blockComplete'. Lets BCO swap to WorkoutView (via
  // openOverlay('workout')) without leaving stale state behind.
  useEffect(() => {
    if (overlay !== 'blockComplete' && blockCompletePos !== null) {
      setBlockCompletePos(null)
    }
  }, [overlay, blockCompletePos])

  if (!sessionId) return <div className={styles.empty}>No session.</div>
  if (!session || !snapshot) return <div className={styles.empty}>Loading…</div>
  if (!cursor) return null // the useEffect above navigates us away

  const bp = Number.parseInt(bpStr ?? '1', 10)
  const block = snapshot.blocks.find((b) => b.position === bp)
  if (!block) return <div className={styles.empty}>Block not found.</div>

  const bes = block.exercises.slice().sort((a, b) => a.position - b.position)
  const loggedByKey = new Map((logged ?? []).map((r) => [cursorKeyFromRow(r), r]))

  const elapsedSinceStart = session.started_at
    ? mmss((Date.now() - session.started_at) / 1000)
    : '0:00'
  const liftNumber = cardNumber(snapshot, cursor)

  const onSkipSet = async () => {
    const undo = await skipCurrentSet()
    if (undo) showUndo('Set skipped', undo.undoCursor)
  }

  const onEnd = async () => {
    const unloggedRemaining = countUnloggedInNonSkippedBlocks(snapshot, logged ?? [], skippedBlockIds)
    if (unloggedRemaining > 0) {
      if (!window.confirm(
        `Finish workout? You have ${unloggedRemaining} unlogged set${unloggedRemaining === 1 ? '' : 's'}.`,
      )) return
    }
    await endWorkout()
    navigate(`/session/${sessionId}/summary`, { replace: true })
  }

  const blockTitle = bes.map((e) => e.name).join('  +  ')
  const blockKindTag =
    block.kind === 'superset' ? `SUPERSET × ${block.rounds}` : block.kind === 'circuit' ? `CIRCUIT × ${block.rounds}` : null

  // ─── Single-block render path ──────────────────────────────────────
  if (block.kind === 'single') {
    const be = bes[0]
    if (!be) return <div className={styles.empty}>Block has no exercises.</div>

    const onTapPreFocused = async (setNumber: number) => {
      // Seed form state is handled inside SetLogger from the current cursor.
      // The tap both starts the active timer and opens the logger.
      const targetSet = be.sets.find((s) => s.set_number === setNumber)
      const rest = targetSet?.rest_after_sec ?? null
      // For the last set of the block: use workout_blocks.rest_after_sec as
      // the block-rest countdown; else count up.
      const isLast = be.sets[be.sets.length - 1]?.set_number === setNumber
      const dur = isLast
        ? (block.rest_after_sec && block.rest_after_sec > 0 ? block.rest_after_sec : null)
        : (rest && rest > 0 ? rest : null)
      await startActiveTimer(dur)
      openOverlay('setLogger')
    }

    const onSetLoggerRecord = async (actuals: SetLoggerActuals) => {
      // Capture whether we're on the last set BEFORE logSet runs.
      const wasLastOfBlock = isLastSetOfBlock(snapshot, cursor)
      const blockPos = cursor.blockPosition
      await logSet({
        actualWeight: actuals.actualWeight,
        actualReps: actuals.actualReps,
        actualDurationSec: actuals.actualDurationSec,
        advance: false,
      })
      closeOverlay()
      if (wasLastOfBlock) {
        setBlockCompletePos(blockPos)
        openOverlay('blockComplete')
      }
    }

    const onSetLoggerCancel = async () => {
      await stopActiveTimer()
      closeOverlay()
    }

    const onInlineNext = async () => {
      // Rest → advance to next set + stop the active timer.
      await stopActiveTimer()
      advanceCursor()
    }

    const onBlockCompleteClose = () => {
      setBlockCompletePos(null)
      closeOverlay()
    }

    // End Block → open BCO for the current block. Confirm if there are
    // unlogged sets remaining in this block.
    const onEndBlock = () => {
      const unloggedInBlock = be.sets.filter((t) => {
        const k = cursorKey({
          blockPosition: block.position,
          blockExercisePosition: be.position,
          roundNumber: 1,
          setNumber: t.set_number,
        })
        return !loggedByKey.has(k)
      }).length
      if (unloggedInBlock > 0) {
        if (!window.confirm(
          `End this block? ${unloggedInBlock} set${unloggedInBlock === 1 ? '' : 's'} unlogged.`,
        )) return
      }
      setBlockCompletePos(block.position)
      openOverlay('blockComplete')
    }

    return (
      <div className={styles.root}>
        <header className={styles.header}>
          <button
            className={styles.navBtn}
            onClick={() => openOverlay('workout')}
            aria-label="Workout view"
          >
            ☰ Workout
          </button>
          <div className={styles.eyebrow}>
            LIFT {liftNumber.current} / {liftNumber.total} · {elapsedSinceStart}
          </div>
          <button
            className={styles.navBtn}
            onClick={() => openOverlay('set')}
            aria-label="Set view"
          >
            Set ⋮
          </button>
        </header>

        <h1 className={styles.display}>{blockTitle}</h1>

        <div className={styles.secondaryActions}>
          <button className={styles.actionBtn} onClick={onSkipSet}>Skip Set</button>
          <button className={styles.actionBtn} onClick={onEndBlock}>End Block</button>
          <button className={styles.actionBtn} onClick={onEnd}>End Workout</button>
        </div>

        <div className={styles.stack}>
          {be.sets.map((t) => {
            const c: Cursor = {
              blockPosition: block.position,
              blockExercisePosition: be.position,
              roundNumber: 1,
              setNumber: t.set_number,
            }
            const row = loggedByKey.get(cursorKey(c))
            const isCursorSet =
              c.blockPosition === cursor.blockPosition &&
              c.blockExercisePosition === cursor.blockExercisePosition &&
              c.roundNumber === cursor.roundNumber &&
              c.setNumber === cursor.setNumber
            const isLogged = Boolean(row)
            const isRestMode = isCursorSet && isLogged
            const isPreTap = isCursorSet && !isLogged

            return (
              <div key={`s${t.set_number}`} className={styles.singleCardWrap}>
                <WorkSetCard
                  target={t}
                  cursor={c}
                  isFocused={isCursorSet}
                  isDone={isLogged}
                  actual={row}
                  beName={be.name}
                  showExName={false}
                  round={null}
                  totalRounds={null}
                  onRecord={isPreTap ? () => void onTapPreFocused(t.set_number) : undefined}
                />
                {isRestMode ? (
                  <RestWithNext
                    startedAt={session.work_timer_started_at ?? null}
                    durationSec={session.work_timer_duration_sec ?? null}
                    onNext={() => void onInlineNext()}
                  />
                ) : null}
              </div>
            )
          })}
        </div>

        <UndoToast onUndo={(cur) => undoSkip(cur)} />

        {overlay === 'set' ? <SetViewOverlay onClose={closeOverlay} /> : null}
        {overlay === 'workout' ? <WorkoutViewOverlay onClose={closeOverlay} /> : null}
        {overlay === 'setLogger' ? (
          <SetLogger onRecord={onSetLoggerRecord} onCancel={onSetLoggerCancel} />
        ) : null}
        {overlay === 'blockComplete' && blockCompletePos !== null ? (
          <BlockCompleteOverlay
            blockPosition={blockCompletePos}
            onClose={onBlockCompleteClose}
          />
        ) : null}
      </div>
    )
  }

  // ─── Legacy superset/circuit render path (unchanged) ───────────────

  const cursorK = cursorKey(cursor)
  const rounds = block.rounds

  type Card =
    | { kind: 'work'; cursor: Cursor; target: SnapshotSetTarget; be: SnapshotBlockExercise; row: SessionSetRow | undefined }
    | { kind: 'rest'; afterKey: string; durationSec: number; isActive: boolean }
    | { kind: 'next'; afterKey: string; active: boolean }
    | { kind: 'finishBlock'; afterKey: string; active: boolean; isTimed: boolean; isLastBlockOverall: boolean }
  const cards: Card[] = []

  const latestInBlock = (logged ?? [])
    .filter((r) => r.block_position === block.position)
    .sort((a, b) => b.logged_at - a.logged_at)[0]
  const latestKey = latestInBlock ? cursorKeyFromRow(latestInBlock) : null

  for (let r = 1; r <= rounds; r++) {
    for (let beIdx = 0; beIdx < bes.length; beIdx++) {
      const be = bes[beIdx]!
      // Filter to this round's targets (with round-1 fallback for inherited rounds).
      const roundSets = setsForRound(be, r)
      for (let sIdx = 0; sIdx < roundSets.length; sIdx++) {
        const t = roundSets[sIdx]!
        const cur: Cursor = {
          blockPosition: block.position,
          blockExercisePosition: be.position,
          roundNumber: r,
          setNumber: t.set_number,
        }
        const key = cursorKey(cur)
        cards.push({ kind: 'work', cursor: cur, target: t, be, row: loggedByKey.get(key) })

        const isLastSetInBe = sIdx === roundSets.length - 1
        const isLastBeInRound = beIdx === bes.length - 1
        const isLastRound = r === rounds
        const isLastOverall = isLastSetInBe && isLastBeInRound && isLastRound
        if (isLastOverall) {
          const lastBlockInWorkout = snapshot.blocks
            .filter((b) => !skippedBlockIds.has(b.id))
            .sort((a, b) => a.position - b.position)
            .at(-1)
          const isLastBlockOverall = lastBlockInWorkout?.id === block.id
          cards.push({
            kind: 'finishBlock',
            afterKey: key,
            active: cursorK === key,
            isTimed: t.target_duration_sec != null,
            isLastBlockOverall,
          })
          continue
        }

        const isRoundBoundary = isLastSetInBe && isLastBeInRound && !isLastRound
        // v3 per-round rest: at a round boundary, prefer the rest_after_sec
        // of the last-set row of the ending round (that's `t` here — we're
        // on the last set of the last BE of round `r`). Falls back to the
        // block-level rest so legacy templates without per-round rest keep
        // their existing single-value behavior.
        const restAfter = isRoundBoundary
          ? (t.rest_after_sec ?? block.rest_after_sec ?? 0)
          : (t.rest_after_sec ?? 0)
        if (restAfter > 0) {
          cards.push({
            kind: 'rest',
            afterKey: key,
            durationSec: restAfter,
            isActive: latestKey === key,
          })
        } else {
          cards.push({
            kind: 'next',
            afterKey: key,
            active: cursorK === key,
          })
        }
      }
    }
  }

  const lastRestAfter = (() => {
    if (!latestInBlock) return null
    const latestCursor: Cursor = {
      blockPosition: latestInBlock.block_position,
      blockExercisePosition: latestInBlock.block_exercise_position,
      roundNumber: latestInBlock.round_number,
      setNumber: latestInBlock.set_number,
    }
    if (isLastSetOfBlock(snapshot, latestCursor)) {
      return block.rest_after_sec ?? null
    }
    const be = bes.find((e) => e.position === latestInBlock.block_exercise_position)
    if (!be) return null
    const match = be.sets.find(
      (s) =>
        s.set_number === latestInBlock.set_number &&
        (s.round_number ?? 1) === latestInBlock.round_number,
    )
      ?? be.sets.find((s) => s.set_number === latestInBlock.set_number && (s.round_number ?? 1) === 1)
    return match?.rest_after_sec ?? null
  })()

  const focusedEntry = targetAt(snapshot, cursor)
  const focusedIsTimed = focusedEntry?.target.target_duration_sec != null

  const onInlineNextLegacy = async () => {
    await logSet() // default advance: true
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <button
          className={styles.navBtn}
          onClick={() => openOverlay('workout')}
          aria-label="Workout view"
        >
          ☰ Workout
        </button>
        <div className={styles.eyebrow}>
          LIFT {liftNumber.current} / {liftNumber.total} · {elapsedSinceStart}
        </div>
        <button
          className={styles.navBtn}
          onClick={() => openOverlay('set')}
          aria-label="Set view"
        >
          Set ⋮
        </button>
      </header>

      <h1 className={styles.display}>{blockTitle}</h1>
      {blockKindTag ? <div className={styles.blockTag}>{blockKindTag}</div> : null}

      <div className={styles.secondaryActions}>
        <button className={styles.actionBtn} onClick={onSkipSet}>Skip Set</button>
        <button className={styles.actionBtn} onClick={onEnd}>End Workout</button>
      </div>

      <TimerDock
        lastLoggedAt={latestInBlock?.logged_at ?? null}
        lastLoggedRestAfterSec={lastRestAfter}
        workTimerStartedAt={session.work_timer_started_at ?? null}
        workTimerDurationSec={session.work_timer_duration_sec ?? null}
        onRestZero={() => {}}
        onWorkZero={() => { void logSet() }}
      />

      <div className={styles.stack}>
        {cards.map((c, i) => {
          if (c.kind === 'work') {
            const isFocused = cursorKey(c.cursor) === cursorK
            return (
              <WorkSetCard
                key={`w${i}`}
                target={c.target}
                cursor={c.cursor}
                isFocused={isFocused}
                isDone={Boolean(c.row)}
                actual={c.row}
                beName={c.be.name}
                showExName={bes.length > 1}
                round={c.cursor.roundNumber}
                totalRounds={rounds}
                onTap={isFocused ? () => openOverlay('set') : undefined}
              />
            )
          }
          if (c.kind === 'rest') {
            return <RestCard key={`r${i}`} durationSec={c.durationSec} isActive={c.isActive} />
          }
          if (c.kind === 'finishBlock') {
            const label = c.isLastBlockOverall ? '✓ Finish Workout' : '✓ Finish Block'
            return (
              <div key={`f${i}`} className={styles.finishBlockWrap}>
                <button
                  className={`${styles.finishBlock} ${c.active && !c.isTimed ? styles.finishBlockActive : ''}`}
                  onClick={c.active && !c.isTimed ? onInlineNextLegacy : undefined}
                  disabled={!c.active || c.isTimed}
                  aria-label={label}
                >
                  {label}
                  {c.active && c.isTimed ? <span className={styles.finishHint}> · auto on timer zero</span> : null}
                </button>
              </div>
            )
          }
          return (
            <div key={`n${i}`} className={styles.inlineNextWrap}>
              <button
                className={`${styles.inlineNext} ${c.active ? styles.inlineNextActive : ''}`}
                onClick={c.active ? onInlineNextLegacy : undefined}
                disabled={!c.active || focusedIsTimed}
                aria-label={c.active ? 'Next set' : 'Next (not active)'}
              >
                Next →
              </button>
            </div>
          )
        })}
      </div>

      <UndoToast onUndo={(cur) => undoSkip(cur)} />

      {overlay === 'set' ? <SetViewOverlay onClose={closeOverlay} /> : null}
      {overlay === 'workout' ? <WorkoutViewOverlay onClose={closeOverlay} /> : null}
    </div>
  )
}

// ─── RestWithNext ──────────────────────────────────────────────────
// Rendered below a just-logged card in the single-block layout. Shows a
// live-updating timer (countdown or count-up, per the session's active-
// timer fields) and a Next button that advances focus + stops the timer.

function RestWithNext({
  startedAt,
  durationSec,
  onNext,
}: {
  startedAt: number | null
  durationSec: number | null
  onNext: () => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const display = (() => {
    if (startedAt == null) return null
    const elapsed = Math.floor((now - startedAt) / 1000)
    if (durationSec == null) {
      return { text: mmss(Math.max(0, elapsed)), ready: false, label: 'Elapsed' }
    }
    const remaining = durationSec - elapsed
    if (remaining <= 0) return { text: 'READY', ready: true, label: 'Rest' }
    return { text: mmss(remaining), ready: false, label: 'Rest' }
  })()

  return (
    <div className={styles.singleTimer}>
      <div>
        <div className={styles.singleTimerLabel}>
          {display ? display.label : 'Rest'}
        </div>
        <div className={`${styles.singleTimerValue} ${display?.ready ? styles.singleTimerReady : ''}`}>
          {display?.text ?? '—'}
        </div>
      </div>
      <button type="button" className={styles.singleNextBtn} onClick={onNext}>
        Next →
      </button>
    </div>
  )
}

function cardNumber(snapshot: WorkoutSnapshot, cursor: Cursor) {
  let hit = 0
  let total = 0
  for (const b of snapshot.blocks) {
    const rounds = b.kind === 'single' ? 1 : b.rounds
    for (let r = 1; r <= rounds; r++) {
      for (const be of b.exercises) {
        for (const s of setsForRound(be, r)) {
          total++
          if (
            b.position === cursor.blockPosition &&
            be.position === cursor.blockExercisePosition &&
            r === cursor.roundNumber &&
            s.set_number === cursor.setNumber
          ) {
            hit = total
          }
        }
      }
    }
  }
  return { current: hit || 1, total: Math.max(1, total) }
}

function countUnloggedInNonSkippedBlocks(
  snapshot: WorkoutSnapshot,
  logged: SessionSetRow[],
  skippedBlockIds: ReadonlySet<string>,
): number {
  const doneKeys = new Set(logged.map(cursorKeyFromRow))
  let unlogged = 0
  for (const b of snapshot.blocks) {
    if (skippedBlockIds.has(b.id)) continue
    const rounds = b.kind === 'single' ? 1 : b.rounds
    for (let r = 1; r <= rounds; r++) {
      for (const be of b.exercises) {
        for (const t of setsForRound(be, r)) {
          const key = cursorKey({
            blockPosition: b.position,
            blockExercisePosition: be.position,
            roundNumber: r,
            setNumber: t.set_number,
          })
          if (!doneKeys.has(key)) unlogged++
        }
      }
    }
  }
  return Math.max(0, unlogged - 1)
}
