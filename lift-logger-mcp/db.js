/**
 * Shared SQLite handle for MCP tools.
 *
 * Points at the IRON database (`../lift-logger-api/data/iron.db`). MCP only
 * writes exercise_prs from delete_session's recompute path; otherwise that's
 * the sync handler's job. MCP also never opens a second handle to create
 * tables; the API server owns schema init.
 *
 * Matches the schema in lift-logger-api/db/schema.js and the frontend types
 * in lift-logger-frontend/src/types/schema.ts.
 */

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const dbPath = process.env.LIFT_LOGGER_DB_PATH
  || path.join(__dirname, '..', 'lift-logger-api', 'data', 'iron.db');
const db = new Database(dbPath, { readonly: false });

// Concurrent-safe reads alongside the API server.
db.pragma('journal_mode = WAL');

// -------------------- id / time helpers --------------------

function nowMs() { return Date.now(); }

function genId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

// -------------------- workout tree read --------------------

/**
 * Return a workout with its nested block → block_exercise → block_exercise_sets tree.
 */
function readWorkoutTree(workoutId) {
  const workout = db.prepare('SELECT * FROM workouts WHERE id = ?').get(workoutId);
  if (!workout) return null;

  const blocks = db.prepare(`
    SELECT * FROM workout_blocks
    WHERE workout_id = ?
    ORDER BY position ASC
  `).all(workoutId);

  const blockIds = blocks.map((b) => b.id);
  const blockExercises = blockIds.length === 0 ? [] : db.prepare(`
    SELECT be.*, e.name AS exercise_name
    FROM block_exercises be
    LEFT JOIN exercises e ON e.id = be.exercise_id
    WHERE be.block_id IN (${blockIds.map(() => '?').join(',')})
    ORDER BY be.block_id, be.position ASC
  `).all(...blockIds);

  const beIds = blockExercises.map((be) => be.id);
  const sets = beIds.length === 0 ? [] : db.prepare(`
    SELECT * FROM block_exercise_sets
    WHERE block_exercise_id IN (${beIds.map(() => '?').join(',')})
    ORDER BY block_exercise_id, round_number, set_number ASC
  `).all(...beIds);

  const setsByBE = new Map();
  for (const s of sets) {
    if (!setsByBE.has(s.block_exercise_id)) setsByBE.set(s.block_exercise_id, []);
    setsByBE.get(s.block_exercise_id).push(s);
  }

  const besByBlock = new Map();
  for (const be of blockExercises) {
    if (!besByBlock.has(be.block_id)) besByBlock.set(be.block_id, []);
    besByBlock.get(be.block_id).push({
      ...be,
      sets: setsByBE.get(be.id) || [],
    });
  }

  return {
    ...workout,
    blocks: blocks.map((b) => ({
      ...b,
      exercises: besByBlock.get(b.id) || [],
    })),
  };
}

// -------------------- workout tree write --------------------

/**
 * Upsert an entire workout tree transactionally.
 *
 * Input shape:
 *   {
 *     id?,
 *     name,
 *     description?,
 *     tags?: string[],
 *     starred?: boolean,
 *     est_duration?: number,
 *     created_by?: 'user' | 'agent',  // defaults to 'agent' for MCP writes
 *     blocks: [
 *       {
 *         id?, position?,
 *         kind?: 'single' | 'superset' | 'circuit',
 *         rounds?: number,
 *         rest_after_sec?, setup_cue?,
 *         exercises: [
 *           {
 *             id?, exercise_id, position?,
 *             alt_exercise_ids?: string[],
 *             sets: [
 *               {
 *                 id?, set_number?,
 *                 round_number?,     // v3: defaults to 1; >1 = partial override per-round
 *                 target_weight?, target_pct_1rm?, target_reps?,
 *                 target_reps_each?, target_duration_sec?, target_rpe?,
 *                 is_peak?, rest_after_sec?, notes?
 *               }, ...
 *             ]
 *           }, ...
 *         ]
 *       }, ...
 *     ]
 *   }
 *
 * Missing ids, positions, and set_numbers are auto-assigned. All exercise_ids
 * are validated up-front so the transaction can't fail halfway.
 * Returns the freshly-read workout tree.
 */
