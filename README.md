# Project Brainless Discord bot

The Project Brainless stats bot, running as a free **Cloudflare Worker**. It answers `/pb-stats`, `/pb-playtime`, `/pb-top`, `/pb-link` and `/pb-optout` by asking the game server's stats API (Core plugin in [BrainlessProjectPlugins](https://github.com/Swishhyy/BrainlessProjectPlugins)). Discord sends each command to the Worker. Nothing runs between commands, so there is no bot process to host or keep online.

```
Discord ──https──▶ this Worker ──https──▶ Cloudflare ──▶ game server (Core stats API)
```

## Before you start

The stats API has to be running behind Cloudflare first: follow steps A and B of the [Stats API guide](https://github.com/Swishhyy/BrainlessProjectPlugins/blob/main/docs/STATS_API.md). Check that `https://api.yourdomain.com/api/v1/health` shows `{"ok":true,"bot":true}`, and keep the `shared_secret` you made there. You also need Node.js 20+ on your PC for the one-time setup.

## Set up

1. **Discord Developer Portal** → [Applications](https://discord.com/developers/applications) → *New Application*.
   - *General Information*: copy the **Public Key**.
   - *Bot*: *Reset Token* and copy the **Bot Token**.
   - *Installation*: scope `applications.commands` (add `bot` if you want it listed as a member) → open the install link → add it to your server.
   - With Developer Mode on in Discord, right-click your server → *Copy Server ID*.
2. **Deploy the Worker:** Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → this repo.
   - Build command: *(empty)* · Deploy command: `npx wrangler deploy` · Root directory: `/`
   - `API_URL` in [`wrangler.toml`](wrangler.toml) must be your API address. Every push to `main` redeploys.
3. **Add variables:** open the Worker → **Settings → Variables and Secrets** → *Add*:

   | Name | Type | Value |
   | --- | --- | --- |
   | `DISCORD_PUBLIC_KEY` | Secret | the Public Key |
   | `API_SECRET` | Secret | the same value as `stats_api.shared_secret` in the Core config |
   | `DISCORD_TOKEN` | Secret | the Bot Token (registers the slash commands and keeps the bot online) |
   | `GUILD_ID` | Text | your server ID (commands appear instantly and only answer there) |

   These stay set between deploys (`keep_vars = true`).
4. **Open the Worker URL** (e.g. `https://brainlessdiscordbot.<you>.workers.dev`). It should say *Project Brainless Discord bot is running*, *Registered /pb-stats, …* and *Online status: connected*. The Worker also re-checks the commands every hour, and only re-registers them if something changed.
5. **Developer Portal → General Information → Interactions Endpoint URL:** paste the Worker URL → *Save Changes*. Discord tests it immediately; it only saves if `DISCORD_PUBLIC_KEY` is right.
6. **Test:** in game, F1 `.pblink` → in Discord `/pb-link code:XXXXXXXX` → `/pb-stats`, `/pb-top`.

Replies are private (only the person who ran the command sees them), and mentions are disabled. If the game server is offline, commands answer "Stats are unavailable right now" instead of failing.

### Population status and alerts

Every 30 seconds the bot reads `GET /api/v1/status` from the Core API (Core 0.3.1 or later) and:

- shows **Watching Project Brainless · 8/25** as its status (or `· offline`);
- posts an embed in `ALERT_CHANNEL_ID` and pings `ALERT_ROLE_ID` when the server reaches `ALERT_THRESHOLD` players (default 8, "Server is filling up!"), and again at `ALERT_HIGH_THRESHOLD` (default 18, "close to max pop, hurry up and join").

Each alert fires once per climb. It can fire again only after the count drops `ALERT_REARM_GAP` (3) players below the threshold, and no sooner than `ALERT_COOLDOWN_MINUTES` (45) after the last one. A jump straight past both thresholds sends only the high alert. Alert state is stored in the Durable Object, so redeploys don't resend.

The channel, role, thresholds and join address are in [`wrangler.toml`](wrangler.toml). The bot needs **View Channel**, **Send Messages** and **Embed Links** in the alert channel. To ping the role, either make the role mentionable or give the bot **Mention @everyone, @here and All Roles**. Problems show on the Worker's status page.

### Online status

Slash commands work over HTTP, which doesn't make a bot show as online. To show online, one Durable Object (`Gateway` in [`src/gateway.js`](src/gateway.js)) holds a Discord gateway connection with the `DISCORD_TOKEN`. It sends heartbeats, and an alarm every 30 seconds reconnects it if it dropped, for example after a redeploy. It fits within Cloudflare's free limits for one small Durable Object. It can blink offline for a few seconds while reconnecting; commands keep working either way.

By default the status shows the live population (above). To show fixed text instead, add these optional **Text** variables in the dashboard:

| Name | Default | Options |
| --- | --- | --- |
| `PRESENCE_TEXT` | `Project Brainless · /pb-stats` | any text (128 characters max) |
| `PRESENCE_TYPE` | `custom` | `custom`, `playing`, `watching`, `listening`, `competing` |
| `PRESENCE_STATUS` | `online` | `online`, `idle`, `dnd` |

The bot picks up new values the next time it reconnects. To force that, remove `DISCORD_TOKEN` and add it back.

### Without storing the bot token in Cloudflare

Leave `DISCORD_TOKEN` out (the bot then shows offline) and register the commands once from your PC instead (Node.js 20+, from a copy of this repo):

```bash
DISCORD_TOKEN=xxx DISCORD_APPLICATION_ID=123 DISCORD_GUILD_ID=456 npm run register
```

```powershell
$env:DISCORD_TOKEN="xxx"; $env:DISCORD_APPLICATION_ID="123"; $env:DISCORD_GUILD_ID="456"; npm run register
```

### Deploying from your PC instead of GitHub

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

## How it talks to the API

Private requests carry `X-PB-Timestamp`, a random `X-PB-Nonce` and `X-PB-Signature` = hex `HMAC-SHA256(API_SECRET, timestamp + "\n" + nonce + "\n" + METHOD + "\n" + pathAndQuery)` (see [`src/api.js`](src/api.js)). The secret is never sent. The leaderboard (`/pb-top`) uses the public endpoint. The full endpoint list is in the [API reference](https://github.com/Swishhyy/BrainlessProjectPlugins/blob/main/docs/STATS_API.md#api-reference).

## Developing

```bash
npm test
```

The tests check the same fixed signature value as the plugin's C# tests (`StatsApiTests.cs`), so a change to the signing on either side fails until both match.
