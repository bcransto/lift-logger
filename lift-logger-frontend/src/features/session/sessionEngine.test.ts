import { describe, expect, it } from 'vitest'
import type { SnapshotBlock, WorkoutSnapshot } from '../../types/schema'
import type { BlockExerciseId, ExerciseId, WorkoutBlockId, WorkoutId } from '../../types/ids'
import {
  advance,
  cursorKey,
  cursorsEqual,
  firstCursor,
  firstCursorOfBlock,
  firstUnloggedCursorInBlock,
  fixedBlockIdsForReorder,
  isNewBlock,
  iterateSets,
  nextReorderableIndex,
  swapBlocksByIndex,
  targetAt,
  totalSetCount,
} from './sessionEngine'

// ─── fixtures ─────────────────────────────────────────────────────────

const wid = 'w1' as WorkoutId

function mkBlock(overrides: Partial<SnapshotBlock>): SnapshotBlock {
  return {
    id: ('b' + Math.random()) as WorkoutBlockId,
    position: 1,
    kind: 'single',
    rounds: 1,
    rest_after_sec: null,
    setup_cue: null,
    exercises: [],
    ...overrides,
  }
}

function straightPyramid(): WorkoutSnapshot {
  return {
    workout_id: wid,
    name: 'Pyramid',
    snapshot_at: 0,
    blocks: [
      mkBlock({
        id: 'b1' as WorkoutBlockId,
        position: 1,
        kind: 'single',
        rounds: 1,
        exercises: [
          {
            id: 'be1' as BlockExerciseId,
            exercise_id: 'ex1' as ExerciseId,
            name: 'Squat',
            position: 1,
            alt_exercise_ids: [],
            sets: [
              { set_number: 1, target_weight: 135, target_reps: 12 },
              { set_number: 2, target_weight: 155, target_reps: 10 },
              { set_number: 3, target_weight: 175, target_reps: 8 },
              { set_number: 4, target_weight: 185, target_reps: 6, is_peak: true },
            ],
          },
        ],
      }),
    ],
  }
}

function superset2x3(): WorkoutSnapshot {
  return {
    workout_id: wid,
    name: 'Super',
    snapshot_at: 0,
    blocks: [
      mkBlock({
        id: 'b1' as WorkoutBlockId,
        position: 1,
        kind: 'superset',
        rounds: 3,
        exercises: [
          {
            id: 'beA' as BlockExerciseId,
            exercise_id: 'exA' as ExerciseId,
            name: 'Curl',
            position: 1,
            alt_exercise_ids: [],
            sets: [{ set_number: 1, target_weight: 30, target_reps: 12 }],
          },
          {
            id: 'beB' as BlockExerciseId,
            exercise_id: 'exB' as ExerciseId,
            name: 'Tricep',
            position: 2,
            alt_exercise_ids: [],
            sets: [{ set_number: 1, target_weight: 40, target_reps: 12 }],
          },
        ],
      }),
    ],
  }
}

function multiBlock(): WorkoutSnapshot {
  return {
    workout_id: wid,
    name: 'Combo',
    snapshot_at: 0,
    blocks: [
      mkBlock({
        id: 'b1' as WorkoutBlockId,
        position: 1,
        kind: 'single',
        exercises: [
          {
            id: 'be1' as BlockExerciseId,
            exercise_id: 'ex1' as ExerciseId,
            name: 'A',
            position: 1,
            alt_exercise_ids: [],
            sets: [
              { set_number: 1, target_weight: 100, target_reps: 5 },
              { set_number: 2, target_weight: 100, target_reps: 5 },
            ],
          },
        ],
      }),
      mkBlock({
        id: 'b2' as WorkoutBlockId,
        position: 2,
        kind: 'circuit',
        rounds: 2,
        exercises: [
          {
            id: 'be2' as BlockExerciseId,
            exercise_id: 'ex2' as ExerciseId,
            name: 'HIIT A',
            position: 1,
            alt_exercise_ids: [],
            sets: [{ set_number: 1, target_duration_sec: 40 }],
          },
          {
            id: 'be3' as BlockExerciseId,
            exercise_id: 'ex3' as ExerciseId,
            name: 'HIIT B',
            position: 2,
            alt_exercise_ids: [],
            sets: [{ set_number: 1, target_duration_sec: 40 }],
          },
        ],
      }),
    ],
  }
}

