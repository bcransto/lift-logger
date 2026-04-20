# IRON Phase 2 — Plan (revised post-gym test)

## Context

Phase 1 shipped. Post-gym test-drive surfaced a different default presentation: a **block-centric vertical stack** that matches how a workout actually feels in hand, with rest treated as a first-class card between work sets and focus auto-advancing through the block. The old three-swipeable-views plan is scrapped; navigation is now hierarchical (workout ↔ block ↔ set) rather than lateral.

Two independent reviews of the prior plan (see chat history) converged on seven correctness issues; those are folded in here rather than left for "fix during."

Supersedes the prior [iron-phase2-plan.md](iron-phase2-plan.md) (this file) content. Builds on [iron-backend-plan.md](iron-backend-plan.md) and [iron-frontend-plan.md](iron-frontend-plan.md).

## Decisions locked

### Architecture

- **Block view is the default Active-Lift presentation.** Opens when the user hits "I'm Ready" from Transition. Replaces the Phase 1 single-view Active Lift and the prior plan's three-swipeable-views concept.
- **Three-card spatial layout, no carousel**:
  ```
  [Workout view]  ←  [Block view (default)]  →  [Set view]
  ```
  - Swipe left-to-right (page moves right) → Workout view (to the left of default)
  - Swipe right-to-left (page moves left) → Set view (to the right of default)
  - Swipe is bounded at both edges — no wrap from Set → Workout or vice versa.
  - Set view always targets the currently focused set (cursor). Done and pending cards in Block view are read-only; no per-card swipe gesture.
- **Rest is a first-class card, not stored.** UI derives rest cards from each set's `rest_after_sec`; no schema change for rest.

### Card types

| Type | Trigger | Advance mechanism | Logs a session_set? |
|---|---|---|---|
| **Work — rep-based** (e.g. pushups ×10) | Focus arrives | User taps **Next** | Yes (actuals = targets unless edited via Set view) |
| **Work — timed** (e.g. pushups 10s) | Focus arrives | Timer auto-hits zero | Yes (`actual_duration_sec = target`, unless edited) |
| **Rest** (e.g. 15s) | Previous card advanced | Timer auto-hits zero | No |

Discrimination is derived: a set with non-null `target_reps` + null `target_duration_sec` is rep-based; vice versa is timed. A set cannot be both (CHECK constraint enforces this). Rest is UI-synthesized from the preceding set's `rest_after_sec > 0`.

### Focus + timer semantics

- Exactly one card holds focus at a time. Focus is derived from the `sessionStore.cursor`.
- An active timer **docks to the top** of the block view whenever running (setup, rest, work-timed). When idle, no timer UI — top is clean.
- Auto-advance rules:
  - Timed work: timer zero → `logSet` with `actual_duration_sec = target_duration_sec` → cursor advances → rest card (if any) → next work card
  - Rest: timer zero → cursor advances → next work card gets focus
  - Rep work: user taps **Next** → `logSet` with stored actuals → cursor advances → rest card → next work card

### Block-level controls

Persistent on the Block view: **Pause**, **Skip Set**, **End**. Also accessible via Workout view: **Skip Block**, **End**, per-skipped-block **Return**. Pause is additionally reachable from Set view via the timer dock.

- **Pause**: freezes any active timer + focus. Session stays `active`. Persists across reload. Lives on Block view + Set view (via the timer dock). **Not on Transition** — Transition's setup timer is ephemeral; user taps "I'm Ready" to bail out.
- **Skip Set**: silent — advance cursor past the current card without logging, no confirmation. A toast appears for ~5s with an **Undo** action that reinstates the cursor. Covers both rep-work and timed-work cards.
- **Skip Block** (Workout view only): cursor jumps to next non-skipped block's first set. Block id added to `sessions.skipped_block_ids`.
- **End**: `completeSession()` → Summary. Confirm if any un-skipped, unlogged work sets remain in non-skipped blocks.

### Set view

