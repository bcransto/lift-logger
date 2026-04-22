#!/usr/bin/env node
/**
 * Smoke test for P3 — MCP per-round target support.
 *
 * Creates a progressive superset via the createWorkout path (anchor + per-round
 * overrides + an intentional orphan), reads it back with getWorkout, asserts:
 *   - Every set row has a round_number field.
 *   - Override rows preserve their round_number round-trip.
 *   - Orphan rows (round_number > block.rounds) are preserved (warned, not rejected).
 *   - Sets return ordered by (round_number, set_number).
 *   - Legacy single-block sets default round_number = 1.
 *
 * Deletes the test workout on success. On failure, leaves the workout in place
 * so you can inspect it. Exit 0 all-pass, 1 otherwise.
 */

const path = require('path');
const { db } = require(path.join(__dirname, '..', 'db'));
const { createWorkout, getWorkout, deleteWorkout } = require(path.join(__dirname, '..', 'tools', 'workouts'));

let failed = 0;
function ok(cond, msg) {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${msg}`);
  if (!cond) failed++;
}

// Pick two existing exercise IDs (any two — content doesn't matter for the shape test).
const exRows = db.prepare('SELECT id FROM exercises LIMIT 2').all();
if (exRows.length < 2) {
  console.error('FAIL  need at least 2 exercises in the DB; run seed-demo.js first');
  process.exit(1);
}
const [exA, exB] = exRows;

// Build a workout with:
//   block 1: single block, 2 sets, no round_number → should land on round 1.
//   block 2: superset, 3 rounds, 2 BEs, each with a round-1 anchor and a
//            round-2 override + a round-3 override for BE_A only (BE_B round 3
//            inherits from anchor). Plus an orphan row at round 5 to exercise
//            the permissive warning path.
const payload = {
  name: `__verify-per-round-${Date.now()}`,
  description: 'P3 MCP smoke test — per-round targets',
  tags: ['__verify'],
  blocks: [
    {
      kind: 'single',
      rounds: 1,
      exercises: [
        {
          exercise_id: exA.id,
          sets: [
            // round_number omitted — should default to 1.
            { set_number: 1, target_weight: 100, target_reps: 10 },
            { set_number: 2, target_weight: 110, target_reps: 8 },
          ],
        },
      ],
    },
    {
      kind: 'superset',
      rounds: 3,
      rest_after_sec: 90,
      exercises: [
        {
          exercise_id: exA.id,
          sets: [
            // Round-1 anchor.
            { set_number: 1, target_weight: 50, target_reps: 12 },
            // Round-2 partial override: bump weight only; reps inherit.
            { set_number: 1, round_number: 2, target_weight: 60 },
            // Round-3 full override: weight AND reps.
            { set_number: 1, round_number: 3, target_weight: 70, target_reps: 8 },
            // Orphan: round 5 exists but block.rounds = 3 — preserved but filtered at read-time.
            { set_number: 1, round_number: 5, target_weight: 999 },
          ],
        },
        {
          exercise_id: exB.id,
          sets: [
            // Round-1 anchor only; rounds 2 and 3 inherit everything.
            { set_number: 1, target_weight: 40, target_reps: 12 },
          ],
        },
      ],
    },
  ],
};

const created = createWorkout(payload);
ok(created && created.id, 'createWorkout returned an id');
const workoutId = created.id;

try {
  const tree = getWorkout({ workoutId });
  ok(tree.blocks.length === 2, `two blocks (got ${tree.blocks.length})`);

  const singleBlock = tree.blocks[0];
  const supersetBlock = tree.blocks[1];

  // --- Single-block defaults ---
  const singleBe = singleBlock.exercises[0];
  ok(singleBe.sets.length === 2, `single block has 2 sets (got ${singleBe.sets.length})`);
  ok(singleBe.sets.every((s) => s.round_number === 1), 'single-block sets default round_number = 1');

  // --- Superset round-trip ---
  const beA = supersetBlock.exercises[0];
  ok(beA.sets.length === 4, `superset BE A has 4 raw rows incl orphan (got ${beA.sets.length})`);

  // Rows come back ordered by (round_number, set_number) ASC.
  const rounds = beA.sets.map((s) => s.round_number);
  ok(
    rounds.every((r, i) => i === 0 || rounds[i - 1] <= r),
    `rows sorted by round_number ASC (got [${rounds.join(',')}])`,
  );

  const anchor = beA.sets.find((s) => s.round_number === 1);
  const r2 = beA.sets.find((s) => s.round_number === 2);
  const r3 = beA.sets.find((s) => s.round_number === 3);
  const orphan = beA.sets.find((s) => s.round_number === 5);

  ok(anchor && anchor.target_weight === 50 && anchor.target_reps === 12, 'anchor preserved');
  ok(r2 && r2.target_weight === 60 && r2.target_reps === null, 'R2 partial override: weight set, reps null (to inherit)');
  ok(r3 && r3.target_weight === 70 && r3.target_reps === 8, 'R3 full override preserved');
  ok(orphan && orphan.target_weight === 999, 'orphan R5 row preserved in DB');

  // BE B — anchor only, no overrides.
  const beB = supersetBlock.exercises[1];
  ok(beB.sets.length === 1, `superset BE B has 1 anchor row (got ${beB.sets.length})`);
  ok(beB.sets[0].round_number === 1, 'BE B anchor at round 1');

  // --- Auto-assigned set_number per round ---
  // Write a block with multiple sets across rounds, some without set_number.
  const autoPayload = {
    name: `__verify-auto-setnum-${Date.now()}`,
    blocks: [
      {
        kind: 'superset',
        rounds: 2,
        exercises: [
          {
            exercise_id: exA.id,
            sets: [
              // round 1: two sets, both without set_number → should become 1, 2.
              { target_weight: 100 },
              { target_weight: 110 },
              // round 2: one set without set_number → should become 1 (scoped per round).
              { round_number: 2, target_weight: 120 },
            ],
          },
          {
            exercise_id: exB.id,
            sets: [{ target_weight: 40 }],
          },
        ],
      },
    ],
  };
  const auto = createWorkout(autoPayload);
  const autoTree = getWorkout({ workoutId: auto.id });
  const autoBe = autoTree.blocks[0].exercises[0];
  const r1Sets = autoBe.sets.filter((s) => s.round_number === 1).sort((a, b) => a.set_number - b.set_number);
  const r2Sets = autoBe.sets.filter((s) => s.round_number === 2);
  ok(r1Sets.length === 2 && r1Sets[0].set_number === 1 && r1Sets[1].set_number === 2,
     `R1 auto-numbered 1,2 (got ${r1Sets.map((s) => s.set_number).join(',')})`);
  ok(r2Sets.length === 1 && r2Sets[0].set_number === 1,
     `R2 auto-numbered 1 scoped per round (got ${r2Sets.map((s) => s.set_number).join(',')})`);

  deleteWorkout({ workoutId: auto.id });
} finally {
  if (failed === 0) {
    deleteWorkout({ workoutId });
    console.log('\nAll MCP per-round checks passed.');
    process.exit(0);
  } else {
    console.log(`\n${failed} check(s) failed. Inspect workout id: ${workoutId}`);
    process.exit(1);
  }
}
