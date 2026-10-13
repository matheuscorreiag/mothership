// Settings (config.json) and the small HTTP/env helpers every module shares.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = os.homedir();
export const HOSTNAME = os.hostname().replace(/\.local$/, '');

export function expandHome(p) {
  return p.replace(/^~(?=$|\/)/, HOME);
}

const DEFAULTS = {
  port: 7680,
  host: '127.0.0.1',
  root: '~',
  workdir: '~',
  shell: process.env.SHELL || '/bin/zsh',
  allowedLogins: [],
  dataDir: '~/.mothership',
  // The coding agent behind the chat UI; `type` picks the adapter in lib/agents.
  agent: {
    type: 'claude',
    command: 'claude',
    cwd: '~',
    args: ['--dangerously-skip-permissions'],
    model: null, // for chats left on "Default" (each chat can pick its own)
    effort: null,
    idleMinutes: 30,
  },
};

function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error(`invalid config in ${file}: ${err.message}`);
    process.exit(1);
  }
}

const file = process.env.MOTHERSHIP_CONFIG || path.join(APP_DIR, 'config.json');
const loaded = readConfig(file);
const agentType = loaded.agent?.type || DEFAULTS.agent.type;
const agentDefaults = agentType === 'claude' ? DEFAULTS.agent : { ...DEFAULTS.agent, type: agentType, command: agentType, args: [] };
export const config = { ...DEFAULTS, ...loaded, agent: { ...agentDefaults, ...loaded.agent } };
if (process.env.PORT) config.port = Number(process.env.PORT);

// ---------------------------------------------------------------- helpers

export function findBin(name) {
  const dirs = [...(process.env.PATH || '').split(':'), path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

// The server may be started from inside another terminal app or agent session;
// don't leak that context into the processes it creates.
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDECODE|CLAUDE_|CMUX_|TMUX|TERM_PROGRAM|ITERM_|GHOSTTY_|VSCODE_)/.test(k)) continue;
    if (k.startsWith('CODEX_') && !['CODEX_HOME', 'CODEX_API_KEY'].includes(k)) continue;
    env[k] = v;
  }
  env.PATH = (env.PATH || '').split(':').filter((d) => d && !/cmux/i.test(d)).join(':');
  return { ...env, ...extra };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function readJson(req, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

// ------------------------------------------------------------------ access

// Requests through `tailscale serve` carry the tailnet user's login. When
// allowedLogins is set, only those users get in; a browser on this Mac
// hitting localhost directly (no proxy headers) is always allowed.
export function authorized(req) {
  if (!config.allowedLogins.length) return true;
  const login = req.headers['tailscale-user-login'];
  if (login) return config.allowedLogins.includes(login);
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  return local && !req.headers['x-forwarded-for'];
}

// Is the browser on this Mac? Through `tailscale serve`, X-Forwarded-For is
// the client's tailnet address (the proxy sets it, never passes a client's own
// through); without it the request came straight to localhost.
export function fromThisMac(req) {
  const peer = req.socket.remoteAddress;
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
  const addr = (loopback && req.headers['x-forwarded-for']) || peer || '';
  const own = Object.values(os.networkInterfaces())
    .flat()
    .map((i) => i.address);
  return own.includes(addr.replace(/^::ffff:/, ''));
}

// Straight from a process on this Mac (an agent's tool bridge), not a browser
// through `tailscale serve`.
export function fromLocalProcess(req) {
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  return loopback && !req.headers['x-forwarded-for'] && !req.headers['tailscale-user-login'];
}

// This server runs commands, so a random website open in the same browser
// must not be able to drive it: reject cross-site requests.
export function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return host === req.headers.host || host === req.headers['x-forwarded-host'];
}

export function rejectUpgrade(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
}