- Opens by swiping the page right-to-left from Block view. Always targets the currently focused set (cursor).
- Contents: weight stepper, reps stepper, duration stepper (whichever are non-null on the target), notes, peak toggle, **Pause** control (via the timer dock).
- Edits stash as pending actuals for the focused set; applied to `session_sets` on Next / timer-zero via `logSet`. Stash lives on the session store and is persisted on the session row so edits survive reload (see "Pending actuals" below).
- Active timer pinned at top (rest timer during rest, work timer during a timed work set).
- Swipe left-to-right (or back button) → Block view, cursor unchanged.

### Pending actuals (Set view → logSet handoff)

When the user edits the focused set in Set view before advancing, the edits need to survive until `logSet` fires (Next tap or timer zero). Store on the session row:

```sql
ALTER TABLE sessions ADD COLUMN pending_actuals TEXT;  -- JSON: {actual_weight, actual_reps, actual_duration_sec, rpe, notes} or null
```

Cleared by `logSet` after writing the session_sets row, and by cursor advance.

Total v2 sessions columns now: `paused_at`, `skipped_block_ids`, `work_timer_started_at`, `work_timer_duration_sec`, `accumulated_paused_ms`, `pending_actuals` (6).

## Schema changes (unchanged from prior plan)

Add two nullable columns to `sessions`:

```sql
ALTER TABLE sessions ADD COLUMN paused_at INTEGER;
ALTER TABLE sessions ADD COLUMN skipped_block_ids TEXT;  -- JSON array of block IDs
```

Bumps `schema_version` to **2**. Migration in `runMigrations(db)` runs both `ALTER`s idempotently guarded by `PRAGMA table_info`. Mirror in:
- `lift-logger-frontend/src/types/schema.ts` — `SessionRow` gains the two fields
- `lift-logger-api/db/database.js` — `TABLE_COLUMNS.sessions` adds both columns
- MCP `sessions.js` — exposes `pausedAt`, `skippedBlockIds` in `getSession` / `getSessionHistory`

### Dexie version bump (reviewer catch — blocker)

Bump Dexie schema from `version(1)` to `version(2)` in `lift-logger-frontend/src/db/schema.ts`:

```ts
this.version(2).stores({
  // ...unchanged indexes on other tables...
  session_sets: 'id, session_id, exercise_id, logged_at, updated_at, ' +
                '[session_id+block_position+block_exercise_position+round_number+set_number]',
  // ...
})
```

The compound index on `session_sets` is what makes the **upsert-by-tuple** lookup in the revised `logSet` cheap. Without the bump + index, every edit is a full table scan and the contract doc in the plan lies.

### `UNIQUE` constraint on session_sets tuple (reviewer catch — FBS)

Server-side belt-and-suspenders:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_sets_tuple
  ON session_sets(session_id, block_position, block_exercise_position, round_number, set_number);
```

Added in the v2 migration. Prevents silent duplication if the client logic ever drifts.

## State model (sessionStore)

Extensions to `SessionState`:

```ts
type SessionState = {
  // existing...
  pausedAt: number | null
  skippedBlockIds: Set<string>          // Set in memory, stringified JSON at DB boundary
  accumulatedPausedMs: number           // sum of prior pause durations; excluded from duration_sec
  restTimerAnchor: {                    // derived rest-timer state; see "Timer persistence" below
    logged_at: number                   // source session_set's logged_at
    durationSec: number                 // rest_after_sec for that set
  } | null

  // new actions
  pause(): Promise<void>
  resume(): Promise<void>
  skipCurrentSet(): Promise<void>
  skipBlock(blockId: string): Promise<void>
  returnToBlock(blockId: string): Promise<void>
  endWorkout(notes?: string | null): Promise<void>   // delegates to completeSession, subtracting paused time
}
```

### Timer persistence (reviewer blocker #2 — fixed)

**Rest timer is never directly persisted on the session row.** Instead it's *derived* from `last session_set's logged_at + rest_after_sec`:

```ts
restTimerRemainingSec(now: number): number | null {
  const last = getLastLoggedSet()                 // from session_sets, by logged_at desc
  if (!last || !last.rest_after_sec) return null  // no rest card to time
  const endsAt = last.logged_at + last.rest_after_sec * 1000
  return Math.max(0, (endsAt - (paused_at ?? now)) / 1000)
}
```

