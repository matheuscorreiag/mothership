import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
const root = path.resolve(import.meta.dirname, '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test('both providers preserve queue, interrupt, attachments, clear and resume across restarts', { timeout: 30000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mothership-test-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise((r) => listener.close(r));
  const base = `http://127.0.0.1:${port}`;
  const config = path.join(temp, 'config.json');
  const fixture = path.join(root, 'test/fixtures/agent.mjs');
  await fs.writeFile(config, JSON.stringify({ port, dataDir: path.join(temp, 'data'), agent: { type: 'codex', cwd: temp, idleMinutes: 0.002 }, agents: { claude: { command: fixture, model: 'haiku' }, codex: { command: fixture } } }));
  const legacyDir = path.join(temp, 'data/chats/000000000001');
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, 'meta.json'), JSON.stringify({ id: '000000000001', title: 'Legacy', created: 1 }));
  const goneDir = path.join(temp, 'data/chats/000000000002');
  await fs.mkdir(goneDir, { recursive: true });
  await fs.writeFile(path.join(goneDir, 'meta.json'), JSON.stringify({ id: '000000000002', agent: 'claude', title: 'Gone', created: 2, cwd: path.join(temp, 'removed-worktree') }));
  let server, socket, logs = '';
  const messages = [];
  t.after(async () => { socket?.terminate(); if (server?.exitCode === null) { server.kill(); await once(server, 'exit'); } await fs.rm(temp, { recursive: true, force: true }); });
  async function boot() {
    server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, MOTHERSHIP_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (b) => { logs += b; }); server.stderr.on('data', (b) => { logs += b; });
    for (let i = 0; i < 100; i++) {
      if (await fetch(base + '/api/chats').then((r) => r.ok).catch(() => false)) break;
      if (server.exitCode !== null) throw new Error(logs);
      await delay(30);
    }
    socket = new WebSocket(base.replace('http:', 'ws:') + '/ws/chat');
    socket.on('message', (b) => messages.push(JSON.parse(b)));
    await once(socket, 'open');
    await wait((m) => m.op === 'agent' && m.agents.find((a) => a.id === 'codex').models.length);
  }
  async function wait(predicate, from = 0) {
    for (let i = 0; i < 400; i++) { const found = messages.slice(from).find(predicate); if (found) return found; await delay(15); }
    throw new Error(`Message timeout. ${logs}\n${JSON.stringify(messages.slice(-8))}`);
  }
  const send = (m) => socket.send(JSON.stringify(m));
  const list = () => fetch(base + '/api/chats').then((r) => r.json());
  async function message(agent, text, chatId, extra = {}) {
    const from = messages.length;
    send({ op: 'send', agent, text, chatId, ref: `${Date.now()}`, ...extra });
    if (!chatId) chatId = (await wait((m) => m.op === 'created', from)).chatId;
    await wait((m) => m.op === 'item' && m.chatId === chatId && m.item.t === 'result', from);
    return chatId;
  }
  await boot();
  assert.equal((await list()).find((c) => c.id === '000000000001').agent, 'claude');
  send({ op: 'open', chatId: '000000000002' }); // its folder is gone: back to where it starts
  for (let i = 0; i < 100 && (await list()).find((c) => c.id === '000000000002').cwd !== temp; i++) await delay(20);
  assert.equal((await list()).find((c) => c.id === '000000000002').cwd, temp);
  const ids = {};
  for (const agent of ['claude', 'codex']) {
    const id = ids[agent] = await message(agent, 'first');
    assert.equal((await list()).find((c) => c.id === id).agent, agent);
    const session = (await list()).find((c) => c.id === id).sessionId;
    await delay(200); // idle shutdown, then resume the provider's persisted session
    await message(agent, 'second', id);
    assert(messages.some((m) => m.item?.block?.text === `${agent}:2:0:second`));
    assert.equal((await list()).find((c) => c.id === id).sessionId, session);
    const upload = await fetch(base + '/api/uploads?name=test.png', { method: 'POST', headers: { 'X-Mothership': '1' }, body: Buffer.from('fixture') }).then((r) => r.json());
    await message(agent, 'image', id, { attachments: [{ file: upload.file }] });
    assert(messages.some((m) => m.item?.block?.text?.startsWith(`${agent}:3:1:image`)));
    let from = messages.length;
    send({ op: 'send', chatId: id, text: 'slow' });
    await wait((m) => m.op === 'status' && m.status === 'running', from);
    send({ op: 'send', chatId: id, text: 'queued' });
    await wait((m) => m.op === 'status' && m.queue.length === 1, from);
    send({ op: 'interrupt', chatId: id });
    assert.equal((await wait((m) => m.item?.t === 'result', from)).item.interrupted, true);
    assert.equal((await list()).find((c) => c.id === id).queued, 0);
    from = messages.length;
    send({ op: 'send', chatId: id, text: 'slow' });
    send({ op: 'send', chatId: id, text: 'after queue' });
    await wait((m) => m.item?.block?.text?.endsWith(':after queue'), from);
    await wait((m) => m.op === 'status' && m.status === 'idle' && !m.queue.length, from);
    const patch = await fetch(base + `/api/chats/${id}`, { method: 'PATCH', headers: { 'X-Mothership': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ effort: 'high' }) });
    assert.equal(patch.status, 200);
    await message(agent, 'new settings', id);
    assert.equal((await list()).find((c) => c.id === id).sessionId, session);
    from = messages.length;
    send({ op: 'send', chatId: id, text: '/clear' });
    await wait((m) => m.op === 'cleared', from);
    await message(agent, 'fresh', id);
    assert(messages.some((m) => m.item?.block?.text === `${agent}:1:0:fresh`));
    assert.notEqual((await list()).find((c) => c.id === id).sessionId, session);
    const files = await fs.readdir(path.join(temp, 'data/chats', id));
    assert(files.some((f) => /^events-/.test(f)));
  }
  assert(messages.some((m) => m.op === 'limits' && m.agent === 'claude' && m.limits.windows[0].utilization === 0.5));
  assert(messages.some((m) => m.op === 'limits' && m.agent === 'codex' && m.limits.windows[0].utilization === 0.25));
  const beforeRestart = await list();
  socket.terminate(); server.kill(); await once(server, 'exit'); messages.length = 0;
  await boot();
  for (const agent of ['claude', 'codex']) {
    const id = ids[agent];
    send({ op: 'open', chatId: id });
    await message(agent, 'restart', id);
    assert(messages.some((m) => m.item?.block?.text === `${agent}:2:0:restart`));
    assert.equal((await list()).find((c) => c.id === id).sessionId, beforeRestart.find((c) => c.id === id).sessionId);
  }
  for (const agent of ['claude', 'codex']) {
    const from = messages.length;
    send({ op: 'open', chatId: ids[agent] });
    send({ op: 'send', chatId: ids[agent], text: 'crash' });
    send({ op: 'send', chatId: ids[agent], text: 'after crash' });
    await wait((m) => m.item?.level === 'error', from);
    await wait((m) => m.item?.block?.text?.endsWith(':after crash'), from);
    assert.equal((await list()).find((c) => c.id === ids[agent]).agent, agent);
  }
  const from = messages.length;
  send({ op: 'send', agent: 'invalid', text: 'test', ref: 'invalid' });
  assert.match((await wait((m) => m.op === 'error' && m.ref === 'invalid', from)).error, /unknown agent/);
  const bad = await fetch(base + `/api/chats/${ids.codex}`, { method: 'PATCH', headers: { 'X-Mothership': '1' }, body: JSON.stringify({ model: 'haiku' }) });
  assert.equal(bad.status, 400);
});
