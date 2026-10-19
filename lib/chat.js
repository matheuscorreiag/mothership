// Chats with a coding agent: one agent process per conversation, driven
// through an adapter (lib/agents) that turns its protocol into neutral
// events. Those become "items", appended to ~/.mothership/chats/<id>/events.jsonl
// and broadcast over a WebSocket to every device looking at that chat, so any
// of them can pick the conversation up. The process stays alive between turns,
// is stopped after `idleMinutes` without use and resumed on the next message.
//
// Items (persisted, in order):
//   { t: 'user', text, attachments: [{ name, url, mediaType, path }] }
//   { t: 'block', msg, index, block, parent }   block: text | thinking | tool_use
//   { t: 'tool_result', toolUseId, isError, content: [text | image], parent }
//   { t: 'result', ok, interrupted, error, durationMs, turns }
//   { t: 'system', level, text }
// Live only (not persisted): { t: 'start' | 'delta' | 'drop', msg, index, ... }
// Per chat (in the list): context { used, window }, accent hue, settings
// { model, effort } (null = default), unread, preview (the last turn's last
// text, for notifications). Account-wide: limits.
//
// Unread: a turn that ended (doneAt) after the chat was last seen (readAt).
// Seen = open on a device whose page is visible; any device counts, so the
// state is shared. An archived chat is never unread (see setArchived).
//
// History goes out a page at a time: a chat opens on its last page, and older
// ones are asked for as the page scrolls up (see historyPage).
//
// "/clear" is the engine's, whatever the agent: the next message starts a new
// session and the thread starts empty (the old items stay on disk, unshown).
//
// Agents also get the server's own tools (Slack, lib/slack.js) through an MCP
// bridge (lib/mcp-bridge.js) that calls back here with the chat's key. A tool
// knows the prompt the turn is answering (chat.turn).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { APP_DIR, HOME, config, expandHome, fromLocalProcess, HttpError, sendJson, readJson, IMAGE_TYPES } from './config.js';
import { createAgents } from './agents/index.js';
import { startAgent } from './agents/process.js';
import { slackConnected, slackTools, runSlackTool, onSlackChange } from './slack.js';
import { closeChatTabs } from './terminal.js';

const AGENT = config.agent;
const agents = createAgents(config);
if (!agents[AGENT.type]) throw new Error(`Unknown agent: ${AGENT.type}`);
const provider = (chat) => agents[chat.meta.agent];
const DATA_DIR = expandHome(config.dataDir);
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const LIMITS_FILE = path.join(DATA_DIR, 'limits.json');
const BRIDGE = path.join(APP_DIR, 'lib', 'mcp-bridge.js');
// Image types sent to the agent as images; anything else goes as a path.
const AGENT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const FILE_TYPES = {
  ...IMAGE_TYPES,
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
};
const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_RESULT_TEXT = 60_000;
const PAGE_ITEMS = 100; // about a page of history; long agent turns run to hundreds of items
const CLEAR = '/clear';

const DEFAULT_SYSTEM_PROMPT = [
  'You are being used through a custom web chat UI, often from a phone.',
  'It renders Markdown and shows images inline when you mention the absolute path of an image file',
  '(png, jpg, gif, webp, svg) — e.g. after saving a screenshot or chart, write its full path.',
  'Files the user attaches are saved on disk; their paths are included in the message.',
].join(' ');

const chats = new Map(); // id -> Chat
const sockets = new Set(); // every chat socket, for list updates
let limits = {}; // provider -> { status, windows, updated }
let limitWrites = Promise.resolve();
let nextHue = null; // accent of the next chat, so the empty "new chat" screen already wears it

class Chat {
  constructor(meta) {
    this.meta = meta; // { id, title, hue, sessionId, model, modelLabel, context, settings, preview, dir, cwd, pinned, archived, doneAt, readAt, created, updated }
    this.dir = path.join(CHATS_DIR, meta.id);
    this.proc = null;
    this.status = 'idle'; // idle | running
    this.queue = []; // messages sent while a turn was running
    this.watchers = new Set(); // sockets showing this chat
    this.drafts = new Map(); // `${msg}:${index}` -> block being streamed
    this.writes = Promise.resolve(); // serializes appends to events.jsonl
    this.events = Promise.resolve(); // serializes handling of agent events
    this.stderr = '';
    this.interrupting = false;
    this.idleTimer = null;
    this.interruptTimer = null;
    this.restart = false; // settings changed mid-turn: new process after it
    this.clears = 0; // bumped by /clear, so a history read that raced it is redone
    this.clearing = false; // /clear is looking up the folder: messages wait in the queue
    this.deleted = false;
    this.key = crypto.randomBytes(16).toString('hex'); // how its agent's tool bridge says which chat it is
    this.turn = null; // { text, sent } while a turn runs: the prompt it answers (Slack checks sends against it)
  }

  get eventsFile() {
    return path.join(this.dir, 'events.jsonl');
  }

  summary() {
    const { settings = {}, doneAt = 0, readAt = 0, archived } = this.meta;
    return { ...this.meta, settings: { model: settings.model ?? null, effort: settings.effort ?? null }, unread: !archived && doneAt > readAt, status: this.status, queued: this.queue.length };
  }

