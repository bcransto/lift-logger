/**
 * IRON backend: generic LWW upsert + per-table change feed + migrations + PR computation.
 *
 * Design notes:
 *  - Each syncable table registers itself in TABLE_COLUMNS below. The shape is
 *    simply the list of column names (excluding id + updated_at, which are always
 *    present and handled specially).
 *  - upsertRow(table, row) does ON CONFLICT(id) DO UPDATE … WHERE new.updated_at > existing.updated_at.
 *  - getChangesSince(table, since) returns all rows with updated_at > since.
 *  - PR computation for session_sets is a transactional side-effect — see recomputePRsForSessionSet.
 *  - Agents (MCP) never touch exercise_prs; only the sync handler does, via this module.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const schema = require('./schema');
const { MIGRATIONS, CURRENT_SCHEMA_VERSION, runMigrations, takePreV3Snapshot } = require('./migrations');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'iron.db');
const db = new Database(dbPath);

// Concurrent-safe settings
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// -------------------- schema init + migrations --------------------

db.exec(schema);

// Pre-migration safety net: if we're about to rebuild block_exercise_sets
// (v2 → v3), take a disk snapshot first. Must happen outside the migration
// transaction because SQLite forbids VACUUM inside one.
const snapshotPath = takePreV3Snapshot(db);
if (snapshotPath) {
  console.log(`[migration] pre-v3 snapshot saved to ${snapshotPath}`);
}

runMigrations(db);

// -------------------- per-table column maps --------------------

/**
 * Column definitions for every syncable table.
 * `id` and `updated_at` are always present and handled generically — do not list them.
 */
const TABLE_COLUMNS = {
  exercises: [
    'name', 'equipment', 'muscle_groups', 'movement_type',
    'is_unilateral', 'starred', 'notes', 'created_at'
  ],
  workouts: [
    'name', 'description', 'tags', 'starred', 'est_duration',
    'created_by', 'created_at', 'last_performed'
  ],
  workout_blocks: [
    'workout_id', 'position', 'kind', 'rounds', 'rest_after_sec',
    'setup_cue', 'created_at'
  ],
  block_exercises: [
    'block_id', 'exercise_id', 'position', 'alt_exercise_ids', 'created_at'
  ],
  block_exercise_sets: [
    'block_exercise_id', 'set_number', 'round_number',
    'target_weight', 'target_pct_1rm',
    'target_reps', 'target_reps_each', 'target_duration_sec', 'target_rpe',
    'is_peak', 'rest_after_sec', 'notes', 'created_at'
  ],
  sessions: [
    'workout_id', 'workout_snapshot', 'started_at', 'ended_at', 'duration_sec',
    'status', 'notes', 'save_preference', 'created_at',
    // v2 additions (Phase 2)
    'paused_at', 'skipped_block_ids',
    'work_timer_started_at', 'work_timer_duration_sec',
    'accumulated_paused_ms', 'pending_actuals'
  ],
  session_sets: [
    'session_id', 'exercise_id', 'block_position', 'block_exercise_position',
    'round_number', 'set_number', 'target_weight', 'target_reps',
    'target_duration_sec', 'actual_weight', 'actual_reps', 'actual_duration_sec',
    'rpe', 'rest_taken_sec', 'is_pr', 'was_swapped', 'logged_at', 'created_at'
  ],
  exercise_prs: [
    'exercise_id', 'pr_type', 'value', 'reps', 'weight',
    'achieved_at', 'session_id', 'created_at'
  ]
};

const SYNC_TABLES = Object.keys(TABLE_COLUMNS);

// Cache prepared statements per (table, operation) so we don't re-prepare on every call.
const stmtCache = new Map();

