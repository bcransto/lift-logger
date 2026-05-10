import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAllExercises } from '../../db/queries'
import type { ExerciseRow } from '../../types/schema'
import { Button } from '../../shared/components/Button'
import { parseJsonArray } from '../../shared/utils/format'
import styles from './ExercisesListScreen.module.css'

export function ExercisesListScreen() {
  const navigate = useNavigate()
  const exercises = useAllExercises()
  const [query, setQuery] = useState('')
  const [starredOnly, setStarredOnly] = useState(false)

  const filtered = useMemo(() => {
    const rows = exercises ?? []
    const q = query.trim().toLowerCase()
    return rows.filter((ex) => {
      if (starredOnly && ex.starred !== 1) return false
      if (!q) return true
      return ex.name.toLowerCase().includes(q)
    })
  }, [exercises, query, starredOnly])

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>EXERCISES</div>
      </header>
      <h1 className={styles.display}>Lifts</h1>

      <div className={styles.actionRow}>
        <Button variant="primary" onClick={() => navigate('/exercises/new')}>
          + New
        </Button>
      </div>

      <input
        className={styles.search}
        type="search"
        placeholder="Search exercises…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className={styles.chips}>
        <button
          className={`${styles.chip} ${!starredOnly ? styles.chipActive : ''}`}
          onClick={() => setStarredOnly(false)}
        >
          All
        </button>
        <button
          className={`${styles.chip} ${starredOnly ? styles.chipActive : ''}`}
          onClick={() => setStarredOnly(true)}
        >
          ★ Starred
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>
          {exercises === undefined
            ? 'Loading…'
            : (exercises.length === 0 ? 'No exercises yet.' : 'No matches.')}
        </div>
      ) : (
        <ul className={styles.list}>
          {filtered.map((ex) => (
            <li key={ex.id}>
              <ExerciseRowCard exercise={ex} onTap={() => navigate(`/exercises/${ex.id}/edit`)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ExerciseRowCard({ exercise, onTap }: { exercise: ExerciseRow; onTap: () => void }) {
  const muscles = parseJsonArray(exercise.muscle_groups) as string[]
  const equipment = parseJsonArray(exercise.equipment) as string[]
  const badges = [...muscles, ...equipment].slice(0, 4)

  return (
    <button
      type="button"
      className={`${styles.card} ${exercise.starred ? styles.starred : ''}`}
      onClick={onTap}
    >
      <div className={styles.row}>
        <div className={styles.title}>{exercise.name}</div>
        {exercise.starred === 1 && <span className={styles.star}>★</span>}
      </div>
      {badges.length > 0 && (
        <div className={styles.badges}>
          {badges.map((b, i) => (
            <span key={`${b}-${i}`} className={styles.badge}>
              {b}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}