  // Shown on a device right now?
  get seen() {
    return [...this.watchers].some((ws) => ws.visible);
  }
}

const shortId = () => crypto.randomBytes(6).toString('hex');

// Each chat gets its own accent: a random hue at a fixed OKLCH lightness and
// chroma (the client paints oklch(0.78 0.14 <hue>)), so any of them reads well
// on the dark UI. Hues too close to the newest chats are rolled again.
function pickHue() {
  const recent = [...chats.values()]
    .sort((a, b) => b.meta.created - a.meta.created)
    .slice(0, 4)
    .map((c) => c.meta.hue)
    .filter(Number.isFinite);
  const gapTo = (hue) => Math.min(180, ...recent.map((h) => Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue))));
  let best = 0;
  for (let i = 0; i < 32; i++) {
    const hue = Math.floor(Math.random() * 360);
    if (gapTo(hue) >= 50) return hue;
    if (gapTo(hue) > gapTo(best)) best = hue;
  }
  return best;
}

// ------------------------------------------------------------ persistence

export async function loadChats() {
  await fsp.mkdir(CHATS_DIR, { recursive: true });
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  for (const id of await fsp.readdir(CHATS_DIR)) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(CHATS_DIR, id, 'meta.json'), 'utf8'));
      chats.set(meta.id, new Chat(meta));
    } catch {}
  }
  const savedLimits = JSON.parse(await fsp.readFile(LIMITS_FILE, 'utf8').catch(() => 'null'));
  limits = savedLimits?.windows ? { claude: savedLimits } : savedLimits || {};
  // Chats saved by older versions get an accent (oldest first) and a model label.
  for (const chat of [...chats.values()].sort((a, b) => a.meta.created - b.meta.created)) {
    const legacy = !chat.meta.agent;
    chat.meta.agent ||= 'claude'; // Existing sessions belong to Claude, regardless of today's default.
    const agent = provider(chat)?.adapter;
    if (!agent) throw new Error(`Unknown saved agent: ${chat.meta.agent}`);
    const label = chat.meta.model && agent.modelLabel ? agent.modelLabel(chat.meta.model) : chat.meta.modelLabel;
    if (!legacy && Number.isFinite(chat.meta.hue) && label === chat.meta.modelLabel) continue;
    if (!Number.isFinite(chat.meta.hue)) chat.meta.hue = pickHue();
    chat.meta.modelLabel = label;
    await saveMeta(chat);
  }
  nextHue = pickHue();
}

// Where its agent starts: every process of a session (see clearChat).
const startDir = (chat) => chat.meta.dir || expandHome(provider(chat).options.cwd);
const isDir = (dir) => (dir ? fsp.stat(dir).then((st) => st.isDirectory(), () => false) : Promise.resolve(false));

// Where the agent works now (meta.cwd, shown in the status line): what the
// adapter can tell (currentDir), else the last folder it reported. One that's
// gone since (a removed worktree, say) gives way to the start folder, where
// the agent's shell goes back to. Debounced: tool results come in bursts, and
// the agent writes what it reports a moment after.
function refreshDir(chat) {
  const agent = provider(chat).adapter;
  clearTimeout(chat.dirTimer);
  chat.dirTimer = setTimeout(async () => {
    const now = agent.currentDir && chat.meta.sessionId ? await agent.currentDir(chat.meta.sessionId).catch(() => null) : null;
    let dir = now || chat.meta.cwd;
    if (!(await isDir(dir))) dir = startDir(chat);
    if (dir === chat.meta.cwd || chat.deleted) return;
    chat.meta.cwd = dir;
    await saveMeta(chat);
    broadcastList();
  }, 500);
}

// Where the agent works now, asked afresh (meta.cwd trails it by a moment), if
// that folder is still there.
async function workingDir(chat) {
  const agent = provider(chat).adapter;
  const now = agent.currentDir && chat.meta.sessionId ? await agent.currentDir(chat.meta.sessionId).catch(() => null) : null;
  const dir = now || chat.meta.cwd;
  return (await isDir(dir)) ? dir : null;
}

async function saveMeta(chat) {
  if (chat.deleted) return;
  await fsp.writeFile(path.join(chat.dir, 'meta.json'), `${JSON.stringify(chat.meta, null, 2)}\n`);
}

// dir: where its agent starts (a terminal's "New chat in this folder"); none =
// the configured folder. It always starts there, as --resume needs.
async function createChat(settings, dir, type = AGENT.type) {
  if (!Object.hasOwn(agents, type)) throw new HttpError(400, `unknown agent "${type}"`);
  const agent = agents[type].adapter;
  if (agent.discover && !agent.models.length) await (discovering || discoverAgents());
  const now = Date.now();
  const hue = nextHue ?? pickHue();
  settings = checkSettings(agent, { model: null, effort: null }, settings || {});
  if (dir != null) {
    const st = typeof dir === 'string' && path.isAbsolute(dir) ? await fsp.stat(dir).catch(() => null) : null;
    if (!st?.isDirectory()) throw new HttpError(400, `folder not found: ${dir}`);
  }
  const chat = new Chat({ id: shortId(), agent: type, title: '', hue, sessionId: null, model: null, modelLabel: modelChoiceLabel(agent, settings.model), context: null, settings, ...(dir && { dir, cwd: dir }), created: now, updated: now });
  await fsp.mkdir(chat.dir, { recursive: true });
  await saveMeta(chat);
  chats.set(chat.meta.id, chat);
  nextHue = pickHue();
  broadcastList();
  return chat;
}

