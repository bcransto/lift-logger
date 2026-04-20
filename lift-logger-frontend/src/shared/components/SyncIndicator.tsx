import { useSyncStatus } from '../../sync/useSyncStatus'
import styles from './SyncIndicator.module.css'

export function SyncIndicator() {
  const { status, sync, lastSync } = useSyncStatus()
  const label =
    status === 'syncing'
      ? 'SYNCING'
      : status === 'offline'
        ? 'OFFLINE'
        : status === 'error'
          ? 'ERROR'
          : lastSync
            ? 'SYNCED'
            : 'READY'

  const dotClass =
    status === 'syncing' ? styles.amber : status === 'offline' || status === 'error' ? styles.red : styles.green

  return (
    <button type="button" className={styles.root} onClick={() => sync()} aria-label="sync">
      <span className={`${styles.dot} ${dotClass}`} />
      <span className={styles.label}>{label}</span>
    </button>
  )
}
