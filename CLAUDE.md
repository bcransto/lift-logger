# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Application Overview

**IRON** is an offline-first workout tracking PWA for iPhone. The agent authors workouts via MCP; the phone executes them (pyramids, supersets, circuits, HIIT with planned-vs-actual tracking) and syncs back to the Pi. Pre-IRON vanilla app is preserved at git tag `v1-vanilla`.

`IRON` is the internal codename — it lives on in the SQLite filename (`data/iron.db`), variable names, plan docs, and this file. **User-facing strings say "Lift Logger"** (header, manifest, page title — see commit `90ce043`). Don't "fix" the user-facing copy back to IRON.

Design rationale and scope cuts are in [docs/iron-backend-plan.md](docs/iron-backend-plan.md) and [docs/iron-frontend-plan.md](docs/iron-frontend-plan.md) — treat these as the source of truth when the schema or screen flow is ambiguous. Phase-2 UX rework lives in [docs/iron-phase2-plan.md](docs/iron-phase2-plan.md).

## Repo Layout

Three packages, deployed together on the Pi:

- **`lift-logger-frontend/`** — React + TypeScript + Vite PWA. Build output lands in `../lift-logger-api/public/`.
- **`lift-logger-api/`** — Node + Express + better-sqlite3. Serves the built frontend and `/api/sync`.
- **`lift-logger-mcp/`** — MCP server with stdio + Streamable HTTP transports. Talks directly to the shared SQLite file.

Old vanilla-app artifacts (root-level `index.html`, `manifest.json`, `sw.js`) were removed in commit `d30a072` and replaced by the `lift-logger-frontend/` build pipeline.

## Development Commands

**All package commands require Node ≥ 20.19** (Vite 7 enforces this). Local dev on macOS uses nvm: `source ~/.nvm/nvm.sh && nvm use 20`.

For Claude Code sessions: see [docs/claude-code-dev-env.md](docs/claude-code-dev-env.md) for the operational details — `.claude/launch.json` wiring, worktree-based previews, port-5173 orphan-vite gotcha, iPhone over Tailscale, headless SSH git pushes.

### Frontend (`lift-logger-frontend/`)

```bash
npm install
npm run dev                 # Vite dev server on :5173, proxies /api to backend (set VITE_API_PORT=3100 locally)
npm run build               # tsc -b && vite build → ../lift-logger-api/public/
npm run typecheck           # tsc --noEmit
npm run test                # Vitest watch mode
npm run test:run            # single run (CI-style)
npm run test:run src/features/session/sessionEngine.test.ts   # one file
```

Env vars:
- `VITE_USE_MOCK_SYNC=true` → bypass `/api/sync`, use the in-memory `src/sync/mockServer.ts` (default **false**; real backend)
- `VITE_API_PORT=3100` → dev proxy target port (default `3000`; set to `3100` locally because macOS Chrome sandbox reserves `3000`)
- `TAILSCALE_DEV=1` → switches Vite HMR to `clientPort: 443` for live-testing on a real iPhone over Tailscale Serve. Required when accessing the dev server through `https://<mac>.tail2a85a6.ts.net`; **omit for plain localhost dev** or HMR will loop trying to dial port 443.

#### Live-testing on a real iPhone

The Mac dev server is exposed to the iPhone over Tailscale Serve (real HTTPS cert, tailnet-only, no router config). Per-session:

```bash
# terminal 1 — backend
PORT=3100 node server.js

# terminal 2 — frontend (note both env vars)
TAILSCALE_DEV=1 VITE_API_PORT=3100 npm run dev

# terminal 3 — expose frontend port via Tailscale (one-time per session)
tailscale serve --bg http://localhost:5173
# teardown: tailscale serve --https=443 off
```

Then open `https://bradfords-macbook-air.tail2a85a6.ts.net` on the iPhone. Vite proxies `/api/*` to the backend at `localhost:3100`, so only the frontend port needs Tailscale exposure. Vite's `server.host`, `allowedHosts`, and the env-gated `hmr.clientPort` are wired in [vite.config.ts](lift-logger-frontend/vite.config.ts).

**Seed-then-open**: if you populate the dev DB *after* the iPhone has already loaded the empty version, sync will return zero rows because the client persisted a high `lastSync` timestamp. Bump `updated_at` on all rows to "now" or clear the iOS site data. Full reference (gotchas + alternative stacks): `~/AppDev/Documents/iOS-dev-testing.md`.

### Backend (`lift-logger-api/`)

```bash
npm install
node server.js                            # :3000 (or PORT env var)
curl http://localhost:3000/health
node scripts/seed-demo.js 3000            # pyramid + superset workouts
node scripts/seed-hiit.js 3000            # Tabata Finisher (circuit, 2 ex)
node scripts/seed-circuit-4.js 3000       # Four-Station Finisher (circuit, 4 ex)
node scripts/seed-circuit-6.js 3000       # Six-Station Circuit  (circuit, 6 ex)
```

On macOS, use `PORT=3100 node server.js` — `:3000` is occupied by a sandbox WSGI proxy that intercepts requests.

### MCP (`lift-logger-mcp/`)

```bash
npm install
node server.js               # stdio (used by Claude Desktop via SSH)
node server-remote.js        # Streamable HTTP on :3002 (used by Cloudflare portal)
```

