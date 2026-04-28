// SessionHeader — the consistent top nav row used across all screens.
//
// Layout: [LEFT BACK] [CENTER eyebrow/title] [RIGHT slot]
//
// Back semantics: tap the parent screen in the linear hierarchy.
//   home → workout view → block intro → block (active) → set
//
// Right slot priority (highest first):
//   1. Resume Block anchor — shows when an active session exists AND the
//      current route is NOT a session route. Lets the user "zip back" to
//      the active block from anywhere they've drifted (Home, browsing
//      another workout's overview, future Stats/Exercises tabs).
//   2. Caller-provided rightSlot — e.g. BlockView passes `Set ⋮`.
//   3. Nothing.

import type { ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useLocation, useNavigate } from 'react-router-dom'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import styles from './SessionHeader.module.css'

type Props = {
  /** Text for the back button (e.g. "WORKOUT", "BLOCK"). Hidden when undefined. */
  backLabel?: string
  /** Where back navigates. */
  onBack?: () => void
  /** Center content — typically eyebrow text. */
  children?: ReactNode
  /** Caller-provided right content (used when no Resume anchor takes over). */
  rightSlot?: ReactNode
  /** Disable the Resume Block override. Pass true on screens where a more
      prominent Resume affordance already exists (e.g. OverviewScreen's bottom
      "Resume Workout →" CTA when viewing the same workout). */
  suppressResumeAnchor?: boolean
}

export function SessionHeader({
  backLabel,
  onBack,
  children,
  rightSlot,
  suppressResumeAnchor,
}: Props) {
  const navigate = useNavigate()
  const location = useLocation()
  const cursor = useSessionStore((s) => s.cursor)

  const activeSession = useLiveQuery(async () => {
    const all = await db.sessions.toArray()
    return all.find((s) => s.ended_at == null) ?? null
  }, [])

  const onSessionRoute = location.pathname.startsWith('/session/')
  const showResumeAnchor =
    !suppressResumeAnchor && !onSessionRoute && activeSession != null && cursor != null

  const right = showResumeAnchor && cursor && activeSession ? (
    <button
      type="button"
      className={styles.navBtn}
      onClick={() => {
        const setKey = `${cursor.blockExercisePosition}.${cursor.roundNumber}.${cursor.setNumber}`
        navigate(`/session/${activeSession.id}/active/${cursor.blockPosition}/${setKey}`)
      }}
      aria-label="Resume active block"
    >
      → Block
    </button>
  ) : rightSlot ?? null

  const left = backLabel && onBack ? (
    <button
      type="button"
      className={styles.navBtn}
      onClick={onBack}
      aria-label={`Back to ${backLabel.toLowerCase()}`}
    >
      ← {backLabel}
    </button>
  ) : null

  return (
    <header className={styles.header}>
      <div className={styles.slot}>{left}</div>
      <div className={styles.center}>{children}</div>
      <div className={styles.slot}>{right}</div>
    </header>
  )
}
