#!/usr/bin/env node
/**
 * Load backup data into the Lift Logger database via sync endpoint
 *
 * Usage: node load-backup.js [server-url]
 * Default server: http://localhost:3000
 */

const fs = require('fs');
const path = require('path');

const SERVER_URL = process.argv[2] || 'http://localhost:3000';

// Load backup files
const backupDir = path.join(__dirname, '..', '..', 'full backup 12-16-2025');
const exercisesData = JSON.parse(fs.readFileSync(path.join(backupDir, 'exercises.json'), 'utf8'));
const workoutsData = JSON.parse(fs.readFileSync(path.join(backupDir, 'workouts.json'), 'utf8'));
const recordsData = JSON.parse(fs.readFileSync(path.join(backupDir, 'records.json'), 'utf8'));

// Use backup date as default timestamp
const backupTimestamp = new Date('2025-12-16T22:00:00Z').getTime();

// Transform exercises - add updatedAt
const exercises = exercisesData.exercises.map(ex => ({
  id: ex.id,
  name: ex.name,
  updatedAt: backupTimestamp,
  isDeleted: ex.isDeleted || false
}));

// Transform workouts - add updatedAt
const workouts = workoutsData.workouts.map(w => ({
  id: w.id,
  name: w.name,
  exercises: w.exercises,
  updatedAt: backupTimestamp
}));

// Transform records - add id and updatedAt
const records = recordsData.records.map(r => {
  // Generate unique ID from date + workout + exercise + set
  const id = `rec_${r.date}_${r.workoutId}_${r.exerciseId}_${r.set}`;

  // Use existing timestamp or generate from date
  const timestamp = r.timestamp || `${r.date}T12:00:00.000Z`;
  const updatedAt = r.timestamp ? new Date(r.timestamp).getTime() : backupTimestamp;

  return {
    id,
    date: r.date,
    workoutId: r.workoutId,
    exerciseId: r.exerciseId,
    set: r.set,
    weight: r.weight,
    reps: r.reps,
    timestamp,
    updatedAt
  };
});

console.log(`Loading backup data to ${SERVER_URL}`);
console.log(`  Exercises: ${exercises.length}`);
console.log(`  Workouts: ${workouts.length}`);
console.log(`  Records: ${records.length}`);

// Send via sync endpoint
async function loadData() {
  try {
    const response = await fetch(`${SERVER_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lastSync: 0,
        changes: {
          exercises,
          workouts,
          records
        }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    console.log('\nBackup loaded successfully!');
    console.log(`Server sync timestamp: ${new Date(result.syncTimestamp).toISOString()}`);
    console.log(`Server returned ${result.serverChanges.exercises.length} exercises`);
    console.log(`Server returned ${result.serverChanges.workouts.length} workouts`);
    console.log(`Server returned ${result.serverChanges.records.length} records`);
  } catch (error) {
    console.error('Failed to load backup:', error.message);
    process.exit(1);
  }
}

loadData();