After changing Node versions: `npm rebuild better-sqlite3` in both `lift-logger-api` and `lift-logger-mcp`.

## Architecture

### Backend: 8-table SQLite + generic LWW sync

Schema lives in [lift-logger-api/db/schema.js](lift-logger-api/db/schema.js): `exercises`, `workouts`, `workout_blocks`, `block_exercises`, `block_exercise_sets`, `sessions`, `session_sets`, `exercise_prs`, plus `schema_version`. All timestamps are INTEGER epoch millis, all booleans are INTEGER 0/1. Matches [`lift-logger-frontend/src/types/schema.ts`](lift-logger-frontend/src/types/schema.ts) exactly — the two files are a manual contract.

`schema.js` is just the **baseline**; later columns are added via [migrations.js](lift-logger-api/db/migrations.js) `ALTER TABLE` migrations. Current `CURRENT_SCHEMA_VERSION = 4`:
- **v2** — Phase-2 columns on `sessions`: `paused_at`, `skipped_block_ids`, `work_timer_*`, `accumulated_paused_ms`, `pending_actuals`. Plus a `UNIQUE(session_id, block_position, ...)` index on `session_sets`.
- **v3** — `block_exercise_sets.round_number` (NOT NULL DEFAULT 1) + new UNIQUE shape requires a table rebuild.
- **v4** — `session_sets.skipped` (Bool01, default 0) so Skip Set writes a row distinct from a real log; `sessions.done_block_ids` (JSON array) so Finish-Block disposition is durable, parallel to `skipped_block_ids`.

`database.js` `normalizeRow` defaults `session_sets.skipped` to 0 and `block_exercise_sets.round_number` to 1 when missing — older clients can push rows without those fields and the server fills them. Add the same shim when introducing future NOT NULL columns to avoid breaking pre-deploy clients.

Everything in [database.js](lift-logger-api/db/database.js) routes through `TABLE_COLUMNS` and a generic `upsertRow(table, row)`. LWW rule: `ON CONFLICT(id) DO UPDATE … WHERE @updated_at > {table}.updated_at`. `created_at` is insert-only (excluded from UPDATE SET). `runMigrations(db)` reads `schema_version` on boot and applies ordered migrations.

**PR computation is a side-effect of session_sets writes.** `recomputePRsForSessionSet(row, tx)` runs in the same transaction as the upsert, evaluates weight / reps / volume / Epley 1RM (rep cap ≤ 10), upserts `exercise_prs` on beaten records, and flips `session_sets.is_pr = 1`. **Only the sync handler triggers this.** MCP's `delete_session` is the one other writer — it recomputes PRs from scratch after a session delete (see Conventions section).

### Sync protocol (the contract both sides depend on)

`POST /api/sync` in [lift-logger-api/routes/sync.js](lift-logger-api/routes/sync.js):

```
Request:  { "tables": { "<table>": { "lastSync": N, "changes": [rows...] }, ... } }
Response: { "tables": { "<table>": { "syncTimestamp": N, "changes": [rows...] }, ... } }
```

- Writes apply in `WRITE_ORDER` (exercises → workouts → blocks → block_exercises → block_exercise_sets → sessions → session_sets → exercise_prs).
- `session_sets` writes go through `upsertSessionSetWithPRs`, which triggers PR computation.
- Response per table contains every row with `updated_at > lastSync` **including server-computed `exercise_prs` rows**.
- `exercise_prs` is effectively **read-only from the client** — the frontend never pushes PR rows.

Sync on the client is **pull-triggered by `useAutoSync()`, which mounts only on HomeScreen** (and on `window 'online'`). Mid-session, templates don't pull. SummaryScreen triggers a final push+pull. If you edit a workout template while a session is active, the edit won't appear on-device until the user navigates back to Home.

### Frontend: Dexie mirror + Zustand cursor state machine

Dexie schema in [lift-logger-frontend/src/db/schema.ts](lift-logger-frontend/src/db/schema.ts) mirrors the 8 backend tables + two local-only stores (`sync_meta`, `settings`). Reactive reads via `dexie-react-hooks` (`useLiveQuery`). `SyncService` in [lift-logger-frontend/src/sync/syncService.ts](lift-logger-frontend/src/sync/syncService.ts) push-then-pulls in one request; flip `VITE_USE_MOCK_SYNC=true` to dispatch through `mockServer.ts` for backend-less UI work.

The active session cursor lives in Zustand (`src/stores/sessionStore.ts`). The **frozen `WorkoutSnapshot`** on `sessions.workout_snapshot` (JSON) is the source of truth for what the session is executing — the template tables may change mid-session but the snapshot doesn't. Cursor is `(blockPosition, blockExercisePosition, roundNumber, setNumber)`, 1-indexed to match DB columns.

Pure cursor advancement logic is in [src/features/session/sessionEngine.ts](lift-logger-frontend/src/features/session/sessionEngine.ts) — no React, no Dexie, just generators. Unit tests in `sessionEngine.test.ts`. Exported helpers worth knowing: `iterateSets`, `advance`, `targetAt`, `cursorKey`, `cursorKeyFromRow`, `firstCursorOfBlock`, `isNewBlock`, `isLastSetOfBlock`, `nextCursorInBlock` / `prevCursorInBlock`.

