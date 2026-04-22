# IRON Frontend — Plan

## Context

Companion to the IRON Backend plan at [iron-backend-plan.md](iron-backend-plan.md). This plan covers the iPhone PWA rebuild — a clean-slate React/Vite app that replaces the current vanilla `index.html`. Backend and frontend will be built in parallel; the two sides meet at the sync contract (the 8-table schema + `{tables: {name: {lastSync, changes}}}` payload defined in the backend plan).

**Scope**: the phone app only. MCP server and SQLite backend are covered by the backend plan. The frontend only talks to Pi via `POST /api/sync`; it never talks to MCP.

## Stack (locked)

- **TypeScript** + **React 18**
- **Vite** + **vite-plugin-pwa** (Workbox under the hood)
- **Zustand** for cross-screen state (session cursor, timer, sync status)
- **Dexie.js** for IndexedDB (mirrors the 8 backend tables + local metadata)
- **React Router v6** for navigation
- **CSS Modules** + CSS variables (no utility framework)
- **Archivo Black** (display), **Archivo** (body), **JetBrains Mono** (labels/numerics) — self-hosted WOFF2 via `@font-face`
- Native browser APIs: Web Audio (timer chime), Vibration, Wake Lock (keep screen on during workout)

Build output lands in `lift-logger-api/public/` so the existing single-port Express server continues to serve the app.

## Phase 1 scope (ship this first)

Aggressive cut. Everything marked Phase 2 is deferred to its own follow-up.

**In**
- Workouts tab only (Exercises/Stats/Settings = stub screens with "coming soon")
- Screen flow: Home → Overview → Transition → Active Lift (single view, no swipe) → Summary
- Manual weight/rep entry with ±5 / ±1 steppers and type-to-override
- Rest timer auto-start on Transition; manual "Start Rest" on Active Lift
- Peak-set ★ rendering
- Two-layer save preference (session_only / template, sticky on first edit)
- Add/delete sets, edit weight/reps/duration on Transition
- Offline-first workout execution with Dexie as local truth
- Sync against the new per-table payload
- PR banner on Summary (reads `exercise_prs`)
- Installable PWA with icon set, splash, standalone mode
- Home search bar + sort dropdown + filter chips (cheap, keep in Phase 1)

**Out (deferred to Phase 2)**
- Swipeable Active Lift (Views 2 & 3 — Multi-set grid and Workout Progress)
- Swap Exercise bottom sheet
- Exercises / Stats / Settings tab contents
- Pull-to-refresh (manual sync button in header is enough for Phase 1)
- Notes field on Summary
- Unit preference toggle (hardcode `lb`; store on a settings row when Phase 2 lands)
- "New" filter chip highlight for agent-created workouts (surface `created_by = 'agent'` later)
- Advanced HIIT UI (big-number countdown Phase 2; functional timer-per-set works in Phase 1)

## Design system

CSS variables in `src/styles/tokens.css`:

```css
:root {
  --bg: #0a0a0a;
  --bg-elev-1: #141414;
  --bg-elev-2: #1f1f1f;
  --text: #f5f1e8;
  --text-dim: #8a847a;
  --text-faint: #4a4640;
  --accent: #ff5a1f;
  --accent-2: #ffc21f;
  --ok: #8bc34a;
  --radius-sm: 6px;
  --radius-md: 12px;
  --radius-lg: 20px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --font-display: 'Archivo Black', system-ui, sans-serif;
  --font-body: 'Archivo', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
  --tap-min: 48px;
}
```

Component CSS is scoped via `.module.css`. Fonts served from `/public/fonts/` (self-hosted to avoid Google Fonts fetch on first PWA load). `font-size: 16px` on all inputs to prevent iOS auto-zoom. All interactive targets ≥ `--tap-min`. Safe-area insets via `env(safe-area-inset-*)` on the app shell and tab bar.

## Directory layout

New directory at repo root:

