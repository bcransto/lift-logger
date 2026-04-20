const { db, readWorkoutTree, upsertWorkoutTree, deleteWorkoutTree } = require('../db');

function parseJsonArray(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * list_workouts — summary of each workout (no nested tree).
 */
function listWorkouts({ tag, starred, createdBy } = {}) {
  let sql = 'SELECT * FROM workouts';
  const params = {};
  const where = [];
  if (starred === true) where.push('starred = 1');
  if (tag) {
    where.push('tags LIKE @tag');
    params.tag = `%"${tag}"%`;
  }
  if (createdBy) {
    where.push('created_by = @createdBy');
    params.createdBy = createdBy;
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY name ASC';

  const workouts = db.prepare(sql).all(params);
  const countBlocks = db.prepare('SELECT COUNT(*) AS n FROM workout_blocks WHERE workout_id = ?');
  const countExercises = db.prepare(`
    SELECT COUNT(*) AS n
    FROM block_exercises be
    JOIN workout_blocks wb ON wb.id = be.block_id
    WHERE wb.workout_id = ?
  `);

  return workouts.map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description,
    tags: parseJsonArray(w.tags),
    starred: w.starred === 1,
    estDuration: w.est_duration,
    createdBy: w.created_by,
    createdAt: w.created_at,
    updatedAt: w.updated_at,
    lastPerformed: w.last_performed,
    blockCount: countBlocks.get(w.id).n,
    exerciseCount: countExercises.get(w.id).n,
  }));
}

/**
 * get_workout — full nested tree for a single workout.
 */
function getWorkout({ workoutId }) {
  const tree = readWorkoutTree(workoutId);
  if (!tree) throw new Error(`workout not found: ${workoutId}`);
  // Normalize JSON-array fields for the response.
  return {
    ...tree,
    tags: parseJsonArray(tree.tags),
    starred: tree.starred === 1,
    blocks: (tree.blocks ?? []).map((b) => ({
      ...b,
      exercises: (b.exercises ?? []).map((be) => ({
        ...be,
        alt_exercise_ids: parseJsonArray(be.alt_exercise_ids),
      })),
    })),
  };
}

/**
 * create_workout — create a new workout tree. created_by defaults to 'agent'.
 * Missing ids, positions, and set_numbers are auto-assigned.
 */
function createWorkout(payload) {
  const tree = { ...payload, id: undefined, created_by: payload.created_by ?? 'agent' };
  return upsertWorkoutTree(tree);
}

/**
 * update_workout — upsert an existing workout tree. `id` is required.
 * Merge-safe: children not mentioned in the payload are NOT deleted. Callers
 * should pass explicit ids for rows they want to keep, and use delete_workout
 * for full removal.
 */
function updateWorkout(payload) {
  if (!payload.id) throw new Error('update_workout: id is required');
  return upsertWorkoutTree(payload);
}

/**
 * delete_workout — hard-delete a workout and its entire tree.
 */
function deleteWorkout({ workoutId }) {
  const ok = deleteWorkoutTree(workoutId);
  if (!ok) throw new Error(`workout not found: ${workoutId}`);
  return { id: workoutId, deleted: true };
}

module.exports = { listWorkouts, getWorkout, createWorkout, updateWorkout, deleteWorkout };
