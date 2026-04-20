import { useEffect, useRef, useState } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import { crossedZero, remainingSec, type TimerKind } from '../timer/TimerService'
import { playChime, vibrate } from '../timer/chime'
import { mmss } from '../../shared/utils/format'
import { useTick } from '../../shared/hooks/useVisibility'
import styles from './RestTimerCard.module.css'

type Props = {
  /** Label displayed above the countdown (e.g., "REST", "SETUP"). */
  title: string
  /** Auto-start a timer of this kind+duration when the component mounts. */
  autoStart?: { kind: Exclude<TimerKind, null>; durationSec: number } | null
  /** Hide the manual "Start" button (used when autoStart is always active). */
  hideStartButton?: boolean
  /** Default duration when user taps "Start Rest". */
  manualDurationSec?: number
}

export function RestTimerCard({ title, autoStart, hideStartButton, manualDurationSec = 90 }: Props) {
  const timer = useSessionStore((s) => s.timer)
  const startTimer = useSessionStore((s) => s.startTimer)
  const adjustTimer = useSessionStore((s) => s.adjustTimer)
  const cancelTimer = useSessionStore((s) => s.cancelTimer)

  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return
    // Only auto-start if nothing is running.
    if (timer.kind === null) {
      autoStartedRef.current = true
      startTimer(autoStart.kind, autoStart.durationSec)
    }
    // Intentionally depend on autoStart only; re-running on timer changes would re-fire.

  }, [autoStart, startTimer])

  const [remaining, setRemaining] = useState<number>(() => remainingSec(timer))
  const prevRef = useRef<number>(remaining)

  useTick(timer.kind !== null, () => {
    const next = remainingSec(timer)
    if (crossedZero(prevRef.current, next)) {
      playChime()
      vibrate([120, 60, 120])
    }
    prevRef.current = next
    setRemaining(next)
  }, 250)

  useEffect(() => {
    // Reset the "previous" baseline whenever a fresh timer starts.
    if (timer.startedAt) prevRef.current = remainingSec(timer)
  }, [timer.startedAt])

  if (timer.kind === null) {
    if (hideStartButton) return null
    return (
      <div className={styles.card}>
        <div className={styles.title}>{title}</div>
        <div className={styles.row}>
          <span className={styles.idle}>—:—</span>
          <button className={styles.primary} onClick={() => startTimer('rest', manualDurationSec)}>
            Start Rest
          </button>
        </div>
      </div>
    )
  }

  const zeroed = remaining <= 0
  return (
    <div className={`${styles.card} ${zeroed ? styles.done : ''}`}>
      <div className={styles.title}>
        {title} · {labelForKind(timer.kind)}
      </div>
      <div className={styles.row}>
        <span className={styles.time}>{mmss(Math.max(0, remaining))}</span>
        <div className={styles.actions}>
          <button className={styles.step} onClick={() => adjustTimer(-15)}>−15</button>
          <button className={styles.step} onClick={() => adjustTimer(15)}>+15</button>
          <button className={styles.ghost} onClick={cancelTimer}>
            {zeroed ? 'Dismiss' : 'Skip'}
          </button>
        </div>
      </div>
    </div>
  )
}

function labelForKind(k: TimerKind): string {
  switch (k) {
    case 'setup': return 'AUTO-STARTED'
    case 'rest': return 'REST'
    case 'block_rest': return 'BLOCK REST'
    case 'work': return 'WORK'
    default: return ''
  }
}