// ─── tests ────────────────────────────────────────────────────────────

describe('sessionEngine — pyramid (straight)', () => {
  const s = straightPyramid()

  it('iterates 4 sets in order', () => {
    const cursors = [...iterateSets(s)].map((e) => cursorKey(e.cursor))
    expect(cursors).toEqual(['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4'])
  })

  it('first cursor is set 1', () => {
    expect(firstCursor(s)).toEqual({ blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 })
  })

  it('advance walks through all sets then returns null', () => {
    let c = firstCursor(s)!
    const visited = [cursorKey(c)]
    while (true) {
      const next = advance(s, c)
      if (!next) break
      c = next
      visited.push(cursorKey(c))
    }
    expect(visited).toEqual(['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4'])
  })

  it('targetAt returns the pyramid target', () => {
    const t = targetAt(s, { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 3 })
    expect(t?.target.target_weight).toBe(175)
    expect(t?.target.target_reps).toBe(8)
  })

  it('totalSetCount === 4', () => {
    expect(totalSetCount(s)).toBe(4)
  })
})

describe('sessionEngine — superset 2×3 (round-major)', () => {
  const s = superset2x3()

  it('iterates in round-major order: A1 B1 A1 B1 A1 B1', () => {
    const cursors = [...iterateSets(s)].map((e) => cursorKey(e.cursor))
    expect(cursors).toEqual(['1.1.1.1', '1.2.1.1', '1.1.2.1', '1.2.2.1', '1.1.3.1', '1.2.3.1'])
  })

  it('totalSetCount === 6', () => {
    expect(totalSetCount(s)).toBe(6)
  })

  it('advance from A round-1 goes to B round-1', () => {
    const from = { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }
    expect(advance(s, from)).toEqual({ blockPosition: 1, blockExercisePosition: 2, roundNumber: 1, setNumber: 1 })
  })

  it('advance from B round-1 goes to A round-2', () => {
    const from = { blockPosition: 1, blockExercisePosition: 2, roundNumber: 1, setNumber: 1 }
    expect(advance(s, from)).toEqual({ blockPosition: 1, blockExercisePosition: 1, roundNumber: 2, setNumber: 1 })
  })
})

describe('sessionEngine — multi-block (single → circuit)', () => {
  const s = multiBlock()

  it('walks all 6 sets across blocks', () => {
    const cursors = [...iterateSets(s)].map((e) => cursorKey(e.cursor))
    expect(cursors).toEqual([
      '1.1.1.1',
      '1.1.1.2',
      '2.1.1.1',
      '2.2.1.1',
      '2.1.2.1',
      '2.2.2.1',
    ])
  })
})

describe('sessionEngine — utilities', () => {
  it('cursorsEqual detects mismatches', () => {
    const a = { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }
    const b = { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 2 }
    expect(cursorsEqual(a, a)).toBe(true)
    expect(cursorsEqual(a, b)).toBe(false)
  })
})

// ─── Phase 2 additions ───────────────────────────────────────────────

