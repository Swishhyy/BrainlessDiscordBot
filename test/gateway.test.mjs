import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewaySession, Gateway, presencePayload } from '../src/gateway.js';

class FakeSocket extends EventTarget {
  constructor() {
    super();
    this.sent = [];
    this.closedWith = null;
  }
  accept() {}
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code) {
    this.closedWith = code;
  }
  receive(payload) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }
  drop(code) {
    const event = new Event('close');
    event.code = code;
    this.dispatchEvent(event);
  }
}

function session(clock) {
  const socket = new FakeSocket();
  const s = new GatewaySession({ token: 'tok', presence: presencePayload({}), socket, now: () => clock.t, random: () => 0.5 });
  return { socket, s };
}

test('identifies with the token, no intents and the online presence', () => {
  const clock = { t: 0 };
  const { socket, s } = session(clock);
  socket.receive({ op: 10, d: { heartbeat_interval: 40000 } });
  const identify = socket.sent.find((m) => m.op === 2);
  assert.equal(identify.d.token, 'tok');
  assert.equal(identify.d.intents, 0);
  assert.equal(identify.d.presence.status, 'online');
  assert.deepEqual(identify.d.presence.activities, [{ type: 4, name: 'Custom Status', state: 'Project Brainless · /pb-stats' }]);
  socket.receive({ op: 0, t: 'READY', s: 1, d: {} });
  assert.equal(s.ready, true);
});

test('heartbeats on time with the last sequence and reconnects on a missed ack', () => {
  const clock = { t: 0 };
  const { socket, s } = session(clock);
  socket.receive({ op: 10, d: { heartbeat_interval: 40000 } });
  socket.receive({ op: 0, t: 'READY', s: 5, d: {} });
  clock.t = 19000;
  assert.equal(s.tick(), true);
  assert.ok(!socket.sent.some((m) => m.op === 1), 'first heartbeat waits for the jitter');
  clock.t = 20000;
  s.tick();
  assert.deepEqual(socket.sent.at(-1), { op: 1, d: 5 });
  socket.receive({ op: 11 });
  clock.t = 60000;
  assert.equal(s.tick(), true);
  assert.equal(socket.sent.filter((m) => m.op === 1).length, 2);
  clock.t = 100000; // no ack for the second heartbeat
  assert.equal(s.tick(), false);
  assert.ok(socket.closedWith);
});

test('answers heartbeat requests and reconnects when Discord asks', () => {
  const clock = { t: 0 };
  const { socket, s } = session(clock);
  socket.receive({ op: 10, d: { heartbeat_interval: 40000 } });
  socket.receive({ op: 1 });
  assert.equal(socket.sent.at(-1).op, 1);
  socket.receive({ op: 7 });
  assert.equal(s.tick(), false);
});

test('presence text and type can be configured', () => {
  assert.deepEqual(presencePayload({ PRESENCE_TEXT: 'SCP:SL', PRESENCE_TYPE: 'Playing', PRESENCE_STATUS: 'idle' }), { since: null, activities: [{ type: 0, name: 'SCP:SL' }], status: 'idle', afk: false });
});

function fakeState() {
  return { alarms: [], storage: { setAlarm(at) { this.owner.alarms.push(at); } } };
}

test('the presence object connects, reports online and keeps a watchdog alarm', async () => {
  const sockets = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(init.headers.Upgrade, 'websocket');
    const socket = new FakeSocket();
    sockets.push(socket);
    return { status: 101, webSocket: socket };
  };
  const state = fakeState();
  state.storage.owner = state;
  const gateway = new Gateway(state, { DISCORD_TOKEN: 'tok' });
  try {
    let status = await (await gateway.fetch(new Request('https://presence/ensure'))).json();
    assert.match(status.message, /connecting/);
    sockets[0].receive({ op: 10, d: { heartbeat_interval: 40000 } });
    sockets[0].receive({ op: 0, t: 'READY', s: 1, d: {} });
    status = await (await gateway.fetch(new Request('https://presence/ensure'))).json();
    assert.equal(status.online, true);
    assert.equal(sockets.length, 1, 'an open connection is reused');
    assert.ok(state.alarms.length >= 2);

    sockets[0].drop(1006);
    await gateway.alarm();
    assert.equal(sockets.length, 2, 'a dropped connection is reopened by the watchdog');

    sockets[1].drop(4004);
    await gateway.alarm();
    status = gateway.status();
    assert.equal(sockets.length, 2, 'a rejected token is not retried immediately');
    assert.match(status.message, /DISCORD_TOKEN/);
  } finally {
    gateway.stopTimer();
  }
});

test('without a token the bot stays offline and nothing connects', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
  };
  const state = fakeState();
  state.storage.owner = state;
  const gateway = new Gateway(state, {});
  const status = await (await gateway.fetch(new Request('https://presence/ensure'))).json();
  assert.equal(called, false);
  assert.match(status.message, /off/);
});
