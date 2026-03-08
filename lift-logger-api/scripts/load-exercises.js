#!/usr/bin/env node
/**
 * Load exercises from CSV into the Lift Logger database via sync endpoint
 *
 * Usage: node load-exercises.js [server-url]
 * Default server: http://localhost:3000
 */

const fs = require('fs');
const path = require('path');

const SERVER_URL = process.argv[2] || 'http://localhost:3000';
const CSV_PATH = process.argv[3] || path.join(__dirname, '..', '..', 'exercises_all.csv');

const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n');
const now = Date.now();

const exercises = lines.map((name, i) => ({
  id: `ex_csv_${i + 1}`,
  name: name.trim().replace(/^"(.*)"$/, '$1'),
  updatedAt: now,
  isDeleted: false
}));

console.log(`Loading ${exercises.length} exercises to ${SERVER_URL}`);

async function loadData() {
  try {
    const response = await fetch(`${SERVER_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lastSync: 0,
        changes: { exercises, workouts: [], records: [] }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    console.log('Done!');
    console.log(`Server now has ${result.serverChanges.exercises.length} total exercises`);
  } catch (error) {
    console.error('Failed:', error.message);
    process.exit(1);
  }
}

loadData();
