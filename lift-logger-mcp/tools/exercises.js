const { db, nowMs, genId } = require('../db');

function parseJsonArray(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toOut(row) {
  return {
    id: row.id,
    name: row.name,
    equipment: parseJsonArray(row.equipment),
    muscleGroups: parseJsonArray(row.muscle_groups),
    movementType: row.movement_type,
    isUnilateral: row.is_unilateral === 1,
    starred: row.starred === 1,
    notes: row.notes,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

/**
 * list_exercises — alphabetical, optional name substring + starred filter.
 */
function listExercises({ search, starred, muscleGroup, equipment } = {}) {
  let sql = 'SELECT * FROM exercises';
  const params = {};
  const where = [];

  if (starred === true) where.push('starred = 1');
  if (search) {
    where.push('name LIKE @search');
    params.search = `%${search}%`;
  }
  if (muscleGroup) {
    where.push('muscle_groups LIKE @mg');
    params.mg = `%"${muscleGroup}"%`;
  }
  if (equipment) {
    where.push('equipment LIKE @eq');
    params.eq = `%"${equipment}"%`;
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY name ASC';

  return db.prepare(sql).all(params).map(toOut);
}

/**
 * create_exercise — insert a new exercise. equipment + muscleGroups are arrays.
 */
function createExercise({ name, equipment, muscleGroups, movementType, isUnilateral, starred, notes }) {
  if (!name || !name.trim()) throw new Error('name is required');
  const id = genId('ex');
  const now = nowMs();

  db.prepare(`
    INSERT INTO exercises
      (id, name, equipment, muscle_groups, movement_type, is_unilateral, starred, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name.trim(),
    JSON.stringify(Array.isArray(equipment) ? equipment : []),
    JSON.stringify(Array.isArray(muscleGroups) ? muscleGroups : []),
    movementType ?? null,
    isUnilateral ? 1 : 0,
    starred ? 1 : 0,
    notes ?? null,
    now,
    now,
  );

  return toOut({
    id,
    name: name.trim(),
    equipment: JSON.stringify(equipment ?? []),
    muscle_groups: JSON.stringify(muscleGroups ?? []),
    movement_type: movementType ?? null,
    is_unilateral: isUnilateral ? 1 : 0,
    starred: starred ? 1 : 0,
    notes: notes ?? null,
    created_at: now,
    updated_at: now,
  });
}

/**
 * suggest_alt_exercises — heuristic alternatives based on shared muscle_group,
 * movement_type, and equipment tags. Arrays are JSON-encoded TEXT; we use
 * substring matches for the overlap check (good enough at single-user scale).
 */
function suggestAltExercises({ exerciseId, limit = 10 }) {
  const target = db.prepare('SELECT * FROM exercises WHERE id = ?').get(exerciseId);
  if (!target) throw new Error(`exerciseId not found: ${exerciseId}`);

  const targetMGs = parseJsonArray(target.muscle_groups);
  const targetEquip = parseJsonArray(target.equipment);

  const all = db.prepare('SELECT * FROM exercises WHERE id != ?').all(exerciseId);
  const scored = all.map((r) => {
    const mgs = parseJsonArray(r.muscle_groups);
    const eq = parseJsonArray(r.equipment);
    let score = 0;
    // Muscle-group overlap: each shared group +2.
    for (const m of targetMGs) if (mgs.includes(m)) score += 2;
    // Movement type match: +2.
    if (target.movement_type && r.movement_type === target.movement_type) score += 2;
    // Equipment overlap: each shared piece +1.
    for (const e of targetEquip) if (eq.includes(e)) score += 1;
    return { row: r, score };
  })
  .filter((x) => x.score > 0)
  .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name))
  .slice(0, limit);

  return {
    target: toOut(target),
    suggestions: scored.map(({ row, score }) => ({ ...toOut(row), score })),
  };
}

module.exports = { listExercises, createExercise, suggestAltExercises };