### Route map

```
/                                        HomeScreen (auto-syncs via useAutoSync)
/workout/:workoutId                      OverviewScreen
/session/:sessionId                      → redirects to intro/1
/session/:sessionId/intro/:bp            BlockIntroScreen  (pre-block: setup cue + rest timer + "I'm Ready")
/session/:sessionId/active/:bp/:setKey   BlockView         (the executing block)
/session/:sessionId/summary              SummaryScreen
```

`BlockIntroScreen` was `TransitionScreen` pre-Phase-2; route path changed from `/transition/:bp` → `/intro/:bp`. Don't be surprised by historical references.

**BlockIntroScreen's CTA stack** is `I'm Ready / Resume → (primary) + Skip Block (secondary)`. The primary label flips to "Resume" when the block has any logs already (returning user). Skip Block confirms with copy that adapts to whether the block has logs ("Logged sets will stay; the block is marked skipped so you can return later"), then calls `skipBlock(blockId)` and routes to the next non-skipped block's intro — or to OverviewScreen / Summary if no blocks remain.

### Active-session flow — two render paths branched on `block.kind`

**Single blocks** (`kind === 'single'`) use the Phase-2 tap-to-log model:

1. Focused set card shows a **Record button** (right-justified, spans card height). Non-focused cards are inert placeholders.
2. Tap Record → starts the **active timer** + opens the **SetLogger** full-screen overlay. Timer is a countdown if the set has `rest_after_sec`, else count-up. On the last set of the block, the block timer uses `workout_blocks.rest_after_sec` if set, else count-up.
3. SetLogger has Weight + Reps number cards (iOS numeric keypad via `inputMode`, ± sign toggle on weight). Primary button is labeled **"Done"**. Cancel kills the timer + closes without logging; Done → `logSet({ advance: false })` + close.
4. Post-Record: the just-logged card shows actuals + a running timer below it + a **Next** button inside the card. Next = `advanceCursor()` + `stopActiveTimer()`.
5. Record on the **last set** of a block opens the **BlockCompleteOverlay** instead of a rest card.

**Superset / circuit blocks** (`kind === 'superset' | 'circuit'`) keep the legacy round-major layout: vertical stack of work cards with inline Next buttons between them, rest cards when `rest_after_sec > 0`, terminal "Finish Block" / "Finish Workout" card at the bottom. Here `logSet()` advances the cursor by default and the tap hotlink on the focused card opens `SetView` (not `SetLogger`).

For **timed work** in circuit/superset blocks (sets with `target_duration_sec`), the live mm:ss countdown renders inside the focused `WorkSetCard`'s reps slot via the `InlineCountdown` subcomponent — there is no separate top-docked timer on this screen. The HIIT loop is fully automatic on circuits:

```
work 0  → logSet({ advance: false })     → RestCard activates
rest 0  → RestCard fires onNext           → cursor advances + skipRest
        → work-timer lifecycle effect restarts timer for the new cursor
