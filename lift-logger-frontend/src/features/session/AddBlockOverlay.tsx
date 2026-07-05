// AddBlockOverlay — two-step wizard for appending a block (issue #4).
// Step 1: pick the block kind. Step 2: kind-specific structural params,
// with target weight/reps prefilled from each exercise's LAST (prior
// session's best set) at pick time.
//
// Deliberately commit-free: emits a NewBlockSpec via onAdd and the caller
// decides where it lands — appendBlockToCurrentSession (session snapshot)
// today; issue #32's appendBlockToWorkout (template rows) reuses this
// overlay unchanged.

import { useState } from 'react'
import { db } from '../../db/db'
import { Button } from '../../shared/components/Button'
import { NumberStepper } from '../../shared/components/NumberStepper'
import { ExercisePicker } from './ExercisePicker'
import { LastAndPrRow, queryLastAndPr } from './LastAndPrRow'
import type { NewBlockExerciseSpec, NewBlockSpec } from './blockSpec'
import styles from './AddBlockOverlay.module.css'

type Props = {
  /** Active session id — excluded from the LAST lookup so mid-session logs
      don't count as "previous". Null pre-session (issue #32 create flow). */
  currentSessionId: string | null
  onAdd: (spec: NewBlockSpec) => void | Promise<void>
  onCancel: () => void
}

type Step = 'kind' | 'single' | 'superset' | 'circuit'

const KIND_OPTIONS: Array<{ step: Exclude<Step, 'kind'>; name: string; desc: string }> = [
  { step: 'single', name: 'Single', desc: 'One exercise, straight sets' },
  { step: 'superset', name: 'Superset', desc: 'Alternate 2+ exercises, user-paced rest' },
  { step: 'circuit', name: 'Circuit', desc: 'Stations in rounds, timed HIIT loop' },
]