```
lift-logger-frontend/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
├── public/
│   ├── fonts/
│   └── icons/
└── src/
    ├── main.tsx                    # entry, router, providers
    ├── App.tsx                     # shell: tab bar + <Outlet>
    ├── routes.tsx                  # React Router v6 config
    ├── styles/
    │   ├── tokens.css              # CSS variables
    │   ├── global.css              # resets, @font-face, body
    │   └── typography.module.css
    ├── db/
    │   ├── schema.ts               # Dexie table defs, mirrors backend 8 tables + local stores
    │   ├── db.ts                   # Dexie instance
    │   └── queries.ts              # reactive hooks (useWorkouts, useSession, etc.)
    ├── sync/
    │   ├── syncService.ts          # POST /api/sync, apply changes
    │   ├── syncWorker.ts           # reconnect push, manual trigger
    │   └── useSyncStatus.ts
    ├── stores/
    │   ├── sessionStore.ts         # Zustand: active session cursor, timer, pending edits
    │   └── uiStore.ts              # save-preference banner, modal state
    ├── types/
    │   ├── schema.ts               # shared types mirroring backend
    │   └── ids.ts                  # branded ID types (ExerciseId, WorkoutId, ...)
    ├── features/
    │   ├── workouts/
    │   │   ├── HomeScreen.tsx
    │   │   ├── OverviewScreen.tsx
    │   │   ├── WorkoutCard.tsx
    │   │   ├── FilterChips.tsx
    │   │   └── SetPatternRenderer.tsx
    │   ├── session/
    │   │   ├── TransitionScreen.tsx
    │   │   ├── ActiveLiftScreen.tsx
    │   │   ├── SummaryScreen.tsx
    │   │   ├── SetCard.tsx
    │   │   ├── RestTimerCard.tsx
    │   │   ├── SavePreferencePrompt.tsx
    │   │   └── sessionEngine.ts    # cursor advancement pure fns
    │   ├── timer/
    │   │   ├── TimerService.ts     # startedAt-based, survives reload
    │   │   └── chime.ts            # Web Audio cue
    │   └── stubs/
    │       ├── ExercisesTab.tsx
    │       ├── StatsTab.tsx
    │       └── SettingsTab.tsx
    ├── shared/
    │   ├── components/
    │   │   ├── TabBar.tsx
    │   │   ├── SyncIndicator.tsx
    │   │   ├── Button.tsx
    │   │   ├── NumberStepper.tsx
    │   │   └── Sheet.tsx           # bottom sheet primitive (used Phase 2)
    │   ├── hooks/
    │   │   ├── useWakeLock.ts
    │   │   └── useVisibility.ts
    │   └── utils/
    │       ├── format.ts           # relative dates, weight display
    │       └── uuid.ts
    └── serviceWorker.ts            # vite-plugin-pwa injects; custom handlers here
```

## Data layer (Dexie)

Mirrors the 8 backend tables exactly — same column names, camelCase in TS types, snake_case in DB (map at the edge). Plus two local-only stores (`syncMeta`, `settings`).

```ts
db.version(1).stores({
  exercises:           'id, starred, updatedAt',
  workouts:            'id, starred, lastPerformed, updatedAt',
  workoutBlocks:       'id, workoutId, [workoutId+position], updatedAt',
  blockExercises:      'id, blockId, [blockId+position], updatedAt',
  blockExerciseSets:   'id, blockExerciseId, [blockExerciseId+setNumber], updatedAt',
  sessions:            'id, workoutId, status, startedAt, updatedAt',
  sessionSets:         'id, sessionId, exerciseId, loggedAt, updatedAt',
  exercisePrs:         'id, exerciseId, [exerciseId+prType], updatedAt',

  // local-only
  syncMeta:            'table',       // { table: string, lastSync: number }
  settings:            'key'          // { key: 'units' | 'apiUrl' | ..., value }
});
```

Reactive queries via `dexie-react-hooks` (`useLiveQuery`). All timestamps are `number` (epoch millis) to match backend. Boolean flags persist as `0|1` to match SQLite and are normalized to `boolean` at the type boundary.

