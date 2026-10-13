import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexAgent, createCodexParser } from '../lib/agents/codex.js';
import { createAgents } from '../lib/agents/index.js';

test('provider configuration never leaks flags or models', () => {
  const agents = createAgents({ agent: { type: 'claude', command: 'my-claude', model: 'haiku', args: ['--custom'], cwd: '/tmp' } });
  assert.equal(agents.codex.options.command, 'codex');
  assert.equal(agents.codex.options.model, undefined);
  assert.deepEqual(agents.codex.options.args, []);
  assert.equal(agents.claude.options.model, 'haiku');
});

test('Codex streams once, pairs tools with results, and normalizes errors and images', () => {
  const parse = createCodexParser();
  const item = { id: 'cmd', type: 'commandExecution', command: 'pwd', cwd: '/tmp', aggregatedOutput: '/tmp', exitCode: 1, status: 'completed' };
  const begun = parse({ method: 'item/started', params: { item } });
  assert.equal(begun[0].block.name, 'shell');
  assert.deepEqual(begun[1], { kind: 'cwd', cwd: '/tmp' }); // the status line follows the command's folder
  const done = parse({ method: 'item/completed', params: { item } });
  assert.equal(done.length, 1); assert.equal(done[0].isError, true);
  assert.deepEqual(parse({ method: 'item/completed', params: { item } }), []);
  const delta = parse({ method: 'item/agentMessage/delta', params: { itemId: 'text', delta: 'hello' } });
  assert.deepEqual(delta.map((x) => x.kind), ['draft-start', 'draft-delta']);
  parse({ method: 'item/completed', params: { item: { id: 'text', type: 'agentMessage', text: 'hello' } } });
  assert.deepEqual(parse({ method: 'item/agentMessage/delta', params: { itemId: 'text', delta: 'hello' } }), []);
  const mcp = parse({ method: 'item/completed', params: { item: { id: 'mcp', type: 'mcpToolCall', server: 'mothership', tool: 'slack_read', arguments: {}, result: { content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }] } } } });
  assert.equal(mcp[0].block.name, 'mcp__mothership__slack_read');
  assert.deepEqual(mcp[1].content[0], { type: 'image', data: 'AAA', mediaType: 'image/png' });
  const usage = parse({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { totalTokens: 900 }, last: { totalTokens: 123 }, modelContextWindow: 1000 } } });
  assert.equal(usage[0].used, 123);
  assert.equal(parse({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'bad model' } } } })[0].error, 'bad model');
});

test('Codex resumes its own thread and can stop while initialization is pending', async () => {
  const sent = [], events = [];
  const a = createCodexAgent({});
  const c = a.createConnection({ write: (m) => sent.push(m), emit: (e) => events.push(e), sessionId: 'saved', cwd: '/tmp' });
  const run = c.send({ text: 'hello', images: [] });
  await c.interrupt();
  c.receive({ id: sent[0].id, result: {} });
  await new Promise(setImmediate);
  const resume = sent.find((x) => x.method === 'thread/resume');
  assert.equal(resume.params.threadId, 'saved');
  c.receive({ id: resume.id, result: { thread: { id: 'saved' }, model: 'test' } });
  await run;
  assert.equal(sent.some((x) => x.method === 'turn/start'), false);
  assert.equal(events.some((e) => e.kind === 'cwd'), false); // a resumed thread keeps the chat's last folder
  assert.equal(events.at(-1).aborted, true);
  c.close(new Error('done'));
});

test('sparse Codex usage notifications retain the other window', () => {
  const parse = createCodexParser();
  parse({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 } } } });
  const [event] = parse({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: null, secondary: { usedPercent: 50, windowDurationMins: 10080 } } } });
  assert.deepEqual(event.windows.map((w) => [w.label, w.utilization]), [['5h', 0.2], ['7d', 0.5]]);
});

test('child agents keep authentication paths but drop the parent Codex sandbox context', async () => {
  const { cleanEnv } = await import('../lib/config.js');
  const keys = { CODEX_HOME: '/tmp/test-home', CODEX_API_KEY: 'test-key', CODEX_PERMISSION_PROFILE: 'parent', CODEX_SANDBOX_NETWORK_DISABLED: '1', CODEX_SESSION_ID: 'parent' };
  const before = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, keys);
    const env = cleanEnv();
    assert.equal(env.CODEX_HOME, keys.CODEX_HOME);
    assert.equal(env.CODEX_API_KEY, keys.CODEX_API_KEY);
    assert.equal(env.CODEX_PERMISSION_PROFILE, undefined);
    assert.equal(env.CODEX_SANDBOX_NETWORK_DISABLED, undefined);
    assert.equal(env.CODEX_SESSION_ID, undefined);
  } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('interruption closes unfinished tool cards before completing the turn', () => {
  const parse = createCodexParser();
  parse({ method: 'item/started', params: { item: { id: 'sleep', type: 'commandExecution', command: 'sleep 20' } } });
  const events = parse({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } });
  assert.deepEqual(events.map((e) => e.kind), ['tool-result', 'result']);
  assert.equal(events[0].toolUseId, 'sleep');
  assert.equal(events[0].content[0].text, 'Interrupted');
});
