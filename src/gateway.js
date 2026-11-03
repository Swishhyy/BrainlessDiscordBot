// Keeps the bot "online" in Discord.
//
// Discord shows a bot as online only while it holds a gateway (WebSocket)
// connection. Slash commands don't need it (they arrive over HTTP), so this is
// purely for presence. A single Durable Object holds the connection; an alarm
// every 30 seconds sends heartbeats if needed and reconnects if it dropped
// (for example after a redeploy).

import { alertConfig, alertMessage, decideAlert, emptyAlertState, populationPresence } from './population.js';

const GATEWAY_URL = 'https://gateway.discord.gg/?v=10&encoding=json';
const WATCHDOG_MS = 30_000;
const TICK_MS = 5_000;
// Close codes that will not fix themselves by reconnecting quickly.
const FATAL = { 4004: 'Discord rejected DISCORD_TOKEN (4004 authentication failed)', 4013: 'invalid intents (4013)', 4014: 'disallowed intents (4014)' };

const ACTIVITY_TYPES = { playing: 0, listening: 2, watching: 3, competing: 5, custom: 4 };

export function presencePayload(env) {
  const text = String(env.PRESENCE_TEXT ?? 'Project Brainless · /pb-stats').slice(0, 128);
  const type = ACTIVITY_TYPES[String(env.PRESENCE_TYPE ?? 'custom').toLowerCase()] ?? 4;
  const status = ['online', 'idle', 'dnd'].includes(env.PRESENCE_STATUS) ? env.PRESENCE_STATUS : 'online';
  const activity = type === 4 ? { type, name: 'Custom Status', state: text } : { type, name: text };
  return { since: null, activities: text ? [activity] : [], status, afk: false };
}

// One gateway connection: identify, heartbeat, notice when it must reconnect.
export class GatewaySession {
  constructor({ token, presence, socket, now = () => Date.now(), random = Math.random }) {
    this.token = token;
    this.presence = presence;
    this.socket = socket;
    this.now = now;
    this.random = random;
    this.seq = null;
    this.interval = 0;
    this.lastHeartbeat = 0;
    this.awaitingAck = false;
    this.ready = false;
    this.closed = false;
    this.closeReason = null;
    this.closeCode = null;
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', (event) => this.markClosed(`closed by Discord (${event.code ?? 'no code'})`, event.code));
    socket.addEventListener('error', () => this.markClosed('connection error'));
  }

  send(payload) {
    if (this.closed) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      this.markClosed('send failed');
    }
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (message.s !== null && message.s !== undefined) this.seq = message.s;
    switch (message.op) {
      case 10: // Hello
        this.interval = Number(message.d?.heartbeat_interval) || 41_250;
        // First heartbeat after interval * jitter, as Discord asks.
        this.lastHeartbeat = this.now() - this.interval + this.interval * this.random();
        this.send({
          op: 2,
          d: { token: this.token, intents: 0, properties: { os: 'cloudflare', browser: 'brainlessdiscordbot', device: 'brainlessdiscordbot' }, presence: this.presence },
        });
        break;
      case 11: // Heartbeat ACK
        this.awaitingAck = false;
        break;
      case 1: // Discord asks for a heartbeat now
        this.heartbeat();
        break;
      case 7: // Reconnect
        this.close('Discord asked to reconnect');
        break;
      case 9: // Invalid session
        this.close('invalid session');
        break;
      case 0:
        if (message.t === 'READY') this.ready = true;
        break;
    }
  }

  // Change the bot's status without reconnecting (gateway op 3).
  updatePresence(presence) {
    this.presence = presence;
    if (this.ready) this.send({ op: 3, d: presence });
  }

  heartbeat() {
    this.send({ op: 1, d: this.seq });
    this.lastHeartbeat = this.now();
    this.awaitingAck = true;
  }

  // Returns false when the connection is gone and a new one is needed.
  tick() {
    if (this.closed) return false;
    if (this.interval && this.now() - this.lastHeartbeat >= this.interval) {
      if (this.awaitingAck) {
        this.close('missed heartbeat acknowledgement');
        return false;
      }
      this.heartbeat();
    }
    return true;
  }

  markClosed(reason, code) {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.closeReason = reason;
    this.closeCode = code ?? null;
  }

  close(reason) {
    this.markClosed(reason);
    try {
      this.socket.close(4000, reason.slice(0, 100));
    } catch {
      // already closed
    }
  }
}

async function openSocket() {
  const response = await fetch(GATEWAY_URL, { headers: { Upgrade: 'websocket' } });
  const socket = response.webSocket;
  if (!socket) throw new Error(`gateway upgrade failed (${response.status})`);
  socket.accept();
  return socket;
}

