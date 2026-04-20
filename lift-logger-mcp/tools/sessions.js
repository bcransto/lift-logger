const { db } = require('../db');

/**
 * get_session_history — sessions (+ aggregated stats) ordered by started_at DESC.
 * Optionally filter by workoutId, date range, or limit.
 */
function getSessionHistory({ workoutId, startDate, endDate, limit = 50 } = {}) {
  const where = ['s.is_deleted = 0'];
  const params = [];

  if (workoutId) {
    where.push('s.workout_id = ?');
    params.push(workoutId);
  }
  if (startDate !== undefined && startDate !== null) {
    where.push('s.started_at >= ?');
    params.push(Number(startDate));
  }
  if (endDate !== undefined && endDate !== null) {
    where.push('s.started_at <= ?');
    params.push(Number(endDate));
  }

  const sql = `
    SELECT s.*, w.name AS workout_name,
           (SELECT COUNT(*) FROM session_sets ss
              WHERE ss.session_id = s.id AND ss.is_deleted = 0) AS set_count,
           (SELECT COUNT(DISTINCT ss.exercise_id) FROM session_sets ss
              WHERE ss.session_id = s.id AND ss.is_deleted = 0) AS exercise_count,
           (SELECT ROUND(SUM(ss.weight * ss.reps), 2) FROM session_sets ss
              WHERE ss.session_id = s.id AND ss.is_deleted = 0
                AND ss.is_warmup = 0
                AND ss.weight IS NOT NULL AND ss.reps IS NOT NULL) AS total_volume
    FROM sessions s
    LEFT JOIN workouts w ON w.id = s.workout_id
    WHERE ${where.join(' AND ')}
    ORDER BY s.started_at DESC
    LIMIT ?
  `;
  params.push(Number(limit));

  return db.prepare(sql).all(...params).map(r => ({
    id: r.id,
    workoutId: r.workout_id,
    workoutName: r.workout_name,
    name: r.name,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    notes: r.notes,
    setCount: r.set_count,
    exerciseCount: r.exercise_count,
    totalVolume: r.total_volume,
    updatedAt: r.updated_at
  }));
}

/**
 * get_session — single session with all sets grouped by exercise.
 */
function getSession({ sessionId }) {
  const session = db.prepare(`
    SELECT s.*, w.name AS workout_name
    FROM sessions s
    LEFT JOIN workouts w ON w.id = s.workout_id
    WHERE s.id = ? AND s.is_deleted = 0
  `).get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  const sets = db.prepare(`
    SELECT ss.*, e.name AS exercise_name
    FROM session_sets ss
    LEFT JOIN exercises e ON e.id = ss.exercise_id
    WHERE ss.session_id = ? AND ss.is_deleted = 0
    ORDER BY ss.performed_at ASC, ss.set_number ASC
  `).all(sessionId);

  const byExercise = new Map();
  for (const s of sets) {
    if (!byExercise.has(s.exercise_id)) {
      byExercise.set(s.exercise_id, {
        exerciseId: s.exercise_id,
        exerciseName: s.exercise_name,
        sets: []
      });
    }
    byExercise.get(s.exercise_id).sets.push({
      id: s.id,
      setNumber: s.set_number,
      weight: s.weight,
      reps: s.reps,
      rpe: s.rpe,
      performedAt: s.performed_at,
      isWarmup: s.is_warmup === 1,
      isPr: s.is_pr === 1,
      notes: s.notes
    });
  }

  return {
    id: session.id,
    workoutId: session.workout_id,
    workoutName: session.workout_name,
    name: session.name,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    notes: session.notes,
    updatedAt: session.updated_at,
    exercises: Array.from(byExercise.values())
  };
}

/**
 * get_exercise_history — all sets for one exercise over time, newest-first.
 */
