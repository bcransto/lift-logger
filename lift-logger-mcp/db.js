const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'lift-logger-api', 'data', 'liftlogger.db');
const db = new Database(dbPath, { readonly: false });

// Enable WAL mode for concurrent read access
db.pragma('journal_mode = WAL');

module.exports = db;
