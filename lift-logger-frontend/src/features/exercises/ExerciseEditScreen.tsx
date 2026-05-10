// Single screen for both /exercises/new and /exercises/:id/edit. Branches on
// the presence of `:id` in the route.
//
// Validation mirrors the MCP `createExercise` contract (lift-logger-mcp/tools/exercises.js):
//   - name: required, trimmed, non-empty
//   - equipment / muscle_groups: string[] (default [])
//   - movement_type: one of 8 values OR null
//   - is_unilateral / starred: bool → 0|1 at the DB boundary
//
// Equipment + muscle_groups are entered as comma-separated text (split on
// commas, trim, drop empties on save; rejoined with ", " on load). Simpler
// than chip pickers and consistent with how the data is shaped today.

import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate, useParams } from 'react-router-dom'
import { db } from '../../db/db'
import { useExerciseUsageCount } from '../../db/queries'
import type { ExerciseRow, MovementType } from '../../types/schema'
import { asExerciseId } from '../../types/ids'
import { Button } from '../../shared/components/Button'
import { genId } from '../../shared/util/genId'
import { parseJsonArray } from '../../shared/utils/format'
import styles from './ExerciseEditScreen.module.css'

const MOVEMENT_TYPES: MovementType[] = [
  'squat',
  'hinge',
  'push',
  'pull',
  'carry',
  'iso',
  'plyo',
  'cardio',
]

function csvFromArray(arr: string[]): string {
  return arr.join(', ')
}

function arrayFromCsv(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function ExerciseEditScreen() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const isEdit = id !== undefined

  // Load existing row when editing.
  const existing = useLiveQuery(async () => {
    if (!id) return null
    return (await db.exercises.get(id)) ?? null
  }, [id])

  // Form state.
  const [name, setName] = useState('')
  const [equipmentText, setEquipmentText] = useState('')
  const [muscleGroupsText, setMuscleGroupsText] = useState('')
  const [movementType, setMovementType] = useState<MovementType | ''>('')
  const [isUnilateral, setIsUnilateral] = useState(false)
  const [starred, setStarred] = useState(false)
  const [notes, setNotes] = useState('')
  const [seeded, setSeeded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Seed from existing once on first load. Skip on /new.
  useEffect(() => {
    if (seeded) return
    if (!isEdit) {
      setSeeded(true)
      return
    }
    if (existing === undefined) return
    if (existing === null) {
      // Editing a missing id — bail out to list.
      navigate('/exercises', { replace: true })
      return
    }
    setName(existing.name)
    setEquipmentText(csvFromArray(parseJsonArray(existing.equipment) as string[]))
    setMuscleGroupsText(csvFromArray(parseJsonArray(existing.muscle_groups) as string[]))
    setMovementType(existing.movement_type ?? '')
    setIsUnilateral(existing.is_unilateral === 1)
    setStarred(existing.starred === 1)
    setNotes(existing.notes ?? '')
    setSeeded(true)
  }, [isEdit, existing, seeded, navigate])

  const usageCount = useExerciseUsageCount(isEdit ? id : undefined)

  const trimmedName = name.trim()
  const canSave = trimmedName.length > 0

  const onSave = async () => {
    if (!canSave) {
      setError('Name is required.')
      return
    }
    const now = Date.now()
    const equipment = arrayFromCsv(equipmentText)
    const muscleGroups = arrayFromCsv(muscleGroupsText)
    const movement: MovementType | null = movementType === '' ? null : movementType

    const row: ExerciseRow = {
      id: isEdit && existing ? existing.id : asExerciseId(genId('ex')),
      name: trimmedName,
      equipment: JSON.stringify(equipment),
      muscle_groups: JSON.stringify(muscleGroups),
      movement_type: movement,
      is_unilateral: isUnilateral ? 1 : 0,
      starred: starred ? 1 : 0,
      notes: notes.trim().length === 0 ? null : notes,
      created_at: isEdit && existing ? existing.created_at : now,
      updated_at: now,
    }

    await db.exercises.put(row)
    navigate('/exercises')
  }

  const onDelete = async () => {
    if (!isEdit || !existing) return
    if (usageCount !== undefined && usageCount > 0) return // safety: button is disabled in this state
    const ok = window.confirm(`Delete "${existing.name}"? This can't be undone.`)
    if (!ok) return
    await db.exercises.delete(existing.id)
    navigate('/exercises')
  }

  const eyebrow = isEdit ? 'EDIT EXERCISE' : 'NEW EXERCISE'
  const usageBlocked = isEdit && usageCount !== undefined && usageCount > 0
  const deleteHint = useMemo(() => {
    if (!isEdit) return null
    if (usageCount === undefined) return null
    if (usageCount === 0) return null
    const noun = usageCount === 1 ? 'workout' : 'workouts'
    return `Used in ${usageCount} ${noun}; remove from those workouts via Coach Claude first.`
  }, [isEdit, usageCount])

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.navBtn}
          onClick={() => navigate('/exercises')}
          aria-label="Back to exercises"
        >
          ← EXERCISES
        </button>
        <div className={styles.eyebrow}>{eyebrow}</div>
        <div />
      </header>

      <div className={styles.formGroup}>
        <label className={styles.label} htmlFor="ex-name">
          Name
        </label>
        <input
          id="ex-name"
          className={styles.input}
          type="text"
          inputMode="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (error) setError(null)
          }}
          placeholder="Back Squat"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label} htmlFor="ex-equipment">
          Equipment
        </label>
        <input
          id="ex-equipment"
          className={styles.input}
          type="text"
          inputMode="text"
          value={equipmentText}
          onChange={(e) => setEquipmentText(e.target.value)}
          placeholder="barbell, rack"
        />
        <div className={styles.hint}>Comma-separated.</div>
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label} htmlFor="ex-mg">
          Muscle groups
        </label>
        <input
          id="ex-mg"
          className={styles.input}
          type="text"
          inputMode="text"
          value={muscleGroupsText}
          onChange={(e) => setMuscleGroupsText(e.target.value)}
          placeholder="quads, glutes, core"
        />
        <div className={styles.hint}>Comma-separated.</div>
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label} htmlFor="ex-mt">
          Movement type
        </label>
        <select
          id="ex-mt"
          className={styles.select}
          value={movementType}
          onChange={(e) => setMovementType(e.target.value as MovementType | '')}
        >
          <option value="">—</option>
          {MOVEMENT_TYPES.map((mt) => (
            <option key={mt} value={mt}>
              {mt}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.toggleRow}>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={isUnilateral}
            onChange={(e) => setIsUnilateral(e.target.checked)}
          />
          <span>Unilateral</span>
        </label>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={starred}
            onChange={(e) => setStarred(e.target.checked)}
          />
          <span>★ Starred</span>
        </label>
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label} htmlFor="ex-notes">
          Notes
        </label>
        <textarea
          id="ex-notes"
          className={styles.textarea}
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Cues, form notes…"
        />
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.saveRow}>
        <Button variant="primary" block onClick={onSave} disabled={!canSave}>
          {isEdit ? 'Save' : 'Create'}
        </Button>
      </div>

      {isEdit && (
        <div className={styles.dangerZone}>
          <div className={styles.dangerEyebrow}>Danger zone</div>
          <Button
            variant="danger"
            block
            disabled={usageBlocked}
            onClick={onDelete}
          >
            Delete exercise
          </Button>
          {deleteHint && <div className={styles.dangerHint}>{deleteHint}</div>}
        </div>
      )}
    </div>
  )
}
