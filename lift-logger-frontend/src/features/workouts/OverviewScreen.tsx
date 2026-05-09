import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import { buildWorkoutSnapshot } from '../../db/queries'
import { useSessionStore } from '../../stores/sessionStore'
import { Button } from '../../shared/components/Button'
import { SessionHeader } from '../../shared/components/SessionHeader'
import { SetPatternRenderer } from './SetPatternRenderer'
import { confirmEndWorkout } from '../session/BlockView'
import {
  cursorKey,
  cursorKeyFromRow,
  firstCursorOfBlock,
  setsForRound,
} from '../session/sessionEngine'
import { parseJsonArray, relativeDate } from '../../shared/utils/format'
import type { Cursor, SessionSetRow, SnapshotBlock, WorkoutSnapshot } from '../../types/schema'
import styles from './OverviewScreen.module.css'

// 5-state model (per design convo), plus 'current' as a transient cursor
// indicator. Disposition × Content:
//   done   × complete | partial    — block was Finished (auto on full log, or via Finish tap)
//   skipped × empty   | partial    — block was Skipped (will return)
//   untouched (== pending)         — never started, no disposition
type BlockStatus =
  | 'pending'
  | 'current'
  | 'done_complete'
  | 'done_partial'
  | 'skipped_empty'
  | 'skipped_partial'