```

`RestCard` takes an `autoAdvance` prop. **Circuit blocks pass `true`** (HIIT loop, zero-cross fires `onNext`). **Superset blocks pass `false`** (user-paced; the timer keeps counting up past zero with a `+MM:SS` overflow display until the user taps Next manually). Both states have ±15s buttons that nudge the displayed duration via local `extra` state.

The `advance: false` on auto-log-at-zero is load-bearing for the auto-loop: advancing immediately would start the next set's work timer while the rest is still playing. **Exception**: the *last set of the last block* (`focusedIsLastOverall`) always passes `advance: true` because there's no rest card or finishBlock tap to wait on — without this, a circuit's last timed set hangs on a disabled "auto on timer zero" tile and the workout never ends.

Round-boundary rest fallback uses [`restForCursor` / `restAtBoundary`](lift-logger-frontend/src/features/session/BlockView.tsx) helpers: when the last set of an ending round has `rest_after_sec === 0` (or null), fall back to `workout_blocks.rest_after_sec`. The fallback uses `> 0` rather than `??` because `??` treats explicit 0 as "configured" and would skip the fallback (Plank-Hold bug, commit `21786a8`).

Multi-round blocks (`rounds > 1`) render a `──── R{n} / {total} ────` divider between rounds on both `BlockIntroScreen` (all rounds including R1) and the active `BlockView` stack (between rounds, skipping R1).

The secondary action row above the card stack is **Skip Block · Finish Block · End Workout** on both render paths (factored as `<SessionActions>` inside [BlockView.tsx](lift-logger-frontend/src/features/session/BlockView.tsx)). Skip Block adds the block to `skippedBlockIds` and advances. Finish Block adds it to `doneBlockIds` and opens the BlockCompleteOverlay. **End Workout no longer goes straight to /summary** — it routes the user to OverviewScreen so they can review final block status before the irreversible end. The actual `confirmEndWorkout(snapshot, logged, skippedBlockIds)` confirm + `endWorkout()` happens on Overview's End Workout button.

A "Skip Set" button used to live in this row but was removed once tap-focus → Start auto-skips intermediate untouched sets — tapping the very next set's Start button reproduces Skip Set's effect, plus there's no equivalent for "skip THIS set when there's no future set to tap" because in that situation Finish Block / End Workout cover the user's actual intent. The store still exposes `skipCurrentSet` + `undoSkip` and BlockView still mounts `<UndoToast>` — both intact for potential reuse from other surfaces, just with no producer in BlockView itself today.

### BlockCompleteOverlay — post-block interstitial

[BlockCompleteOverlay.tsx](lift-logger-frontend/src/features/session/BlockCompleteOverlay.tsx) opens on Record of the last set or from Finish Block. Four actions, order fixed:

- **Next block →** — `jumpTo(firstCursorOfBlock(snapshot, nextBlockPosition))`, closes overlay. Block timer keeps ticking. BlockView's cursor→URL effect then routes to `/intro/{N+1}`. Hidden on the last block. Top of the stack — most-common next action.
- **+ Add a set** — `appendSetToCurrentBlock()`: session-only snapshot mutation, inherits just-recorded actuals as targets, resets active timer, jumps cursor to the new set.
- **Workout overview** — navigates to `/workout/:id` (the **OverviewScreen**, which is now the live workout view; the in-session `WorkoutViewOverlay` is deleted). Calls `onClose()` first to dismiss the BCO. The BlockView ☰ Workout button does the same nav.
- **Finish workout** — same review-then-end semantics as BlockView's End Workout. Stops the active timer, navigates to OverviewScreen (NOT directly to /summary). Primary button on the last block; secondary otherwise. Shown on every BCO because users often treat the final block as optional. The `nextBlockPosition` calc skips past blocks already in `doneBlockIds` / `skippedBlockIds` so "Next block →" doesn't shove the user back into a finished one when they came in via Resume on a skipped block.

### Active timer — one slot, persisted

`sessions.work_timer_started_at` + `sessions.work_timer_duration_sec` are **repurposed as a single "active timer"** pair — at most one (rest / block / work) runs at a time. Timers survive browser reload via wall-clock math: `remaining = duration - (now - started_at)`. **Count-up** is signaled by `duration_sec = null` with non-null `started_at`. Store actions: `startActiveTimer(durationSec | null)`, `stopActiveTimer()`.

The **work-timer lifecycle effect** in `BlockView` writes `work_timer_*` directly via `db.sessions.put(...)` rather than calling the `startWorkTimer` store action. The action reads `sessionId` from the store, which isn't populated until `hydrate()` completes — the effect can fire first (from URL params) and the action would silently no-op. The effect has a trusted sessionId from the route, so direct write is safe. The effect tracks the previous cursor in a ref and restarts the timer whenever the cursor advances into a timed set OR the stored timer has already elapsed (e.g. post-reload).

### OverviewScreen as the live workout view (5-state block model)

[OverviewScreen.tsx](lift-logger-frontend/src/features/workouts/OverviewScreen.tsx) is the **single workout view** at every phase — pre-session it shows uniform tiles + Start CTA, mid-session it shows live status pills + Resume CTA, with all sets accounted for it shows End Workout CTA. The in-session `WorkoutViewOverlay` was deleted in chunk #2 (commit `f9b110c`).

Block tile status is a 2-axis matrix (disposition × content) with **5 reachable states**:

| State | Disposition | Content |
|---|---|---|
| `done_complete` | Finished (auto when all sets logged, or explicit Finish) | All sets logged with actuals |
| `done_partial` | Finished | Some sets unlogged or skipped |
| `skipped_empty` | Skipped (returnable) | No logs |
| `skipped_partial` | Skipped (returnable) | Some logs |
| `pending` | Untouched | No logs |

Plus the transient `current` for the cursor's block (only shown when no explicit disposition is set — once a block enters `doneBlockIds` or `skippedBlockIds`, that wins). `blockStatusOf` in OverviewScreen derives the value; precedence is `skipped > done > auto-Done (all logged) > current > pending`.

**Auto-Done on the last accounted-for set**: `logSet` calls `isBlockFullyAccounted(sessionId, snapshot, blockPosition)` — true when every set has a session_sets row (logged OR skipped). When true, the block flips to `doneBlockIds` automatically. The `done_complete` vs `done_partial` sub-status is then derived by counting non-skipped rows.

**Tile interaction is tap-to-reveal** (mirrors BlockView's #5a pattern). Tap a tile → tap-focus toggles to that block id, exclusive across tiles. A contextual button row appears beneath the exercise list (full-width, accent-colored). Re-tap the tile body to clear focus. The button label per status:
- `current` → **Cont.** → navigate /active at cursor
- `skipped_partial` → **Cont.** → `returnToBlock` + navigate /active at first unlogged (skips /intro because this is a continuation, not a re-entry)
- `skipped_empty` → **Start** → `returnToBlock` + navigate /intro (re-entry ceremony)
- `pending` → **Start** → confirm with progress count + `skipBlock(currentBlockId)` + `jumpTo(firstCursorOfBlock(target))` + /intro
- `done_complete` / `done_partial` → **Edit** → `jumpTo(firstCursorOfBlock(block))` + navigate /active. BlockView mounts; the user then taps individual cards (per BlockView's tap-focus, see below) to edit specific sets via SetView.

The cursor temporarily pointing into a Done block is fine — `blockStatusOf` precedence keeps the tile rendering as Done since it's still in `doneBlockIds`.

**Bottom CTA is 3-way + a fourth secondary**: 
- No active session → Start Workout (primary)
- Active + cursor non-null → **Resume Workout (primary) + End Workout (secondary, beneath)** — the End-Workout-review flow (chunk #12). The user came here via the explicit End Workout button in BlockView/BCO and gets a chance to review state before the actual end.
- Active + cursor null → End Workout (primary). Reached when the user finished all non-skipped blocks but had block-level skips remaining; BlockView's workout-complete effect routes here when `skippedBlockIds.size > 0`. Otherwise the effect routes to /summary.

End Workout fires `confirmEndWorkout(snapshot, logged, skippedBlockIds)` (block-only copy: `X unlogged · Y skipped blocks`).

**Active session selector** (both OverviewScreen + SessionHeader): pick the **most-recently-started** active session, not Dexie's default lex-by-id ordering. Defensive against multi-active-session states from crashes/multi-tab.

**OverviewScreen state is per-displayed-session, not global store**. The store's `cursor` / `skippedBlockIds` / `doneBlockIds` belong to whatever session `hydrate()` auto-picked (most-recent across **all** workouts). On a workout the user isn't currently executing, those values would belong to a different session entirely — using them on this overview would render the wrong tile statuses and build a Resume URL with the wrong session's coordinates. OverviewScreen instead derives `cursor`/`skipped`/`done` locally from `activeSession` + `logged` via the exported `cursorFromLogged` / `parseSkippedBlocks` / `parseDoneBlocks` helpers. **Before any handler that navigates into a session route OR mutates the store** (Resume, tile actions like `returnToBlock`/`skipBlock`/`jumpTo`), it calls `ensureStoreOnSession(activeSession.id)` which resyncs the store via `hydrate(activeSession.id)` — that variant of hydrate looks up a specific session id rather than auto-picking. Without this, BlockView/SetView would mount with the store still pointing at the old session and render mismatched cursor coordinates against the URL's snapshot. (SessionHeader's "→ Block" anchor stays globally-scoped — it's "zip back to your most-recent session," not context-aware.)

**Orphan cleanup on End-from-Overview**: `endWorkout(notes, options)` accepts an explicit `options.sessionId` plus `options.alsoEndOrphansForWorkoutId`. OverviewScreen passes both — without the explicit id, the action falls back to the store's hydrated `sessionId` and silently no-ops when the user is ending a session that was hydrated *during this run and already reset* (orphan from a prior crash now surfacing as the most-recently-started active). The orphan-cleanup pass marks every other un-ended session for the same workout `status: 'abandoned'` (not `'completed'` — the user didn't explicitly end them, they're just being cleared). Without this pass, ending the visible session leaves the next-most-recent orphan to surface as "unfinished" on the next open of that workout — whack-a-mole.

### Shared `<SessionHeader>` (top nav)

[SessionHeader.tsx](lift-logger-frontend/src/shared/components/SessionHeader.tsx) is the consistent top-nav row across BlockView, BlockIntroScreen, SetView, and OverviewScreen. Layout: `[← BackLabel] [center eyebrow] [right slot]`. Right slot priority:

1. **Resume Block anchor** (`→ Block`) — when an active session exists AND the current route is *not* a session route. Lets the user "zip back" to the active block from anywhere they've drifted (Home, browsing another workout's overview).
2. Caller-provided `rightSlot` — e.g., BlockView passes `Sets →` (forward affordance to SetView).
3. Hidden.

The Resume anchor reads cursor from sessionStore + active session row from Dexie; tapping navigates to `/session/:id/active/:bp/:setKey`. `suppressResumeAnchor` overrides only when redundant (none currently — even on the active workout's own overview, the anchor coexists with the bottom Resume CTA).

### BlockView tap-to-reveal Edit / Start on set cards (#5a)

Same tap-focus model as the OverviewScreen tile pattern, but at the set level. `tapFocusKey` lives in BlockView (not the store) and holds a single cursor key — exclusive across cards. Tap a non-cursor-pre-log card → tap-focus toggles. The cursor-focused pre-log card stays driven by the existing Go!/Done timer and is NOT tap-eligible (its primary affordance is the right-side button).

Button label per card situation (when tap-focused):
- Cursor-focused, post-log (rest mode) → **Edit**
- Past, completed (logged with actuals) → **Edit**
- Past, skipped (`skipped:1`) → **Start**
- Future, pending (no row, ahead of cursor) → **Start**

**Edit** opens `SetViewOverlay` pinned to that cursor via the `initialViewingCursor` prop — SetView starts on the tapped set instead of the execution cursor. Update closes SetView and returns to BlockView.

**Start on a future set** does a forward jump-ahead. Auto-skips every untouched ("virgin") set strictly between the new cursor and the old cursor — including the abandoned cursor's own set if it's untouched. Logged or already-skipped sets stay as-is. Implemented as `autoSkipUntouchedBetween(from, to)` in sessionStore + `jumpTo(target)`. No confirm dialog.

**Start on a skipped set** is backward — just `jumpTo(target)`, no intermediate writes. The user went back to revisit; the abandoned cursor's set stays pending and will be reached again via natural advance.

**Cursor advance is loggedSetKeys-aware** in this branch. After `logSet`, `advance()` skips past sets whose key is in `loggedActualKeys` (computed from `db.session_sets` filtering `r.skipped !== 1`). Skipped sets are valid landing spots — the user can revisit them. This matters specifically when returning to a previously-skipped set and logging it: cursor lands on the next thing the user still owes, not the very next iteration step which might be a set they already finished.

### SetView (set editor): staged edits + up/down nav

[SetView.tsx](lift-logger-frontend/src/features/session/SetView.tsx) is the per-set editor. Reachable two ways: BlockView header `Sets →` button (opens at execution cursor) or BlockView tap-focus → Edit button (opens pinned to the tapped set via `initialViewingCursor` prop, which suppresses the auto-reset effect that would normally re-sync to the execution cursor).

**Steppers no longer auto-commit.** Edits land in local state (`weight`/`reps`/`duration`); a `seed` snapshot tracks the last-committed values. The Update button is enabled only when there's a real diff. Update commits + reseeds + closes SetView. Cancel resets local state back to seed.

**Commit branching is critical**: `if (isFocused && !isDone)` writes to `session.pending_actuals` (the stash logSet picks up on Next). Otherwise (`doneRow` exists), direct upsert to the `session_sets` row. The `&& !isDone` gate is what makes Edit-on-cursor-focused-logged-set work — without it, the focused-and-done case would write to pendingActuals instead of the row, the seed effect would re-run with the unchanged doneRow, and the input would visibly reset back to the prior value. (Bug fix in commit `b32045e`.)

[SetLogger.tsx](lift-logger-frontend/src/features/session/SetLogger.tsx) (the modal opened on Done/Record on the focused card) also has up/down navigation that calls `jumpTo(prev/next cursor in block)`. Pending edits on the current set are discarded on navigate — user should tap Done first if they want to save.

### `WorkSetCard` prominence flip

Once a set is logged (and `skipped !== 1`), the **big number on the card flips to actuals** and the target moves to a small `TARGET 18 LB × 12` line above for comparison. Pre-log behavior (target prominent) is unchanged. Skipped sets show `· SKIPPED` in the label and no actuals row. This was the underlying cause of "updated set info isn't displayed" — users were reading the prominent target text and missing the small actuals line.

**Color coding** for non-cursor cards: Done sets get a faint green tint background + slightly stronger green border. Skipped sets get an amber dashed border + faint amber tint + strikethrough on weight/reps numbers (matches the OverviewScreen `skipped_*` pill colors so the visual carries across screens). Mutually exclusive — `skipped` styling wins when both flags would apply. Pending / focused / peak unchanged.

### Pre-set "Go!/Done" prep timer

The focused-card button on a non-timed rep-based set reads **"Go!"** (green background) for 10 seconds after the cursor lands on it, then flips to **"Done"** (accent color). Both states are tappable and open the same SetLogger flow. Implementation: lazy `useState` init captures `focusedAt = Date.now()` on first render, useEffect resets on `goDoneActive` transitions, `useTick` at 1Hz drives the flip. In-memory only — reload restarts the 10s timer.

Timed sets opt out (no Go/Done flip) so the HIIT auto-loop's rhythm isn't competing with a second prompt.

### Wake lock (screen stay-on)

[useWakeLock.ts](lift-logger-frontend/src/shared/hooks/useWakeLock.ts) requests `navigator.wakeLock('screen')` while `sessionId !== null`. iOS Safari PWA silently drops the lock on visibility change AND occasionally without an event — the hook listens for the sentinel's `release` event AND polls every 30s as a belt-and-suspenders re-request. App.tsx mounts the hook gated on session existence.

### Portrait orientation

Manifest declares `orientation: 'portrait'` and App.tsx calls `screen.orientation.lock('portrait')` (best-effort; Android PWA honors, iOS Safari rejects). For iOS PWA — which honors neither — there's a CSS overlay `.rotateOverlay` on `<App>` that becomes a full-viewport "Please rotate to portrait" message under `@media (orientation: landscape) and (max-height: 600px)`. The 600px ceiling avoids triggering on desktop landscape.

### iOS safe-area on full-screen overlays

Body has `padding: env(safe-area-inset-*)` so normal-flow content respects the notch. `position: fixed; inset: 0` overlays bypass that — SetView, SetLogger, and BlockCompleteOverlay each use `padding: max(var(--space-N), env(safe-area-inset-*))` per side so the design's intended spacing is preserved on browsers without notches and extended past iOS chrome (status bar, home indicator) when present.

### Critical: URL ↔ cursor is one-directional

URL changes drive cursor updates via a **mount-only** effect in `BlockView.tsx`. Cursor changes drive URL changes via `navigate()` in a second effect that **does not list `cursor` in its deps** — listing it causes the effect to snap cursor back to a stale URL before navigate lands (see commit `3d83f54`). The cursor→URL effect is also suppressed while `overlay === 'blockComplete'` so BCO owns the next-block navigation.

### Two-layer save flow (structural edits)

First structural edit on BlockIntroScreen shows a one-time prompt (`SavePreferencePrompt`). Sticky `session_only` → mutate only `sessions.workout_snapshot`. Sticky `template` → mutate snapshot **and** the underlying `block_exercise_sets` / `workout_blocks` rows and bump `workouts.updated_at`. **`appendSetToCurrentBlock` bypasses this** — always session-only (mid-workout "add a set" is almost never a template intent).

### MCP: 15 tools, two transports, shared registration

Both transports use `registerTools(server)` from [lift-logger-mcp/register-tools.js](lift-logger-mcp/register-tools.js) so the tool list stays in sync between stdio and HTTP. Tools split across `tools/exercises.js`, `tools/workouts.js`, `tools/sessions.js`, `tools/analysis.js`. Shared DB helpers (`readWorkoutTree`, `upsertWorkoutTree`, `deleteWorkoutTree`) in [db.js](lift-logger-mcp/db.js) — all workout writes go through `upsertWorkoutTree` which validates `exercise_id` existence up-front and fills auto-assigned positions/set_numbers.

MCP writes default `workouts.created_by = 'agent'`. Tool Zod schemas mirror the `WorkoutSnapshot` shape used on the frontend.

## Configuration

Single-user, Tailscale-secured. No auth layer in the app itself.

- Pi hostname: `pinto`, Tailscale IP `100.75.94.59`
- Frontend API URL: `/api` (relative, same-origin — frontend is served by the backend)
- Cloudflare MCP portal: `https://lift-portal.938752.xyz/mcp`

