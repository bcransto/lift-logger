const db = require('../db');
const crypto = require('crypto');

function listWorkouts() {
  const rows = db.prepare('SELECT id, name, exercises FROM workouts ORDER BY name').all();
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    exercises: JSON.parse(row.exercises)
  }));
}

function getWorkoutHistory({ startDate, endDate, workoutId, limit } = {}) {
  let sql = `
    SELECT r.date, r.workout_id, w.name AS workout_name,
           r.exercise_id, e.name AS exercise_name,
           r.set_num, r.weight, r.reps, r.timestamp
    FROM records r
    LEFT JOIN workouts w ON r.workout_id = w.id
    LEFT JOIN exercises e ON r.exercise_id = e.id
    WHERE 1=1
  `;
  const params = [];

  if (startDate) {
    sql += ' AND r.date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND r.date <= ?';
    params.push(endDate);
  }
  if (workoutId) {
    sql += ' AND r.workout_id = ?';
    params.push(workoutId);
  }

  sql += ' ORDER BY r.date DESC, r.timestamp ASC, r.set_num ASC';

  const rows = db.prepare(sql).all(...params);

  // Group by date + workout
  const grouped = {};
  for (const row of rows) {
    const key = `${row.date}_${row.workout_id}`;
    if (!grouped[key]) {
      grouped[key] = {
        date: row.date,
        workoutId: row.workout_id,
        workoutName: row.workout_name || 'Unknown Workout',
        exercises: {}
      };
    }
    const session = grouped[key];
    if (!session.exercises[row.exercise_id]) {
      session.exercises[row.exercise_id] = {
        exerciseId: row.exercise_id,
        exerciseName: row.exercise_name || 'Unknown Exercise',
        sets: []
      };
    }
    session.exercises[row.exercise_id].sets.push({
      set: row.set_num,
      weight: row.weight,
      reps: row.reps
    });
  }

  // Convert exercises object to array and apply limit
  let sessions = Object.values(grouped).map(session => ({
    ...session,
    exercises: Object.values(session.exercises)
  }));

  if (limit) {
    sessions = sessions.slice(0, limit);
  }

  return sessions;
}

function createWorkout({ name, exerciseIds }) {
  // Validate exercise IDs exist
  const exercises = [];
  for (const exerciseId of exerciseIds) {
    const exercise = db.prepare('SELECT id, name FROM exercises WHERE id = ? AND is_deleted = 0').get(exerciseId);
    if (!exercise) {
      throw new Error(`Exercise not found: ${exerciseId}`);
    }
    exercises.push({ exerciseId: exercise.id, name: exercise.name });
  }

  const id = `workout_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const updatedAt = Date.now();

  db.prepare(`
    INSERT INTO workouts (id, name, exercises, updated_at)
    VALUES (?, ?, ?, ?)
  `).run(id, name, JSON.stringify(exercises), updatedAt);

  return { id, name, exercises, updatedAt };
}

module.exports = { listWorkouts, getWorkoutHistory, createWorkout };
