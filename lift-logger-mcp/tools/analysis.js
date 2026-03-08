const db = require('../db');

function getVolumeSummary({ startDate, endDate, groupBy }) {
  let groupExpr, groupLabel;

  switch (groupBy) {
    case 'exercise':
      groupExpr = 'r.exercise_id';
      groupLabel = 'e.name';
      break;
    case 'workout':
      groupExpr = 'r.workout_id';
      groupLabel = 'w.name';
      break;
    case 'week':
      // ISO week: group by year-week
      groupExpr = "strftime('%Y-W%W', r.date)";
      groupLabel = "strftime('%Y-W%W', r.date)";
      break;
    case 'day':
      groupExpr = 'r.date';
      groupLabel = 'r.date';
      break;
    default:
      throw new Error(`Invalid groupBy: ${groupBy}. Must be one of: exercise, workout, week, day`);
  }

  const sql = `
    SELECT ${groupExpr} AS group_key,
           ${groupLabel} AS group_label,
           COUNT(*) AS total_sets,
           SUM(r.reps) AS total_reps,
           ROUND(SUM(r.weight * r.reps), 1) AS total_volume
    FROM records r
    LEFT JOIN exercises e ON r.exercise_id = e.id
    LEFT JOIN workouts w ON r.workout_id = w.id
    WHERE r.date >= ? AND r.date <= ?
    GROUP BY group_key
    ORDER BY ${groupBy === 'exercise' || groupBy === 'workout' ? 'total_volume DESC' : 'group_key ASC'}
  `;

  const rows = db.prepare(sql).all(startDate, endDate);

  return rows.map(row => ({
    group: row.group_label || row.group_key || 'Unknown',
    totalSets: row.total_sets,
    totalReps: row.total_reps,
    totalVolume: row.total_volume
  }));
}

function queryRecords({ exerciseId, workoutId, startDate, endDate, minWeight, maxWeight } = {}) {
  let sql = `
    SELECT r.id, r.date, r.workout_id, w.name AS workout_name,
           r.exercise_id, e.name AS exercise_name,
           r.set_num, r.weight, r.reps, r.timestamp
    FROM records r
    LEFT JOIN exercises e ON r.exercise_id = e.id
    LEFT JOIN workouts w ON r.workout_id = w.id
    WHERE 1=1
  `;
  const params = [];

  if (exerciseId) {
    sql += ' AND r.exercise_id = ?';
    params.push(exerciseId);
  }
  if (workoutId) {
    sql += ' AND r.workout_id = ?';
    params.push(workoutId);
  }
  if (startDate) {
    sql += ' AND r.date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND r.date <= ?';
    params.push(endDate);
  }
  if (minWeight !== undefined) {
    sql += ' AND r.weight >= ?';
    params.push(minWeight);
  }
  if (maxWeight !== undefined) {
    sql += ' AND r.weight <= ?';
    params.push(maxWeight);
  }

  sql += ' ORDER BY r.date DESC, r.timestamp ASC, r.set_num ASC LIMIT 500';

  const rows = db.prepare(sql).all(...params);

  return rows.map(row => ({
    id: row.id,
    date: row.date,
    workoutId: row.workout_id,
    workoutName: row.workout_name || 'Unknown Workout',
    exerciseId: row.exercise_id,
    exerciseName: row.exercise_name || 'Unknown Exercise',
    set: row.set_num,
    weight: row.weight,
    reps: row.reps,
    timestamp: row.timestamp
  }));
}

module.exports = { getVolumeSummary, queryRecords };