## Deployment

```bash
git push origin main
ssh bcransto@pinto "cd ~/lift-logger-repo && git pull"
ssh bcransto@pinto "cd ~/lift-logger-repo/lift-logger-api && npm install"
ssh bcransto@pinto "cd ~/lift-logger-repo/lift-logger-mcp && npm install"
ssh bcransto@pinto "cd ~/lift-logger-repo/lift-logger-frontend && npm install && npm run build"
ssh bcransto@pinto "sudo systemctl restart lift-logger lift-logger-mcp-remote"
```

Build on the Pi (Node 22) rather than shipping `dist/` — Pi build is ~3s for this project. If `better-sqlite3` native bindings are missing after a Node upgrade, `npm rebuild better-sqlite3` in each package.

## Service management (on Pi)

```bash
sudo systemctl status lift-logger                # API + frontend static (port 3000)
sudo systemctl status lift-logger-mcp-remote     # HTTP MCP (port 3002)
sudo systemctl restart lift-logger
sudo systemctl restart lift-logger-mcp-remote
journalctl -u lift-logger -f
journalctl -u lift-logger-mcp-remote -f
```

The old SQLite database `data/liftlogger.db` is preserved on disk as a safety net. IRON uses `data/iron.db`, created fresh on first startup via `CREATE TABLE IF NOT EXISTS` + `runMigrations`.

