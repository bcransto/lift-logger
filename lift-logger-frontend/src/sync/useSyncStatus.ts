import { useEffect, useState } from 'react'
import { syncService, type SyncStatus } from './syncService'

export type UseSyncStatus = {
  status: SyncStatus
  lastSync: number | null
  error: string | undefined
  sync: () => Promise<void>
}

export function useSyncStatus(): UseSyncStatus {
  const [state, setState] = useState(() => syncService.getStatus())
  useEffect(() => {
    const unsubscribe = syncService.subscribe(setState)
    return unsubscribe
  }, [])
  return {
    ...state,
    sync: () => syncService.sync(),
  }
}

/** Wire reconnect-triggered sync + initial sync on mount. */
export function useAutoSync() {
  useEffect(() => {
    void syncService.sync()
    const online = () => {
      void syncService.sync()
    }
    // iOS PWA resume from the app switcher doesn't remount or fire 'online' —
    // visibilitychange is the only signal we get.
    const visible = () => {
      if (document.visibilityState === 'visible') {
        void syncService.sync()
      }
    }
    window.addEventListener('online', online)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('online', online)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
}
