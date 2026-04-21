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
  isNewBlock,
  iterateSets,
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
