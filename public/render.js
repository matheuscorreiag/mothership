// Turns chat items (see lib/chat.js) into DOM. Everything about how a
// message, a tool call or an image looks lives here — tweak TOOLS to change
// how each tool is summarized and expanded.

import { marked } from '/vendor/marked.mjs';
import DOMPurify from '/vendor/purify.mjs';
import { h } from '/ui.js';

marked.use({ gfm: true, breaks: true });

// ------------------------------------------------------------------ utils

// Absolute (or ~/) paths to image files mentioned in plain text.
const IMAGE_PATH = /(?:^|[\s(`'"“])((?:\/|~\/)[^\s'"`<>()“”]+?\.(?:png|jpe?g|gif|webp|svg))(?=$|[\s)`'"”.,;:!?])/gim;

export const localImageUrl = (p) => `/api/local-image?path=${encodeURIComponent(p)}`;

function short(p = '') {
  return String(p).replace(/^\/Users\/[^/]+/, '~');
}

function firstString(input) {
  return Object.values(input || {}).find((v) => typeof v === 'string') || '';
}

function code(text, lang = '') {
  return h('pre', { class: 'code' }, h('code', { dataset: { lang }, textContent: text ?? '' }));
}

// ---------------------------------------------------------------- markdown

function renderMarkdown(text) {
  const el = h('div', { class: 'md' });
  el.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['target'] });
  for (const img of el.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    const local = src.replace(/^file:\/\//, '');
    if (/^(\/|~\/)/.test(local) && !/^\/(media|api)\//.test(local)) img.src = localImageUrl(decodeURI(local));
    img.loading = 'lazy';
    img.classList.add('zoomable');
  }
  for (const a of el.querySelectorAll('a[href]')) {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  for (const pre of el.querySelectorAll('pre')) {
    pre.classList.add('code');
    pre.append(
      h('button', {
        class: 'copy',
        type: 'button',
        textContent: 'copy',
        onclick: (e) => {
          navigator.clipboard?.writeText(pre.querySelector('code')?.textContent ?? pre.textContent);
          e.target.textContent = 'copied';
          setTimeout(() => (e.target.textContent = 'copy'), 1200);
        },
      }),
    );
  }
  // Images mentioned by path ("salvei em /Users/.../shot.png") become a gallery.
  const shown = new Set([...el.querySelectorAll('img')].map((i) => i.getAttribute('src')));
  const paths = [...new Set([...(text || '').matchAll(IMAGE_PATH)].map((m) => m[1]))].filter((p) => !shown.has(localImageUrl(p)));
  if (paths.length) el.append(gallery(paths.map((p) => ({ url: localImageUrl(p), name: short(p) }))));
  return el;
}

function gallery(images) {
  return h(
    'div',
    { class: 'gallery' },
    images.map(({ url, name }) =>
      h('img', {
        class: 'thumb zoomable',
        src: url,
        alt: name || '',
        title: name || '',
        loading: 'lazy',
        onerror: (e) => e.target.remove(), // a path that doesn't exist (anymore)
      }),
    ),
  );
}

// ------------------------------------------------------------------- tools

// summary: one line next to the tool name. body: the expanded view of the
// input. open: start expanded. Icons are shell-ish marks (< reads, > writes,
// & runs in the background…) drawn in the mono font.
export const TOOLS = {
  shell: { name: 'Shell', icon: '$', summary: (i) => i.command, body: (i) => code(i.command, 'bash') },
  apply_patch: { name: 'Patch', icon: '±', summary: (i) => (i.changes || []).map((c) => short(c.path)).join(', '),
    body: (i) => code((i.changes || []).map((c) => `${c.path}\n${c.diff}`).join('\n'), 'diff') },
  web_search: { name: 'Search', icon: '?', summary: (i) => i.query },
  view_image: { name: 'Image', icon: '<', summary: (i) => short(i.path) },
  generate_image: { name: 'Image', icon: '>', summary: (i) => i.prompt },
  agent: { name: 'Agent', icon: '&', summary: (i) => i.prompt || i.tool },
  Bash: { icon: '$', summary: (i) => i.description || i.command, body: (i) => code(i.command, 'bash') },
  Read: { icon: '<', summary: (i) => short(i.file_path) },
  Write: { icon: '>', summary: (i) => short(i.file_path), body: (i) => code(i.content) },
  Edit: { icon: '±', summary: (i) => short(i.file_path), body: (i) => diff(i.old_string, i.new_string) },
  MultiEdit: { icon: '±', summary: (i) => short(i.file_path), body: (i) => h('div', {}, (i.edits || []).map((e) => diff(e.old_string, e.new_string))) },
  NotebookEdit: { icon: '±', summary: (i) => short(i.notebook_path) },
  Glob: { icon: '*', summary: (i) => i.pattern },
  Grep: { icon: '/', summary: (i) => `${i.pattern}${i.path ? ` · ${short(i.path)}` : ''}` },
  WebFetch: { icon: '@', summary: (i) => i.url },
  WebSearch: { icon: '?', summary: (i) => i.query },
  Task: { icon: '&', summary: (i) => i.description },
  Agent: { icon: '&', summary: (i) => i.description },
  TodoWrite: { icon: '#', summary: (i) => todoSummary(i.todos), body: (i) => todos(i.todos), open: true },
  // The server's own tools (lib/slack.js), through its MCP bridge.
  mcp__mothership__slack_conversations: { name: 'Slack', icon: '#', summary: (i) => (i.query ? `conversations · ${i.query}` : 'conversations') },
  mcp__mothership__slack_read: { name: 'Slack', icon: '<', summary: (i) => `read ${i.conversation}${i.thread_ts ? ' · thread' : ''}` },
  mcp__mothership__slack_recent: { name: 'Slack', icon: '<', summary: (i) => `recent · ${i.hours || 24} h` },
  mcp__mothership__slack_search: { name: 'Slack', icon: '?', summary: (i) => `search · ${i.query}` },
  mcp__mothership__slack_send: { name: 'Slack', icon: '>', summary: (i) => `send · ${i.text}`, body: (i) => code(`to: ${i.conversation}${i.thread_ts ? ` (thread ${i.thread_ts})` : ''}\n\n${i.text}`) },
};

// What a tool is called on screen.
export const toolName = (name) => TOOLS[name]?.name || name;

function diff(before = '', after = '') {
  const lines = [...before.split('\n').map((l) => ['del', `- ${l}`]), ...after.split('\n').map((l) => ['add', `+ ${l}`])];
  return h('pre', { class: 'code diff' }, lines.map(([cls, text]) => h('span', { class: cls, textContent: `${text}\n` })));
}

function todoSummary(list = []) {
  return `${list.filter((t) => t.status === 'completed').length}/${list.length} tasks`;
}

function todos(list = []) {
  const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
  return h(
    'ul',
    { class: 'todos' },
    list.map((t) => h('li', { class: t.status }, h('span', { textContent: mark[t.status] || '☐' }), ` ${t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}`)),
  );
}

function toolCard(block) {
  const spec = TOOLS[block.name] || { icon: '•', summary: (i) => firstString(i) };
  const input = block.input || {};
  const body = h('div', { class: 'tool-body', hidden: !spec.open });
  body.append(spec.body ? spec.body(input) : code(JSON.stringify(input, null, 2), 'json'));
  const head = h(
    'button',
    { class: 'tool-head', type: 'button', onclick: () => (body.hidden = !body.hidden) },
    h('span', { class: 'tool-icon', textContent: spec.icon }),
    h('span', { class: 'tool-name', textContent: toolName(block.name) }),
    h('span', { class: 'tool-sum', textContent: spec.summary(input) || '' }),
    h('span', { class: 'tool-state' }),
  );
  const card = h('div', { class: 'tool', dataset: { state: 'running', tool: block.name } }, head, body, h('div', { class: 'tool-images' }), h('div', { class: 'sub' }));
  card.body = body;
  return card;
}

function fillToolResult(card, item) {
  card.dataset.state = item.isError ? 'error' : 'done';
  const text = item.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  const images = item.content.filter((c) => c.type === 'image');
  if (text) {
    const pre = code(text);
    pre.classList.add('result');
    card.body.append(h('div', { class: 'tool-result-label', textContent: item.isError ? 'Error' : 'Output' }), pre);
    if (item.isError) card.body.hidden = false;
  }
  // Images are shown even with the card collapsed.
  if (images.length) card.querySelector('.tool-images').append(gallery(images.map((i) => ({ url: i.url }))));
}

// ------------------------------------------------------------------ thread

export class Thread {
  constructor(el) {
    this.el = el;
    this.reset();
  }

  reset() {
    this.el.replaceChildren();
    this.el.style.counterReset = '';
    this.seen = new Set();
    this.tools = new Map(); // tool_use id -> card
    this.drafts = new Map(); // `${msg}:${index}` -> { el, kind, text, parent }
    this.finals = new Set(); // keys whose final block is already shown
    this.turn = null;
    this.frame = 0;
  }

  // Where assistant content goes: the current turn, or a tool card's
  // sub-list for things a subagent did.
  container(parent) {
    const card = parent && this.tools.get(parent);
    if (card) return card.querySelector('.sub');
    if (!this.turn) this.newTurn();
    return this.turn.assistant;
  }

  newTurn() {
    const assistant = h('div', { class: 'assistant' });
    const el = h('section', { class: 'turn' }, assistant);
    this.el.append(el);
    this.turn = { el, assistant };
    return this.turn;
  }

  add(item) {
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    switch (item.t) {
      case 'user': {
        const turn = this.newTurn();
        turn.el.prepend(turnHead(item), userMessage(item));
        break;
      }
      case 'block':
        this.addBlock(item);
        break;
      case 'tool_result': {
        const card = this.tools.get(item.toolUseId);
        if (card) fillToolResult(card, item);
        break;
      }
      case 'result':
        this.container(null).append(resultLine(item));
        break;
      case 'system':
        this.el.append(h('div', { class: `note ${item.level || ''}`, textContent: item.text }));
        break;
    }
  }

  // History comes a page at a time (lib/chat.js historyPage), newest first.
  // turnsBefore: prompts before the page, so the turns keep their numbers.
  numberFrom(items, turnsBefore) {
    // A page that starts mid-reply opens on that turn's tail, which counts
    // as the turn it belongs to.
    const mid = items[0] && items[0].t !== 'user';
    this.el.style.counterReset = `turn ${Math.max(0, turnsBefore - (mid ? 1 : 0))}`;
  }

  // An older page goes above what's shown.
  prepend(items, turnsBefore) {
    const older = new Thread(document.createElement('div'));
    for (const item of items) older.add(item);
    // The tail of a turn this page cut off joins the rest of that turn.
    const tail = this.el.firstElementChild;
    if (older.turn && tail?.matches('.turn') && !tail.querySelector(':scope > .turn-head')) {
      older.turn.assistant.append(...tail.querySelector(':scope > .assistant').childNodes);
      tail.remove();
      if (this.turn?.el === tail) this.turn = older.turn; // still running: replies go on there
    }
    this.el.prepend(...older.el.childNodes);
    for (const id of older.seen) this.seen.add(id);
    for (const key of older.finals) this.finals.add(key);
    for (const [id, card] of older.tools) this.tools.set(id, card);
    this.numberFrom(items, turnsBefore);
  }

  addBlock({ msg, index, block, parent }) {
    const key = `${msg}:${index}`;
    const draft = this.drafts.get(key);
    let el;
    if (block.type === 'text') el = renderMarkdown(block.text);
    else if (block.type === 'thinking') el = h('details', { class: 'thinking' }, h('summary', { textContent: 'Thinking' }), renderMarkdown(block.text));
    else if (block.type === 'tool_use') {
      el = toolCard(block);
      this.tools.set(block.id, el);
    } else return draft?.el?.remove();
    // A draft may not be painted yet (its last delta and the final block can
    // land in the same frame): then there's nothing to replace.
    if (draft?.el?.isConnected) draft.el.replaceWith(el);
    else this.container(parent).append(el);
    this.drafts.delete(key);
    this.finals.add(key);
  }

  // Streaming: drafts are placeholders replaced by the final block.
  live(ev) {
    const key = `${ev.msg}:${ev.index}`;
    if (ev.t === 'start') {
      if (this.finals.has(key)) return; // a stale draft (e.g. from a history snapshot)
      const draft = { kind: ev.kind, text: ev.text || '', parent: ev.parent, el: null };
      this.drafts.set(key, draft);
      if (ev.kind === 'tool_use') {
        draft.el = h('div', { class: 'tool pending' }, h('div', { class: 'tool-head' }, h('span', { class: 'tool-icon', textContent: TOOLS[ev.name]?.icon || '•' }), h('span', { class: 'tool-name', textContent: toolName(ev.name) }), h('span', { class: 'tool-sum', textContent: 'preparing…' })));
        this.container(ev.parent).append(draft.el);
      }
      if (draft.text) this.paint(draft);
    } else if (ev.t === 'delta') {
      const draft = this.drafts.get(key);
      if (!draft) return;
      draft.text += ev.text;
      this.schedule(draft);
    } else if (ev.t === 'drop') {
      this.drafts.get(key)?.el?.remove();
      this.drafts.delete(key);
    }
  }

  // Re-render streamed markdown at most once per frame.
  schedule(draft) {
    draft.dirty = true;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      for (const d of this.drafts.values()) if (d.dirty) this.paint(d);
    });
  }

  paint(draft) {
    draft.dirty = false;
    if (draft.kind !== 'text' && draft.kind !== 'thinking') return;
    const el = draft.kind === 'text' ? renderMarkdown(draft.text) : h('details', { class: 'thinking', open: true }, h('summary', { textContent: 'Thinking…' }), renderMarkdown(draft.text));
    el.classList.add('draft');
    if (draft.el?.isConnected) draft.el.replaceWith(el);
    else this.container(draft.parent).append(el);
    draft.el = el;
  }
}

// "01 ──── 14:32" above each prompt (the number comes from a CSS counter).
function turnHead(item) {
  const d = new Date(item.ts);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = d.toDateString() === new Date().toDateString() ? '' : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · `;
  return h('div', { class: 'turn-head' }, item.ts ? h('time', { dateTime: d.toISOString(), textContent: `${day}${time}` }) : null);
}

function userMessage(item) {
  const images = item.attachments.filter((a) => a.mediaType.startsWith('image/'));
  const files = item.attachments.filter((a) => !a.mediaType.startsWith('image/'));
  return h(
    'div',
    { class: 'user-msg' },
    images.length ? gallery(images.map((a) => ({ url: a.url, name: a.name }))) : null,
    files.length ? h('div', { class: 'files' }, files.map((f) => h('a', { class: 'file-chip', href: f.url, target: '_blank', textContent: f.name }))) : null,
    item.text ? h('div', { class: 'user-text', textContent: item.text }) : null,
  );
}

function resultLine(item) {
  if (item.interrupted) return h('div', { class: 'turn-meta interrupted', textContent: 'interrupted' });
  if (item.error) return h('div', { class: 'turn-meta error', textContent: `Error: ${item.error}` });
  const secs = item.durationMs ? (item.durationMs / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) : null;
  return h('div', { class: 'turn-meta', textContent: secs ? `done · ${secs}s` : 'done' });
}

