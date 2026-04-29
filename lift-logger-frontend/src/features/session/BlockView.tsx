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
import { SessionHeader } from '../../shared/components/SessionHeader'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { cursorKey, cursorKeyFromRow, isLastSetOfBlock, isNewBlock, parseSetKey, setsForRound, targetAt } from './sessionEngine'
import { WorkSetCard } from './WorkSetCard'
import { RestCard } from './RestCard'
import { UndoToast } from './UndoToast'
import { SetViewOverlay } from './SetView'
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
  const startActiveTimer = useSessionStore((s) => s.startActiveTimer)
  const stopActiveTimer = useSessionStore((s) => s.stopActiveTimer)
  const adjustWorkTimer = useSessionStore((s) => s.adjustWorkTimer)
  const advanceCursor = useSessionStore((s) => s.advanceCursor)
  const skipRest = useSessionStore((s) => s.skipRest)
  const skipBlock = useSessionStore((s) => s.skipBlock)
  const finishBlock = useSessionStore((s) => s.finishBlock)
  const restSkippedAt = useSessionStore((s) => s.restSkippedAt)
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
  //
  // Keyed off cursor changes only — `session` and `snapshot` are NOT in deps
  // because this effect writes to sessions, which re-emits `session` via
  // useLiveQuery, which reinstantiates `snapshot` via useMemo. That ref churn
  // would retrigger the effect even when nothing semantic changed, eventually
  // tripping React's Maximum-update-depth guard on supersets.
  //
  // On cursor *advance* into a timed set, we restart the timer fresh (each
  // HIIT/circuit set gets its own 20s window). On the first mount with an
  // already-running timer (reload mid-set), we leave it alone so the wall-
  // clock countdown survives the reload.
  const prevCursorKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!sessionId || !cursor) return
    const nowKey = cursorKey(cursor)
    const wasKey = prevCursorKeyRef.current
    prevCursorKeyRef.current = nowKey
    const isCursorChange = wasKey !== null && wasKey !== nowKey
    let cancelled = false
    void (async () => {
      const ses = await db.sessions.get(sessionId)
      if (cancelled || !ses) return
      let snap: WorkoutSnapshot | null = null
      try { snap = JSON.parse(ses.workout_snapshot) as WorkoutSnapshot } catch { return }
      if (!snap) return
      const entry = targetAt(snap, cursor)
      if (!entry) return
      if (entry.block.kind === 'single') return // single blocks use startActiveTimer on tap
      const isTimed = entry.target.target_duration_sec != null
      const startedAt = ses.work_timer_started_at
      const durationSec = ses.work_timer_duration_sec
      const alreadyStarted = startedAt != null
      const timerElapsed =
        startedAt != null &&
        durationSec != null &&
        Date.now() - startedAt >= durationSec * 1000
      // Write directly to Dexie (bypassing `startWorkTimer` action) — this
      // effect can fire before the store's `sessionId` is hydrated, and the
      // store action no-ops when it's null. We have a trusted sessionId from
      // the route, so we can just `put`.
      if (isTimed && (isCursorChange || !alreadyStarted || timerElapsed)) {
        const now = Date.now()
        await db.sessions.put({
          ...ses,
          work_timer_started_at: now,
          work_timer_duration_sec: entry.target.target_duration_sec as number,
          updated_at: now,
        })
      } else if (!isTimed && alreadyStarted) {
        await db.sessions.put({
          ...ses,
          work_timer_started_at: null,
          work_timer_duration_sec: null,
          updated_at: Date.now(),
        })
      }
    })()
    return () => { cancelled = true }
  }, [sessionId, cursor?.blockPosition, cursor?.blockExercisePosition, cursor?.roundNumber, cursor?.setNumber])

  // Workout complete: cursor becomes null after the final logSet advance.
  useEffect(() => {
    if (sessionId && snapshot && !cursor) {
      navigate(`/session/${sessionId}/summary`, { replace: true })
    }
  }, [cursor, sessionId, snapshot, navigate])

  // Clear the captured block-complete position whenever the overlay variant
  // is no longer 'blockComplete' so it can't leak into a future BCO mount.
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

  // Block-level Skip and Finish share the same confirmation pattern:
  // "X unlogged · Y skipped" if either count > 0, plain "Skip/Finish this
  // block?" otherwise. Skip Block = "I'll come back to this" (marks block
  // skipped, advances). Finish Block = "I'm done with this block — mark it
  // complete" (adds to doneBlockIds, opens BCO).
  const buildBlockConfirm = (verb: 'Skip' | 'Finish') => {
    const unlogged = countUnloggedInBlock(block, bes, loggedByKey)
    const skippedCount = (logged ?? []).filter((r) => r.block_position === block.position && r.skipped === 1).length
    const parts: string[] = []
    if (unlogged > 0) parts.push(`${unlogged} unlogged`)
    if (skippedCount > 0) parts.push(`${skippedCount} skipped`)
    return parts.length > 0
      ? `${verb} this block? ${parts.join(' · ')}.`
      : `${verb} this block?`
  }

  const onSkipBlock = async () => {
    const msg = buildBlockConfirm('Skip')
    if (!window.confirm(msg)) return
    await skipBlock(block.id)
  }

  const onFinishBlock = async () => {
    const unlogged = countUnloggedInBlock(block, bes, loggedByKey)
    if (unlogged > 0) {
      if (!window.confirm(buildBlockConfirm('Finish'))) return
    }
    await finishBlock(block.id)
    setBlockCompletePos(block.position)
    openOverlay('blockComplete')
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

    return (
      <div className={styles.root}>
        <SessionHeader
          backLabel="Workout"
          onBack={() => session?.workout_id && navigate(`/workout/${session.workout_id}`)}
          rightSlot={
            <button
              type="button"
              className={styles.navBtn}
              onClick={() => openOverlay('set')}
              aria-label="Set view"
            >
              Set ⋮
            </button>
          }
        >
          LIFT {liftNumber.current} / {liftNumber.total} · {elapsedSinceStart}
        </SessionHeader>

        <h1 className={styles.display}>{blockTitle}</h1>

        <SessionActions
          onSkipSet={() => void onSkipSet()}
          onSkipBlock={() => void onSkipBlock()}
          onFinishBlock={() => void onFinishBlock()}
          onEndWorkout={() => void onEnd()}
        />

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
                    onAdjust={(delta) => void adjustWorkTimer(delta)}
                  />
                ) : null}
              </div>
            )
          })}
        </div>

        <UndoToast onUndo={(cur) => undoSkip(cur)} />

        {overlay === 'set' ? <SetViewOverlay onClose={closeOverlay} /> : null}
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
    | { kind: 'roundBreak'; round: number; totalRounds: number }
    | { kind: 'finishBlock'; afterKey: string; active: boolean; isTimed: boolean; isLastBlockOverall: boolean }
  const cards: Card[] = []

  const latestInBlock = (logged ?? [])
    .filter((r) => r.block_position === block.position)
    .sort((a, b) => b.logged_at - a.logged_at)[0]
  const latestKey = latestInBlock ? cursorKeyFromRow(latestInBlock) : null

  for (let r = 1; r <= rounds; r++) {
    if (r > 1 && rounds > 1) {
      cards.push({ kind: 'roundBreak', round: r, totalRounds: rounds })
    }
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
        const restAfter = restAtBoundary(isRoundBoundary, t.rest_after_sec, block.rest_after_sec)
        // New flow: SetLogger's Update handles the log + advance directly.
        // When rest_after_sec > 0, emit a single rest card that ticks down
        // and hosts the Next button inside itself (skip rest early). With no
        // rest, nothing sits between this card and the next — Update auto-
        // advances and the next set becomes focused.
        if (restAfter > 0) {
          cards.push({
            kind: 'rest',
            afterKey: key,
            durationSec: restAfter,
            isActive: latestKey === key,
          })
        }
      }
    }
  }

  const focusedRestAfterSec = restForCursor(snapshot, cursor)

  // Focused-card Done: opens the SetLogger overlay pre-filled with target
  // values. If the user's target-default is fine they tap Update immediately;
  // otherwise they adjust weight/reps and tap Update. SetLogger's handler
  // (onSetLoggerUpdateLegacy) does the actual logSet + advance, gated by
  // whether a rest timer is configured for this set.
  const onDoneFocused = () => {
    openOverlay('setLogger')
  }

  const onSetLoggerUpdateLegacy = async (actuals: SetLoggerActuals) => {
    await logSet({
      actualWeight: actuals.actualWeight,
      actualReps: actuals.actualReps,
      actualDurationSec: actuals.actualDurationSec,
      advance: focusedRestAfterSec === 0,
    })
    closeOverlay()
  }

  const onSetLoggerCancelLegacy = () => {
    closeOverlay()
  }

  // Inline Next button on an active rest card — advance cursor + mark rest as
  // skipped. Marking is what hides the Next button; it also suppresses the
  // rest derivation elsewhere so the timer slot can switch to the new set's
  // work timer (restarted by the work-timer lifecycle effect on this cursor
  // change).
  const onInlineNextLegacy = () => {
    skipRest()
    advanceCursor()
  }

  // Close handler for the BCO mounted in the legacy render path (mirrors
  // single's onBlockCompleteClose).
  const onLegacyBlockCompleteClose = () => {
    setBlockCompletePos(null)
    closeOverlay()
  }

  return (
    <div className={styles.root}>
      <SessionHeader
        backLabel="Workout"
        onBack={() => session?.workout_id && navigate(`/workout/${session.workout_id}`)}
        rightSlot={
          <button
            type="button"
            className={styles.navBtn}
            onClick={() => openOverlay('set')}
            aria-label="Set view"
          >
            Set ⋮
          </button>
        }
      >
        LIFT {liftNumber.current} / {liftNumber.total} · {elapsedSinceStart}
      </SessionHeader>

      <h1 className={styles.display}>{blockTitle}</h1>
      {blockKindTag ? <div className={styles.blockTag}>{blockKindTag}</div> : null}

      <SessionActions
        onSkipSet={() => void onSkipSet()}
        onSkipBlock={() => void onSkipBlock()}
        onFinishBlock={() => void onFinishBlock()}
        onEndWorkout={() => void onEnd()}
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
                onDone={isFocused ? onDoneFocused : undefined}
                workTimerStartedAt={isFocused ? session.work_timer_started_at ?? null : null}
                workTimerDurationSec={isFocused ? session.work_timer_duration_sec ?? null : null}
                // Auto-log on zero stays on the current cursor so the rest
                // timer can play out before the next set's work timer starts
                // — otherwise both countdowns run simultaneously.
                onTimerZero={isFocused ? () => { void logSet({ advance: focusedRestAfterSec === 0 }) } : undefined}
              />
            )
          }
          if (c.kind === 'roundBreak') {
            return (
              <div key={`rb${i}`} className={styles.roundBreak}>
                <span className={styles.roundBreakRule} />
                <span className={styles.roundBreakLabel}>
                  R{c.round} / {c.totalRounds}
                </span>
                <span className={styles.roundBreakRule} />
              </div>
            )
          }
          if (c.kind === 'rest') {
            const precedingLog = loggedByKey.get(c.afterKey)
            // A rest is "live" only while the user hasn't explicitly skipped
            // past it. After tapping Next, restSkippedAt > logged_at → hide
            // the button + drop the highlighted state so focus can shift to
            // the new set's work timer.
            const precedingLogAt = precedingLog?.logged_at ?? null
            const skipped =
              restSkippedAt != null && precedingLogAt != null && restSkippedAt > precedingLogAt
            const live = c.isActive && !skipped
            return (
              <RestCard
                key={`r${i}`}
                durationSec={c.durationSec}
                isActive={live}
                startedAt={precedingLogAt}
                onNext={live ? onInlineNextLegacy : undefined}
                // Circuits keep the HIIT auto-loop (rest expires → next set's
                // work timer takes over). Supersets are user-paced lifting,
                // so the timer counts up past expiry until the user taps Next.
                autoAdvance={block.kind === 'circuit'}
              />
            )
          }
          // c.kind === 'finishBlock'
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
        })}
      </div>

      <UndoToast onUndo={(cur) => undoSkip(cur)} />

      {overlay === 'set' ? <SetViewOverlay onClose={closeOverlay} /> : null}
      {overlay === 'setLogger' ? (
        <SetLogger
          primaryLabel="Update"
          onRecord={onSetLoggerUpdateLegacy}
          onCancel={onSetLoggerCancelLegacy}
        />
      ) : null}
      {overlay === 'blockComplete' && blockCompletePos !== null ? (
        <BlockCompleteOverlay
          blockPosition={blockCompletePos}
          onClose={onLegacyBlockCompleteClose}
        />
      ) : null}
    </div>
  )
}

