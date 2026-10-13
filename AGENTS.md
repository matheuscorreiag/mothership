# AGENTS.md

Context for anyone (human or agent) changing this project. README.md covers
setup and usage; this file covers what the code is, how it fits together, the
decisions behind it and the traps already found.

## What this is

A personal, self-hosted web app that lets its owner use the **coding agent
running on their Mac** from a phone or any other device. All work (files,
commands, the office VPN, local network) happens on the Mac; other devices
only render the UI. It is reached over **Tailscale** (`tailscale serve`, tailnet
only) and runs as a **launchd** user agent.

Two pages, same look:

- `/` — **chat**: one agent process per chat, structured events (streaming
  text, tool calls, images, context and usage limits) rendered by our own UI.
- `/terminal/` — **terminals**: tmux-backed shells in the browser, plus a
  Files panel. "Back to chats" returns to `/`.

Each chat chooses **Claude Code** (`claude -p` in stream-json mode) or
**Codex** (`codex app-server`, stdio JSON-RPC v2), using the CLI's local login.
The UI and engine stay **agent-agnostic**: provider code lives in
`lib/agents/claude.js` and `lib/agents/codex.js`; `lib/agents/process.js` owns
shared process lifetime. Existing chats without an `agent` field migrate to
Claude even if the default for new chats changes.

## Product rules (from the owner)

- **Branding only at the top of the sidebar.** The app's mark and name,
  "Mothership", come first in the sidebar's top row on both pages
  (`setupBrand()` in ui.js), with Share, the status dot and the sidebar's
  toggle at the row's right end — the owner asked for that order. Agent names appear only in the agent/model picker and its default label;
  they are choices, not page branding. Each agent's real logo (the adapter's
  `icon`: Claude's mark, OpenAI's for Codex), small and gray, marks which
  agent a chat uses — beside its time in the sidebar, on the status line's
  model button and in the picker — at the owner's request. Otherwise no agent names, tab titles are the chat/terminal title, the page is "New
  chat", "Settings" (or one of its pages: "Shortcuts", "Integrations", an
  integration's name) or "Terminal".
- **Monochrome identity.** The mark (a B-2-like flying wing), the favicon, the
  menu-bar glyph and the working indicator are black, white and gray,
  geometric, Linear-like — never the chat's accent. The indicator's words
  follow the theme too (`PHRASES` in app.js: "Plotting a course",
  "Transmitting", "Arming Bash", "Deploying Bash", "Reading telemetry"…).
- **English UI**, everywhere (server error messages too). The owner talks to
  agents in Portuguese; the app itself is English.
- **Always dark.** Only the hue changes: each chat (and terminal) has its own
  hue; the accent is `oklch(0.78 0.14 <hue>)` and every surface, line and text
  color in `base.css` is derived from the same `--h` at a fixed low chroma, so
  the page is faintly tinted and any hue reads well. `setHue()` (ui.js) sets it.
- **Agent-agnostic** UI and chat engine (see Architecture).
- **Slack messages go out only when the owner asks, here.** The agents get
  Slack through the server's own tools (`lib/slack.js`), never a connector:
  a send must quote the owner's current prompt word for word and go to
  someone that prompt names. The token is pasted in Settings › Integrations ›
  Slack, not written in `config.json`.
- **Tailscale stays** as the network layer. Exposing the app publicly with a
  homemade token was discussed and rejected: the agent runs with
  `--dangerously-skip-permissions` on a machine inside the office network.
- Minimal chrome: no header bar. The sidebar toggle sits at the right end of
  the sidebar's top row when open and floats top-left when closed; the
  connection status is just a dot next to it. On this Mac only, a floating
  button at the top right opens the chat's folder in a code editor (a menu of
  the editors `lib/editors.js` finds installed; VS Code for now). The agent's folder, model and usage live in a status line
  under the composer — not the chat's name (the owner dropped it; the sidebar
  shows which chat is open).
- Look: Instrument Sans for text, Martian Mono for labels, code and readouts
  (self-hosted in `public/fonts/`); small radii, hairlines, a faint grain. The
  thread is a log — numbered prompts, the reply on a rail with tool calls as
  nodes — not chat bubbles.

## Architecture

