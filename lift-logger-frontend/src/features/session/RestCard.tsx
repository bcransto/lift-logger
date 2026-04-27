import { useEffect, useRef, useState } from 'react'
import { useTick } from '../../shared/hooks/useVisibility'
import { playChime, vibrate } from '../timer/chime'
import { mmss } from '../../shared/utils/format'
import styles from './RestCard.module.css'

type Props = {
  durationSec: number
  isActive: boolean | undefined
  /** When active, the logged_at (epoch ms) of the preceding set. Derives
      remaining via wall-clock math — no local timer state needed. */
  startedAt?: number | null
  /** When provided, renders a Next button inside the card (right-justified).
      Shown only when the rest is active; lets the user skip rest early. */
  onNext?: () => void
  /** When true, fire `onNext` automatically on zero-cross (HIIT/Tabata loop).
      When false (default), the timer keeps counting up after expiry and
      the user must tap Next manually. Chime+vibrate fire either way. */
  autoAdvance?: boolean
}

/**
 * Between-sets rest timer inside the legacy superset/circuit stack. When
 * `isActive` flips true (user just logged the preceding set), the card starts
 * ticking down from `durationSec`. Fires the chime + vibration once as it
 * crosses zero. With `autoAdvance: true` it also calls `onNext` on zero-cross
 * (the HIIT auto-loop). With `autoAdvance: false` (default) the timer
 * continues into a `+MM:SS` count-up so the user knows how long they've
 * actually rested past the planned duration. ±15s buttons let the user nudge
 * the planned duration on the fly.
 */
export function RestCard({ durationSec, isActive, startedAt, onNext, autoAdvance = false }: Props) {
  // Per-mount duration nudge from the ±15 buttons. Resets when the card
  // unmounts (i.e. when the cursor advances past this rest).
  const [extra, setExtra] = useState(0)
  const effectiveDuration = Math.max(0, durationSec + extra)

  const activeWithStart = isActive && startedAt != null
  const computeRemaining = () =>
    activeWithStart ? effectiveDuration - Math.floor((Date.now() - startedAt!) / 1000) : effectiveDuration
  const [remaining, setRemaining] = useState<number>(computeRemaining)
  const prevRef = useRef<number>(remaining)
  const firedRef = useRef<number | null>(null)

  useTick(Boolean(activeWithStart), () => {
    if (!activeWithStart) return
    const next = effectiveDuration - Math.floor((Date.now() - startedAt) / 1000)
    if (prevRef.current > 0 && next <= 0 && firedRef.current !== startedAt) {
      firedRef.current = startedAt
      playChime()
      vibrate([120, 60, 120])
      if (autoAdvance) {
        // HIIT/circuit loop: rest expires → next set's work timer takes over.
        onNext?.()
      }
    }
    prevRef.current = next
    setRemaining(next)
  }, 250)

  // Reset baseline when a new rest starts (different startedAt or duration).
  useEffect(() => {
    const next = computeRemaining()
    setRemaining(next)
    prevRef.current = next
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWithStart, startedAt, effectiveDuration])

  const expired = activeWithStart && remaining <= 0
  const displayText = activeWithStart
    ? expired
      ? `+${mmss(-remaining)}`
      : mmss(remaining)
    : `${effectiveDuration}s`

  return (
    <div className={`${styles.card} ${isActive ? styles.active : ''} ${expired ? styles.done : ''}`}>
      <div className={styles.label}>REST</div>
      <div className={styles.duration}>{displayText}</div>
      {isActive ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.stepBtn}
            onClick={() => setExtra((v) => v - 15)}
            aria-label="Subtract 15 seconds"
          >
            −15
          </button>
          <button
            type="button"
            className={styles.stepBtn}
            onClick={() => setExtra((v) => v + 15)}
            aria-label="Add 15 seconds"
          >
            +15
          </button>
          {onNext ? (
            <button type="button" className={styles.nextBtn} onClick={onNext}>
              Next →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
