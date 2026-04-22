#!/usr/bin/env node
/**
 * Verifier for schema migration v3 (per-round targets on block_exercise_sets).
 *
 * Creates an isolated temp DB, seeds it with v2-shape tables + rows, applies the
 * v3 migration from db/database.js, and asserts:
 *   - round_number column exists (NOT NULL, DEFAULT 1)
 *   - All pre-migration rows land at round_number = 1
 *   - New UNIQUE is (block_exercise_id, round_number, set_number)
 *   - Second round override on same (be, set_number) is accepted
 *   - schema_version row reads 3
 *   - Migration is idempotent (second run is a no-op)
 *
 * Run:  node lift-logger-api/scripts/verify-migration-v3.js
 * Exit: 0 on all-pass, 1 on any failure. Temp DB is deleted on success.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
// Import the pure migrations module — no side effects, no main-DB auto-init.
const { runMigrations, takePreV3Snapshot } = require(path.join(__dirname, '..', 'db', 'migrations'));

const TMP_PATH = path.join(__dirname, '..', 'data', `iron-verify-v3-${Date.now()}.db`);
for (const ext of ['', '-wal', '-shm']) {
  const p = TMP_PATH + ext;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

let failed = 0;
function ok(cond, msg) {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${msg}`);
  if (!cond) failed++;
}

// -- 1. Seed a v2-shape DB (schema pre-v3; only the slice we need). --
const tmp = new Database(TMP_PATH);
tmp.pragma('journal_mode = WAL');
tmp.pragma('foreign_keys = ON');

tmp.exec(`
  CREATE TABLE schema_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE block_exercise_sets (
    id TEXT PRIMARY KEY,
    block_exercise_id TEXT NOT NULL,
    set_number INTEGER NOT NULL CHECK (set_number >= 1),
    target_weight REAL,
    target_pct_1rm REAL,
    target_reps INTEGER,
    target_reps_each INTEGER NOT NULL DEFAULT 0,
    target_duration_sec INTEGER,
    target_rpe INTEGER,
    is_peak INTEGER NOT NULL DEFAULT 0,
    rest_after_sec INTEGER,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(block_exercise_id, set_number),
    CHECK (NOT (target_weight IS NOT NULL AND target_pct_1rm IS NOT NULL))
  );
  CREATE INDEX idx_bes_be ON block_exercise_sets(block_exercise_id, set_number);
  CREATE INDEX idx_bes_updated ON block_exercise_sets(updated_at);
  -- Stub sessions table (session_sets unique index references it; not needed for this migration)
  CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
  CREATE TABLE session_sets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    block_position INTEGER NOT NULL,
    block_exercise_position INTEGER NOT NULL,
    round_number INTEGER NOT NULL DEFAULT 1,
    set_number INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

tmp.prepare('INSERT INTO schema_version (id, version, updated_at) VALUES (1, 2, ?)').run(Date.now());

// Pre-migration data: three sets on one BE.
const now = Date.now();
const seed = tmp.prepare(`
  INSERT INTO block_exercise_sets (id, block_exercise_id, set_number, target_weight, target_reps, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
seed.run('bes_seed_1', 'be_x', 1, 100, 10, now, now);
seed.run('bes_seed_2', 'be_x', 2, 110, 8, now, now);
seed.run('bes_seed_3', 'be_x', 3, 120, 6, now, now);

ok(tmp.prepare('SELECT COUNT(*) AS n FROM block_exercise_sets').get().n === 3, 'seeded 3 rows at v2 shape');

// -- 2. Snapshot (outside transaction) + apply the v3 migration. --
const snapPath = takePreV3Snapshot(tmp);
ok(typeof snapPath === 'string' && fs.existsSync(snapPath), 'pre-v3 snapshot taken on disk');
runMigrations(tmp);

// -- 3. Assert outcomes. --
const cols = tmp.prepare('PRAGMA table_info(block_exercise_sets)').all();
const roundCol = cols.find((c) => c.name === 'round_number');
ok(!!roundCol, 'round_number column exists');
ok(roundCol && roundCol.notnull === 1, 'round_number is NOT NULL');
ok(roundCol && roundCol.dflt_value === '1', 'round_number default = 1');

const versionRow = tmp.prepare('SELECT version FROM schema_version WHERE id = 1').get();
ok(versionRow && versionRow.version === 3, `schema_version = 3 (got ${versionRow && versionRow.version})`);

const rowCount = tmp.prepare('SELECT COUNT(*) AS n FROM block_exercise_sets').get().n;
ok(rowCount === 3, `row count preserved (got ${rowCount})`);

const allRound1 = tmp.prepare(
  'SELECT COUNT(*) AS n FROM block_exercise_sets WHERE round_number = 1'
).get().n;
ok(allRound1 === 3, `all pre-migration rows land at round_number = 1 (got ${allRound1})`);

// -- 4. UNIQUE behavior. --
// New UNIQUE permits the same (be, set_number) at a different round_number.
let allowedRound2 = false;
try {
  tmp.prepare(`
    INSERT INTO block_exercise_sets (id, block_exercise_id, set_number, round_number, target_weight, target_reps, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('bes_override_r2', 'be_x', 1, 2, 105, 9, now, now);
  allowedRound2 = true;
} catch (err) {
  console.error('  unexpected insert failure:', err.message);
}
ok(allowedRound2, 'UNIQUE permits (be, set=1, round=2) alongside (be, set=1, round=1)');

// Same tuple (be, round, set) still rejected.
let rejectedDup = false;
try {
  tmp.prepare(`
    INSERT INTO block_exercise_sets (id, block_exercise_id, set_number, round_number, target_weight, target_reps, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('bes_dup', 'be_x', 1, 1, 999, 1, now, now);
} catch (err) {
  rejectedDup = /UNIQUE constraint/i.test(err.message);
}
ok(rejectedDup, 'UNIQUE rejects duplicate (be, set=1, round=1)');

// -- 5. Idempotency. --
runMigrations(tmp);
const afterSecondRun = tmp.prepare('PRAGMA table_info(block_exercise_sets)').all().length;
ok(afterSecondRun === cols.length, `second migration run is a no-op (column count stable at ${afterSecondRun})`);
const versionAfter = tmp.prepare('SELECT version FROM schema_version WHERE id = 1').get().version;
ok(versionAfter === 3, 'schema_version still = 3 after re-run');

// -- cleanup --
tmp.close();
if (failed === 0) {
  for (const ext of ['', '-wal', '-shm']) {
    const p = TMP_PATH + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  if (snapPath && fs.existsSync(snapPath)) fs.unlinkSync(snapPath);
  console.log('\nAll migration checks passed.');
  process.exit(0);
} else {
  console.log(`\n${failed} check(s) failed. Temp DB retained: ${TMP_PATH}`);
  if (snapPath) console.log(`Snapshot retained: ${snapPath}`);
  process.exit(1);
}
