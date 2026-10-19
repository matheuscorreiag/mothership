// Chat UI: chat list, one open chat, composer, usage, shortcuts. Talks to the
// server over a single WebSocket (/ws/chat); rendering lives in render.js and
// the "working" indicator in loader.js. Nothing here depends on which agent
// runs behind the server.

import { Thread, toolName } from '/render.js';
import { createLoader } from '/loader.js';
import { $, h, touch, narrow, isMac, MOD, standalone, native, appKey, isAppKey, itemKey, itemNumber, ask, api, storage, toast, fail, place, copyRow, hidePopovers, showMenu, editInline, setupSidebar, setupPinning, setConn, accentFor, setHue, indexLabel, MORE_ICON, ago } from '/ui.js';

const randomId = () => Math.random().toString(36).slice(2, 10);
const local = storage('chat'); // last chat, unsent drafts, settings for new chats

const thread = new Thread($('#thread'));
const input = $('#input');
const messages = $('#messages');

const state = {
  chats: [], // pinned first, then newest first, stable: ⌘1…⌘9 follow this order
  view: 'chat', // chat | settings
  chatId: null, // null = a new chat, created by its first message
  nextHue: null, // accent the next new chat will get
  status: 'idle',
  queue: [],
  limits: {}, // { status, windows: [{ id, label, utilization, resetsAt }], updated }
  phase: {}, // what the working indicator shows: { phase, label, moment }
  opening: null, // { chatId, buffer } until the history arrives
  attachments: [], // { id, name, mediaType, preview, uploading, file, url }
  sends: new Map(), // ref -> what was sent, to restore it on error
  editing: false, // a title is being renamed inline: hold list re-renders
  agents: [],
  defaultAgent: null,
  home: null,
  editors: [], // [{ id, name }]: code editors that can open the chat's folder (a browser on this Mac only)
  newAgent: local.get('newAgent', null), // per-chat choices the agent offers, where it starts
  newSettings: { model: null, effort: null, ...local.get('newSettings', {}) }, // for the next new chat
  newDir: null, // where the next new chat starts (a terminal's "New chat in this folder"); null = the agent's folder
  listed: false, // the first list arrived (later unread changes are news)
  showArchived: false, // the sidebar shows the archived chats instead of the list
  off: false, // turned off from here: stop reconnecting
};
let loader = null;

// ------------------------------------------------------------------ utils

const hhmm = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function resetsIn(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60000));
  const rel = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
  const sameDay = d.toDateString() === new Date().toDateString();
  const when = sameDay ? hhmm(d) : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm(d)}`;
  return `resets in ${rel} (${when})`;
}

function tokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const level = (pct) => (pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '');

// ---------------------------------------------------------------- accents

// Every chat has its own hue (picked by the server); it tints the whole
// page. The New chat button previews the next one.
function applyAccent() {
  setHue(state.chatId ? current()?.hue : state.nextHue);
  term.view?.setHue(state.chatId ? current()?.hue : state.nextHue); // its terminal follows
  $('#new-chat').style.setProperty('--swatch', accentFor(state.nextHue));
}

// Inline rename (ui.js) with the list held still while the field is open.
function renameInline(el, chat) {
  editInline(el, chat?.title || '', (t) => (t ? renameChat(chat.id, t) : Promise.resolve()), {
    onStart: () => (state.editing = true),
    onEnd: () => {
      state.editing = false;
      renderList();
      renderHeader();
    },
  });
}

// ------------------------------------------------------------- connection

let ws = null;
let retries = 0;
let retryTimer = null;

function connect() {
  clearTimeout(retryTimer);
  if (state.off) return;
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat`);
  ws = socket;
  setConn('connecting');
  socket.onopen = () => {
    retries = 0;
    setConn('online');
    sendVisibility(); // before "open": a visible page marks the chat read
    openChat(state.chatId); // (re)load what's on screen
  };
  socket.onmessage = (e) => onMessage(JSON.parse(e.data));
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setConn('offline');
    retryTimer = setTimeout(connect, Math.min(8000, 400 * 2 ** retries++));
    checkPower(); // closed because it was turned off?
  };
}

function wsSend(msg) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

// Phones drop sockets while asleep; reconnect as soon as the page is back.
// The server also needs to know: chats only count as read on a visible page.
const sendVisibility = () => wsSend({ op: 'visibility', visible: !document.hidden });
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('away', document.hidden); // holds the notice's countdown
  if (!document.hidden) term.view?.wake();
  if (!document.hidden && state.off) checkPower();
  else if (!document.hidden && ws?.readyState !== WebSocket.OPEN) {
    retries = 0;
    connect();
  } else sendVisibility();
});

function onMessage(m) {
  const here = m.chatId && m.chatId === state.chatId;
  switch (m.op) {
    case 'agent':
      state.defaultAgent = m.default || 'claude';
      state.home = m.home || null;
      state.agents = m.agents || [{ id: 'claude', name: 'Claude Code', models: m.models || [], efforts: m.efforts || [], cwd: m.cwd }];
      if (!state.agents.some((a) => a.id === state.newAgent)) state.newAgent = state.defaultAgent;
      renderList(); // the logos
      renderStats();
      renderDir();
      break;

    case 'chats': {
      const before = new Map(state.chats.map((c) => [c.id, c]));
      state.chats = m.chats;
      state.nextHue = m.nextHue;
      if (before.get(state.chatId)?.archived && !current()?.archived) state.showArchived = false; // back in the list: show it there
      if (state.listed) for (const c of m.chats) if (c.unread && !before.get(c.id)?.unread) notify(c);
      state.listed = true;
      renderList();
      renderHeader();
      break;
    }

    case 'limits':
      state.limits[m.agent || state.defaultAgent] = m.limits;
      renderHeader();
      break;

    // The open chat's last page; older ones come as it scrolls up.
    case 'history': {
      if (!here) return;
      const buffered = state.opening?.buffer || [];
      state.opening = null;
      thread.reset();
      thread.numberFrom(m.items, m.turnsBefore || 0);
      for (const item of [...m.items, ...buffered]) thread.add(item);
      remember([...(m.prompts || []).map((text) => ({ t: 'user', text })), ...m.items, ...buffered]);
      for (const draft of m.drafts) thread.live({ t: 'start', ...draft });
      applyStatus(m.status, m.queue);
      scrollToBottom();
      setPages(m.items[0]?.id, m.more);
      break;
    }

    case 'older': {
      if (!here || m.before !== pages.oldest) return; // another chat, or cleared since
      holdAnchor();
      thread.prepend(m.items, m.turnsBefore);
      followAnchor();
      setPages(m.items[0]?.id ?? pages.oldest, m.more);
      break;
    }

    // /clear: the conversation starts over on every device showing it.
    case 'cleared':
      if (!here) return;
      if (state.opening) state.opening.buffer = [];
      thread.reset();
      forgetRecent();
      setPages(null, false);
      break;

    case 'created':
      // Our first message made a new chat: it's the one on screen now.
      if (!state.sends.has(m.ref)) return;
      state.chatId = m.chatId;
      state.newDir = null;
      local.set('last', m.chatId);
      history.replaceState(null, '', `#${m.chatId}`);
      moveDraft('new', m.chatId);
      adoptTerm(m.chatId);
      renderHeader();
      renderList();
      break;

    case 'item':
      if (!here) return;
      if (state.opening) return state.opening.buffer.push(m.item);
      thread.add(m.item);
      itemPhase(m.item);
      remember([m.item]);
      break;

    case 'live':
      if (!here || state.opening) return;
      thread.live(m.ev);
      livePhase(m.ev);
      break;

    case 'status':
      if (here) applyStatus(m.status, m.queue);
      break;

    case 'ack':
      state.sends.delete(m.ref);
      break;

    case 'error': {
      const sent = state.sends.get(m.ref);
      state.sends.delete(m.ref);
      if (sent && !input.value && !state.attachments.length) {
        input.value = sent.text;
        state.attachments = sent.attachments;
        renderAttachments();
        autosize();
      }
      if (state.opening && m.chatId === state.opening.chatId) {
        state.opening = null;
        go(null); // that chat is gone
      }
      fail(m.error);
      break;
    }

    case 'deleted':
      if (here) go(null);
      break;
  }
}

