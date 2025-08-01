# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Application Overview

Lift Logger is a single-page web application for workout tracking built with vanilla HTML/CSS/JavaScript. It's designed as a mobile-first, offline-capable fitness tracker with optional GitHub Gist synchronization.

## Development Commands

Since this is a vanilla web application with no build process:

- **Run locally**: Open `index.html` directly in a web browser
- **Test**: Manual testing in browser (no automated test suite)
- **Deploy**: Copy `index.html` to any web server
- **Lint**: `npm run lint` (ESLint with HTML plugin for embedded JavaScript)
- **Lint fix**: `npm run lint:fix` (automatically fix linting issues where possible)

## Architecture

### Single-File Application
The entire application is contained in `index.html` (~2,637 lines) with embedded CSS and JavaScript. This design choice prioritizes simplicity and zero-dependency deployment.

### Data Architecture
- **Local-first storage**: Primary data lives in browser localStorage with immediate saves
- **No pending state**: All changes save directly to localStorage without intermediate storage
- **Cloud sync**: Optional explicit sync with GitHub Gists API (no auto-sync)
- **Three data types**: Exercises (definitions), Workouts (templates), Records (actual workout data with timestamps)

### Key Classes

**DataStore** (lines 734-1079): Core data persistence and management
- Handles localStorage operations and GitHub Gist synchronization
- Manages exercises, workouts, and workout records
- Provides data access methods and analytics (PR calculations)
- Implements explicit sync points (no auto-sync)

**WeightTrackerApp** (lines 1082-2629): Main application controller
- View navigation and UI state management
- Workout flow orchestration (start → record sets → finish)
- Modal management for configuration and data entry
- Inline editing system for real-time set updates
- Current workouts tracking and resumption

### Data Flow
1. App initializes → Load from localStorage → Optional Gist sync
2. User selects workout template → Records exercises with sets/reps/weights
3. Data saves immediately to localStorage → Explicit sync to Gist on completion
4. Workout state persists for resumption → Time tracking with timestamps

### Key Features

**Inline Editing System**
- Real-time set editing with `updateSetData()` providing immediate saves
- Visual feedback via `updateSetRowStyling()` (has-data vs empty styling)
- Uses `oninput` events for immediate responsiveness
- No modal dialogs for set editing

**Workout Resumption**
- Active workout persistence in localStorage
- Resume capability with time elapsed display
- Automatic state saving during exercise progress
- Current workouts section on home screen

**Sync Status System**
- Explicit sync points only (finish workout, edit templates, manual sync)
- Timeout management to prevent stuck states
- `isSyncing` flag prevents concurrent operations
- 30-second failsafe timeout for hung operations

## Configuration

GitHub integration requires:
- Personal Access Token (stored in localStorage as `githubToken`)
- Gist ID (stored in localStorage as `gistId`)
- Three files in the Gist: `exercises.json`, `workouts.json`, `records.json`

## Code Patterns

- ES6 classes with async/await for API calls
- Template literals for HTML generation
- Event delegation for dynamic UI elements
- Try-catch blocks around all JSON.parse operations
- localStorage for offline persistence with Gist backup
- Mobile-first design with iOS-specific optimizations

## Common Modifications

When adding features:
- New exercises: Add to `exercises.json` data structure
- New workout templates: Add to `workouts.json` with exercise references
- UI changes: Modify embedded CSS in `<style>` section
- New views: Add HTML in view container, update `showView()` method
- Sync behavior: Use explicit sync points, avoid auto-sync patterns