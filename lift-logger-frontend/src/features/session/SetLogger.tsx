// SetLogger — opens on tap of the focused set card in a single-block BlockView.
// Dedicated to logging the *currently active* set. Editing past sets still
// happens in SetView (via the top-right "Set" button in BlockView), which has
// its up/down nav arrows.
//
// Behavior:
//   - Cancel → stops the active timer (which the BlockView tap started),
//     closes the overlay, nothing logged.
//   - Record → calls logSet() with entered weight/reps/duration, closes the
//     overlay. Cursor advance + timer lifecycle are owned by BlockView / the
//     logSet path.
//
// Inputs: stepper +/− buttons, a tap-to-edit numeric field (fires iOS numeric
// keyboard via inputMode), and — on the weight card only — a sign toggle (±)
// for weight-assist machines where target weight is a negative bodyweight
// offset.

import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import { Button } from '../../shared/components/Button'
import { targetAt } from './sessionEngine'
import type { WorkoutSnapshot } from '../../types/schema'
import styles from './SetLogger.module.css'

export type SetLoggerActuals = {
  actualWeight: number | null
  actualReps: number | null
  actualDurationSec: number | null
}

type Props = {
  /** Called when the user taps Record. Parent owns logSet + post-log routing. */
  onRecord: (actuals: SetLoggerActuals) => void | Promise<void>
  /** Called when the user taps Cancel. Parent owns timer-stop + overlay close. */
  onCancel: () => void | Promise<void>
}

export function SetLogger({ onRecord, onCancel }: Props) {
  const sessionId = useSessionStore((s) => s.sessionId)
  const cursor = useSessionStore((s) => s.cursor)

  const session = useLiveQuery(
    () => (sessionId ? db.sessions.get(sessionId) : undefined),
    [sessionId],
  )
  const snapshot = useMemo<WorkoutSnapshot | null>(() => {
    if (!session?.workout_snapshot) return null
    try { return JSON.parse(session.workout_snapshot) as WorkoutSnapshot } catch { return null }
  }, [session])

  const entry = snapshot && cursor ? targetAt(snapshot, cursor) : null

  const [weight, setWeight] = useState<number | null>(null)
  const [reps, setReps] = useState<number | null>(null)
  const [duration, setDuration] = useState<number | null>(null)

  // Seed form state from the target once.
  useEffect(() => {
    if (!entry) return
    setWeight(entry.target.target_weight ?? null)
    setReps(entry.target.target_reps ?? null)
    setDuration(entry.target.target_duration_sec ?? null)
    // Seed once per entry (cursor change ⇒ new entry ⇒ reseed).
  }, [entry?.target])

  if (!entry || !cursor) return null

  const isTimed = entry.target.target_duration_sec != null
  const block = entry.block
  const roundPill = block.kind !== 'single' ? `R${cursor.roundNumber}/${block.rounds}` : null

  const handleCancel = () => {
    void onCancel()
  }

  const handleRecord = () => {
    void onRecord({
      actualWeight: weight,
      actualReps: reps,
      actualDurationSec: duration,
    })
  }

  return (
    <div className={styles.overlay}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>LOG SET</div>
        <h1 className={styles.display}>{entry.blockExercise.name}</h1>
        <div className={styles.setLabel}>
          SET {cursor.setNumber}
          {roundPill ? ` · ${roundPill}` : ''}
          {entry.target.is_peak ? ' ★' : ''}
        </div>
      </header>

      {isTimed ? (
        <div className={styles.stack}>
          <NumberCard
            label="Duration"
            unit="sec"
            value={duration}
            step={5}
            inputMode="numeric"
            min={0}
            onChange={setDuration}
          />
        </div>
      ) : (
        <div className={styles.stack}>
          <NumberCard
            label="Weight"
            unit="lb"
            value={weight}
            step={5}
            inputMode="decimal"
            withSignToggle
            onChange={setWeight}
          />
          <NumberCard
            label={entry.target.target_reps_each ? 'Reps (each side)' : 'Reps'}
            value={reps}
            step={1}
            inputMode="numeric"
            min={0}
            onChange={setReps}
          />
        </div>
      )}

      <div className={styles.footer}>
        <Button variant="secondary" block onClick={handleCancel}>
          Cancel
        </Button>
        <Button variant="primary" block onClick={handleRecord}>
          Done
        </Button>
      </div>
    </div>
  )
}

// ─── NumberCard ──────────────────────────────────────────────────────
// Self-contained because SetLogger's weight variant needs a sign toggle
// (±) that NumberStepper doesn't support. Same tap-to-edit + stepper
// pattern otherwise.

function NumberCard({
  label,
  unit,
  value,
  step,
  inputMode,
  min,
  withSignToggle,
  onChange,
}: {
  label: string
  unit?: string
  value: number | null
  step: number
  inputMode: 'decimal' | 'numeric'
  min?: number
  withSignToggle?: boolean
  onChange: (v: number | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    if (!editing) setDraft(value === null ? '' : String(value))
  }, [value, editing])

  const display = value === null ? '—' : String(value)
  const isNegative = value !== null && value < 0

  const bump = (delta: number) => {
    const base = value ?? 0
    const next = base + delta
    if (min !== undefined && next < min) return
    onChange(next)
  }

  const toggleSign = () => {
    if (value === null) return
    onChange(-value)
  }

  return (
    <div className={styles.card}>
      <div className={styles.label}>
        {label}
        {unit ? <span className={styles.unit}> · {unit}</span> : null}
      </div>
      <div className={`${styles.row} ${withSignToggle ? '' : styles.rowNoSign}`}>
        {withSignToggle ? (
          <button
            type="button"
            className={`${styles.sign} ${isNegative ? styles.signActive : ''}`}
            onClick={toggleSign}
            aria-label={isNegative ? 'Make positive' : 'Make negative'}
            aria-pressed={isNegative}
          >
            ±
          </button>
        ) : null}
        <button type="button" className={styles.step} onClick={() => bump(-step)}>
          −{step}
        </button>
        {editing ? (
          <input
            type="text"
            inputMode={inputMode}
            className={styles.input}
            value={draft}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false)
              const trimmed = draft.trim()
              if (trimmed === '') {
                onChange(null)
                return
              }
              const n = Number.parseFloat(trimmed)
              if (!Number.isFinite(n)) return
              if (min !== undefined && n < min) return
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
