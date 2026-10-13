// Adapter for Claude Code: drives `claude -p` in stream-json mode and turns
// its events into the agent-neutral events lib/chat.js understands:
//
//   { kind: 'session', sessionId, model, modelLabel }
//   { kind: 'draft-start', msg, index, block, name, parent }    streaming begins
//   { kind: 'draft-delta', msg, index, text }
//   { kind: 'block', msg, index, block, parent }                block: text | thinking | tool_use | null (drop draft)
//   { kind: 'tool-result', toolUseId, isError, content, parent }  content: text | { type: 'image', mediaType, data }
//   { kind: 'context', used, window }
//   { kind: 'limits', status, windows: [{ id, label, utilization, resetsAt }] }
//   { kind: 'result', ok, aborted, error, durationMs, turns }
//   { kind: 'notice', level, text }
//
// Another agent plugs in by exporting the same shape (see lib/agents/index.js).
//
// `models` and `efforts` are the per-chat choices the UI offers (null in a
// chat's settings = the CLI's own default). Aliases always resolve to the
// newest model of each family; the real one is reported by the session.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const STREAM_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
// Slack goes through the server's own tools (lib/slack.js), which only send
// what the owner wrote here. A claude.ai Slack connector on the account would
// be loaded into every session and send anything, so its tools are taken away
// ("=": the flag takes a list and would swallow the next argument).
const BLOCKED = ['--disallowedTools=mcp__claude_ai_Slack'];