function getChat(id) {
  const chat = chats.get(id);
  if (!chat) throw new HttpError(404, 'chat not found');
  return chat;
}

function append(chat, fields) {
  const item = { id: shortId(), ts: Date.now(), ...fields };
  if (chat.deleted) return item;
  chat.meta.updated = item.ts;
  chat.writes = chat.writes
    .then(() => fsp.appendFile(chat.eventsFile, `${JSON.stringify(item)}\n`))
    .catch((err) => console.error('chat: write failed', err));
  emit(chat, { op: 'item', item });
  return item;
}

async function history(chat) {
  await chat.writes;
  const text = await fsp.readFile(chat.eventsFile, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// A page can start at a prompt, or mid-reply at a top-level block while no
// tool call waits for its result — so every result lands in the same page as
// its card (the page shows that part of the turn on its own until the one
// above it is loaded).
function pageStarts(items) {
  const open = new Set(); // tool calls without a result yet, this turn
  return items.map((item) => {
    if (item.t === 'user') open.clear();
    if (item.t === 'tool_result') open.delete(item.toolUseId);
    const ok = item.t === 'user' || (item.t === 'block' && !item.parent && !open.size);
    if (item.t === 'block' && item.block?.type === 'tool_use') open.add(item.block.id);
    return ok;
  });
}

// About PAGE_ITEMS items before the item `before` (an id; none = the end),
// starting where a page can start. turnsBefore: prompts before the page, so
// the page keeps the turns' numbers.
async function historyPage(chat, before) {
  let clears, items;
  do {
    clears = chat.clears;
    items = await history(chat);
  } while (clears !== chat.clears);
  const end = before ? items.findIndex((i) => i.id === before) : items.length;
  if (end < 0) return { items: [], more: false, turnsBefore: 0 }; // cleared since
  const starts = pageStarts(items);
  let start = Math.max(0, end - PAGE_ITEMS);
  while (start > 0 && !starts[start]) start--;
  const turnsBefore = items.slice(0, start).filter((i) => i.t === 'user').length;
  const page = { items: items.slice(start, end), more: start > 0, turnsBefore };
  // With the last page, the last prompts (↑ in the message box) — the page may hold only one.
  if (!before) page.prompts = items.filter((i) => i.t === 'user' && i.text).slice(-10).map((i) => i.text);
  return page;
}

// /clear: the agent starts over (a new session, with no --resume) and so does
// the thread. The old items move aside in the chat's folder. The new session
// starts in the folder the old one had moved to, and so does every process
// after it (--resume finds sessions by folder): it becomes the chat's dir.
async function clearChat(chat) {
  retire(chat);
  chat.clearing = true;
  const dir = await workingDir(chat);
  chat.clearing = false;
  if (chat.deleted) return;
  if (dir && dir !== startDir(chat)) chat.meta.dir = dir;
  Object.assign(chat.meta, { sessionId: null, context: null, preview: '', cwd: chat.meta.dir || null });
  chat.drafts.clear();
  chat.clears++;
  // Behind the appends already queued, so those stay with the old items.
  chat.writes = chat.writes
    .then(() => fsp.rename(chat.eventsFile, path.join(chat.dir, `events-${Date.now()}.jsonl`)))
    .catch((err) => err.code !== 'ENOENT' && console.error('chat: clear failed', err));
  emit(chat, { op: 'cleared' });
  append(chat, { t: 'system', level: 'info', text: 'Conversation cleared' });
  saveMeta(chat).catch(() => {});
  emitStatus(chat);
  dispatchNext(chat);
}

async function deleteChat(chat) {
  chat.deleted = true;
  chat.queue = [];
  chats.delete(chat.meta.id);
  clearTimeout(chat.idleTimer);
  chat.proc?.kill();
  for (const ws of chat.watchers) send(ws, { op: 'deleted', chatId: chat.meta.id });
  await chat.writes;
  await fsp.rm(chat.dir, { recursive: true, force: true });
  broadcastList();
  await closeChatTabs(chat.meta.id);
}

// ------------------------------------------------------------------ media

const mediaUrl = (file) => `/media/${encodeURIComponent(file)}`;

function mediaInfo(file, name) {
  const full = path.join(MEDIA_DIR, file);
  const mediaType = FILE_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return { name: name || file, url: mediaUrl(file), mediaType: mediaType.split(';')[0], path: full, file };
}

// Images inside tool results arrive as base64; keep them as files, named by
// content so the same screenshot read twice is stored once.
async function saveImage(base64, mediaType) {
  const buf = Buffer.from(base64, 'base64');
  const ext = Object.keys(IMAGE_TYPES).find((e) => IMAGE_TYPES[e] === mediaType) || '.bin';
  const file = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}${ext}`;
  const full = path.join(MEDIA_DIR, file);
  if (!fs.existsSync(full)) await fsp.writeFile(full, buf);
  return { type: 'image', url: mediaUrl(file), mediaType };
}

async function saveUpload(req, url) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD) throw new HttpError(413, 'file too large (max 50 MB)');
  const original = path.basename(String(url.searchParams.get('name') || 'file')).slice(0, 120) || 'file';
  const ext = path.extname(original).toLowerCase().replace(/[^.\w]/g, '');
  const stem = path.basename(original, path.extname(original)).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'file';
  const file = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}-${stem}${ext}`;
  const full = path.join(MEDIA_DIR, file);
  let size = 0;
  try {
    await pipeline(
      req,
      async function* limit(source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > MAX_UPLOAD) throw new HttpError(413, 'file too large (max 50 MB)');
          yield chunk;
        }
      },
      fs.createWriteStream(full),
    );
  } catch (err) {
    await fsp.rm(full, { force: true });
    throw err;
  }
  const info = mediaInfo(file, original);
  return { file: info.file, name: info.name, url: info.url, mediaType: info.mediaType, size };
}

