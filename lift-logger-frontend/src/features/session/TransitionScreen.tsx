import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import { useSessionStore } from '../../stores/sessionStore'
import { Button } from '../../shared/components/Button'
import { RestTimerCard } from './RestTimerCard'
import { SetCard } from './SetCard'
import { SavePreferencePrompt } from './SavePreferencePrompt'
import { mmss } from '../../shared/utils/format'
import { cursorKey } from './sessionEngine'
import type { SessionSetRow, WorkoutSnapshot } from '../../types/schema'
import styles from './TransitionScreen.module.css'

export function TransitionScreen() {
  const { sessionId, blockPosition: bpStr } = useParams<{ sessionId: string; blockPosition: string }>()
  const navigate = useNavigate()

  const blockPosition = Number.parseInt(bpStr ?? '1', 10)
  const session = useLiveQuery(() => (sessionId ? db.sessions.get(sessionId) : undefined), [sessionId])
  const snapshot = useMemo<WorkoutSnapshot | null>(() => {
    if (!session?.workout_snapshot) return null
    try {
      return JSON.parse(session.workout_snapshot) as WorkoutSnapshot
    } catch {
      return null
    }
  }, [session])

  const logged = useLiveQuery<SessionSetRow[]>(
    async () => (sessionId ? db.session_sets.where('session_id').equals(sessionId).toArray() : []),
    [sessionId],
  )

  const cursor = useSessionStore((s) => s.cursor)
  const applyEdit = useSessionStore((s) => s.applyEdit)
  const savePreference = useSessionStore((s) => s.savePreference)

  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  if (!session || !snapshot) return <div className={styles.empty}>Loading…</div>

  const block = snapshot.blocks.find((b) => b.position === blockPosition)
  if (!block) return <div className={styles.empty}>Block not found.</div>

  const totalLifts = snapshot.blocks.reduce((n, b) => n + b.exercises.length, 0)
  const liftNumber = snapshot.blocks
    .filter((b) => b.position < blockPosition)
    .reduce((n, b) => n + b.exercises.length, 0) + 1

  const elapsed = mmss((now - session.started_at) / 1000)
  const autoStartSec = block.rest_after_sec ?? (blockPosition === 1 ? 0 : 60)

  const onReady = () => {
    const c = cursor
    if (!c) {
      navigate(`/session/${sessionId}/summary`)
      return
    }
    const setKey = `${c.blockExercisePosition}.${c.roundNumber}.${c.setNumber}`
    navigate(`/session/${sessionId}/active/${c.blockPosition}/${setKey}`)
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>
          UP NEXT · LIFT {liftNumber} OF {totalLifts}
        </div>
        <div className={styles.elapsed}>{elapsed} ELAPSED</div>
      </header>

      <h1 className={styles.display}>{block.exercises[0]?.name ?? '(block)'}</h1>
      {block.kind !== 'single' ? (
        <div className={styles.groupLabel}>
          {block.kind === 'superset' ? 'SUPERSET' : 'CIRCUIT'} · {block.rounds} ROUNDS
        </div>
      ) : null}

      {autoStartSec > 0 ? (
        <RestTimerCard
          title={blockPosition === 1 ? 'SETUP' : 'REST'}
          autoStart={{ kind: blockPosition === 1 ? 'setup' : 'rest', durationSec: autoStartSec }}
        />
      ) : null}

      {block.setup_cue ? <StationSetup cue={block.setup_cue} /> : null}

      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>SETS · TAP TO EDIT</span>
        {savePreference ? (
          <span className={`${styles.saveTag} ${styles[savePreference]}`}>
            {savePreference === 'template' ? 'template' : 'session'}
          </span>
        ) : null}
      </div>

      <SavePreferencePrompt />

      <div className={styles.blocks}>
        {block.exercises.map((be) => (
          <div key={be.id} className={styles.exGroup}>
            {block.exercises.length > 1 ? (
              <div className={styles.exLabel}>{be.name}</div>
            ) : null}
            <div className={styles.setGrid}>
              {be.sets.map((s) => {
                const loggedKey = cursorKey({
                  blockPosition,
                  blockExercisePosition: be.position,
                  roundNumber: 1,
                  setNumber: s.set_number,
                })
                const match = (logged ?? []).find(
                  (r) =>
                    r.block_position === blockPosition &&
                    r.block_exercise_position === be.position &&
                    r.set_number === s.set_number,
                )
                const cur = cursor ?? null
                const isCurrent =
                  cur?.blockPosition === blockPosition &&
                  cur?.blockExercisePosition === be.position &&
                  cur?.roundNumber === 1 &&
                  cur?.setNumber === s.set_number
                const state = match ? 'done' : isCurrent ? 'current' : s.is_peak ? 'peak' : 'pending'
                return (
                  <SetCard
                    key={loggedKey}
                    target={s}
                    state={state}
                    actual={match ? { weight: match.actual_weight, reps: match.actual_reps, duration: match.actual_duration_sec } : null}
                    onEdit={(patch) =>
                      applyEdit({
                        kind: 'editSetTarget',
                        blockPosition,
                        blockExercisePosition: be.position,
                        setNumber: s.set_number,
                        patch,
                      })
                    }
                  />
                )
              })}
            </div>
            <div className={styles.exActions}>
              <button
                className={styles.addBtn}
                onClick={() =>
                  applyEdit({
                    kind: 'addSet',
                    blockPosition,
                    blockExercisePosition: be.position,
                    target: {
                      set_number: (be.sets[be.sets.length - 1]?.set_number ?? 0) + 1,
                      target_weight: be.sets[be.sets.length - 1]?.target_weight ?? null,
                      target_reps: be.sets[be.sets.length - 1]?.target_reps ?? null,
                    },
                  })
                }
              >
                + Add Set
              </button>
              {be.sets.length > 1 ? (
                <button
                  className={styles.deleteBtn}
                  onClick={() =>
                    applyEdit({
                      kind: 'deleteSet',
                      blockPosition,
                      blockExercisePosition: be.position,
                      setNumber: be.sets[be.sets.length - 1]!.set_number,
                    })
                  }
                >
                  − Remove Last
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.footer}>
        <Button variant="primary" block onClick={onReady}>
          I’m Ready →
        </Button>
      </div>
    </div>
  )
}

function StationSetup({ cue }: { cue: string }) {
  // Render cue with **bold** values in amber and line breaks preserved.
  return (
    <div className={styles.setup}>
      <div className={styles.setupLabel}>STATION SETUP</div>
      <div className={styles.setupBody}>
        {cue.split(/\n+/).map((line, i) => (
          <div key={i} className={styles.setupLine}>
            → {renderCueLine(line)}
          </div>
        ))}
      </div>
    </div>
  )
}

function renderCueLine(line: string): React.ReactNode[] {
  const parts = line.split(/(\*\*.+?\*\*)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return (
        <span key={i} className={styles.setupBold}>
          {p.slice(2, -2)}
        </span>
      )
    }
    return <span key={i}>{p}</span>
  })
}
