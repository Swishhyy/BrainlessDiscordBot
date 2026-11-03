import test from 'node:test';
import assert from 'node:assert/strict';
import { alertConfig, alertMessage, decideAlert, emptyAlertState, populationPresence } from '../src/population.js';
import { Gateway } from '../src/gateway.js';

const cfg = alertConfig({ ALERT_CHANNEL_ID: '1567064512010518528', ALERT_ROLE_ID: '1567063348544016424', SERVER_ADDRESS: 'sl.projectbrainless.com:9025' });
const MIN = 60_000;

test('defaults: alerts at 8 and 18 players', () => {
  assert.equal(cfg.low, 8);
  assert.equal(cfg.high, 18);
  assert.equal(cfg.channel, '1567064512010518528');
  assert.equal(alertConfig({ ALERT_CHANNEL_ID: 'not-an-id' }).channel, null);
});

test('alerts once when crossing a threshold, then waits to re-arm', () => {
  let state = emptyAlertState();
  let t = 1000 * MIN;
  const step = (players) => {
    const r = decideAlert(state, players, (t += MIN), cfg);
    state = r.state;
    return r.alert;
  };
  assert.equal(step(7), null);
  assert.equal(step(8), 'low');
  assert.equal(step(9), null, 'no repeat while staying above');
  assert.equal(step(7), null, '7 is not low enough to re-arm (needs 5)');
  assert.equal(step(8), null);
  assert.equal(step(18), 'high');
  assert.equal(step(20), null);
  assert.equal(step(5), null); // re-arms both
  t += 60 * MIN; // past the cooldown
  assert.equal(step(8), 'low');
});

test('a jump past both thresholds sends only the high alert', () => {
  const { alert, state } = decideAlert(emptyAlertState(), 19, 100 * MIN, cfg);
  assert.equal(alert, 'high');
  assert.equal(decideAlert(state, 19, 101 * MIN, cfg).alert, null);
});

test('the cooldown stops rapid repeats even after re-arming', () => {
  let { state } = decideAlert(emptyAlertState(), 8, 100 * MIN, cfg);
  ({ state } = decideAlert(state, 3, 101 * MIN, cfg));
  assert.equal(decideAlert(state, 8, 110 * MIN, cfg).alert, null, '10 minutes later is inside the 45-minute cooldown');
  assert.equal(decideAlert(state, 8, 150 * MIN, cfg).alert, 'low');
});

test('alert messages are embeds that ping only the configured role', () => {
  const low = alertMessage('low', 8, 25, cfg);
  assert.equal(low.content, '<@&1567063348544016424>');
  assert.deepEqual(low.allowed_mentions, { parse: [], roles: ['1567063348544016424'] });
  assert.match(low.embeds[0].description, /8\/25/);
  assert.equal(low.embeds[0].fields[1].value, '`sl.projectbrainless.com:9025`');
  const high = alertMessage('high', 18, 25, cfg);
  assert.match(high.embeds[0].title, /close to max pop/);
  assert.match(high.embeds[0].description, /Hurry up and join/);
});

test('the bot status shows Watching with the live population', () => {
  assert.deepEqual(populationPresence({ online: true, players: 8, maxPlayers: 25 }, {}).activities, [{ type: 3, name: 'Project Brainless · 8/25' }]);
  assert.equal(populationPresence({ online: false }, {}).activities[0].name, 'Project Brainless · offline');
});

test('the presence object polls the API, posts one alert and persists its state', async () => {
  const posts = [];
  let players = 8;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/api/v1/status')) return new Response(JSON.stringify({ online: true, players, maxPlayers: 25 }));
    if (String(url).includes('/channels/')) {
      posts.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization });
      return new Response('{}');
    }
    throw new Error('unexpected ' + url);
  };
  const stored = new Map();
  const state = { storage: { setAlarm() {}, get: async (k) => stored.get(k), put: async (k, v) => stored.set(k, v) } };
  const env = { API_URL: 'https://api.example.com', ALERT_CHANNEL_ID: '111', ALERT_ROLE_ID: '222', DISCORD_TOKEN: 'tok' };
  const gateway = new Gateway(state, env);
  await gateway.pollPopulation();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://discord.com/api/v10/channels/111/messages');
  assert.equal(posts[0].auth, 'Bot tok');
  assert.equal(posts[0].body.content, '<@&222>');
  gateway.nextPoll = 0;
  await gateway.pollPopulation();
  assert.equal(posts.length, 1, 'no second alert at the same population');
  assert.ok(stored.get('alerts'));
  assert.match(gateway.populationLine(), /8\/25/);
});