// ----------------------------------------------------------------- chats

// Routes: #<chatId> (or empty for a new chat), #settings and its pages
// #settings/<page>.
// The settings pages: their title and the page their back button goes to ('' is
// the list itself, which goes back to the chat).
const SETTINGS = {
  '': { title: 'Settings' },
  shortcuts: { title: 'Shortcuts', up: '' },
  integrations: { title: 'Integrations', up: '' },
  'integrations/slack': { title: 'Slack', up: 'integrations' },
};
function route() {
  const hash = location.hash.slice(1);
  if (hash === 'settings' || hash.startsWith('settings/')) {
    const page = hash.slice('settings/'.length);
    return { view: 'settings', page: SETTINGS[page] ? page : '' };
  }
  return { view: 'chat', chatId: hash || null };
}
const hashId = () => route().chatId ?? null;

function go(id) {
  id = id || null;
  if (state.view === 'chat' && id === state.chatId && hashId() === id) return; // already open
  if (route().view === 'chat' && hashId() === id) applyRoute();
  else location.hash = id || '';
}

function applyRoute() {
  const r = route();
  if (r.view !== 'chat') return setView(r.view);
  // Back from Settings to the chat that's still loaded behind it.
  if (state.view !== 'chat' && r.chatId === state.chatId) return setView('chat');
  setView('chat');
  openChat(r.chatId);
}
window.addEventListener('hashchange', applyRoute);

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  $('#open-settings').classList.toggle('active', view === 'settings');
  if (view === 'settings') showSettings(route().page);
  hidePopovers();
  renderHeader();
  renderList();
  if (narrow()) setDrawer(false);
}

function openChat(id) {
  const changed = id !== state.chatId;
  if (changed) forgetRecent();
  state.chatId = id || null;
  if (state.chatId) state.newDir = null;
  if (!current()?.archived) state.showArchived = false; // the list it's in
  local.set('last', state.chatId);
  thread.reset();
  setPages(null, false);
  applyStatus('idle', []);
  hidePopovers();
  $('#welcome').hidden = Boolean(state.chatId);
  if (!state.chatId) scrollToBottom();
  if (changed) restoreDraft();
  renderHeader();
  renderList();
  syncTerm();
  state.opening = state.chatId ? { chatId: state.chatId, buffer: [] } : null;
  wsSend({ op: 'open', chatId: state.chatId });
  if (narrow()) setDrawer(false);
}

function newChat() {
  state.newDir = null;
  renderDir();
  go(null);
  if (!touch) input.focus();
}

function focusInput() {
  // From another screen, the composer only shows once the chat view is back (on hashchange).
  if (state.view !== 'chat') {
    addEventListener('hashchange', focusInput, { once: true });
    return go(state.chatId);
  }
  hidePopovers();
  if (narrow()) setDrawer(false);
  input.focus();
}

const current = () => state.chats.find((c) => c.id === state.chatId);

const renameChat = (id, title) => api('PATCH', `/api/chats/${id}`, { title });

async function deleteChat(chat) {
  const sure = await ask({
    title: 'Delete this chat?',
    text: `"${chat.title || 'New chat'}" and its history are removed from the app.`,
    confirm: 'Delete',
    danger: true,
  });
  if (!sure) return;
  await api('DELETE', `/api/chats/${chat.id}`)
    .then(() => chat.id === state.chatId && go(null))
    .catch(fail);
}

// Archived: out of the list, its numbers and every notice (the server stops
// counting it unread); the open chat makes way, as when it's deleted.
const archiveChat = (chat, archived) =>
  api('PATCH', `/api/chats/${chat.id}`, { archived })
    .then(() => archived && chat.id === state.chatId && go(null))
    .catch(fail);

// Without the mouse (⇧⌘E): the same rename as double-clicking it in the sidebar.
async function renameWithDialog(chat) {
  const title = await ask({ title: 'Rename chat', value: chat.title || '', confirm: 'Rename' });
  if (title && title !== chat.title) await renameChat(chat.id, title).catch(fail);
}

// Pinned chats (meta.pinned, their place from 1) come first in the list, in
// the server's order — mirrored here so a drop shows at once.
const isPinned = (c) => c.pinned != null;
// The sidebar's list (and ⌘1–9) leaves the archived chats out; they have their own, behind Archived.
const listed = () => state.chats.filter((c) => !c.archived);
const archivedChats = () => state.chats.filter((c) => c.archived);
const shown = () => (state.showArchived ? archivedChats() : listed()); // what the sidebar lists now: ⌘1–9 open those
const byPlace = (a, b) => (a.pinned ?? Infinity) - (b.pinned ?? Infinity) || b.created - a.created;

// index: its place among the pinned chats; null unpins it.
function movePin(id, index) {
  const before = state.chats.filter(isPinned).map((c) => c.id);
  const ids = before.filter((x) => x !== id);
  if (index != null) ids.splice(index, 0, id);
  if (ids.join() === before.join()) return;
  state.chats = state.chats.map((c) => ({ ...c, pinned: ids.indexOf(c.id) + 1 || undefined })).sort(byPlace);
  renderList();
  // The server broadcasts the new list; if it refused, put the old one back.
  api('PUT', '/api/chats/pinned', { ids }).catch(async (err) => {
    fail(err);
    state.chats = await api('GET', '/api/chats').catch(() => state.chats);
    renderList();
  });
}
const togglePin = (chat) => movePin(chat.id, isPinned(chat) ? null : state.chats.filter(isPinned).length);

// Items are kept and updated in place (keyed by id): rebuilding them would
// break double-click-to-rename and lose focus while the list refreshes.
const listItems = new Map(); // chat id -> { el, avatar, name, sub, kbd }

function listItem(c) {
  const avatar = h('span', { class: 'avatar', 'aria-hidden': 'true' });
  const name = h('span', { class: 'name' });
  const sub = h('span', { class: 'sub' });
  const kbd = h('kbd', { class: 'kbd' });
  const rename = () => renameInline(name, state.chats.find((x) => x.id === c.id) || c);
  const more = h('button', {
    type: 'button',
    class: 'more',
    innerHTML: MORE_ICON,
    'aria-label': 'Chat options',
    onclick: (e) => {
      e.stopPropagation();
      const chat = state.chats.find((x) => x.id === c.id) || c;
      showMenu(more, [
        chat.archived ? null : { label: isPinned(chat) ? 'Unpin' : 'Pin', run: () => togglePin(chat) },
        { label: 'Rename', run: rename },
        { label: chat.archived ? 'Unarchive' : 'Archive', run: () => archiveChat(chat, !chat.archived) },
        { label: 'Delete', danger: true, run: () => deleteChat(chat) },
      ]);
    },
  });
  const el = h(
    'div',
    {
      class: 'side-item',
      dataset: { id: c.id },
      role: 'button',
      tabIndex: 0,
      onclick: () => go(c.id),
      ondblclick: (e) => {
        e.preventDefault();
        rename();
      },
      onkeydown: (e) => e.key === 'Enter' && e.target === e.currentTarget && go(c.id),
    },
    avatar,
    h('span', { class: 'text' }, name, sub),
    h('span', { class: 'side' }, h('span', { class: 'unread-dot', title: 'New reply' }), kbd, more),
  );
  return { el, avatar, name, sub, kbd };
}

