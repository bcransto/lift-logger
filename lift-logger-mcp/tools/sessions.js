const { db } = require('../db');

function rowToSessionSet(r) {
  return {
    id: r.id,
    sessionId: r.session_id,
    exerciseId: r.exercise_id,
    exerciseName: r.exercise_name,
    workoutId: r.workout_id,
    workoutName: r.workout_name,
    blockPosition: r.block_position,
    blockExercisePosition: r.block_exercise_position,
    roundNumber: r.round_number,
    setNumber: r.set_number,
    targetWeight: r.target_weight,
    targetReps: r.target_reps,
    targetDurationSec: r.target_duration_sec,
    actualWeight: r.actual_weight,
    actualReps: r.actual_reps,
    actualDurationSec: r.actual_duration_sec,
    rpe: r.rpe,
    restTakenSec: r.rest_taken_sec,
    isPr: r.is_pr === 1,
    wasSwapped: r.was_swapped === 1,
    loggedAt: r.logged_at,
  };
}

/**
 * get_session_history — sessions + aggregate stats, newest first.
 */
function getSessionHistory({ workoutId, status, startDate, endDate, limit = 50 } = {}) {
  const where = [];
  const params = [];

  if (workoutId) {
    where.push('s.workout_id = ?');
    params.push(workoutId);
  }
  if (status) {
    where.push('s.status = ?');
    params.push(status);
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
      (SELECT COUNT(*) FROM session_sets ss WHERE ss.session_id = s.id) AS set_count,
      (SELECT COUNT(DISTINCT ss.exercise_id) FROM session_sets ss WHERE ss.session_id = s.id) AS exercise_count,
      (SELECT ROUND(SUM(ss.actual_weight * ss.actual_reps), 2) FROM session_sets ss
         WHERE ss.session_id = s.id
           AND ss.actual_weight IS NOT NULL AND ss.actual_reps IS NOT NULL) AS total_volume,
      (SELECT COUNT(*) FROM session_sets ss WHERE ss.session_id = s.id AND ss.is_pr = 1) AS pr_count
    FROM sessions s
    LEFT JOIN workouts w ON w.id = s.workout_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.started_at DESC
    LIMIT ?
  `;
  params.push(Number(limit));

  return db.prepare(sql).all(...params).map((r) => ({
    id: r.id,
    workoutId: r.workout_id,
    workoutName: r.workout_name,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationSec: r.duration_sec,
    notes: r.notes,
    savePreference: r.save_preference,
    setCount: r.set_count,
    exerciseCount: r.exercise_count,
    totalVolume: r.total_volume,
    prCount: r.pr_count,
    updatedAt: r.updated_at,
    // Phase 2 fields
    pausedAt: r.paused_at ?? null,
    skippedBlockIds: safeParseArray(r.skipped_block_ids),
    accumulatedPausedMs: r.accumulated_paused_ms ?? 0,
  }));
}

function safeParseArray(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

/**
 * get_session — single session with all sets grouped by exercise, in logged order.
 */
function getSession({ sessionId }) {
  const session = db.prepare(`
    SELECT s.*, w.name AS workout_name
    FROM sessions s
    LEFT JOIN workouts w ON w.id = s.workout_id
    WHERE s.id = ?
  `).get(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);

  const sets = db.prepare(`
    SELECT ss.*, e.name AS exercise_name, s.workout_id, w.name AS workout_name
    FROM session_sets ss
    LEFT JOIN exercises e ON e.id = ss.exercise_id
    LEFT JOIN sessions s ON s.id = ss.session_id
    LEFT JOIN workouts w ON w.id = s.workout_id
    WHERE ss.session_id = ?
    ORDER BY ss.logged_at ASC, ss.set_number ASC
  `).all(sessionId);

  const byExercise = new Map();
  for (const s of sets) {
    if (!byExercise.has(s.exercise_id)) {
      byExercise.set(s.exercise_id, {
        exerciseId: s.exercise_id,
        exerciseName: s.exercise_name,
        sets: [],
      });
    }
    byExercise.get(s.exercise_id).sets.push(rowToSessionSet(s));
  }

  let snapshot = null;
  try { snapshot = JSON.parse(session.workout_snapshot); } catch { /* leave null */ }

  return {
    id: session.id,
    workoutId: session.workout_id,
    workoutName: session.workout_name,
    status: session.status,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    durationSec: session.duration_sec,
    savePreference: session.save_preference,
    notes: session.notes,
    updatedAt: session.updated_at,
    // Phase 2 fields
    pausedAt: session.paused_at ?? null,
    skippedBlockIds: safeParseArray(session.skipped_block_ids),
    accumulatedPausedMs: session.accumulated_paused_ms ?? 0,
    workTimerStartedAt: session.work_timer_started_at ?? null,
    workTimerDurationSec: session.work_timer_duration_sec ?? null,
    pendingActuals: session.pending_actuals ? (() => { try { return JSON.parse(session.pending_actuals); } catch { return null; } })() : null,
    snapshot,
    exercises: Array.from(byExercise.values()),
  };
}

/**
 * get_exercise_history — all sets for one exercise over time, newest-first.
 */
function getExerciseHistory({ exerciseId, startDate, endDate, limit = 200 }) {
  if (!exerciseId) throw new Error('exerciseId is required');

  const where = ['ss.exercise_id = ?'];
  const params = [exerciseId];
  if (startDate !== undefined && startDate !== null) {
    where.push('ss.logged_at >= ?');
    params.push(Number(startDate));
  }
  if (endDate !== undefined && endDate !== null) {
    where.push('ss.logged_at <= ?');
    params.push(Number(endDate));
  }

  const rows = db.prepare(`
    SELECT ss.*, e.name AS exercise_name, s.workout_id, w.name AS workout_name
    FROM session_sets ss
    LEFT JOIN exercises e ON e.id = ss.exercise_id
    LEFT JOIN sessions s ON s.id = ss.session_id
    LEFT JOIN workouts w ON w.id = s.workout_id
    WHERE ${where.join(' AND ')}
    ORDER BY ss.logged_at DESC, ss.set_number ASC
    LIMIT ?
  `).all(...params, Number(limit));

  return rows.map(rowToSessionSet);
}

/**
 * query_session_sets — flexible filter over session_sets. Operates on actual_*.
 */
function querySessionSets({
  exerciseId, sessionId, workoutId,
  startDate, endDate,
  minWeight, maxWeight, minReps, maxReps,
  prOnly = false,
  limit = 500,
} = {}) {
  const where = [];
  const params = [];

  if (exerciseId) { where.push('ss.exercise_id = ?'); params.push(exerciseId); }
  if (sessionId)  { where.push('ss.session_id = ?');  params.push(sessionId); }
  if (workoutId)  { where.push('s.workout_id = ?');   params.push(workoutId); }
  if (prOnly)     { where.push('ss.is_pr = 1'); }
  if (startDate !== undefined && startDate !== null) {
    where.push('ss.logged_at >= ?'); params.push(Number(startDate));
  }
  if (endDate !== undefined && endDate !== null) {
    where.push('ss.logged_at <= ?'); params.push(Number(endDate));
  }
  if (minWeight !== undefined) { where.push('ss.actual_weight >= ?'); params.push(Number(minWeight)); }
  if (maxWeight !== undefined) { where.push('ss.actual_weight <= ?'); params.push(Number(maxWeight)); }
  if (minReps !== undefined)   { where.push('ss.actual_reps >= ?');   params.push(Number(minReps)); }
  if (maxReps !== undefined)   { where.push('ss.actual_reps <= ?');   params.push(Number(maxReps)); }

  const sql = `
    SELECT ss.*, e.name AS exercise_name, s.workout_id, w.name AS workout_name
    FROM session_sets ss
    LEFT JOIN exercises e ON e.id = ss.exercise_id
    LEFT JOIN sessions s ON s.id = ss.session_id
    LEFT JOIN workouts w ON w.id = s.workout_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ss.logged_at DESC, ss.set_number ASC
    LIMIT ?
  `;
  params.push(Number(limit));
  return db.prepare(sql).all(...params).map(rowToSessionSet);
}

module.exports = { getSessionHistory, getSession, getExerciseHistory, querySessionSets };