// ─── RestWithNext ──────────────────────────────────────────────────
// Rendered below a just-logged card in the single-block layout. Shows a
// live-updating timer (countdown that flips to `+MM:SS` count-up after
// expiry, or pure count-up when no duration is set), ±15s buttons that
// nudge the planned duration on the fly, and a Next button that advances
// focus + stops the timer.

function RestWithNext({
  startedAt,
  durationSec,
  onNext,
  onAdjust,
}: {
  startedAt: number | null
  durationSec: number | null
  onNext: () => void
  onAdjust: (deltaSec: number) => void
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
    if (remaining <= 0) {
      return { text: `+${mmss(-remaining)}`, ready: true, label: 'Rest' }
    }
    return { text: mmss(remaining), ready: false, label: 'Rest' }
  })()

  // ±15 only meaningful for countdown timers — pure count-up has no duration
  // to nudge, so hide the buttons there.
  const showSteps = durationSec != null

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
      <div className={styles.singleTimerActions}>
        {showSteps ? (
          <>
            <button type="button" className={styles.singleStepBtn} onClick={() => onAdjust(-15)} aria-label="Subtract 15 seconds">−15</button>
            <button type="button" className={styles.singleStepBtn} onClick={() => onAdjust(15)} aria-label="Add 15 seconds">+15</button>
          </>
        ) : null}
        <button type="button" className={styles.singleNextBtn} onClick={onNext}>
          Next →
        </button>
      </div>
    </div>
  )
}

