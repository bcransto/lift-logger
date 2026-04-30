import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { TabBar } from './shared/components/TabBar'
import { useSessionStore } from './stores/sessionStore'
import { useWakeLock } from './shared/hooks/useWakeLock'
import styles from './App.module.css'

type ScreenWithLock = Screen & {
  orientation?: ScreenOrientation & { lock?: (kind: 'portrait') => Promise<void> }
}

export function App() {
  const hydrate = useSessionStore((s) => s.hydrate)
  const sessionId = useSessionStore((s) => s.sessionId)
  const location = useLocation()

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Best-effort screen orientation lock. Works on Android PWAs in standalone
  // mode; iOS Safari rejects (no support yet) — the CSS rotateOverlay below
  // handles iOS as a fallback. Promise rejection is silent.
  useEffect(() => {
    const s = screen as ScreenWithLock
    s.orientation?.lock?.('portrait').catch(() => undefined)
  }, [])

  useWakeLock(sessionId !== null)

  // Hide tab bar during session flow (intro/active/summary).
  const inSession = location.pathname.startsWith('/session/')

  return (
    <div className={styles.shell}>
      <main className={styles.main}>
        <Outlet />
      </main>
      {!inSession ? <TabBar /> : null}
      <div className="rotateOverlay" aria-hidden>
        Please rotate to portrait
      </div>
    </div>
  )
}
