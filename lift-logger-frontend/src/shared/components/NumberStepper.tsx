import { useState, useEffect } from 'react'
import styles from './NumberStepper.module.css'

type Props = {
  label: string
  value: number | null
  step: number
  onChange: (v: number | null) => void
  min?: number
  unit?: string
  allowNull?: boolean
}

export function NumberStepper({ label, value, step, onChange, min, unit, allowNull }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!editing) setDraft(value === null ? '' : String(value))
  }, [value, editing])

  const display = value === null ? '—' : String(value)

  const bump = (delta: number) => {
    const base = value ?? 0
    const next = base + delta
    if (min !== undefined && next < min) return
    onChange(next)
  }

  return (
    <div className={styles.card}>
      <div className={styles.label}>
        {label}
        {unit ? <span className={styles.unit}> · {unit}</span> : null}
      </div>
      <div className={styles.row}>
        <button type="button" className={styles.step} onClick={() => bump(-step)}>
          −{step}
        </button>
        {editing ? (
          <input
            type="text"
            inputMode="decimal"
            className={styles.input}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false)
              const n = Number.parseFloat(draft)
              if (!Number.isFinite(n)) {
                if (allowNull && draft.trim() === '') onChange(null)
                return
              }
              onChange(n)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        ) : (
          <button type="button" className={styles.value} onClick={() => setEditing(true)}>
            {display}
          </button>
        )}
        <button type="button" className={styles.step} onClick={() => bump(step)}>
          +{step}
        </button>
      </div>
    </div>
  )
}
