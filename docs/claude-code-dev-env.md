# Claude Code dev environment setup

Operational supplement to CLAUDE.md's "Development Commands" section. Covers the bits Claude Code sessions hit that aren't obvious from reading the npm scripts: launch.json wiring, worktree previews, iPhone over Tailscale, headless git pushes.

## `.claude/launch.json` — preview_start config

The `preview_*` MCP tools read `.claude/launch.json` to start dev servers. Two configs:

- **iron-dev** — Vite frontend on `:5173`. Runs from a specific frontend path (main or a worktree).
- **iron-api** — Express backend on `:3100`. Runs from the **main checkout's** `lift-logger-api` so the SQLite DB at `data/iron.db` stays stable across worktrees.

When switching which checkout the preview should serve, edit the **iron-dev** `runtimeArgs` `cd '<path>'`:

- main: `/Users/bcransto/AppDev/Web Apps/lift-logger/lift-logger-frontend`
- worktree: `/Users/bcransto/AppDev/Web Apps/lift-logger/.claude/worktrees/<name>/lift-logger-frontend`

`iron-api` should keep its main-checkout path so all worktrees see the same seeded DB.

`TAILSCALE_DEV=1` must be in `runtimeArgs` env when iPhone testing is in scope — `vite.config.ts` reads it at server-startup to switch HMR to `clientPort: 443 / wss`. Without it, the iPhone loads the page but live-reload loops trying to dial 5173 directly (which Tailscale Serve doesn't expose).

## New worktree first-run

`preview_start` will fail in a fresh worktree until deps are installed:

```bash
cd lift-logger-frontend && npm install
```

Worktrees share `.git/` with main but each carry their own `node_modules/`. The API checkout (`lift-logger-api`) typically doesn't need a re-install per worktree because the `iron-api` preview points at main.

## Orphan vite gotcha (port 5173)

A stale `npm run dev` from a prior session can hold port 5173 and block `preview_start` ("Port 5173 is in use by another process (not a preview server)"). Diagnose:

```bash
lsof -i :5173 -sTCP:LISTEN -n -P
ps -fp <PID>
```

If it's an old vite from a checkout you've moved past, `kill <PID>` and retry `preview_start`. The preview tool only manages the processes it started, so background processes from terminal sessions are invisible to it.

## iPhone over Tailscale (off-network capable)

Tailscale Serve is the bridge — once configured it's persistent across Mac sleeps until you tear it down.

```bash
tailscale serve --bg http://localhost:5173    # one-time per Mac session
tailscale serve status                         # verify proxy mapping
tailscale serve --https=443 off                # teardown
```

URL: `https://bradfords-macbook-air.tail2a85a6.ts.net`

**Off-network works** because Tailscale is a mesh VPN, not LAN-bound. As long as both Mac and iPhone are signed into the same tailnet (`tail2a85a6.ts.net`), the iPhone connects through Tailscale's encrypted relay regardless of underlying network — cell data, hotel WiFi, coffee shop, etc.

Pre-flight checklist:

- iPhone has Tailscale app installed, signed into the tailnet
- Tailscale toggled on in iPhone's Settings/Tailscale app
- Mac awake with `iron-dev` preview running
- `tailscale serve status` shows the proxy
- `TAILSCALE_DEV=1` in `iron-dev` runtimeArgs (else HMR breaks)

For long testing sessions, consider `caffeinate -d &` (or System Settings → Battery → "Prevent automatic sleeping") so the Mac doesn't drop the dev server mid-session.

## Git push from a headless session

Use SSH, not HTTPS. HTTPS hits the macOS keychain credential helper which prompts for the laptop password — there's no way to answer that prompt from a Claude Code session or an iPhone-driven session.

Switch a repo from HTTPS to SSH:

```bash
git remote -v                                                      # check current
git remote set-url origin git@github.com:bcransto/lift-logger.git  # switch
ssh -T git@github.com                                              # expect "Hi bcransto!"
```

Adding the SSH key to GitHub via gh CLI requires the `admin:public_key` scope (default `gh auth login` doesn't grant it):

```bash
gh auth refresh -h github.com -s admin:public_key  # device flow — use phone browser
gh ssh-key add ~/.ssh/id_ed25519.pub --title "<host-name>"
```

This is account-level — once done, switch to SSH on any other repo with `git remote set-url`.

## Sample data (iron.db)

The seeded SQLite at `lift-logger-api/data/iron.db` (main checkout) holds 6 workouts, 17 exercises, ~50 sessions, ~170 session_sets as of 2026-05-10. Worktrees don't shadow this — the `iron-api` preview targets main, so any worktree's frontend reads/writes the same data via the proxy.

To re-seed from scratch see CLAUDE.md's "Backend" section (`seed-demo.js`, `seed-hiit.js`, `seed-circuit-4.js`, `seed-circuit-6.js`).

The DB carries baggage from past dev sessions — multiple `status='active'` sessions accrued via interrupted runs. That's a useful happy-coincidence for testing fixes around active-session handling, but worth `DELETE FROM sessions WHERE ...` if you want a known-clean state.
