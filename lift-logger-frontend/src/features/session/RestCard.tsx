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
}

/**
 * Between-sets rest timer inside the legacy superset/circuit stack. When
 * `isActive` flips true (user just logged the preceding set), the card starts
 * ticking down from `durationSec`. Fires the chime + vibration once as it
 * crosses zero, matching the intro RestTimerCard convention. Non-active rest
 * cards below the cursor render as static placeholders.
 */
export function RestCard({ durationSec, isActive, startedAt, onNext }: Props) {
  const activeWithStart = isActive && startedAt != null
  const [remaining, setRemaining] = useState<number>(() => {
    if (!activeWithStart) return durationSec
    return Math.max(0, durationSec - Math.floor((Date.now() - startedAt) / 1000))
  })
  const prevRef = useRef<number>(remaining)
  const firedRef = useRef<number | null>(null)

  useTick(Boolean(activeWithStart), () => {
    if (!activeWithStart) return
    const next = Math.max(0, durationSec - Math.floor((Date.now() - startedAt) / 1000))
    if (prevRef.current > 0 && next <= 0 && firedRef.current !== startedAt) {
      firedRef.current = startedAt
      playChime()
      vibrate([120, 60, 120])
      // Rest elapsed naturally — invoke the same advance handler the user
      // would have tapped, so the next set's work timer starts and the Next
      // button drops out on the resulting re-render.
      onNext?.()
    }
    prevRef.current = next
    setRemaining(next)
  }, 250)

  // Reset baseline when a new rest starts (different startedAt value).
  useEffect(() => {
    if (!activeWithStart) {
      setRemaining(durationSec)
      prevRef.current = durationSec
      return
    }
    const next = Math.max(0, durationSec - Math.floor((Date.now() - startedAt) / 1000))
    setRemaining(next)
    prevRef.current = next
  }, [activeWithStart, startedAt, durationSec])

  return (
    <div className={`${styles.card} ${isActive ? styles.active : ''} ${activeWithStart && remaining <= 0 ? styles.done : ''}`}>
      <div className={styles.label}>REST</div>
      <div className={styles.duration}>
        {activeWithStart ? mmss(remaining) : `${durationSec}s`}
      </div>
      {onNext && isActive && (!activeWithStart || remaining > 0) ? (
        <button type="button" className={styles.nextBtn} onClick={onNext}>
          Next →
        </button>
      ) : null}
    </div>
  )
}