export function AddBlockOverlay({ currentSessionId, onAdd, onCancel }: Props) {
  const [step, setStep] = useState<Step>('kind')
  const [exercises, setExercises] = useState<NewBlockExerciseSpec[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)

  // Single
  const [setCount, setSetCount] = useState(3)
  const [restSetsSec, setRestSetsSec] = useState(180)
  // Superset / circuit
  const [rounds, setRounds] = useState(3)
  const [restRoundsSec, setRestRoundsSec] = useState(90)
  // Circuit
  const [workMode, setWorkMode] = useState<'timed' | 'reps'>('timed')
  const [workSec, setWorkSec] = useState(30)
  const [restStationsSec, setRestStationsSec] = useState(15)

  const chooseKind = (k: Exclude<Step, 'kind'>) => {
    setExercises([])
    setRounds(3)
    setRestRoundsSec(k === 'circuit' ? 60 : 90)
    setStep(k)
    // Single's first required action is the pick — skip the empty form tap.
    if (k === 'single') setPickerOpen(true)
  }

  const onPickExercise = async (exerciseId: string) => {
    const ex = await db.exercises.get(exerciseId)
    // Prefill targets from LAST at pick time (one-shot — a live query here
    // would stomp manual edits on re-emit). Re-picking re-seeds.
    const { last } = await queryLastAndPr(exerciseId, currentSessionId)
    const spec: NewBlockExerciseSpec = {
      exerciseId,
      name: ex?.name ?? 'Exercise',
      targetWeight: last?.weight ?? null,
      targetReps: last?.reps ?? null,
    }
    setExercises((prev) => (step === 'single' ? [spec] : [...prev, spec]))
    setPickerOpen(false)
  }

  const updateExercise = (idx: number, patch: Partial<NewBlockExerciseSpec>) => {
    setExercises((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)))
  }
  const removeExercise = (idx: number) => {
    setExercises((prev) => prev.filter((_, i) => i !== idx))
  }

  const spec = ((): NewBlockSpec | null => {
    if (step === 'single') {
      const ex = exercises[0]
      if (!ex) return null
      return { kind: 'single', exercise: ex, setCount, restBetweenSetsSec: restSetsSec }
    }
    if (step === 'superset') {
      if (exercises.length < 2) return null
      return { kind: 'superset', exercises, rounds, restBetweenRoundsSec: restRoundsSec }
    }
    if (step === 'circuit') {
      if (exercises.length < 2) return null
      return {
        kind: 'circuit',
        exercises,
        rounds,
        work: workMode === 'timed' ? { mode: 'timed', durationSec: workSec } : { mode: 'reps' },
        restBetweenStationsSec: restStationsSec,
        restBetweenRoundsSec: restRoundsSec,
      }
    }
    return null
  })()

  const kindLabel = KIND_OPTIONS.find((o) => o.step === step)?.name ?? ''

  if (step === 'kind') {
    return (
      <div className={styles.overlay}>
        <header className={styles.header}>
          <div className={styles.eyebrow}>ADD BLOCK</div>
          <h1 className={styles.display}>Choose block type</h1>
        </header>
        <div className={styles.kindList}>
          {KIND_OPTIONS.map((o) => (
            <button
              key={o.step}
              type="button"
              className={styles.kindCard}
              onClick={() => chooseKind(o.step)}
            >
              <div className={styles.kindName}>{o.name}</div>
              <div className={styles.kindDesc}>{o.desc}</div>
            </button>
          ))}
        </div>
        <div className={styles.footer}>
          <Button variant="secondary" block onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  const singleExercise = step === 'single' ? exercises[0] ?? null : null
  const stationNoun = step === 'circuit' ? 'station' : 'exercise'
  const needsMore = step !== 'single' && exercises.length < 2

  return (
    <div className={styles.overlay}>
      <header className={styles.header}>
        <div className={styles.eyebrow}>ADD BLOCK · {kindLabel.toUpperCase()}</div>
        <h1 className={styles.display}>{kindLabel} block</h1>
      </header>

      {step === 'single' ? (
        <>
          <button type="button" className={styles.exPickRow} onClick={() => setPickerOpen(true)}>
            <span className={styles.exPickLabel}>Exercise</span>
            <span className={singleExercise ? styles.exPickName : styles.exPickEmpty}>
              {singleExercise ? singleExercise.name : 'Choose exercise'} ›
            </span>
          </button>
          {singleExercise ? (
            <>
              <LastAndPrRow
                exerciseId={singleExercise.exerciseId}
                sessionId={currentSessionId}
                exerciseName={singleExercise.name}
                showName={false}
              />
              <div className={styles.targetsGrid}>
                <NumberStepper
                  label="Target weight"
                  unit="lb"
                  value={singleExercise.targetWeight}
                  step={5}
                  allowNull
                  onChange={(v) => updateExercise(0, { targetWeight: v })}
                />
                <NumberStepper
                  label="Target reps"
                  value={singleExercise.targetReps}
                  step={1}
                  min={0}
                  allowNull
                  onChange={(v) => updateExercise(0, { targetReps: v })}
                />
              </div>
            </>
          ) : null}
          <NumberStepper
            label="Sets"
            value={setCount}
            step={1}
            min={1}
            onChange={(v) => setSetCount(v ?? 1)}
          />
          <NumberStepper
            label="Rest between sets"
            unit="sec"
            value={restSetsSec}
            step={15}
            min={0}
            onChange={(v) => setRestSetsSec(v ?? 0)}
          />
        </>
      ) : (
        <>
          {step === 'circuit' ? (
            <div className={styles.segRow}>
              <span className={styles.segLabel}>Work</span>
              <div className={styles.seg}>
                <button
                  type="button"
                  className={workMode === 'timed' ? styles.segActive : styles.segBtn}
                  onClick={() => setWorkMode('timed')}
                >
                  Timed
                </button>
                <button
                  type="button"
                  className={workMode === 'reps' ? styles.segActive : styles.segBtn}
                  onClick={() => setWorkMode('reps')}
                >
                  Reps
                </button>
              </div>
            </div>
          ) : null}
          {step === 'circuit' && workMode === 'timed' ? (
            <NumberStepper
              label="Work duration"
              unit="sec"
              value={workSec}
              step={5}
              min={5}
              onChange={(v) => setWorkSec(v ?? 30)}
            />
          ) : null}

          {exercises.map((ex, i) => {
            const showReps = step === 'superset' || workMode === 'reps'
            return (
              <div key={`${ex.exerciseId}-${i}`} className={styles.exCard}>
                <div className={styles.exCardHeader}>
                  <span className={styles.exCardName}>
                    {i + 1} · {ex.name}
                  </span>
                  <button
                    type="button"
                    className={styles.remove}
                    onClick={() => removeExercise(i)}
                    aria-label={`Remove ${ex.name}`}
                  >
                    ✕
                  </button>
                </div>
                <LastAndPrRow
                  exerciseId={ex.exerciseId}
                  sessionId={currentSessionId}
                  exerciseName={ex.name}
                  showName={false}
                />
                <div className={showReps ? styles.targetsGrid : undefined}>
                  <NumberStepper
                    label="Weight"
                    unit="lb"
                    value={ex.targetWeight}
                    step={5}
                    allowNull
                    onChange={(v) => updateExercise(i, { targetWeight: v })}
                  />
                  {showReps ? (
                    <NumberStepper
                      label="Reps"
                      value={ex.targetReps}
                      step={1}
                      min={0}
                      allowNull
                      onChange={(v) => updateExercise(i, { targetReps: v })}
                    />
                  ) : null}
                </div>
              </div>
            )
          })}

          <button type="button" className={styles.addRow} onClick={() => setPickerOpen(true)}>
            + Add {stationNoun}
          </button>

          <NumberStepper
            label="Rounds"
            value={rounds}
            step={1}
            min={1}
            onChange={(v) => setRounds(v ?? 1)}
          />
          {step === 'circuit' ? (
            <NumberStepper
              label="Rest between stations"
              unit="sec"
              value={restStationsSec}
              step={5}
              min={0}
              onChange={(v) => setRestStationsSec(v ?? 0)}
            />
          ) : null}
          <NumberStepper
            label="Rest between rounds"
            unit="sec"
            value={restRoundsSec}
            step={15}
            min={0}
            onChange={(v) => setRestRoundsSec(v ?? 0)}
          />
        </>
      )}

      {needsMore ? (
        <div className={styles.hint}>Add at least 2 {stationNoun}s</div>
      ) : null}

      <div className={styles.footer}>
        <Button variant="secondary" block onClick={() => setStep('kind')}>
          ← Back
        </Button>
        <Button
          variant="primary"
          block
          disabled={!spec}
          onClick={() => {
            if (spec) void onAdd(spec)
          }}
        >
          Add Block →
        </Button>
      </div>

      {pickerOpen ? (
        <ExercisePicker
          currentExerciseId={step === 'single' ? singleExercise?.exerciseId ?? null : null}
          currentExerciseName={step === 'single' ? singleExercise?.name ?? null : null}
          mode="append"
          onPick={onPickExercise}
          onCancel={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  )
}
