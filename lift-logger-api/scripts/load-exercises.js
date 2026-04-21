#!/usr/bin/env node
/**
 * Load exercises from CSV into IRON via /api/sync.
 *
 * Usage:   node scripts/load-exercises.js [server-url] [csv-path]
 * Default: http://localhost:3000 , ../exercises_all.csv
 *
 * Uses the IRON per-table payload shape:
 *   { tables: { exercises: { lastSync: 0, changes: [...rows] } } }
 */

const fs = require('fs');
const path = require('path');

const SERVER_URL = process.argv[2] || 'http://localhost:3000';
const CSV_PATH = process.argv[3] || path.join(__dirname, '..', '..', 'exercises_all.csv');

if (!fs.existsSync(CSV_PATH)) {
  console.error(`CSV not found: ${CSV_PATH}`);
  process.exit(1);
}

const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n');
const now = Date.now();

const exercises = lines.map((name, i) => ({
  id: `ex_csv_${i + 1}`,
  name: name.trim().replace(/^"(.*)"$/, '$1'),
  created_at: now,
  updated_at: now
}));

console.log(`Loading ${exercises.length} exercises to ${SERVER_URL}`);

async function loadData() {
  try {
    const response = await fetch(`${SERVER_URL}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tables: {
          exercises: { lastSync: 0, changes: exercises }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = await response.json();
    const returned = result.tables?.exercises?.changes?.length ?? 0;
    console.log('Done!');
    console.log(`Server now reports ${returned} exercises in its change feed.`);
  } catch (error) {
    console.error('Failed:', error.message);
    process.exit(1);
  }
}

loadData();
