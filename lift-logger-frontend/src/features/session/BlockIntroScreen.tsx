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
import { cursorKey, setsForRound } from './sessionEngine'
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

  // Active round tab (superset/circuit only). Clamped to block.rounds so that
  // a Remove Last Round action that trims below the active tab falls back.
  const [activeRound, setActiveRound] = useState(1)

  if (!session || !snapshot) return <div className={styles.empty}>Loading…</div>

  const block = snapshot.blocks.find((b) => b.position === blockPosition)
  if (!block) return <div className={styles.empty}>Block not found.</div>

  const totalLifts = snapshot.blocks.reduce((n, b) => n + b.exercises.length, 0)
  const liftNumber = snapshot.blocks
    .filter((b) => b.position < blockPosition)
    .reduce((n, b) => n + b.exercises.length, 0) + 1

  const elapsed = mmss((now - session.started_at) / 1000)
  const autoStartSec = block.rest_after_sec ?? (blockPosition === 1 ? 0 : 60)

  const showRoundTabs = block.kind !== 'single' && block.rounds > 1
  // Clamp active round to block.rounds. Guards against Remove-Last-Round
  // taking rounds below the active tab — fall back to the new last round.
  const effectiveRound = showRoundTabs ? Math.min(Math.max(activeRound, 1), block.rounds) : 1
  // Which rounds have at least one explicit override row? Used to render the
  // "•" indicator on tabs so the user knows which rounds differ from R1.
  const overrideRounds = new Set<number>()
  for (const be of block.exercises) {
    for (const s of be.sets) {
      const rn = s.round_number ?? 1
      if (rn > 1) overrideRounds.add(rn)
    }
  }

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
        <span className={styles.sectionTitle}>
          SETS · TAP TO EDIT
          {showRoundTabs ? ` · R${effectiveRound}` : ''}
        </span>
        {savePreference ? (
          <span className={`${styles.saveTag} ${styles[savePreference]}`}>
            {savePreference === 'template' ? 'template' : 'session'}
          </span>
        ) : null}
      </div>

      {showRoundTabs ? (
        <div className={styles.roundTabs} role="tablist">
          {Array.from({ length: block.rounds }, (_, i) => i + 1).map((r) => {
            const isActive = r === effectiveRound
            const hasOverride = overrideRounds.has(r)
            return (
              <button
                key={r}
                role="tab"
                aria-selected={isActive}
                className={`${styles.roundTab} ${isActive ? styles.roundTabActive : ''}`}
                onClick={() => setActiveRound(r)}
              >
                R{r}
                {hasOverride ? <span className={styles.roundTabDot} aria-label="has overrides" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}

      <SavePreferencePrompt />

      <div className={styles.blocks}>
        {block.exercises.map((be) => {
          // Round-expanded snapshots have per-round entries; supersets that
          // don't specify per-round overrides fall back to round-1 anchors
          // via setsForRound. For single blocks this is effectively round-1.
          const roundSets = setsForRound(be, effectiveRound)
            .slice()
            .sort((a, b) => a.set_number - b.set_number)
          return (
          <div key={be.id} className={styles.exGroup}>
            {block.exercises.length > 1 ? (
              <div className={styles.exLabel}>{be.name}</div>
            ) : null}
            <div className={styles.setGrid}>
              {roundSets.map((s) => {
                const loggedKey = cursorKey({
                  blockPosition,
                  blockExercisePosition: be.position,
                  roundNumber: effectiveRound,
                  setNumber: s.set_number,
                })
                const match = (logged ?? []).find(
                  (r) =>
                    r.block_position === blockPosition &&
                    r.block_exercise_position === be.position &&
                    r.round_number === effectiveRound &&
                    r.set_number === s.set_number,
                )
                const cur = cursor ?? null
                const isCurrent =
                  cur?.blockPosition === blockPosition &&
                  cur?.blockExercisePosition === be.position &&
                  cur?.roundNumber === effectiveRound &&
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
                        roundNumber: effectiveRound,
                        setNumber: s.set_number,
                        patch,
                      })
                    }
                  />
                )
              })}
            </div>
            {block.kind === 'single' ? (
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
            ) : null}
          </div>
          )
        })}
      </div>

      {block.kind !== 'single' ? (
        <div className={styles.blockActions}>
          <button
            className={styles.addBtn}
            onClick={() => {
              applyEdit({ kind: 'addRound', blockPosition })
              // Auto-select the new round so the user can tweak it.
              setActiveRound(block.rounds + 1)
            }}
          >
            + Add Round (clones R{block.rounds})
          </button>
          {block.rounds > 1 ? (
            <button
              className={styles.deleteBtn}
              onClick={() => {
                applyEdit({ kind: 'removeLastRound', blockPosition })
                // Clamp tab if we were viewing the now-removed round.
                if (activeRound >= block.rounds) setActiveRound(block.rounds - 1)
              }}
            >
              − Remove Last Round
            </button>
          ) : null}
        </div>
      ) : null}

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