### Shared schema types

`src/types/schema.ts` defines the canonical TS types for every table. **This file is the contract with the backend.** Keep it in sync by hand during parallel work. Later we can extract to a shared package and generate from a single source (a JSON schema or zod schemas).

## Sync service

Single class `SyncService` in `src/sync/syncService.ts`.

- **Push then pull in one request.** Build payload by reading `syncMeta.lastSync` per table + Dexie rows where `updatedAt > lastSync`. POST to `/api/sync`. Apply response: upsert each table's returned rows, then write the server-reported `syncTimestamp` back to `syncMeta`.
- **Mutex** to prevent concurrent syncs.
- **Reconnect push** via `navigator.onLine` + `online` event listener.
- **Manual trigger** from the Home header button.
- **No auto-polling during a workout** — a live session shouldn't race with sync. Run sync only when idle or on manual trigger.
- **Conflict model**: server is authoritative via LWW on `updated_at`. Client accepts server rows wholesale where `server.updated_at > local.updated_at`.
- **`exercise_prs` is read-only on the client** — never push; only accept.

`useSyncStatus` hook exposes `{ status: 'idle'|'syncing'|'error'|'offline', lastSync: number }` for the `SyncIndicator` in the header.

## State management

Zustand stores for state that crosses screens. Everything else reads Dexie directly via `useLiveQuery`.

### `sessionStore` (the important one)

Holds the active workout cursor + timer. Hydrated from Dexie on app load (from the `active` session, if any). Persisted to Dexie on change (debounced).

```ts
type SessionState = {
  sessionId: string | null;
  snapshot: WorkoutSnapshot | null;
  cursor: {
    blockPosition: number;
    blockExercisePosition: number;
    roundNumber: number;
    setNumber: number;
  };
  logged: Record<string, SessionSet>;  // key: `${block}.${be}.${round}.${set}`
  pendingEdits: PendingEdit[];         // edits waiting for save-preference
  savePreference: 'session_only' | 'template' | null;
  timer: {
    kind: 'setup' | 'rest' | 'block_rest' | 'work' | null;
    startedAt: number | null;
    durationSec: number | null;
  };

  startSession(workoutId: string): Promise<void>;
  advanceCursor(): void;
  jumpToCursor(target: Partial<Cursor>): void;
  logSet(actual: LoggedSet): Promise<void>;
  startTimer(kind, durationSec): void;
  adjustTimer(delta: number): void;
  cancelTimer(): void;
  applyEdit(edit: StructuralEdit): Promise<void>;
  completeSession(notes?: string): Promise<void>;
  abandonSession(): Promise<void>;
};
```

### `uiStore`

Ephemeral UI state: save-preference prompt visibility, currently open modal, the session/template badge near edited elements.

### No global store for workout/exercise lists

Those are pure data; read Dexie directly. Stores are only for state that isn't naturally persisted.

## Routing

React Router v6 with data routers. Paths:

```
/                                                  → HomeScreen (Workouts tab)
/workout/:workoutId                                → OverviewScreen
/session/:sessionId                                → redirect to current cursor
/session/:sessionId/transition/:blockPosition      → TransitionScreen
/session/:sessionId/active/:blockPosition/:setKey  → ActiveLiftScreen
/session/:sessionId/summary                        → SummaryScreen
/exercises                                         → ExercisesTab (stub)
/stats                                             → StatsTab (stub)
/settings                                          → SettingsTab (stub)
```

`setKey` encodes `blockExercisePosition.roundNumber.setNumber` (e.g. `1.1.3`) so a single URL is bookmarkable. The cursor in `sessionStore` is authoritative; URL is for back/forward and reload safety.

Tab bar sits at the bottom of the app shell. It hides on session screens (Transition / Active Lift / Summary) — the workout flow is modal by design.

## Screens

### Home (Workouts tab)

`src/features/workouts/HomeScreen.tsx`. Data from `useLiveQuery(() => db.workouts.toArray())`.