describe('sessionEngine — skip-aware advance', () => {
  const s = multiBlock() // 3 blocks: single (2 sets), circuit rounds=2 (2×1)
  // Block IDs from fixture: 'b1' (single), 'b2' (circuit)
  const BP1_BE1_R1_S1 = { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }
  const BP1_BE1_R1_S2 = { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 2 }
  const BP2_BE1_R1_S1 = { blockPosition: 2, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }

  it('skipping the first block jumps advance straight to block 2', () => {
    const skipped = new Set(['b1'])
    expect(advance(s, BP1_BE1_R1_S1, skipped)).toEqual(BP2_BE1_R1_S1)
  })

  it('cursor inside a skipped block — advance still exits that block', () => {
    const skipped = new Set(['b1'])
    expect(advance(s, BP1_BE1_R1_S2, skipped)).toEqual(BP2_BE1_R1_S1)
  })

  it('skipping the last block from last-non-skipped set returns null', () => {
    const skipped = new Set(['b2'])
    expect(advance(s, BP1_BE1_R1_S2, skipped)).toBeNull()
  })

  it('skipping all blocks returns null from anywhere', () => {
    const skipped = new Set(['b1', 'b2'])
    expect(advance(s, BP1_BE1_R1_S1, skipped)).toBeNull()
  })

  it('default empty skipped set preserves original linear behavior', () => {
    expect(advance(s, BP1_BE1_R1_S1)).toEqual(BP1_BE1_R1_S2)
  })

  // ─── #5a: loggedSetKeys lets advance skip past completed sets ──────
  it('advance skips past sets in loggedSetKeys, landing on the next non-completed', () => {
    // Cursor on block 1 set 1; if set 2 is logged, advance should skip past
    // it and land on block 2's first cursor.
    const logged = new Set(['1.1.1.2'])  // cursorKey for BP1_BE1_R1_S2
    expect(advance(s, BP1_BE1_R1_S1, new Set(), logged)).toEqual(BP2_BE1_R1_S1)
  })

  it('advance with no loggedSetKeys preserves linear behavior', () => {
    expect(advance(s, BP1_BE1_R1_S1, new Set(), new Set())).toEqual(BP1_BE1_R1_S2)
  })

  it('advance still skips skipped blocks even when loggedSetKeys is provided', () => {
    const skipped = new Set(['b1'])
    const logged = new Set(['1.1.1.2'])
    expect(advance(s, BP1_BE1_R1_S1, skipped, logged)).toEqual(BP2_BE1_R1_S1)
  })
})

describe('sessionEngine — firstCursorOfBlock (fixed to not hardcode position=1)', () => {
  it('returns the first set-number of the first block_exercise, not hardcoded to 1', () => {
    const snapshot: WorkoutSnapshot = {
      workout_id: wid,
      name: 'Non-1 positions',
      snapshot_at: 0,
      blocks: [
        mkBlock({
          id: 'b1' as WorkoutBlockId,
          position: 1,
          kind: 'single',
          exercises: [
            {
              id: 'be' as BlockExerciseId,
              exercise_id: 'ex' as ExerciseId,
              name: 'x',
              position: 3, // not 1
              alt_exercise_ids: [],
              sets: [
                { set_number: 7, target_weight: 100, target_reps: 5 }, // not 1
                { set_number: 8, target_weight: 105, target_reps: 5 },
              ],
            },
          ],
        }),
      ],
    }
    expect(firstCursorOfBlock(snapshot, 1)).toEqual({
      blockPosition: 1,
      blockExercisePosition: 3,
      roundNumber: 1,
      setNumber: 7,
    })
  })

  it('returns null for unknown block position', () => {
    expect(firstCursorOfBlock(straightPyramid(), 999)).toBeNull()
  })

  it('isNewBlock uses firstCursorOfBlock — true at start, false mid-block', () => {
    const s = straightPyramid()
    expect(isNewBlock(s, { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }))
      .toBe(true)
    expect(isNewBlock(s, { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 3 }))
      .toBe(false)
  })

  it('isNewBlock is true for the first cursor of every block in a multi-block snapshot', () => {
    const s = multiBlock() // block 1 (single, 2 sets), block 2 (circuit, 2 rounds × 2 BEs)
    // First cursor of block 1
    expect(isNewBlock(s, { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }))
      .toBe(true)
    // First cursor of block 2 (round-major → round 1, BE 1)
    expect(isNewBlock(s, { blockPosition: 2, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }))
      .toBe(true)
    // Mid-block 1 (last set of single) — not new
    expect(isNewBlock(s, { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 2 }))
      .toBe(false)
    // Block 2, round 2 start — same block, different round — not new
    expect(isNewBlock(s, { blockPosition: 2, blockExercisePosition: 1, roundNumber: 2, setNumber: 1 }))
      .toBe(false)
    // Block 2, BE 2 — not the first BE — not new
    expect(isNewBlock(s, { blockPosition: 2, blockExercisePosition: 2, roundNumber: 1, setNumber: 1 }))
      .toBe(false)
  })
})