function upsertWorkoutTree(tree) {
  if (!tree || typeof tree !== 'object') {
    throw new Error('upsertWorkoutTree: tree must be an object');
  }
  if (!tree.name || typeof tree.name !== 'string') {
    throw new Error('upsertWorkoutTree: name is required');
  }
  const blocks = Array.isArray(tree.blocks) ? tree.blocks : [];

  // --- Validate exercise_ids up front. ---
  const exerciseCheck = db.prepare('SELECT id FROM exercises WHERE id = ?');
  for (const block of blocks) {
    const exes = Array.isArray(block.exercises) ? block.exercises : [];
    for (const be of exes) {
      if (!be.exercise_id) {
        throw new Error('upsertWorkoutTree: each block exercise requires exercise_id');
      }
      if (!exerciseCheck.get(be.exercise_id)) {
        throw new Error(`upsertWorkoutTree: unknown exercise_id ${be.exercise_id}`);
      }
    }
  }

  const workoutId = tree.id || genId('workout');
  const now = nowMs();
  const existingWorkout = db.prepare('SELECT created_at FROM workouts WHERE id = ?').get(workoutId);
  const createdAt = existingWorkout?.created_at ?? now;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO workouts
        (id, name, description, tags, starred, est_duration, created_by, created_at, updated_at, last_performed)
      VALUES
        (@id, @name, @description, @tags, @starred, @est_duration, @created_by, @created_at, @updated_at, @last_performed)
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        description = @description,
        tags = @tags,
        starred = @starred,
        est_duration = @est_duration,
        created_by = @created_by,
        updated_at = @updated_at
    `).run({
      id: workoutId,
      name: tree.name,
      description: tree.description ?? null,
      tags: JSON.stringify(Array.isArray(tree.tags) ? tree.tags : []),
      starred: tree.starred ? 1 : 0,
      est_duration: Number.isFinite(tree.est_duration) ? tree.est_duration : null,
      created_by: tree.created_by ?? 'agent',
      created_at: createdAt,
      updated_at: now,
      last_performed: null,
    });

    blocks.forEach((block, blockIdx) => {
      const blockId = block.id || genId('block');
      const position = Number.isFinite(block.position) ? block.position : blockIdx + 1;
      const kind = block.kind ?? 'single';
      const rounds = Number.isFinite(block.rounds) ? block.rounds : 1;
      const restAfterSec = block.rest_after_sec ?? null;
      const setupCue = block.setup_cue ?? null;

      const existingBlock = db.prepare('SELECT created_at FROM workout_blocks WHERE id = ?').get(blockId);
      const blockCreated = existingBlock?.created_at ?? now;

      db.prepare(`
        INSERT INTO workout_blocks
          (id, workout_id, position, kind, rounds, rest_after_sec, setup_cue, created_at, updated_at)
        VALUES
          (@id, @workout_id, @position, @kind, @rounds, @rest_after_sec, @setup_cue, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          workout_id = @workout_id,
          position = @position,
          kind = @kind,
          rounds = @rounds,
          rest_after_sec = @rest_after_sec,
          setup_cue = @setup_cue,
          updated_at = @updated_at
      `).run({
        id: blockId,
        workout_id: workoutId,
        position,
        kind,
        rounds,
        rest_after_sec: restAfterSec,
        setup_cue: setupCue,
        created_at: blockCreated,
        updated_at: now,
      });

      const exes = Array.isArray(block.exercises) ? block.exercises : [];
      exes.forEach((be, beIdx) => {
        const beId = be.id || genId('be');
        const bePos = Number.isFinite(be.position) ? be.position : beIdx + 1;
        const altIds = Array.isArray(be.alt_exercise_ids) ? be.alt_exercise_ids : [];

        const existingBe = db.prepare('SELECT created_at FROM block_exercises WHERE id = ?').get(beId);
        const beCreated = existingBe?.created_at ?? now;

        db.prepare(`
          INSERT INTO block_exercises
            (id, block_id, exercise_id, position, alt_exercise_ids, created_at, updated_at)
          VALUES
            (@id, @block_id, @exercise_id, @position, @alt_exercise_ids, @created_at, @updated_at)
          ON CONFLICT(id) DO UPDATE SET
            block_id = @block_id,
            exercise_id = @exercise_id,
            position = @position,
            alt_exercise_ids = @alt_exercise_ids,
            updated_at = @updated_at
        `).run({
          id: beId,
          block_id: blockId,
          exercise_id: be.exercise_id,
          position: bePos,
          alt_exercise_ids: JSON.stringify(altIds),
          created_at: beCreated,
          updated_at: now,
        });

        const sets = Array.isArray(be.sets) ? be.sets : [];
        // Track set_number fill-in per (round_number) so per-round sets that
        // omit set_number get numbered independently of other rounds.
        const nextSetNumberByRound = new Map();
        sets.forEach((s) => {
          const sId = s.id || genId('bes');
          const roundNum = Number.isFinite(s.round_number) && s.round_number > 0 ? s.round_number : 1;
          // Auto-assign set_number per round if omitted. Keeps round 2 overrides
          // aligned to round 1 when the author lists them in order.
          let setNum;
          if (Number.isFinite(s.set_number)) {
            setNum = s.set_number;
          } else {
            const cur = nextSetNumberByRound.get(roundNum) ?? 0;
            setNum = cur + 1;
          }
          nextSetNumberByRound.set(roundNum, setNum);
          if (roundNum > rounds) {
            console.warn(
              `[upsertWorkoutTree] orphan override row: block ${blockId} be ${beId} ` +
              `round_number=${roundNum} > rounds=${rounds}. Row is preserved but ` +
              `filtered out of the executed snapshot until block.rounds is raised.`,
            );
          }

          const existingSet = db.prepare('SELECT created_at FROM block_exercise_sets WHERE id = ?').get(sId);
          const setCreated = existingSet?.created_at ?? now;

          db.prepare(`
            INSERT INTO block_exercise_sets
              (id, block_exercise_id, set_number, round_number,
               target_weight, target_pct_1rm, target_reps, target_reps_each,
               target_duration_sec, target_rpe, is_peak, rest_after_sec, notes,
               created_at, updated_at)
            VALUES
              (@id, @block_exercise_id, @set_number, @round_number,
               @target_weight, @target_pct_1rm, @target_reps, @target_reps_each,
               @target_duration_sec, @target_rpe, @is_peak, @rest_after_sec, @notes,
               @created_at, @updated_at)
            ON CONFLICT(id) DO UPDATE SET
              block_exercise_id = @block_exercise_id,
              set_number = @set_number,
              round_number = @round_number,
              target_weight = @target_weight,
              target_pct_1rm = @target_pct_1rm,
              target_reps = @target_reps,
              target_reps_each = @target_reps_each,
              target_duration_sec = @target_duration_sec,
              target_rpe = @target_rpe,
              is_peak = @is_peak,
              rest_after_sec = @rest_after_sec,
              notes = @notes,
              updated_at = @updated_at
          `).run({
            id: sId,
            block_exercise_id: beId,
            set_number: setNum,
            round_number: roundNum,
            target_weight: s.target_weight ?? null,
            target_pct_1rm: s.target_pct_1rm ?? null,
            target_reps: s.target_reps ?? null,
            target_reps_each: s.target_reps_each ? 1 : 0,
            target_duration_sec: s.target_duration_sec ?? null,
            target_rpe: s.target_rpe ?? null,
            is_peak: s.is_peak ? 1 : 0,
            rest_after_sec: s.rest_after_sec ?? null,
            notes: s.notes ?? null,
            created_at: setCreated,
            updated_at: now,
          });
        });
      });
    });
  });

  tx();
  return readWorkoutTree(workoutId);
}

// -------------------- session delete --------------------

/**
 * Epley 1RM estimate, capped at 10 reps (matches lift-logger-api/db/database.js
 * `estimate1RM`). Duplicated here to avoid a cross-package import.
 */
function estimate1RM(weight, reps) {
  if (weight === null || weight === undefined) return null;
  if (reps === null || reps === undefined) return null;
  if (reps <= 0 || weight <= 0) return null;
  const cappedReps = Math.min(reps, 10);
  if (cappedReps === 1) return weight;
  return weight * (1 + cappedReps / 30);
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
 * NB: This is the one place in MCP that writes exercise_prs (see CLAUDE.md
 * convention). Necessary because PR state is no longer truthful after a
 * session delete and there's no other actor that could rebuild it.
 */
function recomputeExercisePRsFromScratch(exerciseId, txDb = db) {
  const rows = txDb.prepare(`
    SELECT actual_weight AS w, actual_reps AS r, session_id, logged_at
    FROM session_sets
    WHERE exercise_id = ?
      AND actual_weight IS NOT NULL
      AND actual_reps IS NOT NULL
  `).all(exerciseId);

  // Compute the new max for each pr_type from surviving rows.
  const best = {
    weight:  { value: -Infinity, weight: null, reps: null, session_id: null, achieved_at: null },
    reps:    { value: -Infinity, weight: null, reps: null, session_id: null, achieved_at: null },
    volume:  { value: -Infinity, weight: null, reps: null, session_id: null, achieved_at: null },
    '1rm_est': { value: -Infinity, weight: null, reps: null, session_id: null, achieved_at: null },
  };

  for (const r of rows) {
    const w = r.w, reps = r.r;
    const consider = (type, val) => {
      if (val === null || val === undefined || !(val > 0)) return;
      if (val > best[type].value) {
        best[type] = { value: val, weight: w, reps, session_id: r.session_id, achieved_at: r.logged_at };
      }
    };
    consider('weight', w);
    consider('reps', reps);
    consider('volume', (w > 0 && reps > 0) ? w * reps : null);
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

/**
 * Hard-delete a session and all its session_sets, then recompute PRs from
 * remaining sessions for every exercise the deleted session touched.
 *
 * Refuses to delete sessions with status='active' — would yank the rug out
 * from under a live workout.
 *
 * Returns { deleted, sessionSetsDeleted, prsRecomputed } or { deleted: false }
 * if the session id doesn't exist.
 *
 * Note on sync: server-side hard delete does NOT propagate to the iPhone's
 * Dexie mirror (sync only carries upserts via LWW). Acceptable for the
 * server-side cleanup use case; the frontend has no completed-session list
 * screen so the only visible effect is HomeScreen's "New" chip computation.
 */
function deleteSessionTree(sessionId) {
  const existing = db.prepare('SELECT id, status FROM sessions WHERE id = ?').get(sessionId);
  if (!existing) return { deleted: false, sessionSetsDeleted: 0, prsRecomputed: 0 };
  if (existing.status === 'active') {
    throw new Error(`cannot delete active session: ${sessionId}`);
  }

  let sessionSetsDeleted = 0;
  let prsRecomputed = 0;

  const tx = db.transaction(() => {
    const exerciseIds = db.prepare(
      'SELECT DISTINCT exercise_id FROM session_sets WHERE session_id = ?'
    ).all(sessionId).map((r) => r.exercise_id);

    sessionSetsDeleted = db.prepare(
      'DELETE FROM session_sets WHERE session_id = ?'
    ).run(sessionId).changes;

    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    for (const exId of exerciseIds) {
      prsRecomputed += recomputeExercisePRsFromScratch(exId, db);
    }
  });
  tx();

  return { deleted: true, sessionSetsDeleted, prsRecomputed };
}

/**
 * Hard-delete a workout and its entire tree (blocks, block_exercises,
 * block_exercise_sets) in one transaction. Schema has no CASCADE, so we
 * cascade manually. Sessions that referenced the workout keep their
 * workout_snapshot intact; session_sets are untouched.
 */
function deleteWorkoutTree(workoutId) {
  const existing = db.prepare('SELECT id FROM workouts WHERE id = ?').get(workoutId);
  if (!existing) return false;

  const tx = db.transaction(() => {
    const blocks = db.prepare('SELECT id FROM workout_blocks WHERE workout_id = ?').all(workoutId);
    for (const b of blocks) {
      const bes = db.prepare('SELECT id FROM block_exercises WHERE block_id = ?').all(b.id);
      for (const be of bes) {
        db.prepare('DELETE FROM block_exercise_sets WHERE block_exercise_id = ?').run(be.id);
      }
      db.prepare('DELETE FROM block_exercises WHERE block_id = ?').run(b.id);
    }
    db.prepare('DELETE FROM workout_blocks WHERE workout_id = ?').run(workoutId);
    db.prepare('DELETE FROM workouts WHERE id = ?').run(workoutId);
  });
  tx();
  return true;
}

module.exports = {
  db,
  nowMs,
  genId,
  readWorkoutTree,
  upsertWorkoutTree,
  deleteWorkoutTree,
  deleteSessionTree,
  recomputeExercisePRsFromScratch,
};
