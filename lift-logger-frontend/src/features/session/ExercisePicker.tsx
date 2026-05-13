// ExercisePicker — full-screen overlay opened from BlockView's "Swap
// Exercise" button. User picks any exercise from the library to replace
// the current single-block exercise. Tap a card → onPick fires with the
// chosen id. Cancel dismisses without changes.

import { useMemo, useState } from 'react'
import { useAllExercises } from '../../db/queries'
import { Button } from '../../shared/components/Button'
import { parseJsonArray } from '../../shared/utils/format'
import styles from './ExercisePicker.module.css'

type Props = {
  /** Exercise currently in the block — hidden from the list so the user
      isn't offered the no-op. */
  currentExerciseId: string
  /** Name shown in the header as context. */
  currentExerciseName: string
  onPick: (exerciseId: string) => void | Promise<void>
  onCancel: () => void
}

export function ExercisePicker({ currentExerciseId, currentExerciseName, onPick, onCancel }: Props) {
  const exercises = useAllExercises()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const rows = exercises ?? []
    const q = query.trim().toLowerCase()
    return rows.filter((ex) => {
      if (ex.id === currentExerciseId) return false
      if (!q) return true
      return ex.name.toLowerCase().includes(q)
    })
  }, [exercises, query, currentExerciseId])

  return (
    <div className={styles.overlay}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>SWAP EXERCISE</div>
        <h1 className={styles.display}>Pick a replacement</h1>
        <div className={styles.currentLine}>CURRENT · {currentExerciseName}</div>
      </header>

      <input
        className={styles.search}
        type="search"
        placeholder="Search exercises…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />

      {filtered.length === 0 ? (
        <div className={styles.empty}>
          {exercises === undefined ? 'Loading…' : 'No matches.'}
        </div>
      ) : (
        <ul className={styles.list}>
          {filtered.map((ex) => {
            const muscles = parseJsonArray<string>(ex.muscle_groups)
            const equipment = parseJsonArray<string>(ex.equipment)
            const badges = [...muscles, ...equipment].slice(0, 4)
            return (
              <li key={ex.id}>
                <button type="button" className={styles.card} onClick={() => void onPick(ex.id)}>
                  <div className={styles.name}>{ex.name}</div>
                  {badges.length > 0 ? (
                    <div className={styles.badges}>
                      {badges.map((b, i) => (
                        <span key={`${b}-${i}`} className={styles.badge}>{b}</span>
                      ))}
                    </div>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <div className={styles.footer}>
        <Button variant="secondary" block onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  )
}
