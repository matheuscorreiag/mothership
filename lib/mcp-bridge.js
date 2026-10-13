// The MCP server a chat's agent gets (lib/chat.js hands it to the adapter): a
// stdio bridge to the tools the server itself offers its agents (Slack, see
// lib/slack.js). It holds nothing: the server knows which chat is asking by
// MOTHERSHIP_KEY, runs the tool and checks what it has to.
//
// MCP over stdio is JSON-RPC, one message per line; this answers the few
// methods a tools-only server needs.

import readline from 'node:readline';

const { MOTHERSHIP_URL, MOTHERSHIP_KEY } = process.env;

async function server(body) {
  const res = await fetch(`${MOTHERSHIP_URL}/api/agent/tools`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mothership': '1' },
    body: JSON.stringify({ key: MOTHERSHIP_KEY, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `the server answered ${res.status}`);
  return data;
}

async function handle(method, params = {}) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mothership', version: '1.0.0' } };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: (await server({})).tools };
    case 'tools/call':
      try {
        return await server({ call: { name: params.name, args: params.arguments } });
      } catch (err) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
  }
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

const reply = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

readline
  .createInterface({ input: process.stdin })
  .on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined) return; // a notification: nothing to answer
    try {
      reply({ id: msg.id, result: await handle(msg.method, msg.params) });
    } catch (err) {
      reply({ id: msg.id, error: { code: err.code || -32603, message: err.message } });
    }
  })
  .on('close', () => process.exit(0));
