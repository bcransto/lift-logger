const { db } = require('../db');

/**
 * get_prs — exercise_prs joined with exercise names. Optionally filter by
 * exerciseId or pr_type. Rows are ONLY written by the sync handler's PR
 * computation, never by MCP.
 */
function getPRs({ exerciseId, prType } = {}) {
  const where = [];
  const params = [];

  if (exerciseId) { where.push('pr.exercise_id = ?'); params.push(exerciseId); }
  if (prType)     { where.push('pr.pr_type = ?');     params.push(prType); }

  const sql = `
    SELECT pr.*, e.name AS exercise_name
    FROM exercise_prs pr
    LEFT JOIN exercises e ON e.id = pr.exercise_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.name ASC, pr.pr_type ASC
  `;

  return db.prepare(sql).all(...params).map((r) => ({
    id: r.id,
    exerciseId: r.exercise_id,
    exerciseName: r.exercise_name,
    prType: r.pr_type,
    value: r.value,
    weight: r.weight,
    reps: r.reps,
    sessionId: r.session_id,
    achievedAt: r.achieved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * get_volume_summary — aggregate set count / reps / volume grouped by
 * exercise | workout | week | day. Date args are epoch millis.
 *
 * Uses actual_weight and actual_reps (not targets).
 */
function getVolumeSummary({ startDate, endDate, groupBy }) {
  if (startDate === undefined || endDate === undefined) {
    throw new Error('startDate and endDate (epoch millis) are required');
  }

  let groupExpr, groupLabel;

  switch (groupBy) {
    case 'exercise':
      groupExpr = 'ss.exercise_id';
      groupLabel = 'e.name';
      break;
    case 'workout':
      groupExpr = 's.workout_id';
      groupLabel = 'w.name';
      break;
    case 'week':
      groupExpr = "strftime('%Y-W%W', datetime(ss.logged_at/1000, 'unixepoch'))";
      groupLabel = groupExpr;
      break;
    case 'day':
      groupExpr = "strftime('%Y-%m-%d', datetime(ss.logged_at/1000, 'unixepoch'))";
      groupLabel = groupExpr;
      break;
    default:
      throw new Error(`Invalid groupBy: ${groupBy}. Must be exercise | workout | week | day`);
  }

  const sql = `
    SELECT ${groupExpr} AS group_key,
           ${groupLabel} AS group_label,
           COUNT(*) AS total_sets,
           SUM(ss.actual_reps) AS total_reps,
           ROUND(SUM(ss.actual_weight * ss.actual_reps), 2) AS total_volume
    FROM session_sets ss
    LEFT JOIN exercises e ON e.id = ss.exercise_id
    LEFT JOIN sessions s ON s.id = ss.session_id
    LEFT JOIN workouts w ON w.id = s.workout_id
    WHERE ss.actual_weight IS NOT NULL
      AND ss.actual_reps IS NOT NULL
      AND ss.logged_at >= ?
      AND ss.logged_at <= ?
    GROUP BY group_key
    ORDER BY ${groupBy === 'exercise' || groupBy === 'workout' ? 'total_volume DESC' : 'group_key ASC'}
  `;

  return db.prepare(sql).all(Number(startDate), Number(endDate)).map((r) => ({
    group: r.group_label || r.group_key || 'Unknown',
    totalSets: r.total_sets,
    totalReps: r.total_reps,
    totalVolume: r.total_volume,
  }));
}

module.exports = { getPRs, getVolumeSummary };
