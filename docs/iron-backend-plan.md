# IRON Backend — Clean Slate

## Context

We're rebuilding Lift Logger as IRON — a gym-focused PWA with complex workouts (HIIT, supersets, circuits, pyramids), an AI agent that authors plans, and proper planned-vs-actual tracking. After comparing a graft-on-existing plan against the IRON spec, we chose clean slate: the existing UI is not the intended end state, and a hybrid data model would fight the IRON screen architecture. Prior workout/record data is disposable — a migration tool can be built later if needed.

**This plan covers the backend only** — `lift-logger-api/` server, SQLite schema, sync protocol, PR computation, and the `lift-logger-mcp/` rewrite. The IRON frontend rebuild (React+Vite, new screens, design system) will get a separate plan.

## Decisions locked

- **Clean slate**, not graft-on-existing. Fresh DB, fresh schema, rewritten MCP.
- **SQLite, not Postgres.** IRON spec says Postgres; we stay on SQLite because the Pi + Tailscale + better-sqlite3 setup works and Postgres is ops cost for no functional gain at single-user scale.
- **Schema:** IRON's 8 tables, translated Postgres → SQLite.
- **PR computation: server-side, transactional, triggered only by real `session_sets` inserts via sync.** Agent/MCP template writes never touch `exercise_prs`.
- **MCP writes stay direct-to-SQLite** as a sidecar (current pattern). Not routed through REST.
- **Single-port Express + systemd deployment unchanged.** Tailscale-secured.
- **Schema versioning from day 1.** `schema_version` table + `runMigrations(db)`.
- **Old `liftlogger.db` stays on disk** as safety net; new DB is `data/iron.db`. Delete old file manually once confident.

## Schema (SQLite, greenfield v1)

Postgres → SQLite translations applied throughout:
- `TEXT[]` → `TEXT` containing JSON array
- `BOOLEAN` → `INTEGER` (0/1)
- `NUMERIC(6,2)` → `REAL`
- `JSONB` → `TEXT` containing JSON (SQLite 3.38+ has `json_extract` / `json_each`)
- `TIMESTAMPTZ NOT NULL DEFAULT now()` → `INTEGER NOT NULL` (epoch millis — matches existing app pattern; app fills on write)
- GIN indexes → skipped (single-user scale); add `json_extract` expression indexes only if query latency demands
- Partial indexes (`WHERE` clauses) → supported in SQLite, kept

