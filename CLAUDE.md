# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Application Overview

Lift Logger is a single-page PWA for workout tracking built with vanilla HTML/CSS/JavaScript. It's designed as a mobile-first, offline-capable fitness tracker with IndexedDB storage and Pi backend sync.

## Development Commands

### Frontend (vanilla web app, no build process)
- **Run locally**: Open `index.html` in browser, or `python3 -m http.server 8000` for PWA features
- **Test**: Manual testing in browser (no automated test suite)
- **Deploy**: Frontend is served by the Express backend from `lift-logger-api/public/`

### Backend (`lift-logger-api/`)
- **Install**: `cd lift-logger-api && npm install`
- **Run locally**: `node server.js` (runs on port 3000)
- **Test endpoints**:
  ```bash
  curl http://localhost:3000/health
  curl -X POST http://localhost:3000/api/sync -H "Content-Type: application/json" -d '{"lastSync":0,"changes":{}}'
  ```

## Architecture

### Single-File Application
The entire application is contained in `index.html` (~2,900 lines) with embedded CSS and JavaScript, plus PWA support files (`manifest.json`, `sw.js`).

### Data Architecture
- **Offline-first storage**: Primary data lives in IndexedDB via Dexie.js
- **Session persistence**: Active workout state saved to localStorage (`liftLogger_activeSession`)
- **All methods async**: DatabaseService and SyncService methods return Promises
- **Sync-ready**: All entities have `updatedAt` timestamps for incremental sync
- **Three data types**: Exercises (definitions), Workouts (templates), Records (actual workout data)

### Key Classes

**DatabaseService** (~lines 725-1115): IndexedDB persistence via Dexie.js
- Manages IndexedDB stores: `exercises`, `workouts`, `records`, `activeSession`, `syncMeta`
- Maintains in-memory `exerciseMap` and `workoutMap` for fast lookups
- Auto-migrates existing localStorage data on first run
- All CRUD operations are async with `updatedAt` timestamps
- Sync methods: `getChangesSince()`, `applyServerChanges()`, `getLastSync()`, `setLastSync()`

**SyncService** (~lines 1120-1220): Bidirectional sync with Pi backend
- `setConfig(url)` / `getConfig()`: Manage API URL (no API key - Tailscale provides security)
- `isConfigured()`: Check if sync URL is set
- `checkConnection()`: Test server health endpoint
- `sync()`: Incremental bidirectional sync with mutex to prevent double-sync
- `getLastSyncTime()` / `formatLastSync()`: Display last sync time
- Uses server's `syncTimestamp` to avoid clock skew issues

**WeightTrackerApp** (~lines 1230-2900): Main application controller
- View navigation and UI state management
- Workout flow orchestration (start → record sets → finish)
- Session persistence with debounced saves (`scheduleSessionSave()`)
- Reusable exercise search: `sortExercises()`, `renderSearchInput(targetId)`, `filterExerciseList(query, containerId)` — used in exercise view, workout creation, and add-exercise-to-workout modal
- All methods that touch data are async/await

### Data Flow
1. App initializes → DatabaseService loads from IndexedDB → Builds lookup maps
2. User selects workout → Records exercises with sets/reps/weights → Saves to IndexedDB
3. Session state persists via `saveWorkoutSession()` for crash recovery
4. Sync: SyncService sends changes since `lastSync`, receives server changes, applies with `updatedAt` conflict resolution (newer wins)

### PWA Structure
- `manifest.json`: PWA manifest with standalone display mode
- `sw.js`: Service worker with cache-first strategy (explicitly excludes `/api/` routes)
- `icons/`: App icons (user must provide actual image files)

### Key Features

**Session Persistence**
- `scheduleSessionSave()`: Debounced (300ms) session saves
- `saveWorkoutSession()`: Saves workout state to localStorage
- Triggered on: visibility change, beforeunload, set data changes
- Session includes: workoutId, exerciseSets, currentExercise, completedExercises

**Inline Editing System**
- Real-time set editing with `updateSetData()` providing immediate visual feedback
- Visual state via `updateSetRowStyling()` (has-data vs empty styling)
- Uses `oninput` events for immediate responsiveness

**Workout CRUD**
- Create/edit share `createWorkoutView` — `showCreateWorkoutView()` vs `showEditWorkoutView(id)` set `editingWorkoutId` and reuse `tempWorkoutExercises`
- Exercise picker modal with live search for adding exercises to workout
- Exercises in workout are ordered; UI has move up/down/delete buttons
- Workout deletion is hard delete (no `is_deleted` field); history falls back to "Unknown Workout" via `getWorkoutName()`
- Exercise deletion is soft delete (`isDeleted` flag) — exercises table has `is_deleted` column, workouts table does not

**Workout Resumption**
- Active workout persistence in IndexedDB and session storage
- Resume capability with time elapsed display
- Current workouts section on home screen

## Configuration

Pi sync requires (stored in localStorage):
- `liftLogger_apiUrl`: Server URL via Tailscale (e.g., `http://100.75.94.59:3000`)

No API key needed - Tailscale provides network-level security.

## Pi Backend

The companion backend is in `lift-logger-api/`:
- Node.js + Express.js + better-sqlite3
- Serves frontend from `public/` (single port for app + API)
- `GET /health`: Health check
- `POST /api/sync`: Incremental bidirectional sync (no auth - Tailscale secured)
- Uses `updated_at` timestamps for Last-Write-Wins conflict resolution

### Deployment
```bash
# Pi (pinto) addresses
# Hostname: pinto
# Tailscale: 100.75.94.59

# Pi repo is at ~/lift-logger-repo (cloned from GitHub)
# App runs from ~/lift-logger-repo/lift-logger-api/

# Deploy: push to GitHub, then pull on Pi
git push origin main
ssh bcransto@pinto "cd ~/lift-logger-repo && git pull"

# Copy frontend files to public/ (gitignored, must be done after pull)
ssh bcransto@pinto "cd ~/lift-logger-repo && cp index.html manifest.json sw.js lift-logger-api/public/ && cp -r icons lift-logger-api/public/"

# Restart service
ssh bcransto@pinto "sudo systemctl restart lift-logger"

# If dependencies changed:
ssh bcransto@pinto "cd ~/lift-logger-repo/lift-logger-api && npm install"
```

### Service management (run on Pi)
```bash
sudo systemctl status lift-logger    # Check status
sudo systemctl restart lift-logger   # Restart
journalctl -u lift-logger -f         # View logs
```

### Load backup data
```bash
# Load from backup directory into server
node lift-logger-api/scripts/load-backup.js http://pinto:3000
```

## Code Patterns

- ES6 classes with async/await throughout
- Template literals for HTML generation
- Cached Maps (`exerciseMap`, `workoutMap`) for sync lookups from IndexedDB
- All database operations are async - callers must await
- Debounced session saves to avoid excessive writes
- Mobile-first design with iOS-specific PWA optimizations
- Views are switched via CSS class `.active`; `showView(viewId)` handles navigation and triggers data loading via switch statement
- Modals use a single shared `#modal` / `#modalContent` container; shown/hidden via `.show` class
- Exercise lists reuse shared `sortExercises()`, `renderSearchInput()`, and `filterExerciseList()` for consistent search/filter behavior
- Use `font-size: 16px` on inputs to prevent iOS auto-zoom
