// The chats' terminals (the chat page's ⌘J panel): tmux sessions running a
// login shell, each tagged with its chat.
//
//   tab   = a tmux session (socket `mothership`) running your login shell
//   view  = a WebSocket that attaches a PTY to that tmux session
//
// Sessions live in tmux, so a terminal survives the browser closing and can be
// opened from SSH too (`bin/mothership`).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { APP_DIR, HOME, HOSTNAME, config, expandHome, findBin, cleanEnv, HttpError, sendJson, readJson, clampInt, rejectUpgrade } from './config.js';

const ROOT = fs.realpathSync(expandHome(config.root));
const SHELL = config.shell;
const TMUX = config.tmux || findBin('tmux');
const TMUX_BASE = ['-L', 'mothership', '-f', path.join(APP_DIR, 'tmux.conf')];
const PREFIX = 'mothership-';

function tmux(args, input) {
  if (!TMUX) return Promise.reject(new HttpError(500, 'tmux not found — install it with `brew install tmux`'));
  return new Promise((resolve, reject) => {
    const child = execFile(TMUX, [...TMUX_BASE, ...args], { env: cleanEnv(), encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

// ------------------------------------------------------------------- tabs

const TAB_FORMAT = [
  '#{session_name}',
  '#{session_path}',
  '#{session_created}',
  '#{pane_current_path}',
  '#{@mothership_title}',
  '#{@mothership_chat}',
  '#{pane_title}',
].join('\t');

function tabName(id) {
  if (!/^[a-f0-9]{8}$/.test(id)) throw new HttpError(400, 'invalid id');
  return PREFIX + id;
}

// Exact-match targets: `=name` for session commands, `=name:` for commands
// that take a pane (set-option, send-keys, ...), which reject the bare form.
const pane = (name) => `=${name}:`;

// Like a terminal emulator: a name given to the tab wins; otherwise the title
// the running program set (tmux defaults it to the hostname, i.e. unset);
// otherwise the current folder. Shells often set "user@host:~/dir" — that
// becomes just the folder name.
function autoTitle(paneTitle, currentPath) {
  const folder = (p) => (p === HOME || p === '~' ? '~' : path.basename(p) || p);
  const t = paneTitle.trim().replace(/^[^@\s]+@[^:\s]+:\s*/, '');
  if (!t || t === HOSTNAME || t === os.hostname()) return folder(currentPath);
  return /^[~/]/.test(t) && !/\s/.test(t) ? folder(t) : t;
}

async function listTabs() {
  let out;
  try {
    out = await tmux(['list-sessions', '-F', TAB_FORMAT]);
  } catch (err) {
    if (/no server running|error connecting|no sessions/i.test(err.stderr || '')) return [];
    throw err;
  }
  return out
    .split('\n')
    .filter((line) => line.startsWith(PREFIX))
    .map((line) => {
      const [name, cwd, created, currentPath, customTitle, chat, ...paneTitle] = line.split('\t');
      return {
        id: name.slice(PREFIX.length),
        title: customTitle || autoTitle(paneTitle.join('\t'), currentPath),
        chat: chat || undefined,
        cwd,
        currentPath,
        created: Number(created) * 1000,
      };
    })
    .sort((a, b) => a.created - b.created);
}

// chat: the chat whose terminal this is, kept in the session
// (@mothership_chat) so every device finds the same one.
const chatId = (chat) => {
  if (!/^[a-f0-9]{12}$/.test(chat)) throw new HttpError(400, 'invalid chat');
  return chat;
};

async function createTab({ cwd, chat }) {
  const dir = await resolveSafe(cwd);
  if (!(await fsp.stat(dir)).isDirectory()) throw new HttpError(400, 'the terminal folder must be a directory');
  if (chat != null) chatId(chat);
  const id = crypto.randomBytes(4).toString('hex');
  // Login shell so PATH, nvm etc. match a normal terminal window.
  await tmux(['new-session', '-d', '-s', PREFIX + id, '-c', dir, '-x', '120', '-y', '36', SHELL, '-l']);
  if (chat != null) await tmux(['set-option', '-t', pane(PREFIX + id), '@mothership_chat', chat]);
  return (await listTabs()).find((t) => t.id === id);
}

// A terminal opened on the new chat page belongs to the chat its first message makes.
async function setTabChat(id, chat) {
  await tmux(['set-option', '-t', pane(tabName(id)), '@mothership_chat', chatId(chat)]);
}

async function closeTab(id) {
  await tmux(['kill-session', '-t', `=${tabName(id)}`]).catch(() => {});
}

// A deleted chat's terminal goes with it.
export async function closeChatTabs(chat) {
  for (const tab of await listTabs().catch(() => [])) if (tab.chat === chat) await closeTab(tab.id);
}

// The folder a terminal opens in, symlinks resolved, so nothing can step outside ROOT.
async function resolveSafe(p) {
  if (typeof p !== 'string' || !p) throw new HttpError(400, 'path required');
  const abs = path.resolve(ROOT, expandHome(p));
  const real = await fsp.realpath(abs).catch(() => {
    throw new HttpError(404, 'folder not found');
  });
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new HttpError(403, 'outside the allowed folder');
  return real;
}

// ----------------------------------------------------------------- routes

// Returns false when the path isn't a terminal route.
export async function handleTerminalApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const reply = (status, body) => {
    sendJson(res, status, body);
    return true;
  };
  if (pathname === '/api/tabs') {
    if (method === 'GET') return reply(200, await listTabs());
    if (method === 'POST') return reply(201, await createTab(await readJson(req)));
  }
  const tab = pathname.match(/^\/api\/tabs\/([^/]+)$/);
  if (tab && method === 'PATCH') {
    const body = await readJson(req);
    if ('chat' in body) await setTabChat(tab[1], body.chat);
    return reply(200, { ok: true });
  }
  return false;
}

// --------------------------------------------------------------- terminal

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

// Called for /ws/tabs/<id> after access checks.
export async function handleTerminalUpgrade(req, socket, head, url) {
  const match = url.pathname.match(/^\/ws\/tabs\/([a-f0-9]{8})$/);
  if (!match) return rejectUpgrade(socket, 404, 'Not Found');
  const name = PREFIX + match[1];
  try {
    await tmux(['has-session', '-t', `=${name}`]);
  } catch {
    return rejectUpgrade(socket, 404, 'Not Found');
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, name, url));
}

// Turned off from the panel: detach every browser view; tmux keeps the shells.
export function detachTerminals() {
  for (const ws of wss.clients) ws.close(1001, 'turned off');
}

// Each browser view is its own tmux client; closing the view only detaches.
function attach(ws, name, url) {
  const term = pty.spawn(TMUX, [...TMUX_BASE, 'attach-session', '-t', `=${name}`], {
    name: 'xterm-256color',
    cols: clampInt(url.searchParams.get('cols'), 10, 500, 120),
    rows: clampInt(url.searchParams.get('rows'), 4, 200, 36),
    cwd: HOME,
    env: cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' }),
  });
  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  // 4000 tells the UI the tmux client is gone (usually: the tab was closed).
  term.onExit(() => ws.close(4000, 'session ended'));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
    else if (msg.t === 'r') term.resize(clampInt(msg.cols, 10, 500, 120), clampInt(msg.rows, 4, 200, 36));
  });
  ws.on('close', () => {
    try {
      term.kill();
    } catch {}
  });
}
