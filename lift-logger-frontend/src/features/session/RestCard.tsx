import styles from './RestCard.module.css'

type Props = {
  durationSec: number
  isActive: boolean | undefined
}

export function RestCard({ durationSec, isActive }: Props) {
  return (
    <div className={`${styles.card} ${isActive ? styles.active : ''}`}>
      <div className={styles.label}>REST</div>
      <div className={styles.duration}>{durationSec}s</div>
    </div>
  )
}