- Eyebrow: "MON · 10:02 AM" (date + time, updates every minute)
- Display title: "IRON."
- Search input — live filter by workout `name`, `tags`, and exercise names inside (requires a one-time denormalized search string per workout)
- Filter chips: `All`, `★ Starred`, plus chips derived from existing `tags`. `New`/`Recent` chips require `last_seen_at` local; defer to Phase 2.
- Sort dropdown: Last performed (default) / Starred first / A→Z / Duration / Most performed
- Workout cards:
  - Title (Archivo Black 17px)
  - Meta: `{est_duration || '—'} MIN · {lift_count} LIFTS · {last_performed || 'NEW'}`
  - Star button (toggles `workouts.starred`, bumps `updatedAt`, enqueues sync)
  - Starred card gets `border: 1px solid var(--accent)`
- Empty state: "No workouts yet — agent hasn't uploaded any."
- `SyncIndicator` in the header

**Tap card** → `navigate(\`/workout/\${id}\`)`. **Tap star** → toggle only.

### Overview

`src/features/workouts/OverviewScreen.tsx`. Data joined from the 4 template tables for the given `workoutId`.

- Back chevron
- Eyebrow: "OVERVIEW · {N} LIFTS"
- Display title + description
- Meta pills: `≈ {est_duration} MIN` · `LAST: {relative}` · star
- Exercise rows numbered `01`, `02`, ... (block position); superset/circuit grouped under a yellow left bracket with sub-numbering (`04a`, `04b`)
- `SetPatternRenderer` per block_exercise:
  - Pyramid (sets differ): `135×12 → 155×10 → 175×8 → 185×6 ★`
  - Straight (sets identical): `40 × 10 × 3`
  - Varied reps same weight: `40 × 10, 10, 10`
  - Unilateral: `37.5 × 10 ea × 3`
  - Time-based: `BW · 40s × 3`
- Equipment tags as small yellow inline pills (`[DB]`, `[LANDMINE]`) from `exercises.equipment`
- Primary "Start Workout →" button at bottom

**Start** creates a `sessions` row with `status='active'` and `workout_snapshot` frozen from the joined template. Snapshot is computed in `sessionStore.startSession()` and written to Dexie before navigating.

### Transition

`src/features/session/TransitionScreen.tsx`. Pre-block screen, shown before every block (including the first).

- Header eyebrow: `UP NEXT · LIFT {n} OF {total}` + `{mm:ss} ELAPSED` (from `sessions.started_at`)
- Exercise display (large Archivo Black)
- **RestTimerCard** — auto-starts on mount with `block.rest_after_sec` (or a sensible default for block 1). `-15` / `+15` pills. Does **not** block input. Green at zero + chime + vibration.
- STATION SETUP — parsed from `workout_blocks.setup_cue`. Plain text; bold `**key**` values rendered in amber.
- SETS grid (2×N):
  - Each card: `SET {n}` label + weight + reps/duration
  - Current (first un-logged) set: orange border + subtle orange tint
  - Done (when revisiting): green ✓ + "Actual: {w} × {r}"
  - Peak (`is_peak=1`): amber border + ★ in label
  - Tap to expand inline and edit weight/reps/rest/duration — triggers the save-preference gate
- Action row: `+ Add Set` / `× Delete Ex.` (Phase 1 allows delete only if block has >1 exercise or workout has >1 block; otherwise hide)
- **Swap exercise row** — Phase 2. Phase 1: hide.
- Primary `I'm Ready →` button. Flushes pending edits and navigates to `/session/.../active/...`.
- **v3: round tabs** for superset/circuit blocks with `rounds > 1`. Horizontal scrollable strip (`R1 · R2 · R3 · …`) above the set grid. Active tab highlighted; rounds that have explicit override rows show an amber `•` dot after the label. Tapping a tab filters the set grid via `setsForRound(be, effectiveRound)` and routes all `applyEdit` calls with `roundNumber: effectiveRound`. Single blocks never render the tabs. Block-level `+ Add Round (clones R{N})` and `− Remove Last Round` buttons sit below the grid — they replace the per-exercise `+ Add Set` for supersets (sets-per-round is a template-time concern; mid-workout you add *rounds*, not sets).