function renderList() {
  if (state.editing || pinning.dragging) return; // would clobber the rename field / the drag
  const nav = $('#chat-list');
  const ids = new Set(state.chats.map((c) => c.id));
  for (const [id, item] of listItems) {
    if (!ids.has(id)) {
      item.el.remove();
      listItems.delete(id);
    }
  }
  const chats = listed();
  const archived = archivedChats();
  if (!archived.length) state.showArchived = false;
  [...chats, ...archived].forEach((c) => {
    let item = listItems.get(c.id);
    if (!item) listItems.set(c.id, (item = listItem(c)));
    const i = c.archived ? archived.indexOf(c) : chats.indexOf(c);
    const keyed = Boolean(c.archived) === state.showArchived && i < 9; // ⌘1–9: the first nine of what's shown
    const name = c.title || 'New chat';
    const busy = c.status === 'running';
    item.el.classList.toggle('active', state.view === 'chat' && c.id === state.chatId);
    item.el.style.setProperty('--item-accent', accentFor(c.hue));
    item.el.title = keyed ? `${name}  (${itemKey(i + 1)})` : name;
    item.avatar.textContent = indexLabel(i);
    item.avatar.classList.toggle('busy', busy);
    item.name.textContent = name;
    const when = ago(c.updated) === 'now' ? 'just now' : `${ago(c.updated)} ago`;
    item.sub.replaceChildren(
      ...[agentMark(c.agent)].filter(Boolean),
      busy ? (c.queued ? `working · ${c.queued} queued` : 'working…') : c.unread ? `replied ${when}` : when,
    );
    item.sub.classList.toggle('busy', busy || c.unread);
    item.el.classList.toggle('unread', c.unread && !busy);
    item.kbd.textContent = keyed ? itemKey(i + 1) : '';
    item.kbd.hidden = !keyed;
    (c.archived ? $('#archived-list') : isPinned(c) ? pinning.nav : nav).append(item.el); // moves existing nodes into order
  });
  const pinned = chats.filter(isPinned).length;
  pinning.update(state.showArchived ? 0 : pinned);
  $('#chat-count').textContent = chats.length > pinned ? indexLabel(chats.length - pinned - 1) : '';
  let empty = nav.querySelector('.side-list-empty');
  if (!chats.length && !empty) nav.append((empty = h('div', { class: 'side-list-empty', textContent: 'No chats yet.' })));
  if (chats.length) empty?.remove();
  // Archived (the foot's button, while there are any): in the list's place.
  const showing = state.showArchived;
  $('#chats-label').hidden = nav.hidden = showing;
  $('#archived-label').hidden = $('#archived-list').hidden = !showing;
  $('#archived-count').textContent = archived.length ? indexLabel(archived.length - 1) : '';
  const button = $('#show-archived');
  button.hidden = !archived.length;
  button.classList.toggle('active', showing);
  button.setAttribute('aria-pressed', String(showing));
  renderUnread();
}

const pinning = setupPinning({ list: $('#chat-list'), onDrop: movePin, onEnd: renderList });

// The archived chats in the list's place, and back (the foot's Archived button, ⇧⌘A).
function toggleArchived() {
  if (!state.showArchived && !archivedChats().length) return toast('No archived chats');
  state.showArchived = !state.showArchived;
  renderList();
  const hidden = narrow() ? !document.body.classList.contains('sidebar-open') : document.body.classList.contains('sidebar-collapsed');
  if (state.showArchived && hidden) toggleSidebar(); // from the keyboard: show them
}
$('#show-archived').addEventListener('click', toggleArchived);

// ---------------------------------------------------------------- unread

// The server decides what's unread (a turn ended while no device had the
// chat open and visible); opening a chat on a visible page marks it read.
const unreadCount = () => state.chats.filter((c) => c.unread).length;

// Count on the floating sidebar toggle (the list is hidden) and on the
// installed app's icon.
function renderUnread() {
  const n = unreadCount();
  const badge = $('#unread-badge');
  badge.hidden = !n;
  badge.textContent = n > 9 ? '9+' : String(n);
  try {
    if (n) navigator.setAppBadge?.(n)?.catch(() => {});
    else navigator.clearAppBadge?.()?.catch(() => {});
  } catch {}
}

// A chat that isn't on screen just replied: a notice with the start of the
// reply that opens it (click, or ⌘J). It stays NOTICE_SECONDS on screen —
// a bar shows the time left, which stops while hovered or while the page is
// in the background (see style.css), so it isn't missed.
const NOTICE_SECONDS = 30;
let noticeChat = null;

function notify(chat) {
  if (chat.id === state.chatId && state.view === 'chat' && !document.hidden) return;
  noticeChat = chat.id;
  const others = state.chats.filter((c) => c.unread && c.id !== chat.id).length;
  const el = $('#notice');
  el.style.setProperty('--item-accent', accentFor(chat.hue));
  el.style.setProperty('--notice-time', `${NOTICE_SECONDS}s`);
  const time = h('span', { class: 'notice-time' });
  time.addEventListener('animationend', hideNotice);
  el.replaceChildren(
    h(
      'div',
      { class: 'notice-head' },
      h('span', { class: 'dot' }),
      h('span', { textContent: 'New reply' }),
      h('span', { class: 'num', textContent: indexLabel(listed().indexOf(chat)) }),
      h('button', { type: 'button', class: 'notice-x', 'aria-label': 'Dismiss', textContent: '×', onclick: (e) => (e.stopPropagation(), hideNotice()) }),
    ),
    h('div', { class: 'notice-title', textContent: chat.title || 'New chat' }),
    h('p', { class: 'notice-preview', textContent: chat.preview || 'The turn ended — open the chat to see it.' }),
    h(
      'div',
      { class: 'notice-foot' },
      others ? h('span', { class: 'notice-more', textContent: `+${others} more unread` }) : null,
      h('span', { class: 'notice-open' }, 'Open', touch ? null : h('kbd', { textContent: isMac ? '⇧⌘J' : 'Ctrl+Shift+J' })),
    ),
    time,
  );
  el.onclick = openReply;
  el.hidden = false;
}

function hideNotice() {
  $('#notice').hidden = true;
  noticeChat = null;
}

// The chat in the notice, else the newest unread one. False when there's none.
function openReply() {
  const newest = state.chats.filter((c) => c.unread).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))[0];
  const id = noticeChat || newest?.id;
  if (!id) return false;
  hideNotice();
  go(id);
}

// There's no header: this keeps the tab title, the accent and the status
// line under the composer in sync with the open chat.
function renderHeader() {
  const chat = current();
  const n = unreadCount();
  const title = state.view === 'settings' ? SETTINGS[route().page].title : chat?.title || 'New chat';
  document.title = `${n ? `(${n}) ` : ''}${title}`;
  applyAccent();
  renderDir();
  renderStats();
}

// The folder the open chat's agent works in (a new chat: where it will start).
const chatDir = () => current()?.cwd || state.newDir || agentOf().cwd;

// The status line's left side: chatDir(). The chat itself is the one lit in the sidebar.
function renderDir() {
  const dir = chatDir();
  const el = $('#chat-dir');
  el.title = dir || '';
  // LRM marks keep the slashes in order inside the rtl box, which trims a long
  // path from the left so its last folders stay visible.
  el.textContent = dir ? `\u200e${shortPath(dir)}\u200e` : '';
  $('#open-in').hidden = !state.editors.length || !dir;
}

// Top right: chatDir() in a code editor on this Mac.
$('#open-in').addEventListener('click', (e) =>
  showMenu(
    e.currentTarget,
    state.editors.map((ed) => ({ label: `Open in ${ed.name}`, run: () => api('POST', '/api/open-in', { editor: ed.id, dir: chatDir() }).catch(fail) })),
  ),
);

const shortPath = (dir) => {
  const home = state.home;
  return home && (dir === home || dir.startsWith(`${home}/`)) ? `~${dir.slice(home.length)}` : dir;
};

$('#new-chat').addEventListener('click', newChat);

// Sidebar (ui.js): its own button hides it, a floating one brings it back.
const sidebar = setupSidebar('chatSidebarCollapsed');
const setDrawer = sidebar.setDrawer;
function toggleSidebar() {
  const stick = atBottom; // the reflow would leave the thread mid-way
  sidebar.toggle();
  if (stick && !narrow()) {
    requestAnimationFrame(scrollToBottom);
    setTimeout(scrollToBottom, 300); // after the slide (see base.css)
  }
}
$('#close-sidebar').addEventListener('click', toggleSidebar);
$('#open-sidebar').addEventListener('click', toggleSidebar);

setInterval(() => {
  renderList();
  renderStats();
}, 60_000);

// ------------------------------------------------------------------ usage

function meter({ label, pct, detail, foot }) {
  const bar = h('span');
  bar.style.width = `${Math.min(100, pct)}%`;
  return h(
    'div',
    { class: `meter ${level(pct)}` },
    h('div', { class: 'meter-head' }, h('span', { textContent: label }), h('b', { textContent: detail ?? `${pct}%` })),
    h('div', { class: 'meter-bar' }, bar),
    foot ? h('div', { class: 'meter-foot', textContent: foot }) : null,
  );
}

