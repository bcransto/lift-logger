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

### `workout_blocks.rest_after_sec` — default between-rounds rest (superset/circuit)

- Applies at round boundaries (last station of round N → first station of round N+1) **when the last-set row of the round doesn't specify its own `rest_after_sec`**.
- For single-kind blocks (rounds always 1), put rest on the sets, not here.
- If the block has `rounds: 1`, the UI does not use this field.

### Per-round rest overrides (v3)

If you want the between-round rest to vary — e.g. 60s after R1, 90s after R2 as fatigue builds — set `rest_after_sec` on the last-set row of a specific round (via a per-round override, see "Per-round targets" below). That value overrides `workout_blocks.rest_after_sec` for *that* round only; rounds without an explicit override still fall back to the block-level default.

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

### Progressive superset — per-round targets (v3)

Supersets and circuits can carry different weights / reps / rest per round. Each `(set_number)` gets a **round-1 anchor** with the defaults, plus optional **override rows** (`round_number > 1`) that carry only the fields that differ. Null columns on override rows inherit from the anchor.

```json
{
  "kind": "superset",
  "rounds": 3,
  "rest_after_sec": 90,
  "exercises": [
    {
      "exercise_id": "ex_leg_ext",
      "sets": [
        { "set_number": 1, "target_weight": 100, "target_reps": 12 },
        { "set_number": 1, "round_number": 2, "target_weight": 110 },
        { "set_number": 1, "round_number": 3, "target_weight": 120, "target_reps": 10 }
      ]
    },
    {
      "exercise_id": "ex_leg_curl",
      "sets": [
        { "set_number": 1, "target_weight": 70, "target_reps": 12 }
      ]
    }
  ]
}
```

Reads as: Leg Extensions R1 = 100×12, R2 = 110×12 (reps inherited), R3 = 120×10 (both overridden). Leg Curls runs 70×12 on every round (no overrides, inherits anchor entirely). Between-round rest is 90s everywhere (block default) — no per-round rest variation here.

**Rules**:
- Round 1 is a mandatory anchor per `(exercise, set_number)`. Without it, overrides have nothing to inherit from and the set won't execute.
- Override rows are **partial**: only include the fields that change. Omitting a field = inherit from round 1. Setting it to `null` also = inherit.
- You can vary `rest_after_sec` per round the same way — put it on the last-set row of a round to override the between-round rest for that round.
- Keep `round_number ≤ block.rounds`. Rows beyond that are preserved in the DB but filtered out of execution (a safety net for shrink/regrow of rounds).
- You never need to duplicate a row per round if nothing differs — the engine replicates round 1 for any round without explicit entries.

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
- **Authoring a round-2 override without a round-1 anchor** for the same `set_number`. The override row will exist but the executor has no anchor to inherit from, so the set won't appear in any round. Always write the anchor first.
- **Setting `round_number` on single-block sets.** Single blocks always execute `rounds=1`. Any `round_number > 1` row on a single-block set is an unreachable orphan. Omit the field (it defaults to 1).
- **Duplicating every round verbatim** when nothing differs. Wasteful and easy to drift — just write one anchor row at round 1 and let the engine replicate.

## Checking your work

After `create_workout`, call `get_workout({ workoutId })` and verify:
- All exercises you named are present (the tool validates `exercise_id`s at write time, but inspect visually).
- Set numbering is 1..N contiguous per block_exercise **within each round**. Different rounds can have different counts; they don't need to match.
- `is_peak` is exactly where you intended.
- Rest values make sense: longest rest on the heaviest set of a pyramid, zero on the final set of non-final blocks, block-level rest only set for supersets/circuits with rounds > 1.
- For per-round overrides: each `set_number` has a round-1 row; override rows (round > 1) carry only the fields that differ; `round_number` never exceeds `block.rounds` (or if it does, you did it deliberately as a preserved orphan).
