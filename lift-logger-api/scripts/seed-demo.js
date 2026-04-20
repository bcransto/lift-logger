#!/usr/bin/env node
/**
 * Seed a demo pyramid workout + superset workout via the sync endpoint.
 * Run:  node scripts/seed-demo.js [port]
 */
const http = require('http');

const PORT = process.argv[2] ?? '3100';
const now = Date.now();

const exercises = [
  { id: 'ex_smith_squat', name: 'Smith Machine Squat', equipment: '["smith_machine"]', muscle_groups: '["quads","glutes"]' },
  { id: 'ex_leg_ext', name: 'Leg Extensions', equipment: '["machine"]', muscle_groups: '["quads"]' },
  { id: 'ex_leg_curl', name: 'Leg Curls', equipment: '["machine"]', muscle_groups: '["hamstrings"]' },
  { id: 'ex_curl', name: 'DB Curl', equipment: '["db"]', muscle_groups: '["biceps"]' },
  { id: 'ex_tricep_ext', name: 'Tricep Extension', equipment: '["db"]', muscle_groups: '["triceps"]' },
].map((e) => ({
  ...e,
  movement_type: null,
  is_unilateral: 0,
  starred: 0,
  notes: null,
  created_at: now,
  updated_at: now,
}));

const workouts = [
  {
    id: 'wk_lower_heavy',
    name: 'Lower Body — Heavy',
    description: 'Squat pyramid, then accessories.',
    tags: '["lower","heavy","pyramid"]',
    starred: 1,
    est_duration: 45,
    created_by: 'agent',
    created_at: now,
    updated_at: now,
    last_performed: null,
  },
  {
    id: 'wk_arms',
    name: 'Arm Day — Superset',
    description: 'Biceps + triceps paired for 4 rounds.',
    tags: '["upper","superset","arms"]',
    starred: 0,
    est_duration: 30,
    created_by: 'agent',
    created_at: now,
    updated_at: now,
    last_performed: null,
  },
];

const workout_blocks = [
  { id: 'wb_a1', workout_id: 'wk_lower_heavy', position: 1, kind: 'single', rounds: 1, rest_after_sec: 180,
    setup_cue: 'Set safety pins at squat depth.\nStart with **135** loaded.', created_at: now, updated_at: now },
  { id: 'wb_a2', workout_id: 'wk_lower_heavy', position: 2, kind: 'superset', rounds: 3, rest_after_sec: 120,
    setup_cue: 'Leg ext **80×12**, then curl **70×12**. No rest between.', created_at: now, updated_at: now },
  { id: 'wb_b1', workout_id: 'wk_arms', position: 1, kind: 'superset', rounds: 4, rest_after_sec: 90,
    setup_cue: 'Alternate without rest, then **90s** between rounds.', created_at: now, updated_at: now },
];

const block_exercises = [
  { id: 'be_a1_squat', block_id: 'wb_a1', exercise_id: 'ex_smith_squat', position: 1, alt_exercise_ids: '[]', created_at: now, updated_at: now },
  { id: 'be_a2_ext', block_id: 'wb_a2', exercise_id: 'ex_leg_ext', position: 1, alt_exercise_ids: '[]', created_at: now, updated_at: now },
  { id: 'be_a2_curl', block_id: 'wb_a2', exercise_id: 'ex_leg_curl', position: 2, alt_exercise_ids: '[]', created_at: now, updated_at: now },
  { id: 'be_b1_curl', block_id: 'wb_b1', exercise_id: 'ex_curl', position: 1, alt_exercise_ids: '[]', created_at: now, updated_at: now },
  { id: 'be_b1_tri', block_id: 'wb_b1', exercise_id: 'ex_tricep_ext', position: 2, alt_exercise_ids: '[]', created_at: now, updated_at: now },
];

const mkSet = (id, be, n, w, r, peak = false, rest = 0) => ({
  id, block_exercise_id: be, set_number: n,
  target_weight: w, target_pct_1rm: null, target_reps: r,
  target_reps_each: 0, target_duration_sec: null, target_rpe: null,
  is_peak: peak ? 1 : 0, rest_after_sec: rest || null, notes: null,
  created_at: now, updated_at: now,
});

const block_exercise_sets = [
  // Smith Squat pyramid: 3 min rest between pyramid sets; no rest after the top set.
  mkSet('bes_a1_1', 'be_a1_squat', 1, 135, 12, false, 180),
  mkSet('bes_a1_2', 'be_a1_squat', 2, 155, 10, false, 180),
  mkSet('bes_a1_3', 'be_a1_squat', 3, 175, 8,  false, 180),
  mkSet('bes_a1_4', 'be_a1_squat', 4, 185, 6,  true),
  // Leg Ext + Curl superset: no rest between stations, block-level 120s between rounds.
  mkSet('bes_a2a_1', 'be_a2_ext',  1, 80, 12),
  mkSet('bes_a2b_1', 'be_a2_curl', 1, 70, 12),
  // Arm Day superset: same.
  mkSet('bes_b1a_1', 'be_b1_curl', 1, 30, 12),
  mkSet('bes_b1b_1', 'be_b1_tri',  1, 40, 12),
];

const payload = {
  tables: {
    exercises: { lastSync: 0, changes: exercises },
    workouts: { lastSync: 0, changes: workouts },
    workout_blocks: { lastSync: 0, changes: workout_blocks },
    block_exercises: { lastSync: 0, changes: block_exercises },
    block_exercise_sets: { lastSync: 0, changes: block_exercise_sets },
  },
};

const body = JSON.stringify(payload);
const req = http.request(
  { hostname: 'localhost', port: PORT, path: '/api/sync', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
  (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      const d = JSON.parse(data);
      for (const [t, v] of Object.entries(d.tables ?? {})) {
        console.log(`${t} → ${v.changes.length} rows returned`);
      }
      console.log('Seed complete.');
    });
  },
);
req.on('error', (e) => console.error('error:', e.message));
req.write(body);
req.end();
