// Population features driven by the Core API's /api/v1/status:
//  - the bot's status ("Watching Project Brainless · 8/25")
//  - one-time embed alerts when the server reaches the alert thresholds.
// Pure logic here; the Gateway Durable Object polls and sends.

const DISCORD_ID = /^[0-9]{1,24}$/;

export function alertConfig(env) {
  const number = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  const channel = String(env.ALERT_CHANNEL_ID ?? '').trim();
  const role = String(env.ALERT_ROLE_ID ?? '').trim();
  return {
    channel: DISCORD_ID.test(channel) ? channel : null,
    role: DISCORD_ID.test(role) ? role : null,
    low: number(env.ALERT_THRESHOLD, 8),
    high: number(env.ALERT_HIGH_THRESHOLD, 18),
    // The count must drop this far below a threshold before it can alert again.
    rearm: number(env.ALERT_REARM_GAP, 3),
    cooldownMs: number(env.ALERT_COOLDOWN_MINUTES, 45) * 60_000,
    serverName: String(env.SERVER_NAME ?? 'Project Brainless').slice(0, 64),
    address: String(env.SERVER_ADDRESS ?? '').slice(0, 100),
  };
}

export function emptyAlertState() {
  return { low: { armed: true, lastSent: 0 }, high: { armed: true, lastSent: 0 } };
}

// Decides which alert (if any) to send for a new player count. At most one alert
// per poll: when the count jumps past both thresholds only the "high" one is sent.
export function decideAlert(state, players, now, cfg) {
  const next = { low: { ...state.low }, high: { ...state.high } };
  for (const [key, threshold] of [['low', cfg.low], ['high', cfg.high]])
    if (players <= threshold - cfg.rearm) next[key].armed = true;

  const ready = (key, threshold) => players >= threshold && next[key].armed && now - next[key].lastSent >= cfg.cooldownMs;
  let alert = null;
  if (ready('high', cfg.high)) alert = 'high';
  else if (ready('low', cfg.low) && players < cfg.high) alert = 'low';

  if (alert === 'high') {
    next.high = { armed: false, lastSent: now };
    // Reaching high pop also counts as the low alert for this climb.
    if (next.low.armed) next.low = { armed: false, lastSent: next.low.lastSent };
  } else if (alert === 'low') next.low = { armed: false, lastSent: now };
  return { alert, state: next };
}

export function alertMessage(kind, players, maxPlayers, cfg) {
  const pop = `${players}/${maxPlayers}`;
  const high = kind === 'high';
  const fields = [{ name: 'Players', value: `**${pop}**`, inline: true }];
  if (cfg.address) fields.push({ name: 'Join', value: `\`${cfg.address}\``, inline: true });
  return {
    content: cfg.role ? `<@&${cfg.role}>` : undefined,
    allowed_mentions: { parse: [], roles: cfg.role ? [cfg.role] : [] },
    embeds: [
      {
        title: high ? '🔥 Server is close to max pop!' : '🟢 Server is filling up!',
        description: high ? `**${cfg.serverName}** is at **${pop}**. Hurry up and join before it's full!` : `**${cfg.serverName}** is at **${pop}**. Come join the round!`,
        color: high ? 0xe74c3c : 0x57f287,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// The bot's presence: "Watching <server> · 8/25", or offline / starting text.
export function populationPresence(status, env) {
  const name = String(env.SERVER_NAME ?? 'Project Brainless').slice(0, 64);
  const text = !status ? `${name}` : status.online ? `${name} · ${status.players}/${status.maxPlayers}` : `${name} · offline`;
  return { since: null, activities: [{ type: 3, name: text }], status: 'online', afk: false };
}
