# Project Brainless Discord bot

The Project Brainless stats bot, running as a free **Cloudflare Worker**. It answers `/pb-stats`, `/pb-playtime`, `/pb-top`, `/pb-link` and `/pb-optout` by asking the game server's stats API (Core plugin in [BrainlessProjectPlugins](https://github.com/Swishhyy/BrainlessProjectPlugins)). Discord sends each command to the Worker. Nothing runs between commands, so there is no bot process to host or keep online.

```
Discord ──https──▶ this Worker ──https──▶ Cloudflare ──▶ game server (Core stats API)
```

## Before you start

The stats API has to be running behind Cloudflare first: follow steps A and B of the [Stats API guide](https://github.com/Swishhyy/BrainlessProjectPlugins/blob/main/docs/STATS_API.md). Check that `https://api.yourdomain.com/api/v1/health` shows `{"ok":true,"bot":true}`, and keep the `shared_secret` you made there. You also need Node.js 20+ on your PC for the one-time setup.

## Set up

1. **Discord Developer Portal** → [Applications](https://discord.com/developers/applications) → *New Application*. If you already used the old built-in bot, reuse that application.
   - *General Information*: copy the **Application ID** and **Public Key**.
   - *Bot*: *Reset Token* and copy it. You only need it once, for step 5. Don't put it anywhere else.
   - *Installation* (or *OAuth2 → URL Generator*): scope `applications.commands` (add `bot` if you want it listed as a member) → open the link → add it to your server.
2. **Edit `wrangler.toml`:** set `API_URL` to `https://api.yourdomain.com`, and `GUILD_ID` to your Discord server ID (right-click the server with Developer Mode on → *Copy Server ID*). Keep `COMMAND_PREFIX` the same as `discord_command_prefix` in the plugin.
3. **Deploy** from this repo (clone it, then run these in its folder):
   ```bash
   npx wrangler@4 login
   ```
   ```bash
   npx wrangler@4 secret put DISCORD_PUBLIC_KEY
   ```
   ```bash
   npx wrangler@4 secret put API_SECRET
   ```
   ```bash
   npm run deploy
   ```
   Paste the Public Key and the `shared_secret` from the Stats API guide when asked. The deploy prints a URL like `https://brainlessdiscordbot.<you>.workers.dev`.
4. **Developer Portal → General Information → Interactions Endpoint URL:** paste that Worker URL and *Save Changes*. Discord tests it straight away; it only saves if the Public Key is right.
5. **Register the slash commands** (once, and again only if you change the prefix):
   ```bash
   DISCORD_TOKEN=xxx DISCORD_APPLICATION_ID=123 DISCORD_GUILD_ID=456 npm run register
   ```
   On Windows PowerShell:
   ```powershell
   $env:DISCORD_TOKEN="xxx"; $env:DISCORD_APPLICATION_ID="123"; $env:DISCORD_GUILD_ID="456"; npm run register
   ```
6. **Test:** in game, F1 `.pblink` → in Discord `/pb-link code:XXXXXXXX` → `/pb-stats`, `/pb-top`.

Replies are private (only the person who ran the command sees them), and mentions are disabled. If the game server is offline, commands answer "Stats are unavailable right now" instead of failing.

### Deploying from GitHub instead of your PC

Optional: in the Cloudflare dashboard (**Workers & Pages → Create → Import a repository**) connect this repo with:

- **Build command:** none
- **Deploy command:** `npx wrangler deploy`
- **Root directory:** `/`

Every push to `main` then redeploys. The Worker name must match `name` in `wrangler.toml` (`brainlessdiscordbot`). The secrets from step 3 stay set between deploys. The `[vars]` in `wrangler.toml` are applied on every deploy, so change `API_URL`/`GUILD_ID` there rather than in the dashboard.

## How it talks to the API

Private requests carry `X-PB-Timestamp`, a random `X-PB-Nonce` and `X-PB-Signature` = hex `HMAC-SHA256(API_SECRET, timestamp + "\n" + nonce + "\n" + METHOD + "\n" + pathAndQuery)` (see [`src/api.js`](src/api.js)). The secret is never sent. The leaderboard (`/pb-top`) uses the public endpoint. The full endpoint list is in the [API reference](https://github.com/Swishhyy/BrainlessProjectPlugins/blob/main/docs/STATS_API.md#api-reference).

## Developing

```bash
npm test
```

The tests check the same fixed signature value as the plugin's C# tests (`StatsApiTests.cs`), so a change to the signing on either side fails until both match.