async function resolveAttachments(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > 20) throw new HttpError(400, 'too many attachments (max 20)');
  return Promise.all(
    list.map(async ({ file, name }) => {
      if (typeof file !== 'string' || path.basename(file) !== file) throw new HttpError(400, 'invalid attachment');
      await fsp.access(path.join(MEDIA_DIR, file)).catch(() => {
        throw new HttpError(400, `attachment not found: ${name || file}`);
      });
      return mediaInfo(file, typeof name === 'string' ? name.slice(0, 120) : file);
    }),
  );
}

// Served with a CSP so an SVG (or anything else) opened directly can't run
// scripts on this origin.
async function streamFile(res, full, contentType, cache) {
  const st = await fsp.stat(full).catch(() => null);
  if (!st?.isFile()) throw new HttpError(404, 'not found');
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': st.size,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  await pipeline(fs.createReadStream(full), res);
}

export async function serveMedia(res, url) {
  const file = decodeURIComponent(url.pathname.slice('/media/'.length));
  if (!file || path.basename(file) !== file) throw new HttpError(404, 'not found');
  const { mediaType } = mediaInfo(file);
  await streamFile(res, path.join(MEDIA_DIR, file), FILE_TYPES[path.extname(file).toLowerCase()] || mediaType, 'private, max-age=31536000, immutable');
}

// Images the agent mentions by path (screenshots, charts it saved...). Only
// image files under the home folder.
async function serveLocalImage(res, url) {
  const requested = url.searchParams.get('path') || '';
  const type = IMAGE_TYPES[path.extname(requested).toLowerCase()];
  if (!type || !path.isAbsolute(expandHome(requested))) throw new HttpError(400, 'not an image');
  const real = await fsp.realpath(expandHome(requested)).catch(() => null);
  if (!real || !real.startsWith(HOME + path.sep)) throw new HttpError(404, 'not found');
  await streamFile(res, real, type, 'no-cache');
}

// ---------------------------------------------------- settings and reads


// `current` with the fields `changes` sets ({ model, effort }), validated.
function checkSettings(agent, current, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new HttpError(400, 'invalid settings');
  const MODEL_IDS = new Set((agent.models || []).map((m) => m.id));
  const EFFORTS = new Set(agent.efforts || []);
  const next = { ...current };
  if ('model' in changes) {
    if (changes.model !== null && !MODEL_IDS.has(changes.model)) throw new HttpError(400, `unknown model "${changes.model}"`);
    next.model = changes.model;
  }
  if ('effort' in changes) {
    if (changes.effort !== null && !EFFORTS.has(changes.effort)) throw new HttpError(400, `unknown effort "${changes.effort}"`);
    next.effort = changes.effort;
  }
  const model = agent.models?.find((m) => m.id === (next.model || agent.defaultModel));
  if (next.effort && model?.efforts && !model.efforts.includes(next.effort)) {
    if ('effort' in changes) throw new HttpError(400, 'effort is not supported by this model');
    next.effort = null;
  }
  return next;
}

// Until a process reports the exact model, the list shows the choice ('' = default).
const modelChoiceLabel = (agent, id) => (agent.models || []).find((m) => m.id === id)?.label || '';

async function changeSettings(chat, changes) {
  const agent = provider(chat).adapter;
  if (agent.discover && !agent.models.length) await (discovering || discoverAgents());
  const before = { model: null, effort: null, ...chat.meta.settings };
  const settings = checkSettings(agent, before, changes);
  if (settings.model === before.model && settings.effort === before.effort) return;
  chat.meta.settings = settings;
  if (settings.model !== before.model) Object.assign(chat.meta, { model: null, modelLabel: modelChoiceLabel(agent, settings.model) });
  // A process keeps the flags it started with: replace it now if it's idle,
  // after the turn otherwise.
  if (chat.status === 'running') chat.restart = true;
  else retire(chat);
  await saveMeta(chat);
}

function markRead(chat) {
  if ((chat.meta.doneAt || 0) <= (chat.meta.readAt || 0)) return;
  chat.meta.readAt = Date.now();
  saveMeta(chat).catch(() => {});
  broadcastList();
}