describe('sessionEngine — firstUnloggedCursorInBlock', () => {
  const s = straightPyramid() // block 1: 4 sets
  it('first set when nothing is logged', () => {
    expect(firstUnloggedCursorInBlock(s, 1, new Set())).toEqual({
      blockPosition: 1,
      blockExercisePosition: 1,
      roundNumber: 1,
      setNumber: 1,
    })
  })

  it('skips already-logged sets', () => {
    const logged = new Set(['1.1.1.1', '1.1.1.2'])
    expect(firstUnloggedCursorInBlock(s, 1, logged)).toEqual({
      blockPosition: 1,
      blockExercisePosition: 1,
      roundNumber: 1,
      setNumber: 3,
    })
  })

  it('returns null when all sets in the block are logged', () => {
    const logged = new Set(['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4'])
    expect(firstUnloggedCursorInBlock(s, 1, logged)).toBeNull()
  })
})

// ─── v3: per-round target overrides ──────────────────────────────────

/**
 * Progressive superset: 2 BEs (Curl, Tricep) × 3 rounds. Round 1 is the
 * anchor; round 2 and 3 carry explicit override rows with different weights
 * and reps. Represents the output of `buildWorkoutSnapshot` after round
 * expansion.
 */
function progressiveSuperset(): WorkoutSnapshot {
  return {
    workout_id: wid,
    name: 'Progressive',
    snapshot_at: 0,
    blocks: [
      mkBlock({
        id: 'b1' as WorkoutBlockId,
        position: 1,
        kind: 'superset',
        rounds: 3,
        exercises: [
          {
            id: 'beA' as BlockExerciseId,
            exercise_id: 'exA' as ExerciseId,
            name: 'Curl',
            position: 1,
            alt_exercise_ids: [],
            sets: [
              { set_number: 1, round_number: 1, target_weight: 30, target_reps: 12 },
              { set_number: 1, round_number: 2, target_weight: 35, target_reps: 10 },
              { set_number: 1, round_number: 3, target_weight: 40, target_reps: 8 },
            ],
          },
          {
            id: 'beB' as BlockExerciseId,
            exercise_id: 'exB' as ExerciseId,
            name: 'Tricep',
            position: 2,
            alt_exercise_ids: [],
            sets: [
              { set_number: 1, round_number: 1, target_weight: 40, target_reps: 12 },
              { set_number: 1, round_number: 2, target_weight: 45, target_reps: 10 },
              { set_number: 1, round_number: 3, target_weight: 50, target_reps: 8 },
            ],
          },
        ],
      }),
    ],
  }
}

describe('sessionEngine — per-round overrides (v3)', () => {
  const s = progressiveSuperset()

  it('iterateSets walks round-major across explicit round-N entries', () => {
    const cursors = [...iterateSets(s)].map((e) => cursorKey(e.cursor))
    expect(cursors).toEqual([
      '1.1.1.1',
      '1.2.1.1',
      '1.1.2.1',
      '1.2.2.1',
      '1.1.3.1',
      '1.2.3.1',
    ])
  })

  it('targetAt returns the correct round-specific target', () => {
    const t1 = targetAt(s, { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 })
    expect(t1?.target.target_weight).toBe(30)
    expect(t1?.target.target_reps).toBe(12)
    const t2 = targetAt(s, { blockPosition: 1, blockExercisePosition: 1, roundNumber: 2, setNumber: 1 })
    expect(t2?.target.target_weight).toBe(35)
    expect(t2?.target.target_reps).toBe(10)
    const t3 = targetAt(s, { blockPosition: 1, blockExercisePosition: 1, roundNumber: 3, setNumber: 1 })
    expect(t3?.target.target_weight).toBe(40)
    expect(t3?.target.target_reps).toBe(8)
  })

  it('totalSetCount === 6', () => {
    expect(totalSetCount(s)).toBe(6)
  })

  it('firstCursorOfBlock lands on round 1 set 1', () => {
    expect(firstCursorOfBlock(s, 1)).toEqual({
      blockPosition: 1,
      blockExercisePosition: 1,
      roundNumber: 1,
      setNumber: 1,
    })
  })

  it('implicit inheritance: superset with only round-1 entries still walks every round', () => {
    // Pre-v3 shaped snapshot (or a post-v3 template with no overrides):
    // one round-1 entry per BE, but block.rounds=3. setsForRound replicates.
    const implicit: WorkoutSnapshot = {
      workout_id: wid,
      name: 'Implicit',
      snapshot_at: 0,
      blocks: [
        mkBlock({
          id: 'b1' as WorkoutBlockId,
          position: 1,
          kind: 'superset',
          rounds: 3,
          exercises: [
            {
              id: 'beA' as BlockExerciseId,
              exercise_id: 'exA' as ExerciseId,
              name: 'Curl',
              position: 1,
              alt_exercise_ids: [],
              sets: [{ set_number: 1, round_number: 1, target_weight: 30, target_reps: 12 }],
            },
          ],
        }),
      ],
    }
    const cursors = [...iterateSets(implicit)].map((e) => cursorKey(e.cursor))
    expect(cursors).toEqual(['1.1.1.1', '1.1.2.1', '1.1.3.1'])
    // Inherited target for round 2 reuses round-1 weight.
    const r2 = targetAt(implicit, { blockPosition: 1, blockExercisePosition: 1, roundNumber: 2, setNumber: 1 })
    expect(r2?.target.target_weight).toBe(30)
  })
})

