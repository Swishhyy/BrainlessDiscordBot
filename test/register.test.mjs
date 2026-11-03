import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCommands, resetSyncCache } from '../src/register.js';
import { commandDefinitions } from '../src/commands.js';
import worker from '../src/worker.js';

function mockDiscord(existing) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method, path, headers: init.headers, body: init.body });
    if (path.endsWith('/oauth2/applications/@me')) return new Response(JSON.stringify({ id: '777' }));
    if (init.method === 'GET') return new Response(JSON.stringify(existing));
    if (init.method === 'PUT') return new Response(init.body);
    return new Response('{}', { status: 404 });
  };
  return calls;
}

test('registers the commands in the server when they are missing', async () => {
  resetSyncCache();
  const calls = mockDiscord([]);
  const result = await syncCommands({ DISCORD_TOKEN: 'tok', GUILD_ID: '123', COMMAND_PREFIX: 'pb' });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/api/v10/applications/777/guilds/123/commands');
  assert.equal(put.headers.Authorization, 'Bot tok');
  assert.deepEqual(JSON.parse(put.body).map((c) => c.name), ['pb-stats', 'pb-playtime', 'pb-top', 'pb-link', 'pb-optout']);
});

test('does not re-register when Discord already has the same commands', async () => {
  resetSyncCache();
  // Discord omits "required": false and adds ids; those differences are ignored.
  const existing = commandDefinitions('pb').map((c, i) => ({ id: String(i), application_id: '777', ...c, options: c.options?.map(({ required, ...o }) => (required ? { ...o, required } : o)) }));
  const calls = mockDiscord(existing);
  const result = await syncCommands({ DISCORD_TOKEN: 'tok', GUILD_ID: '123' });
  assert.equal(result.changed, false);
  assert.ok(!calls.some((c) => c.method === 'PUT'));
});

test('without a token or with a bad server ID nothing is sent', async () => {
  resetSyncCache();
  const calls = mockDiscord([]);
  assert.equal((await syncCommands({})).ok, false);
  assert.equal((await syncCommands({ DISCORD_TOKEN: 'tok', GUILD_ID: 'abc' })).ok, false);
  assert.equal(calls.length, 0);
});

test('a rejected token gives a readable message without leaking it', async () => {
  resetSyncCache();
  globalThis.fetch = async () => new Response('{"message":"401: Unauthorized"}', { status: 401 });
  const result = await syncCommands({ DISCORD_TOKEN: 'secret-token-value' });
  assert.equal(result.ok, false);
  assert.match(result.message, /401/);
  assert.ok(!result.message.includes('secret-token-value'));
});

test('opening the Worker URL reports the registration status', async () => {
  resetSyncCache();
  mockDiscord([]);
  const response = await worker.fetch(new Request('https://bot.example/'), { DISCORD_TOKEN: 'tok', GUILD_ID: '123' }, { waitUntil() {} });
  const text = await response.text();
  assert.match(text, /bot is running/);
  assert.match(text, /Registered \/pb-stats/);
});
