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

/**
 * Find the cursor one step after the given cursor, skipping any block whose
 * id is in `skippedBlockIds`. If cursor itself is inside a skipped block
 * (user returned then something auto-advanced past them), return the first
 * entry beyond that block. Returns null when done.
 */
export function advance(
  snapshot: WorkoutSnapshot,
  cursor: Cursor,
  skippedBlockIds: ReadonlySet<string> = EMPTY_SET,
): Cursor | null {
  let seen = false
  let cursorBlockSkipped = false
  for (const entry of iterateSets(snapshot)) {
    if (skippedBlockIds.has(entry.block.id)) {
      // If the iterator is inside a skipped block while "seen" was set, keep stepping.
      if (cursorsEqual(entry.cursor, cursor)) {
        seen = true
        cursorBlockSkipped = true
      }
      continue
    }
    if (seen) return entry.cursor
    if (cursorsEqual(entry.cursor, cursor)) seen = true
  }
  // If cursor was inside a skipped block and no later non-skipped entry exists.
  if (cursorBlockSkipped) return null
  return null
}

const EMPTY_SET: ReadonlySet<string> = new Set()

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

/** Same key format as cursorKey, built from a DB row's snake_case fields. */
export function cursorKeyFromRow(r: {
  block_position: number
  block_exercise_position: number
  round_number: number
  set_number: number
}): string {
  return `${r.block_position}.${r.block_exercise_position}.${r.round_number}.${r.set_number}`
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

/** True if `cursor` is the very first set of its block (used to trigger Transition). */
export function isNewBlock(snapshot: WorkoutSnapshot, cursor: Cursor): boolean {
  const first = firstCursorOfBlock(snapshot, cursor.blockPosition)
  return first !== null && cursorsEqual(first, cursor)
}

/**
 * Cursor of the first set in the first block-exercise of a block.
 * Correctly handles blocks whose first exercise isn't at position 1 (e.g. after
 * a template-level reorder) and sets that aren't numbered from 1.
 */
export function firstCursorOfBlock(
  snapshot: WorkoutSnapshot,
  blockPosition: number,
): Cursor | null {
  const b = snapshot.blocks.find((x) => x.position === blockPosition)
  if (!b || b.exercises.length === 0) return null
  const firstBePosition = Math.min(...b.exercises.map((e) => e.position))
  const be = b.exercises.find((e) => e.position === firstBePosition)!
  if (be.sets.length === 0) return null
  const firstSetNumber = Math.min(...be.sets.map((s) => s.set_number))
  return {
    blockPosition: b.position,
    blockExercisePosition: firstBePosition,
    roundNumber: 1,
    setNumber: firstSetNumber,
  }
}

/** First unlogged cursor inside a block, skipping sets that are already in `loggedKeys`. */
export function firstUnloggedCursorInBlock(
  snapshot: WorkoutSnapshot,
  blockPosition: number,
  loggedKeys: ReadonlySet<string>,
): Cursor | null {
  for (const entry of iterateSets(snapshot)) {
    if (entry.cursor.blockPosition !== blockPosition) continue
    if (!loggedKeys.has(cursorKey(entry.cursor))) return entry.cursor
  }
  return null
}

/** Count of planned sets for a single block_exercise across all rounds. */
export function setsPerBlockExercise(block: SnapshotBlock, blockExercisePosition: number): number {
  const be = block.exercises.find((x) => x.position === blockExercisePosition)
  if (!be) return 0
  const rounds = block.kind === 'single' ? 1 : block.rounds
  return be.sets.length * rounds
}

/**
 * Walk all cursors in a single block in execution (round-major) order.
 * Used by Set view's up/down navigation — scoped to the block so the user
 * can page through superset / circuit sets as they'll actually be performed.
 */
export function iterateBlockCursors(
  snapshot: WorkoutSnapshot,
  blockPosition: number,
): Cursor[] {
  const b = snapshot.blocks.find((x) => x.position === blockPosition)
  if (!b) return []
  const rounds = b.kind === 'single' ? 1 : b.rounds
  const bes = b.exercises.slice().sort((a, b) => a.position - b.position)
  const out: Cursor[] = []
  for (let r = 1; r <= rounds; r++) {
    for (const be of bes) {
      for (const s of be.sets) {
        out.push({
          blockPosition: b.position,
          blockExercisePosition: be.position,
          roundNumber: r,
          setNumber: s.set_number,
        })
      }
    }
  }
  return out
}

/** Previous cursor within the same block (round-major). Null at the block's first set. */
export function prevCursorInBlock(snapshot: WorkoutSnapshot, cursor: Cursor): Cursor | null {
  const all = iterateBlockCursors(snapshot, cursor.blockPosition)
  const idx = all.findIndex((c) => cursorsEqual(c, cursor))
  return idx > 0 ? all[idx - 1]! : null
}

/** Next cursor within the same block (round-major). Null at the block's last set. */
export function nextCursorInBlock(snapshot: WorkoutSnapshot, cursor: Cursor): Cursor | null {
  const all = iterateBlockCursors(snapshot, cursor.blockPosition)
  const idx = all.findIndex((c) => cursorsEqual(c, cursor))
  return idx >= 0 && idx < all.length - 1 ? all[idx + 1]! : null
}

/** True if `cursor` is the final set of its block (last round, last BE, last set). */
export function isLastSetOfBlock(snapshot: WorkoutSnapshot, cursor: Cursor): boolean {
  const all = iterateBlockCursors(snapshot, cursor.blockPosition)
  const last = all[all.length - 1]
  return last ? cursorsEqual(last, cursor) : false
}