// ─── issue #21: mid-session block reorder ─────────────────────────────

/**
 * Four single-kind blocks, one set each, positions 1..4 aligned with array
 * index. Lets us reason about reorder where array order and `position` must
 * stay consistent after a swap.
 */
function fourSingleBlocks(): WorkoutSnapshot {
  const mk = (n: number): SnapshotBlock =>
    mkBlock({
      id: ('blk' + n) as WorkoutBlockId,
      position: n,
      kind: 'single',
      exercises: [
        {
          id: ('be' + n) as BlockExerciseId,
          exercise_id: ('ex' + n) as ExerciseId,
          name: 'Lift ' + n,
          position: 1,
          alt_exercise_ids: [],
          sets: [{ set_number: 1, round_number: 1, target_weight: 100 + n, target_reps: 5 }],
        },
      ],
    })
  return {
    workout_id: wid,
    name: 'Four',
    snapshot_at: 0,
    blocks: [mk(1), mk(2), mk(3), mk(4)],
  }
}

describe('sessionEngine — swapBlocksByIndex (array order + position stay aligned)', () => {
  it('swaps two adjacent blocks AND their position fields', () => {
    const s = fourSingleBlocks()
    const next = swapBlocksByIndex(s, 2, 3) // swap blk3 ↔ blk4 (indices 2,3)
    // Array order: blk4 now precedes blk3.
    expect(next.blocks.map((b) => b.id)).toEqual(['blk1', 'blk2', 'blk4', 'blk3'])
    // Positions ascend with array index: each block's position == index+1.
    expect(next.blocks.map((b) => b.position)).toEqual([1, 2, 3, 4])
    // blk4 took position 3, blk3 took position 4.
    expect(next.blocks.find((b) => b.id === 'blk4')!.position).toBe(3)
    expect(next.blocks.find((b) => b.id === 'blk3')!.position).toBe(4)
  })

  it('is pure — input snapshot is not mutated', () => {
    const s = fourSingleBlocks()
    const before = s.blocks.map((b) => `${b.id}@${b.position}`)
    swapBlocksByIndex(s, 0, 1)
    expect(s.blocks.map((b) => `${b.id}@${b.position}`)).toEqual(before)
  })

  it('returns the same snapshot for out-of-range / equal indices', () => {
    const s = fourSingleBlocks()
    expect(swapBlocksByIndex(s, 1, 1)).toBe(s)
    expect(swapBlocksByIndex(s, -1, 2)).toBe(s)
    expect(swapBlocksByIndex(s, 0, 99)).toBe(s)
  })

  it('engine advances in the NEW order after a swap', () => {
    const s = fourSingleBlocks()
    // Swap blocks at index 1 and 2 (blk2 ↔ blk3).
    const next = swapBlocksByIndex(s, 1, 2)
    const cursors = [...iterateSets(next)].map((e) => cursorKey(e.cursor))
    // Execution now visits position 1, then position 2 (which is blk3's slot),
    // then position 3 (blk2's slot), then position 4.
    expect(cursors).toEqual(['1.1.1.1', '2.1.1.1', '3.1.1.1', '4.1.1.1'])
    // targetAt at position 2 now resolves to blk3's exercise (weight 103).
    const t = targetAt(next, { blockPosition: 2, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 })
    expect(t?.blockExercise.exercise_id).toBe('ex3')
    expect(t?.target.target_weight).toBe(103)
  })
})

