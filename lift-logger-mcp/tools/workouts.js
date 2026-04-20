const { db, readWorkoutTree, upsertWorkoutTree, softDeleteWorkoutTree } = require('../db');

/**
 * list_workouts — summary of each non-deleted workout (id, name, block count,
 * exercise count). Use get_workout for the full tree.
 */
function listWorkouts({ includeDeleted = false } = {}) {
  const workouts = db.prepare(
    includeDeleted
      ? 'SELECT id, name, description, is_deleted, updated_at FROM workouts ORDER BY name ASC'
      : 'SELECT id, name, description, is_deleted, updated_at FROM workouts WHERE is_deleted = 0 ORDER BY name ASC'
  ).all();

  const countBlocks = db.prepare(
    'SELECT COUNT(*) AS n FROM workout_blocks WHERE workout_id = ? AND is_deleted = 0'
  );
  const countExercises = db.prepare(`
    SELECT COUNT(*) AS n
    FROM block_exercises be
    JOIN workout_blocks wb ON wb.id = be.block_id
    WHERE wb.workout_id = ? AND be.is_deleted = 0 AND wb.is_deleted = 0
  `);

  return workouts.map(w => ({
    id: w.id,
    name: w.name,
    description: w.description,
    isDeleted: w.is_deleted === 1,
    updatedAt: w.updated_at,
    blockCount: countBlocks.get(w.id).n,
    exerciseCount: countExercises.get(w.id).n
  }));
}

/**
 * get_workout — full nested tree for a single workout.
 */
function getWorkout({ workoutId }) {
  const tree = readWorkoutTree(workoutId);
  if (!tree) throw new Error(`workout not found: ${workoutId}`);
  return tree;
}

/**
 * create_workout — create a new workout tree.
 * Missing ids, positions, and set_numbers are auto-assigned.
 */
function createWorkout(payload) {
  // Force a new id so we never collide by accident.
  const tree = { ...payload, id: undefined };
  return upsertWorkoutTree(tree);
}

/**
 * update_workout — upsert an existing workout tree. `id` is required.
 * Note: rows present in the old tree but absent from the new payload are NOT
 * auto-deleted — callers should pass explicit `id`s for anything they want
 * preserved, and use delete_workout for full removal. For destructive edits,
 * the caller should supply fresh ids for any rebuilt children.
 */
function updateWorkout(payload) {
  if (!payload.id) throw new Error('update_workout: id is required');
  return upsertWorkoutTree(payload);
}

/**
 * delete_workout — soft-delete a workout and its entire tree.
 */
function deleteWorkout({ workoutId }) {
  const ok = softDeleteWorkoutTree(workoutId);
  if (!ok) throw new Error(`workout not found: ${workoutId}`);
  return { id: workoutId, deleted: true };
}

module.exports = { listWorkouts, getWorkout, createWorkout, updateWorkout, deleteWorkout };
