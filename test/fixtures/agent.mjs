#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
import crypto from 'node:crypto';
const codex = process.argv.includes('app-server');
const args = process.argv.slice(2);
const write = (x) => process.stdout.write(JSON.stringify(x) + '\n');
const note = (method, params) => write({ method, params });
let session;
let turn;
let timer;
let model;
let history = [];
const file = () => `${process.cwd()}/${session}.json`;
const save = () => fs.writeFileSync(file(), JSON.stringify(history));
function finish(interrupted = false) {
  clearTimeout(timer);
  if (codex) note('turn/completed', { threadId: session, turn: { id: turn, status: interrupted ? 'interrupted' : 'completed', error: null } });
  else write({ type: 'result', is_error: interrupted, terminal_reason: interrupted ? 'aborted_streaming' : null });
}
function run(text, images) {
  if (text === 'crash') return process.exit(2);
  history.push(text); save();
  if (text === 'slow') { timer = setTimeout(() => finish(), 3000); return; }
  const reply = `${codex ? 'codex' : 'claude'}:${history.length}:${images}:${text}`;
  if (codex) {
    const item = { type: 'agentMessage', id: crypto.randomUUID(), text: reply };
    note('item/started', { threadId: session, item: { ...item, text: '' } });
    note('item/agentMessage/delta', { threadId: session, itemId: item.id, delta: reply });
    note('item/completed', { threadId: session, item });
    note('thread/tokenUsage/updated', { threadId: session, tokenUsage: { last: { totalTokens: 123 }, modelContextWindow: 1000 } });
    note('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 } } });
  } else {
    const id = crypto.randomUUID();
    write({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
    write({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
    write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } } });
    write({ type: 'assistant', message: { id, content: [{ type: 'text', text: reply }] } });
    write({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5 } } } });
  }
  finish();
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (!codex) {
    if (m.type === 'control_request') return finish(true);
    if (!session) {
      session = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : crypto.randomUUID();
      history = fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file())) : [];
      model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'sonnet';
      write({ type: 'system', subtype: 'init', session_id: session, model });
    }
    return run(m.message.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n'), m.message.content.filter((x) => x.type === 'image').length);
  }
  const result = (value) => write({ id: m.id, result: value });
  switch (m.method) {
    case 'initialize': return result({});
    case 'initialized': return;
    case 'model/list': return result({ data: [{ model: 'test-model', displayName: 'Test model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: null });
    case 'account/rateLimits/read': return result({ rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300 } } });
    case 'thread/start':
    case 'thread/resume':
      session = m.params.threadId || crypto.randomUUID();
      history = fs.existsSync(file()) ? JSON.parse(fs.readFileSync(file())) : [];
      model = m.params.model || 'test-model';
      return result({ thread: { id: session, cwd: process.cwd() }, cwd: process.cwd(), model });
    case 'turn/start':
      turn = crypto.randomUUID();
      result({ turn: { id: turn, status: 'inProgress' } });
      note('turn/started', { threadId: session, turn: { id: turn } });
      return run(m.params.input.filter((x) => x.type === 'text').map((x) => x.text).join('\n'), m.params.input.filter((x) => x.type === 'image').length);
    case 'turn/interrupt': result({}); return finish(true);
  }
});
