import { useState } from 'react'
import type { SnapshotSetTarget } from '../../types/schema'
import styles from './SetCard.module.css'

type Props = {
  target: SnapshotSetTarget
  state: 'pending' | 'current' | 'done' | 'peak'
  actual?: { weight: number | null; reps: number | null; duration: number | null } | null
  onEdit?: (patch: Partial<SnapshotSetTarget>) => void
}

export function SetCard({ target, state, actual, onEdit }: Props) {
  const [expanded, setExpanded] = useState(false)

  const weightDisplay = target.target_weight ?? (target.target_pct_1rm ? `${Math.round(target.target_pct_1rm * 100)}%` : 'BW')
  const repsDisplay = target.target_reps ?? (target.target_duration_sec ? `${target.target_duration_sec}s` : '—')

  return (
    <div
      className={`${styles.card} ${styles[state]} ${target.is_peak && state !== 'current' ? styles.peak : ''}`}
      onClick={() => onEdit && setExpanded((v) => !v)}
      role={onEdit ? 'button' : undefined}
    >
      <div className={styles.label}>
        SET {target.set_number}
        {target.is_peak ? ' ★' : ''}
        {state === 'current' ? ' · NOW' : ''}
        {state === 'done' ? ' ✓' : ''}
      </div>
      <div className={styles.weight}>{weightDisplay}{target.target_weight != null ? <span className={styles.unit}> LB</span> : null}</div>
      <div className={styles.reps}>× {repsDisplay}{target.target_reps_each ? ' ea' : ''}</div>
      {state === 'done' && actual ? (
        <div className={styles.actual}>
          Actual: {actual.weight ?? '—'} × {actual.reps ?? actual.duration ?? '—'}
        </div>
      ) : null}
      {expanded && onEdit ? (
        <ExpandEditor target={target} onClose={() => setExpanded(false)} onEdit={onEdit} />
      ) : null}
    </div>
  )
}

function ExpandEditor({
  target,
  onEdit,
  onClose,
}: {
  target: SnapshotSetTarget
  onEdit: (patch: Partial<SnapshotSetTarget>) => void
  onClose: () => void
}) {
  const [w, setW] = useState(target.target_weight ?? 0)
  const [r, setR] = useState(target.target_reps ?? 0)
  const [peak, setPeak] = useState(Boolean(target.is_peak))

  return (
    <div className={styles.editor} onClick={(e) => e.stopPropagation()}>
      <div className={styles.editorRow}>
        <label className={styles.editorLabel}>Weight</label>
        <input
          type="text"
          inputMode="decimal"
          className={styles.editorInput}
          value={w}
          onChange={(e) => setW(Number.parseFloat(e.target.value) || 0)}
        />
      </div>
      <div className={styles.editorRow}>
        <label className={styles.editorLabel}>Reps</label>
        <input
          type="text"
          inputMode="numeric"
          className={styles.editorInput}
          value={r}
          onChange={(e) => setR(Number.parseInt(e.target.value, 10) || 0)}
        />
      </div>
      <div className={styles.editorRow}>
        <label className={styles.editorLabel}>Peak set</label>
        <input type="checkbox" checked={peak} onChange={(e) => setPeak(e.target.checked)} />
      </div>
      <div className={styles.editorActions}>
        <button className={styles.ghost} onClick={onClose}>Cancel</button>
        <button
          className={styles.save}
          onClick={() => {
            onEdit({ target_weight: w, target_reps: r, is_peak: peak })
            onClose()
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}
