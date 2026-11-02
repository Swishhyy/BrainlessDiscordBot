import test from 'node:test';
import assert from 'node:assert/strict';
import { sign, toHex } from '../src/api.js';
import worker, { answer, verifyDiscord } from '../src/worker.js';
import { commandDefinitions } from '../src/commands.js';

// Same vector as BrainlessProjectPlugins tests/Brainless.Tests/StatsApiTests.cs, so the plugin and the bot agree.
const SECRET = '0123456789abcdef0123456789abcdef';

test('signatures match the plugin reference vector', async () => {
  assert.equal(await sign(SECRET, 1700000000, 'n0nce000000000001', 'GET', '/api/v1/discord/123456789012345678'), '048eeb8034465085732b1438fcb9f028f9417a3ed8da1b4907952266d36c0b8a');
  assert.equal(await sign(SECRET, 1700000000, 'n0nce000000000002', 'post', '/api/v1/discord/123456789012345678/link?code=ABCD2345'), '57383927aa84c3f78d7edb06a655ec5d2c8769e1b6a116d26df3e2bc231adbaf');
});

test('commands keep the five pb- names', () => {
  assert.deepEqual(commandDefinitions('pb').map((c) => c.name), ['pb-stats', 'pb-playtime', 'pb-top', 'pb-link', 'pb-optout']);
});

async function discordKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = toHex(await crypto.subtle.exportKey('raw', pair.publicKey));
  const signBody = async (timestamp, body) => toHex(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(timestamp + body)));
  return { publicKey, signBody };
}

test('only requests signed by Discord are accepted', async () => {
  const { publicKey, signBody } = await discordKeys();
  const body = '{"type":1}';
  const signature = await signBody('123', body);
  assert.equal(await verifyDiscord(publicKey, signature, '123', body), true);
  assert.equal(await verifyDiscord(publicKey, signature, '124', body), false);
  assert.equal(await verifyDiscord(publicKey, signature, '123', '{"type":2}'), false);
  assert.equal(await verifyDiscord(publicKey, 'zz', '123', body), false);

  const env = { DISCORD_PUBLIC_KEY: publicKey };
  const ctx = { waitUntil() {} };
  const ping = await worker.fetch(new Request('https://bot/', { method: 'POST', body, headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': '123' } }), env, ctx);
  assert.equal(ping.status, 200);
  assert.deepEqual(await ping.json(), { type: 1 });
  const forged = await worker.fetch(new Request('https://bot/', { method: 'POST', body, headers: { 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': '999' } }), env, ctx);
  assert.equal(forged.status, 401);
});

function mockApi(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname + parsed.search, method: init.method, headers: init.headers ?? {} });
    const handler = routes[`${init.method} ${parsed.pathname}`];
    if (!handler) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(handler(parsed, init)), { status: 200 });
  };
  return calls;
}

const env = { API_URL: 'https://api.example.com/', API_SECRET: SECRET, COMMAND_PREFIX: 'pb' };
const command = (name, options = [], user = '111') => ({ type: 2, data: { name, options }, member: { user: { id: user } } });

test('stats lookups are signed and formatted', async () => {
  const calls = mockApi({ 'GET /api/v1/discord/111': () => ({ linked: true, name: '@everyone Swish', level: 3, xp: 900, playtimeSeconds: 7260, actions: { scp_kill: 2 } }) });
  const text = await answer(command('pb-stats'), env);
  assert.match(text, /everyone Swish\*\* — level 3, 900 XP/);
  assert.ok(!text.includes('@'));
  assert.match(text, /2h 1m/);
  const call = calls[0];
  assert.equal(call.path, '/api/v1/discord/111');
  assert.match(call.headers['X-PB-Nonce'], /^[0-9a-f]{32}$/);
  const expected = await sign(SECRET, call.headers['X-PB-Timestamp'], call.headers['X-PB-Nonce'], 'GET', '/api/v1/discord/111');
  assert.equal(call.headers['X-PB-Signature'], expected);
  assert.ok(!JSON.stringify(call.headers).includes(SECRET), 'the secret itself is never sent');
});

test('leaderboard, link and opt-out use the right endpoints', async () => {
  const calls = mockApi({
    'GET /api/v1/leaderboard': () => ({ players: [{ rank: 1, name: 'Top', xp: 50, level: 1 }] }),
    'POST /api/v1/discord/111/link': (url) => ({ linked: url.searchParams.get('code') === 'ABCD2345' }),
    'POST /api/v1/discord/111/optout': () => ({ optedOut: true }),
  });
  assert.equal(await answer(command('pb-top'), env), '1. Top — 50 XP (level 1)');
  assert.equal(calls[0].headers['X-PB-Signature'], undefined, 'the public leaderboard is not signed');
  assert.match(await answer(command('pb-link', [{ name: 'code', value: ' abcd2345 ' }]), env), /linked/);
  assert.match(await answer(command('pb-link', [{ name: 'code', value: '../../x' }]), env), /invalid/);
  assert.match(await answer(command('pb-optout'), env), /Tracking disabled/);
});

test('an offline game server gives a friendly message', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  assert.match(await answer(command('pb-stats'), env), /unavailable right now/);
});

test('commands are acknowledged first and answered in a follow-up', async () => {
  const { publicKey, signBody } = await discordKeys();
  const calls = mockApi({ 'GET /api/v1/discord/111': () => ({ linked: false }) });
  const interaction = { ...command('pb-stats'), application_id: '999', token: 'tok' };
  const body = JSON.stringify(interaction);
  const pending = [];
  const response = await worker.fetch(
    new Request('https://bot/', { method: 'POST', body, headers: { 'X-Signature-Ed25519': await signBody('5', body), 'X-Signature-Timestamp': '5' } }),
    { ...env, DISCORD_PUBLIC_KEY: publicKey },
    { waitUntil: (p) => pending.push(p) },
  );
  assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
  await Promise.all(pending);
  const followUp = calls.find((c) => c.method === 'PATCH');
  assert.equal(followUp.path, '/api/v10/webhooks/999/tok/messages/@original');
});