describe('sessionEngine — fixedBlockIdsForReorder ("pending" = at/ahead of cursor, no rows, not skipped/done)', () => {
  const s = fourSingleBlocks() // blk1..blk4 at index/position 1..4
  const empty = new Set<string>()

  it('cursor on block 1, nothing logged: ALL blocks are pending (issue #26 — the untouched cursor block moves too)', () => {
    const cursor = { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }
    const fixed = fixedBlockIdsForReorder(s, cursor, empty, empty, empty)
    expect(fixed.size).toBe(0)
  })

  it('cursor block with rows is fixed (mid-block: some sets already logged)', () => {
    const cursor = { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }
    const fixed = fixedBlockIdsForReorder(s, cursor, new Set(['blk1']), empty, empty)
    expect(fixed.has('blk1')).toBe(true)
    expect(fixed.has('blk2')).toBe(false)
  })

  it('a block with logged rows is fixed even though it is ahead of the cursor', () => {
    const cursor = { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }
    const withRows = new Set(['blk3'])
    const fixed = fixedBlockIdsForReorder(s, cursor, withRows, empty, empty)
    expect(fixed.has('blk3')).toBe(true)
    expect(fixed.has('blk2')).toBe(false)
    expect(fixed.has('blk4')).toBe(false)
  })

  it('skipped and done blocks are fixed', () => {
    const cursor = { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }
    const fixed = fixedBlockIdsForReorder(s, cursor, empty, new Set(['blk2']), new Set(['blk4']))
    expect(fixed.has('blk2')).toBe(true) // skipped
    expect(fixed.has('blk4')).toBe(true) // done
    expect(fixed.has('blk3')).toBe(false) // still pending
  })

  it('blocks strictly before the cursor are fixed (cursor on block 3)', () => {
    const cursor = { blockPosition: 3, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }
    const fixed = fixedBlockIdsForReorder(s, cursor, empty, empty, empty)
    expect(fixed.has('blk1')).toBe(true)
    expect(fixed.has('blk2')).toBe(true)
    expect(fixed.has('blk3')).toBe(false) // cursor block, untouched → pending (issue #26)
    expect(fixed.has('blk4')).toBe(false) // ahead → pending
  })

  it('no cursor (workout fully accounted) → every block fixed', () => {
    const fixed = fixedBlockIdsForReorder(s, null, empty, empty, empty)
    expect([...fixed].sort()).toEqual(['blk1', 'blk2', 'blk3', 'blk4'])
  })
})