function stat({ label, pct, title }) {
  const bar = h('span');
  bar.style.width = `${Math.min(100, pct)}%`;
  return h(
    'button',
    { type: 'button', class: `stat ${level(pct)}`, title, 'data-popover-anchor': '', onclick: (e) => openUsage(e.currentTarget) },
    h('span', { textContent: label }),
    h('span', { class: 'stat-bar' }, bar),
    h('b', { textContent: `${pct}%` }),
  );
}

const contextPct = (ctx) => Math.round((ctx.used / ctx.window) * 100);
const windowPct = (w) => Math.round((w.utilization || 0) * 100);

// Top of the chat: model, this chat's context, the account's usage windows.
function renderStats() {
  const chat = current();
  const ctx = chat?.context;
  const parts = [termToggle];
  if (state.agents.length) parts.push(modelButton(chat));
  else if (chat?.modelLabel || chat?.model) parts.push(h('span', { class: 'model', textContent: chat.modelLabel || chat.model }));
  if (ctx?.window) parts.push(stat({ label: 'ctx', pct: contextPct(ctx), title: `Context: ${tokens(ctx.used)} / ${tokens(ctx.window)} tokens` }));
  for (const w of limitsOf()?.windows || []) parts.push(stat({ label: w.label, pct: windowPct(w), title: `${w.label} usage — ${resetsIn(w.resetsAt)}` }));
  $('#chat-stats').replaceChildren(...parts);
  if (!$('#usage-panel').hidden) renderUsagePanel();
  if (!$('#model-panel').hidden) {
    renderModelPanel();
    const anchor = $('#chat-stats .model');
    if (anchor) place($('#model-panel'), anchor);
  }
}

// ------------------------------------------------------ model and effort

// Per chat; a new chat uses the ones picked for it (kept per device).
const settingsOf = (chat) => (chat ? { model: null, effort: null, ...chat.settings } : state.newSettings);
const agentId = () => current()?.agent || (current() ? state.defaultAgent : state.newAgent) || state.defaultAgent;
const agentOf = () => state.agents.find((a) => a.id === agentId()) || { models: [], efforts: [], cwd: null };
const limitsOf = () => state.limits[agentId()];

// The agent's logo, if its adapter has one (a 24×24 path): beside each chat in
// the sidebar, on the model button and in the picker. Gray, like the app's own marks.
function agentMark(id) {
  const icon = state.agents.find((a) => a.id === id)?.icon;
  if (!icon) return null;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'agent-mark');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', icon);
  svg.append(path);
  return svg;
}
const modelOption = (id) => agentOf().models.find((m) => m.id === (id || agentOf().defaultModel));

function modelButton(chat) {
  const { model, effort } = settingsOf(chat);
  // The exact model once a process reported it, else the choice.
  const label = (chat ? chat.modelLabel : modelOption(model)?.label) || `${agentOf().name || 'Default'} · Default`;
  const showEffort = effort && modelOption(model)?.effort !== false;
  return h(
    'button',
    { type: 'button', class: 'model', title: 'Agent, model and effort', 'data-popover-anchor': '', onclick: (e) => openModelPanel(e.currentTarget) },
    agentMark(agentId()),
    h('span', { class: 'model-name', textContent: label }),
    h('span', { class: 'model-short', textContent: label.split(' · ')[0] }), // phones: no "· 1M"
    showEffort ? h('span', { class: 'effort', textContent: effort }) : null,
  );
}

function renderModelPanel() {
  const chat = current();
  const { model, effort } = settingsOf(chat);
  const noEffort = modelOption(model)?.effort === false;
  const models = [{ id: null, label: 'Default', note: 'account setting' }, ...agentOf().models];
  if (model && !models.some((m) => m.id === model)) models.push({ id: model, label: chat?.modelLabel || model });
  const efforts = modelOption(model)?.efforts || agentOf().efforts;
  $('#model-panel').replaceChildren(
    h('section', { class: 'pick-group' },
      h('h2', { textContent: 'Agent' }),
      h('div', { class: 'segmented' }, ...state.agents.map((a) => h('button', {
        type: 'button', class: a.id === agentId() ? 'on' : '', disabled: Boolean(chat),
        onclick: () => {
          if (a.id === state.newAgent) return;
          state.newAgent = a.id;
          local.set('newAgent', a.id);
          changeSettings({ model: null, effort: null });
          renderDir();
        },
      }, agentMark(a.id), a.name))),
      chat ? h('div', { class: 'meter-foot', textContent: 'Choose a different agent in a new chat.' }) : null,
    ),
    h(
      'section',
      { class: 'pick-group' },
      h('h2', { textContent: 'Model' }),
      ...models.map((m) =>
        h(
          'button',
          { type: 'button', class: `pick${m.id === model ? ' on' : ''}`, onclick: () => changeSettings({ model: m.id }) },
          h('span', { class: 'radio' }),
          h('span', { class: 'pick-label', textContent: m.label }),
          m.note ? h('span', { class: 'pick-note', textContent: m.note }) : null,
        ),
      ),
    ),
    efforts.length
      ? h(
          'section',
          { class: 'pick-group' },
          h('h2', { textContent: 'Effort' }),
          h(
            'div',
            { class: `segmented${efforts.length > 5 ? ' wrap' : ''}` },
            ...[null, ...efforts].map((e) =>
              h('button', { type: 'button', class: !noEffort && e === effort ? 'on' : '', disabled: noEffort, textContent: e ?? 'default', onclick: () => changeSettings({ effort: e }) }),
            ),
          ),
        )
      : null,
    h('div', { class: 'meter-foot', textContent: chat ? 'Applies from the next message.' : 'For this new chat (and the next ones on this device).' }),
  );
}

function openModelPanel(anchor) {
  const panel = $('#model-panel');
  if (!panel.hidden) return hidePopovers();
  hidePopovers();
  renderModelPanel();
  panel.hidden = false;
  place(panel, anchor);
}

async function changeSettings(changes) {
  const chat = current();
  if ('model' in changes && modelOption(changes.model)?.efforts && !modelOption(changes.model).efforts.includes(settingsOf(chat).effort)) changes.effort = null;
  if (!chat) {
    state.newSettings = { ...state.newSettings, ...changes };
    local.set('newSettings', state.newSettings);
    return renderStats();
  }
  // Show it right away; the server's list confirms it.
  const before = { settings: chat.settings, modelLabel: chat.modelLabel };
  chat.settings = { ...settingsOf(chat), ...changes };
  if ('model' in changes) chat.modelLabel = modelOption(changes.model)?.label || '';
  renderStats();
  try { Object.assign(chat, await api('PATCH', `/api/chats/${chat.id}`, changes)); }
  catch (err) { Object.assign(chat, before); fail(err); }
  renderStats();
}

function renderUsagePanel() {
  const ctx = current()?.context;
  const windows = limitsOf()?.windows || [];
  const updated = limitsOf() && ago(limitsOf().updated);
  $('#usage-panel').replaceChildren(
    ctx?.window
      ? h(
          'section',
          { class: 'meter-group' },
          h('h2', { textContent: 'This chat' }),
          meter({ label: 'Context', pct: contextPct(ctx), detail: `${contextPct(ctx)}% · ${tokens(ctx.used)} / ${tokens(ctx.window)}` }),
        )
      : null,
    windows.length
      ? h(
          'section',
          { class: 'meter-group' },
          h('h2', { textContent: 'Account limits' }),
          ...windows.map((w) => meter({ label: w.label, pct: windowPct(w), foot: resetsIn(w.resetsAt) })),
          h('div', { class: 'meter-foot', textContent: updated === 'now' ? 'updated just now' : `updated ${updated} ago` }),
        )
      : null,
  );
}

function openUsage(anchor) {
  const panel = $('#usage-panel');
  if (!panel.hidden) return hidePopovers();
  hidePopovers();
  renderUsagePanel();
  panel.hidden = false;
  place(panel, anchor);
}

// ------------------------------------------------------- terminal panel