// ─── SessionActions ────────────────────────────────────────────────
// The bottom action row on BlockView (both single + legacy paths). Four
// fixed buttons in fixed order: Skip Set · Skip Block · Finish Block · End
// Workout.

function SessionActions({
  onSkipSet,
  onSkipBlock,
  onFinishBlock,
  onEndWorkout,
}: {
  onSkipSet: () => void
  onSkipBlock: () => void
  onFinishBlock: () => void
  onEndWorkout: () => void
}) {
  return (
    <div className={styles.secondaryActions}>
      <button className={styles.actionBtn} onClick={onSkipSet}>Skip Set</button>
      <button className={styles.actionBtn} onClick={onSkipBlock}>Skip Block</button>
      <button className={styles.actionBtn} onClick={onFinishBlock}>Finish Block</button>
      <button className={styles.actionBtn} onClick={onEndWorkout}>End Workout</button>
    </div>
  )
}

function countUnloggedInBlock(
  block: { kind: string; position: number; rounds: number },
  bes: SnapshotBlockExercise[],
  loggedByKey: Map<string, SessionSetRow>,
): number {
  const rounds = block.kind === 'single' ? 1 : block.rounds
  let n = 0
  for (let r = 1; r <= rounds; r++) {
    for (const be of bes) {
      for (const t of setsForRound(be, r)) {
        const k = cursorKey({
          blockPosition: block.position,
          blockExercisePosition: be.position,
          roundNumber: r,
          setNumber: t.set_number,
        })
        if (!loggedByKey.has(k)) n++
      }
    }
  }
  return n
}