### Active Lift (Phase 1: View 1 only)

`src/features/session/ActiveLiftScreen.tsx`.

- Top progress bar: fraction of workout complete by sets logged
- Eyebrow: `[LIFTING]` badge · `LIFT {n} / {total}`
- Exercise display
- `SET {n} OF {total}` sub-eyebrow
- **TODAY'S TARGET** card — orange gradient background
  - Big: `{target_weight} × {target_reps}` or `{target_duration_sec}s`
  - Small: `Last time: {last_actual_weight} × {last_actual_reps}` (from `session_sets` for this exercise, most recent set at same `block_exercise_position`)
- Input grid:
  - WEIGHT card: big number, `-5` / `+5` steppers, tap number to enter
  - REPS card: big number, `-1` / `+1`, tap to enter
  - (if duration-based, swap REPS for DURATION with ±5s)
- **RestTimerCard** — manual Start Rest. Running: countdown + Skip. Zero: chime + haptic + auto-hide.
- Primary `Log Set →` button:
  - Writes `session_sets` row with targets copied from snapshot and actuals from inputs
  - Bumps `sessions.updated_at`
  - Calls `advanceCursor()`
  - New block → navigate to that block's Transition
  - Cursor exhausted → navigate to Summary

### Summary

`src/features/session/SummaryScreen.tsx`. Data: the session + all `session_sets` + any `exercise_prs` updated this session.

- Eyebrow: "WORKOUT COMPLETE"
- Display: "Done." + orange dot
- Date eyebrow: `{DOW} · {MON DD} · {HH:MM AM}`
- Stats grid (3 cells): `duration_sec` mm:ss · total volume (sum of `actual_weight * actual_reps`) · set count
- **PR banner** (yellow gradient) — shown only if any `session_sets.is_pr=1` exists for this session. Lists each PR as `{EXERCISE NAME} {weight}×{reps}`.
- SESSION LOG — per exercise: name (with ★ if PR), actuals (`135×12 · 155×10 · ...`), right-aligned exercise volume
- `Done` button → sets `status='completed'`, `ended_at=now`, attempts sync, navigates Home
- `Add note` → Phase 2 (wire the button; show "coming soon" toast)

## Session engine

Pure functions in `src/features/session/sessionEngine.ts`. No React, no Dexie — just cursor advancement and snapshot traversal.

```ts
function advance(snapshot: WorkoutSnapshot, cursor: Cursor): Cursor | null;
function* iterateSets(snapshot: WorkoutSnapshot): Generator<CursorWithTarget>;
function targetAt(snapshot: WorkoutSnapshot, cursor: Cursor): SetTarget | null;
```

Pure functions let us unit-test the engine without DOM/Dexie, and make `sessionStore.advanceCursor` a one-liner.

**Superset ordering** (the tricky case): for a block with `kind='superset'` and `rounds=3`, execution order is round-major: `(be1 sets), (be2 sets), (be1 sets), (be2 sets), (be1 sets), (be2 sets)`. Straight `single` blocks are just `(sets)`. Circuit behaves like superset with potentially time-based sets. HIIT is modeled as `circuit` with `target_duration_sec` per set.

**Per-round targets (v3)**: each `SnapshotSetTarget` carries an optional `round_number`. [`buildWorkoutSnapshot`](../lift-logger-frontend/src/db/queries.ts) round-expands the raw `block_exercise_sets` rows at session start, merging anchor + per-round overrides into one entry per `(round, set_number)`. The engine then filters `be.sets` by `round_number === r` inside its round loop. `setsForRound(be, r)` exported from [`sessionEngine.ts`](../lift-logger-frontend/src/features/session/sessionEngine.ts) provides implicit round-1 fallback so legacy flat snapshots (pre-v3 sessions, authored-without-overrides templates) still walk every round. Consumers that iterate `be.sets` directly (BlockView legacy path, WorkoutView counts, SetView/SetPatternRenderer lookups) should use `setsForRound` rather than the raw array to stay round-aware.

