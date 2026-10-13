// Codex App Server over stdio JSON-RPC. No API key or SDK: the local CLI
// supplies authentication, tools and persistent threads.
import { startAgent } from './process.js';
import { expandHome } from '../config.js';

const modelLabel = (model) => model || '';
// OpenAI's mark (simple-icons, CC0), a 24×24 path: the page draws it in gray
// beside the chat, the model button and the picker.
const ICON = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z';
const toml = (value) => Array.isArray(value) ? `[${value.map(toml).join(', ')}]`
  : value && typeof value === 'object' ? `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(', ')} }`
  : JSON.stringify(value);

function limitEvent(snapshot) {
  if (!snapshot) return null;
  const windows = ['primary', 'secondary'].flatMap((id) => {
    const w = snapshot[id];
    if (!w) return [];
    const mins = w.windowDurationMins;
    const label = mins ? (mins % 1440 === 0 ? `${mins / 1440}d` : mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`) : id;
    return [{ id, label, utilization: w.usedPercent / 100, resetsAt: w.resetsAt ? w.resetsAt * 1000 : null }];
  });
  return { kind: 'limits', status: windows.some((w) => w.utilization >= 1) ? 'limited' : 'allowed', windows };
}

export function createCodexParser() {
  const started = new Set();
  const completed = new Set();
  const drafts = new Set();
  let limits = {};
  let cwd = null;
  let began = Date.now();
  const block = (item, value) => ({ kind: 'block', msg: item.id, index: 0, block: value, parent: null });
  function tool(item) {
    switch (item.type) {
      case 'commandExecution': return { name: 'shell', input: { command: item.command, cwd: item.cwd } };
      case 'fileChange': return { name: 'apply_patch', input: { changes: item.changes } };
      case 'mcpToolCall': return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments };
      case 'dynamicToolCall': return { name: item.tool, input: item.arguments };
      case 'webSearch': return { name: 'web_search', input: { query: item.query || item.action?.query || '', action: item.action } };
      case 'imageView': return { name: 'view_image', input: { path: item.path } };
      case 'imageGeneration': return { name: 'generate_image', input: { prompt: item.revisedPrompt || '' } };
      case 'collabAgentToolCall': return { name: 'agent', input: { tool: item.tool, prompt: item.prompt, agents: item.receiverThreadIds } };
      default: return null;
    }
  }
  return ({ method, params: p = {} }) => {
    if (method === 'turn/started') { began = Date.now(); return []; }
    if (method === 'thread/tokenUsage/updated') {
      const u = p.tokenUsage;
      return u?.modelContextWindow ? [{ kind: 'context', used: u.last.totalTokens, window: u.modelContextWindow }] : [];
    }
    if (method === 'account/rateLimits/updated') {
      if (!p.rateLimits) return [];
      if (p.rateLimits.limitId && limits.limitId !== p.rateLimits.limitId) limits = {};
      limits = { ...limits, ...Object.fromEntries(Object.entries(p.rateLimits).filter(([, value]) => value != null)) };
      return [limitEvent(limits)];
    }
    if (method === 'error') return p.willRetry ? [{ kind: 'notice', level: 'info', text: p.error?.message || 'Retrying the request' }] : [];
    if (method === 'turn/completed') {
      const unfinished = [...started].filter((id) => !completed.has(id)).map((toolUseId) => ({
        kind: 'tool-result', toolUseId, isError: true,
        content: [{ type: 'text', text: p.turn.status === 'interrupted' ? 'Interrupted' : 'The tool ended without a result' }],
      }));
      started.clear(); completed.clear(); drafts.clear();
      return [...unfinished, { kind: 'result', ok: p.turn.status === 'completed', aborted: p.turn.status === 'interrupted',
        error: p.turn.error?.message, durationMs: Date.now() - began }];
    }
    if (['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/plan/delta'].includes(method)) {
      if (completed.has(p.itemId)) return [];
      const events = [];
      if (!drafts.has(p.itemId)) {
        drafts.add(p.itemId);
        events.push({ kind: 'draft-start', msg: p.itemId, index: 0, block: method.includes('reasoning') ? 'thinking' : 'text' });
      }
      events.push({ kind: 'draft-delta', msg: p.itemId, index: 0, text: p.delta });
      return events;
    }
    if (method !== 'item/started' && method !== 'item/completed') return [];
    const item = p.item;
    if (!item || completed.has(item.id)) return [];
    const done = method === 'item/completed';
    const spec = tool(item);
    const events = [];
    if (spec && !started.has(item.id)) {
      started.add(item.id);
      events.push(block(item, { type: 'tool_use', id: item.id, ...spec }));
    }
    // Each command names its own folder (the thread's stays where it began):
    // the last one is where the agent works now.
    if (item.type === 'commandExecution' && item.cwd && item.cwd !== cwd) {
      cwd = item.cwd;
      events.push({ kind: 'cwd', cwd });
    }
    if (!done) return events;
    completed.add(item.id);
    if (['agentMessage', 'plan', 'reasoning'].includes(item.type)) {
      const text = item.type === 'reasoning' ? (item.summary || []).join('\n\n') : item.text;
      events.push(block(item, text ? { type: item.type === 'reasoning' ? 'thinking' : 'text', text } : null));
    } else if (spec) {
      let content = [{ type: 'text', text: item.aggregatedOutput ?? item.error?.message ??
        (item.type === 'fileChange' ? item.changes.map((c) => `${c.path}\n${c.diff}`).join('\n') :
          item.type === 'imageView' ? item.path : JSON.stringify(item.result ?? item.agentsStates ?? item.action ?? { status: item.status })) }];
      if (item.type === 'imageGeneration') content = item.result
        ? [{ type: 'image', data: item.result, mediaType: 'image/png' }]
        : [{ type: 'text', text: item.failure?.message || item.savedPath || item.status }];
      if (item.result?.content) content = item.result.content.map((c) => c.type === 'image'
        ? { type: 'image', data: c.data, mediaType: c.mimeType } : { type: 'text', text: c.text || JSON.stringify(c) });
      if (item.contentItems) content = item.contentItems.map((c) => ({ type: 'text', text: c.text || JSON.stringify(c) }));
      events.push({ kind: 'tool-result', toolUseId: item.id, isError: ['failed', 'declined'].includes(item.status) ||
        Boolean(item.error) || item.success === false || (item.exitCode != null && item.exitCode !== 0), content });
    } else if (item.type === 'contextCompaction') events.push({ kind: 'notice', level: 'info', text: 'Conversation compacted' });
    return events;
  };
}

export function createCodexAgent(options) {
  const adapter = {
    name: 'Codex', icon: ICON, models: [], efforts: [], modelLabel,
    spawnArgs({ mcpServers = [] } = {}) {
      const args = ['app-server', ...(options.args || []), '--listen', 'stdio://',
        // Slack must go through Mothership's checked MCP bridge, never account apps.
        '-c', 'features.apps=false', '-c', 'apps._default.enabled=false'];
      for (const { name, ...server } of mcpServers) args.push('-c', `mcp_servers.${name}=${toml(server)}`);
      return { command: options.command || 'codex', args };
    },
    async discover() {
      const proc = startAgent(adapter, { cwd: expandHome(options.cwd), onEvent() {}, onExit() {} });
      try {
        const models = await proc.discover();
        adapter.defaultModel = options.model || models.find((m) => m.isDefault)?.model || null;
        adapter.models = models.filter((m) => !m.hidden).map((m) => ({
          id: m.model, label: m.displayName || m.model, efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
        }));
        adapter.efforts = [...new Set(adapter.models.flatMap((m) => m.efforts))];
      } finally { proc.stop(); }
    },
    createConnection({ write, emit, sessionId, cwd, systemPrompt, model, effort }) {
      const pending = new Map();
      const parse = createCodexParser();
      let seq = 0;
      let closed;
      let initialized;
      let thread;
      let turnId;
      let completedTurn;
      let interrupted = false;
      let starting;
      const request = (method, params) => new Promise((resolve, reject) => {
        if (closed) return reject(closed);
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Agent request timed out: ${method}`)); }, 30_000).unref();
        pending.set(id, { resolve, reject, timer });
        try { write({ id, method, params }); } catch (err) { clearTimeout(timer); pending.delete(id); reject(err); }
      });
      const initialize = () => initialized ||= request('initialize', {
        clientInfo: { name: 'mothership', title: 'Mothership', version: '0.1.0' },
      }).then(() => write({ method: 'initialized' }));
      const interruptTurn = () => turnId ? request('turn/interrupt', { threadId: thread, turnId }) : Promise.resolve();
      return {
        async discover() {
          await initialize();
          const models = [];
          let cursor;
          do {
            const page = await request('model/list', { cursor, limit: 100 });
            models.push(...page.data);
            cursor = page.nextCursor;
          } while (cursor);
          return models;
        },
        receive(raw) {
          if (raw.id != null && !raw.method) {
            const call = pending.get(raw.id);
            if (!call) return;
            pending.delete(raw.id); clearTimeout(call.timer);
            if (raw.error) call.reject(new Error(raw.error.message)); else call.resolve(raw.result);
            return;
          }
          if (raw.id != null && raw.method) {
            // Never leave an unsupported interactive request hanging. The normal
            // runtime has approvals disabled, matching the existing local agent.
            if (raw.method === 'item/permissions/requestApproval') write({ id: raw.id, result: { permissions: {}, scope: 'turn' } });
            else if (raw.method.endsWith('/requestApproval')) write({ id: raw.id, result: { decision: 'decline' } });
            else if (raw.method === 'item/tool/requestUserInput') write({ id: raw.id, result: { answers: {} } });
            else write({ id: raw.id, error: { code: -32601, message: 'This client does not support interactive requests. Ask the user in the chat.' } });
            emit({ kind: 'notice', level: 'info', text: 'The agent requested an interactive action. Ask it to continue in the chat.' });
            return;
          }
          if (raw.params?.threadId && raw.params.threadId !== thread) return;
          if (raw.method === 'turn/started') turnId = raw.params.turn.id;
          if (raw.method === 'turn/completed') { completedTurn = raw.params.turn.id; turnId = null; }
          for (const event of parse(raw)) emit(event);
        },
        async send({ text, images }) {
          interrupted = false;
          await initialize();
          if (!thread) {
            const params = { cwd, model: model || options.model || null, approvalPolicy: 'never', sandbox: 'danger-full-access',
              developerInstructions: systemPrompt, ...(sessionId && { threadId: sessionId }) };
            const result = await request(sessionId ? 'thread/resume' : 'thread/start', params);
            thread = result.thread.id;
            emit({ kind: 'session', sessionId: thread, model: result.model, modelLabel: modelLabel(result.model) });
            // A resumed thread starts where the chat did; the folder its last
            // command ran in (meta.cwd) is still where the agent works.
            if (!sessionId) emit({ kind: 'cwd', cwd: result.cwd || result.thread.cwd || cwd });
            request('account/rateLimits/read', {}).then((r) => {
              for (const ev of parse({ method: 'account/rateLimits/updated', params: r })) emit(ev);
            }).catch(() => {});
          }
          if (interrupted) { emit({ kind: 'result', ok: false, aborted: true }); return; }
          const input = images.map((i) => ({ type: 'image', url: `data:${i.mediaType};base64,${i.data}` }));
          if (text) input.push({ type: 'text', text, text_elements: [] });
          starting = request('turn/start', { threadId: thread, input, effort: effort || options.effort || null });
          const result = await starting;
          // A very short turn can complete before the response is delivered.
          if (completedTurn !== result.turn.id && !['completed', 'failed', 'interrupted'].includes(result.turn.status)) turnId = result.turn.id;
          starting = null;
          if (interrupted) await interruptTurn();
        },
        async interrupt() {
          interrupted = true;
          if (!starting) await interruptTurn();
        },
        close(error) {
          closed = error;
          for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
          pending.clear();
        },
      };
    },
  };
  return adapter;
}
