import styles from './StubScreen.module.css'

export function ExercisesTab() {
  return <Stub title="Exercises" />
}
export function StatsTab() {
  return <Stub title="Stats" />
}
export function SettingsTab() {
  return <Stub title="Settings" />
}

function Stub({ title }: { title: string }) {
  return (
    <div className={styles.root}>
      <div className={styles.eyebrow}>{title.toUpperCase()}</div>
      <h1 className={styles.display}>Coming soon.</h1>
      <p className={styles.body}>
        This tab is a Phase 2 deliverable. For now, the Workouts tab is where the action is.
      </p>
    </div>
  )
}