// --------------------------------------------------------------- process

function ensureProcess(chat) {
  clearTimeout(chat.idleTimer);
  if (chat.proc) return chat.proc;
  const { adapter: agent, options } = provider(chat);
  const systemPrompt = options.appendSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const { model, effort } = chat.meta.settings || {};
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  const env = { MOTHERSHIP_URL: `http://${host}:${config.port}`, MOTHERSHIP_KEY: chat.key };
  const mcpServers = agentTools().length ? [{ name: 'mothership', command: process.execPath, args: [BRIDGE], env }] : [];
  const proc = startAgent(agent, {
    sessionId: chat.meta.sessionId, systemPrompt, model, effort, mcpServers,
    cwd: chat.meta.dir || expandHome(options.cwd),
    onEvent(ev) {
      if (chat.proc !== proc) return;
      chat.events = chat.events.then(() => onAgentEvent(chat, ev)).catch((err) => console.error('chat: event', err));
    },
    onExit: (error, code) => onExit(chat, proc, error, code),
  });
  chat.proc = proc;
  return proc;
}

function onExit(chat, proc, error, code) {
  if (chat.proc !== proc) return;
  chat.proc = null;
  clearTimeout(chat.interruptTimer);
  // Queue behind events still being handled, so the last result lands first.
  chat.events = chat.events.then(() => {
    if (chat.status !== 'running' || chat.proc) return;
    if (chat.interrupting) {
      append(chat, { t: 'result', ok: false, interrupted: true });
    } else {
      const detail = error || chat.stderr.trim().split('\n').slice(-6).join('\n') || `exit code ${code}`;
      append(chat, { t: 'system', level: 'error', text: `The agent exited unexpectedly: ${detail}` });
    }
    endTurn(chat);
  });
}

// Lets an idle process go; the next message starts a new one that resumes
// the session (with the chat's current settings).
function retire(chat) {
  const proc = chat.proc;
  if (!proc) return;
  clearTimeout(chat.idleTimer);
  chat.proc = null; // its exit is no longer this chat's business (see onExit)
  proc.stop();
}

function armIdle(chat) {
  clearTimeout(chat.idleTimer);
  const { idleMinutes } = provider(chat).options;
  if (!chat.proc || !idleMinutes) return;
  chat.idleTimer = setTimeout(() => {
    if (chat.status === 'idle') retire(chat); // the session resumes on the next message
  }, idleMinutes * 60_000);
}

// ------------------------------------------------------------------ turns

// Plain text for a notification: no code blocks or Markdown marks, one line.
function previewOf(text) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#+|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/`|\*\*|__|\|/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function titleFrom(text, attachments) {
  const line = text.split('\n').find((l) => l.trim())?.trim();
  if (line) return line.length > 60 ? `${line.slice(0, 57)}…` : line;
  return attachments[0]?.name || 'New chat';
}

async function sendMessage(chat, { text, attachments }) {
  const message = { id: shortId(), text: String(text || '').trim(), attachments: await resolveAttachments(attachments) };
  if (!message.text && !message.attachments.length) throw new HttpError(400, 'empty message');
  if (!chat.meta.title && !isClear(message)) {
    chat.meta.title = titleFrom(message.text, message.attachments);
    await saveMeta(chat);
  }
  if (chat.status === 'running' || chat.clearing) {
    chat.queue.push(message);
    emitStatus(chat);
    return;
  }
  await dispatch(chat, message);
}

const isClear = (message) => message.text === CLEAR && !message.attachments.length;

async function dispatch(chat, message) {
  if (isClear(message)) return clearChat(chat); // in its place in the queue, like a message
  const attachments = message.attachments.map(({ name, url, mediaType, path: p }) => ({ name, url, mediaType, path: p }));
  append(chat, { t: 'user', text: message.text, attachments });
  chat.turn = { text: message.text, sent: new Set() };
  chat.meta.preview = '';
  setStatus(chat, 'running');

  const images = [];
  try {
    for (const a of message.attachments) {
      if (AGENT_IMAGE_TYPES.has(a.mediaType)) images.push({ mediaType: a.mediaType, data: (await fsp.readFile(a.path)).toString('base64') });
    }
  } catch (err) {
    append(chat, { t: 'system', level: 'error', text: `Couldn't read an attachment: ${err.message}` });
    return endTurn(chat);
  }
  // Every attachment's path goes along too, so the agent can open, copy or edit it.
  const notes = message.attachments.map((a) => `[Attachment: ${a.path}]`).join('\n');
  const text = [message.text, notes].filter(Boolean).join('\n\n');
  if (chat.interrupting || chat.deleted) return endTurn(chat);
  let proc;
  try {
    proc = ensureProcess(chat);
    // Initialization may be asynchronous; keep the socket free for Stop.
    Promise.resolve(proc.send({ text, images })).catch((err) => failTurn(chat, proc, err));
  } catch (err) { failTurn(chat, proc, err); }
}