function getExerciseHistory({ exerciseId, startDate, endDate, limit = 200 }) {
  if (!exerciseId) throw new Error('exerciseId is required');

  const where = ['ss.exercise_id = ?', 'ss.is_deleted = 0'];
  const params = [exerciseId];
  if (startDate !== undefined && startDate !== null) {
    where.push('ss.performed_at >= ?');
    params.push(Number(startDate));
  }
  if (endDate !== undefined && endDate !== null) {
    where.push('ss.performed_at <= ?');
    params.push(Number(endDate));
  }

  const rows = db.prepare(`
    SELECT ss.*, e.name AS exercise_name, s.workout_id, w.name AS workout_name
    FROM session_sets ss
    LEFT JOIN exercises e ON e.id = ss.exercise_id
    LEFT JOIN sessions s ON s.id = ss.session_id
    LEFT JOIN workouts w ON w.id = s.workout_id
    WHERE ${where.join(' AND ')}
    ORDER BY ss.performed_at DESC, ss.set_number ASC
    LIMIT ?
  `).all(...params, Number(limit));

  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    workoutId: r.workout_id,
    workoutName: r.workout_name,
    exerciseId: r.exercise_id,
    exerciseName: r.exercise_name,
    setNumber: r.set_number,
    weight: r.weight,
    reps: r.reps,
    rpe: r.rpe,
    performedAt: r.performed_at,
    isWarmup: r.is_warmup === 1,
    isPr: r.is_pr === 1
  }));
}

/**
 * query_session_sets — flexible filter.
 */
function querySessionSets({
  exerciseId, sessionId, workoutId,
  startDate, endDate,
  minWeight, maxWeight, minReps, maxReps,
  includeWarmup = false,
  limit = 500
} = {}) {
  const where = ['ss.is_deleted = 0'];
  const params = [];

  if (exerciseId) { where.push('ss.exercise_id = ?'); params.push(exerciseId); }
  if (sessionId)  { where.push('ss.session_id = ?');  params.push(sessionId); }
  if (workoutId)  { where.push('s.workout_id = ?');   params.push(workoutId); }
  if (!includeWarmup) where.push('ss.is_warmup = 0');
  if (startDate !== undefined && startDate !== null) {
    where.push('ss.performed_at >= ?'); params.push(Number(startDate));
  }
  if (endDate !== undefined && endDate !== null) {
    where.push('ss.performed_at <= ?'); params.push(Number(endDate));
  }
  if (minWeight !== undefined) { where.push('ss.weight >= ?'); params.push(Number(minWeight)); }
  if (maxWeight !== undefined) { where.push('ss.weight <= ?'); params.push(Number(maxWeight)); }
  if (minReps !== undefined)   { where.push('ss.reps >= ?');   params.push(Number(minReps)); }
  if (maxReps !== undefined)   { where.push('ss.reps <= ?');   params.push(Number(maxReps)); }

  const sql = `
    SELECT ss.*, e.name AS exercise_name, s.workout_id, w.name AS workout_name
    FROM session_sets ss
    LEFT JOIN exercises e ON e.id = ss.exercise_id
    LEFT JOIN sessions s ON s.id = ss.session_id
    LEFT JOIN workouts w ON w.id = s.workout_id
    WHERE ${where.join(' AND ')}
    ORDER BY ss.performed_at DESC, ss.set_number ASC
    LIMIT ?
  `;
  params.push(Number(limit));
  return db.prepare(sql).all(...params).map(r => ({
    id: r.id,
    sessionId: r.session_id,
    exerciseId: r.exercise_id,
    exerciseName: r.exercise_name,
    workoutId: r.workout_id,
    workoutName: r.workout_name,
    setNumber: r.set_number,
    weight: r.weight,
    reps: r.reps,
    rpe: r.rpe,
    performedAt: r.performed_at,
    isWarmup: r.is_warmup === 1,
    isPr: r.is_pr === 1
  }));
}

module.exports = { getSessionHistory, getSession, getExerciseHistory, querySessionSets };
