// Primary Active-Lift view. Vertical stack of cards representing the current
// block's execution in round-major order. Superset/circuit blocks interleave
// their exercises (exA-R1, exB-R1, exA-R2, exB-R2, ...).
//
// Between consecutive work cards we render either:
//   - a rest card (when the preceding set's rest_after_sec > 0), or
//   - an inline "Next" button (when rest = 0/null) — only the slot right after
//     the focused card is active; the rest are dim (visual rhythm only).
//
// There is no bottom Next button. Advancement is inline.
//
// Header: LEFT = Workout view button, RIGHT = Set view button (active set).
// Secondary row: Skip Set, End.
// Only the focused set card is a tap-hotlink to Set view; all others are
// non-interactive to prevent accidental mis-hits.

import { useEffect, useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { cursorKey, isLastSetOfBlock, parseSetKey } from './sessionEngine'
import { TimerDock } from './TimerDock'
import { WorkSetCard } from './WorkSetCard'
import { RestCard } from './RestCard'
import { UndoToast } from './UndoToast'
import { SetViewOverlay } from './SetView'
import { WorkoutViewOverlay } from './WorkoutView'
import type {
  Cursor,
  SessionSetRow,
  SnapshotBlock,
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
  const undoSkip = useSessionStore((s) => s.undoSkip)
  const { overlay, openOverlay, closeOverlay, showUndo } = useUiStore()

  // Sync cursor FROM URL on URL change.
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

  // Sync cursor TO URL after logSet advances.
  useEffect(() => {
    if (!sessionId || !cursor) return
    const expected = `/session/${sessionId}/active/${cursor.blockPosition}/${cursor.blockExercisePosition}.${cursor.roundNumber}.${cursor.setNumber}`
    if (window.location.pathname !== expected) navigate(expected, { replace: true })
  }, [cursor, sessionId, navigate])

  // Work-timer lifecycle: start when cursor lands on a timed-work card, clear on others.
  useEffect(() => {
    if (!cursor || !snapshot || !session) return
    const entry = findEntry(snapshot, cursor)
    if (!entry) return
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
  // Navigate to Summary once. Lives at top-level to obey React's hook rules.
  useEffect(() => {
    if (sessionId && snapshot && !cursor) {
      navigate(`/session/${sessionId}/summary`, { replace: true })
    }
  }, [cursor, sessionId, snapshot, navigate])

  if (!sessionId) return <div className={styles.empty}>No session.</div>
  if (!session || !snapshot) return <div className={styles.empty}>Loading…</div>
  if (!cursor) return null // the useEffect above navigates us away

  const bp = Number.parseInt(bpStr ?? '1', 10)
  const block = snapshot.blocks.find((b) => b.position === bp)
  if (!block) return <div className={styles.empty}>Block not found.</div>

  const cursorK = cursorKey(cursor)
  const rounds = block.kind === 'single' ? 1 : block.rounds
  const loggedByKey = new Map(
    (logged ?? []).map((r) => [
      `${r.block_position}.${r.block_exercise_position}.${r.round_number}.${r.set_number}`,
      r,
    ]),
  )

  // Assemble round-major cards across ALL block_exercises in this block.
  // Between consecutive work cards: rest card or inline Next button.
  type Card =
    | { kind: 'work'; cursor: Cursor; target: SnapshotSetTarget; be: SnapshotBlockExercise; row: SessionSetRow | undefined }
    | { kind: 'rest'; afterKey: string; durationSec: number; isActive: boolean }
    | { kind: 'next'; afterKey: string; active: boolean }
    | { kind: 'finishBlock'; afterKey: string; active: boolean; isTimed: boolean; isLastBlockOverall: boolean }
  const cards: Card[] = []
  const bes = block.exercises.slice().sort((a, b) => a.position - b.position)

  // Most recent log in this block → drives rest card "active" indicator.
  const latestInBlock = (logged ?? [])
    .filter((r) => r.block_position === block.position)
    .sort((a, b) => b.logged_at - a.logged_at)[0]
  const latestKey = latestInBlock
    ? `${latestInBlock.block_position}.${latestInBlock.block_exercise_position}.${latestInBlock.round_number}.${latestInBlock.set_number}`
    : null

  for (let r = 1; r <= rounds; r++) {
    for (let beIdx = 0; beIdx < bes.length; beIdx++) {
      const be = bes[beIdx]!
      for (let sIdx = 0; sIdx < be.sets.length; sIdx++) {
        const t = be.sets[sIdx]!
        const cur: Cursor = {
          blockPosition: block.position,
          blockExercisePosition: be.position,
          roundNumber: r,
          setNumber: t.set_number,
        }
        const key = cursorKey(cur)
        cards.push({ kind: 'work', cursor: cur, target: t, be, row: loggedByKey.get(key) })

        // Is there a card after this one in the execution order?
        const isLastSetInBe = sIdx === be.sets.length - 1
        const isLastBeInRound = beIdx === bes.length - 1
        const isLastRound = r === rounds
        const isLastOverall = isLastSetInBe && isLastBeInRound && isLastRound
        if (isLastOverall) {
          // Terminal "Finish Block" card — caps the stack and gives the user
          // an explicit advance for rep-based final sets. For timed finals
          // the work timer handles advancement; we still render the card
          // (disabled) as a visual end-of-block affordance.
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

        // Inter-card slot: rest card or inline Next button.
        // Rest duration: at a round boundary (last-set-of-last-BE-but-more-rounds-coming),
        // use block.rest_after_sec. Within-round transitions use set.rest_after_sec.
        const isRoundBoundary = isLastSetInBe && isLastBeInRound && !isLastRound
        const restAfter =
          (isRoundBoundary ? block.rest_after_sec : t.rest_after_sec) ?? 0
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
            active: cursorK === key, // only the slot after the focused set is live
          })
        }
      }
    }
  }

  // TimerDock inputs: rest_after_sec for the rest-timer derivation.
  // Rule: if the latest-logged set is the FINAL set of the block (last round,
  // last BE, last set-number), pull `block.rest_after_sec` — that's the
  // between-rounds rest for circuits/supersets, or the post-block rest for
  // single. Otherwise use the set's own rest_after_sec.
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
    return be?.sets.find((s) => s.set_number === latestInBlock.set_number)?.rest_after_sec ?? null
  })()

  const focusedEntry = findEntry(snapshot, cursor)
  const focusedIsTimed = focusedEntry?.target.target_duration_sec != null
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

  const onInlineNext = async () => {
    // Advance from the focused set. logSet handles upsert + cursor advance.
    await logSet()
  }

  const blockTitle = bes.map((e) => e.name).join('  +  ')
  const blockKindTag =
    block.kind === 'superset' ? `SUPERSET × ${block.rounds}` : block.kind === 'circuit' ? `CIRCUIT × ${block.rounds}` : null

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
        <button className={styles.actionBtn} onClick={onEnd}>End</button>
      </div>

      <TimerDock
        lastLoggedAt={latestInBlock?.logged_at ?? null}
        lastLoggedRestAfterSec={lastRestAfter}
        workTimerStartedAt={session.work_timer_started_at ?? null}
        workTimerDurationSec={session.work_timer_duration_sec ?? null}
        onRestZero={() => {
          // Rest expired — cursor is already on the next work set. Just advance visuals.
        }}
        onWorkZero={() => {
          void logSet()
        }}
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
                round={block.kind !== 'single' ? c.cursor.roundNumber : null}
                totalRounds={block.kind !== 'single' ? rounds : null}
                // Only focused card is a tap hotlink to Set view.
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
                  onClick={c.active && !c.isTimed ? onInlineNext : undefined}
                  disabled={!c.active || c.isTimed}
                  aria-label={label}
                >
                  {label}
                  {c.active && c.isTimed ? <span className={styles.finishHint}> · auto on timer zero</span> : null}
                </button>
              </div>
            )
          }
          // inline Next button
          return (
            <div key={`n${i}`} className={styles.inlineNextWrap}>
              <button
                className={`${styles.inlineNext} ${c.active ? styles.inlineNextActive : ''}`}
                onClick={c.active ? onInlineNext : undefined}
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

function findEntry(snapshot: WorkoutSnapshot, cursor: Cursor) {
  const b = snapshot.blocks.find((x) => x.position === cursor.blockPosition)
  const be = b?.exercises.find((e) => e.position === cursor.blockExercisePosition)
  const target = be?.sets.find((s) => s.set_number === cursor.setNumber)
  if (!b || !be || !target) return null
  return { block: b, blockExercise: be, target }
}

function cardNumber(snapshot: WorkoutSnapshot, cursor: Cursor) {
  // "Lift" = which work card (1-indexed) the user is on, across the whole workout.
  let idx = 0
  let hit = 0
  let total = 0
  for (const b of snapshot.blocks) {
    const rounds = b.kind === 'single' ? 1 : b.rounds
    for (let r = 1; r <= rounds; r++) {
      for (const be of b.exercises) {
        for (const s of be.sets) {
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
  idx = hit || 1
  return { current: idx, total: Math.max(1, total) }
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
          if (!doneKeys.has(key)) unlogged++
        }
      }
    }
  }
  // exclude the currently-focused set from the "remaining" count
  return Math.max(0, unlogged - 1)
}

// Silence unused — SnapshotBlock type is referenced via SnapshotBlockExercise import.
export type { SnapshotBlock as _KeepBlockTypeImported }
