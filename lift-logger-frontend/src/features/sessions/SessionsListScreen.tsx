// SessionsListScreen — list of past completed sessions.
//
// Reactive over Dexie. Filters to sessions with `ended_at != null` (the
// in-progress session lives on its workout's OverviewScreen instead) and
// sorts by started_at desc.

import { useMemo } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { db } from '../../db/db'
import type { SessionRow, WorkoutSnapshot } from '../../types/schema'
import { dowShort, monShort, timeShort, mmss } from '../../shared/utils/format'
import styles from './SessionsListScreen.module.css'

export function SessionsListScreen() {
  const sessions = useLiveQuery<SessionRow[]>(async () => {
    const all = await db.sessions.toArray()
    return all
      .filter((s) => s.ended_at != null)
      .sort((a, b) => b.started_at - a.started_at)
  }, [])

  // PR + logged-set counts per session, computed in one pass over all
  // session_sets. Keeps the list query simple and avoids N round-trips.
  const setStats = useLiveQuery(async () => {
    const all = await db.session_sets.toArray()
    const stats = new Map<string, { logged: number; prs: number }>()
    for (const r of all) {
      const cur = stats.get(r.session_id) ?? { logged: 0, prs: 0 }
      if (r.skipped !== 1) cur.logged++
      if (r.is_pr === 1) cur.prs++
      stats.set(r.session_id, cur)
    }
    return stats
  }, [])

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.display}>Sessions</h1>
      </header>

      {!sessions ? (
        <div className={styles.empty}>Loading…</div>
      ) : sessions.length === 0 ? (
        <div className={styles.empty}>No completed sessions yet.</div>
      ) : (
        <ul className={styles.list}>
          {sessions.map((s) => (
            <SessionRowItem
              key={s.id}
              session={s}
              logged={setStats?.get(s.id)?.logged ?? 0}
              prs={setStats?.get(s.id)?.prs ?? 0}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function SessionRowItem({
  session,
  logged,
  prs,
}: {
  session: SessionRow
  logged: number
  prs: number
}) {
  const name = useMemo(() => {
    try {
      const snap = JSON.parse(session.workout_snapshot) as WorkoutSnapshot
      return snap?.name ?? 'Workout'
    } catch {
      return 'Workout'
    }
  }, [session.workout_snapshot])

  const durationSec =
    session.duration_sec ??
    (session.ended_at
      ? Math.round((session.ended_at - session.started_at) / 1000)
      : 0)

  return (
    <li>
      <Link to={`/sessions/${session.id}`} className={styles.row}>
        <div className={styles.name}>{name}</div>
        <div className={styles.meta}>
          <span>
            {dowShort(session.started_at)} · {monShort(session.started_at)}{' '}
            {new Date(session.started_at).getDate()} · {timeShort(session.started_at)}
          </span>
          <span className={styles.dot}>·</span>
          <span>{mmss(durationSec)}</span>
          <span className={styles.dot}>·</span>
          <span>{logged} {logged === 1 ? 'set' : 'sets'}</span>
          {prs > 0 ? (
            <>
              <span className={styles.dot}>·</span>
              <span className={styles.pr}>★ {prs}</span>
            </>
          ) : null}
        </div>
      </Link>
    </li>
  )
}

// Used by other helpers if needed.
export type { SessionRow }
