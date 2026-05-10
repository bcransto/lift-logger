import { useNavigate } from 'react-router-dom'
import type { WorkoutRow } from '../../types/schema'
import { db } from '../../db/db'
import { relativeDate } from '../../shared/utils/format'
import styles from './WorkoutCard.module.css'

type Props = {
  workout: WorkoutRow
  liftCount: number
  inProgress?: boolean
}

export function WorkoutCard({ workout, liftCount, inProgress = false }: Props) {
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

  const onCardClick = () => navigate(`/workout/${workout.id}`)
  const onCardKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onCardClick()
    }
  }

  const duration = workout.est_duration ? `${workout.est_duration} MIN` : '— MIN'
  const lifts = `${liftCount} ${liftCount === 1 ? 'LIFT' : 'LIFTS'}`
  const last = workout.last_performed ? relativeDate(workout.last_performed).toUpperCase() : 'NEW'

  return (
    <div
      className={`${styles.card} ${workout.starred ? styles.starred : ''}`}
      role="button"
      tabIndex={0}
      aria-label={workout.name}
      onClick={onCardClick}
      onKeyDown={onCardKey}
    >
      <div className={styles.row}>
        <div className={styles.title}>{workout.name}</div>
        <button type="button" className={styles.star} onClick={onStar} aria-label="star">
          {workout.starred ? '★' : '☆'}
        </button>
      </div>
      <div className={styles.meta}>
        {duration} · {lifts} · {inProgress ? <span className={styles.inProgress}>IN PROGRESS</span> : last}
      </div>
    </div>
  )
}