**Structural edits** carry `roundNumber` on every variant (`editSetTarget`, `addSet`, `deleteSet`). `deleteSet` renumbering is scoped per round so other rounds' set_numbers stay stable. The store also has two block-level edits — `addRound` (clones the last round's targets into `rounds+1`, writes explicit override rows across every BE) and `removeLastRound` (decrements `block.rounds`, preserves orphan override rows for a possible regrow). On save preference `template`, `propagateEditsToTemplate` writes these through to the Dexie compound index `[block_exercise_id+round_number+set_number]`.

**Unplanned mid-session additions** are Phase 2. For Phase 1, the UI doesn't expose "add exercise mid-workout"; only add/delete *sets* within existing block_exercises.

## Two-layer save flow

First structural edit on Transition → show `SavePreferencePrompt` inline below the edited element:

```
Save this change to template, or just this session?
  [ This Session ]  [ Save to Template ]
```

`sessionStore.applyEdit(edit)`:
1. If `savePreference === null`, queue the edit in `pendingEdits` and open the prompt.
2. User picks → set `savePreference`, apply the queued edit(s), close prompt.
3. Subsequent edits call `applyEdit` which applies immediately per sticky preference.

**session_only path**: mutate `sessions.workout_snapshot` JSON only. Bump `sessions.updated_at`. Do NOT touch template tables.

**template path**: mutate `sessions.workout_snapshot` AND the backing `workout_blocks` / `block_exercises` / `block_exercise_sets` rows. Bump `workouts.updated_at`. Sync propagates both.

A small tag near the edited element shows `session` or `template` once the preference is set, so the user always knows where edits are going.

**Allowed Phase 1 edits** (Transition screen only):
- Add a set to a `block_exercise`
- Delete a set
- Edit `target_weight`, `target_reps`, `target_duration_sec`, `rest_after_sec`, `is_peak` on any set

Everything else (swap exercise, reorder, add exercise, edit station cue) is Phase 2.

## Timer service

`src/features/timer/TimerService.ts` — a thin wrapper around `startedAt` + `durationSec`, NOT a running `setInterval`. State lives in `sessionStore.timer`.

- `startTimer(kind, durationSec)` sets `startedAt = Date.now()`.
- UI polls via a single 250ms `setInterval` that only runs when a timer is active (started via `useEffect` in the currently mounted screen).
- `elapsedSec = (Date.now() - startedAt) / 1000`; `remainingSec = durationSec - elapsedSec`.
- Crossing zero: fire chime (Web Audio), vibration (`navigator.vibrate([120, 60, 120])`), flip card to green. Clear the interval.
- Backgrounded tabs still work because we compute from `Date.now()`, not a counter.
- Wake Lock acquired on `startSession`, released on `completeSession`/`abandonSession`, re-acquired on visibility change.

Chime is a short generated oscillator tone (no audio file to precache).

## PWA config

`vite.config.ts`:

```ts
VitePWA({
  registerType: 'autoUpdate',
  includeAssets: ['fonts/*.woff2', 'icons/*.png'],
  manifest: {
    name: 'IRON',
    short_name: 'IRON',
    theme_color: '#0a0a0a',
    background_color: '#0a0a0a',
    display: 'standalone',
    orientation: 'portrait',
    icons: [/* 192, 512, maskable */]
  },
  workbox: {
    navigateFallback: '/index.html',
    runtimeCaching: [
      {
        urlPattern: /\/api\//,
        handler: 'NetworkOnly'       // never cache sync requests
      },
      {
        urlPattern: /\/fonts\//,
        handler: 'CacheFirst',
        options: { cacheName: 'fonts', expiration: { maxAgeSeconds: 60*60*24*365 }}
      }
    ]
  }
})
```

`/api/` must be `NetworkOnly` — the current vanilla app already encodes this; port it forward.

