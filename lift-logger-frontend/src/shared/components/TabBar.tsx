import { NavLink } from 'react-router-dom'
import styles from './TabBar.module.css'

const TABS = [
  { to: '/', label: 'Workouts' },
  { to: '/exercises', label: 'Exercises' },
  { to: '/stats', label: 'Stats' },
  { to: '/settings', label: 'Settings' },
] as const

export function TabBar() {
  return (
    <nav className={styles.root}>
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.to === '/'}
          className={({ isActive }) => `${styles.tab} ${isActive ? styles.active : ''}`}
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  )
}
