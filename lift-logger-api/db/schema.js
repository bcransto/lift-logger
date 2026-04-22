/**
 * IRON schema — 8 domain tables + schema_version.
 *
 * Matches docs/iron-backend-plan.md and the frontend TS types at
 * lift-logger-frontend/src/types/schema.ts exactly.
 *
 * Conventions:
 *  - All ids are TEXT (client-generated / UUID-ish)
 *  - All timestamps are INTEGER epoch millis
 *  - All booleans are INTEGER 0/1
 *  - LWW conflict resolution uses `updated_at`
 */
const schema = `
-- ---------- schema_version (migration tracking) ----------
CREATE TABLE IF NOT EXISTS schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------- exercises ----------
CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  equipment TEXT NOT NULL DEFAULT '[]',       -- JSON array string
  muscle_groups TEXT NOT NULL DEFAULT '[]',   -- JSON array string
  movement_type TEXT,                          -- squat|hinge|push|pull|carry|iso|plyo|cardio
  is_unilateral INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exercises_starred ON exercises(starred);
CREATE INDEX IF NOT EXISTS idx_exercises_updated ON exercises(updated_at);

-- ---------- workouts (templates) ----------
CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  tags TEXT NOT NULL DEFAULT '[]',             -- JSON array string
  starred INTEGER NOT NULL DEFAULT 0,
  est_duration INTEGER,                         -- minutes
  created_by TEXT NOT NULL DEFAULT 'user'
    CHECK (created_by IN ('user', 'agent')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_performed INTEGER
);
CREATE INDEX IF NOT EXISTS idx_workouts_starred ON workouts(starred);
CREATE INDEX IF NOT EXISTS idx_workouts_last_performed ON workouts(last_performed);
CREATE INDEX IF NOT EXISTS idx_workouts_updated ON workouts(updated_at);

-- ---------- workout_blocks ----------
CREATE TABLE IF NOT EXISTS workout_blocks (
  id TEXT PRIMARY KEY,
  workout_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('single', 'superset', 'circuit')),
  rounds INTEGER NOT NULL DEFAULT 1,
  -- rest_after_sec: rest AFTER this block finishes. For superset/circuit with
  -- rounds > 1 it's between-rounds rest; for single blocks it's between-block
  -- rest (drives the block timer countdown on last-set tap).
  rest_after_sec INTEGER,
  setup_cue TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workout_id, position)
);
CREATE INDEX IF NOT EXISTS idx_blocks_workout ON workout_blocks(workout_id, position);
CREATE INDEX IF NOT EXISTS idx_blocks_updated ON workout_blocks(updated_at);

-- ---------- block_exercises ----------
CREATE TABLE IF NOT EXISTS block_exercises (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  alt_exercise_ids TEXT NOT NULL DEFAULT '[]', -- JSON array string
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(block_id, position)
);
CREATE INDEX IF NOT EXISTS idx_block_exercises_block ON block_exercises(block_id, position);
CREATE INDEX IF NOT EXISTS idx_block_exercises_exercise ON block_exercises(exercise_id);
CREATE INDEX IF NOT EXISTS idx_block_exercises_updated ON block_exercises(updated_at);

-- ---------- block_exercise_sets ----------
-- round_number semantics (v3): for kind='single' blocks it's always 1. For
-- kind='superset'|'circuit', round_number=1 is the mandatory anchor row per
-- (block_exercise_id, set_number); rows with round_number > 1 are PARTIAL
-- overrides — null columns inherit from the round-1 anchor at snapshot-build
-- time. Orphan rows (round_number > workout_blocks.rounds) are preserved but
-- filtered out by the snapshot builder so author intent survives shrink→regrow.
CREATE TABLE IF NOT EXISTS block_exercise_sets (
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
CREATE INDEX IF NOT EXISTS idx_bes_be ON block_exercise_sets(block_exercise_id, round_number, set_number);
CREATE INDEX IF NOT EXISTS idx_bes_updated ON block_exercise_sets(updated_at);

-- ---------- sessions ----------
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workout_id TEXT,
  workout_snapshot TEXT NOT NULL,              -- JSON of WorkoutSnapshot
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_sec INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'abandoned')),
  notes TEXT,
  save_preference TEXT
    CHECK (save_preference IS NULL OR save_preference IN ('session_only', 'template')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_workout ON sessions(workout_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

-- ---------- session_sets ----------
CREATE TABLE IF NOT EXISTS session_sets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  block_position INTEGER NOT NULL,
  block_exercise_position INTEGER NOT NULL,
  round_number INTEGER NOT NULL DEFAULT 1,
  set_number INTEGER NOT NULL CHECK (set_number >= 1),
  target_weight REAL,
  target_reps INTEGER,
  target_duration_sec INTEGER,
  actual_weight REAL,
  actual_reps INTEGER,
  actual_duration_sec INTEGER,
  rpe INTEGER,
  rest_taken_sec INTEGER,
  is_pr INTEGER NOT NULL DEFAULT 0,
  was_swapped INTEGER NOT NULL DEFAULT 0,
  logged_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_sets_session ON session_sets(session_id);
CREATE INDEX IF NOT EXISTS idx_session_sets_exercise ON session_sets(exercise_id, logged_at);
CREATE INDEX IF NOT EXISTS idx_session_sets_pr ON session_sets(exercise_id, is_pr);
CREATE INDEX IF NOT EXISTS idx_session_sets_updated ON session_sets(updated_at);

-- ---------- exercise_prs ----------
CREATE TABLE IF NOT EXISTS exercise_prs (
  id TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL,
  pr_type TEXT NOT NULL CHECK (pr_type IN ('weight', 'reps', 'volume', '1rm_est')),
  value REAL NOT NULL,
  reps INTEGER,
  weight REAL,
  achieved_at INTEGER NOT NULL,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(exercise_id, pr_type)
);
CREATE INDEX IF NOT EXISTS idx_prs_exercise ON exercise_prs(exercise_id);
CREATE INDEX IF NOT EXISTS idx_prs_updated ON exercise_prs(updated_at);
`;

module.exports = schema;