This sidesteps the "need to persist timer.startedAt" problem entirely. Pause still works because `pausedAt` substitutes for `now` in the calculation — any wall-clock time spent paused doesn't accrue against remaining.

**Timed work sets** (HIIT) still need a `startedAt` because there's no prior `session_sets.logged_at` to anchor to. Persist as two optional columns on `sessions`:

```sql
ALTER TABLE sessions ADD COLUMN work_timer_started_at INTEGER;
ALTER TABLE sessions ADD COLUMN work_timer_duration_sec INTEGER;
```

Set on focus-arrival of a timed work card, cleared on advance. Four columns instead of two on `sessions` — still all nullable, still one migration.

### Pause math (reviewer FBS #3 — fixed)

- `pause()`: sets `paused_at = now`. Persisted to `sessions.paused_at`.
- `resume()`: computes `delta = now - paused_at`; increments in-memory `accumulatedPausedMs += delta`; persists to `sessions.accumulated_paused_ms` (new column below). Clears `paused_at`.
- `completeSession()`: `duration_sec = (ended_at - started_at) / 1000 - accumulatedPausedMs / 1000`.

Needs one more column:

```sql
ALTER TABLE sessions ADD COLUMN accumulated_paused_ms INTEGER NOT NULL DEFAULT 0;
```

Total v2 migration: **6 new columns** on `sessions` (`paused_at`, `skipped_block_ids`, `work_timer_started_at`, `work_timer_duration_sec`, `accumulated_paused_ms`, `pending_actuals`) + 1 unique index on `session_sets`.

## Session engine changes

`sessionEngine.ts`:

```ts
// New signature — skip-aware
advance(snapshot, cursor, skippedBlockIds: Set<string>): Cursor | null

// New exported helper (renamed to avoid collision with existing local)
firstUnloggedCursorInBlock(
  snapshot,
  blockPosition: number,
  loggedKeys: Set<string>,
): Cursor | null
```

Algorithm for `advance`:
1. Filter `iterateSets` through `.filter(e => !skippedBlockIds.has(e.block.id))` — a skip-aware generator.
2. Find the entry matching `cursor` (or the first entry beyond cursor if cursor itself is in a skipped block — user returned then something auto-advanced).
3. Return the next entry's cursor, or null if none.

### `cursorFromLogged` skip-awareness (reviewer FD #8)

When hydrating from an existing session on reload, pass `skippedBlockIds` through:

```ts
cursorFromLogged(snapshot, logged, skippedBlockIds): Cursor | null {
  // Walk skip-aware iterator; return first entry whose key is not in loggedKeys.
}
```

### `isNewBlock` / `firstSetOfBlock` fix (reviewer FBS #10)

Current `firstSetOfBlock` at `sessionEngine.ts:94` hardcodes `position === 1`. With skip-advance, cursors land on block boundaries more often and will hit this bug. Replace with:

```ts
firstSetOfBlock(snapshot, blockPosition): { be: number; round: number; set: number } {
  const b = snapshot.blocks.find((x) => x.position === blockPosition)
  if (!b) throw new Error(...)
  const firstBe = Math.min(...b.exercises.map((e) => e.position))
  const be = b.exercises.find((e) => e.position === firstBe)!
  return { be: firstBe, round: 1, set: Math.min(...be.sets.map((s) => s.set_number)) }
}
```

### `logSet` upsert-by-tuple (reviewer blocker #1 — fixed)

Current `sessionStore.logSet` at line 211 always does `uuid('ss')`. Replace with:

```ts
async logSet(input: LoggedSetInput, targetCursor?: Cursor) {
  const c = targetCursor ?? this.cursor
  if (!c) return
  const existing = await db.session_sets
    .where('[session_id+block_position+block_exercise_position+round_number+set_number]')
    .equals([this.sessionId, c.blockPosition, c.blockExercisePosition, c.roundNumber, c.setNumber])
    .first()
  const id = existing?.id ?? uuid('ss')
  const row: SessionSetRow = { id, ...input, session_id: this.sessionId, /* ...cursor fields... */ }
  await db.session_sets.put(row)
  // ...existing sync bump + advance...
}
```