// ⌘J: a terminal under the chat, like an editor's integrated one. It's a tmux
// tab (lib/terminal.js) tagged with the chat's id, opened in the chat's folder
// the first time and the same on every device (and over SSH: bin/mothership). Which chats show it is this device's ('termOpen'); the new chat page's
// one ('termDraft') goes to the chat its first message makes.
const termPanel = $('#term-panel');
const term = {
  open: new Set(local.get('termOpen', [])), // chat ids, 'new' for the new chat page
  view: null, // the terminal shown (term.js)
  key: null, // whose it is
  loading: null, // the latest lookup: an older one that lands late is dropped
};
const termKey = () => state.chatId || 'new';
const saveTermOpen = () => local.set('termOpen', [...term.open]);
const termToggle = h(
  'button',
  { id: 'term-toggle', type: 'button', 'aria-label': 'Terminal', onclick: () => toggleTerm() },
  h('span', { innerHTML: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 8 4 4-4 4M12 16h7" /></svg>' }).firstChild,
);
termToggle.title = `Terminal (${MOD}J)`;

async function findTermTab(key) {
  const tabs = await api('GET', '/api/tabs');
  if (key !== 'new') return tabs.find((t) => t.chat === key);
  return tabs.find((t) => t.id === local.get('termDraft', null) && !t.chat);
}

function dropTermView() {
  term.view?.destroy();
  term.view = null;
  term.key = null;
}

// Shows (or hides) the panel for the chat on screen. create: make its terminal
// if it has none (⌘J); otherwise a chat whose terminal was closed hides it.
async function syncTerm({ create = false, focus = false } = {}) {
  const key = termKey();
  const shown = state.view === 'chat' && term.open.has(key);
  termPanel.hidden = !shown;
  termToggle.classList.toggle('on', shown);
  termToggle.setAttribute('aria-pressed', String(shown));
  if (term.key && term.key !== key) dropTermView(); // another chat's: its tab stays in tmux
  if (!shown) return;
  sizeTerm();
  if (term.view) {
    term.view.refit();
    if (focus) term.view.term.focus();
    return;
  }
  const token = (term.loading = {});
  const stale = () => term.loading !== token || termKey() !== key || !term.open.has(key);
  try {
    let tab = await findTermTab(key);
    if (!tab && create && !stale()) tab = await api('POST', '/api/tabs', { cwd: chatDir(), ...(key !== 'new' && { chat: key }) });
    if (stale()) return;
    if (!tab) return closeTerm(key);
    if (key === 'new') local.set('termDraft', tab.id);
    const { termView } = await import('/term.js');
    if (stale() || term.view) return;
    term.key = key;
    term.view = termView({
      id: tab.id,
      hue: state.chatId ? current()?.hue : state.nextHue,
      parent: $('#term-body'),
      onStatus: (status) => (termPanel.dataset.status = status),
      // The shell exited (or the tab was closed elsewhere): the panel goes with it.
      beforeRetry: async () => {
        const tabs = await api('GET', '/api/tabs').catch(() => null);
        if (tabs && !tabs.some((t) => t.id === tab.id) && term.view?.id === tab.id) closeTerm(term.key); // its key may have moved (adoptTerm)
      },
    });
    $('#term-title').textContent = tab.title;
    term.view.refit();
    term.view.connect();
    if (focus) term.view.term.focus();
  } catch (err) {
    fail(err);
  }
}

function closeTerm(key) {
  term.open.delete(key);
  saveTermOpen();
  if (term.key === key) dropTermView();
  if (key === termKey()) syncTerm();
}

// The buttons show / hide it. ⌘J (fromKeys) works like an editor's: from
// elsewhere it opens it or, already open, goes to it; only from inside it
// does it hide it.
function toggleTerm({ fromKeys = false } = {}) {
  if (state.view !== 'chat') return false;
  const key = termKey();
  const opening = !term.open.has(key);
  if (fromKeys && !opening && !termPanel.contains(document.activeElement)) {
    if (term.view) term.view.term.focus();
    else syncTerm({ focus: true }); // still loading: focus it when it's there
    return;
  }
  const stick = atBottom; // the thread loses (or gets back) the panel's height
  if (opening) term.open.add(key);
  else term.open.delete(key);
  saveTermOpen();
  if (!opening && termPanel.contains(document.activeElement) && !touch) input.focus();
  syncTerm({ create: opening, focus: opening && !touch });
  if (stick) requestAnimationFrame(scrollToBottom);
}

// The new chat page's terminal becomes the new chat's.
function adoptTerm(chatId) {
  const draft = local.get('termDraft', null);
  if (!term.open.has('new') || !draft) return;
  term.open.delete('new');
  term.open.add(chatId);
  saveTermOpen();
  local.set('termDraft', null);
  if (term.key === 'new') term.key = chatId;
  api('PATCH', `/api/tabs/${draft}`, { chat: chatId }).catch(fail);
}

// Height: dragged from its top edge, kept per device, never so tall the thread
// and the message box lose their room.
function sizeTerm(px = local.get('termHeight', null)) {
  const room = $('#main').clientHeight - 240;
  const height = Math.max(120, Math.min(px ?? Math.round(innerHeight * 0.38), room));
  termPanel.style.height = `${height}px`;
  return height;
}
$('#term-resize').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  termPanel.classList.add('resizing');
  const startY = e.clientY;
  const start = termPanel.offsetHeight;
  let height = start;
  const move = (ev) => (height = sizeTerm(start + startY - ev.clientY));
  const up = () => {
    handle.removeEventListener('pointermove', move);
    termPanel.classList.remove('resizing');
    local.set('termHeight', height);
    if (atBottom) scrollToBottom();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up, { once: true });
  handle.addEventListener('pointercancel', up, { once: true });
});
// Refit once the size settles, not on every frame (each fit resizes the tmux session).
let termFit;
new ResizeObserver(() => {
  clearTimeout(termFit);
  termFit = setTimeout(() => term.view?.refit(), 80);
}).observe($('#term-body'));
addEventListener('resize', () => !termPanel.hidden && sizeTerm());

$('#term-hide').addEventListener('click', () => toggleTerm());
$('#term-hide').title = `Hide (${MOD}J)`;

// ------------------------------------------------------------- shortcuts

// One table drives the key handling and the Shortcuts screen. `match` gets
// the keydown event; `run` returns false when it didn't apply. Entries
// without `match` are handled elsewhere (composer, sidebar) and only listed.
const mod = (e) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey) && !e.altKey;
const shiftMod = (e) => e.shiftKey && !e.altKey && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
const SHORTCUTS = [
  {
    id: 'switch',
    keys: [itemKey(1), '…', itemKey(9)],
    label: 'Open chat 1–9',
    note: 'In sidebar order (the archived ones while they are shown) — hold the modifier to see the numbers',
    match: (e) => itemNumber(e) > 0,
    run: (e) => {
      const chat = shown()[itemNumber(e) - 1];
      if (!chat) return false;
      go(chat.id);
    },
  },
  {
    id: 'new',
    keys: [appKey('N')],
    label: 'New chat',
    note: isMac && !standalone ? 'Just ⌘N in the macOS app or an installed app window' : null,
    match: (e) => isAppKey(e, 'N'),
    run: () => newChat(),
  },
  {
    id: 'sidebar',
    keys: [`${MOD}B`],
    label: 'Show / hide the sidebar',
    match: (e) => mod(e) && !e.shiftKey && e.code === 'KeyB',
    run: () => toggleSidebar(),
  },
  {
    id: 'reply',
    keys: [isMac ? '⇧⌘J' : 'Ctrl+Shift+J'],
    label: 'Open the latest reply',
    note: 'The chat in the notice, or the newest unread one',
    match: (e) => shiftMod(e) && e.code === 'KeyJ',
    run: () => openReply(),
  },
  {
    id: 'term',
    keys: [`${MOD}J`],
    label: 'Terminal',
    note: "Opens this chat's own, under it, in its folder; open, goes to it; from inside it, hides it. Drag its top edge to resize",
    match: (e) => mod(e) && !e.shiftKey && e.code === 'KeyJ',
    run: () => toggleTerm({ fromKeys: true }),
  },
  {
    id: 'input',
    keys: [`${MOD}K`],
    label: 'Go to the message box',
    match: (e) => mod(e) && !e.shiftKey && e.code === 'KeyK',
    run: () => focusInput(),
  },
  {
    id: 'rename',
    keys: [isMac ? '⇧⌘E' : 'Ctrl+Shift+E'],
    label: 'Rename this chat',
    note: 'Or double-click it in the sidebar',
    match: (e) => shiftMod(e) && e.code === 'KeyE',
    run: () => (current() ? renameWithDialog(current()) : false),
  },
  {
    id: 'pin',
    keys: [isMac ? '⇧⌘P' : 'Ctrl+Shift+P'],
    label: 'Pin / unpin this chat',
    note: 'Or drag it to Pinned in the sidebar, and back down to unpin',
    match: (e) => shiftMod(e) && e.code === 'KeyP',
    run: () => (current() && !current().archived ? togglePin(current()) : false),
  },
  {
    id: 'archived',
    keys: [isMac ? '⇧⌘A' : 'Ctrl+Shift+A'],
    label: 'Show / hide archived chats',
    note: 'In the sidebar, in place of the list; the same keys bring the list back',
    match: (e) => shiftMod(e) && e.code === 'KeyA',
    run: () => toggleArchived(),
  },
  {
    id: 'delete',
    keys: [isMac ? '⇧⌘D' : 'Ctrl+Shift+D'],
    label: 'Delete this chat',
    note: 'Asks first',
    match: (e) => shiftMod(e) && e.code === 'KeyD',
    run: () => (current() ? deleteChat(current()) : false),
  },
  {
    id: 'settings',
    keys: [`${MOD}/`],
    label: 'Open Settings',
    note: 'Where this list is, under Shortcuts',
    match: (e) => mod(e) && (e.key === '/' || e.code === 'Slash'), // ABNT keyboards put / elsewhere
    run: () => (location.hash = 'settings'),
  },
  { id: 'send', keys: ['Enter'], label: 'Send message', note: 'On a phone, use the send button' },
  { id: 'newline', keys: ['⇧Enter'], label: 'New line in the message' },
  { id: 'stop', keys: ['Esc'], label: 'Stop the agent', note: 'While it is working, with the message box focused' },
  { id: 'recall', keys: ['↑', '↓'], label: 'Suggest a recent message', note: "In an empty message box: this chat's last 5, newest first" },
  { id: 'take', keys: ['Tab'], label: 'Use the suggestion', note: 'Puts it in the box, to edit or send' },
];

