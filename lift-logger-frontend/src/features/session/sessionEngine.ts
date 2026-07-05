// Pure cursor advancement over a WorkoutSnapshot.
//
// Execution order for each block kind:
//   single            → slot1: set1, set2, set3...
//   pyramid           → same as single (type tag only affects UI)
//   superset/circuit  → round-major: (slot1 sets..., slot2 sets..., ...) × rounds
//
// Cursor fields are 1-indexed to match DB columns.

import type { Cursor, CursorWithTarget, SnapshotBlock, SnapshotBlockExercise, SnapshotSetTarget, WorkoutSnapshot } from '../../types/schema'

/** Walk every planned set in the order the app will execute them. */
export function* iterateSets(snapshot: WorkoutSnapshot): Generator<CursorWithTarget> {
  for (const block of snapshot.blocks) {
    const rounds = block.kind === 'single' ? 1 : block.rounds
    for (let r = 1; r <= rounds; r++) {
      for (const be of block.exercises) {
        for (const t of setsForRound(be, r)) {
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
 * Return the targets that execute in round `r` for a given BE, with implicit
 * inheritance — if the snapshot has no round-`r` entries, fall back to the
 * round-1 anchors (re-tagged to round r). Handles:
 *   - Pre-v3 session snapshots (no round_number field at all → treated as 1).
 *   - Newly authored supersets without explicit per-round overrides.
 *   - `block.rounds` bumped past the highest override round.
 *
 * The target's `round_number` is rewritten to `r` so downstream consumers can
 * trust it for keying and display.
 */
export function setsForRound(be: SnapshotBlockExercise, r: number): SnapshotSetTarget[] {
  const own = be.sets.filter((s) => (s.round_number ?? 1) === r)
  if (own.length > 0) return own
  if (r === 1) return []
  const anchors = be.sets.filter((s) => (s.round_number ?? 1) === 1)
  return anchors.map((s) => ({ ...s, round_number: r }))
}

/**
 * Find the cursor one step after the given cursor, skipping any block whose
 * id is in `skippedBlockIds` AND any set whose key is in `loggedSetKeys`.
 * If cursor itself is inside a skipped block (user returned then something
 * auto-advanced past them), return the first entry beyond that block.
 * Returns null when done.
 *
 * `loggedSetKeys` lets the caller skip past sets that have already been
 * logged-with-actuals, so the cursor lands on the next set the user actually
 * has work left in (logged sets are "done"; skipped sets are valid landing
 * spots — user can revisit them).
 */
export function advance(
  snapshot: WorkoutSnapshot,
  cursor: Cursor,
  skippedBlockIds: ReadonlySet<string> = EMPTY_SET,
  loggedSetKeys: ReadonlySet<string> = EMPTY_SET,
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
    if (seen) {
      if (loggedSetKeys.has(cursorKey(entry.cursor))) continue
      return entry.cursor
    }
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

/**
 * Compare two cursors by iteration order in this snapshot. Returns:
 *   -1  if `a` comes before `b`
 *    0  if same cursor (or either isn't found)
 *   +1  if `a` comes after `b`
 *
 * Used by the tap-focus Start flow to decide forward vs backward direction.
 */
export function compareCursors(snapshot: WorkoutSnapshot, a: Cursor, b: Cursor): -1 | 0 | 1 {
  if (cursorsEqual(a, b)) return 0
  for (const entry of iterateSets(snapshot)) {
    if (cursorsEqual(entry.cursor, a)) return -1
    if (cursorsEqual(entry.cursor, b)) return 1
  }
  return 0
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
  // The round-1 slice of be.sets defines the set_number list for the block.
  // Higher-round entries are overrides that share the same set_numbers.
  const round1Sets = be.sets.filter((s) => (s.round_number ?? 1) === 1)
  if (round1Sets.length === 0) return null
  const firstSetNumber = Math.min(...round1Sets.map((s) => s.set_number))
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
  // Round 1 defines the set_number list; higher-round entries are per-round
  // overrides that share the same set_numbers. Count only round-1 to get
  // "sets per round", then multiply by total rounds.
  const setsPerRound = be.sets.filter((s) => (s.round_number ?? 1) === 1).length
  return setsPerRound * rounds
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
      for (const s of setsForRound(be, r)) {
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

// ─── mid-session block reorder (issue #21) ────────────────────────────
//
// CORRECTNESS CRUX: the engine reads execution order from `snapshot.blocks[]`
// ARRAY order, but cursors / session_sets / firstCursorOfBlock / targetAt key
// off each block's `position` FIELD. To move a block we must keep both in sync:
// swap the two blocks' array slots AND swap their `position` values. After the
// swap, walking the array still yields blocks whose `position` ascends with
// array index, so every consumer agrees.
//
// Only PENDING blocks move. A block is fixed if it has any session_sets row
// (logged OR skipped), is skipped/done, OR is strictly behind the cursor.
// The cursor's OWN block is reorderable while untouched (issue #26 — starting
// a workout parks the cursor on block 1 before anything is logged, and that
// must not lock it): the cursor is derived from logged rows everywhere it
// matters (cursorFromLogged), so after a swap it simply re-derives to the
// first unaccounted set in the new order.
// Adjacent-swap only: the arrows skip over fixed anchors rather than leaping
// them, so a pending block can only trade places with its nearest *pending*
// neighbour.

/**
 * Swap the block at `blockIndex` with the block at `targetIndex` in array
 * order, then exchange their `position` fields so array-order and position
 * stay aligned. Pure — returns a new snapshot; never mutates the input.
 * Returns the snapshot unchanged if either index is out of range or equal.
 */
export function swapBlocksByIndex(
  snapshot: WorkoutSnapshot,
  blockIndex: number,
  targetIndex: number,
): WorkoutSnapshot {
  const n = snapshot.blocks.length
  if (
    blockIndex === targetIndex ||
    blockIndex < 0 ||
    targetIndex < 0 ||
    blockIndex >= n ||
    targetIndex >= n
  ) {
    return snapshot
  }
  const blocks = snapshot.blocks.slice()
  const a = blocks[blockIndex]!
  const b = blocks[targetIndex]!
  // Exchange array slots AND position fields so the moved blocks keep
  // position === their new neighbours' order. Every other block's position is
  // untouched, so all existing session_sets rows stay valid (only pending
  // blocks — no rows — move; the cursor re-derives from rows after the swap).
  blocks[targetIndex] = { ...a, position: b.position }
  blocks[blockIndex] = { ...b, position: a.position }
  return { ...snapshot, blocks }
}

/**
 * Compute the set of block ids that are FIXED for reorder purposes — i.e. the
 * complement of "pending". A block is reorderable (pending) iff ALL hold:
 *   - it has no session_sets rows at all (`blockIdsWithRows` excludes it),
 *   - it is AT or AFTER the cursor's block in array order,
 *   - it is not skipped and not done.
 * Everything failing any of those is fixed. Blocks strictly before the cursor
 * are always fixed (logged rows must not move). The cursor's own block is
 * reorderable while it has no rows (issue #26) — safe because the cursor is
 * re-derived from logged rows after every swap, not carried across it.
 * When there is no cursor (workout fully accounted for) nothing is pending, so
 * every block is fixed. Single source of truth shared by the store action and
 * the OverviewScreen UI so their notions of "pending" can't drift.
 */
export function fixedBlockIdsForReorder(
  snapshot: WorkoutSnapshot,
  cursor: Cursor | null,
  blockIdsWithRows: ReadonlySet<string>,
  skippedBlockIds: ReadonlySet<string>,
  doneBlockIds: ReadonlySet<string>,
): Set<string> {
  const fixed = new Set<string>()
  const cursorIndex = cursor
    ? snapshot.blocks.findIndex((b) => b.position === cursor.blockPosition)
    : -1
  snapshot.blocks.forEach((b, i) => {
    const atOrAheadOfCursor = cursor != null && cursorIndex >= 0 && i >= cursorIndex
    const pending =
      atOrAheadOfCursor &&
      !blockIdsWithRows.has(b.id) &&
      !skippedBlockIds.has(b.id) &&
      !doneBlockIds.has(b.id)
    if (!pending) fixed.add(b.id)
  })
  return fixed
}

/**
 * Find the array index of the nearest reorderable neighbour to `fromIndex` in
 * the given direction, skipping over fixed anchors. `fixedBlockIds` is the set
 * of block ids that may NOT move (blocks with rows, blocks behind the cursor,
 * skipped / done blocks). Returns null if `fromIndex` is itself fixed, out of range, or
 * there is no reorderable block on that side. This is the single source of
 * truth for both the store's swap and the UI's arrow-enable state.
 */
export function nextReorderableIndex(
  snapshot: WorkoutSnapshot,
  fromIndex: number,
  direction: 'up' | 'down',
  fixedBlockIds: ReadonlySet<string>,
): number | null {
  const blocks = snapshot.blocks
  if (fromIndex < 0 || fromIndex >= blocks.length) return null
  const from = blocks[fromIndex]!
  if (fixedBlockIds.has(from.id)) return null
  const step = direction === 'up' ? -1 : 1
  for (let i = fromIndex + step; i >= 0 && i < blocks.length; i += step) {
    if (fixedBlockIds.has(blocks[i]!.id)) return null // hit a fixed anchor — don't leap it
    return i // first non-fixed neighbour
  }
  return null // edge of list
}