Depends on the Dexie compound index from the version bump above.

## File plan (revised)

### Backend

- [lift-logger-api/db/schema.js](../lift-logger-api/db/schema.js) — add 5 columns to `sessions`, add unique index on `session_sets`
- [lift-logger-api/db/database.js](../lift-logger-api/db/database.js) — v2 migration (idempotent ALTERs); extend `TABLE_COLUMNS.sessions` with the 5 new columns

### Frontend

- [src/types/schema.ts](../lift-logger-frontend/src/types/schema.ts) — SessionRow gains 5 fields
- [src/db/schema.ts](../lift-logger-frontend/src/db/schema.ts) — Dexie `version(2)` with compound index on `session_sets`
- [src/stores/sessionStore.ts](../lift-logger-frontend/src/stores/sessionStore.ts) — pause/resume/skip/end actions; `logSet` upsert-by-tuple; `accumulatedPausedMs` tracking; `restTimerAnchor` derivation
- [src/features/session/sessionEngine.ts](../lift-logger-frontend/src/features/session/sessionEngine.ts) — skip-aware `advance`, fixed `firstSetOfBlock`, new `firstUnloggedCursorInBlock`
- [src/features/session/sessionEngine.test.ts](../lift-logger-frontend/src/features/session/sessionEngine.test.ts) — cases: skip mid-block, return-to-skipped, skip-all-remaining, cursor-inside-skipped, firstSetOfBlock with non-1 positions
- [src/features/timer/TimerService.ts](../lift-logger-frontend/src/features/timer/TimerService.ts) — derive rest-timer from `last_logged_at + rest_after_sec`; work-timer from `work_timer_started_at`; both freeze on `paused_at`

**Block view (replaces old ActiveLiftScreen body)**:
- `src/features/session/BlockView.tsx` — new primary screen. Vertical stack of cards. Active timer dock at top. Pause/Skip Set/End actions.
- `src/features/session/cards/WorkSetCard.tsx` — rep + timed modes. States: pending, focused, done. Swipe-left-or-right reveals Set view.
- `src/features/session/cards/RestCard.tsx` — shorter height. Active countdown when focused.
- `src/features/session/TimerDock.tsx` — docked timer UI with pause/±15 controls.

**Set view**:
- `src/features/session/SetView.tsx` — zoomed-in editor for a specific set. Weight/reps/duration steppers, notes, peak toggle. Active timer pinned at top. Back gesture → Block view.

**Workout view**:
- `src/features/session/WorkoutView.tsx` — list of all blocks with status (done / current / skipped / pending). Tap a block → cursor jumps; tap Return on a skipped row → cursor returns.

**Navigation**:
- Route stays `/session/:sessionId/active/:blockPosition/:setKey` (block view).
- Set view: modal state or a sibling route (e.g. `/session/:sessionId/set/:blockPosition/:setKey`). Modal is simpler.
- Workout view: modal state or sibling route. Same choice.
- Gestures via `react-swipeable` on the page container; `touch-action: pan-y` on inner scroll areas so vertical scroll inside cards isn't hijacked.

**Deleted / folded from prior plan**:
- `ViewIndicator` (dots) — no longer applicable
- `MultiSetView`, `WorkoutProgressView` as separate swipe slots — folded into Block view + Workout view respectively

### MCP

- [lift-logger-mcp/tools/sessions.js](../lift-logger-mcp/tools/sessions.js) — expose `pausedAt`, `skippedBlockIds`, `accumulatedPausedMs`, work-timer fields in `getSession` output. No write tools needed.

## Verification