function failTurn(chat, proc, err) {
  proc ??= null;
  if (chat.proc !== proc || chat.status !== 'running') return;
  chat.events = chat.events.then(() => {
    if (chat.proc !== proc || chat.status !== 'running') return;
    append(chat, { t: 'result', ok: false, interrupted: chat.interrupting, error: chat.interrupting ? null : err.message });
    retire(chat);
    endTurn(chat);
  });
}

function interrupt(chat) {
  chat.queue = [];
  if (chat.status === 'running') {
    chat.interrupting = true;
    const proc = chat.proc;
    if (proc) Promise.resolve(proc.interrupt()).catch((err) => failTurn(chat, proc, err));
    // If the turn doesn't wind down, stop the process; the session resumes later.
    clearTimeout(chat.interruptTimer);
    chat.interruptTimer = setTimeout(() => {
      if (chat.status === 'running') chat.proc?.kill('SIGTERM');
    }, 5000);
  }
  emitStatus(chat);
}

function endTurn(chat) {
  clearTimeout(chat.interruptTimer);
  chat.turn = null;
  refreshDir(chat);
  chat.interrupting = false;
  chat.drafts.clear();
  chat.meta.doneAt = Date.now();
  if (chat.seen) chat.meta.readAt = chat.meta.doneAt;
  if (chat.restart) {
    chat.restart = false;
    retire(chat);
  }
  setStatus(chat, 'idle');
  saveMeta(chat).catch(() => {});
  dispatchNext(chat);
}

function dispatchNext(chat) {
  const next = chat.queue.shift();
  if (next) dispatch(chat, next).catch((err) => console.error('chat: send', err));
  else armIdle(chat);
}

// --------------------------------------------------------- agent events

const clip = (s) => (s.length > MAX_RESULT_TEXT ? `${s.slice(0, MAX_RESULT_TEXT)}\n… (${s.length - MAX_RESULT_TEXT} characters omitted)` : s);

async function onAgentEvent(chat, ev) {
  switch (ev.kind) {
    case 'cwd':
      chat.meta.cwd = ev.cwd;
      await saveMeta(chat);
      return broadcastList();
    case 'session':
      if (ev.sessionId !== chat.meta.sessionId || ev.model !== chat.meta.model || ev.modelLabel !== chat.meta.modelLabel) {
        Object.assign(chat.meta, { sessionId: ev.sessionId, model: ev.model, modelLabel: ev.modelLabel });
        await saveMeta(chat);
        broadcastList();
      }
      refreshDir(chat);
      return;

    case 'draft-start': {
      const draft = { msg: ev.msg, index: ev.index, kind: ev.block, name: ev.name, text: '', parent: ev.parent };
      chat.drafts.set(`${ev.msg}:${ev.index}`, draft);
      return emit(chat, { op: 'live', ev: { t: 'start', ...draft } });
    }

    case 'draft-delta': {
      const draft = chat.drafts.get(`${ev.msg}:${ev.index}`);
      if (draft) draft.text += ev.text;
      return emit(chat, { op: 'live', ev: { t: 'delta', msg: ev.msg, index: ev.index, text: ev.text } });
    }

    case 'block':
      chat.drafts.delete(`${ev.msg}:${ev.index}`);
      if (ev.block?.type === 'text' && !ev.parent) chat.meta.preview = previewOf(ev.block.text);
      if (ev.block) append(chat, { t: 'block', msg: ev.msg, index: ev.index, block: ev.block, parent: ev.parent });
      else emit(chat, { op: 'live', ev: { t: 'drop', msg: ev.msg, index: ev.index } });
      return;

    case 'tool-result': {
      const content = [];
      for (const c of ev.content) {
        if (c.type === 'text') content.push({ type: 'text', text: clip(c.text) });
        else if (c.type === 'image' && c.data) content.push(await saveImage(c.data, c.mediaType));
        else content.push({ type: c.type });
      }
      append(chat, { t: 'tool_result', toolUseId: ev.toolUseId, isError: ev.isError, content, parent: ev.parent });
      refreshDir(chat); // a command may have moved it
      return;
    }

    case 'context':
      chat.meta.context = { used: ev.used, window: ev.window };
      return broadcastList();

    case 'limits':
      limits[chat.meta.agent] = { status: ev.status, windows: ev.windows, updated: Date.now() };
      limitWrites = limitWrites.then(() => fsp.writeFile(LIMITS_FILE, JSON.stringify(limits))).catch(() => {});
      for (const ws of sockets) send(ws, { op: 'limits', limits: limits[chat.meta.agent], agent: chat.meta.agent });
      return;

    case 'notice':
      append(chat, { t: 'system', level: ev.level, text: ev.text });
      return;

    case 'result': {
      const interrupted = chat.interrupting || ev.aborted;
      append(chat, { t: 'result', ok: ev.ok, interrupted, error: interrupted ? null : ev.error, durationMs: ev.durationMs, turns: ev.turns });
      return endTurn(chat);
    }
  }
}

// -------------------------------------------------------------- broadcast

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function emit(chat, msg) {
  const data = { ...msg, chatId: chat.meta.id };
  for (const ws of chat.watchers) send(ws, data);
}

const queueView = (chat) => chat.queue.map(({ id, text, attachments }) => ({ id, text, attachments: attachments.map(({ name, url, mediaType }) => ({ name, url, mediaType })) }));

