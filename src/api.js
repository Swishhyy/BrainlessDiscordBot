// Talks to the Project Brainless Core stats API.
// Private requests are signed with HMAC-SHA256 over "timestamp\nnonce\nMETHOD\npathAndQuery",
// so the shared secret itself is never sent.
const encoder = new TextEncoder();

export function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('Invalid hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export function nonce() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

export async function sign(secret, timestamp, nonceValue, method, pathAndQuery) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}\n${nonceValue}\n${method.toUpperCase()}\n${pathAndQuery}`));
  return toHex(mac);
}

export class ApiError extends Error {
  constructor(status) {
    super(`Stats API returned ${status}`);
    this.status = status;
  }
}

export async function callApi(env, method, pathAndQuery, { signed = true } = {}) {
  if (!env.API_URL) throw new Error('API_URL is not set');
  const base = env.API_URL.replace(/\/+$/, '');
  const headers = { 'User-Agent': 'ProjectBrainlessBot/1.0', Accept: 'application/json' };
  if (signed) {
    if (!env.API_SECRET || env.API_SECRET.length < 32) throw new Error('API_SECRET must be at least 32 characters');
    const timestamp = Math.floor(Date.now() / 1000);
    const once = nonce();
    headers['X-PB-Timestamp'] = String(timestamp);
    headers['X-PB-Nonce'] = once;
    headers['X-PB-Signature'] = await sign(env.API_SECRET, timestamp, once, method, pathAndQuery);
  }
  const response = await fetch(base + pathAndQuery, { method, headers });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
}