1. **Rep block**: 3×10 curls. Focus lands on set 1. Tap Next (no edit) → session_sets row logged with `actual_reps = target_reps = 10`, `actual_weight = target_weight`. Rest card auto-counts; at zero, focus moves to set 2.
2. **Timed block** (HIIT): 10s pushups → 10s rest → 10s burpees → 10s rest, ×3 rounds. Timer auto-advances every card. Watch the timer dock at top. Verify 6 session_sets rows logged with `actual_duration_sec = 10`.
3. **Rep with edit**: on set 2 of 3, swipe to Set view, change weight 135 → 145, back to Block view. Next tap → logged actual_weight = 145.
4. **Edit a done set**: swipe a done card to Set view, change actual_reps. Save. Dexie row updated in place (same id); Pi sync reflects the same id, not a new one. Verify no duplicate rows.
5. **Pause mid-rest**: rest timer at 45s remaining, tap Pause → freezes. Close tab. Reopen 10 minutes later → still shows 45s remaining. Tap Resume → counts down from 45s.
6. **Pause duration not billed**: start workout, pause for 20 min, resume, complete. Summary `duration_sec` should reflect active time only (within a few seconds), not include the 20 min.
7. **Skip Set**: tap Skip Set on a work card → no log, focus advances to rest card (or next work if no rest).
8. **Skip Block from Workout view**: skip block 2 of 3 → cursor jumps to first card of block 3. `sessions.skipped_block_ids` contains block 2's id (verify via sync or MCP).
9. **Return to skipped**: from Workout view, tap Return on block 2 → cursor lands on **first unlogged** set of block 2, not first set (reviewer catch #5). Block 2 removed from `skipped_block_ids`.
10. **End workout with unlogged sets** in non-skipped blocks: confirmation shows; accept → Summary. Unlogged-but-in-skipped-block sets do NOT trigger the confirmation (reviewer catch #6).
11. **Unique constraint**: attempt to insert two session_sets with the same tuple via the sync endpoint → second write rejected (or ignored by LWW, depending on timestamp). Confirm via direct DB read.
12. **Migration idempotency**: start API against existing v1 `iron.db` → all 5 ALTERs + unique index succeed, `schema_version = 2`. Restart twice → no errors, no duplicate columns.
13. **Dexie version bump**: open app in a browser with v1 Dexie data → Dexie migrates to v2 cleanly, compound index created, existing rows retained.
14. **MCP round-trip**: `get_session(sessionId)` returns `pausedAt`, `skippedBlockIds`, `accumulatedPausedMs`. Edit a set via View 2, sync, MCP reflects updated `actual_*`.
15. **Session engine tests**: all existing + new skip-aware cases green.

## Resolved UX decisions (locked)

1. **Swipe geometry**: three-card spatial layout, no carousel. `[Workout] ← [Block] → [Set]`. Swipe bounded at both edges.
2. **Skip Set**: silent, no confirmation. Undo toast appears for ~5s with an "Undo" action that reinstates the cursor.
3. **Set view scope**: always targets the focused (cursor) set. Done + pending cards in Block view are read-only — no per-card swipe gesture.
4. **Rest card editing**: read-only as a card. Adjust rest duration mid-workout via the timer dock's ±15s buttons while the rest timer is running. Template-level rest edits still flow through SavePreferencePrompt on Transition.
5. **Pause placement**: Block view + Set view (in the timer dock). Not on Transition (setup timer is ephemeral; "I'm Ready" covers it).

## Build order

1. Schema v2 migration (5 columns + unique index), Dexie v2 bump with compound index, type + TABLE_COLUMNS mirrors. Verify via `npm run smoke` + direct sync POST.
2. `logSet` upsert-by-tuple + associated unit test. Backward-compat check: existing logged sets still work.
3. Session engine: skip-aware advance, fixed `firstSetOfBlock`, tests. No UI yet.
4. Timer derivation: rewrite `TimerService` to compute rest timer from `last_logged.logged_at + rest_after_sec`; work timer from new columns. Pause math updated.
5. Block view skeleton: render current block's cards (work + rest) in a vertical list. Focus indicator on current. No gestures yet.
6. Card components (WorkSetCard, RestCard, TimerDock) wired to cursor + timer state.
7. Auto-advance logic: timed work / rest → advance on timer zero; rep → advance on Next. Verify with HIIT + rep blocks end-to-end.
8. Set view as a modal overlay with steppers + notes. Swipe-on-card triggers it (gesture TBD pending user clarification on Q1).
9. Workout view as a modal overlay with block list + Skip / Return / End actions. Confirmation dialogs.
10. Pause: button, math, persistence, hydration.
11. MCP exposure of new fields.
12. Full verification pass.
