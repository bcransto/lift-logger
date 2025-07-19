# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Application Overview

Lift Logger is a single-page web application for workout tracking built with vanilla HTML/CSS/JavaScript. It's designed as a mobile-first, offline-capable fitness tracker with optional GitHub Gist synchronization.

## Development Commands

Since this is a vanilla web application with no build process:

- **Run locally**: Open `index.html` directly in a web browser
- **Test**: Manual testing in browser (no automated test suite)
- **Deploy**: Copy `index.html` to any web server
- **Lint**: No linting tools configured (manual code review only)

## Architecture

### Single-File Application
The entire application is contained in `index.html` (~1700 lines) with embedded CSS and JavaScript. This design choice prioritizes simplicity and zero-dependency deployment.

### Data Architecture
- **Local-first storage**: Primary data lives in browser localStorage
- **Cloud sync**: Optional bidirectional sync with GitHub Gists API
- **Three data types**: Exercises (definitions), Workouts (templates), Records (actual workout data)

### Key Classes

**DataStore** (lines 632-933): Core data persistence and management
- Handles localStorage operations and GitHub Gist synchronization
- Manages exercises, workouts, and workout records
- Provides data access methods and analytics (PR calculations)

**WeightTrackerApp** (lines 936-1699): Main application controller
- View navigation and UI state management
- Workout flow orchestration (start → record sets → finish)
- Modal management for configuration and data entry

### Data Flow
1. App initializes → Load from localStorage → Optional Gist sync
2. User selects workout template → Records exercises with sets/reps/weights
3. Data saves locally → Syncs to Gist (if configured)

### Sync Status System
The sync status display uses timeout management to prevent stuck states:
- `showSyncStatus()` with timeout tracking
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

## Common Modifications

When adding features:
- New exercises: Add to `exercises.json` data structure
- New workout templates: Add to `workouts.json` with exercise references
- UI changes: Modify embedded CSS in `<style>` section
- New views: Add HTML in view container, update `showView()` method