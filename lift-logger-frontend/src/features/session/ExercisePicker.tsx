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
      isn't offered the no-op. Null for append-mode (no current exercise). */
  currentExerciseId: string | null
  /** Name shown in the header as context. Null for append-mode. */
  currentExerciseName: string | null
  /** Header label override. Defaults to "SWAP EXERCISE" / "Pick a replacement". */
  mode?: 'swap' | 'append'
  onPick: (exerciseId: string) => void | Promise<void>
  onCancel: () => void
}

export function ExercisePicker({ currentExerciseId, currentExerciseName, mode = 'swap', onPick, onCancel }: Props) {
  const exercises = useAllExercises()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const rows = exercises ?? []
    const q = query.trim().toLowerCase()
    return rows.filter((ex) => {
      if (currentExerciseId && ex.id === currentExerciseId) return false
      if (!q) return true
      return ex.name.toLowerCase().includes(q)
    })
  }, [exercises, query, currentExerciseId])

  const eyebrow = mode === 'append' ? 'ADD EXERCISE' : 'SWAP EXERCISE'
  const title = mode === 'append' ? 'Pick an exercise' : 'Pick a replacement'

  return (
    <div className={styles.overlay}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>{eyebrow}</div>
        <h1 className={styles.display}>{title}</h1>
        {currentExerciseName ? (
          <div className={styles.currentLine}>CURRENT · {currentExerciseName}</div>
        ) : null}
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