// The Durable Object that owns the connection. Address it by name ("presence").
export class Gateway {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.session = null;
    this.timer = null;
    this.backoff = 5_000;
    this.nextAttempt = 0;
    this.lastError = null;
    this.connectedAt = null;
    this.connecting = false;
    this.population = null;
    this.presenceKey = null;
    this.nextPoll = 0;
    this.alertBackoffUntil = 0;
    this.alertProblem = null;
  }

  // PRESENCE_TEXT overrides the live population status.
  currentPresence() {
    return this.env.PRESENCE_TEXT ? presencePayload(this.env) : populationPresence(this.population, this.env);
  }

  // Every ~30 seconds: read the server population, update the bot's status when it
  // changes, and post a role-ping embed when an alert threshold is reached.
  async pollPopulation() {
    if (!this.env.API_URL || Date.now() < this.nextPoll) return;
    this.nextPoll = Date.now() + 25_000;
    let status;
    try {
      const response = await fetch(this.env.API_URL.replace(/\/+$/, '') + '/api/v1/status', { headers: { Accept: 'application/json' } });
      status = response.ok ? await response.json() : { online: false };
    } catch {
      status = { online: false };
    }
    this.population = status;

    const presence = this.currentPresence();
    const key = JSON.stringify(presence.activities);
    if (this.session?.ready && key !== this.presenceKey) {
      this.session.updatePresence(presence);
      this.presenceKey = key;
    }

    const cfg = alertConfig(this.env);
    if (!status.online || !this.env.DISCORD_TOKEN || !cfg.channel || Date.now() < this.alertBackoffUntil) return;
    const saved = (await this.state.storage.get('alerts')) ?? emptyAlertState();
    const { alert, state } = decideAlert(saved, Number(status.players) || 0, Date.now(), cfg);
    if (alert) {
      const response = await fetch(`https://discord.com/api/v10/channels/${cfg.channel}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${this.env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(alertMessage(alert, status.players, status.maxPlayers, cfg)),
      }).catch((error) => ({ ok: false, status: error.message }));
      if (!response.ok) {
        // Keep the alert pending and retry in 5 minutes (e.g. missing channel permission).
        this.alertProblem = `posting the alert failed (${response.status}); check the bot can send messages and embeds in the alert channel`;
        this.alertBackoffUntil = Date.now() + 5 * 60_000;
        return;
      }
      this.alertProblem = null;
    }
    await this.state.storage.put('alerts', state);
  }

  async fetch(request) {
    await this.ensure();
    await this.pollPopulation().catch(() => {});
    return new Response(JSON.stringify(this.status()), { headers: { 'Content-Type': 'application/json' } });
  }

  async alarm() {
    await this.ensure();
    await this.pollPopulation().catch(() => {});
  }

  status() {
    if (!this.env.DISCORD_TOKEN) return { online: false, message: 'Online status: off (DISCORD_TOKEN secret is not set).' };
    if (this.session?.ready && !this.session.closed) return { online: true, message: 'Online status: connected to Discord, the bot shows as online.' + this.populationLine() };
    if (this.session && !this.session.closed) return { online: false, message: 'Online status: connecting to Discord…' };
    return { online: false, message: `Online status: reconnecting${this.lastError ? ` (last problem: ${this.lastError})` : ''}.` };
  }

  populationLine() {
    const pop = this.population;
    const cfg = alertConfig(this.env);
    const count = !pop ? 'not checked yet' : pop.online ? `${pop.players}/${pop.maxPlayers}` : 'game server offline';
    const alerts = !cfg.channel ? 'off (set ALERT_CHANNEL_ID)' : `on at ${cfg.low} and ${cfg.high} players${cfg.role ? ', pinging the role' : ''}`;
    return `\nPopulation: ${count}. Alerts: ${alerts}.${this.alertProblem ? ` Problem: ${this.alertProblem}.` : ''}`;
  }

  async ensure() {
    await this.state.storage.setAlarm(Date.now() + WATCHDOG_MS);
    if (!this.env.DISCORD_TOKEN) {
      this.session?.close('DISCORD_TOKEN removed');
      this.session = null;
      return;
    }
    if (this.session && this.session.tick()) return;
    if (this.session) {
      this.lastError = this.session.closeReason;
      const fatal = FATAL[this.session.closeCode];
      if (fatal) {
        this.lastError = fatal;
        this.nextAttempt = Date.now() + 15 * 60_000;
      }
      this.session = null;
      this.stopTimer();
    }
    if (Date.now() < this.nextAttempt || this.connecting) return;
    this.connecting = true;
    try {
      const socket = await openSocket();
      const presence = this.currentPresence();
      this.session = new GatewaySession({ token: this.env.DISCORD_TOKEN, presence, socket });
      this.presenceKey = JSON.stringify(presence.activities);
      this.connectedAt = Date.now();
      this.backoff = 5_000;
      this.nextAttempt = 0;
      this.startTimer();
    } catch (error) {
      this.lastError = error.message;
      this.nextAttempt = Date.now() + this.backoff;
      this.backoff = Math.min(this.backoff * 2, 5 * 60_000);
    } finally {
      this.connecting = false;
    }
  }

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (this.session && !this.session.tick()) this.ensure();
    }, TICK_MS);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// Wake the presence object (it then keeps itself alive) and report its state.
export async function presenceStatus(env) {
  if (!env.GATEWAY) return { online: false, message: 'Online status: not configured.' };
  try {
    const stub = env.GATEWAY.get(env.GATEWAY.idFromName('presence'));
    const response = await stub.fetch('https://presence/ensure');
    return await response.json();
  } catch (error) {
    return { online: false, message: `Online status: could not start (${error.message}).` };
  }
}
