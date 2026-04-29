/**
 * Schema migrations — pure data + runner, no DB-handle side effects.
 *
 * Extracted so verifier scripts (and future standalone tools) can run the
 * migration list against a custom handle without triggering the main-DB
 * auto-init that happens when requiring database.js.
 */

const CURRENT_SCHEMA_VERSION = 4;

const MIGRATIONS = [
  // v1 is the baseline covered by schema.js; no-op migration body, just records the version.
  {
    version: 1,
    up(/* db */) {
      // Baseline — schema.js already created the tables.
    }
  },
  // v2 — Phase 2: add pause / skip / timer-persistence / pending-actuals columns to sessions,
  //       plus a UNIQUE index on session_sets tuple to prevent edit-mode duplicates.
  // All ALTERs are guarded by table_info checks so the migration is idempotent.
  {
    version: 2,
    up(database) {
      const addColumnIfMissing = (table, name, sql) => {
        const cols = database.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.some((c) => c.name === name)) {
          database.exec(sql);
        }
      };
      addColumnIfMissing('sessions', 'paused_at',
        'ALTER TABLE sessions ADD COLUMN paused_at INTEGER');
      addColumnIfMissing('sessions', 'skipped_block_ids',
        'ALTER TABLE sessions ADD COLUMN skipped_block_ids TEXT');
      addColumnIfMissing('sessions', 'work_timer_started_at',
        'ALTER TABLE sessions ADD COLUMN work_timer_started_at INTEGER');
      addColumnIfMissing('sessions', 'work_timer_duration_sec',
        'ALTER TABLE sessions ADD COLUMN work_timer_duration_sec INTEGER');
      // Nullable so clients that don't yet send the field can insert cleanly via
      // the generic upsertRow (which passes null for missing cols). Treat null as 0.
      addColumnIfMissing('sessions', 'accumulated_paused_ms',
        'ALTER TABLE sessions ADD COLUMN accumulated_paused_ms INTEGER');
      addColumnIfMissing('sessions', 'pending_actuals',
        'ALTER TABLE sessions ADD COLUMN pending_actuals TEXT');
      // Dedupe session_sets before adding the unique index — pre-Phase-2 logSet
      // always generated a new id per call, so edit attempts produced multiple rows
      // per tuple. Keep the newest (highest updated_at) per tuple, delete the rest.
      database.exec(`
        DELETE FROM session_sets
        WHERE id IN (
          SELECT id FROM session_sets ss1
          WHERE EXISTS (
            SELECT 1 FROM session_sets ss2
            WHERE ss2.session_id = ss1.session_id
              AND ss2.block_position = ss1.block_position
              AND ss2.block_exercise_position = ss1.block_exercise_position
              AND ss2.round_number = ss1.round_number
              AND ss2.set_number = ss1.set_number
              AND (ss2.updated_at > ss1.updated_at
                   OR (ss2.updated_at = ss1.updated_at AND ss2.id > ss1.id))
          )
        )
      `);
      // Belt-and-suspenders: prevent duplicate session_sets rows with the same tuple.
      // Phase 2 introduces edit-mode which must upsert, not insert; this catches client drift.
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_session_sets_tuple
          ON session_sets(session_id, block_position, block_exercise_position, round_number, set_number)
      `);
    }
  },
  // v3 — per-round targets: add round_number to block_exercise_sets.
  // Existing rows get round_number = 1 (round-1 anchor). UNIQUE constraint changes
  // from (block_exercise_id, set_number) to (block_exercise_id, round_number, set_number),
  // which requires a table rebuild (SQLite can't ALTER a UNIQUE in place).
  // Idempotent: skips if round_number already exists. The migration runs inside
  // the outer `apply` transaction in runMigrations, so a crash mid-rebuild is atomic.
  {
    version: 3,
    up(database) {
      const cols = database.prepare('PRAGMA table_info(block_exercise_sets)').all();
      if (cols.some((c) => c.name === 'round_number')) return;
      // NOTE: pre-migration VACUUM INTO snapshot is taken by the caller
      // BEFORE entering the migration transaction (see takePreV3Snapshot).
      // VACUUM cannot run inside an active transaction, so we can't do it here.
      database.exec(`
        CREATE TABLE block_exercise_sets_v3 (
          id TEXT PRIMARY KEY,
          block_exercise_id TEXT NOT NULL,
          set_number INTEGER NOT NULL CHECK (set_number >= 1),
          round_number INTEGER NOT NULL DEFAULT 1 CHECK (round_number >= 1),
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
          UNIQUE(block_exercise_id, round_number, set_number),
          CHECK (NOT (target_weight IS NOT NULL AND target_pct_1rm IS NOT NULL))
        );
        INSERT INTO block_exercise_sets_v3 (
          id, block_exercise_id, set_number, round_number,
          target_weight, target_pct_1rm, target_reps, target_reps_each,
          target_duration_sec, target_rpe, is_peak, rest_after_sec, notes,
          created_at, updated_at
        )
        SELECT id, block_exercise_id, set_number, 1,
               target_weight, target_pct_1rm, target_reps, target_reps_each,
               target_duration_sec, target_rpe, is_peak, rest_after_sec, notes,
               created_at, updated_at
          FROM block_exercise_sets;
        DROP TABLE block_exercise_sets;
        ALTER TABLE block_exercise_sets_v3 RENAME TO block_exercise_sets;
        CREATE INDEX IF NOT EXISTS idx_bes_be ON block_exercise_sets(block_exercise_id, round_number, set_number);
        CREATE INDEX IF NOT EXISTS idx_bes_updated ON block_exercise_sets(updated_at);
      `);
    }
  },
  // v4 — add per-set skipped flag + per-block done-flag JSON to support the
  // 5-state tile model on OverviewScreen (done/complete, done/partial,
  // skipped/empty, skipped/partial, untouched). Idempotent: skips columns
  // that already exist.
  {
    version: 4,
    up(database) {
      const ssCols = database.prepare('PRAGMA table_info(session_sets)').all();
      if (!ssCols.some((c) => c.name === 'skipped')) {
        database.exec('ALTER TABLE session_sets ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0');
      }
      const sCols = database.prepare('PRAGMA table_info(sessions)').all();
      if (!sCols.some((c) => c.name === 'done_block_ids')) {
        database.exec('ALTER TABLE sessions ADD COLUMN done_block_ids TEXT');
      }
    }
  }
];

function runMigrations(database) {
  const row = database.prepare('SELECT version FROM schema_version WHERE id = 1').get();
  const current = row ? row.version : 0;

  const pending = MIGRATIONS.filter(m => m.version > current)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    // Make sure the schema_version row exists even on fresh DBs that run no migrations.
    if (!row) {
      database.prepare(
        'INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?, ?)'
      ).run(CURRENT_SCHEMA_VERSION, Date.now());
    }
    return;
  }

  const apply = database.transaction(() => {
    for (const m of pending) {
      m.up(database);
    }
    const latest = pending[pending.length - 1].version;
    const now = Date.now();
    database.prepare(`
      INSERT INTO schema_version (id, version, updated_at)
      VALUES (1, @version, @updated_at)
      ON CONFLICT(id) DO UPDATE SET version = @version, updated_at = @updated_at
    `).run({ version: latest, updated_at: now });
  });

  apply();
}

/**
 * Take a disk snapshot of `database` if the current schema_version is less
 * than `targetVersion` and the DB is backed by a file. Best-effort safety net
 * for destructive migrations (v3's table rebuild). Must be called outside any
 * transaction — SQLite forbids VACUUM inside one.
 */
function takePreV3Snapshot(database) {
  try {
    const row = database.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    const current = row ? row.version : 0;
    if (current >= 3) return null;
    const dbPath = database.name;
    if (!dbPath || typeof dbPath !== 'string' || dbPath === ':memory:') return null;
    const path = require('path');
    const snapshotPath = path.join(
      path.dirname(dbPath),
      `${path.basename(dbPath, path.extname(dbPath))}-pre-v3-${Date.now()}.db`
    );
    database.prepare('VACUUM INTO ?').run(snapshotPath);
    return snapshotPath;
  } catch (err) {
    console.warn('[migration] pre-v3 snapshot failed; continuing:', err.message);
    return null;
  }
}

module.exports = { MIGRATIONS, CURRENT_SCHEMA_VERSION, runMigrations, takePreV3Snapshot };