Icons generated once from a source SVG (Archivo Black "I" on an orange square) into `192`, `512`, and `maskable` sizes.

## Contract with the backend

The sync payload shape and table column names are the contract. To minimize drift during parallel development:

1. **`src/types/schema.ts` is the source of truth on the frontend.** Each table type matches the backend `CREATE TABLE` exactly (snake_case keys, `number` for timestamps/booleans).
2. The backend's `db/schema.js` and the frontend's `types/schema.ts` should change in the same PR when the schema evolves. Until we have a shared package, keep this discipline manual.
3. **Review step**: before starting each screen, diff the relevant portion of `types/schema.ts` against `lift-logger-api/db/schema.js`. Any mismatch blocks the screen.
4. Sync payload validation: on receipt, `SyncService.applyServerChanges` should log and skip rows whose keys don't match the expected columns rather than crash. Forward-compatible; tolerant of server additions.

## Local dev

```
cd lift-logger-frontend
npm install
npm run dev         # Vite dev server on :5173
```

Vite proxies `/api/*` to `http://localhost:3000` (the local API server). Run `node server.js` in `lift-logger-api/` alongside `npm run dev` in `lift-logger-frontend/` for a full local stack.

## Build & deploy

Vite builds to `../lift-logger-api/public/` (configured via `build.outDir`):

```
cd lift-logger-frontend && npm run build
```

On the Pi, the deploy chain becomes:

```bash
git push origin main
ssh pinto "cd ~/lift-logger-repo && git pull"
ssh pinto "cd ~/lift-logger-repo/lift-logger-frontend && npm install && npm run build"
ssh pinto "sudo systemctl restart lift-logger"
```

Pi 4 build time ~30s for a project this size. Acceptable.

## File-by-file checklist

New directory: `lift-logger-frontend/`. All files new.

