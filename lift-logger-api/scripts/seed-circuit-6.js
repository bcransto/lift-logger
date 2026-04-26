#!/usr/bin/env node
/**
 * Seed a 6-exercise circuit for testing the BlockIntroScreen 2-col grid wrap.
 * Run: node scripts/seed-circuit-6.js [port]
 */
const http = require('http');

const PORT = process.argv[2] ?? '3100';
const now = Date.now();

const names = [
  ['ex_c6_burpee', 'Burpees'],
  ['ex_c6_mc', 'Mountain Climbers'],
  ['ex_c6_jsq', 'Jump Squats'],
  ['ex_c6_pu', 'Push-ups'],
  ['ex_c6_rt', 'Russian Twists'],
  ['ex_c6_plank', 'Plank Hold'],
];

const exercises = names.map(([id, name]) => ({
  id,
  name,
  equipment: '["bodyweight"]',
  muscle_groups: '["full_body"]',
  movement_type: 'cardio',
  is_unilateral: 0,
  starred: 0,
  notes: null,
  created_at: now,
  updated_at: now,
}));

const workouts = [
  {
    id: 'wk_circuit_6',
    name: 'Six-Station Circuit',
    description: '6-exercise circuit · 3 rounds. Used for grid layout verification.',
    tags: '["hiit","cardio"]',
    starred: 0,
    est_duration: 12,
    created_by: 'agent',
    created_at: now,
    updated_at: now,
    last_performed: null,
  },
];

const workout_blocks = [
  {
    id: 'wb_circuit_6',
    workout_id: 'wk_circuit_6',
    position: 1,
    kind: 'circuit',
    rounds: 3,
    rest_after_sec: 60,
    setup_cue: 'Six stations · **30s** work · **15s** transition.',
    created_at: now,
    updated_at: now,
  },
];

const block_exercises = names.map(([exId], i) => ({
  id: `be_c6_${i + 1}`,
  block_id: 'wb_circuit_6',
  exercise_id: exId,
  position: i + 1,
  alt_exercise_ids: '[]',
  created_at: now,
  updated_at: now,
}));

const block_exercise_sets = block_exercises.map((be) => ({
  id: `bes_${be.id}_1`,
  block_exercise_id: be.id,
  set_number: 1,
  target_weight: null,
  target_pct_1rm: null,
  target_reps: null,
  target_reps_each: 0,
  target_duration_sec: 30,
  target_rpe: null,
  is_peak: 0,
  rest_after_sec: 15,
  notes: null,
  created_at: now,
  updated_at: now,
}));

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
  {
    hostname: 'localhost',
    port: PORT,
    path: '/api/sync',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  },
  (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      const d = JSON.parse(data);
      for (const [t, v] of Object.entries(d.tables ?? {})) {
        console.log(`${t} → ${v.changes.length} rows`);
      }
      console.log('Six-Station Circuit seeded.');
    });
  },
);
req.on('error', (e) => console.error('error:', e.message));
req.write(body);
req.end();
