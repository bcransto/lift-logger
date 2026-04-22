/**
 * Shared SQLite handle for MCP tools.
 *
 * Points at the IRON database (`../lift-logger-api/data/iron.db`). MCP never
 * writes to exercise_prs — that's the sync handler's job. MCP also never
 * opens a second handle to create tables; the API server owns schema init.
 *
 * Matches the schema in lift-logger-api/db/schema.js and the frontend types
 * in lift-logger-frontend/src/types/schema.ts.
 */

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, '..', 'lift-logger-api', 'data', 'iron.db');
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
};
