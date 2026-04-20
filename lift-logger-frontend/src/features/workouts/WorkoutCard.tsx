import { useNavigate } from 'react-router-dom'
import type { WorkoutRow } from '../../types/schema'
import { db } from '../../db/db'
import { relativeDate } from '../../shared/utils/format'
import styles from './WorkoutCard.module.css'

type Props = {
  workout: WorkoutRow
  liftCount: number
}

export function WorkoutCard({ workout, liftCount }: Props) {
  const navigate = useNavigate()

  const onStar = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const now = Date.now()
    await db.workouts.put({
      ...workout,
      starred: workout.starred === 1 ? 0 : 1,
      updated_at: now,
    })
  }

  const duration = workout.est_duration ? `${workout.est_duration} MIN` : '— MIN'
  const lifts = `${liftCount} ${liftCount === 1 ? 'LIFT' : 'LIFTS'}`
  const last = workout.last_performed ? relativeDate(workout.last_performed).toUpperCase() : 'NEW'

  return (
    <button
      className={`${styles.card} ${workout.starred ? styles.starred : ''}`}
      onClick={() => navigate(`/workout/${workout.id}`)}
    >
      <div className={styles.row}>
        <div className={styles.title}>{workout.name}</div>
        <button type="button" className={styles.star} onClick={onStar} aria-label="star">
          {workout.starred ? '★' : '☆'}
        </button>
      </div>
      <div className={styles.meta}>
        {duration} · {lifts} · {last}
      </div>
    </button>
  )
}