```sql
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

CREATE TABLE IF NOT EXISTS exercises (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  equipment       TEXT NOT NULL DEFAULT '[]',       -- JSON array
  muscle_groups   TEXT NOT NULL DEFAULT '[]',       -- JSON array
  movement_type   TEXT,                              -- squat|hinge|push|pull|carry|iso|plyo|cardio
  is_unilateral   INTEGER NOT NULL DEFAULT 0,
  starred         INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exercises_starred ON exercises(starred) WHERE starred = 1;
CREATE INDEX IF NOT EXISTS idx_exercises_updated ON exercises(updated_at);

CREATE TABLE IF NOT EXISTS workouts (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',       -- JSON array
  starred         INTEGER NOT NULL DEFAULT 0,
  est_duration    INTEGER,                          -- minutes
  created_by      TEXT NOT NULL DEFAULT 'user',     -- user|agent
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_performed  INTEGER                           -- epoch millis, nullable
);
CREATE INDEX IF NOT EXISTS idx_workouts_starred ON workouts(starred) WHERE starred = 1;
CREATE INDEX IF NOT EXISTS idx_workouts_last_performed ON workouts(last_performed DESC);
CREATE INDEX IF NOT EXISTS idx_workouts_created_by ON workouts(created_by);
CREATE INDEX IF NOT EXISTS idx_workouts_updated ON workouts(updated_at);

CREATE TABLE IF NOT EXISTS workout_blocks (
  id              TEXT PRIMARY KEY,
  workout_id      TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('single','superset','circuit')),
  rounds          INTEGER NOT NULL DEFAULT 1,
  rest_after_sec  INTEGER,
  setup_cue       TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(workout_id, position)
);
CREATE INDEX IF NOT EXISTS idx_blocks_workout ON workout_blocks(workout_id, position);
CREATE INDEX IF NOT EXISTS idx_blocks_updated ON workout_blocks(updated_at);

CREATE TABLE IF NOT EXISTS block_exercises (
  id                TEXT PRIMARY KEY,
  block_id          TEXT NOT NULL REFERENCES workout_blocks(id) ON DELETE CASCADE,
  exercise_id       TEXT NOT NULL REFERENCES exercises(id),
  position          INTEGER NOT NULL,
  alt_exercise_ids  TEXT NOT NULL DEFAULT '[]',     -- JSON array
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE(block_id, position)
);
CREATE INDEX IF NOT EXISTS idx_block_exercises_block ON block_exercises(block_id, position);
CREATE INDEX IF NOT EXISTS idx_block_exercises_exercise ON block_exercises(exercise_id);
CREATE INDEX IF NOT EXISTS idx_block_exercises_updated ON block_exercises(updated_at);

CREATE TABLE IF NOT EXISTS block_exercise_sets (
  id                    TEXT PRIMARY KEY,
  block_exercise_id     TEXT NOT NULL REFERENCES block_exercises(id) ON DELETE CASCADE,
  set_number            INTEGER NOT NULL,
  target_weight         REAL,
  target_pct_1rm        REAL,                       -- 0.0–1.2
  target_reps           INTEGER,
  target_reps_each      INTEGER NOT NULL DEFAULT 0, -- unilateral flag
  target_duration_sec   INTEGER,
  target_rpe            INTEGER,
  is_peak               INTEGER NOT NULL DEFAULT 0,
  rest_after_sec        INTEGER,
  notes                 TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE(block_exercise_id, set_number),
  CHECK (NOT (target_weight IS NOT NULL AND target_pct_1rm IS NOT NULL)),
  CHECK (
    target_weight IS NOT NULL
    OR target_pct_1rm IS NOT NULL
    OR target_duration_sec IS NOT NULL
    OR target_reps IS NOT NULL
  )
);
CREATE INDEX IF NOT EXISTS idx_sets_block_exercise ON block_exercise_sets(block_exercise_id, set_number);
CREATE INDEX IF NOT EXISTS idx_sets_updated ON block_exercise_sets(updated_at);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  workout_id        TEXT REFERENCES workouts(id) ON DELETE SET NULL,
  workout_snapshot  TEXT NOT NULL,                  -- JSON, frozen at session start
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  duration_sec      INTEGER,
  status            TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','completed','abandoned')),
  notes             TEXT,
  save_preference   TEXT CHECK (save_preference IN ('session_only','template') OR save_preference IS NULL),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_workout ON sessions(workout_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS session_sets (
  id                        TEXT PRIMARY KEY,
  session_id                TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  exercise_id               TEXT NOT NULL REFERENCES exercises(id),
  block_position            INTEGER NOT NULL,
  block_exercise_position   INTEGER NOT NULL,
  round_number              INTEGER NOT NULL DEFAULT 1,
  set_number                INTEGER NOT NULL,
  target_weight             REAL,
  target_reps               INTEGER,
  target_duration_sec       INTEGER,
  actual_weight             REAL,
  actual_reps               INTEGER,
  actual_duration_sec       INTEGER,
  rpe                       INTEGER,
  rest_taken_sec            INTEGER,
  is_pr                     INTEGER NOT NULL DEFAULT 0,
  was_swapped               INTEGER NOT NULL DEFAULT 0,
  logged_at                 INTEGER NOT NULL,
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_sets_session ON session_sets(session_id);
CREATE INDEX IF NOT EXISTS idx_session_sets_exercise ON session_sets(exercise_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_sets_pr ON session_sets(exercise_id, is_pr) WHERE is_pr = 1;
CREATE INDEX IF NOT EXISTS idx_session_sets_updated ON session_sets(updated_at);

CREATE TABLE IF NOT EXISTS exercise_prs (
  id            TEXT PRIMARY KEY,
  exercise_id   TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  pr_type       TEXT NOT NULL CHECK (pr_type IN ('weight','reps','volume','1rm_est')),
  value         REAL NOT NULL,
  reps          INTEGER,
  weight        REAL,
  achieved_at   INTEGER NOT NULL,
  session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(exercise_id, pr_type)
);
CREATE INDEX IF NOT EXISTS idx_prs_exercise ON exercise_prs(exercise_id);
CREATE INDEX IF NOT EXISTS idx_prs_updated ON exercise_prs(updated_at);
```