function emitStatus(chat) {
  emit(chat, { op: 'status', status: chat.status, queue: queueView(chat) });
  broadcastList();
}

function setStatus(chat, status) {
  chat.status = status;
  emitStatus(chat);
}

// Pinned chats first, in their pinned order (meta.pinned, 1-based); then the
// newest conversation first, by creation — a stable order, so ⌘1…⌘9 keep
// pointing at the same chats while they're in use.
const listChats = () =>
  [...chats.values()]
    .map((c) => c.summary())
    .sort((a, b) => (a.pinned ?? Infinity) - (b.pinned ?? Infinity) || b.created - a.created);

// The whole pinned list at once, in order (the sidebar sends it after a drag,
// a pin or an unpin); every chat not in it is unpinned.
async function setPinned(ids) {
  if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be a list');
  const order = [...new Set(ids)].filter((id) => chats.has(id) && !chats.get(id).meta.archived); // archived: out of the list, out of Pinned
  for (const chat of chats.values()) {
    const pinned = order.indexOf(chat.meta.id) + 1 || undefined;
    if (pinned === chat.meta.pinned) continue;
    chat.meta.pinned = pinned;
    await saveMeta(chat);
  }
  broadcastList();
}

// Archived (meta.archived: since when): out of the sidebar's list and never
// unread, so it raises no notice, badge or notification on any device — even
// while it's still written in; only Unarchive brings it back. It leaves
// Pinned; back in the list, what it said meanwhile counts as read.
async function setArchived(chat, archived) {
  if (Boolean(chat.meta.archived) === archived) return;
  if (archived) {
    chat.meta.archived = Date.now();
    if (chat.meta.pinned) await setPinned(listChats().filter((c) => c.pinned && c.id !== chat.meta.id).map((c) => c.id));
  } else {
    delete chat.meta.archived;
    chat.meta.readAt = Math.max(chat.meta.readAt || 0, chat.meta.doneAt || 0);
  }
  await saveMeta(chat);
}

let listTimer = null;
function broadcastList() {
  // Coalesce bursts (a turn touches the list several times).
  if (listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    const msg = { op: 'chats', chats: listChats(), nextHue };
    for (const ws of sockets) send(ws, msg);
  }, 50);
}

// ---------------------------------------------------------------- sockets

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

export function handleChatUpgrade(req, socket, head) {
  wss.handleUpgrade(req, socket, head, onSocket);
}

// Phones vanish without closing their sockets; ping to find out.
setInterval(() => {
  for (const ws of sockets) {
    if (!ws.alive) ws.terminate();
    else {
      ws.alive = false;
      ws.ping();
    }
  }
}, 30_000).unref();

function watch(ws, chat) {
  ws.chat?.watchers.delete(ws);
  ws.chat = chat;
  chat?.watchers.add(ws);
}

function sendAgentChoices(ws) {
  send(ws, { op: 'agent', default: AGENT.type, home: HOME, agents: Object.entries(agents).map(([id, { adapter, options }]) => ({
    id, name: adapter.name, icon: adapter.icon || null, models: adapter.models || [], efforts: adapter.efforts || [], defaultModel: adapter.defaultModel || options.model || null,
    cwd: expandHome(options.cwd),
  })) });
}

let discovering;
let discoveredAt = 0;
function discoverAgents() {
  if (discovering || Date.now() - discoveredAt < 60_000) return;
  discovering = Promise.all(Object.values(agents).map(async ({ adapter }) => {
    if (!adapter.discover) return;
    try { await adapter.discover(); } catch (err) { console.error(`chat: model discovery: ${err.message}`); }
  })).finally(() => {
    discovering = null;
    discoveredAt = Date.now();
    for (const socket of sockets) sendAgentChoices(socket);
  });
  return discovering;
}

function onSocket(ws) {
  sockets.add(ws);
  ws.alive = true;
  ws.chat = null;
  ws.visible = false; // the page tells (op 'visibility'); only visible pages mark chats read
  ws.on('pong', () => (ws.alive = true));
  ws.on('close', () => {
    sockets.delete(ws);
    watch(ws, null);
  });
  // One message at a time per socket, so e.g. a "stop" right after "send"
  // can't overtake it.
  let pending = Promise.resolve();
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    pending = pending.then(() =>
      onSocketMessage(ws, msg).catch((err) => {
        if (!(err instanceof HttpError)) console.error('chat: socket', err);
        send(ws, { op: 'error', ref: msg.ref, chatId: msg.chatId, error: err.message });
      }),
    );
  });
  // cwd: where a new chat's agent starts; home: so the page can show paths as ~/…
  sendAgentChoices(ws);
  discoverAgents();
  send(ws, { op: 'chats', chats: listChats(), nextHue });
  for (const [agent, value] of Object.entries(limits)) send(ws, { op: 'limits', agent, limits: value });
}

