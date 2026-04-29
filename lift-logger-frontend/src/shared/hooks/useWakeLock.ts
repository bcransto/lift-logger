import { useEffect } from 'react'

type WakeLockSentinel = {
  release: () => Promise<void>
  released?: boolean
  addEventListener?: (event: 'release', cb: () => void) => void
}
type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> }
}

/**
 * Acquire a screen wake lock while `active` is true and re-acquire whenever
 * the browser silently releases it (visibility change, OS audio interruption,
 * iOS PWA quirks). Releases on unmount.
 *
 * The wake lock is auto-released by the browser when document.visibilityState
 * goes hidden — we listen for both the explicit 'release' event on the sentinel
 * and the 'visibilitychange' event on the document, then re-request when we
 * return to visible. A 30s polling re-request is a belt-and-suspenders catch
 * for silent drops we don't get an event for.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    let sentinel: WakeLockSentinel | null = null
    let released = false
    let intervalId: number | null = null

    const nav = navigator as NavigatorWithWakeLock

    const request = async () => {
      if (released || sentinel) return
      try {
        if (nav.wakeLock?.request) {
          const s = await nav.wakeLock.request('screen')
          sentinel = s
          // Some browsers (incl. iOS Safari PWA) release the lock without
          // firing a visibility change — listen for the sentinel's own
          // release event so we can re-request on the next opportunity.
          s.addEventListener?.('release', () => {
            sentinel = null
          })
        }
      } catch {
        sentinel = null
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Browser releases the lock when hidden; clear our reference and
        // re-request now that we're back.
        sentinel = null
        void request()
      }
    }

    void request()
    document.addEventListener('visibilitychange', onVisibility)
    // Belt-and-suspenders: periodic re-request in case the lock was dropped
    // silently. No-op when sentinel is already held.
    intervalId = window.setInterval(() => void request(), 30_000)

    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (intervalId !== null) window.clearInterval(intervalId)
      if (sentinel) {
        sentinel.release().catch(() => undefined)
      }
    }
  }, [active])
}