## Sync protocol

Generalize the current `POST /api/sync` (currently three-table, whole-document LWW) to a per-table, LWW payload keyed by table name:

**Request**
```json
{
  "tables": {
    "exercises":           { "lastSync": 0, "changes": [...] },
    "workouts":            { "lastSync": 0, "changes": [...] },
    "workout_blocks":      { "lastSync": 0, "changes": [...] },
    "block_exercises":     { "lastSync": 0, "changes": [...] },
    "block_exercise_sets": { "lastSync": 0, "changes": [...] },
    "sessions":            { "lastSync": 0, "changes": [...] },
    "session_sets":        { "lastSync": 0, "changes": [...] },
    "exercise_prs":        { "lastSync": 0, "changes": [...] }
  }
}
```

**Response**: same shape, each table reports `syncTimestamp` + `changes[]` to apply on the client.

**LWW rule** per row: upsert wins only if `incoming.updated_at > existing.updated_at`. Matches the current [db/database.js:35-82](lift-logger-api/db/database.js) pattern, extended across 8 tables via a generic `upsertRow(table, row)` helper driven by a small column-map config.

**Conflict-free zones**: session writes (rows in `sessions` and `session_sets`) have one writer (the phone performing the workout). The agent never edits an in-progress session. `exercise_prs` writes are server-only (see below). No conflict resolution needed on those in practice.

## PR computation

**Triggered in the sync handler** when one or more `session_sets` rows arrive with non-null `actual_weight`/`actual_reps`/`actual_duration_sec`. Never triggered by MCP or agent writes.

In the same SQLite transaction that upserts the session_sets row(s):

1. For each incoming row, compute candidate PRs:
   - `weight` — heaviest `actual_weight` the exercise has seen, for any rep count
   - `reps` — most `actual_reps` at or above the exercise's current weight threshold (if tracked; MVP: most reps at `actual_weight`)
   - `volume` — single-set volume (`actual_weight * actual_reps`)
   - `1rm_est` — Epley: `actual_weight * (1 + actual_reps / 30)` (cap reps ≤ 10)
2. Upsert `exercise_prs` for each `pr_type` where the candidate beats the current row. Each row carries `achieved_at` + `session_id` backreference.
3. Flip `session_sets.is_pr = 1` on any row that set at least one record.
4. Bump `exercise_prs.updated_at = now()` so the client pulls the new PR on its next sync.

Epley cap prevents runaway 1RM estimates on high-rep AMRAPs. PR rebuild is not exposed as an endpoint in v1; if it's ever needed, it's a server-local script that iterates session_sets chronologically.

## MCP rewrite (`lift-logger-mcp/`)

All existing tools (`list_exercises`, `list_workouts`, `get_workout_history`, `get_exercise_history`, `get_personal_records`, `get_volume_summary`, `query_records`, `create_exercise`, `create_workout`) reference the old schema and get rewritten. Both transports — stdio in [server.js](lift-logger-mcp/server.js) and Streamable HTTP in [server-remote.js](lift-logger-mcp/server-remote.js) — register the new set.

