const express = require('express');
const router = express.Router();
const db = require('../db/database');

/**
 * POST /api/sync
 * Bidirectional sync endpoint
 *
 * Request body:
 * {
 *   lastSync: number (timestamp in ms),
 *   changes: {
 *     exercises: [...],
 *     workouts: [...],
 *     records: [...]
 *   }
 * }
 *
 * Response:
 * {
 *   serverChanges: {
 *     exercises: [...],
 *     workouts: [...],
 *     records: [...]
 *   },
 *   syncTimestamp: number
 * }
 */
router.post('/', (req, res) => {
  try {
    const { lastSync = 0, changes = {} } = req.body;

    const result = db.sync(lastSync, changes);

    res.json(result);
  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({ error: 'Sync failed', message: error.message });
  }
});

module.exports = router;
