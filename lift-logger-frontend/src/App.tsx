import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { TabBar } from './shared/components/TabBar'
import { useSessionStore } from './stores/sessionStore'
import { useWakeLock } from './shared/hooks/useWakeLock'
import styles from './App.module.css'

export function App() {
  const hydrate = useSessionStore((s) => s.hydrate)
  const sessionId = useSessionStore((s) => s.sessionId)
  const location = useLocation()

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  useWakeLock(sessionId !== null)

  // Hide tab bar during session flow (intro/active/summary).
  const inSession = location.pathname.startsWith('/session/')

  return (
    <div className={styles.shell}>
      <main className={styles.main}>
        <Outlet />
      </main>
      {!inSession ? <TabBar /> : null}
    </div>
  )
}
