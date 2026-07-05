import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import { buildWorkoutSnapshot } from '../../db/queries'
import {
  useSessionStore,
  cursorFromLogged,
  parseSkippedBlocks,
  parseDoneBlocks,
} from '../../stores/sessionStore'
import { Button } from '../../shared/components/Button'
import { SessionHeader } from '../../shared/components/SessionHeader'
import { SetPatternRenderer } from './SetPatternRenderer'
import {
  cursorKey,
  cursorKeyFromRow,
  firstCursorOfBlock,
  fixedBlockIdsForReorder,
  nextReorderableIndex,
  setsForRound,
} from '../session/sessionEngine'
import { parseJsonArray, relativeDate } from '../../shared/utils/format'
import { AddBlockOverlay } from '../session/AddBlockOverlay'
import { ExercisePicker } from '../session/ExercisePicker'
import type { NewBlockSpec } from '../session/blockSpec'
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
  const endWorkout = useSessionStore((s) => s.endWorkout)
  const hydrate = useSessionStore((s) => s.hydrate)
  const swapExerciseInBlock = useSessionStore((s) => s.swapExerciseInBlock)
  const appendBlockToCurrentSession = useSessionStore((s) => s.appendBlockToCurrentSession)
  const moveBlock = useSessionStore((s) => s.moveBlock)
  // NOTE: store.cursor / store.skippedBlockIds / store.doneBlockIds are
  // intentionally NOT read here. The store is hydrated for the
  // most-recently-started active session across ALL workouts, so on a
  // workout this user isn't currently executing those values would belong
  // to a different session. We derive per-displayed-session state below
  // from `activeSession` + `logged`. The store is only resynced (via
  // `hydrate(activeSession.id)`) when the user actually chooses to resume
  // this session — after that, BlockView/SetView etc. read store state
  // that's consistent with the route they're now on.

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

  // Per-displayed-session state — derived locally rather than read from the
  // store. The store's hydrated session may be a different workout entirely
  // (e.g., user has Six-Station Circuit AND Arm Day Superset both active and
  // hydrate auto-picked the most-recent), so reading store.cursor on this
  // screen would mean "Resume" and tile statuses use the wrong session's
  // coordinates. Deriving locally keeps each workout's overview internally
  // consistent regardless of which session the store happens to be pointing
  // at right now.
  const sessionSkippedBlockIds = useMemo(
    () => parseSkippedBlocks(activeSession?.skipped_block_ids ?? null),
    [activeSession?.skipped_block_ids],
  )
  const sessionDoneBlockIds = useMemo(
    () => parseDoneBlocks(activeSession?.done_block_ids ?? null),
    [activeSession?.done_block_ids],
  )
  const sessionCursor = useMemo<Cursor | null>(() => {
    if (!snapshot || !activeSession) return null
    return cursorFromLogged(snapshot, logged ?? [], sessionSkippedBlockIds)
  }, [snapshot, activeSession, logged, sessionSkippedBlockIds])
  // Aliases that match the prior names so the rest of this file reads the
  // same. Could be inlined later; kept for diff legibility.
  const cursor = sessionCursor
  const skippedBlockIds = sessionSkippedBlockIds
  const doneBlockIds = sessionDoneBlockIds

  // Tap-to-reveal action button per tile (mirrors BlockView's #5a pattern).
  // MUST stay above the early-return below — moving it below would cause a
  // React #310 hooks-order error when `workout`/`snapshot` resolve.
  const [tapFocusBlockId, setTapFocusBlockId] = useState<string | null>(null)
  // Block currently being swapped (ExercisePicker overlay target). Null = closed.
  const [swapTargetBlockId, setSwapTargetBlockId] = useState<string | null>(null)
  // AddBlockOverlay open (+ Add Block CTA, issue #4).
  const [addBlockOpen, setAddBlockOpen] = useState(false)
  // Reorder mode (issue #21): when on, tiles show ▲/▼ for pending blocks and
  // the tap-to-reveal action row is suppressed. Only meaningful with an
  // active session (the toggle is hidden otherwise).
  const [reorderMode, setReorderMode] = useState(false)

  // Block ids that are FIXED for reorder (complement of "pending"). Shared
  // single source of truth with the store action via fixedBlockIdsForReorder.
  // A block is pending iff it's strictly ahead of the cursor, has no
  // session_sets rows, and isn't skipped/done. MUST stay above the early
  // return (hooks-order trap).
  const blockIdsWithRows = useMemo(() => {
    if (!snapshot) return new Set<string>()
    const positions = new Set((logged ?? []).map((r) => r.block_position))
    return new Set(snapshot.blocks.filter((b) => positions.has(b.position)).map((b) => b.id))
  }, [snapshot, logged])
  const fixedBlockIds = useMemo(() => {
    if (!snapshot || !activeSession) return new Set<string>()
    return fixedBlockIdsForReorder(
      snapshot,
      sessionCursor,
      blockIdsWithRows,
      sessionSkippedBlockIds,
      sessionDoneBlockIds,
    )
  }, [snapshot, activeSession, sessionCursor, blockIdsWithRows, sessionSkippedBlockIds, sessionDoneBlockIds])

  // Soft-delete redirect: if this workout was deleted (locally or via sync),
  // bounce the user to Home rather than showing an empty Overview.
  useEffect(() => {
    if (workout?.deleted_at != null) {
      navigate('/', { replace: true })
    }
  }, [workout?.deleted_at, navigate])

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

  // Resync the store for the displayed session before any action that
  // either reads/mutates store state (cursor, doneBlockIds, etc.) or
  // navigates into a session route. Without this, BlockView/SetView would
  // mount with the store still pointing at whatever session hydrate
  // auto-picked, and they'd render the wrong cursor / mutate the wrong
  // session's state. No-op when the store is already on this session.
  const ensureStoreOnSession = async (sessionId: string) => {
    if (useSessionStore.getState().sessionId === sessionId) return
    await hydrate(sessionId)
  }

  const onResume = async () => {
    if (!activeSession || !cursor) return
    await ensureStoreOnSession(activeSession.id)
    navigateToCursor(activeSession.id, cursor)
  }

  // When the cursor has run off the end (all non-skipped blocks done) but
  // skipped blocks still exist, the user is parked on Overview. Their two
  // exits are: tap a skipped tile to revisit, or tap the bottom CTA to end
  // the workout. The CTA below flips into "End Workout" for this state.
  const onEndFromOverview = async () => {
    if (!activeSession) return
    // No confirm dialog (issue #30) — the Summary screen's "Return to
    // workout" button is the undo for an accidental End tap.
    // Pass the explicit session id — the store's hydrated sessionId may be
    // null (user came directly to /workout/:id without going through a
    // session route, or already ended a session this run leaving an orphan
    // from a prior crash to surface as "active"). alsoEndOrphans cleans up
    // any other un-ended sessions for this workout in the same write so
    // they can't silently resurface as fake "unfinished" tiles next open.
    await endWorkout(null, {
      sessionId: activeSession.id,
      alsoEndOrphansForWorkoutId: workoutId ?? undefined,
    })
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
  // Tap → toggle tap-focus on/off. The contextual action button
  // (Edit / Cont. / Start) appears within the tap-focused tile. Tapping the
  // button fires the action below; tapping a different tile moves focus.
  // (`tapFocusBlockId` state itself lives above the early-return guard.)
  const onTileToggleFocus = (blockId: string) => {
    setTapFocusBlockId((prev) => (prev === blockId ? null : blockId))
  }

  const onTileSwap = async (blockId: string) => {
    if (!activeSession) return
    // The swap action reads sessionId/snapshot from the store; make sure
    // it's hydrated to the session we're displaying before we open the
    // picker, otherwise the swap could land on a different session's
    // snapshot.
    await ensureStoreOnSession(activeSession.id)
    setSwapTargetBlockId(blockId)
    setTapFocusBlockId(null)
  }

  const onSwapPick = async (newExerciseId: string) => {
    if (!swapTargetBlockId) return
    await swapExerciseInBlock(swapTargetBlockId, newExerciseId)
    setSwapTargetBlockId(null)
  }

  const onAddBlock = async (spec: NewBlockSpec) => {
    if (!activeSession) return
    await ensureStoreOnSession(activeSession.id)
    const target = await appendBlockToCurrentSession(spec)
    setAddBlockOpen(false)
    if (target) {
      navigate(`/session/${activeSession.id}/intro/${target.blockPosition}`)
    }
  }

  const onDeleteWorkout = async () => {
    if (!workout) return
    if (!window.confirm(`Delete "${workout.name}"? This can't be undone from the app.`)) return
    const now = Date.now()
    await db.workouts.put({ ...workout, deleted_at: now, updated_at: now })
    navigate('/', { replace: true })
  }

  // Label per status — drives the visible button. Done blocks have no
  // pre-existing tile action (it's the new Edit affordance).
  const actionLabelFor = (status: BlockStatus): 'Edit' | 'Cont.' | 'Start' | null => {
    switch (status) {
      case 'done_complete':
      case 'done_partial':
        return 'Edit'
      case 'current':
      case 'skipped_partial':
        return 'Cont.'
      case 'skipped_empty':
      case 'pending':
        return 'Start'
      default:
        return null
    }
  }

  const onTileAction = async (block: SnapshotBlock, status: BlockStatus) => {
    if (!activeSession) return
    const sid = activeSession.id
    setTapFocusBlockId(null)  // collapse tap-focus once an action fires
    // Every branch below either calls a store action (which mutates the
    // store's currently-loaded session) or navigates into a session route
    // (which makes BlockView/SetView read store state). Re-hydrate first
    // so the store matches the session this screen is displaying.
    await ensureStoreOnSession(sid)
    const currentBlockId = cursor
      ? snapshot.blocks.find((b) => b.position === cursor.blockPosition)?.id ?? null
      : null
    if (status === 'current' && cursor) {
      // Cont. on current — go straight to the active cursor.
      navigateToCursor(sid, cursor)
      return
    }
    if (status === 'skipped_partial') {
      // Cont. on skipped & partial — un-skip and continue at first unlogged
      // set. Skip the intro ceremony per design (this is a continuation, not
      // a re-entry).
      await returnToBlock(block.id)
      const c = useSessionStore.getState().cursor
      if (c) navigateToCursor(sid, c)
      else navigate(`/session/${sid}/intro/${block.position}`)
      return
    }
    if (status === 'skipped_empty') {
      // Start on skipped & empty — un-skip and run the intro ceremony.
      await returnToBlock(block.id)
      navigate(`/session/${sid}/intro/${block.position}`)
      return
    }
    if (status === 'pending') {
      // Start on pending — jump-ahead. Current block becomes Skipped (with
      // confirm), cursor moves to target's first set, intro ceremony.
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
    if (status === 'done_complete' || status === 'done_partial') {
      // Edit on done — jump cursor to this block's first set and route to
      // BlockView. The user then taps individual cards (per #5a) to edit
      // specific sets via SetView. The cursor temporarily pointing into a
      // Done block is fine — blockStatusOf precedence keeps the tile
      // showing as Done (not Current) since it's still in doneBlockIds.
      const target = firstCursorOfBlock(snapshot, block.position)
      if (!target) return
      jumpTo(target)
      navigateToCursor(sid, target)
      return
    }
  }

  // Reorder a pending block up/down one slot. Session-only; the store action
  // re-derives the authoritative fixed set from DB and no-ops if the move
  // isn't legal. ensureStoreOnSession keeps the store's snapshot in step so
  // BlockView/SetView reflect the new order if the user resumes.
  const onMove = async (blockId: string, direction: 'up' | 'down') => {
    if (!activeSession) return
    await ensureStoreOnSession(activeSession.id)
    await moveBlock(activeSession.id, blockId, direction)
  }

  const onToggleReorder = () => {
    setTapFocusBlockId(null) // reorder mode and tap-to-reveal are mutually exclusive
    setReorderMode((prev) => !prev)
  }

  return (
    <div className={styles.root}>
      <SessionHeader
        backLabel="Home"
        onBack={() => navigate('/')}
        suppressResumeAnchor
      >
        OVERVIEW · {totalLifts} {totalLifts === 1 ? 'LIFT' : 'LIFTS'}
      </SessionHeader>
      <h1 className={styles.display}>{workout.name}</h1>
      {workout.description ? <p className={styles.desc}>{workout.description}</p> : null}

      <div className={styles.pills}>
        {workout.est_duration ? <span className={styles.pill}>≈ {workout.est_duration} MIN</span> : null}
        <span className={styles.pill}>CREATED: {relativeDate(workout.created_at).toUpperCase()}</span>
        {workout.last_performed ? (
          <span className={styles.pill}>LAST: {relativeDate(workout.last_performed).toUpperCase()}</span>
        ) : null}
        {workout.starred ? <span className={styles.pill}>★</span> : null}
      </div>

      <ol className={styles.blocks}>
        {snapshot.blocks.map((b, bi) => {
          const { status, done, total } = blockStatusOf(b)
          const actionLabel = activeSession ? actionLabelFor(status) : null
          // Swap eligibility — single block + no session_sets rows. Status
          // 'done_*' implies at least one row; 'skipped_partial' / 'current'
          // with done > 0 also; gate on done === 0 to cover them all.
          const swapEligible = Boolean(activeSession) && b.kind === 'single' && done === 0
          // Reorder affordances (only meaningful in reorder mode). A block is
          // reorderable iff it's not in the fixed set; arrows enable only when
          // there's a reorderable neighbour in that direction (no leaping
          // fixed anchors, no running off the list edge).
          const reorderable = reorderMode && !fixedBlockIds.has(b.id)
          const canMoveUp = reorderable && nextReorderableIndex(snapshot, bi, 'up', fixedBlockIds) != null
          const canMoveDown = reorderable && nextReorderableIndex(snapshot, bi, 'down', fixedBlockIds) != null
          return (
            <BlockRow
              key={b.id}
              block={b}
              startNumber={computeStartNumber(snapshot.blocks, bi)}
              exerciseMeta={exerciseMap}
              status={activeSession ? status : null}
              progress={activeSession ? { done, total } : null}
              // Tap-to-reveal is suppressed in reorder mode.
              onTap={activeSession && !reorderMode ? () => onTileToggleFocus(b.id) : null}
              tapFocused={!reorderMode && tapFocusBlockId === b.id}
              actionLabel={reorderMode ? null : actionLabel}
              onAction={!reorderMode && activeSession && actionLabel ? () => void onTileAction(b, status) : null}
              onSwap={!reorderMode && swapEligible ? () => void onTileSwap(b.id) : null}
              reorderMode={reorderMode}
              reorderable={reorderable}
              canMoveUp={canMoveUp}
              canMoveDown={canMoveDown}
              onMoveUp={canMoveUp ? () => void onMove(b.id, 'up') : null}
              onMoveDown={canMoveDown ? () => void onMove(b.id, 'down') : null}
            />
          )
        })}
      </ol>

      {/* Session tools live at the bottom with the CTA stack (issue #26). */}
      {activeSession ? (
        <div className={styles.sessionToolsRow}>
          <button
            type="button"
            className={styles.addExerciseBtn}
            onClick={() => setAddBlockOpen(true)}
          >
            + Add Block
          </button>
          <button
            type="button"
            className={`${styles.reorderToggle} ${reorderMode ? styles.reorderToggleActive : ''}`}
            onClick={onToggleReorder}
            aria-pressed={reorderMode}
          >
            {reorderMode ? 'Done' : 'Reorder'}
          </button>
        </div>
      ) : null}

      <div className={styles.startRow}>
        {!activeSession ? (
          <Button variant="primary" block onClick={onStart}>
            Start Workout →
          </Button>
        ) : cursor ? (
          <>
            {/* Cursor non-null: Resume is the primary action; End Workout is
               a secondary affordance. End goes straight to Summary (issue
               #30) — Summary's "Return to workout" is the undo. */}
            <Button variant="primary" block onClick={onResume}>
              Resume Workout →
            </Button>
            <Button variant="secondary" block onClick={() => void onEndFromOverview()}>
              End Workout
            </Button>
          </>
        ) : (
          <Button variant="primary" block onClick={() => void onEndFromOverview()}>
            End Workout
          </Button>
        )}
      </div>

      {!activeSession ? (
        <button
          type="button"
          className={styles.deleteLink}
          onClick={() => void onDeleteWorkout()}
        >
          Delete workout
        </button>
      ) : null}

      {swapTargetBlockId ? (() => {
        const target = snapshot.blocks.find((b) => b.id === swapTargetBlockId)
        const be = target?.exercises[0]
        if (!target || !be) return null
        return (
          <ExercisePicker
            currentExerciseId={be.exercise_id}
            currentExerciseName={be.name}
            onPick={onSwapPick}
            onCancel={() => setSwapTargetBlockId(null)}
          />
        )
      })() : null}

      {addBlockOpen && activeSession ? (
        <AddBlockOverlay
          currentSessionId={activeSession.id}
          onAdd={onAddBlock}
          onCancel={() => setAddBlockOpen(false)}
        />
      ) : null}
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
  tapFocused,
  actionLabel,
  onAction,
  onSwap,
  reorderMode,
  reorderable,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: {
  block: SnapshotBlock
  startNumber: number
  exerciseMeta: Map<string, { equipment: string[]; is_unilateral: boolean }> | undefined
  status: BlockStatus | null
  progress: { done: number; total: number } | null
  onTap: (() => void) | null
  /** True when this tile is tap-focused (button row visible). Mutually
      exclusive across tiles in the parent's render. */
  tapFocused?: boolean
  /** Contextual button label — Edit / Cont. / Start. Hidden when null. */
  actionLabel?: 'Edit' | 'Cont.' | 'Start' | null
  /** Fired on action-button tap. Null when the tile has no action available
      (pre-session or unmapped status). */
  onAction?: (() => void) | null
  /** Swap-exercise affordance — only set when the block is single-kind and
      has no session_sets rows. Renders as a secondary button below the
      primary action. */
  onSwap?: (() => void) | null
  /** Reorder mode (issue #21) — when true, the tile shows ▲/▼ for pending
      blocks and a locked/dimmed treatment for fixed anchors. */
  reorderMode?: boolean
  /** True when this block may move (it's pending). Fixed anchors are false. */
  reorderable?: boolean
  canMoveUp?: boolean
  canMoveDown?: boolean
  onMoveUp?: (() => void) | null
  onMoveDown?: (() => void) | null
}) {
  const grouped = block.kind === 'superset' || block.kind === 'circuit'
  const label = block.kind === 'superset' ? 'SUPERSET' : block.kind === 'circuit' ? 'CIRCUIT' : null
  const statusClass = status ? styles[`status_${status}`] : ''
  // In reorder mode a fixed anchor is visually locked; a pending block is
  // highlighted as movable.
  const reorderClass = reorderMode
    ? reorderable
      ? styles.reorderMovable
      : styles.reorderLocked
    : ''

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

  // Reorder mode: tile body is inert (tap-to-reveal suppressed) and sits
  // beside a ▲/▼ arrow column. Pending blocks get live arrows (disabled when
  // no reorderable neighbour in that direction); fixed anchors get a lock
  // glyph instead.
  if (reorderMode) {
    return (
      <li className={`${styles.block} ${grouped ? styles.grouped : ''} ${statusClass} ${reorderClass}`}>
        <div className={styles.reorderRow}>
          <div className={styles.reorderBody}>{content}</div>
          {reorderable ? (
            <div className={styles.reorderArrows}>
              <button
                type="button"
                className={styles.reorderArrow}
                onClick={onMoveUp ?? undefined}
                disabled={!canMoveUp}
                aria-label="Move block up"
              >
                ▲
              </button>
              <button
                type="button"
                className={styles.reorderArrow}
                onClick={onMoveDown ?? undefined}
                disabled={!canMoveDown}
                aria-label="Move block down"
              >
                ▼
              </button>
            </div>
          ) : (
            <div className={styles.reorderLock} aria-hidden="true">🔒</div>
          )}
        </div>
      </li>
    )
  }

  return (
    <li className={`${styles.block} ${grouped ? styles.grouped : ''} ${statusClass}`}>
      {onTap ? (
        <button type="button" className={styles.blockTap} onClick={onTap}>
          {content}
        </button>
      ) : (
        <div className={styles.blockTap}>{content}</div>
      )}
      {tapFocused && ((actionLabel && onAction) || onSwap) ? (
        <div className={styles.tileActionRow}>
          {actionLabel && onAction ? (
            <button type="button" className={styles.tileAction} onClick={onAction}>
              {actionLabel}
            </button>
          ) : null}
          {onSwap ? (
            <button type="button" className={styles.tileSwap} onClick={onSwap}>
              Swap Exercise
            </button>
          ) : null}
        </div>
      ) : null}
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
