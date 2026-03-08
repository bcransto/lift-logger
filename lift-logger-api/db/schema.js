const schema = `
CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workouts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  exercises TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  workout_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  set_num INTEGER NOT NULL,
  weight REAL NOT NULL,
  reps INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exercises_updated ON exercises(updated_at);
CREATE INDEX IF NOT EXISTS idx_workouts_updated ON workouts(updated_at);
CREATE INDEX IF NOT EXISTS idx_records_updated ON records(updated_at);
`;

module.exports = schema;