**Config**
- `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `.gitignore`

**Entry + shell**
- `src/main.tsx`, `src/App.tsx`, `src/routes.tsx`, `src/styles/{tokens.css,global.css,typography.module.css}`, `src/serviceWorker.ts`

**Types + DB**
- `src/types/{schema.ts,ids.ts}`
- `src/db/{schema.ts,db.ts,queries.ts}`

**Sync + stores**
- `src/sync/{syncService.ts,syncWorker.ts,useSyncStatus.ts}`
- `src/stores/{sessionStore.ts,uiStore.ts}`

**Features — workouts**
- `src/features/workouts/{HomeScreen,OverviewScreen,WorkoutCard,FilterChips,SetPatternRenderer}.tsx`

**Features — session**
- `src/features/session/{TransitionScreen,ActiveLiftScreen,SummaryScreen,SetCard,RestTimerCard,SavePreferencePrompt}.tsx` + `sessionEngine.ts`

**Features — timer**
- `src/features/timer/{TimerService.ts,chime.ts}`

**Features — stubs**
- `src/features/stubs/{ExercisesTab,StatsTab,SettingsTab}.tsx`

**Shared**
- `src/shared/components/{TabBar,SyncIndicator,Button,NumberStepper,Sheet}.tsx`
- `src/shared/hooks/{useWakeLock,useVisibility}.ts`
- `src/shared/utils/{format.ts,uuid.ts}`

**Assets**
- `public/fonts/ArchivoBlack-Regular.woff2`, `Archivo-{400,700}.woff2`, `JetBrainsMono-{400,600}.woff2`
- `public/icons/icon-{192,512,maskable-512}.png`

**Docs**
- Update [CLAUDE.md](../CLAUDE.md) once Phase 1 ships: new frontend architecture, dev commands, build pipeline.

## Verification (Phase 1 acceptance)

All must pass:

1. **Install + launch.** Open the app URL in mobile Safari, tap Share → Add to Home Screen, launch the installed app. Confirm standalone mode (no browser chrome), IRON splash, Home screen renders with workouts synced from Pi.
2. **Offline start.** Airplane mode, relaunch from Home Screen. App shell loads, Home shows cached workouts, `SyncIndicator` shows red/offline.
3. **Full workout — pyramid.** Agent creates a pyramid workout via MCP. App pulls it on sync. Tap it → Overview shows `135×12 → 155×10 → 175×8 → 185×6 ★`. Start → Transition shows setup cues and auto-started rest timer. Log all 4 sets via Active Lift. Summary shows PRs (if any) + total volume.
4. **Full workout — superset.** 2 exercises × 3 rounds. Confirm cursor advances `be1→be2→be1→be2→be1→be2` with the right target per round. Summary log groups by exercise.
5. **Full workout — HIIT.** Circuit block with `target_duration_sec=40` and `rest_after_sec=20`. Confirm duration input mode (not weight/reps), rest timer uses `rest_after_sec`, summary volume sums duration correctly.
6. **Two-layer save — session only.** Edit a set's weight on Transition → prompt appears. Pick "This Session". Finish the workout. Check Dexie: `sessions.workout_snapshot` has the new value; `block_exercise_sets` untouched. Sync; Pi confirms same.
7. **Two-layer save — template.** Edit a set → pick "Save to Template". Check `block_exercise_sets` row updated locally. Sync pushes to Pi; `workouts.updated_at` bumped.
8. **Crash resume.** Start a workout, log 2 sets, kill the tab mid-workout. Reopen from Home Screen. App resumes at the correct cursor with correct timer remaining (computed from `startedAt`).
9. **PR detection.** Log a set heavier than any prior actuals for that exercise. Complete. Summary shows PR banner. After sync, `exercise_prs` row reflects the new record (server-side computation verified).
10. **Sync status.** Red/amber/green dot transitions on reconnect, during sync, and on success.
11. **iOS quirks.** No input zoom (font-size ≥ 16px). Safe-area respected on notched phones. Wake Lock keeps screen on during active workout. Vibration fires on timer zero.
12. **Typecheck + build.** `tsc --noEmit` clean. `vite build` produces `dist/` that serves correctly from `lift-logger-api/public/`.

## Open questions

1. **Units.** Default `lb` hardcoded in Phase 1. Settings toggle in Phase 2. User preference (one row in `settings`), not per-workout.
2. **Exercise library seed.** Should the app ship a starter set of ~30 common lifts, created on first launch if `exercises` is empty? Recommend yes — makes first install less empty while agent is uploading workouts.
3. **Agent "New" chip.** Relies on a local `last_seen_at` per workout. Defer the chip but consider tracking `last_seen_at` in Phase 1 so Phase 2 can light it up retroactively.
4. **Server URL config.** Default to `/api` (relative, same-origin). Keep Settings override for Phase 2.

## Build order (parallel-friendly with backend)

Frontend and backend share only the sync contract. Within the frontend, a sensible order that lets each step be testable on its own:

1. **Scaffold**: Vite + React + TS + PWA plugin + Dexie + Zustand + Router. Empty screens, router wired, tab bar visible.
2. **Types + Dexie schema**: `src/types/schema.ts`, `src/db/schema.ts`. Data layer only; no UI.
3. **SyncService**: push/pull payload. Mock server until backend is up. Once backend sync is live, point at real endpoint.
4. **Home + Overview**: read-only screens; no session writes yet. Test against agent-created workouts.
5. **Session engine + Zustand store**: pure logic, unit-tested.
6. **Transition screen**: reads snapshot, renders sets, auto-timer. No edits yet.
7. **Active Lift View 1**: weight/reps input, Log Set writes session_sets, cursor advances.
8. **Summary**: session log, PR banner, completion flow.
9. **Two-layer save flow**: add SavePreferencePrompt, wire pendingEdits + snapshot mutation.
10. **PWA polish**: icons, splash, Wake Lock, chime, vibration, offline shell.
11. **Phase 1 verification**: run all 12 acceptance checks.

Steps 1–3 can start immediately alongside backend work. Step 3's integration test needs the backend sync endpoint live — that's the natural sync point between the two parallel streams.
