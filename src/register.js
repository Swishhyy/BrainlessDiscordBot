// Keeps the slash commands registered with Discord using the DISCORD_TOKEN secret.
// It reads what Discord already has and only re-registers when something differs,
// so it is safe to run on every visit and on a schedule.
import { commandDefinitions } from './commands.js';

const API = 'https://discord.com/api/v10';
const RECHECK_MS = 5 * 60 * 1000;
let last = { at: 0, result: null };

function normalize(commands) {
  return JSON.stringify(
    (commands ?? [])
      .map((c) => ({
        name: c.name,
        type: c.type ?? 1,
        description: c.description,
        options: (c.options ?? []).map((o) => ({ type: o.type, name: o.name, description: o.description, required: !!o.required })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}

async function discord(env, method, path, body) {
  const response = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'DiscordBot (https://github.com/Swishhyy/BrainlessDiscordBot, 1.0)',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Discord ${method} ${path.replace(/\d{5,}/g, '…')} returned ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export async function syncCommands(env, { force = false } = {}) {
  if (!env.DISCORD_TOKEN) return { ok: false, message: 'DISCORD_TOKEN secret is not set, so commands are not registered automatically.' };
  const prefix = env.COMMAND_PREFIX || 'pb';
  if (!/^[a-z][a-z0-9]{0,11}$/.test(prefix)) return { ok: false, message: 'COMMAND_PREFIX must be 1-12 lowercase letters/digits.' };
  if (env.GUILD_ID && !/^[0-9]{1,24}$/.test(env.GUILD_ID)) return { ok: false, message: 'GUILD_ID must be your numeric Discord server ID.' };
  if (!force && last.result && Date.now() - last.at < RECHECK_MS) return last.result;

  let result;
  try {
    const app = await discord(env, 'GET', '/oauth2/applications/@me');
    if (!/^[0-9]{1,24}$/.test(String(app?.id ?? ''))) throw new Error('Discord did not return an application ID');
    const path = `/applications/${app.id}${env.GUILD_ID ? `/guilds/${env.GUILD_ID}` : ''}/commands`;
    const wanted = commandDefinitions(prefix);
    const current = await discord(env, 'GET', path);
    const where = env.GUILD_ID ? 'in your server' : 'globally (new commands can take up to an hour to appear)';
    if (normalize(current) === normalize(wanted)) result = { ok: true, changed: false, message: `Slash commands are up to date ${where}.` };
    else {
      await discord(env, 'PUT', path, wanted);
      result = { ok: true, changed: true, message: `Registered /${prefix}-stats, -playtime, -top, -link and -optout ${where}.` };
    }
  } catch (error) {
    result = { ok: false, message: `Could not register slash commands: ${error.message}. Check the DISCORD_TOKEN secret.` };
  }
  last = { at: Date.now(), result };
  return result;
}

export function resetSyncCache() {
  last = { at: 0, result: null };
}