function getUpsertStmt(table, database = db) {
  const key = `${database === db ? 'main' : 'tx'}::upsert::${table}`;
  if (stmtCache.has(key)) return stmtCache.get(key);

  const cols = TABLE_COLUMNS[table];
  const allCols = ['id', ...cols, 'updated_at'];
  const placeholders = allCols.map(c => `@${c}`).join(', ');
  // created_at is insert-only — never update it.
  const updateCols = cols.filter(c => c !== 'created_at').concat(['updated_at'])
    .map(c => `${c} = @${c}`)
    .join(', ');

  const sql = `
    INSERT INTO ${table} (${allCols.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(id) DO UPDATE SET ${updateCols}
    WHERE @updated_at > ${table}.updated_at
  `;
  const stmt = database.prepare(sql);
  if (database === db) stmtCache.set(key, stmt);
  return stmt;
}

/**
 * Normalize an incoming row: coerce booleans to 0/1, fill missing columns with null.
 * Unknown columns (not in TABLE_COLUMNS) are silently dropped.
 */
function normalizeRow(table, row) {
  if (!row || typeof row !== 'object') {
    throw new Error(`Invalid row for ${table}`);
  }
  if (!row.id) throw new Error(`Missing id for ${table}`);
  if (row.updated_at === undefined || row.updated_at === null) {
    throw new Error(`Missing updated_at for ${table} id=${row.id}`);
  }

  const cols = TABLE_COLUMNS[table];
  const out = { id: row.id, updated_at: Number(row.updated_at) };

  for (const col of cols) {
    let v = row[col];
    if (v === undefined) v = null;
    if (typeof v === 'boolean') v = v ? 1 : 0;
    out[col] = v;
  }
  // created_at defaults to updated_at if the client didn't send one (INSERT fallback).
  if (cols.includes('created_at') && (out.created_at === null || out.created_at === undefined)) {
    out.created_at = out.updated_at;
  }
  // block_exercise_sets.round_number was added in v3 and is NOT NULL. Older
  // clients (pre-v3) omit the field; default to 1 (the round-1 anchor) so their
  // pushes land cleanly without a coordinated deploy.
  if (table === 'block_exercise_sets' && (out.round_number === null || out.round_number === undefined)) {
    out.round_number = 1;
  }
  return out;
}

/**
 * Upsert a row with LWW semantics. Returns the change info from better-sqlite3.
 * If you pass a custom `database` handle (e.g. inside a transaction), the
 * statement is prepared on that handle — handy for transactional PR computation.
 */
function upsertRow(table, row, database = db) {
  if (!TABLE_COLUMNS[table]) throw new Error(`Unknown table: ${table}`);
  const normalized = normalizeRow(table, row);
  const stmt = getUpsertStmt(table, database);
  return stmt.run(normalized);
}

/**
 * Return all rows in `table` with updated_at > since. Booleans re-cast to real bools.
 */
function getChangesSince(table, since) {
  if (!TABLE_COLUMNS[table]) throw new Error(`Unknown table: ${table}`);
  const rows = db.prepare(`SELECT * FROM ${table} WHERE updated_at > ?`).all(Number(since) || 0);
  return rows;
}

// -------------------- PR computation --------------------

/**
 * Epley 1RM estimate, capped at 10 reps (above that the formula is noise).
 * Returns null if inputs are unusable.
 */
function estimate1RM(weight, reps) {
  if (weight === null || weight === undefined) return null;
  if (reps === null || reps === undefined) return null;
  if (reps <= 0) return null;
  if (weight <= 0) return null;
  const cappedReps = Math.min(reps, 10);
  if (cappedReps === 1) return weight;
  return weight * (1 + cappedReps / 30);
}

/**
 * Recompute PRs after a session_sets write. Runs inside the supplied transaction
 * (`txDb` — the same better-sqlite3 handle used for the session_sets upsert).
 *
 * Rules:
 *  - Rep-count PRs and weight PRs only consider sets with meaningful values (>0).
 *  - A PR is "beaten" if the new value is strictly greater than the existing one.
 *  - When a PR is beaten, upsert exercise_prs (new row uses a deterministic id:
 *    `pr_${exercise_id}_${pr_type}`) and flip is_pr=1 on the winning session_set row.
 *  - `exercise_prs.updated_at` always advances so the change feed picks it up.
 *
 * Returns { setPRs: ['weight', 'reps', …] } listing which PR types this row claimed.
 */