```
browser ──HTTPS──► tailscale serve ──► server.js (127.0.0.1:7680)
                                         ├─ /ws/chat      lib/chat.js ──► agent process per chat (lib/agents/<type>.js)
                                         ├─ /ws/tabs/<id> lib/terminal.js ──► node-pty ⇄ tmux -L mothership
                                         ├─ /api/*        REST (chats, uploads, local images, tabs, files, slack)
                                         └─ static        public/ (no build step)
```

| Path | Role |
| --- | --- |
| `server.js` | HTTP + WebSocket wiring, access checks, static files |
| `lib/config.js` | `config.json` loading/defaults, shared helpers (auth, origin check, this-Mac check, env cleaning) |
| `lib/power.js` | on / off: the keep-awake assertion (`caffeinate -i -w <pid>`) and the `off` marker |
| `lib/network.js` | `GET /api/network` for the sidebar's Share button: the `tailscale serve` URL that proxies to our port, the tailnet name and IPs (tailscale CLI, cached 15 s) |
| `lib/chat.js` | chats: processes, queue, interrupt, persistence, broadcast, uploads/media, accent hues |
| `lib/agents/claude.js` | **the only Claude-specific code**: CLI args, message encoding, interrupt, event parsing, labels |
| `lib/agents/index.js` | adapter registry by `agent.type` |
| `lib/slack.js` | Slack: the owner's token (`/api/slack`), the agents' Slack tools and the rule every send is checked against |
| `lib/editors.js` | "Open in…": the chat's folder in a code editor on this Mac (`POST /api/open-in`); the editors this Mac has, by bundle id |
| `lib/mcp-bridge.js` | the stdio MCP server each chat's agent runs: relays `tools/list` / `tools/call` to `/api/agent/tools` with the chat's key |
| `lib/terminal.js` | tmux tabs + file API (list/read/write/mkdir/rename/trash) + PTY WebSocket |
| `public/base.css`, `public/ui.js` | **shared by both pages**: fonts, tokens, sidebar, item rows, menus, inline rename, status dot, page tint (`setHue`), accents, `api()`, `h()` |
| `public/index.html`, `app.js`, `style.css` | chat page (state, WebSocket, usage, settings page, composer) |
| `public/render.js` | chat items → DOM (markdown, tool cards via `TOOLS`, images, streaming drafts) |
| `public/loader.js` | the "working" indicator (small, swappable contract) |
| `public/terminal/*` | terminal page |
| `public/terminal/editor.js` | the Files editor: CodeMirror 6, loaded on the first open; languages by file name or `#!` line |
| `bin/mothership` | open the same tmux tabs over SSH |
| `scripts/launchd.sh` | install / start / stop / restart / uninstall the launchd agent |
| `macos/` | the macOS app (Swift package, `build.sh`); see below |

### Chat engine

- Each chat stores its immutable `meta.agent` (`claude` or `codex`), selected
  before its first message. `agent.type` supplies the new-chat default;
  `agents.claude` / `agents.codex` optionally override provider config without
  sharing provider-specific flags. Model discovery runs asynchronously and
  comes from Codex `model/list`, including each model's effort levels.
- One long-lived agent process per chat, JSON lines over stdin/stdout. Stopped
  after `agent.idleMinutes`; the next message respawns it with `--resume
  <sessionId>` (also works after restarts).
- The adapter's parser turns raw agent events into **neutral events**
  (`session`, `draft-start`, `draft-delta`, `block`, `tool-result`, `context`,
  `limits`, `result`, `notice` — documented at the top of `claude.js`).
  `chat.js` turns those into **items** appended to
  `~/.mothership/chats/<id>/events.jsonl` and broadcast to every socket watching
  the chat. Live-only events (drafts) are not persisted.
- **History is paged** (`historyPage()`): `open` answers with the last ~100
  items (`more`, `turnsBefore` — prompts before the page, so turns keep their
  numbers — and the last `prompts` for ↑); the page asks `{ op: 'older',
  before: <oldest item id> }` as it scrolls near the top. A page starts at a
  prompt or mid-reply at a top-level block while no tool call waits for its
  result (`pageStarts()`), so a result never lands in a page without its card;
  `Thread.prepend()` (render.js) joins a cut turn's tail to its start. Long
  agent turns are hundreds of items, so pages can't be whole turns.