export function OverviewScreen() {
  const { workoutId } = useParams<{ workoutId: string }>()
  const navigate = useNavigate()
  const startSession = useSessionStore((s) => s.startSession)
  const skipBlock = useSessionStore((s) => s.skipBlock)
  const returnToBlock = useSessionStore((s) => s.returnToBlock)
  const jumpTo = useSessionStore((s) => s.jumpTo)
  const cursor = useSessionStore((s) => s.cursor)
  const skippedBlockIds = useSessionStore((s) => s.skippedBlockIds)
  const doneBlockIds = useSessionStore((s) => s.doneBlockIds)
  const endWorkout = useSessionStore((s) => s.endWorkout)

  const workout = useLiveQuery(() => (workoutId ? db.workouts.get(workoutId) : undefined), [workoutId])

  // Active session for THIS workout, if any. Drives the "living" status
  // indicators + Resume CTA. When no active session matches, the screen
  // renders pre-session: uniform tiles + Start CTA.
  const activeSession = useLiveQuery(async () => {
    if (!workoutId) return null
    const all = await db.sessions.where('workout_id').equals(workoutId).toArray()
    // Most-recently-started wins. Dexie returns rows in primary-key order
    // (lexicographic on the id string) by default — that's not the same as
    // chronological, so two leftover active sessions from a crash could pick
    // the older empty one. The hydrate path already enforces single-active
    // semantics in normal use; this is defensive.
    return all
      .filter((s) => s.ended_at == null)
      .sort((a, b) => b.started_at - a.started_at)[0] ?? null
  }, [workoutId])

  // When active, drive the snapshot off the session's frozen workout_snapshot
  // so the tiles match what the session is executing (templates may have
  // drifted since session started). When pre-session, build from the
  // template tables.
  const snapshot = useLiveQuery<WorkoutSnapshot | null | undefined>(
    async () => {
      if (activeSession?.workout_snapshot) {
        try { return JSON.parse(activeSession.workout_snapshot) as WorkoutSnapshot } catch { /* fall through */ }
      }
      return workoutId ? await buildWorkoutSnapshot(workoutId) : undefined
    },
    [workoutId, activeSession?.workout_snapshot],
  )

  const logged = useLiveQuery<SessionSetRow[]>(
    async () => (activeSession ? await db.session_sets.where('session_id').equals(activeSession.id).toArray() : []),
    [activeSession?.id],
  )

  const exerciseMap = useLiveQuery(async () => {
    if (!snapshot) return new Map<string, { equipment: string[]; is_unilateral: boolean }>()
    const ids = new Set<string>()
    for (const b of snapshot.blocks) for (const be of b.exercises) ids.add(be.exercise_id)
    const rows = await db.exercises.where('id').anyOf([...ids]).toArray()
    return new Map(
      rows.map((r) => [
        r.id,
        {
          equipment: parseJsonArray(r.equipment) as string[],
          is_unilateral: r.is_unilateral === 1,
        },
      ]),
    )
  }, [snapshot])

  const totalLifts = useMemo(
    () => (snapshot ? snapshot.blocks.reduce((n, b) => n + b.exercises.length, 0) : 0),
    [snapshot],
  )


  // Set of cursor keys that have an *actual* log row (skipped:0). Skipped
  // rows are excluded from the "done" count because they don't represent
  // completed work — they're a different disposition.
  const loggedActualKeys = useMemo(
    () => new Set((logged ?? []).filter((r) => r.skipped !== 1).map(cursorKeyFromRow)),
    [logged],
  )

  if (!workout || !snapshot) {
    return <div className={styles.empty}>Loading…</div>
  }

  const blockStatusOf = (block: SnapshotBlock): { status: BlockStatus; done: number; total: number } => {
    const rounds = block.kind === 'single' ? 1 : block.rounds
    let total = 0
    let done = 0
    for (let r = 1; r <= rounds; r++) {
      for (const be of block.exercises) {
        for (const t of setsForRound(be, r)) {
          total++
          const k = cursorKey({
            blockPosition: block.position,
            blockExercisePosition: be.position,
            roundNumber: r,
            setNumber: t.set_number,
          })
          if (loggedActualKeys.has(k)) done++
        }
      }
    }
    if (!activeSession) return { status: 'pending', done, total }
    // Cursor wins as "current" only if the block has no explicit disposition
    // yet — once Skipped or Done is set, we want the user-meaningful status.
    const hasLogs = done > 0
    if (skippedBlockIds.has(block.id)) {
      return { status: hasLogs ? 'skipped_partial' : 'skipped_empty', done, total }
    }
    if (doneBlockIds.has(block.id)) {
      return { status: done >= total && total > 0 ? 'done_complete' : 'done_partial', done, total }
    }
    // Auto-Done: all sets logged → Complete (logSet flips this in the store
    // too, but renders correctly even if hydration hasn't caught up).
    if (done >= total && total > 0) return { status: 'done_complete', done, total }
    if (cursor && cursor.blockPosition === block.position) return { status: 'current', done, total }
    return { status: 'pending', done, total }
  }

  const onStart = async () => {
    const id = await startSession(workout.id)
    if (id) navigate(`/session/${id}/intro/1`, { replace: true })
  }

  const onResume = () => {
    if (!activeSession || !cursor) return
    navigateToCursor(activeSession.id, cursor)
  }

  // When the cursor has run off the end (all non-skipped blocks done) but
  // skipped blocks still exist, the user is parked on Overview. Their two
  // exits are: tap a skipped tile to revisit, or tap the bottom CTA to end
  // the workout. The CTA below flips into "End Workout" for this state.
  const onEndFromOverview = async () => {
    if (!activeSession || !snapshot) return
    if (!confirmEndWorkout(snapshot, logged ?? [], skippedBlockIds)) return
    await endWorkout()
    navigate(`/session/${activeSession.id}/summary`, { replace: true })
  }

  // Tile tap dispatch — depends on status.
  //   active   → /active (no ceremony, you were there)
  //   skipped  → returnToBlock + /intro (re-entering)
  //   partial  → returnToBlock (un-skip if needed, lands on first unlogged) + /active
  //   pending  → skipBlock(current) + jumpTo(target) + /intro (fresh ceremony)
  //   done     → no-op for now (read-only summary is future)
  const navigateToCursor = (sessionId: string, c: Cursor) => {
    const setKey = `${c.blockExercisePosition}.${c.roundNumber}.${c.setNumber}`
    navigate(`/session/${sessionId}/active/${c.blockPosition}/${setKey}`)
  }
  const onTileTap = async (block: SnapshotBlock, status: BlockStatus) => {
    if (!activeSession) return
    const sid = activeSession.id
    const currentBlockId = cursor
      ? snapshot.blocks.find((b) => b.position === cursor.blockPosition)?.id ?? null
      : null
    if (status === 'current' && cursor) {
      navigateToCursor(sid, cursor)
      return
    }
    if (status === 'skipped_empty' || status === 'skipped_partial') {
      // Re-entering an explicitly-skipped block: un-skip + run intro ceremony.
      await returnToBlock(block.id)
      navigate(`/session/${sid}/intro/${block.position}`)
      return
    }
    if (status === 'pending') {
      // Jump-ahead: current block becomes Skipped (returnable), cursor moves
      // to the target block's first set, route through the intro ceremony.
      // Confirm first if leaving a different block — a stray tap shouldn't
      // silently flag the current block skipped, especially mid-progress.
      if (currentBlockId && currentBlockId !== block.id) {
        const currentBlock = snapshot.blocks.find((b) => b.id === currentBlockId)
        const currentName = currentBlock?.exercises.map((e) => e.name).join(' + ') ?? 'this block'
        const { done, total } = blockStatusOf(currentBlock!)
        const msg = done > 0
          ? `Skip "${currentName}"? Your current progress (${done} of ${total} sets) will stay; the block is marked skipped so you can return.`
          : `Skip "${currentName}"?`
        if (!window.confirm(msg)) return
        await skipBlock(currentBlockId)
      }
      const target = firstCursorOfBlock(snapshot, block.position)
      if (target) jumpTo(target)
      navigate(`/session/${sid}/intro/${block.position}`)
      return
    }
    // done_complete / done_partial → no-op for now (future: read-only summary).
  }

  return (
    <div className={styles.root}>
      <SessionHeader
        backLabel="Home"
        onBack={() => navigate('/')}
      >
        OVERVIEW · {totalLifts} {totalLifts === 1 ? 'LIFT' : 'LIFTS'}
      </SessionHeader>
      <h1 className={styles.display}>{workout.name}</h1>
      {workout.description ? <p className={styles.desc}>{workout.description}</p> : null}

      <div className={styles.pills}>
        {workout.est_duration ? <span className={styles.pill}>≈ {workout.est_duration} MIN</span> : null}
        {workout.last_performed ? (
          <span className={styles.pill}>LAST: {relativeDate(workout.last_performed).toUpperCase()}</span>
        ) : null}
        {workout.starred ? <span className={styles.pill}>★</span> : null}
      </div>

      <ol className={styles.blocks}>
        {snapshot.blocks.map((b, bi) => {
          const { status, done, total } = blockStatusOf(b)
          return (
            <BlockRow
              key={b.id}
              block={b}
              startNumber={computeStartNumber(snapshot.blocks, bi)}
              exerciseMeta={exerciseMap}
              status={activeSession ? status : null}
              progress={activeSession ? { done, total } : null}
              onTap={activeSession ? () => void onTileTap(b, status) : null}
            />
          )
        })}
      </ol>

      <div className={styles.startRow}>
        {!activeSession ? (
          <Button variant="primary" block onClick={onStart}>
            Start Workout →
          </Button>
        ) : cursor ? (
          <Button variant="primary" block onClick={onResume}>
            Resume Workout →
          </Button>
        ) : (
          <Button variant="primary" block onClick={() => void onEndFromOverview()}>
            End Workout
          </Button>
        )}
      </div>
    </div>
  )
}