**New/revised tools:**
- `list_exercises({ starred?, equipment?, muscle_group? })` — filterable
- `create_exercise({ name, equipment?, muscle_groups?, movement_type?, is_unilateral? })`
- `list_workouts({ tag?, starred?, created_by? })` — returns top-level rows only
- `get_workout({ workoutId })` — returns the workout with its full block tree (blocks → exercises → sets) as nested JSON, reading from the normalized tables
- `create_workout({ name, description?, tags?, est_duration?, blocks: [...] })` — accepts the full block tree; server normalizes into the 4 template tables in one transaction; `created_by` = `'agent'` when called via MCP
- `update_workout` / `delete_workout` — template-level mutations
- `suggest_alt_exercises({ exerciseId })` — reads `block_exercises.alt_exercise_ids` plus library candidates matching `movement_type` + `muscle_groups`
- `get_session_history({ startDate?, endDate?, workoutId?, limit? })` — returns sessions + set counts; agent can drill in with:
- `get_session({ sessionId })` — full session with snapshot + all `session_sets`
- `get_exercise_history({ exerciseId, startDate?, endDate?, limit? })` — over `session_sets`
- `get_prs({ exerciseId? })` — reads `exercise_prs` directly
- `get_volume_summary({ startDate, endDate, groupBy })` — aggregates `session_sets.actual_weight * actual_reps`
- `query_session_sets(...)` — flexible filter, replaces `query_records`

**Zod schemas** for the nested `create_workout` input: `Block = {kind, position, rounds?, rest_after_sec?, setup_cue?, exercises: BlockExercise[]}`, `BlockExercise = {exercise_id, position, alt_exercise_ids?, sets: SetTarget[]}`, `SetTarget = {set_number, target_weight?, target_pct_1rm?, target_reps?, target_reps_each?, target_duration_sec?, target_rpe?, is_peak?, rest_after_sec?, notes?}` — with the same XOR/at-least-one-target invariants as the DB CHECK constraints.

Shared DB access lives in [lift-logger-mcp/db.js](lift-logger-mcp/db.js) and gets rewritten to point at `data/iron.db`.

## Migration mechanism

- `schema_version` table created alongside the rest of v1.
- `runMigrations(db)` runs on every startup, right after `db.exec(schema)` (where [db/database.js:9](lift-logger-api/db/database.js) is today).
- Reads current version with `SELECT MAX(version) FROM schema_version`. If empty, treats as v0 and applies v1 (which is a no-op beyond the `CREATE TABLE IF NOT EXISTS` already run) then `INSERT INTO schema_version(version) VALUES (1)`.
- Future changes (v2+) go in numbered migration functions — `migrations[2](db)` etc. Each runs in a transaction and bumps the version row.
- Idempotent column adds use `PRAGMA table_info(table)` checks.

## File-by-file changes

**`lift-logger-api/`**
- `db/schema.js` — replace entirely with the 8-table IRON schema above.
- `db/database.js` — rewrite: new `upsertRow(table, row)` generic helper driven by a per-table column-map; new `getChangesSince(table, since)`; `runMigrations()`; PR computation routine (`recomputePRsForSessionSet(row, tx)`).
- `routes/sync.js` — generalize to the `{tables: {name: {lastSync, changes}}}` payload shape. Iterate tables in dependency-safe order on write (exercises → workouts → blocks → block_exercises → sets → sessions → session_sets → prs); collect all changes since each table's `lastSync` on read.
- `server.js` — unchanged (still single-port Express serving `public/` + `/api/*`).
- `scripts/load-backup.js` — remove/deprecate the old shape; optional new seed script `scripts/seed-iron.js` for loading an initial set of exercises + example workouts from JSON files.
- `data/iron.db` — new DB file, created fresh on first startup. Old `liftlogger.db` left untouched.

