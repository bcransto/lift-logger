# Cloudflare MCP Portal Setup Guide

How to protect MCP servers with email-based authentication using Cloudflare AI Controls, so users authenticate via their email and you manage access by adding/removing emails.

## How It Works

- Cloudflare AI Controls creates a **portal** that sits in front of your MCP server(s)
- Users authenticate via Cloudflare Access (email + one-time code)
- Works with Claude.ai connectors — a popup handles the OAuth flow
- No API keys to manage — add/remove users by email in the Access policy
- Free tier supports up to 50 users
- Use **separate portals** for different audiences (e.g., personal vs shared with colleagues)

### Architecture

```
User (Claude.ai) → Cloudflare Portal (lift-portal.938752.xyz/mcp)
                  → Cloudflare Access (email auth)
                  → Cloudflare Tunnel (pinto-apps-tunnel)
                  → Pi (localhost:3002)
                  → server-remote.js
```

### Current Setup

```
Tunnel: pinto-apps-tunnel
├── Route: lift.938752.xyz → localhost:3002
└── Route: curriculum.938752.xyz → localhost:4001

AI Controls - MCP Servers:
├── "Lift Logger" → https://lift.938752.xyz/mcp
└── "Curriculum"  → https://curriculum.938752.xyz/mcp

AI Controls - Portals:
├── lift-portal.938752.xyz → Lift Logger (just bcransto)
└── curriculum-portal.938752.xyz → Curriculum (bcransto + colleagues)
```

## Prerequisites

- Cloudflare account with a domain (`938752.xyz`)
- Cloudflare Tunnel exposing MCP server (e.g., `lift.938752.xyz` → `localhost:3002`)
- MCP server running (`server-remote.js` on port 3002)
- Cloudflare Zero Trust account (free tier is fine)

## Setup Steps

### 1. Create Tunnel (if not already done)

1. **Zero Trust → Networks → Tunnels → Create a tunnel**
2. Name it descriptively for the machine, not the app (e.g., `pinto-apps-tunnel`)
3. Copy the tunnel token and install `cloudflared` on your server
4. Add routes via **Published application routes** tab:
   - Subdomain: `lift`, Domain: `938752.xyz`, Service: `http://localhost:3002`
   - Subdomain: `curriculum`, Domain: `938752.xyz`, Service: `http://localhost:4001`
5. Verify DNS records were created in **dash.cloudflare.com → 938752.xyz → DNS**

### 2. Add MCP Server

1. Go to Cloudflare Zero Trust dashboard → **Access → AI Controls → MCP servers** tab
2. Click **Add an MCP server**
3. Enter:
   - **Name**: e.g., `Lift Logger`
   - **HTTP URL**: `https://lift.938752.xyz/mcp` (this is the tunnel URL, not the portal URL)
4. Add an Access policy:
   - **Action**: Allow
   - **Include**: Emails → your email address
5. Save — Cloudflare will validate the connection and fetch the server's tools
6. **Important**: After saving, go to **Zero Trust → Access → Applications**. Find the auto-created application for this MCP server and verify that the **subdomain** and **domain** are correctly set (e.g., subdomain = `lift`, domain = `938752.xyz`). If the domain fields are empty, add them — the server won't authenticate properly without this.

### 3. Sync the MCP Server

After adding the server and fixing the domain in Applications:

1. Go back to **AI Controls → MCP servers** tab
2. The server will likely show **"Sync required"** status
3. Click **Sync capabilities**
4. A popup will ask you to authenticate — enter your email and the one-time code
5. Click **Authorize client**
6. Status should change to **Ready**

This initial admin authentication is required once per MCP server. After this, other users can authenticate from their Claude.ai connector directly.

### 4. Create Portal

1. Go to the **MCP server portals** tab
2. Click **Add MCP server portal**
3. Enter:
   - **Name**: e.g., `Lift Portal`
   - **Domain**: select `938752.xyz`, **Subdomain**: e.g., `lift-portal`
4. Attach your MCP server(s) to the portal
5. Add an Access policy:
   - **Action**: Allow
   - **Include**: Emails → your email (and any colleagues' emails)
6. Save
7. Check **DNS records** (dash.cloudflare.com → your domain → DNS) to confirm the portal subdomain was created

### 5. Connect from Claude.ai

1. Go to Claude.ai → **Settings → Connectors → Add custom connector**
2. Enter:
   - **Name**: e.g., `Lift Logger`
   - **URL**: `https://lift-portal.938752.xyz/mcp` (the portal URL, not the direct tunnel URL)
   - **OAuth fields**: leave blank
3. Click **Connect** — a Cloudflare popup will appear
4. Enter your email, receive a one-time code, enter it
5. Start a new chat and test with a prompt that uses the MCP tools

## Managing Users

### Adding a colleague

1. Add their email to the portal's Access policy (Include → Emails)
2. Add their email to the MCP server's Access policy too (both must allow the user)
3. Tell them to add the portal URL as a connector in Claude.ai (e.g., `https://curriculum-portal.938752.xyz/mcp`)
4. They authenticate with their email on first connect — done

### Removing a colleague

1. Remove their email from the portal and server Access policies
2. They lose access immediately — no keys to rotate

## Multiple Portals for Different Audiences

Use separate portals when different users should access different MCP servers:

- **Personal portal** (`lift-portal.938752.xyz`): Only your email, attached to personal MCP servers
- **Shared portal** (`curriculum-portal.938752.xyz`): Your email + colleagues, attached to shared MCP servers

Each portal has its own Access policy, so you control who sees what. Users only need the portal URL — they don't need to know about the tunnel URLs.

## Gotchas and Lessons Learned

- **MCP server Applications need subdomain/domain set.** When you add an MCP server in AI Controls, Cloudflare auto-creates an Access Application for it. Check **Zero Trust → Access → Applications** and verify the subdomain and domain are filled in. If they're empty, the server won't sync properly — you'll get "No allowed servers available" errors from Claude.ai.

- **Admin must sync each MCP server first.** The first time you add an MCP server, you need to authenticate via the "Sync capabilities" button in AI Controls. This is a one-time admin step. After this, other users authenticate through their Claude.ai connector.

- **Don't create a separate Access Application** on the tunnel domain (e.g., `lift.938752.xyz`). The AI Controls system creates its own Applications — adding a manual one on the same domain blocks access.

- **Check DNS if the portal URL doesn't resolve.** Cloudflare should create the DNS record automatically, but verify it exists in your domain's DNS settings.

- **Leave Claude.ai connector OAuth fields blank.** The portal handles authentication via the popup flow — the OAuth Client ID/Secret fields in the connector are for a different auth mechanism.

- **The MCP server itself stays unauthenticated.** Cloudflare Access handles auth at the portal layer. Your `server-remote.js` doesn't need any auth code.

- **One tunnel per machine, multiple routes.** Name the tunnel for the machine (e.g., `pinto-apps-tunnel`), not a specific app. Add routes for each app within the same tunnel.

- **Tunnel routes need Published application routes, not Hostname routes.** When adding routes to a tunnel, use the **Published application routes** tab, not the Hostname routes (Beta) tab.

- **DNS records may not auto-create from tunnel routes.** If your tunnel routes don't automatically create DNS records, add them manually via the Published application routes tab in the tunnel config, or create CNAME records pointing to `<tunnel-id>.cfargotunnel.com`.

- **Session duration.** The Access Application has a session duration (default 24hrs). After it expires, users re-authenticate via the popup. This is fine.
