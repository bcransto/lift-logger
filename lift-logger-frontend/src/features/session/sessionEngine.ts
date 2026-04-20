// Pure cursor advancement over a WorkoutSnapshot.
//
// Execution order for each block kind:
//   single            → slot1: set1, set2, set3...
//   pyramid           → same as single (type tag only affects UI)
//   superset/circuit  → round-major: (slot1 sets..., slot2 sets..., ...) × rounds
//
// Cursor fields are 1-indexed to match DB columns.

import type { Cursor, CursorWithTarget, SnapshotBlock, WorkoutSnapshot } from '../../types/schema'

/** Walk every planned set in the order the app will execute them. */
export function* iterateSets(snapshot: WorkoutSnapshot): Generator<CursorWithTarget> {
  for (const block of snapshot.blocks) {
    const rounds = block.kind === 'single' ? 1 : block.rounds
    for (let r = 1; r <= rounds; r++) {
      for (const be of block.exercises) {
        for (const t of be.sets) {
          yield {
            cursor: {
              blockPosition: block.position,
              blockExercisePosition: be.position,
              roundNumber: r,
              setNumber: t.set_number,
            },
            block,
            blockExercise: be,
            target: t,
          }
        }
      }
    }
  }
}

/** Find the cursor one step after the given cursor. Returns null when done. */
export function advance(snapshot: WorkoutSnapshot, cursor: Cursor): Cursor | null {
  const it = iterateSets(snapshot)
  let seen = false
  for (const entry of it) {
    if (seen) return entry.cursor
    if (cursorsEqual(entry.cursor, cursor)) seen = true
  }
  return null
}

/** Resolve the target + context for a cursor. Returns null if cursor is stale. */
export function targetAt(snapshot: WorkoutSnapshot, cursor: Cursor): CursorWithTarget | null {
  for (const entry of iterateSets(snapshot)) {
    if (cursorsEqual(entry.cursor, cursor)) return entry
  }
  return null
}

/** The very first cursor to land on when starting a workout. */
export function firstCursor(snapshot: WorkoutSnapshot): Cursor | null {
  const first = iterateSets(snapshot).next()
  if (first.done) return null
  return first.value.cursor
}

export function cursorsEqual(a: Cursor, b: Cursor): boolean {
  return (
    a.blockPosition === b.blockPosition &&
    a.blockExercisePosition === b.blockExercisePosition &&
    a.roundNumber === b.roundNumber &&
    a.setNumber === b.setNumber
  )
}

export function cursorKey(c: Cursor): string {
  return `${c.blockPosition}.${c.blockExercisePosition}.${c.roundNumber}.${c.setNumber}`
}

export function parseSetKey(setKey: string): { blockExercisePosition: number; roundNumber: number; setNumber: number } | null {
  const parts = setKey.split('.').map((n) => Number.parseInt(n, 10))
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null
  const [be, round, set] = parts as [number, number, number]
  return { blockExercisePosition: be, roundNumber: round, setNumber: set }
}

/** Total sets across the whole workout. */
export function totalSetCount(snapshot: WorkoutSnapshot): number {
  let n = 0
  for (const _entry of iterateSets(snapshot)) n++
  return n
}

/** True if `cursor` falls into the first set of a new block (used to trigger Transition). */
export function isNewBlock(snapshot: WorkoutSnapshot, cursor: Cursor): boolean {
  return cursor.blockExercisePosition === 1 && cursor.roundNumber === 1 && cursor.setNumber === firstSetOfBlock(snapshot, cursor.blockPosition)
}

function firstSetOfBlock(snapshot: WorkoutSnapshot, blockPosition: number): number {
  const b = snapshot.blocks.find((x) => x.position === blockPosition)
  if (!b) return 1
  const be = b.exercises.find((x) => x.position === 1)
  if (!be) return 1
  return be.sets[0]?.set_number ?? 1
}

/** Count of planned sets for a single block_exercise across all rounds. */
export function setsPerBlockExercise(block: SnapshotBlock, blockExercisePosition: number): number {
  const be = block.exercises.find((x) => x.position === blockExercisePosition)
  if (!be) return 0
  const rounds = block.kind === 'single' ? 1 : block.rounds
  return be.sets.length * rounds
}