// At a round boundary, set-level rest of 0 means "no per-set rest configured"
// — fall back to block-level (between-rounds) rest. `??` would treat explicit
// 0 as configured and skip the fallback, so use `> 0` instead.
function restAtBoundary(
  isRoundBoundary: boolean,
  setRest: number | null | undefined,
  blockRest: number | null | undefined,
): number {
  if (isRoundBoundary) {
    if (setRest != null && setRest > 0) return setRest
    return blockRest ?? 0
  }
  return setRest ?? 0
}

function restForCursor(snapshot: WorkoutSnapshot, cursor: Cursor): number {
  const entry = targetAt(snapshot, cursor)
  if (!entry) return 0
  const { block: b, target: t, cursor: c } = entry
  if (b.kind === 'single') return t.rest_after_sec ?? 0
  const bes = b.exercises.slice().sort((a, x) => a.position - x.position)
  const lastBeIdx = bes.length - 1
  const beAt = bes.findIndex((e) => e.position === c.blockExercisePosition)
  const setsInRound = setsForRound(bes[beAt]!, c.roundNumber)
  const lastSetInBe = setsInRound[setsInRound.length - 1]?.set_number === c.setNumber
  const isRoundBoundary = lastSetInBe && beAt === lastBeIdx && c.roundNumber < b.rounds
  return restAtBoundary(isRoundBoundary, t.rest_after_sec, b.rest_after_sec)
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