- **`/clear`** is handled by `chat.js`, for every adapter: the message isn't
  sent to the agent. The process is retired, `sessionId` / context dropped
  (the next message starts a new session, no `--resume`), `events.jsonl` moves
  to `events-<ts>.jsonl` in the chat's folder (kept, not shown) and watchers
  get `{ op: 'cleared' }` plus a "Conversation cleared" note. Queued behind a
  running turn, it waits its turn like a message. The folder stays: the agent's
  current folder (asked afresh, `workingDir()`) becomes the chat's `dir`, so
  the new session and every process after it start there — the owner doesn't
  want `/clear` to send the agent back to where the chat began.
- Messages sent while a turn runs go to an in-memory **queue**; one socket's
  messages are processed in order (so "stop" can't overtake "send").
- Per chat meta (`meta.json`): title, hue, sessionId, model, modelLabel,
  context `{ used, window }`, settings `{ model, effort }` (null = default),
  dir (where its agent starts — a terminal's "New chat in this folder", which
  opens `/?dir=<folder>`, or where the agent was at its last `/clear`; absent
  = `agent.cwd`; every process of a session starts there, as `--resume` finds
  sessions by folder),
  cwd (the agent's folder now; Claude: the last `cwd` stamp in its own
  session log, `~/.claude/projects/*/<sessionId>.jsonl` — the stream only
  reports the starting one), pinned (its place in Pinned, from 1; absent =
  not pinned), archived (since when; absent = in the list), doneAt / readAt. Account-wide usage windows: `~/.mothership/limits.json`, keyed by provider
  (the old unkeyed file migrates to Claude).
- **Model / effort**: the chat's settings become the adapter's `--model` /
  `--effort` when its process spawns. A process keeps its flags, so changing
  them retires it (`retire()`: detach, then end stdin) — at once if idle, at
  the end of the turn otherwise — and the next message resumes the session
  with the new ones. Until the new process reports its model, `modelLabel` is
  the choice's label.
- **Unread**: `unread = doneAt > readAt`, where doneAt is set when a turn ends.
  It's read when a socket that has the chat open is visible (the page sends
  `{ op: 'visibility' }` on connect and on visibilitychange) — at turn end,
  on `open`, or when the page becomes visible. Shared by every device.
- **Archived** (`setArchived()`; ⋯ › Archive / Unarchive, `PATCH { archived }`):
  the chat leaves the sidebar's list, its numbers (⌘1–9) and Pinned, and is
  never `unread` — so no notice, badge, title count or macOS notification,
  with no client changes (they all read `unread`). The sidebar foot's
  Archived button (shown while there are any) or ⇧⌘A swaps the list for the archived
  ones and back; opening a chat from the list swaps it back. It stays archived
  (and silent) while it's written in and replies — the owner asked; only
  Unarchive brings it back, counting what it said meanwhile as read.
- Images from tool results are saved content-addressed in `~/.mothership/media/`;
  uploads go there too. Attachments are passed to the agent as image blocks
  (png/jpeg/gif/webp) and always also by path.

### Slack

- The owner creates a Slack app from the manifest Settings › Integrations ›
  Slack (`#settings/integrations/slack`) offers — user scopes only, listed in `SCOPES` — and pastes
  its user token (`xoxp-`) there. `PUT /api/slack` checks it with `auth.test`
  and saves it in `~/.mothership/slack.json` (0600); no response ever carries
  it. `DELETE` forgets it. A token keeps its string when the app is
  reinstalled with more scopes, so `GET` asks `auth.test` again (every 30 s at
  most) and the page warns about missing scopes, with the token field back in
  case Slack did issue a new one.
