// BlockCompleteOverlay — opens from BlockView when the user taps Record on
// the last set of a single-kind block. Shows a summary + the still-running
// block timer + four actions (Add a set, Next block, Workout overview,
// Finish workout).
//
// Which action is primary depends on whether this is the last block overall:
//   - Not last block: Next block is primary
//   - Last block:     Finish workout is primary; Next block is hidden
//
// Finish workout requires confirmation regardless — a mis-tap is expensive.

import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { Button } from '../../shared/components/Button'
import { mmss } from '../../shared/utils/format'
import { cursorKeyFromRow, firstCursorOfBlock } from './sessionEngine'
import type { SessionSetRow, WorkoutSnapshot } from '../../types/schema'
import styles from './BlockCompleteOverlay.module.css'

type Props = {
  /** Position of the block that was just completed. */
  blockPosition: number
  onClose: () => void
}

export function BlockCompleteOverlay({ blockPosition, onClose }: Props) {
  const sessionId = useSessionStore((s) => s.sessionId)
  const jumpTo = useSessionStore((s) => s.jumpTo)
  const appendSetToCurrentBlock = useSessionStore((s) => s.appendSetToCurrentBlock)
  const stopActiveTimer = useSessionStore((s) => s.stopActiveTimer)
  const endWorkout = useSessionStore((s) => s.endWorkout)
  const { openOverlay } = useUiStore()
  const navigate = useNavigate()

  const session = useLiveQuery(
    () => (sessionId ? db.sessions.get(sessionId) : undefined),
    [sessionId],
  )
  const logged = useLiveQuery<SessionSetRow[]>(
    async () => (sessionId ? await db.session_sets.where('session_id').equals(sessionId).toArray() : []),
    [sessionId],
  )
  const snapshot = useMemo<WorkoutSnapshot | null>(() => {
    if (!session?.workout_snapshot) return null
    try { return JSON.parse(session.workout_snapshot) as WorkoutSnapshot } catch { return null }
  }, [session])

  // Live-tick the timer display once per second (timer state lives in Dexie,
  // this just keeps the view in sync).
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  if (!snapshot) return null

  const block = snapshot.blocks.find((b) => b.position === blockPosition)
  if (!block) return null
  const totalBlocks = snapshot.blocks.length
  const isLastBlock = blockPosition === totalBlocks
  const nextBlockPosition = isLastBlock ? null : blockPosition + 1

  // Block summary — just-completed block's logged rows.
  const blockLogged = (logged ?? []).filter((r) => r.block_position === blockPosition)
  const setsLogged = blockLogged.length
  const totalVolume = blockLogged.reduce((sum, r) => {
    const w = r.actual_weight ?? 0
    const reps = r.actual_reps ?? 0
    return sum + (w > 0 ? w * reps : 0)
  }, 0)
  const blockElapsedSec = (() => {
    if (blockLogged.length === 0) return 0
    const first = Math.min(...blockLogged.map((r) => r.logged_at))
    const last = Math.max(...blockLogged.map((r) => r.logged_at))
    return Math.max(0, Math.round((last - first) / 1000))
  })()

  // Timer display — same fields BlockView reads for the in-card timer.
  const timerStarted = session?.work_timer_started_at ?? null
  const timerDuration = session?.work_timer_duration_sec ?? null
  const timerDisplay = (() => {
    if (timerStarted == null) return null
    const elapsed = Math.floor((now - timerStarted) / 1000)
    if (timerDuration == null) {
      return { text: mmss(Math.max(0, elapsed)), ready: false, countUp: true }
    }
    const remaining = timerDuration - elapsed
    if (remaining <= 0) return { text: 'READY', ready: true, countUp: false }
    return { text: mmss(remaining), ready: false, countUp: false }
  })()

  // Also silence unused-var lint for cursorKeyFromRow in case we later trim.
  void cursorKeyFromRow

  // ─── actions ────────────────────────────────────────────────────────
  const onAddSet = async () => {
    await appendSetToCurrentBlock()
    onClose()
  }

  const onNextBlock = () => {
    // Jump cursor directly to the first set of the next block. Works whether
    // the user completed the block normally (Record on last set) or ended it
    // early via End Block with unlogged sets remaining. BlockView's cursor→URL
    // effect routes to /intro/{nextBlockPosition}. Timer keeps ticking.
    if (nextBlockPosition == null || !snapshot) return
    const target = firstCursorOfBlock(snapshot, nextBlockPosition)
    if (target) jumpTo(target)
    onClose()
  }

  const onWorkoutOverview = () => {
    // Swap the overlay variant to 'workout' — BCO unmounts, WorkoutView mounts.
    // Intentionally do NOT call onClose() here: onClose → closeOverlay() would
    // overwrite the variant back to null before WorkoutView ever renders.
    openOverlay('workout')
  }

  const onFinishWorkout = async () => {
    const wording = isLastBlock
      ? 'Finish workout?'
      : `Finish workout? You've completed ${blockPosition} of ${totalBlocks} blocks.`
    if (!window.confirm(wording)) return
    await stopActiveTimer()
    await endWorkout()
    if (sessionId) navigate(`/session/${sessionId}/summary`, { replace: true })
  }

  // ─── render ─────────────────────────────────────────────────────────
  const blockTitle = block.exercises.map((e) => e.name).join('  +  ')

  return (
    <div className={styles.overlay}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>
          BLOCK COMPLETE · LIFT {blockPosition} OF {totalBlocks}
        </div>
        <h1 className={styles.display}>{blockTitle}</h1>
      </header>

      <div className={styles.summary}>
        <div>
          <div className={styles.statLabel}>Sets</div>
          <div className={styles.statValue}>{setsLogged}</div>
        </div>
        <div>
          <div className={styles.statLabel}>Volume</div>
          <div className={styles.statValue}>{formatVolume(totalVolume)}</div>
        </div>
        <div>
          <div className={styles.statLabel}>Elapsed</div>
          <div className={styles.statValue}>{mmss(blockElapsedSec)}</div>
        </div>
      </div>

      {timerDisplay ? (
        <div className={styles.timer}>
          <div className={styles.timerLabel}>
            {timerDisplay.countUp ? 'Time Since Last Set' : isLastBlock ? 'Session Timer' : 'Block Rest'}
          </div>
          <div className={`${styles.timerValue} ${timerDisplay.ready ? styles.timerReady : ''}`}>
            {timerDisplay.text}
          </div>
        </div>
      ) : null}

      <div className={styles.actions}>
        <Button variant="secondary" block onClick={onAddSet}>
          + Add a set
        </Button>
        {nextBlockPosition !== null ? (
          <Button variant={isLastBlock ? 'secondary' : 'primary'} block onClick={onNextBlock}>
            Next block →
          </Button>
        ) : null}
        <Button variant="secondary" block onClick={onWorkoutOverview}>
          Workout overview
        </Button>
        <Button variant={isLastBlock ? 'primary' : 'secondary'} block onClick={onFinishWorkout}>
          Finish workout
        </Button>
      </div>
    </div>
  )
}

function formatVolume(n: number): string {
  if (n <= 0) return '—'
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}
