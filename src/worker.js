// Project Brainless Discord bot as a Cloudflare Worker.
// Discord sends each slash command here (Interactions Endpoint URL); the Worker
// answers by calling the game server's stats API. Nothing runs between commands.
import { callApi, fromHex } from './api.js';
import { syncCommands } from './register.js';

const EPHEMERAL = 64;
const encoder = new TextEncoder();
const OFFLINE = "Stats are unavailable right now (the game server may be offline or restarting). Try again in a minute.";

export async function verifyDiscord(publicKeyHex, signatureHex, timestamp, body) {
  try {
    const key = await crypto.subtle.importKey('raw', fromHex(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, fromHex(signatureHex), encoder.encode(timestamp + body));
  } catch {
    return false;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function safeName(name) {
  const clean = String(name ?? 'Player').replace(/[@`*_~<>|\\\r\n]/g, '').slice(0, 48);
  return clean.length ? clean : 'Player';
}

function playtime(seconds) {
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function option(interaction, name) {
  return interaction.data?.options?.find((o) => o.name === name)?.value;
}

function describe(stats) {
  if (!stats?.linked) return "No linked stats yet. Use `.pblink` in the game's F1 console, then `/pb-link` here.";
  const actions = Object.entries(stats.actions ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k.replaceAll('_', ' ')}: ${v}`)
    .join(', ');
  return `**${safeName(stats.name)}** — level ${stats.level}, ${stats.xp} XP\nServer playtime: ${playtime(stats.playtimeSeconds)}\n${actions || 'No recorded actions yet.'}`;
}

export async function answer(interaction, env) {
  const prefix = env.COMMAND_PREFIX || 'pb';
  const name = interaction.data?.name ?? '';
  const user = interaction.member?.user?.id ?? interaction.user?.id;
  if (!user || !/^[0-9]{1,24}$/.test(user)) return 'Could not identify your Discord account.';
  try {
    if (name === `${prefix}-stats` || name === `${prefix}-playtime`) {
      const target = option(interaction, 'user') || user;
      if (!/^[0-9]{1,24}$/.test(target)) return 'Unknown user.';
      const stats = await callApi(env, 'GET', `/api/v1/discord/${target}`);
      if (name.endsWith('-playtime') && stats.linked) return `**${safeName(stats.name)}** — server playtime: ${playtime(stats.playtimeSeconds)}`;
      return target === user ? describe(stats) : stats.linked ? describe(stats) : 'That user has not linked a game account.';
    }
    if (name === `${prefix}-top`) {
      const board = await callApi(env, 'GET', '/api/v1/leaderboard?limit=10', { signed: false });
      if (!board.players?.length) return 'No recorded XP yet.';
      return board.players.map((p) => `${p.rank}. ${safeName(p.name)} — ${p.xp} XP (level ${p.level})`).join('\n');
    }
    if (name === `${prefix}-link`) {
      const code = String(option(interaction, 'code') ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,16}$/.test(code)) return "That code is invalid. Use `.pblink` in the game's F1 console for a fresh code.";
      const result = await callApi(env, 'POST', `/api/v1/discord/${user}/link?code=${code}`);
      if (result.linked) return 'Your Project Brainless game account is linked.';
      return result.reason === 'wait' ? 'Wait ten seconds before another link attempt.' : "That code is invalid or expired. Use `.pblink` in the game's F1 console for a fresh code.";
    }
    if (name === `${prefix}-optout`) {
      const result = await callApi(env, 'POST', `/api/v1/discord/${user}/optout`);
      return result.optedOut
        ? 'Tracking disabled. Your game XP, playtime, name and Discord link were erased. Use `.pbprivacy optin` in-game to start fresh.'
        : 'No linked stats are stored for this Discord account. Use `.pbprivacy optout` in-game to disable tracking for your game account.';
    }
    return 'Unknown command.';
  } catch (error) {
    console.log(`Command ${name} failed: ${error.message}`);
    return OFFLINE;
  }
}

async function followUp(interaction, env) {
  const content = (await answer(interaction, env)).slice(0, 1900);
  const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) console.log(`Discord follow-up failed: ${response.status}`);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      // Visiting the Worker URL also registers/updates the slash commands when DISCORD_TOKEN is set.
      const sync = new URL(request.url).pathname === '/' ? await syncCommands(env) : null;
      return new Response(`Project Brainless Discord bot is running.${sync ? '\n' + sync.message : ''}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    const signature = request.headers.get('X-Signature-Ed25519');
    const timestamp = request.headers.get('X-Signature-Timestamp');
    const body = await request.text();
    if (!signature || !timestamp || !(await verifyDiscord(env.DISCORD_PUBLIC_KEY, signature, timestamp, body)))
      return new Response('Invalid request signature', { status: 401 });
    const interaction = JSON.parse(body);
    if (interaction.type === 1) return json({ type: 1 });
    if (interaction.type !== 2) return json({ type: 4, data: { content: 'Unsupported interaction.', flags: EPHEMERAL } });
    if (env.GUILD_ID && interaction.guild_id !== env.GUILD_ID)
      return json({ type: 4, data: { content: 'This bot only works in the Project Brainless Discord server.', flags: EPHEMERAL } });
    // Acknowledge within Discord's 3-second limit, then answer once the game server replies.
    ctx.waitUntil(followUp(interaction, env));
    return json({ type: 5, data: { flags: EPHEMERAL } });
  },

  // Hourly check that the slash commands are still registered (see wrangler.toml [triggers]).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncCommands(env, { force: true }).then((r) => console.log(r.message)));
  },
};