- While connected, every agent process gets the `mothership` MCP server
  (`lib/mcp-bridge.js`, through the adapter's `mcpServers`) with tools
  `slack_conversations`, `slack_read`, `slack_recent` (messages to the owner
  and mentions of them, last N hours), `slack_search` (Slack's search syntax)
  and `slack_send`. The last two read through `search.messages`, which takes
  dates, not times: `slack_recent` asks from the day before and trims. The bridge holds nothing:
  it posts to `/api/agent/tools` with the chat's random key (`chat.key`, in
  memory), only accepted straight from localhost. Connecting or disconnecting
  retires the processes so the next one gets the new tool list.
- **The send rule** (`sendRefusal()`): the prompt the running turn answers
  (`chat.turn`, set in `dispatch`, cleared in `endTurn`) must contain the
  text word for word (whitespace aside, not cut mid-word) and name the
  recipient outside that text (a person's full, first, display or handle
  name, accents and case aside; a channel's name). Each text goes to each
  conversation once per prompt. No turn running: refused. Every send and
  refusal is logged.
- The claude.ai Slack connector, if the account has one, is loaded into every
  Claude Code session and sends anything: the Claude adapter removes its tools
  (`--disallowedTools=mcp__claude_ai_Slack`). Any other Slack MCP server added
  to Claude Code would get around the rule too.
- Tests point `MOTHERSHIP_SLACK_API` at a fake Slack Web API.
- **Settings pages** (app.js): `SETTINGS` maps each `#settings/<page>` to its
  title and the page its back button returns to; each page is a
  `.settings-page[data-page]` in index.html. Integrations is a list built from
  `INTEGRATIONS` — a new one adds an entry there (its `load()` fills its page
  and returns `{ connected, note }` for its row), a `SETTINGS` entry and its
  page.

### Adding another agent

Register a factory in `lib/agents/index.js`. Each adapter exports `name`,
`spawnArgs`, `models` / `efforts`, and either the Claude-style
`userMessage` / `interruptMessage` / `createParser`, or
`createConnection({ write, emit, sessionId, cwd, systemPrompt, model, effort })`
returning `receive(raw)`, `send({ text, images })`, `interrupt()` and `close(error)`.
`lib/agents/process.js` spawns and cleans up the process. Async initialization
never blocks the chat socket, so Stop works during startup. Optional `icon` is a 24×24 SVG
path (the company's mark; `agentMark()` in app.js draws it). Optional `discover()`
refreshes the models; `defaultModel` identifies the default model's effort
choices. `currentDir(sessionId)` can refresh the status line's folder; adapters
may also emit `{ kind: 'cwd', cwd }`.

Codex initializes the App Server, starts/resumes its saved thread, starts turns,
and interrupts by thread/turn ID. It uses `approvalPolicy: never` and
`danger-full-access`, matching the existing trusted local execution model.
Account apps are disabled; Mothership's MCP bridge supplies checked Slack tools.
Other manually configured MCP servers carry the same caveat as Claude's.
Unsupported interactive requests are declined with a chat notice. Codex native
items become neutral text/thinking/tool events; the renderer knows generic
shell, patch, search and image cards. `npm test` runs fake-CLI protocol and
isolated-server tests; live CLI validation uses scratch data and port 7681.

### Terminals

- Each tab is a tmux session `mothership-<8 hex>` on the dedicated socket
  `tmux -L mothership` (config: `tmux.conf`), running a login shell. Tabs survive
  browser disconnects and can be attached from several devices (`window-size
  latest`).
- Titles: user-set `@mothership_title` wins, else the program's terminal title, else
  the folder name. Tab accent hue is derived from the id (no stored color).
- Pinned: the session option `@mothership_pinned` (its place, from 1 — tmux's `#{?}`
  reads 0 as false). `bin/mothership` lists in the same order as the sidebar.
- The Files API is confined to `config.root` (symlinks resolved); "delete" moves
  to the macOS Trash.

### macOS app

- `macos/` builds `Mothership.app` (`macos/build.sh`; SwiftPM, no Xcode project). It
  is a client like a browser: a WKWebView on the panel's URL (This Mac =
  `http://127.0.0.1:7680`, or another Mac's Tailscale URL), so the UI stays one
  codebase. Native code only adds what a tab can't do. The bundle has to be
  called something ("Mothership"); the UI inside still shows no name. The title bar
  shows no title (`titleVisibility = .hidden`) — the chat and its folder are
  in the status line; the window's title stays the app's name, never the open
  chat's, for the Window menu and Mission Control. Its icon is
  `macos/AppIcon.svg` (drawn on Apple's 1024 grid: a flying wing after the
  B-2, seen from above — every edge parallel to one of the two leading edges,
  the sawtooth trailing edge — its right half lit and its left half in shade,
  in grays on near-black, Linear-like; no color on purpose); the menu-bar
  glyph is the same wing drawn in code (`StatusMenu.glyph()`, the shaded half
  at partial alpha). The web favicon (`public/icon.svg`) is the same wing,
  larger, on a rounded square, and the working indicator (`loader.js`) is the
  wing again: a light sweeps across it, and contrails stream from it while a
  tool runs — in grays too, whatever the chat's accent.
- The page knows it's inside through the `mothership` message handler (`native` in
  ui.js: standalone-style ⌘N hints, and it posts `{ op: 'power', on }`). The
  app's own pages ("Not running") post `start` / `retry`.
- **Shortcuts**: the page gets ⌘-keys first (WKWebView hands key equivalents to
  the focused page before the menus); every page shortcut also has a menu item
  that dispatches the same keydown into the page, so the page's tables stay
  the source of truth. Add new page shortcuts to `mainMenu()` too.
- **Notifications / badge** come from the app's own `/ws/chat` socket (the
  same `chats` broadcast), not the page, so they work on the terminal page and
  with the window closed. That socket never sends `visibility`, so it never
  marks a chat read. In front, the page's notice covers it (no banner).
- Closing the window hides it; external links and `target=_blank` open in the
  default browser; confirm/prompt/file inputs/downloads get native panels.
- **Test**: `macos/build.sh --debug` builds `Mothership-debug.app` (own bundle id) with
  `SelfTest.swift`; run `macos/.build/Mothership-debug.app/Contents/MacOS/Mothership -selfTest
  <dir> -localPort 7681` against a test server. It sends real ⌘-key events
  through AppKit, flips the power switch, goes through the native confirm and
  writes `results.txt` plus snapshots (screen capture isn't available to an
  agent, the web view's snapshot is). It refuses port 7680. A window and a
  menu-bar icon appear while it runs. `-launchdLabel com.example.none` plays a
  Mac without a server (the "Connect to Another Mac…" page).
- **Releases**: bump `macos/VERSION`, commit and push, then `macos/release.sh`
  builds a universal (arm64 + x86_64) `Mothership.app`, zips it with `ditto` (keeps the
  bundle and signature) and creates the GitHub release `macos-v<VERSION>` with
  the zip. Ad hoc signed: downloads need "Open Anyway" once; notarizing would
  need a paid Apple developer account.

## Conventions

- Node ≥ 20, ESM, **no build step, no framework**: vanilla JS modules served
  as-is; vendor libs (xterm, marked, DOMPurify) are mapped from `node_modules`
  in `server.js`. CodeMirror is many packages importing each other by name:
  the terminal page's import map sends `@codemirror/…`, `@lezer/…` (and a few
  others) to `/vendor/npm/`, which resolves them like Node (the package's
  `exports`) and redirects to the real file. New packages there need adding to
  both the import map and `NPM_PACKAGES`.
- Prettier-like style: 2 spaces, single quotes, semicolons, ~150 cols. Comments
  explain *why*, sparingly, in the file's existing voice.
- Anything both pages need goes in `base.css` / `ui.js`, not copied.
- Sidebar items are rendered **in place, keyed by id** (rebuilding them breaks
  double-click rename and focus). Hold re-renders while an inline rename is
  open, and while an item is being dragged (`pinning.dragging`).
- **Pinned** (both pages): `setupPinning()` in ui.js builds the section above
  the page's list and does the dragging — pointer events, not HTML5 drag and
  drop (which phones don't do); a mouse drags past 5px, a finger after holding
  still for 450ms, so a swipe still scrolls. The page renders pinned items
  into `pinning.nav` and gets `onDrop(id, index | null)`; it sends the whole
  pinned order (`PUT /api/chats/pinned` / `/api/tabs/pinned` `{ ids }`) and
  applies it locally at once. Lists come sorted from the server — pinned
  first, by place — so ⌘1–9 and the numbers count pinned items first.
- Confirmations and one-line prompts use `ask()` (ui.js), not `confirm()` /
  `prompt()`: the app's look, Enter / Esc / click outside, focus kept inside,
  page ⌘-shortcuts held while it's open. Delete chat (⇧⌘D and the ⋯ menu) and
  rename (⇧⌘E) use it; older `confirm()` calls (terminal page, Turn off) can
  move to it.
- Recent messages (↑ / ↓ / Tab in an empty message box, app.js `remember` /
  `suggest`) come from the open chat's `user` items — the `prompts` sent with
  its last page plus live items — so nothing extra is stored; the suggestion
  is the textarea's placeholder, never its value.
- **Scroll position** (app.js): at the bottom, the thread follows new content.
  Elsewhere, the first item starting below the middle of the screen is the
  anchor (`holdAnchor()` on every scroll) and `followAnchor()` undoes any move
  of it — on an older page, images loading above, `#older` hiding. Native
  scroll anchoring is off (`overflow-anchor: none` on `#messages`): Safari
  doesn't have it and in Chrome it fought ours (double corrections) and still
  missed lazy images loading just above the screen.
- The sidebar's width is `--side-w` (base.css). Dragging its right edge
  (`setupResize()` in ui.js, desktop only) overrides it on `<html>`, clamped to
  264–520px (264: the top row — mark, name, Share, dot, toggle — fits whole), and saves it in localStorage `ui:sidebarWidth` for both pages.
  Size sidebar content against `--side-w`, never a fixed 272px.
- Shortcuts are one table per page (chat: `SHORTCUTS` in `app.js`, also drives
  Settings › Shortcuts). Chat: ⌘1–9, ⌘B, ⌘J, ⌘K, ⌘/, ⇧⌘E rename, ⇧⌘D delete
  (not ⌘⌫, the Mac's usual delete: in the message box it erases the line;
  not ⇧⌘R, the browser's hard reload), ⇧⌘P pin / unpin (also on the
  terminal page), ⇧⌘A archived chats ↔ the list. Terminal: ⌘1–9, ⌘B, ⌘E
  — off macOS the terminal page uses Ctrl+Shift for B / E because plain
  Ctrl+B/E belong to the shell. 1–9 (the sidebar's items) are the same keys
  on both pages, ⌘1–9 / Ctrl+1–9 (`itemNumber()` / `itemKey()` in ui.js) — the
  owner wants switching to feel the same in chats and terminals. Both: N =
  new chat / terminal, T = chats ↔ terminal, via
  `appKey()` / `isAppKey()` in ui.js: plain ⌘N / ⌘T in the macOS app or an
  installed app window (`standalone`), ⇧⌘N / ⇧⌘T in a browser
  (Ctrl+Shift+N / T off macOS); either form matches. The owner chose these over
  ⌃⌘ — no Control or Option combos. Caveat: a plain Chrome tab keeps ⌘N/⌘T/⌘W
  and ⇧⌘N/⇧⌘T/⇧⌘W (new window/tab, incognito, reopen tab) and pages can't
  take them; only app windows get them. In the macOS app ⌘W closes (hides) the
  window.
- Holding ⌘ (Ctrl off macOS) sets `body.show-keys` (ui.js) and shows key
  hints, styled `.kbd` in base.css: ⌘1–9 on sidebar items, ⌘K on the message
  box while it isn't focused (`#input-key`; focused, ⌘C / ⌘V would flash it).

## Security model

- Server binds `127.0.0.1` only; remote access only via `tailscale serve`.
  Never `tailscale funnel` or `host: 0.0.0.0`.
- `config.allowedLogins` checks the `Tailscale-User-Login` header that
  `tailscale serve` injects.
- **Turn off / on** (`POST /api/turn-off`, `/api/turn-on`) only work from a
  browser on the Mac itself, and the buttons only show there (`thisMac` in
  `/api/config`): `fromThisMac()` compares the client address — `X-Forwarded-For`, which
  `tailscale serve` overwrites with the client's tailnet IP, or the peer for
  direct localhost requests — with this machine's own interface addresses.
- **Open in…** (`POST /api/open-in`) runs `open -b <editor> <folder>`, so it
  too only works from a browser on this Mac (`fromThisMac()`); `/api/config`
  lists editors only there, and the button shows only when it has some. The
  folder must be an existing absolute path.
- The Share popover (the button next to the status dot, `setupShare()` in
  ui.js, both pages) shows the tailnet name, IPs and serve URL, computed at
  runtime — they still never go in tracked files. It flags Tailscale Funnel
  if it's on.
- Cross-site protection: `Origin`/`Sec-Fetch-Site` checks on API and WebSocket
  upgrades, plus a required `X-Mothership: 1` header on every write.
- Media and `/api/local-image` (images under `$HOME` only) are served with a
  sandboxing CSP and `nosniff`.
- Slack (see Architecture): the token lives in `~/.mothership/slack.json`,
  readable by anything running as the owner — the agent's shell included.
  The send rule keeps the agent from being talked into sending; it can't stop
  an agent that's already been turned into reading the file and calling Slack
  itself (the risk `--dangerously-skip-permissions` already carries).
- `config.json` (has the owner's Tailscale login) is gitignored — never commit
  it. Don't put the tailnet hostname/URL in tracked files.

## Run, test, deploy

```bash
npm install                       # postinstall fixes node-pty's spawn-helper permissions
npm start                         # uses config.json (port 7680)
```

**Test against an isolated server, not production.** Use a separate config
with a cheap model and a scratch data dir:

```json
{ "port": 7681, "dataDir": "/tmp/mothership-test/data", "agent": { "type": "claude", "model": "haiku", "idleMinutes": 1 } }
```

```bash
MOTHERSHIP_CONFIG=/path/to/test-config.json node server.js
```

- Drive the UI with headless Chrome over CDP (`--remote-debugging-port`,
  temporary `--user-data-dir`) and check behavior with real input events
  (`Input.dispatchKeyEvent`/`dispatchMouseEvent`), plus screenshots at desktop
  and 390×844 phone size (emulation resets when the CDP connection closes —
  emulate, measure and screenshot in one session).
- **The tmux socket is shared** between the test and production servers. The
  owner may have terminals open: only touch tabs you created, and close them
  afterwards.

**Deploy:**

- Files under `public/` are read from disk on every request — front-end changes
  are live on reload, no restart needed.
- Server changes (`server.js`, `lib/`) need `scripts/launchd.sh restart`. A
  restart kills running agent processes: **first check that no chat is running**
  (`curl -s http://127.0.0.1:7680/api/chats` → every `status` is `idle`).
- Logs: `~/Library/Logs/mothership.log`.
- **On / off** is a state of the running server, not of the process: a page
  can't start a stopped server, so off keeps the process up (idle) and only
  drops the keep-awake assertion, stops agents and closes every socket. While
  off, the API (except `/api/config` and the switches), media and WebSockets
  answer 503; static files still load, and the pages show the "Turned off"
  screen (the terminal page sends you to it). The server holds the assertion
  itself (`lib/power.js`), so the launchd plist runs plain `node` — re-run
  `scripts/launchd.sh install` if an old plist still wraps it in `caffeinate`.
- `scripts/launchd.sh stop` / `start` stop the process entirely (disable +
  bootout, so neither KeepAlive nor the next login restarts it).
  `MOTHERSHIP_LABEL=<other label>` makes the script manage another job with its own
  plist and log — test launchd changes that way, with a config on another port.

## Gotchas already hit

- **tmux targets**: use `=name` for session commands and `=name:` for pane
  commands (`set-option`, `send-keys`, `paste-buffer`); the bare `=name` form
  fails there.
- **Claude CLI list flags** (`--disallowedTools`, `--mcp-config`, …) take
  several values and swallow the next argument that isn't a flag: pass one
  with `=` or keep a flag after it.
- **claude.ai connectors** (Slack, Gmail…) come into every Claude Code session
  of the account, `claude -p` included, as `mcp__claude_ai_<Name>__*`; they
  aren't in the `init` event's tool list (they load after it).
- **Claude stream-json**: one `assistant` event per finished content block
  (same message id), in stream order — block index = count per message id.
  Interrupt = `control_request` `{ subtype: 'interrupt' }`. Context = last
  main-agent `message_delta` usage (input + cache + output); window from
  `result.modelUsage[model].contextWindow` (1M for `[1m]` models). Usage limits
  come from `rate_limit_event.rate_limit_info.unifiedWindows` (`five_hour`,
  `seven_day`; utilization is 0–1).
- **Streaming drafts**: a block's last delta and its final version can land in
  the same frame, before the draft is painted (`draft.el` is null) — guard
  with optional chaining. Ignore drafts whose final block is already shown.
- **CSS `[hidden]`**: author `display` rules beat the `hidden` attribute; base
  CSS forces `[hidden] { display: none !important }`.
- **Pseudo-element sizing**: `* { box-sizing: border-box }` doesn't match
  `::before`/`::after`; give bordered pseudo-elements their own `box-sizing`
  or their borders shift anything centered by formula (the rail nodes).
- **Grid overflow**: long unbreakable titles widen `1fr` columns — use
  `minmax(0, 1fr)`.
- **iPhone Home Screen app** (`navigator.standalone`, black-translucent status
  bar): the page starts under the status bar but iOS makes it only
  `innerHeight` tall — that bar's height (47pt) short of the screen's bottom.
  The band below is not the page's: nothing can be painted there (a "fill the
  screen" attempt just cut the footer off). The home bar sits in that band, so
  `syncHeight()` (ui.js) sets `html.no-home-bar` (`--safe-bottom: 0`) then, as
  it does while the keyboard covers the home bar. The page is always exactly
  the visual viewport: `body` is `position: fixed` at `--app-top` (the
  viewport's `offsetTop` — iOS pans it to the focused field) with `--app-h`;
  `html` stays `100%`, since anything taller than the browser's viewport makes
  the page scrollable. Anything floating above the message box (`#jump`) is
  anchored to `#composer-wrap`, not a fixed `bottom`. `classList.toggle(x,
  undefined)` flips the class — pass real booleans (`navigator.standalone` is
  undefined off iOS). A different `apple-mobile-web-app-status-bar-style`
  (e.g. `black`) might make iOS size the page to the bottom; untried.
- **xterm.js colors** must be sRGB; convert `oklch()` through a canvas.
- **Keyboard capture over xterm**: page shortcuts listen on `document` in the
  capture phase and `stopPropagation()` so the terminal never sees them.
- Launched from inside another terminal/agent, child processes inherit
  `CLAUDE*`/`CMUX*`/`TMUX*` env vars — `cleanEnv()` strips them. It also
  strips internal `CODEX_*` variables (parent session, sandbox and permission
  profile), retaining only `CODEX_HOME` and `CODEX_API_KEY`. Leaking the
  parent sandbox context made the Codex tool host time out even though
  ordinary text replies worked.
- The launchd plist bakes in the current `node` path (nvm); re-run
  `scripts/launchd.sh install` after switching Node versions.
- **WKWebView**: `evaluateJavaScript` doesn't await promises (use
  `callAsyncJavaScript`); WebKit refuses some ports outright (e.g. 9), so test
  "unreachable" with a closed ordinary port; `innerText` follows CSS
  `text-transform`. Delegate methods must match the SDK's signatures exactly
  (`@MainActor @Sendable` handlers) or AppKit never calls them — a clean build
  must show no "nearly matches" warnings.
- **Typing is never rewritten** (prompts are code and commands): the message
  box (and the Files editor; CodeMirror sets them itself) carry
  `autocorrect="off" autocapitalize="off" spellcheck="false"
  writingsuggestions="false"` — the editor also leaves out auto-closing
  brackets and tags — and the macOS app registers
  `WebAutomatic{SpellingCorrection,QuoteSubstitution,DashSubstitution,
  TextReplacement}Enabled = false` (main.swift) plus `allowsInlinePredictions
  = false` — otherwise WebKit turns `"x" --y` into `“x” —y`. Each layer alone
  stops it (verified: the self-test types real keystrokes).

## Data and persistence

- `~/.mothership/chats/<id>/{meta.json,events.jsonl}` (plus `events-<ts>.jsonl`,
  what each `/clear` set aside), `~/.mothership/media/`,
  `~/.mothership/limits.json`, `~/.mothership/off` (present while turned off),
  `~/.mothership/slack.json` (the Slack token, while connected). The
  agent's own transcripts (used by `--resume`) live in `~/.claude/`.
- Survives connection drops and restarts. Lost on a hard shutdown mid-turn:
  the block being streamed and the in-memory queue. Ideas not done yet:
  persist the queue, mark turns cut by a restart, checkpoint in-progress text.

## Working with the owner

- Communicate in Portuguese; keep the app and code in English.
- Commit and push only when asked; the repo is private
  (`github.com/matheuscorreiag/mothership`).
- Verify UI changes in a real browser (desktop and phone sizes) before saying
  they work, and say what wasn't verified.
