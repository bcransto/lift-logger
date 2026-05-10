/**
 * Session CRUD endpoints — currently only delete.
 *
 * Mounted at /api/sessions in server.js, so the path here is /:id/delete.
 *
 * POST /api/sessions/:id/delete
 *   - 200: { deleted: true, sessionSetsDeleted, prsRecomputed } — session and
 *     all its session_sets are gone, and exercise_prs is rebuilt from scratch
 *     for every exercise the session touched.
 *   - 404: { error: 'not found' } — no session row with that id.
 *   - 409: { error: 'cannot delete active session' } — session.status === 'active'.
 *
 * Mirrors the MCP `deleteSessionTree` semantics (lift-logger-mcp/db.js). Hard
 * delete + transactional PR recompute. The PR recompute is the load-bearing
 * part; without it stale `exercise_prs` rows would lie about the user's actual
 * best after deletion.
 *
 * Caveat on sync: hard-deletes don't propagate via the upsert-only LWW sync.
 * If the user has a second device that hasn't synced yet, the deleted session
 * will linger there until they manually delete it again. Acceptable for a
 * single-user-mostly-single-device app; same caveat as MCP `delete_session`.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { recomputeExercisePRsFromScratch } = require('../db/recomputePRs');

router.post('/:id/delete', (req, res) => {
  const sessionId = req.params.id;

  try {
    const existing = db
      .prepare('SELECT id, status FROM sessions WHERE id = ?')
      .get(sessionId);

    if (!existing) {
      return res.status(404).json({ error: 'not found' });
    }
    if (existing.status === 'active') {
      return res.status(409).json({ error: 'cannot delete active session' });
    }

    let sessionSetsDeleted = 0;
    let prsRecomputed = 0;

    const tx = db.transaction(() => {
      const exerciseIds = db
        .prepare('SELECT DISTINCT exercise_id FROM session_sets WHERE session_id = ?')
        .all(sessionId)
        .map((r) => r.exercise_id);

      sessionSetsDeleted = db
        .prepare('DELETE FROM session_sets WHERE session_id = ?')
        .run(sessionId).changes;

      db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

      for (const exId of exerciseIds) {
        prsRecomputed += recomputeExercisePRsFromScratch(exId, db);
      }
    });
    tx();

    return res.json({ deleted: true, sessionSetsDeleted, prsRecomputed });
  } catch (error) {
    console.error('Session delete error:', error);
    return res.status(500).json({ error: 'delete failed', message: error.message });
  }
});

module.exports = router;
