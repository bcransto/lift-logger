import { describe, expect, it } from 'vitest'
import type { SnapshotBlock, WorkoutSnapshot } from '../../types/schema'
import type { BlockExerciseId, ExerciseId, WorkoutBlockId, WorkoutId } from '../../types/ids'
import {
  advance,
  cursorKey,
  cursorsEqual,
  firstCursor,
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
