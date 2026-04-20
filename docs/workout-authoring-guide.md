# IRON — Workout Authoring Guide (for AI agents)

How to build well-formed workouts via the `create_workout` MCP tool. If you're an AI agent authoring workouts for a user, read this before calling the tool.

## The three block kinds

Every block is one of:

| kind | When to use | `rounds` | Sets author like |
|---|---|---|---|
| `single` | One exercise done straight through (pyramid, straight sets, 5×5, drop set — anything one-exercise). | always `1` | Each set is a row in `sets[]` with its own target weight / reps / rest. |
| `superset` | 2+ exercises cycled back-to-back per round (typical: curl + tricep ×4 rounds). | number of cycles | One `sets[]` entry per exercise; it gets visited once per round. |
| `circuit` | Time-based work (HIIT, Tabata) OR 3+ exercise "stations." | number of cycles | Same as superset, but sets typically use `target_duration_sec`. |

Execution is **round-major** for supersets/circuits: `exA-R1, exB-R1, exA-R2, exB-R2, …`. If your mental model needs A then B then A then B, use rounds.

## Rest semantics (read carefully)

Rest lives in two places:

### `block_exercise_sets.rest_after_sec` — rest *after this specific set*

- Fires between *consecutive set cards* during execution.
- A falsy value (0 or null) means "no rest — advance immediately" (inline Next button appears in the UI).
- The **last set of a block should be 0/null** unless you want rest before the next block begins.
- For pyramids with progressive heavier loads, rest typically grows: 90, 120, 180, ... per set.

### `workout_blocks.rest_after_sec` — between-rounds rest (superset/circuit)

- Only applies at round boundaries (last station of round N → first station of round N+1).
- For single-kind blocks (rounds always 1), put rest on the sets, not here.
- If the block has `rounds: 1`, the UI does not use this field.

**Rule of thumb**: for a Tabata-style circuit with 20s work + 10s between stations + 30s between rounds, set `sets[].rest_after_sec = 10` on each set and `workout_blocks.rest_after_sec = 30` on the block.

## Set target fields

Each set target has these knobs. Use whichever combination matches the exercise; the schema enforces mutual exclusivity for weight vs pct_1rm.

| Field | When |
|---|---|
| `target_weight` | Absolute weight (lb). Mutually exclusive with `target_pct_1rm`. |
| `target_pct_1rm` | 0.0–1.2; decimal. e.g. `0.85` for 85% 1RM. |
| `target_reps` | Rep target (int). |
| `target_reps_each` | `true` for unilateral — reps are "per side" (renders as "10 ea"). |
| `target_duration_sec` | Time-based (HIIT, planks). Exclusive with reps in practice. |
| `target_rpe` | Optional 1–10. |
| `is_peak` | `true` on the ★ set of a pyramid. UI renders an amber border. |
| `notes` | Free text, per-set. |

## Common patterns

### Pyramid (single block)

```json
{
  "kind": "single",
  "rounds": 1,
  "rest_after_sec": null,
  "exercises": [{
    "exercise_id": "ex_squat",
    "sets": [
      { "target_weight": 135, "target_reps": 12, "rest_after_sec": 90 },
      { "target_weight": 155, "target_reps": 10, "rest_after_sec": 120 },
      { "target_weight": 175, "target_reps": 8,  "rest_after_sec": 180 },
      { "target_weight": 185, "target_reps": 6,  "is_peak": true }
    ]
  }]
}
```

### Superset (2 exercises × 4 rounds)

```json
{
  "kind": "superset",
  "rounds": 4,
  "rest_after_sec": 90,
  "exercises": [
    { "exercise_id": "ex_curl",        "sets": [{ "target_weight": 30, "target_reps": 12 }] },
    { "exercise_id": "ex_tricep_ext",  "sets": [{ "target_weight": 40, "target_reps": 12 }] }
  ]
}
```

### Tabata HIIT (2 stations × 8 rounds)

```json
{
  "kind": "circuit",
  "rounds": 8,
  "rest_after_sec": 60,
  "exercises": [
    { "exercise_id": "ex_burpees",
      "sets": [{ "target_duration_sec": 20, "rest_after_sec": 10 }] },
    { "exercise_id": "ex_mountain_climber",
      "sets": [{ "target_duration_sec": 20, "rest_after_sec": 10 }] }
  ]
}
```

### Unilateral (Bulgarian split squat)

```json
{
  "kind": "single",
  "rounds": 1,
  "exercises": [{
    "exercise_id": "ex_bulgarian_split",
    "sets": [
      { "target_weight": 40, "target_reps": 10, "target_reps_each": true, "rest_after_sec": 90 },
      { "target_weight": 40, "target_reps": 10, "target_reps_each": true, "rest_after_sec": 90 },
      { "target_weight": 40, "target_reps": 10, "target_reps_each": true }
    ]
  }]
}
```

## Workout-level fields

| Field | Notes |
|---|---|
| `name` | Required. Short title (e.g. "Lower Body — Heavy"). |
| `description` | Optional. One-line sentence about the session. |
| `tags` | Filter chips: `["lower", "pyramid", "heavy"]`, `["hiit"]`, `["upper", "superset"]`. |
| `est_duration` | Minutes (optional). Helps the Home sort dropdown. |
| `created_by` | Leave unset; defaults to `"agent"` for MCP writes. |

## Things that commonly go wrong

- **Forgetting `is_peak`**: a 4-set pyramid without a starred peak just looks like 4 ascending sets. Mark the top set.
- **Adding rest to the last set of a block you don't need rest after.** Causes a phantom rest before the next block.
- **Putting rest on `workout_blocks.rest_after_sec` for a `single` block** — it won't fire (single blocks run once). Use the last set's `rest_after_sec`.
- **Authoring `target_weight` AND `target_pct_1rm` together** — schema CHECK will reject. Pick one.
- **Mixing rep-based and timed sets in the same block_exercise.** Supported technically but confusing to execute. Prefer separate blocks if the patterns differ.
- **Using `kind: "standard"` or `"hiit"` directly.** Only `single`, `superset`, `circuit` exist. HIIT = circuit with timed sets.

## Checking your work

After `create_workout`, call `get_workout({ workoutId })` and verify:
- All exercises you named are present (the tool validates `exercise_id`s at write time, but inspect visually).
- Set numbering is 1..N contiguous per block_exercise.
- `is_peak` is exactly where you intended.
- Rest values make sense: longest rest on the heaviest set of a pyramid, zero on the final set of non-final blocks, block-level rest only set for supersets/circuits with rounds > 1.
