// Top-docked timer. Renders only when an active rest or work timer is supplied.
// The parent (BlockView) computes the inputs — which rest_after_sec applies,
// whether a work timer is running — and passes them in. This keeps the
// component dumb and easy to test.

import { useEffect, useRef } from 'react'
import { useSessionStore } from '../../stores/sessionStore'
import { deriveActiveTimer, type DerivedTimer } from '../timer/TimerService'
import { playChime, vibrate } from '../timer/chime'
import { mmss } from '../../shared/utils/format'
import { useTick } from '../../shared/hooks/useVisibility'
import styles from './TimerDock.module.css'

type Props = {
  lastLoggedAt: number | null
  lastLoggedRestAfterSec: number | null
  workTimerStartedAt: number | null
  workTimerDurationSec: number | null
  onRestZero?: () => void
  onWorkZero?: () => void
}

export function TimerDock({
  lastLoggedAt,
  lastLoggedRestAfterSec,
  workTimerStartedAt,
  workTimerDurationSec,
  onRestZero,
  onWorkZero,
}: Props) {
  const pausedAt = useSessionStore((s) => s.pausedAt)
  const pause = useSessionStore((s) => s.pause)
  const resume = useSessionStore((s) => s.resume)
  const adjustWorkTimer = useSessionStore((s) => s.adjustWorkTimer)

  // Re-render on tick to keep the countdown fresh.
  const [, force] = useStateTick()
  useTick(true, force, 250)

  const active: DerivedTimer | null = deriveActiveTimer(
    {
      lastLoggedAt,
      lastLoggedRestAfterSec,
      workTimerStartedAt,
      workTimerDurationSec,
      pausedAt,
    },
    Date.now(),
  )

  // Fire-once zero-crossing callbacks.
  const prevRef = useRef<number>(Infinity)
  const firedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!active) {
      prevRef.current = Infinity
      return
    }
    const key = `${active.kind}:${active.startedAt}`
    if (prevRef.current > 0 && active.remainingSec <= 0 && firedForRef.current !== key) {
      firedForRef.current = key
      playChime()
      vibrate([120, 60, 120])
      if (active.kind === 'rest') onRestZero?.()
      else if (active.kind === 'work') onWorkZero?.()
    }
    prevRef.current = active.remainingSec
  })

  if (!active) return null
  return (
    <div className={`${styles.dock} ${active.frozen ? styles.paused : ''}`}>
      <div className={styles.kind}>
        {active.kind === 'rest' ? 'REST' : 'WORK'}
        {active.frozen ? ' · PAUSED' : ''}
      </div>
      <div className={styles.row}>
        <span className={styles.time}>{mmss(active.remainingSec)}</span>
        <div className={styles.actions}>
          {active.kind === 'work' ? (
            <>
              <button className={styles.step} onClick={() => adjustWorkTimer(-15)}>−15</button>
              <button className={styles.step} onClick={() => adjustWorkTimer(15)}>+15</button>
            </>
          ) : null}
          <button className={styles.step} onClick={() => (pausedAt ? resume() : pause())}>
            {pausedAt ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Minimal "tick to trigger re-render" hook; keeps component state local.
import { useState as useStateImport } from 'react'
function useStateTick(): [number, () => void] {
  const [n, setN] = useStateImport(0)
  return [n, () => setN((v) => v + 1)]
}
