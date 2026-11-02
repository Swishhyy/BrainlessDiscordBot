// Registers (or updates) the slash commands. Run once, and again after changing the prefix:
//   DISCORD_TOKEN=... DISCORD_APPLICATION_ID=... [DISCORD_GUILD_ID=...] [COMMAND_PREFIX=pb] node scripts/register-commands.mjs
import { commandDefinitions } from '../src/commands.js';

const { DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, COMMAND_PREFIX = 'pb' } = process.env;
if (!DISCORD_TOKEN || !/^[0-9]{1,24}$/.test(DISCORD_APPLICATION_ID ?? '')) {
  console.error('Set DISCORD_TOKEN and DISCORD_APPLICATION_ID (and optionally DISCORD_GUILD_ID, COMMAND_PREFIX).');
  process.exit(1);
}
if (!/^[a-z][a-z0-9]{0,11}$/.test(COMMAND_PREFIX)) {
  console.error('COMMAND_PREFIX must be 1-12 lowercase letters/digits.');
  process.exit(1);
}

const scope = DISCORD_GUILD_ID ? `/guilds/${DISCORD_GUILD_ID}` : '';
const response = await fetch(`https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}${scope}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(commandDefinitions(COMMAND_PREFIX)),
});
if (!response.ok) {
  console.error(`Discord rejected the commands: ${response.status} ${await response.text()}`);
  process.exit(1);
}
console.log(`Registered ${COMMAND_PREFIX}-stats, -playtime, -top, -link and -optout ${DISCORD_GUILD_ID ? 'in your server' : 'globally (can take up to an hour to appear)'}.`);
