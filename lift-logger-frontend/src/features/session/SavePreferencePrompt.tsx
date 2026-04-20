import { useSessionStore } from '../../stores/sessionStore'
import styles from './SavePreferencePrompt.module.css'

export function SavePreferencePrompt() {
  const pending = useSessionStore((s) => s.pendingEdits)
  const pref = useSessionStore((s) => s.savePreference)
  const pick = useSessionStore((s) => s.pickSavePreference)

  if (pref !== null || pending.length === 0) return null

  return (
    <div className={styles.card}>
      <div className={styles.title}>Save change to template, or just this session?</div>
      <div className={styles.actions}>
        <button className={styles.choice} onClick={() => pick('session_only')}>
          This Session
        </button>
        <button className={`${styles.choice} ${styles.primary}`} onClick={() => pick('template')}>
          Save to Template
        </button>
      </div>
    </div>
  )
}
