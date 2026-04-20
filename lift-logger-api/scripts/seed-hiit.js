#!/usr/bin/env node
/**
 * Seed a small HIIT workout via /api/sync.
 * Run: node scripts/seed-hiit.js [port]
 *
 * HIIT in IRON is a `circuit` block with time-based target_duration_sec
 * on each set. `rounds` on the block tells the UI how many times to
 * cycle through the stations.
 *
 * Shape:
 *   Tabata Finisher (circuit, 4 rounds, 30s rest between rounds)
 *     ├─ Burpees       · 20s
 *     └─ Mountain Climbers · 20s
 */
const http = require('http');

const PORT = process.argv[2] ?? '3100';
const now = Date.now();

const exercises = [
  {
    id: 'ex_burpees',
    name: 'Burpees',
    equipment: '["bodyweight"]',
    muscle_groups: '["full_body"]',
    movement_type: 'cardio',
    is_unilateral: 0,
    starred: 0,
    notes: null,
    created_at: now,
    updated_at: now,
  },
  {
    id: 'ex_mountain_climber',
    name: 'Mountain Climbers',
    equipment: '["bodyweight"]',
    muscle_groups: '["core","cardio"]',
    movement_type: 'cardio',
    is_unilateral: 0,
    starred: 0,
    notes: null,
    created_at: now,
    updated_at: now,
  },
];

const workouts = [
  {
    id: 'wk_tabata_finisher',
    name: 'Tabata Finisher',
    description: '20s on, 10s between stations, 30s between rounds. 4 rounds.',
    tags: '["hiit","cardio","finisher"]',
    starred: 0,
    est_duration: 8,
    created_by: 'agent',
    created_at: now,
    updated_at: now,
    last_performed: null,
  },
];

const workout_blocks = [
  {
    id: 'wb_tabata',
    workout_id: 'wk_tabata_finisher',
    position: 1,
    kind: 'circuit',
    rounds: 4,
    rest_after_sec: 30,
    setup_cue: 'Space for burpees.\n**20s** per station, **10s** transition.',
    created_at: now,
    updated_at: now,
  },
];

const block_exercises = [
  {
    id: 'be_tabata_burpee',
    block_id: 'wb_tabata',
    exercise_id: 'ex_burpees',
    position: 1,
    alt_exercise_ids: '[]',
    created_at: now,
    updated_at: now,
  },
  {
    id: 'be_tabata_mc',
    block_id: 'wb_tabata',
    exercise_id: 'ex_mountain_climber',
    position: 2,
    alt_exercise_ids: '[]',
    created_at: now,
    updated_at: now,
  },
];

const block_exercise_sets = [
  {
    id: 'bes_tabata_burpee_1',
    block_exercise_id: 'be_tabata_burpee',
    set_number: 1,
    target_weight: null,
    target_pct_1rm: null,
    target_reps: null,
    target_reps_each: 0,
    target_duration_sec: 20,
    target_rpe: null,
    is_peak: 0,
    rest_after_sec: 10,
    notes: null,
    created_at: now,
    updated_at: now,
  },
  {
    id: 'bes_tabata_mc_1',
    block_exercise_id: 'be_tabata_mc',
    set_number: 1,
    target_weight: null,
    target_pct_1rm: null,
    target_reps: null,
    target_reps_each: 0,
    target_duration_sec: 20,
    target_rpe: null,
    is_peak: 0,
    rest_after_sec: 10,
    notes: null,
    created_at: now,
    updated_at: now,
  },
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
      console.log('Tabata Finisher seeded. Reload the app to pull it.');
    });
  },
);
req.on('error', (e) => console.error('error:', e.message));
req.write(body);
req.end();
