import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../../db/db'
import type { WorkoutRow } from '../../types/schema'
import { WorkoutCard } from './WorkoutCard'
import { SyncIndicator } from '../../shared/components/SyncIndicator'
import { useAutoSync } from '../../sync/useSyncStatus'
import { dowShort, timeShort, parseJsonArray } from '../../shared/utils/format'
import styles from './HomeScreen.module.css'

type Sort = 'last_performed' | 'starred' | 'az' | 'duration'

export function HomeScreen() {
  useAutoSync()
  const [now, setNow] = useState(Date.now())
  const [query, setQuery] = useState('')
  const [chip, setChip] = useState<string>('All')
  const [sort, setSort] = useState<Sort>('last_performed')

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const workouts = useLiveQuery(() => db.workouts.toArray(), [])
  const liftCounts = useLiveQuery(async () => {
    const all = await db.block_exercises.toArray()
    const blocks = await db.workout_blocks.toArray()
    const byWorkout = new Map<string, number>()
    const blockById = new Map(blocks.map((b) => [b.id, b.workout_id]))
    for (const be of all) {
      const wid = blockById.get(be.block_id)
      if (!wid) continue
      byWorkout.set(wid, (byWorkout.get(wid) ?? 0) + 1)
    }
    return byWorkout
  }, [])

  // Workout IDs that have at least one *completed* session. Abandoned and
  // active-with-zero-sets sessions don't count — "New" means "never actually
  // performed", not "never touched".
  const sessionedWorkoutIds = useLiveQuery(async () => {
    const rows = await db.sessions.where('status').equals('completed').toArray()
    return new Set(rows.map((s) => s.workout_id).filter((id) => id !== null) as string[])
  }, [])

  const chips = useMemo(() => {
    const tagSet = new Set<string>()
    for (const w of workouts ?? []) {
      for (const t of parseJsonArray(w.tags)) tagSet.add(t)
    }
    const extra = [...tagSet].slice(0, 8).map((t) => t[0]!.toUpperCase() + t.slice(1))
    return ['All', 'New', '★ Starred', ...extra]
  }, [workouts])

  const filtered = useMemo(() => {
    const rows = (workouts ?? []).slice()
    const q = query.trim().toLowerCase()
    const byQuery = (w: WorkoutRow) => {
      if (!q) return true
      if (w.name.toLowerCase().includes(q)) return true
      const tags = parseJsonArray(w.tags) as string[]
      return tags.some((t) => t.toLowerCase().includes(q))
    }
    const byChip = (w: WorkoutRow) => {
      if (chip === 'All') return true
      if (chip === 'New') return !(sessionedWorkoutIds?.has(w.id) ?? false)
      if (chip === '★ Starred') return w.starred === 1
      const tags = parseJsonArray(w.tags) as string[]
      return tags.some((t) => t.toLowerCase() === chip.toLowerCase())
    }
    const filtered = rows.filter((w) => byQuery(w) && byChip(w))
    // "New" overrides the sort dropdown — user expects newest-first.
    filtered.sort(chip === 'New' ? (a, b) => b.created_at - a.created_at : byCmp(sort))
    return filtered
  }, [workouts, sessionedWorkoutIds, query, chip, sort])

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>
          {dowShort(now)} · {timeShort(now)}
        </div>
        <SyncIndicator />
      </header>
      <h1 className={styles.display}>IRON.</h1>

      <input
        className={styles.search}
        type="search"
        placeholder="Search workouts or lifts…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className={styles.chips}>
        {chips.map((c) => (
          <button
            key={c}
            className={`${styles.chip} ${c === chip ? styles.chipActive : ''}`}
            onClick={() => setChip(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div className={styles.sortRow}>
        <span className={styles.eyebrow}>Sort</span>
        <select className={styles.sort} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="last_performed">Last performed</option>
          <option value="starred">Starred first</option>
          <option value="az">A → Z</option>
          <option value="duration">Duration</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty}>
          {workouts === undefined ? 'Loading…' : 'No workouts yet — agent hasn\u2019t uploaded any.'}
        </div>
      ) : (
        <ul className={styles.list}>
          {filtered.map((w) => (
            <li key={w.id}>
              <WorkoutCard workout={w} liftCount={liftCounts?.get(w.id) ?? 0} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function byCmp(sort: Sort): (a: WorkoutRow, b: WorkoutRow) => number {
  switch (sort) {
    case 'az':
      return (a, b) => a.name.localeCompare(b.name)
    case 'duration':
      return (a, b) => (a.est_duration ?? 0) - (b.est_duration ?? 0)
    case 'starred':
      return (a, b) => {
        if (a.starred !== b.starred) return b.starred - a.starred
        return (b.last_performed ?? 0) - (a.last_performed ?? 0)
      }
    case 'last_performed':
    default:
      return (a, b) => (b.last_performed ?? 0) - (a.last_performed ?? 0)
  }
}
