# Lift Logger Backend & Sync Setup

**Date:** February 1, 2025

## Summary

Added a Node.js backend running on Raspberry Pi with Tailscale for secure sync across devices. The PWA can now sync workout data from anywhere via Tailscale's private network.

## What Was Built

### Backend (`lift-logger-api/`)

A lightweight Express.js server with SQLite storage that also serves the frontend:

- **`GET /`** - Serves the PWA frontend (static files from `public/`)
- **`GET /health`** - Health check endpoint
- **`POST /api/sync`** - Bidirectional sync with Last-Write-Wins conflict resolution

Stack: Node.js + Express + better-sqlite3

### Database Schema

Three tables mirroring the frontend's IndexedDB structure:
- `exercises` - Exercise definitions (id, name, updated_at, is_deleted)
- `workouts` - Workout templates with exercise lists (stored as JSON)
- `records` - Individual set data (date, workout, exercise, set, weight, reps)

All tables indexed on `updated_at` for efficient sync queries.

### Sync Protocol

1. Client sends `lastSync` timestamp + local changes
2. Server upserts changes using Last-Write-Wins (only update if `updated_at > existing`)
3. Server returns all records modified since `lastSync` + new `syncTimestamp`
4. Client applies server changes and stores new sync timestamp

Server's timestamp is used to avoid clock skew issues between devices.

## Security Model

**Tailscale only** - No API keys or authentication tokens. Tailscale provides network-level security, so only devices on the private tailnet can reach the Pi. This simplifies the code and eliminates credential management.

## Deployment

### Pi Setup (pinto - Pi 5)
- Backend + frontend runs at `~/lift-logger/`
- Frontend served from `public/` subdirectory (single port for everything)
- Managed by systemd (`lift-logger.service`)
- SQLite database at `data/liftlogger.db`

### Network Access
| Type | Address |
|------|---------|
| Hostname | `http://pinto:3000` |
| Tailscale | `http://100.75.94.59:3000` |

### Service Commands
```bash
sudo systemctl status lift-logger
sudo systemctl restart lift-logger
journalctl -u lift-logger -f
```

## Frontend Changes

Removed API key requirement from `SyncService`:
- `setConfig(url)` now takes only URL (was `setConfig(url, apiKey)`)
- Removed `Authorization` header from fetch calls
- Config modal simplified to just server URL input

## Data Migration

Created `scripts/load-backup.js` to import existing workout data:
- Reads from `full backup 12-16-2025/` directory
- Generates missing `id` and `updatedAt` fields
- Posts to sync endpoint for upsert

Loaded 25 exercises, 6 workouts, and 294 records from Aug 2024 - Dec 2025.

## Files Created/Modified

| File | Change |
|------|--------|
| `lift-logger-api/` | New backend directory |
| `lift-logger-api/server.js` | Express app entry point |
| `lift-logger-api/db/schema.js` | SQLite table definitions |
| `lift-logger-api/db/database.js` | DB helpers with LWW sync |
| `lift-logger-api/routes/sync.js` | Sync endpoint handler |
| `lift-logger-api/scripts/load-backup.js` | Backup import script |
| `lift-logger-api/public/` | Frontend static files served by Express |
| `index.html` | Removed API key from SyncService |
| `CLAUDE.md` | Added backend commands and Pi info |