const MODELS = [
  { id: 'fable', label: 'Fable', note: 'most capable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet', note: 'faster' },
  { id: 'haiku', label: 'Haiku', note: 'fastest · no effort levels', effort: false },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const LIMIT_LABELS = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d Opus', seven_day_sonnet: '7d Sonnet' };
const limitLabel = (id) => LIMIT_LABELS[id] || id;

// claude-opus-5-5[1m] -> "Opus 5.5 · 1M", claude-haiku-4-5-20251001 -> "Haiku 4.5"
function modelLabel(model) {
  if (!model) return '';
  const long = /\[1m\]$/i.test(model);
  const name = model
    .replace(/\[.*\]$/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2');
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}${long ? ' · 1M' : ''}`;
}

const guessWindow = (model) => (/\[1m\]$/i.test(model || '') ? 1_000_000 : 200_000);

function normalizeBlock(b) {
  if (b.type === 'text') return b.text ? { type: 'text', text: b.text } : null;
  if (b.type === 'thinking') return b.thinking ? { type: 'thinking', text: b.thinking } : null;
  if (b.type === 'redacted_thinking') return null;
  if (b.type === 'tool_use' || b.type === 'server_tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
  return { type: b.type };
}

function normalizeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return (content || []).map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text || '' };
    if (b.type === 'image' && b.source?.type === 'base64') return { type: 'image', mediaType: b.source.media_type, data: b.source.data };
    return { type: b.type };
  });
}

// Claude Code logs each session to ~/.claude/projects/<launch dir>/<id>.jsonl
// and stamps every entry with the shell's cwd: a `cd` inside the launch folder
// sticks (one that leaves it is reset). The newest stamp is where it works now.
const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const logs = new Map(); // session id -> its log file

async function sessionLog(sessionId) {
  if (logs.has(sessionId)) return logs.get(sessionId);
  for (const dir of await fsp.readdir(PROJECTS).catch(() => [])) {
    const file = path.join(PROJECTS, dir, `${sessionId}.jsonl`);
    if (await fsp.access(file).then(() => true, () => false)) {
      logs.set(sessionId, file);
      return file;
    }
  }
  return null;
}

// Logs carry images inline and get big: read back from the end in growing
// spans. The first "cwd" on a line is the entry's own (nested text has its
// quotes escaped); subagent entries are skipped.
async function lastCwd(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    for (let span = 64 * 1024; ; span *= 8) {
      const start = Math.max(0, size - span);
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(size - start), 0, size - start, start);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start > 0) lines.shift(); // cut mid-line
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('"isSidechain":true')) continue;
        const m = lines[i].match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (m) return JSON.parse(`"${m[1]}"`);
      }
      if (start === 0) return null;
    }
  } finally {
    await handle.close();
  }
}

export function createClaudeAgent(options) {
  return {
    name: 'Claude Code',

    // Display names (also used to relabel chats and limits saved earlier).
    limitLabel,
    modelLabel,
    models: MODELS,
    efforts: EFFORTS,

    // Where the agent works now (optional; see lastCwd).
    async currentDir(sessionId) {
      const file = sessionId && (await sessionLog(sessionId));
      return file ? lastCwd(file) : null;
    },

    // model / effort: the chat's own choice, else config.json's, else the CLI's default.
    // mcpServers: [{ name, command, args, env }], stdio MCP servers on top of the user's own.
    spawnArgs({ sessionId, systemPrompt, model, effort, mcpServers = [] }) {
      const args = [...STREAM_ARGS, ...BLOCKED, ...(options.args || [])];
      model ||= options.model;
      effort ||= options.effort;
      if (model) args.push('--model', model);
      if (effort && MODELS.find((m) => m.id === model)?.effort !== false) args.push('--effort', effort);
      if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
      if (mcpServers.length) {
        const servers = Object.fromEntries(mcpServers.map(({ name, ...server }) => [name, { type: 'stdio', ...server }]));
        args.push('--mcp-config', JSON.stringify({ mcpServers: servers }));
      }
      if (sessionId) args.push('--resume', sessionId);
      return { command: options.command || 'claude', args };
    },

    // images: [{ mediaType, data (base64) }]
    userMessage({ text, images }) {
      const content = images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }));
      if (text) content.push({ type: 'text', text });
      return { type: 'user', message: { role: 'user', content } };
    },

    interruptMessage(id) {
      return { type: 'control_request', request_id: `interrupt-${id}`, request: { subtype: 'interrupt' } };
    },

    // One parser per process: it tracks which message is streaming per lane
    // (main agent / each subagent) and how many blocks each message produced.
    createParser() {
      const liveMsg = new Map(); // parent tool use id ('' = main) -> message id
      const blockCount = new Map(); // message id -> blocks seen
      let model = null;
      let used = 0;

      return function parse(ev) {
        const parent = ev.parent_tool_use_id || null;
        switch (ev.type) {
          case 'system':
            if (ev.subtype === 'init') {
              model = ev.model;
              return [{ kind: 'session', sessionId: ev.session_id, model, modelLabel: modelLabel(model) }];
            }
            if (ev.subtype === 'compact_boundary') return [{ kind: 'notice', level: 'info', text: 'Conversation compacted' }];
            return [];

          case 'stream_event': {
            const e = ev.event;
            const lane = parent || '';
            if (e.type === 'message_start') {
              liveMsg.set(lane, e.message.id);
              return [];
            }
            const msg = liveMsg.get(lane);
            if (!msg) return [];
            if (e.type === 'content_block_start') {
              const b = e.content_block;
              return [{ kind: 'draft-start', msg, index: e.index, block: b.type, name: b.name, parent }];
            }
            if (e.type === 'content_block_delta') {
              const d = e.delta;
              const text = d.type === 'text_delta' ? d.text : d.type === 'thinking_delta' ? d.thinking : '';
              return text ? [{ kind: 'draft-delta', msg, index: e.index, text }] : [];
            }
            // The main agent's context = everything the last request sent plus what it wrote.
            if (e.type === 'message_delta' && !parent && e.usage) {
              const u = e.usage;
              used = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
              return [{ kind: 'context', used, window: guessWindow(model) }];
            }
            return [];
          }

          case 'assistant': {
            // One event per finished content block, in stream order.
            const msg = ev.message.id;
            return (ev.message.content || []).map((raw) => {
              const index = blockCount.get(msg) ?? 0;
              blockCount.set(msg, index + 1);
              return { kind: 'block', msg, index, block: normalizeBlock(raw), parent };
            });
          }

          case 'user':
            return (ev.message?.content || [])
              .filter((b) => b.type === 'tool_result')
              .map((b) => ({ kind: 'tool-result', toolUseId: b.tool_use_id, isError: Boolean(b.is_error), content: normalizeContent(b.content), parent }));

          case 'rate_limit_event': {
            const info = ev.rate_limit_info || {};
            const windows = Object.entries(info.unifiedWindows || {}).map(([id, w]) => ({
              id,
              label: limitLabel(id),
              utilization: w.utilization,
              resetsAt: w.resetsAt ? w.resetsAt * 1000 : null,
            }));
            return windows.length ? [{ kind: 'limits', status: info.status, windows }] : [];
          }

          case 'result': {
            const events = [];
            // modelUsage knows the real window size (e.g. 1M for "[1m]" models).
            const usage = ev.modelUsage || {};
            const base = (model || '').replace(/\[.*\]$/, '');
            const entry = usage[model] || Object.entries(usage).find(([k]) => k.replace(/\[.*\]$/, '').startsWith(base))?.[1];
            if (entry?.contextWindow && used) events.push({ kind: 'context', used, window: entry.contextWindow });
            blockCount.clear();
            liveMsg.clear();
            const aborted = ev.terminal_reason === 'aborted_streaming';
            const error = ev.is_error && !aborted ? (typeof ev.result === 'string' && ev.result) || ev.subtype : null;
            events.push({ kind: 'result', ok: !ev.is_error, aborted, error, durationMs: ev.duration_ms, turns: ev.num_turns });
            return events;
          }

          default:
            return [];
        }
      };
    },
  };
}
