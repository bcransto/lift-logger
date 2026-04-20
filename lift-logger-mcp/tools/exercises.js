const { db, nowMs, genId } = require('../db');

/**
 * list_exercises — all (non-deleted by default) exercises, alphabetical.
 */
function listExercises({ includeDeleted = false, search } = {}) {
  let sql = 'SELECT id, name, category, muscle_group, equipment, notes, is_deleted, updated_at FROM exercises';
  const params = [];
  const where = [];

  if (!includeDeleted) where.push('is_deleted = 0');
  if (search) {
    where.push('name LIKE ?');
    params.push(`%${search}%`);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY name ASC';

  return db.prepare(sql).all(...params).map(row => ({
    id: row.id,
    name: row.name,
    category: row.category,
    muscleGroup: row.muscle_group,
    equipment: row.equipment,
    notes: row.notes,
    isDeleted: row.is_deleted === 1,
    updatedAt: row.updated_at
  }));
}

/**
 * create_exercise — insert a new exercise.
 */
function createExercise({ name, category, muscleGroup, equipment, notes }) {
  if (!name || !name.trim()) throw new Error('name is required');
  const id = genId('ex');
  const now = nowMs();

  db.prepare(`
    INSERT INTO exercises
      (id, name, category, muscle_group, equipment, notes, is_deleted, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    id,
    name.trim(),
    category ?? null,
    muscleGroup ?? null,
    equipment ?? null,
    notes ?? null,
    now
  );

  return {
    id,
    name: name.trim(),
    category: category ?? null,
    muscleGroup: muscleGroup ?? null,
    equipment: equipment ?? null,
    notes: notes ?? null,
    updatedAt: now
  };
}

/**
 * suggest_alt_exercises — heuristic alternatives for an exercise based on
 * matching muscle_group / equipment / category tags. No embeddings, no
 * external calls — just SQL. Returns a ranked list.
 */
function suggestAltExercises({ exerciseId, limit = 10 }) {
  const target = db.prepare(
    'SELECT id, name, category, muscle_group, equipment FROM exercises WHERE id = ? AND is_deleted = 0'
  ).get(exerciseId);
  if (!target) throw new Error(`exerciseId not found: ${exerciseId}`);

  const rows = db.prepare(`
    SELECT
      id, name, category, muscle_group, equipment,
      (CASE WHEN muscle_group IS NOT NULL AND muscle_group = @muscle_group THEN 2 ELSE 0 END) +
      (CASE WHEN category IS NOT NULL AND category = @category THEN 1 ELSE 0 END) +
      (CASE WHEN equipment IS NOT NULL AND equipment = @equipment THEN 1 ELSE 0 END) AS score
    FROM exercises
    WHERE id != @id AND is_deleted = 0
      AND (
        (muscle_group IS NOT NULL AND muscle_group = @muscle_group)
        OR (category IS NOT NULL AND category = @category)
      )
    ORDER BY score DESC, name ASC
    LIMIT @limit
  `).all({
    id: target.id,
    muscle_group: target.muscle_group,
    category: target.category,
    equipment: target.equipment,
    limit
  });

  return {
    target: {
      id: target.id,
      name: target.name,
      category: target.category,
      muscleGroup: target.muscle_group,
      equipment: target.equipment
    },
    suggestions: rows.map(r => ({
      id: r.id,
      name: r.name,
      category: r.category,
      muscleGroup: r.muscle_group,
      equipment: r.equipment,
      score: r.score
    }))
  };
}

module.exports = { listExercises, createExercise, suggestAltExercises };
