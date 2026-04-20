import { useEffect } from 'react'
import { useUiStore } from '../../stores/uiStore'
import type { Cursor } from '../../types/schema'
import styles from './UndoToast.module.css'

export function UndoToast({ onUndo }: { onUndo: (cursor: Cursor) => void }) {
  const undo = useUiStore((s) => s.undo)
  const clearUndo = useUiStore((s) => s.clearUndo)

  useEffect(() => {
    if (!undo) return
    const id = window.setTimeout(() => clearUndo(), Math.max(0, undo.expiresAt - Date.now()))
    return () => window.clearTimeout(id)
  }, [undo, clearUndo])

  if (!undo) return null
  return (
    <div className={styles.toast} role="status">
      <span className={styles.message}>{undo.message}</span>
      <button
        className={styles.undoBtn}
        onClick={() => {
          onUndo(undo.cursor)
          clearUndo()
        }}
      >
        Undo
      </button>
    </div>
  )
}