document.addEventListener(
  'keydown',
  (e) => {
    const s = SHORTCUTS.find((x) => x.match?.(e));
    if (!s || e.isComposing) return;
    // Off macOS the modifier is Ctrl: in the terminal, plain Ctrl+letter is the shell's.
    if (!isMac && !e.shiftKey && s.id !== 'term' && e.target.closest?.('#term-panel')) return;
    if (s.run(e) === false) return;
    e.preventDefault();
    e.stopPropagation(); // never reaches the terminal
  },
  true,
);

$('#new-chat-hint').textContent = appKey('N');
$('#settings-hint').textContent = `${MOD}/`;
$('#archived-hint').textContent = isMac ? '⇧⌘A' : 'Ctrl+Shift+A';
$('#input-key').textContent = `${MOD}K`;

// Settings › Shortcuts: what each one does and its keys.
$('#shortcut-list').replaceChildren(
  ...SHORTCUTS.map((s) =>
    h(
      'li',
      {},
      h('span', { class: 'what' }, s.label, s.note ? h('small', { textContent: s.note }) : null),
      h('span', { class: 'keys' }, s.keys.map((k) => (k === '…' || k === 'or' ? h('span', { textContent: k }) : h('kbd', { textContent: k })))),
    ),
  ),
);
// ------------------------------------------------------------- settings

// A list of its pages (#settings), each opening on its own: Shortcuts
// (above) and Integrations, which lists one page per integration.
function showSettings(page) {
  const { title, up } = SETTINGS[page];
  for (const el of document.querySelectorAll('.settings-page')) el.hidden = el.dataset.page !== page;
  $('#settings-title').textContent = title;
  $('#settings-back span').textContent = up == null ? 'Chat' : SETTINGS[up].title;
  $('#settings-back').setAttribute('aria-label', `Back to ${up == null ? 'the chat' : SETTINGS[up].title}`);
  $('#settings-view').scrollTop = 0;
  if (page === '' || page === 'integrations') loadIntegrations(); // the lines that say how each stands
  else INTEGRATIONS.find((i) => page === `integrations/${i.id}`)?.load();
}

$('#open-settings').addEventListener('click', () => (location.hash = 'settings'));
$('#settings-back').addEventListener('click', () => {
  const { up } = SETTINGS[route().page];
  if (up == null) go(state.chatId);
  else location.hash = up ? `settings/${up}` : 'settings';
});

// ---------------------------------------------------------- integrations

// One row each in Settings › Integrations, opening its own page
// (#settings/integrations/<id>: a [data-page] in index.html and an entry in
// SETTINGS). load() fills that page and says how it stands: { connected, note }.
const INTEGRATIONS = [{ id: 'slack', name: 'Slack', icon: '<path d="M10 4 8 20M16 4l-2 16M5 9h15M4 15h15" />', load: loadSlack }];

const integrationNotes = new Map(); // id -> the note in its row
$('#integration-list').replaceChildren(
  ...INTEGRATIONS.map((i) => {
    const note = h('small', { textContent: '…' });
    integrationNotes.set(i.id, note);
    return h(
      'a',
      { href: `#settings/integrations/${i.id}` },
      h('span', { class: 'icon', innerHTML: `<svg viewBox="0 0 24 24" aria-hidden="true">${i.icon}</svg>` }),
      h('span', { class: 'what' }, i.name, note),
      h('span', { class: 'chevron', 'aria-hidden': 'true', textContent: '›' }),
    );
  }),
);

async function loadIntegrations() {
  const states = await Promise.all(INTEGRATIONS.map((i) => i.load()));
  INTEGRATIONS.forEach((i, n) => {
    const note = integrationNotes.get(i.id);
    note.textContent = states[n].note;
    note.classList.toggle('on', states[n].connected);
  });
  const on = INTEGRATIONS.filter((_, n) => states[n].connected).map((i) => i.name);
  $('#integrations-note').textContent = on.length ? `Connected: ${on.join(', ')}` : 'None connected';
}

// Integrations › Slack: the owner's user token goes in here, never in
// config.json; the server keeps it on the Mac and only ever says whose it is.
// The app the token comes from is created from a manifest with the scopes the
// server asks for.
async function loadSlack() {
  let s;
  try {
    s = await api('GET', '/api/slack');
  } catch (err) {
    // A page newer than the server it talks to (front-end changes are live at once).
    s = { error: err.status === 404 ? 'the server needs a restart to load this' : err.message };
  }
  renderSlack(s);
  return { connected: Boolean(s.connected), note: s.error ? `Couldn't check: ${s.error}` : s.connected ? `Connected as @${s.user} in ${s.team}` : 'Not connected' };
}

