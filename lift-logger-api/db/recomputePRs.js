/**
 * From-scratch PR recomputation for one exercise.
 *
 * Used by POST /api/sessions/:id/delete: after a session is hard-deleted, any
 * exercise it touched needs its `exercise_prs` rows rebuilt from surviving
 * `session_sets` so PR state remains truthful. The incremental
 * `recomputePRsForSessionSet` helper in db/database.js can only ever push the
 * value up — it doesn't know how to roll PRs back when a record is removed.
 *
 * Mirrors `recomputeExercisePRsFromScratch` in lift-logger-mcp/db.js — keep the
 * two implementations in sync if you change the formulas (Epley 1RM, rep cap,
 * etc.). Duplicated rather than shared because the two packages don't share a
 * module boundary.
 */

const { estimate1RM } = require('./database');

function nowMs() {
  return Date.now();
}

/**
 * Recompute the four exercise_prs rows (weight, reps, volume, 1rm_est) for one
 * exercise from scratch by scanning all surviving session_sets. Replaces the
 * existing rows or deletes them if no qualifying set remains. Runs inside the
 * caller's transaction.
 *
 * Returns the number of pr rows written (0..4). Counts a delete as a write
 * since it's a state change clients should pull.
 *
 * NB: This is one of two places the API writes exercise_prs (the other is
 * recomputePRsForSessionSet during sync). Both bump updated_at = Date.now() so
 * the next sync pull sees the change.
 */
function recomputeExercisePRsFromScratch(exerciseId, txDb) {
  const rows = txDb.prepare(`
    SELECT actual_weight AS w, actual_reps AS r, session_id, logged_at
    FROM session_sets
    WHERE exercise_id = ?
      AND actual_weight IS NOT NULL
      AND actual_reps IS NOT NULL
  `).all(exerciseId);

  // Compute the new max for each pr_type from surviving rows.
  const best = {
    weight:    { value: -Infinity, weight: null, reps: null, session_id: null, achieved_at: null },
    reps:      { value: -Infinity, weight: null, reps: null, session_id: null, achieved_at: null },
    volume:    { value: -Infinity, weight: null, reps: null, session_id: null, achieved_at: null },
    '1rm_est': { value: -Infinity, weight: null, reps: null, session_id: null, achieved_at: null },
  };

  for (const r of rows) {
    const w = r.w;
    const reps = r.r;
    const consider = (type, val) => {
      if (val === null || val === undefined || !(val > 0)) return;
      if (val > best[type].value) {
        best[type] = {
          value: val,
          weight: w,
          reps,
          session_id: r.session_id,
          achieved_at: r.logged_at,
        };
      }
    };
    consider('weight', w);
    consider('reps', reps);
    consider('volume', w > 0 && reps > 0 ? w * reps : null);
    consider('1rm_est', estimate1RM(w, reps));
  }

  const types = ['weight', 'reps', 'volume', '1rm_est'];
  const now = nowMs();
  let written = 0;

  const upsertStmt = txDb.prepare(`
    INSERT INTO exercise_prs
      (id, exercise_id, pr_type, value, weight, reps, session_id, achieved_at, created_at, updated_at)
    VALUES
      (@id, @exercise_id, @pr_type, @value, @weight, @reps, @session_id, @achieved_at, @created_at, @updated_at)
    ON CONFLICT(exercise_id, pr_type) DO UPDATE SET
      value = @value,
      weight = @weight,
      reps = @reps,
      session_id = @session_id,
      achieved_at = @achieved_at,
      updated_at = @updated_at
  `);
  const deleteStmt = txDb.prepare(
    'DELETE FROM exercise_prs WHERE exercise_id = ? AND pr_type = ?'
  );
  const getExistingCreated = txDb.prepare(
    'SELECT created_at FROM exercise_prs WHERE exercise_id = ? AND pr_type = ?'
  );

  for (const type of types) {
    const b = best[type];
    if (b.value === -Infinity) {
      const info = deleteStmt.run(exerciseId, type);
      if (info.changes > 0) written++;
      continue;
    }
    const existing = getExistingCreated.get(exerciseId, type);
    upsertStmt.run({
      id: `pr_${exerciseId}_${type}`,
      exercise_id: exerciseId,
      pr_type: type,
      value: b.value,
      weight: b.weight,
      reps: b.reps,
      session_id: b.session_id,
      achieved_at: b.achieved_at,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
    written++;
  }

  return written;
}

module.exports = {
  recomputeExercisePRsFromScratch,
};