**`lift-logger-mcp/`**
- `db.js` — repoint to `data/iron.db`; add helpers for reading the nested workout tree and upserting a nested `create_workout` payload transactionally.
- `tools/exercises.js` — new/rewritten: `list_exercises`, `create_exercise`, `suggest_alt_exercises`.
- `tools/workouts.js` — new/rewritten: `list_workouts`, `get_workout`, `create_workout` (nested), `update_workout`, `delete_workout`.
- `tools/sessions.js` — new: `get_session_history`, `get_session`.
- `tools/analysis.js` — rewrite: `get_exercise_history`, `get_prs`, `get_volume_summary`, `query_session_sets` against `session_sets`.
- `server.js` + `server-remote.js` — register the new tool set; drop the old tools. Keep Zod validation at the choke point.
- `package.json` — no new deps expected.

**Docs**
- `CLAUDE.md` — rewrite the Architecture + Schema + MCP sections to reflect IRON.
- `TODO.md` — note follow-ups: frontend rebuild (separate plan), optional PR rebuild script, optional agent endpoint to push workouts via REST if direct-DB access becomes inconvenient.

**Out of scope for this plan**
- IRON frontend rebuild (React+Vite, tabs, Transition/Active Lift/Summary screens, design system) — separate plan.
- Migrating historical `liftlogger.db` records into IRON `session_sets`.
- Multi-user support, auth.

## Deployment

Unchanged in shape. The deploy chain still looks like:
```
git push origin main
ssh pinto "cd ~/lift-logger-repo && git pull"
ssh pinto "cd ~/lift-logger-repo/lift-logger-api && npm install"   # if deps changed
ssh pinto "cd ~/lift-logger-repo/lift-logger-mcp && npm install"   # if deps changed
ssh pinto "sudo systemctl restart lift-logger lift-logger-mcp-remote"
```
First restart on new code creates `data/iron.db` automatically via `CREATE TABLE IF NOT EXISTS`. Old `data/liftlogger.db` stays on disk untouched.

When the IRON frontend is ready, the deploy step that copies frontend files to `public/` is replaced by a Vite build step whose output goes to `lift-logger-api/public/`.

## Verification

Run each after deployment. All commands assume Tailscale access to the Pi.

1. **Fresh DB** — SSH to Pi, confirm `data/iron.db` exists, open it with `sqlite3` and `.schema`, verify 8 tables + `schema_version` row at 1.
2. **Seed + MCP create_workout** — via MCP (from Claude.ai / Claude Desktop), call `create_exercise` for a handful of lifts, then `create_workout` with a nested block tree containing one `single` pyramid block and one `superset` block. Then `get_workout({workoutId})` — assert the returned tree round-trips structurally identical to what was sent.
3. **Sync protocol** — `curl -X POST http://100.75.94.59:3000/api/sync -d '{"tables":{}}'` returns all rows since lastSync=0 across all 8 tables. Then send a `session_sets` insert with `actual_weight=135`, `actual_reps=10` for an exercise with no prior history; confirm response includes updated `exercise_prs` rows (weight/reps/volume/1rm_est) and the session_sets row comes back with `is_pr=1`.
4. **PR correctness** — insert a second session_sets row at `actual_weight=130, actual_reps=12`. Confirm `exercise_prs(weight)` stays at 135 (not beaten), `exercise_prs(volume)` updates if 130×12=1560 > 135×10=1350 (it does), `exercise_prs(1rm_est)` updates appropriately. Confirm the second row's `is_pr=1` only if it set *any* record.
5. **Agent isolation** — via MCP, call `create_workout` with a plan that includes a set at `target_weight=500`. Confirm `exercise_prs` did NOT change (MCP writes don't touch PRs).
6. **LWW sync** — simulate two clients: POST a workout with `updated_at=T`, then POST an overlapping update with `updated_at=T-1`. Confirm the older update is ignored. Repeat with `updated_at=T+1` and confirm the newer one wins.
7. **Idempotent restart** — restart the systemd service twice. Confirm no duplicate schema_version row, no errors, DB intact.
8. **MCP tool surface** — from Claude, call each new tool once with realistic inputs; verify shapes and error handling (e.g. unknown `exerciseId` → clean error).