async function onSocketMessage(ws, msg) {
  switch (msg.op) {
    case 'open': {
      if (!msg.chatId) return watch(ws, null);
      const chat = getChat(msg.chatId);
      watch(ws, chat);
      if (ws.visible) markRead(chat);
      refreshDir(chat); // its folder may be gone since (a removed worktree)
      const page = await historyPage(chat);
      send(ws, { op: 'history', chatId: chat.meta.id, ...page, drafts: [...chat.drafts.values()], status: chat.status, queue: queueView(chat) });
      return;
    }
    // The page before `before`, the oldest item the page has.
    case 'older': {
      const chat = getChat(msg.chatId);
      if (typeof msg.before !== 'string') throw new HttpError(400, 'missing "before"');
      send(ws, { op: 'older', chatId: chat.meta.id, before: msg.before, ...(await historyPage(chat, msg.before)) });
      return;
    }
    case 'send': {
      let chat;
      if (msg.chatId) chat = getChat(msg.chatId);
      else {
        // First message of a new conversation creates it (with the settings and folder picked for it).
        chat = await createChat(msg.settings, msg.dir, msg.agent);
        watch(ws, chat);
        send(ws, { op: 'created', ref: msg.ref, chatId: chat.meta.id });
      }
      await sendMessage(chat, msg);
      broadcastList();
      send(ws, { op: 'ack', ref: msg.ref, chatId: chat.meta.id });
      return;
    }
    case 'interrupt':
      return interrupt(getChat(msg.chatId));
    case 'visibility':
      ws.visible = Boolean(msg.visible);
      if (ws.visible && ws.chat) markRead(ws.chat);
      return;
    case 'unqueue': {
      const chat = getChat(msg.chatId);
      chat.queue = chat.queue.filter((m) => m.id !== msg.id);
      return emitStatus(chat);
    }
  }
}

// ------------------------------------------------------------ agent tools

// The server's own tools, offered to every chat's agent while they're usable.
const agentTools = () => (slackConnected() ? slackTools : []);

// A process keeps the tools it started with: connecting or disconnecting
// Slack replaces them (after the turn, if one is running).
onSlackChange(() => {
  for (const chat of chats.values()) {
    if (chat.status === 'running') chat.restart = true;
    else retire(chat);
  }
});

// The bridge's calls (lib/mcp-bridge.js): { key } lists the tools, { key,
// call: { name, args } } runs one for that chat. Only from this Mac's own
// processes, and only with a live chat's key.
async function agentToolsApi(req) {
  if (!fromLocalProcess(req)) throw new HttpError(403, 'only for the agents on this Mac');
  const { key, call } = await readJson(req);
  const chat = typeof key === 'string' && [...chats.values()].find((c) => c.key === key);
  if (!chat) throw new HttpError(403, 'unknown chat');
  if (!call) return { tools: agentTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  if (!agentTools().some((t) => t.name === call.name)) return { content: [{ type: 'text', text: `${call.name} isn't available now` }], isError: true };
  return runSlackTool(call.name, call.args, chat.turn, chat.meta.id);
}

// ------------------------------------------------------------------- REST

// Returns false when the path isn't a chat route.
export async function handleChatApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const reply = (status, body) => {
    sendJson(res, status, body);
    return true;
  };

  if (pathname === '/api/chats' && method === 'GET') return reply(200, listChats());
  // { ids }: the pinned chats, in order
  if (pathname === '/api/chats/pinned' && method === 'PUT') {
    await setPinned((await readJson(req)).ids);
    return reply(200, listChats());
  }
  const one = pathname.match(/^\/api\/chats\/([a-f0-9]{12})$/);
  // { title } and/or { model, effort }
  if (one && method === 'PATCH') {
    const chat = getChat(one[1]);
    const body = await readJson(req);
    if ('agent' in body && body.agent !== chat.meta.agent) throw new HttpError(400, 'Choose the agent in a new chat');
    if ('title' in body) {
      const title = String(body.title || '').trim().slice(0, 120);
      if (!title) throw new HttpError(400, 'empty title');
      chat.meta.title = title;
    }
    if ('archived' in body) await setArchived(chat, Boolean(body.archived));
    if ('model' in body || 'effort' in body) await changeSettings(chat, { ...('model' in body && { model: body.model }), ...('effort' in body && { effort: body.effort }) });
    await saveMeta(chat);
    broadcastList();
    return reply(200, chat.summary());
  }
  if (one && method === 'DELETE') {
    await deleteChat(getChat(one[1]));
    return reply(200, { ok: true });
  }
  if (pathname === '/api/uploads' && method === 'POST') return reply(201, await saveUpload(req, url));
  if (pathname === '/api/agent/tools' && method === 'POST') return reply(200, await agentToolsApi(req));
  if (pathname === '/api/local-image' && method === 'GET') {
    await serveLocalImage(res, url);
    return true;
  }
  return false;
}

// Children would otherwise outlive a restart of the server.
export function stopChats() {
  for (const chat of chats.values()) chat.proc?.kill();
}

// Turned off from the panel: running turns end as interrupted (sessions resume
// on the next message), and every page is disconnected — it finds the
// "Turned off" screen when it tries to reconnect.
export function pauseChats() {
  for (const chat of chats.values()) {
    chat.queue = [];
    if (chat.status === 'running') chat.interrupting = true;
    chat.proc?.kill();
  }
  for (const ws of sockets) ws.close(1001, 'turned off');
}

