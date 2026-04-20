import { useEffect } from 'react'

type WakeLockSentinel = { release: () => Promise<void> }
type NavigatorWithWakeLock = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinel> }
}

/** Acquire a screen wake lock while `active` is true. Releases on unmount. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    let sentinel: WakeLockSentinel | null = null
    let released = false

    const nav = navigator as NavigatorWithWakeLock
    const request = async () => {
      if (released) return
      try {
        if (nav.wakeLock?.request) {
          sentinel = await nav.wakeLock.request('screen')
        }
      } catch {
        sentinel = null
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void request()
      }
    }

    void request()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (sentinel) {
        sentinel.release().catch(() => undefined)
      }
    }
  }, [active])
}
