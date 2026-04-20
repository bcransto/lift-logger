/**
 * POST /api/sync — per-table incremental bidirectional sync.
 *
 * Request:
 * {
 *   "tables": {
 *     "exercises":   { "lastSync": 0, "changes": [ {id, name, updated_at, ...}, ... ] },
 *     "workouts":    { "lastSync": 0, "changes": [...] },
 *     "sessions":    { "lastSync": 0, "changes": [...] },
 *     ...
 *   }
 * }
 *
 * Response (same shape, each table reports its own syncTimestamp):
 * {
 *   "tables": {
 *     "exercises": { "syncTimestamp": 1700000000000, "changes": [...] },
 *     ...
 *   }
 * }
 *
 * Semantics:
 *  - Writes are processed in dependency-safe WRITE_ORDER.
 *  - LWW: incoming.updated_at must be strictly greater than existing.updated_at.
 *  - session_sets writes side-effect exercise_prs via recomputePRsForSessionSet.
 *  - Each per-table `changes` in the response includes the server's own view of rows
 *    updated since that table's lastSync — i.e. everything the client is missing,
 *    including any exercise_prs rows that PR computation just produced.
 */

const express = require('express');
const router = express.Router();
const {
  db,
  SYNC_TABLES,
  WRITE_ORDER,
  upsertRow,
  getChangesSince,
  upsertSessionSetWithPRs
} = require('../db/database');

router.post('/', (req, res) => {
  try {
    const body = req.body || {};
    const tables = body.tables || {};

    // --- 1. Apply client changes in dependency-safe order. ---
    const applyAll = db.transaction(() => {
      for (const table of WRITE_ORDER) {
        const section = tables[table];
        if (!section || !Array.isArray(section.changes) || section.changes.length === 0) continue;

        if (table === 'session_sets') {
          // PR computation is the side-effect of this write.
          for (const row of section.changes) {
            upsertSessionSetWithPRs(row);
          }
        } else {
          for (const row of section.changes) {
            upsertRow(table, row);
          }
        }
      }
    });
    applyAll();

    // --- 2. For each table, return rows updated since its lastSync. ---
    const responseTables = {};
    const syncTimestamp = Date.now();

    for (const table of SYNC_TABLES) {
      const since = Number(tables[table]?.lastSync) || 0;
      const changes = getChangesSince(table, since);
      responseTables[table] = {
        syncTimestamp,
        changes
      };
    }

    res.json({ tables: responseTables });
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ error: 'Sync failed', message: error.message });
  }
});

module.exports = router;
