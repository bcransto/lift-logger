const db = require('../db');
const crypto = require('crypto');

function listExercises({ includeDeleted = false } = {}) {
  const sql = includeDeleted
    ? 'SELECT id, name, is_deleted FROM exercises ORDER BY name'
    : 'SELECT id, name FROM exercises WHERE is_deleted = 0 ORDER BY name';
  const rows = db.prepare(sql).all();
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    ...(includeDeleted && { isDeleted: row.is_deleted === 1 })
  }));
}

function getExerciseHistory({ exerciseId, startDate, endDate, limit }) {
  let sql = `
    SELECT r.date, r.workout_id, w.name AS workout_name,
           r.set_num, r.weight, r.reps, r.timestamp
    FROM records r
    LEFT JOIN workouts w ON r.workout_id = w.id
    WHERE r.exercise_id = ?
  `;
  const params = [exerciseId];

  if (startDate) {
    sql += ' AND r.date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND r.date <= ?';
    params.push(endDate);
  }

  sql += ' ORDER BY r.date DESC, r.set_num ASC';

  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const rows = db.prepare(sql).all(...params);

  // Get exercise name
  const exercise = db.prepare('SELECT name FROM exercises WHERE id = ?').get(exerciseId);
  const exerciseName = exercise ? exercise.name : 'Unknown Exercise';

  // Group by date
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.date]) {
      grouped[row.date] = {
        date: row.date,
        workoutName: row.workout_name || 'Unknown Workout',
        sets: []
      };
    }
    grouped[row.date].sets.push({
      set: row.set_num,
      weight: row.weight,
      reps: row.reps
    });
  }

  return {
    exerciseId,
    exerciseName,
    sessions: Object.values(grouped)
  };
}

function getPersonalRecords({ exerciseId } = {}) {
  let sql = `
    SELECT r.exercise_id, e.name AS exercise_name,
           MAX(r.weight) AS max_weight,
           MAX(r.reps) AS max_reps,
           MAX(r.weight * r.reps) AS max_volume
    FROM records r
    LEFT JOIN exercises e ON r.exercise_id = e.id
  `;
  const params = [];

  if (exerciseId) {
    sql += ' WHERE r.exercise_id = ?';
    params.push(exerciseId);
  }

  sql += ' GROUP BY r.exercise_id';

  const rows = db.prepare(sql).all(...params);

  // For each exercise, find the dates of each PR
  return rows.map(row => {
    const maxWeightDate = db.prepare(
      'SELECT date FROM records WHERE exercise_id = ? AND weight = ? LIMIT 1'
    ).get(row.exercise_id, row.max_weight);

    const maxRepsDate = db.prepare(
      'SELECT date FROM records WHERE exercise_id = ? AND reps = ? LIMIT 1'
    ).get(row.exercise_id, row.max_reps);

    const maxVolumeDate = db.prepare(
      'SELECT date FROM records WHERE exercise_id = ? AND (weight * reps) = ? LIMIT 1'
    ).get(row.exercise_id, row.max_volume);

    return {
      exerciseId: row.exercise_id,
      exerciseName: row.exercise_name || 'Unknown Exercise',
      maxWeight: { value: row.max_weight, date: maxWeightDate?.date },
      maxReps: { value: row.max_reps, date: maxRepsDate?.date },
      maxVolume: { value: row.max_volume, date: maxVolumeDate?.date }
    };
  });
}

function createExercise({ name }) {
  const id = `ex_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const updatedAt = Date.now();

  db.prepare(`
    INSERT INTO exercises (id, name, updated_at, is_deleted)
    VALUES (?, ?, ?, 0)
  `).run(id, name, updatedAt);

  return { id, name, updatedAt };
}

module.exports = { listExercises, getExerciseHistory, getPersonalRecords, createExercise };