function recomputePRsForSessionSet(row, txDb) {
  if (!row) return { setPRs: [] };

  const weight = row.actual_weight;
  const reps = row.actual_reps;
  if (weight === null || weight === undefined) return { setPRs: [] };
  if (reps === null || reps === undefined) return { setPRs: [] };

  const volume = (weight > 0 && reps > 0) ? weight * reps : null;
  const oneRm = estimate1RM(weight, reps);

  const candidates = [];
  if (weight > 0) candidates.push({ type: 'weight', value: weight });
  if (reps > 0)   candidates.push({ type: 'reps', value: reps });
  if (volume !== null && volume > 0) candidates.push({ type: 'volume', value: volume });
  if (oneRm !== null && oneRm > 0)   candidates.push({ type: '1rm_est', value: oneRm });

  if (candidates.length === 0) return { setPRs: [] };

  const getPR = txDb.prepare(
    'SELECT value FROM exercise_prs WHERE exercise_id = ? AND pr_type = ?'
  );
  const upsertPR = txDb.prepare(`
    INSERT INTO exercise_prs
      (id, exercise_id, pr_type, value, weight, reps, session_id, achieved_at, created_at, updated_at)
    VALUES
      (@id, @exercise_id, @pr_type, @value, @weight, @reps, @session_id, @achieved_at, @created_at, @updated_at)
    ON CONFLICT(exercise_id, pr_type) DO UPDATE SET
      value = @value,
      weight = @weight,
      reps = @reps,
      session_id = @session_id,
      achieved_at = @achieved_at,
      updated_at = @updated_at
  `);

  const setPRs = [];
  const now = Date.now();

  for (const c of candidates) {
    const existing = getPR.get(row.exercise_id, c.type);
    if (existing && existing.value >= c.value) continue;

    upsertPR.run({
      id: `pr_${row.exercise_id}_${c.type}`,
      exercise_id: row.exercise_id,
      pr_type: c.type,
      value: c.value,
      weight: weight,
      reps: reps,
      session_id: row.session_id,
      achieved_at: row.logged_at,
      created_at: now,
      updated_at: now
    });
    setPRs.push(c.type);
  }

  if (setPRs.length > 0) {
    // Flip is_pr on the winning row. Bump updated_at so clients re-pull.
    txDb.prepare(`
      UPDATE session_sets SET is_pr = 1, updated_at = ? WHERE id = ?
    `).run(now, row.id);
  }

  return { setPRs };
}

/**
 * Upsert a session_sets row AND recompute PRs in the same transaction.
 * Returns { applied, setPRs }.
 */
function upsertSessionSetWithPRs(row) {
  const tx = db.transaction((r) => {
    const info = upsertRow('session_sets', r, db);
    // If the LWW guard rejected the write, don't touch PRs.
    if (info.changes === 0) {
      return { applied: false, setPRs: [] };
    }
    // Re-read the row to compute PRs off the authoritative stored values.
    const stored = db.prepare('SELECT * FROM session_sets WHERE id = ?').get(r.id);
    const { setPRs } = recomputePRsForSessionSet(stored, db);
    return { applied: true, setPRs };
  });
  return tx(row);
}

// -------------------- sync helpers --------------------

/**
 * Dependency-safe write order — parents before children so foreign-key-like
 * references (even without FK enforcement) always resolve.
 */
const WRITE_ORDER = [
  'exercises',
  'workouts',
  'workout_blocks',
  'block_exercises',
  'block_exercise_sets',
  'sessions',
  'session_sets',
  'exercise_prs'
];

module.exports = {
  db,
  TABLE_COLUMNS,
  SYNC_TABLES,
  WRITE_ORDER,
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  runMigrations,
  upsertRow,
  getChangesSince,
  recomputePRsForSessionSet,
  upsertSessionSetWithPRs,
  estimate1RM
};
