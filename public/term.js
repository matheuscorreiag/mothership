// A terminal view: xterm.js attached to a tmux tab over /ws/tabs/<id>
// (lib/terminal.js), shown in the chat's panel (⌘J). Each view is its own tmux
// client: closing it only detaches.

import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { h, narrow, accentFor, toHex } from '/ui.js';

function themeFor(hue) {
  const accent = toHex(accentFor(hue));
  const background = toHex(`oklch(0.13 0.011 ${hue})`); // --code-bg in base.css
  return { background, foreground: toHex(`oklch(0.93 0.01 ${hue})`), cursor: accent, cursorAccent: background, selectionBackground: `${accent}55` };
}

// hue: its accent (xterm needs sRGB, hence toHex). onStatus('connecting' |
// 'online' | 'offline'). beforeRetry: awaited before reconnecting, so the page
// can learn whether the tab is still there (and set view.gone if not).
export function termView({ id, hue, parent, onStatus = () => {}, beforeRetry = async () => {} }) {
  const el = h('div', { class: 'term' });
  parent.append(el);
  const term = new Terminal({
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    fontSize: narrow() ? 12 : 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 2000,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    theme: themeFor(hue),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(el);

  const view = {
    id,
    el,
    term,
    ws: null,
    status: 'connecting',
    retries: 0,
    timer: null,
    gone: false,
    send(msg) {
      if (view.ws?.readyState === WebSocket.OPEN) view.ws.send(JSON.stringify(msg));
    },
    connect,
    setHue(hue) {
      term.options.theme = themeFor(hue);
    },
    // Only while it's shown: each fit resizes the tmux session.
    refit() {
      if (!el.getClientRects().length) return;
      try {
        fit.fit();
      } catch {}
    },
    // Phones drop sockets while asleep: reconnect when the page is back.
    wake() {
      if (!view.gone && view.ws?.readyState !== WebSocket.OPEN && view.ws?.readyState !== WebSocket.CONNECTING) connect();
    },
    destroy() {
      view.gone = true;
      clearTimeout(view.timer);
      view.ws?.close();
      term.dispose();
      el.remove();
    },
  };
  const setStatus = (status) => {
    view.status = status;
    onStatus(status);
  };
  term.onData((d) => view.send({ t: 'i', d }));
  term.onResize(({ cols, rows }) => view.send({ t: 'r', cols, rows }));

  function connect() {
    clearTimeout(view.timer);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/tabs/${id}?cols=${term.cols}&rows=${term.rows}`);
    view.ws = ws;
    setStatus('connecting');
    ws.onopen = () => {
      view.retries = 0;
      term.reset(); // tmux redraws the whole screen on attach
      setStatus('online');
      view.refit();
    };
    ws.onmessage = (e) => term.write(e.data);
    ws.onclose = (e) => {
      if (view.ws !== ws || view.gone) return;
      view.ws = null;
      setStatus('offline');
      // 4000: the tmux client exited — usually the tab ended; beforeRetry decides.
      const delay = e.code === 4000 ? 0 : Math.min(10000, 500 * 2 ** view.retries++);
      view.timer = setTimeout(async () => {
        await beforeRetry(e.code);
        if (!view.gone && !view.ws) connect();
      }, delay);
    };
  }
  return view;
}
