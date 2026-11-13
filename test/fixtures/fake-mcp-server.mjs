// A minimal MCP stdio server used only by the tests. It implements just enough
// protocol to prove the client works: initialize, tools/list, tools/call.

import readline from 'node:readline';

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'fail',
    description: 'Always reports an error.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo: ${args?.text ?? ''}` }] } });
      return;
    }
    if (name === 'fail') {
      send({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'this tool always fails' }] } });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no tool ${name}` } });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
  }
});
