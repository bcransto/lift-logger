#!/usr/bin/env node
/**
 * Offline smoke test for the IRON database layer — no HTTP, no subprocess.
 * Exercises: schema init, migrations idempotency, generic upsert, LWW, PR
 * computation (weight/reps/volume/1rm_est), MCP workout-tree upsert isolation.
 *
 * Run:  node lift-logger-api/scripts/smoke-iron.js
 * Exit: 0 on all-pass, 1 on any failure.
 *
 * WARNING: wipes lift-logger-api/data/iron.db at the start. Use on a throwaway DB.
 */

const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'iron.db');
for (const ext of ['', '-wal', '-shm']) {
  const p = DB_PATH + ext;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

const {
  db, upsertRow, getChangesSince, upsertSessionSetWithPRs,
  runMigrations, estimate1RM
} = require(path.join(__dirname, '..', 'db', 'database'));

let failed = 0;
function ok(cond, msg) {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${msg}`);
  if (!cond) failed++;
}

// --- 1. schema + schema_version ---
const tableNames = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);
for (const t of ['exercises','workouts','workout_blocks','block_exercises','block_exercise_sets','sessions','session_sets','exercise_prs','schema_version']) {
  ok(tableNames.includes(t), `table present: ${t}`);
}
const vRow = db.prepare('SELECT * FROM schema_version').all();
ok(vRow.length === 1, 'schema_version has one row');
ok(vRow[0].version === 1, 'schema_version.version = 1');

// --- 2. Migration idempotency ---
runMigrations(db);
runMigrations(db);
const vRow2 = db.prepare('SELECT * FROM schema_version').all();
ok(vRow2.length === 1, 'schema_version still has one row after re-run');

// --- 3. Generic upsert + LWW ---
upsertRow('exercises', { id: 'ex_a', name: 'Newer', updated_at: 100 });
upsertRow('exercises', { id: 'ex_a', name: 'Older should lose', updated_at: 50 });
ok(db.prepare('SELECT name FROM exercises WHERE id=?').get('ex_a').name === 'Newer',
   'LWW: older write rejected');
upsertRow('exercises', { id: 'ex_a', name: 'Newest', updated_at: 200 });
ok(db.prepare('SELECT name FROM exercises WHERE id=?').get('ex_a').name === 'Newest',
   'LWW: newer write accepted');

// --- 4. getChangesSince ---
ok(getChangesSince('exercises', 0).length >= 2, 'getChangesSince(0) returns all');
const since150 = getChangesSince('exercises', 150);
ok(since150.length === 1 && since150[0].id === 'ex_a', 'getChangesSince filters by updated_at');

// --- 5. PR computation ---
const now = Date.now();
upsertRow('sessions', { id: 'sess_1', name: 'test', started_at: now, updated_at: now });
const r1 = upsertSessionSetWithPRs({
  id: 'ss_1', session_id: 'sess_1', exercise_id: 'ex_a', set_number: 1,
  weight: 100, reps: 5, performed_at: now, updated_at: now
});
ok(r1.applied, 'first session_set applied');
ok(new Set(r1.setPRs).size === 4, `PR set has 4 types (got ${JSON.stringify(r1.setPRs)})`);

const byType = Object.fromEntries(
  db.prepare('SELECT pr_type, value FROM exercise_prs').all().map(r => [r.pr_type, r.value])
);
ok(byType.weight === 100, `weight PR = 100`);
ok(byType.reps === 5, `reps PR = 5`);
ok(byType.volume === 500, `volume PR = 500`);
ok(Math.abs(byType['1rm_est'] - (100 * (1 + 5/30))) < 0.01,
   `1rm_est PR = Epley(100,5) = ${byType['1rm_est']}`);

ok(db.prepare('SELECT is_pr FROM session_sets WHERE id=?').get('ss_1').is_pr === 1,
   'is_pr flipped to 1 on the winning set');

// Heavier set
upsertSessionSetWithPRs({
  id: 'ss_2', session_id: 'sess_1', exercise_id: 'ex_a', set_number: 2,
  weight: 120, reps: 3, performed_at: now + 1000, updated_at: now + 1000
});
const byType2 = Object.fromEntries(
  db.prepare('SELECT pr_type, value FROM exercise_prs').all().map(r => [r.pr_type, r.value])
);
ok(byType2.weight === 120, `weight PR advanced to 120`);
ok(byType2.reps === 5, `reps PR unchanged at 5`);

// Epley cap at 10 reps
ok(estimate1RM(100, 12) === estimate1RM(100, 10),
   `1RM rep-cap at 10 reps`);

// --- 6. MCP workout-tree isolation from exercise_prs ---
const prsBefore = db.prepare('SELECT COUNT(*) AS n FROM exercise_prs').get().n;
const { createWorkout, getWorkout } = require(path.join(__dirname, '..', '..', 'lift-logger-mcp', 'tools', 'workouts'));
const w = createWorkout({
  name: 'MCP test',
  blocks: [{
    block_type: 'standard',
    exercises: [{
      exercise_id: 'ex_a',
      sets: [{ target_reps: 5, target_weight: 500 }, { target_reps: 3, target_weight: 550 }]
    }]
  }]
});
ok(!!w.id, 'createWorkout returned id');
ok(w.blocks.length === 1, 'workout has 1 block');
ok(w.blocks[0].exercises[0].sets.length === 2, 'exercise has 2 sets');
ok(w.blocks[0].exercises[0].sets[0].set_number === 1, 'auto-assigned set_number 1');
ok(w.blocks[0].exercises[0].sets[1].set_number === 2, 'auto-assigned set_number 2');
ok(w.blocks[0].position === 0, 'auto-assigned block position 0');
const prsAfter = db.prepare('SELECT COUNT(*) AS n FROM exercise_prs').get().n;
ok(prsAfter === prsBefore, `createWorkout did not mutate exercise_prs`);

const readBack = getWorkout({ workoutId: w.id });
ok(readBack.id === w.id, 'getWorkout returns same id');
ok(readBack.blocks[0].exercises[0].sets.length === 2, 'getWorkout sees sets');

// Unknown exercise_id rejected
let caught = false;
try {
  createWorkout({ name: 'Bad', blocks: [{ exercises: [{ exercise_id: 'NOPE', sets: [] }] }] });
} catch (e) { caught = /unknown exercise_id/.test(e.message); }
ok(caught, 'createWorkout rejects unknown exercise_id');

// --- 7. session_sets LWW ---
const before = db.prepare('SELECT weight FROM session_sets WHERE id=?').get('ss_1').weight;
upsertSessionSetWithPRs({
  id: 'ss_1', session_id: 'sess_1', exercise_id: 'ex_a', set_number: 1,
  weight: 999, reps: 99, performed_at: now, updated_at: now - 1
});
ok(db.prepare('SELECT weight FROM session_sets WHERE id=?').get('ss_1').weight === before,
   'LWW on session_sets rejects older updated_at');

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAIL'}`);
process.exit(failed === 0 ? 0 : 1);