function computeStartNumber(blocks: SnapshotBlock[], index: number): number {
  let n = 0
  for (let i = 0; i < index; i++) n += blocks[i]!.exercises.length
  return n + 1
}

function BlockRow({
  block,
  startNumber,
  exerciseMeta,
  status,
  progress,
  onTap,
}: {
  block: SnapshotBlock
  startNumber: number
  exerciseMeta: Map<string, { equipment: string[]; is_unilateral: boolean }> | undefined
  status: BlockStatus | null
  progress: { done: number; total: number } | null
  onTap: (() => void) | null
}) {
  const grouped = block.kind === 'superset' || block.kind === 'circuit'
  const label = block.kind === 'superset' ? 'SUPERSET' : block.kind === 'circuit' ? 'CIRCUIT' : null
  const statusClass = status ? styles[`status_${status}`] : ''

  const content = (
    <>
      {grouped || status ? (
        <div className={styles.headerRow}>
          {grouped ? <span className={styles.groupLabel}>┃ {label} × {block.rounds}</span> : <span />}
          {status ? (
            <span className={`${styles.statusPill} ${styles[`pill_${status}`]}`}>
              {statusLabel(status)}
              {progress && progress.total > 0 ? ` ${progress.done}/${progress.total}` : ''}
            </span>
          ) : null}
        </div>
      ) : null}
      <ul className={styles.exList}>
        {block.exercises.map((be, bei) => {
          const num = pad2(startNumber + bei)
          const subLabel = grouped ? String.fromCharCode(0x61 + bei) : ''
          const meta = exerciseMeta?.get(be.exercise_id)
          return (
            <li key={be.id} className={styles.exRow}>
              <div className={styles.num}>{num}{subLabel}</div>
              <div className={styles.exBody}>
                <div className={styles.exName}>
                  {be.name}
                  {meta?.equipment?.length ? (
                    <span className={styles.equipTags}>
                      {meta.equipment.map((e) => (
                        <span key={e} className={styles.equipTag}>{e.toUpperCase()}</span>
                      ))}
                    </span>
                  ) : null}
                </div>
                <SetPatternRenderer blockExercise={be} isUnilateral={meta?.is_unilateral} />
              </div>
            </li>
          )
        })}
      </ul>
    </>
  )

  return (
    <li className={`${styles.block} ${grouped ? styles.grouped : ''} ${statusClass}`}>
      {onTap ? (
        <button type="button" className={styles.blockTap} onClick={onTap}>
          {content}
        </button>
      ) : (
        <div className={styles.blockTap}>{content}</div>
      )}
    </li>
  )
}

function statusLabel(status: BlockStatus): string {
  switch (status) {
    case 'pending': return 'PENDING'
    case 'current': return 'CURRENT'
    case 'done_complete': return 'DONE'
    case 'done_partial': return 'DONE'
    case 'skipped_empty': return 'SKIPPED'
    case 'skipped_partial': return 'SKIPPED'
  }
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}
