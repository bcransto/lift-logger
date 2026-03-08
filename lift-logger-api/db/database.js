const Database = require('better-sqlite3');
const path = require('path');
const schema = require('./schema');

const dbPath = path.join(__dirname, '..', 'data', 'liftlogger.db');
const db = new Database(dbPath);

// Initialize database with schema
db.exec(schema);

/**
 * Upsert an exercise (Last-Write-Wins: only update if incoming updated_at > existing)
 */
function upsertExercise(exercise) {
  const stmt = db.prepare(`
    INSERT INTO exercises (id, name, updated_at, is_deleted)
    VALUES (@id, @name, @updated_at, @is_deleted)
    ON CONFLICT(id) DO UPDATE SET
      name = @name,
      updated_at = @updated_at,
      is_deleted = @is_deleted
    WHERE @updated_at > exercises.updated_at
  `);
  return stmt.run({
    id: exercise.id,
    name: exercise.name,
    updated_at: exercise.updatedAt,
    is_deleted: exercise.isDeleted ? 1 : 0
  });
}

/**
 * Upsert a workout (Last-Write-Wins)
 */
function upsertWorkout(workout) {
  const stmt = db.prepare(`
    INSERT INTO workouts (id, name, exercises, updated_at)
    VALUES (@id, @name, @exercises, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name = @name,
      exercises = @exercises,
      updated_at = @updated_at
    WHERE @updated_at > workouts.updated_at
  `);
  return stmt.run({
    id: workout.id,
    name: workout.name,
    exercises: JSON.stringify(workout.exercises),
    updated_at: workout.updatedAt
  });
}

/**
 * Upsert a record (Last-Write-Wins)
 */
function upsertRecord(record) {
  const stmt = db.prepare(`
    INSERT INTO records (id, date, workout_id, exercise_id, set_num, weight, reps, timestamp, updated_at)
    VALUES (@id, @date, @workout_id, @exercise_id, @set_num, @weight, @reps, @timestamp, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      date = @date,
      workout_id = @workout_id,
      exercise_id = @exercise_id,
      set_num = @set_num,
      weight = @weight,
      reps = @reps,
      timestamp = @timestamp,
      updated_at = @updated_at
    WHERE @updated_at > records.updated_at
  `);
  return stmt.run({
    id: record.id,
    date: record.date,
    workout_id: record.workoutId,
    exercise_id: record.exerciseId,
    set_num: record.set,
    weight: record.weight,
    reps: record.reps,
    timestamp: record.timestamp,
    updated_at: record.updatedAt
  });
}

/**
 * Get all exercises updated since a given timestamp
 */
function getExercisesSince(timestamp) {
  const stmt = db.prepare('SELECT * FROM exercises WHERE updated_at > ?');
  const rows = stmt.all(timestamp);
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    updatedAt: row.updated_at,
    isDeleted: row.is_deleted === 1
  }));
}

/**
 * Get all workouts updated since a given timestamp
 */
function getWorkoutsSince(timestamp) {
  const stmt = db.prepare('SELECT * FROM workouts WHERE updated_at > ?');
  const rows = stmt.all(timestamp);
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    exercises: JSON.parse(row.exercises),
    updatedAt: row.updated_at
  }));
}

/**
 * Get all records updated since a given timestamp
 */
function getRecordsSince(timestamp) {
  const stmt = db.prepare('SELECT * FROM records WHERE updated_at > ?');
  const rows = stmt.all(timestamp);
  return rows.map(row => ({
    id: row.id,
    date: row.date,
    workoutId: row.workout_id,
    exerciseId: row.exercise_id,
    set: row.set_num,
    weight: row.weight,
    reps: row.reps,
    timestamp: row.timestamp,
    updatedAt: row.updated_at
  }));
}

/**
 * Apply client changes and return server changes
 */
function sync(lastSync, changes) {
  const { exercises = [], workouts = [], records = [] } = changes;

  // Apply client changes (LWW)
  for (const exercise of exercises) {
    upsertExercise(exercise);
  }
  for (const workout of workouts) {
    upsertWorkout(workout);
  }
  for (const record of records) {
    upsertRecord(record);
  }

  // Get server changes since lastSync
  const serverChanges = {
    exercises: getExercisesSince(lastSync),
    workouts: getWorkoutsSince(lastSync),
    records: getRecordsSince(lastSync)
  };

  // Use server timestamp to avoid clock skew
  const syncTimestamp = Date.now();

  return { serverChanges, syncTimestamp };
}

module.exports = {
  sync,
  upsertExercise,
  upsertWorkout,
  upsertRecord,
  getExercisesSince,
  getWorkoutsSince,
  getRecordsSince
};