## MCP Access

**Claude Desktop**: SSH stdio launched on demand, configured in `~/Library/Application Support/Claude/claude_desktop_config.json`. No service restart needed after code changes on the Pi.

**Claude.ai**: Cloudflare MCP Portal at `https://lift-portal.938752.xyz/mcp`. After changing the tool list, **disconnect + reconnect the lift connector in Claude.ai settings** to flush the cached schemas — that's the only client-side step. Cloudflare picks up the new schemas automatically on the next request; do **not** re-click Authenticate on the `lift` row in Cloudflare Zero Trust (that's only needed for initial server setup). See [CLOUDFLARE-MCP-PORTAL.md](CLOUDFLARE-MCP-PORTAL.md) for this app's Cloudflare setup; generic setup reference at `/Users/bcransto/AppDev/MCPs/CLOUDFLARE-MCP-SETUP.md`.

## Conventions

- **Timestamps everywhere are INTEGER epoch millis** (`Date.now()`).
- **Booleans are `0|1` at the DB boundary**, normalized to `boolean` in TS at the edge.
- **JSON-array fields** (`tags`, `equipment`, `muscle_groups`, `alt_exercise_ids`) are stored as TEXT containing JSON. Use `parseJsonArray()` on the way out.
- **`workout_blocks.rest_after_sec` has overloaded semantics.** For `kind === 'superset' | 'circuit'` with `rounds > 1` it's the between-rounds rest. For `kind === 'single'` it's the between-block rest — drives the block-timer countdown when the user taps the last set.
- **Schema changes require coordinated edits**: backend `db/schema.js` + `db/database.js` `TABLE_COLUMNS` **and** frontend `src/types/schema.ts` in the same commit. The two files are a hand-maintained contract; the sync endpoint won't catch drift, only runtime errors will.
- **MCP only writes `exercise_prs` from `delete_session`** (recompute-from-scratch after a session delete, since stale PR rows would lie about the user's actual best). Otherwise MCP is read-only on PRs — if a tool needs PR data, read from `exercise_prs`; don't derive.
- **CSS Modules only** on the frontend. Design tokens are in `src/styles/tokens.css`; don't hardcode colors/spacing.
- **Inputs use `font-size: 16px`** to prevent iOS Safari auto-zoom. `inputmode="decimal"` / `"numeric"` picks the compact iOS number pad.
- **`logSet` has an `advance: boolean` option.** Default is true. The single-block flow and the **auto-log-on-work-timer-zero path in circuit/superset blocks** pass `advance: false` so the log doesn't race the rest timer. In both cases the Next button (or RestCard's zero-cross callback) owns the advance + skipRest. **Exception**: when the focused cursor is `focusedIsLastOverall`, the auto-log path passes `advance: true` regardless of `rest_after_sec` — there's no rest card or finishBlock tap to wait on, the workout is logically over.
- **`Skip Set` writes a session_sets row with `skipped: 1`** (schema v4) — distinct from a real log. The OverviewScreen's "done count" excludes skipped rows (`loggedActualKeys` filters `r.skipped !== 1`), but `isBlockFullyAccounted` includes them so a block can auto-finish with all sets accounted for even if most are skips.
- **`isLogged` in BlockView excludes skipped rows** (`Boolean(row) && row?.skipped !== 1`) on both render paths. Without this, a focused-skipped set (cursor returned via tap-focus → Start) renders in rest mode with no Go!/Done button — because the row exists, `isPreTap` is false, `onRecord` isn't passed, and WorkSetCard's `showFocusedActions` filters out the focused-and-`isDone` case. WorkSetCard mirrors this with `showSkippedStyling = cardIsSkipped && !isFocused` so the dashed-amber treatment drops when the cursor is back on the set. The underlying `skipped:1` row stays put; logSet overwrites it on commit.
- **`done_block_ids` and `skipped_block_ids` are mutually exclusive per id.** `finishBlock(id)` clears any skip flag on that id; `skipBlock(id)` clears any done flag. The advance() exclude set is `union(skipped, done)` — `unionBlockIds()` helper in sessionStore.
- **Use `cursorKey()` / `cursorKeyFromRow()`** instead of hand-building `${bp}.${be}.${r}.${s}` strings — those diverged once already and the helpers prevent drift.
- **`BlockIntroScreen` superset/circuit grid wraps to 2 columns when `sortedExercises.length > 2`.** Don't switch the inline `gridTemplateColumns` back to `repeat(${sortedExercises.length}, 1fr)` — at iPhone width (375px) anything past 2 cards per row gets smooshed (this bit us with The Gauntlet's 4-exercise finisher; commit `9d89a6d`).
- **Local backend vs Pi.** The local backend (`lift-logger-api/data/iron.db`) and the Pi's production DB are entirely separate. An MCP write from Claude.ai's Cloudflare connector goes to prod by default. When copying rows between the two, bump `updated_at` to `Date.now()` — clients won't pull a row whose `updated_at` is older than their `lastSync`.
- **`tsc --noEmit` ≠ `tsc -b`.** Local typecheck (`npm run typecheck`) sometimes accepts type narrowings that the Pi's incremental project build rejects (seen with optional `block.rest_after_sec` in commit `5c514cc`). Before deploying, run `npx tsc -b --force` to mirror the Pi's strictness.
- **Forward affordance label**: the right-corner header button is `Sets →` on BlockView (descend to SetView). Don't replace the arrow with a kebab `⋮` — that reads as a dropdown menu, which it isn't.
- **`TAILSCALE_DEV=1` is read by `vite.config.ts` at server startup** — flipping the env var requires restarting the dev server (HMR can't hot-reload its own config). The flag adds `hmr.clientPort: 443 / protocol: 'wss'`; without it the iPhone's HMR websocket dials port 5173 (not exposed via Tailscale Serve) and the page never finishes wiring up.
- **Tailscale SSH may prompt for re-auth** before deploys. If `ssh bcransto@pinto` returns "Tailscale SSH requires an additional check" with a login URL, open it in a browser and wait for confirmation before retrying.
- **`git push` over HTTPS may hang silently** when the macOS keychain credential helper returns `-128` (cancelled / unable to prompt). Symptom: `git push origin main` runs forever with no output, no error. Cause: git tries to prompt for username/password via TTY, which the Bash tool doesn't have. Diagnosis: `GIT_TERMINAL_PROMPT=0 git push origin main` will fail fast with `could not read Username for 'https://github.com'`. Fix: push interactively from a terminal once to refresh keychain creds, then subsequent automated pushes work.
- **Hooks-order trap**: `useState` / `useEffect` / `useMemo` calls must precede ALL early-return branches in a component. React #310 ("Rendered more hooks than during the previous render") fires when a hook is conditionally skipped on first render and called on later renders. Bit us twice in `OverviewScreen.tsx` (commits `bb70a13`, plus the prior fix). Now caught by `react-hooks/rules-of-hooks` in [lift-logger-frontend/eslint.config.js](lift-logger-frontend/eslint.config.js); blocks `npm run build`. Requires Node ≥18 — `.nvmrc` pins 22.17.1, run `nvm use` in `lift-logger-frontend/` first.
- **`tap-to-reveal` action buttons** (BlockView set cards + OverviewScreen tiles) follow the same pattern: tap → tap-focus toggles to that card/tile → contextual button appears. Re-tap same target → focus clears. Tap different target → focus moves. Mutually exclusive across the surface. The body remains a `<button onClick={onTap}>` even when tap-focused — that's what enables toggle-off (commit `4cc76dc` was the fix when WorkSetCard's tap-focused branch had the body as a non-tappable `<div>`).
