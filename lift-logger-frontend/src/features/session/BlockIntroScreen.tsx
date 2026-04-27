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
import { setsForRound } from './sessionEngine'
import type { SessionSetRow, WorkoutSnapshot } from '../../types/schema'
import styles from './BlockIntroScreen.module.css'

export function BlockIntroScreen() {
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

  const isMultiRound = block.kind !== 'single' && block.rounds > 1
  // Which rounds have at least one explicit override row? Shown as a "•"
  // indicator on the round header so the user can spot rounds that differ
  // from R1 at a glance.
  const overrideRounds = new Set<number>()
  for (const be of block.exercises) {
    for (const s of be.sets) {
      const rn = s.round_number ?? 1
      if (rn > 1) overrideRounds.add(rn)
    }
  }
  const sortedExercises = block.exercises.slice().sort((a, b) => a.position - b.position)
  const hasProgressInBlock = (logged ?? []).some((r) => r.block_position === blockPosition)
  const ctaLabel = hasProgressInBlock ? 'Resume →' : 'I’m Ready →'

  const onReady = () => {
    const c = cursor
    if (!c) {
      navigate(`/session/${sessionId}/summary`, { replace: true })
      return
    }
    const setKey = `${c.blockExercisePosition}.${c.roundNumber}.${c.setNumber}`
    // replace (not push) so iOS edge-swipe-back from active doesn't pop to
    // the intro screen we just left — it goes to the overview/home behind it.
    navigate(`/session/${sessionId}/active/${c.blockPosition}/${setKey}`, { replace: true })
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

      {block.kind === 'single' ? (
        <div className={styles.blocks}>
          {sortedExercises.map((be) => {
            const roundSets = setsForRound(be, 1)
              .slice()
              .sort((a, b) => a.set_number - b.set_number)
            return (
              <div key={be.id} className={styles.exGroup}>
                {sortedExercises.length > 1 ? (
                  <div className={styles.exLabel}>{be.name}</div>
                ) : null}
                <div className={styles.setGrid}>
                  {roundSets.map((s) => {
                    const match = (logged ?? []).find(
                      (r) =>
                        r.block_position === blockPosition &&
                        r.block_exercise_position === be.position &&
                        r.round_number === 1 &&
                        r.set_number === s.set_number,
                    )
                    // No 'current' state on the intro — this is a plan preview,
                    // not the executing view. Only done / peak / pending.
                    const state = match ? 'done' : s.is_peak ? 'peak' : 'pending'
                    return (
                      <SetCard
                        key={`${s.set_number}`}
                        target={s}
                        state={state}
                        actual={match ? { weight: match.actual_weight, reps: match.actual_reps, duration: match.actual_duration_sec } : null}
                        onEdit={(patch) =>
                          applyEdit({
                            kind: 'editSetTarget',
                            blockPosition,
                            blockExercisePosition: be.position,
                            roundNumber: 1,
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
                          set_number: (roundSets[roundSets.length - 1]?.set_number ?? 0) + 1,
                          round_number: 1,
                          target_weight: roundSets[roundSets.length - 1]?.target_weight ?? null,
                          target_reps: roundSets[roundSets.length - 1]?.target_reps ?? null,
                        },
                      })
                    }
                  >
                    + Add Set
                  </button>
                  {roundSets.length > 1 ? (
                    <button
                      className={styles.deleteBtn}
                      onClick={() =>
                        applyEdit({
                          kind: 'deleteSet',
                          blockPosition,
                          blockExercisePosition: be.position,
                          roundNumber: 1,
                          setNumber: roundSets[roundSets.length - 1]!.set_number,
                        })
                      }
                    >
                      − Remove Last
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        // Superset / circuit: stacked rounds. Each round is its own row with
        // the exercises side-by-side (A, B, C...) labeled with a colored badge.
        // Every round is visible — no tab switching — so the user can scan
        // the whole plan in one view.
        <div className={styles.rounds}>
          {Array.from({ length: isMultiRound ? block.rounds : 1 }, (_, i) => i + 1).map((r) => (
            <div key={r} className={styles.roundSection}>
              <div className={styles.roundHeader}>
                <span className={styles.roundRule} />
                <span className={styles.roundLabel}>
                  R{r}{isMultiRound ? ` / ${block.rounds}` : ''}
                  {overrideRounds.has(r) ? (
                    <span className={styles.roundTabDot} aria-label="has overrides" />
                  ) : null}
                </span>
                <span className={styles.roundRule} />
              </div>
              <div
                className={styles.pairGrid}
                style={{
                  gridTemplateColumns: `repeat(${sortedExercises.length > 2 ? 2 : sortedExercises.length}, 1fr)`,
                }}
              >
                {sortedExercises.map((be, idx) => {
                  const roundSets = setsForRound(be, r)
                    .slice()
                    .sort((a, b) => a.set_number - b.set_number)
                  const badge = String.fromCharCode(65 + idx) // A, B, C...
                  return (
                    <div key={be.id} className={styles.exCol}>
                      <div className={styles.exHeader}>
                        <span className={styles.exBadge}>{badge}</span>
                        <span className={styles.exColName}>{be.name}</span>
                      </div>
                      <div className={styles.setStack}>
                        {roundSets.map((s) => {
                          const match = (logged ?? []).find(
                            (rr) =>
                              rr.block_position === blockPosition &&
                              rr.block_exercise_position === be.position &&
                              rr.round_number === r &&
                              rr.set_number === s.set_number,
                          )
                          // Intro is a plan preview — no 'current' focus here.
                          const state = match ? 'done' : s.is_peak ? 'peak' : 'pending'
                          return (
                            <SetCard
                              key={`${r}-${s.set_number}`}
                              target={s}
                              state={state}
                              actual={match ? { weight: match.actual_weight, reps: match.actual_reps, duration: match.actual_duration_sec } : null}
                              onEdit={(patch) =>
                                applyEdit({
                                  kind: 'editSetTarget',
                                  blockPosition,
                                  blockExercisePosition: be.position,
                                  roundNumber: r,
                                  setNumber: s.set_number,
                                  patch,
                                })
                              }
                            />
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {block.kind !== 'single' ? (
        <div className={styles.blockActions}>
          <button
            className={styles.addBtn}
            onClick={() => applyEdit({ kind: 'addRound', blockPosition })}
          >
            + Add Round (clones R{block.rounds})
          </button>
          {block.rounds > 1 ? (
            <button
              className={styles.deleteBtn}
              onClick={() => applyEdit({ kind: 'removeLastRound', blockPosition })}
            >
              − Remove Last Round
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={styles.footer}>
        <Button variant="primary" block onClick={onReady}>
          {ctaLabel}
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