describe('sessionEngine — nextReorderableIndex (adjacent swap, no leaping anchors)', () => {
  const s = fourSingleBlocks()

  it('finds the immediate pending neighbour up/down', () => {
    // cursor on block 1 with rows in blk1 → blk2/3/4 pending, blk1 fixed.
    const fixed = fixedBlockIdsForReorder(
      s,
      { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 },
      new Set(['blk1']), new Set(), new Set(),
    )
    // blk3 (index 2): up → index 1 (blk2), down → index 3 (blk4).
    expect(nextReorderableIndex(s, 2, 'up', fixed)).toBe(1)
    expect(nextReorderableIndex(s, 2, 'down', fixed)).toBe(3)
    // blk2 (index 1): up → index 0 is blk1 which is FIXED (has rows) → null.
    expect(nextReorderableIndex(s, 1, 'up', fixed)).toBeNull()
    // blk4 (index 3): down → edge of list → null.
    expect(nextReorderableIndex(s, 3, 'down', fixed)).toBeNull()
  })

  it('untouched cursor block can trade with the block below it (issue #26)', () => {
    // cursor on block 1, nothing logged → every block pending.
    const fixed = fixedBlockIdsForReorder(
      s,
      { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 },
      new Set(), new Set(), new Set(),
    )
    // blk1 (index 0): down → index 1 (blk2); up → edge → null.
    expect(nextReorderableIndex(s, 0, 'down', fixed)).toBe(1)
    expect(nextReorderableIndex(s, 0, 'up', fixed)).toBeNull()
    // blk2 (index 1): up → index 0 (blk1) is now movable.
    expect(nextReorderableIndex(s, 1, 'up', fixed)).toBe(0)
  })

  it('does NOT leap a fixed anchor (returns null rather than skipping past it)', () => {
    // cursor on block 1; blk3 is skipped (fixed). blk2 and blk4 are pending.
    const fixed = fixedBlockIdsForReorder(
      s,
      { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 },
      new Set(), new Set(['blk3']), new Set(),
    )
    // blk2 (index 1) down → index 2 is blk3 (fixed) → null (don't leap to blk4).
    expect(nextReorderableIndex(s, 1, 'down', fixed)).toBeNull()
    // blk4 (index 3) up → index 2 is blk3 (fixed) → null.
    expect(nextReorderableIndex(s, 3, 'up', fixed)).toBeNull()
  })

  it('returns null when the source block itself is fixed', () => {
    const fixed = fixedBlockIdsForReorder(
      s,
      { blockPosition: 2, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 },
      new Set(), new Set(), new Set(),
    )
    // blk1 (index 0) is fixed (strictly before cursor) → cannot move at all.
    expect(nextReorderableIndex(s, 0, 'up', fixed)).toBeNull()
    expect(nextReorderableIndex(s, 0, 'down', fixed)).toBeNull()
  })

  it('end-to-end: swap two pending blocks, cursor block (with rows) stays put', () => {
    const cursor = { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }
    const fixed = fixedBlockIdsForReorder(s, cursor, new Set(['blk1']), new Set(), new Set())
    // Move blk2 (index 1) down → swaps with blk3 (index 2).
    const targetIndex = nextReorderableIndex(s, 1, 'down', fixed)
    expect(targetIndex).toBe(2)
    const next = swapBlocksByIndex(s, 1, targetIndex!)
    expect(next.blocks.map((b) => b.id)).toEqual(['blk1', 'blk3', 'blk2', 'blk4'])
    // Cursor block (blk1) untouched: still position 1, still index 0.
    expect(next.blocks[0]!.id).toBe('blk1')
    expect(next.blocks[0]!.position).toBe(1)
    // The cursor coordinate (blockPosition 1) still resolves to blk1.
    const t = targetAt(next, cursor)
    expect(t?.blockExercise.exercise_id).toBe('ex1')
  })

  it('end-to-end: move the untouched cursor block down; first cursor re-derives to the new first block (issue #26)', () => {
    const cursor = { blockPosition: 1, blockExercisePosition: 1, roundNumber: 1, setNumber: 1 }
    const fixed = fixedBlockIdsForReorder(s, cursor, new Set(), new Set(), new Set())
    // Move blk1 (index 0) down → swaps with blk2 (index 1).
    const targetIndex = nextReorderableIndex(s, 0, 'down', fixed)
    expect(targetIndex).toBe(1)
    const next = swapBlocksByIndex(s, 0, targetIndex!)
    expect(next.blocks.map((b) => b.id)).toEqual(['blk2', 'blk1', 'blk3', 'blk4'])
    expect(next.blocks.map((b) => b.position)).toEqual([1, 2, 3, 4])
    // With no rows logged, the first iterated set — what cursorFromLogged
    // would derive — is now blk2's first set at position 1.
    const first = [...iterateSets(next)][0]!
    expect(cursorKey(first.cursor)).toBe('1.1.1.1')
    expect(first.blockExercise.exercise_id).toBe('ex2')
  })
})