function renderSlack(s) {
  const status = $('#slack-status');
  status.classList.toggle('on', Boolean(s.connected));
  if (s.error) status.replaceChildren(h('span', { class: 'dot' }), `Couldn't check: ${s.error}`);
  else if (s.connected) {
    const team = s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener', textContent: s.team }) : s.team;
    status.replaceChildren(
      h('span', { class: 'dot' }),
      h('span', {}, 'Connected as ', h('b', { textContent: `@${s.user}` }), ' in ', team),
      h('button', { type: 'button', textContent: 'Disconnect', onclick: disconnectSlack }),
    );
    if (s.missing?.length) {
      const scopes = s.missing.join(', ');
      const text = `The token lacks ${scopes}: some tools will fail. In the app's OAuth & Permissions, add ${s.missing.length > 1 ? 'them' : 'it'} to the User Token Scopes and reinstall the app. If Slack shows a new token, paste it below.`;
      status.append(h('span', { class: 'warn', textContent: text }));
    }
  } else status.replaceChildren(h('span', { class: 'dot' }), 'Not connected.');
  // Connected, it's for a new token when Slack gave one (reinstalled with more scopes).
  $('#slack-form').hidden = Boolean(s.error || (s.connected && !s.missing?.length));
  $('#slack-form button').textContent = s.connected ? 'Update' : 'Connect';
  $('#slack-help').open = !s.connected && !s.error;
  if (s.scopes) {
    const manifest = JSON.stringify({
      display_information: { name: 'Mothership', description: 'Lets the agent on my Mac read my conversations and send the messages I ask it to.' },
      oauth_config: { scopes: { user: s.scopes } },
      settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
    });
    $('#slack-create').href = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(manifest)}`;
    $('#slack-manifest').replaceChildren(copyRow(JSON.stringify(JSON.parse(manifest), null, 2)));
  }
}

$('#slack-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const field = $('#slack-token');
  const button = e.target.querySelector('button');
  if (!field.value.trim()) return field.focus();
  const wasConnected = $('#slack-status').classList.contains('on');
  button.disabled = true;
  try {
    renderSlack(await api('PUT', '/api/slack', { token: field.value }));
    field.value = '';
    toast(wasConnected ? 'Token updated' : 'Slack connected');
  } catch (err) {
    fail(err);
  }
  button.disabled = false;
});

async function disconnectSlack() {
  const sure = await ask({
    title: 'Disconnect Slack?',
    text: 'The token is deleted from this Mac and the agents lose their Slack tools. The app stays installed in Slack.',
    confirm: 'Disconnect',
    danger: true,
  });
  if (!sure) return;
  try {
    renderSlack(await api('DELETE', '/api/slack'));
  } catch (err) {
    fail(err);
  }
}


// ------------------------------------------------------------- on / off

// Off (lib/power.js): every device gets the "Turned off" screen; only a
// browser on this Mac gets the switches (the server checks again).
let thisMac = false;
let offPoll = null;

function checkPower() {
  return api('GET', '/api/config').then((c) => {
    thisMac = c.thisMac;
    $('#turn-off').hidden = !thisMac;
    state.editors = c.editors || [];
    renderDir();
    if (c.on === false) showOff();
    else if (c.on && state.off) location.reload(); // turned back on (from another tab)
  }, () => {}); // unreachable (asleep, restarting): the socket keeps retrying
}

function showOff() {
  $('#turn-on').hidden = !thisMac;
  $('#off-note').textContent = thisMac ? 'The Mac can sleep again.' : 'Turn it back on from the Mac.';
  document.title = 'Turned off';
  if (state.off) return;
  state.off = true;
  native?.({ op: 'power', on: false });
  clearTimeout(retryTimer);
  ws?.close();
  hidePopovers();
  $('#off-screen').hidden = false;
  offPoll = setInterval(() => !document.hidden && checkPower(), 10_000);
}

$('#turn-off').addEventListener('click', async () => {
  const running = state.chats.filter((c) => c.status === 'running').length;
  const stops = running ? `\n\n${running === 1 ? 'A chat is' : `${running} chats are`} still working and will stop.` : '';
  if (!confirm(`Turn off? Every device gets a "Turned off" screen and the Mac can sleep again, until you turn it back on from this Mac.${stops}`)) return;
  try {
    await api('POST', '/api/turn-off');
  } catch (err) {
    return fail(err);
  }
  showOff();
});

$('#turn-on').addEventListener('click', async () => {
  $('#turn-on').disabled = true;
  try {
    await api('POST', '/api/turn-on');
  } catch (err) {
    $('#turn-on').disabled = false;
    return fail(err);
  }
  clearInterval(offPoll);
  native?.({ op: 'power', on: true });
  location.reload();
});

checkPower();

// ---------------------------------------------------------- turn status

function applyStatus(status, queue) {
  state.status = status;
  state.queue = queue || [];
  if (status === 'running' && !loader) {
    loader = createLoader();
    $('#loader-slot').append(loader.el);
    state.phase = {};
    sayPhase('thinking', 'thinking');
  } else if (status !== 'running' && loader) {
    loader.destroy();
    loader = null;
  }
  renderQueue();
  updateSend();
}

// What the indicator says, in the app's theme. Each moment has a few
// phrasings: one is picked when the moment starts and kept while it lasts
// (an agent starts several blocks in a row), so the label doesn't flicker.
const PHRASES = {
  thinking: ['Plotting a course', 'Scanning the horizon', 'Running the numbers', 'Charting the route'],
  writing: ['Transmitting', 'Sending the dispatch', 'Downlinking'],
  reading: ['Reading telemetry', 'Debriefing', 'Checking the instruments'],
};

function setPhase(phase, label) {
  state.phase = { phase, label };
  loader?.update(state.phase);
}

// moment: a PHRASES key; phase: the indicator's animation (loader.js).
function sayPhase(phase, moment) {
  if (state.phase.moment === moment) return;
  const list = PHRASES[moment];
  state.phase = { phase, label: list[Math.floor(Math.random() * list.length)], moment };
  loader?.update(state.phase);
}

function livePhase(ev) {
  if (ev.t !== 'start') return;
  if (ev.kind === 'thinking') sayPhase('thinking', 'thinking');
  else if (ev.kind === 'text') sayPhase('writing', 'writing');
  else if (ev.kind === 'tool_use') setPhase('tool', `Arming ${toolName(ev.name)}`);
}

function itemPhase(item) {
  if (item.t === 'block' && item.block.type === 'tool_use') setPhase('tool', `Deploying ${toolName(item.block.name)}`);
  else if (item.t === 'tool_result') sayPhase('thinking', 'reading');
}

function renderQueue() {
  $('#queue').replaceChildren(
    ...state.queue.map((q) =>
      h(
        'div',
        { class: 'queued', title: q.text },
        h('span', { textContent: q.text || q.attachments.map((a) => a.name).join(', ') }),
        h('button', { type: 'button', textContent: '×', 'aria-label': 'Remove from queue', onclick: () => wsSend({ op: 'unqueue', chatId: state.chatId, id: q.id }) }),
      ),
    ),
  );
}

// ------------------------------------------------------------- scrolling

let atBottom = true;
messages.addEventListener('scroll', () => {
  atBottom = messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 80;
  $('#jump').hidden = atBottom;
  holdAnchor();
  loadOlder();
});
function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
  atBottom = true;
  $('#jump').hidden = true;
}

// Off the bottom, what's in the middle of the screen stays there when the
// thread changes size above it: an older page arriving, its images loading
// (browsers' own scroll anchoring does this in Chrome, not always, and not in
// Safari). Its place in the thread (`at`: its top plus the scroll) only
// changes when something above it does.
let anchor = null; // { el, at }

function holdAnchor() {
  followAnchor(); // first undo what moved the last one, if the observer hasn't yet
  const box = messages.getBoundingClientRect();
  const middle = box.top + box.height / 2;
  const list = $('#thread').querySelectorAll(':scope > .note, .turn-head, .user-msg, .assistant > *');
  // In document order, so top to bottom: the first one starting below the middle.
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].getBoundingClientRect().top >= middle) hi = mid;
    else lo = mid + 1;
  }
  const el = list[lo];
  anchor = el ? { el, at: el.getBoundingClientRect().top + messages.scrollTop } : null;
}

function followAnchor() {
  if (atBottom || !anchor?.el.isConnected) return;
  const moved = anchor.el.getBoundingClientRect().top + messages.scrollTop - anchor.at;
  if (Math.abs(moved) < 1) return;
  anchor.at += moved;
  messages.scrollTop += moved;
}

new ResizeObserver(() => (atBottom ? scrollToBottom() : followAnchor())).observe($('#thread'));
new ResizeObserver(() => atBottom && scrollToBottom()).observe($('#loader-slot'));
$('#jump').addEventListener('click', scrollToBottom);

// History pages (lib/chat.js historyPage): the oldest item shown, whether
// there's more above it, and whether it was asked for.
const pages = { oldest: null, more: false, loading: false };

function setPages(oldest, more) {
  Object.assign(pages, { oldest, more: Boolean(more), loading: false });
  $('#older').hidden = !pages.more;
  followAnchor();
  loadOlder(); // a short page doesn't scroll: fill the screen
}

// Asked for a screen ahead, so it's usually there before the top is.
function loadOlder() {
  if (!pages.more || pages.loading || state.opening || messages.scrollTop > messages.clientHeight) return;
  pages.loading = wsSend({ op: 'older', chatId: state.chatId, before: pages.oldest });
}

// -------------------------------------------------------------- composer

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

function updateSend() {
  const empty = !input.value.trim() && !state.attachments.length;
  const stop = state.status === 'running' && empty;
  const send = $('#send');
  send.classList.toggle('stop', stop);
  send.setAttribute('aria-label', stop ? 'Stop' : 'Send');
  send.disabled = !stop && (empty || state.attachments.some((a) => a.uploading));
}

const draftKey = () => `draft:${state.chatId || 'new'}`;
function restoreDraft() {
  input.value = local.get(draftKey(), '');
  autosize();
  updateSend();
}
function moveDraft(from, to) {
  local.set(`draft:${to}`, local.get(`draft:${from}`, ''));
  local.set(`draft:${from}`, null);
}

input.addEventListener('input', () => {
  if (pick >= 0 && input.value) suggest(-1); // typing dismisses a suggestion
  autosize();
  updateSend();
  local.set(draftKey(), input.value);
});
input.addEventListener('blur', () => suggest(-1));
input.addEventListener('keydown', (e) => {
  const plain = !e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.isComposing;
  if (plain && e.key === 'ArrowUp' && !input.value && recent.length) {
    e.preventDefault();
    return suggest(Math.min(pick + 1, recent.length - 1));
  }
  if (pick >= 0) {
    if (e.key === 'ArrowDown') suggest(pick - 1);
    else if (e.key === 'Tab') take();
    else if (e.key === 'Escape') suggest(-1);
    else if (e.key !== 'Enter') return; // anything else: type over it (the input event dismisses it)
    // Enter does nothing here: on an empty box it would stop a running agent.
    return e.preventDefault();
  }
  if (e.key === 'Enter' && !e.isComposing) {
    if (e.shiftKey || touch) return;
    e.preventDefault();
    $('#composer').requestSubmit();
  }
  if (e.key === 'Escape' && state.status === 'running') {
    wsSend({ op: 'interrupt', chatId: state.chatId });
  }
});

// ------------------------------------------------------- recent messages

// ↑ on an empty message box suggests this chat's last messages (newest first,
// up to RECENT, repeats once) as a faded placeholder — the box itself stays
// empty — ↓ goes back, Tab takes it into the box to edit or send.
const RECENT = 5;
const PLACEHOLDER = input.placeholder;
let recent = []; // the open chat's, newest first
let pick = -1; // the one suggested, -1 = none

function remember(items) {
  const before = recent.join('\n');
  for (const item of items) {
    const text = item.t === 'user' && item.text?.trim();
    if (text) recent = [text, ...recent.filter((t) => t !== text)].slice(0, RECENT);
  }
  if (pick >= 0 && recent.join('\n') !== before) suggest(-1); // the list moved under it
}

function forgetRecent() {
  recent = [];
  suggest(-1);
}

function suggest(i) {
  pick = i;
  const on = i >= 0;
  input.placeholder = on ? recent[i] : PLACEHOLDER;
  input.classList.toggle('suggesting', on);
  $('#recall').hidden = !on;
  if (on) $('#recall').textContent = `${i + 1}/${recent.length} · Tab`;
  if (!on) return autosize();
  // Size the box to the suggestion: measure it as a value, then empty it again.
  input.value = recent[i];
  input.style.height = 'auto';
  const height = input.scrollHeight;
  input.value = '';
  input.style.height = `${height}px`;
}

function take() {
  const text = recent[pick];
  suggest(-1);
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event('input')); // size, send button, draft
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (state.status === 'running' && !text && !state.attachments.length) {
    wsSend({ op: 'interrupt', chatId: state.chatId });
    return;
  }
  if (!text && !state.attachments.length) return;
  if (state.attachments.some((a) => a.uploading)) return toast('Wait for the attachments to upload');
  const ref = randomId();
  const attachments = state.attachments.map((a) => ({ file: a.file, name: a.name }));
  // A new chat starts with these.
  const settings = state.chatId ? undefined : state.newSettings;
  const dir = state.chatId ? undefined : state.newDir || undefined;
  if (!wsSend({ op: 'send', ref, chatId: state.chatId, text, attachments, settings, dir, agent: state.newAgent || state.defaultAgent })) return toast('Not connected to the server', true);
  state.sends.set(ref, { text, attachments: state.attachments });
  input.value = '';
  local.set(draftKey(), null);
  state.attachments = [];
  renderAttachments();
  autosize();
  updateSend();
  $('#welcome').hidden = true;
  scrollToBottom();
});

// ----------------------------------------------------------- attachments

const MAX_EDGE = 1568; // larger images get downscaled by the model APIs anyway

// Phone photos are big: resize before uploading (and turn HEIC into JPEG).
async function prepareImage(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const convert = /heic|heif/.test(file.type);
  if (scale === 1 && !convert && file.size < 3 * 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.88));
  if (!blob) return file;
  const name = `${(file.name || 'image').replace(/\.\w+$/, '')}.${type === 'image/png' ? 'png' : 'jpg'}`;
  return new File([blob], name, { type });
}

async function addFiles(files) {
  for (const original of files) {
    const att = {
      id: randomId(),
      name: original.name || 'image',
      mediaType: original.type,
      preview: original.type.startsWith('image/') ? URL.createObjectURL(original) : null,
      uploading: true,
    };
    state.attachments.push(att);
    renderAttachments();
    updateSend();
    try {
      const file = await prepareImage(original);
      const res = await api('POST', `/api/uploads?name=${encodeURIComponent(file.name || att.name)}`, file, file.type || 'application/octet-stream');
      Object.assign(att, { file: res.file, name: res.name, url: res.url, mediaType: res.mediaType, uploading: false });
    } catch (err) {
      state.attachments = state.attachments.filter((a) => a !== att);
      fail(err);
    }
    renderAttachments();
    updateSend();
  }
}

function renderAttachments() {
  $('#attachments').replaceChildren(
    ...state.attachments.map((a) => {
      // An image opens full size before it's sent: anywhere on the chip but ×.
      const preview = a.preview ? () => showImage(a.preview, a.url) : null;
      return h(
        'div',
        {
          class: `chip${a.uploading ? ' uploading' : ''}${preview ? ' previewable' : ''}`,
          title: preview ? `${a.name} — click to preview` : a.name,
          ...(preview && {
            role: 'button',
            tabindex: '0',
            onclick: preview,
            onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), preview()),
          }),
        },
        a.preview ? h('img', { src: a.preview, alt: '' }) : null,
        h('span', { class: 'name', textContent: a.uploading ? 'uploading…' : a.name }),
        h('button', {
          type: 'button',
          class: 'chip-x',
          textContent: '×',
          'aria-label': 'Remove attachment',
          onclick: (e) => {
            e.stopPropagation(); // not a preview
            state.attachments = state.attachments.filter((x) => x !== a);
            renderAttachments();
            updateSend();
          },
        }),
      );
    }),
  );
}

$('#attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
$('#main').addEventListener('dragover', (e) => e.preventDefault());
$('#main').addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
});

// --------------------------------------------------------------- lightbox

const lightbox = $('#lightbox');

// original: what "open original" links to. An attachment not sent yet shows
// its local copy (blob:) and links to the uploaded one, once it's there.
function showImage(src, original = src.startsWith('blob:') ? '' : src) {
  lightbox.querySelector('img').src = src;
  $('#lightbox-open').href = original || '';
  $('#lightbox-open').hidden = !original;
  lightbox.hidden = false;
}

document.addEventListener('click', (e) => {
  const img = e.target.closest('img.zoomable');
  if (img) showImage(img.src);
});
lightbox.addEventListener('click', (e) => {
  if (!e.target.closest('a')) lightbox.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    lightbox.hidden = true;
    hidePopovers();
  }
});

// ------------------------------------------------------------------- boot

// /?dir=<folder>: a new chat that starts there. Otherwise, opening the app without a link resumes the last chat.
const startDir = new URLSearchParams(location.search).get('dir');
if (startDir) {
  state.newDir = startDir;
  history.replaceState(null, '', '/');
} else if (route().view === 'chat' && !hashId() && local.get('last', null)) history.replaceState(null, '', `#${local.get('last')}`);
state.chatId = route().view === 'chat' ? hashId() : local.get('last', null);
$('#welcome').hidden = Boolean(state.chatId);
restoreDraft();
setView(route().view);
connect();
