/**
 * Shared SQLite handle for MCP tools.
 *
 * Points at the IRON database (`../lift-logger-api/data/iron.db`). MCP never
 * writes to exercise_prs — that's the sync handler's job. MCP also never opens
 * a second connection to create tables; the sync backend owns schema.
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
 * Soft-deleted rows at any level are filtered out.
 */
function readWorkoutTree(workoutId) {
  const workout = db.prepare(
    'SELECT * FROM workouts WHERE id = ? AND is_deleted = 0'
  ).get(workoutId);
  if (!workout) return null;

  const blocks = db.prepare(`
    SELECT * FROM workout_blocks
    WHERE workout_id = ? AND is_deleted = 0
    ORDER BY position ASC
  `).all(workoutId);

  const blockIds = blocks.map(b => b.id);
  const blockExercises = blockIds.length === 0 ? [] : db.prepare(`
    SELECT be.*, e.name AS exercise_name
    FROM block_exercises be
    LEFT JOIN exercises e ON e.id = be.exercise_id
    WHERE be.block_id IN (${blockIds.map(() => '?').join(',')}) AND be.is_deleted = 0
    ORDER BY be.block_id, be.position ASC
  `).all(...blockIds);

  const beIds = blockExercises.map(be => be.id);
  const sets = beIds.length === 0 ? [] : db.prepare(`
    SELECT * FROM block_exercise_sets
    WHERE block_exercise_id IN (${beIds.map(() => '?').join(',')}) AND is_deleted = 0
    ORDER BY block_exercise_id, set_number ASC
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
      sets: setsByBE.get(be.id) || []
    });
  }

  return {
    ...workout,
    blocks: blocks.map(b => ({
      ...b,
      exercises: besByBlock.get(b.id) || []
    }))
  };
}

// -------------------- workout tree write --------------------

/**
 * Upsert an entire workout tree transactionally.
 *
 * Input shape:
 *   {
 *     id?, name, description?, notes?,
 *     blocks: [
 *       {
 *         id?, position?, block_type?, rest_seconds?, notes?,
 *         exercises: [
 *           {
 *             id?, exercise_id, position?, notes?,
 *             sets: [ { id?, set_number?, target_reps?, target_weight?, target_rpe?, notes? }, ... ]
 *           }, ...
 *         ]
 *       }, ...
 *     ]
 *   }
 *
 * Missing ids, positions, and set_numbers are auto-assigned. All exercise_ids
 * are validated to exist (and not be soft-deleted) before any write occurs.
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

  // --- Validate exercise_ids up front so the transaction can't fail halfway. ---
  const exerciseCheck = db.prepare(
    'SELECT id FROM exercises WHERE id = ? AND is_deleted = 0'
  );
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

  const tx = db.transaction(() => {
    // Workout row
    db.prepare(`
      INSERT INTO workouts (id, name, description, is_deleted, updated_at)
      VALUES (@id, @name, @description, 0, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        description = @description,
        is_deleted = 0,
        updated_at = @updated_at
    `).run({
      id: workoutId,
      name: tree.name,
      description: tree.description ?? null,
      updated_at: now
    });

    blocks.forEach((block, blockIdx) => {
      const blockId = block.id || genId('block');
      const position = Number.isFinite(block.position) ? block.position : blockIdx;
      const blockType = block.block_type || 'standard';
      const restSec = block.rest_seconds ?? null;
      const blockNotes = block.notes ?? null;

      db.prepare(`
        INSERT INTO workout_blocks
          (id, workout_id, position, block_type, rest_seconds, notes, is_deleted, updated_at)
        VALUES (@id, @workout_id, @position, @block_type, @rest_seconds, @notes, 0, @updated_at)
        ON CONFLICT(id) DO UPDATE SET
          workout_id = @workout_id,
          position = @position,
          block_type = @block_type,
          rest_seconds = @rest_seconds,
          notes = @notes,
          is_deleted = 0,
          updated_at = @updated_at
      `).run({
        id: blockId,
        workout_id: workoutId,
        position,
        block_type: blockType,
        rest_seconds: restSec,
        notes: blockNotes,
        updated_at: now
      });

      const exes = Array.isArray(block.exercises) ? block.exercises : [];
      exes.forEach((be, beIdx) => {
        const beId = be.id || genId('be');
        const bePos = Number.isFinite(be.position) ? be.position : beIdx;

        db.prepare(`
          INSERT INTO block_exercises
            (id, block_id, exercise_id, position, notes, is_deleted, updated_at)
          VALUES (@id, @block_id, @exercise_id, @position, @notes, 0, @updated_at)
          ON CONFLICT(id) DO UPDATE SET
            block_id = @block_id,
            exercise_id = @exercise_id,
            position = @position,
            notes = @notes,
            is_deleted = 0,
            updated_at = @updated_at
        `).run({
          id: beId,
          block_id: blockId,
          exercise_id: be.exercise_id,
          position: bePos,
          notes: be.notes ?? null,
          updated_at: now
        });

        const sets = Array.isArray(be.sets) ? be.sets : [];
        sets.forEach((s, sIdx) => {
          const sId = s.id || genId('bes');
          const setNum = Number.isFinite(s.set_number) ? s.set_number : sIdx + 1;

          db.prepare(`
            INSERT INTO block_exercise_sets
              (id, block_exercise_id, set_number, target_reps, target_weight, target_rpe, notes, is_deleted, updated_at)
            VALUES (@id, @block_exercise_id, @set_number, @target_reps, @target_weight, @target_rpe, @notes, 0, @updated_at)
            ON CONFLICT(id) DO UPDATE SET
              block_exercise_id = @block_exercise_id,
              set_number = @set_number,
              target_reps = @target_reps,
              target_weight = @target_weight,
              target_rpe = @target_rpe,
              notes = @notes,
              is_deleted = 0,
              updated_at = @updated_at
          `).run({
            id: sId,
            block_exercise_id: beId,
            set_number: setNum,
            target_reps: s.target_reps ?? null,
            target_weight: s.target_weight ?? null,
            target_rpe: s.target_rpe ?? null,
            notes: s.notes ?? null,
            updated_at: now
          });
        });
      });
    });
  });

  tx();
  return readWorkoutTree(workoutId);
}

/**
 * Soft-delete a workout and its entire tree (blocks, block_exercises,
 * block_exercise_sets). Updated_at advances so the sync feed picks up the deletion.
 */
function softDeleteWorkoutTree(workoutId) {
  const existing = db.prepare('SELECT id FROM workouts WHERE id = ?').get(workoutId);
  if (!existing) return false;
  const now = nowMs();

  const tx = db.transaction(() => {
    db.prepare('UPDATE workouts SET is_deleted = 1, updated_at = ? WHERE id = ?').run(now, workoutId);

    const blocks = db.prepare('SELECT id FROM workout_blocks WHERE workout_id = ?').all(workoutId);
    for (const b of blocks) {
      db.prepare('UPDATE workout_blocks SET is_deleted = 1, updated_at = ? WHERE id = ?').run(now, b.id);
      const bes = db.prepare('SELECT id FROM block_exercises WHERE block_id = ?').all(b.id);
      for (const be of bes) {
        db.prepare('UPDATE block_exercises SET is_deleted = 1, updated_at = ? WHERE id = ?').run(now, be.id);
        db.prepare('UPDATE block_exercise_sets SET is_deleted = 1, updated_at = ? WHERE block_exercise_id = ?').run(now, be.id);
      }
    }
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
  softDeleteWorkoutTree
};
