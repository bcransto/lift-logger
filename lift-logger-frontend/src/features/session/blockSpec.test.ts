import { describe, expect, it } from 'vitest'
import { blockFromSpec, type NewBlockExerciseSpec } from './blockSpec'

const ex = (over: Partial<NewBlockExerciseSpec> = {}): NewBlockExerciseSpec => ({
  exerciseId: 'ex_a',
  name: 'Bench Press',
  targetWeight: 40,
  targetReps: 10,
  ...over,
})

describe('blockFromSpec — single', () => {
  it('generates N uniform sets with rest and targets', () => {
    const block = blockFromSpec(
      { kind: 'single', exercise: ex(), setCount: 3, restBetweenSetsSec: 180 },
      5,
    )
    expect(block.kind).toBe('single')
    expect(block.position).toBe(5)
    expect(block.rounds).toBe(1)
    expect(block.rest_after_sec).toBeNull()
    expect(block.exercises).toHaveLength(1)
    const sets = block.exercises[0]!.sets
    expect(sets.map((s) => s.set_number)).toEqual([1, 2, 3])
    for (const s of sets) {
      expect(s.round_number).toBe(1)
      expect(s.target_weight).toBe(40)
      expect(s.target_reps).toBe(10)
      expect(s.target_duration_sec).toBeNull()
      expect(s.rest_after_sec).toBe(180)
    }
  })

  it('keeps blank targets null (no history)', () => {
    const block = blockFromSpec(
      {
        kind: 'single',
        exercise: ex({ targetWeight: null, targetReps: null }),
        setCount: 2,
        restBetweenSetsSec: 180,
      },
      1,
    )
    const s = block.exercises[0]!.sets[0]!
    expect(s.target_weight).toBeNull()
    expect(s.target_reps).toBeNull()
  })
})

describe('blockFromSpec — superset', () => {
  it('generates one round-1 anchor set per exercise, zero rest within round', () => {
    const block = blockFromSpec(
      {
        kind: 'superset',
        exercises: [ex(), ex({ exerciseId: 'ex_b', name: 'Row', targetWeight: 65 })],
        rounds: 3,
        restBetweenRoundsSec: 90,
      },
      2,
    )
    expect(block.kind).toBe('superset')
    expect(block.rounds).toBe(3)
    expect(block.rest_after_sec).toBe(90)
    expect(block.exercises.map((e) => e.position)).toEqual([1, 2])
    for (const be of block.exercises) {
      expect(be.sets).toHaveLength(1)
      expect(be.sets[0]!.round_number).toBe(1)
      expect(be.sets[0]!.rest_after_sec).toBe(0)
    }
    expect(block.exercises[1]!.sets[0]!.target_weight).toBe(65)
  })
})

describe('blockFromSpec — circuit', () => {
  const stations = [
    ex({ exerciseId: 'ex_kb', name: 'KB Swing', targetWeight: 55, targetReps: null }),
    ex({ exerciseId: 'ex_mc', name: 'Mountain Climbers', targetWeight: null, targetReps: null }),
    ex({ exerciseId: 'ex_bp', name: 'Burpees', targetWeight: null, targetReps: 15 }),
  ]

  it('timed mode: duration on every set, reps null, last station rest null', () => {
    const block = blockFromSpec(
      {
        kind: 'circuit',
        exercises: stations,
        rounds: 3,
        work: { mode: 'timed', durationSec: 30 },
        restBetweenStationsSec: 15,
        restBetweenRoundsSec: 60,
      },
      4,
    )
    expect(block.kind).toBe('circuit')
    expect(block.rest_after_sec).toBe(60)
    const sets = block.exercises.map((e) => e.sets[0]!)
    for (const s of sets) {
      expect(s.target_duration_sec).toBe(30)
      expect(s.target_reps).toBeNull()
    }
    expect(sets[0]!.rest_after_sec).toBe(15)
    expect(sets[1]!.rest_after_sec).toBe(15)
    // Last station null → round-boundary fallback delivers block rest.
    expect(sets[2]!.rest_after_sec).toBeNull()
    // Station weight survives timed mode (loaded carries like KB swings).
    expect(sets[0]!.target_weight).toBe(55)
  })

  it('reps mode: reps kept, duration null', () => {
    const block = blockFromSpec(
      {
        kind: 'circuit',
        exercises: stations,
        rounds: 2,
        work: { mode: 'reps' },
        restBetweenStationsSec: 15,
        restBetweenRoundsSec: 60,
      },
      1,
    )
    const sets = block.exercises.map((e) => e.sets[0]!)
    for (const s of sets) expect(s.target_duration_sec).toBeNull()
    expect(sets[2]!.target_reps).toBe(15)
  })

  it('assigns unique ids across blocks and exercises', () => {
    const a = blockFromSpec(
      { kind: 'single', exercise: ex(), setCount: 1, restBetweenSetsSec: 60 },
      1,
    )
    const b = blockFromSpec(
      { kind: 'single', exercise: ex(), setCount: 1, restBetweenSetsSec: 60 },
      2,
    )
    expect(a.id).not.toBe(b.id)
    expect(a.exercises[0]!.id).not.toBe(b.exercises[0]!.id)
  })
})
