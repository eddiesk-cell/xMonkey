// MCP (Model Context Protocol) client.
//
// xMonkey can use any tool server that speaks MCP. We implement the parts an
// agent actually needs and nothing else:
//
//   initialize -> tools/list -> tools/call
//
// Transport: stdio (a child process speaking newline-delimited JSON-RPC) and
// HTTP (streamable POST). stdio is the one every local MCP server uses.
//
// The client is intentionally forgiving about unknown fields: MCP is versioned
// and servers differ, so an unexpected field must never break a session.

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { newId } from '../core/types.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'xmonkey', version: '0.1.0' };

export class McpClient {
  /**
   * @param {{ name: string, transport: 'stdio'|'http', command?: string, args?: string[], env?: object, url?: string }} config
   */
  constructor(config) {
    this.config = config;
    this.name = config.name;
    this.transport = config.transport ?? 'stdio';
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.serverInfo = null;
    this.child = null;
    this.rl = null;
    this.closed = false;
    this.stderrTail = '';
  }

  async connect(timeoutMs = 20_000) {
    if (this.transport === 'stdio') await this.#spawnStdio();
    else await this.#initHttp();
    const init = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: {}, sampling: {} },
      clientInfo: CLIENT_INFO,
    }, timeoutMs);
    this.serverInfo = init?.serverInfo ?? null;
    this.protocolVersion = init?.protocolVersion ?? PROTOCOL_VERSION;
    // The spec requires this notification after initialize; servers that omit
    // it still work, ones that require it do not, so it is not optional.
    this.#notify('notifications/initialized', {});
    await this.refreshTools(timeoutMs);
    return this;
  }

  async #spawnStdio() {
    const { command, args = [], env = {} } = this.config;
    if (!command) throw new Error(`mcp "${this.name}": stdio transport needs a command`);
    this.child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('error', (err) => this.#failAll(err));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.#failAll(new Error(`mcp "${this.name}" exited (code ${code}, signal ${signal})`));
    });
    this.child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-4000);
    });
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on('line', (line) => this.#onLine(line));
  }

  async #initHttp() {
    // HTTP transport: no persistent connection needed, just a URL.
    this.url = this.config.url;
    if (!this.url) throw new Error(`mcp "${this.name}": http transport needs a url`);
  }

  #onLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // servers sometimes log to stdout; ignore non-JSON lines
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(`mcp "${this.name}" error ${msg.error.code}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    }
    // Server-initiated requests/notifications are accepted and ignored for now.
  }

  async #send(payload) {
    if (this.transport === 'stdio') {
      if (!this.child?.stdin.writable) throw new Error(`mcp "${this.name}" is not connected`);
      this.child.stdin.write(JSON.stringify(payload) + '\n');
      return;
    }
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`mcp "${this.name}" HTTP ${res.status}`);
    const body = await res.text();
    // The streamable transport may answer directly or as an SSE frame.
    const direct = body.trim().startsWith('{') ? body : null;
    const sse = body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    const candidate = direct ?? sse.at(-1);
    if (!candidate) throw new Error(`mcp "${this.name}" returned no JSON`);
    const msg = JSON.parse(candidate);
    this.#onLine(JSON.stringify(msg));
  }

  async #request(method, params, timeoutMs = 20_000) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp "${this.name}": ${method} timed out after ${timeoutMs}ms${this.stderrTail ? `\nserver stderr: ${this.stderrTail.slice(-800)}` : ''}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    await this.#send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  #notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params }).catch(() => {});
  }

  #failAll(err) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
  }

  async refreshTools(timeoutMs = 20_000) {
    const result = await this.#request('tools/list', {}, timeoutMs);
    this.tools = (result?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      server: this.name,
    }));
    return this.tools;
  }

  /** Call a tool. Returns the text content flattened for the model. */
  async callTool(name, args, timeoutMs = 120_000) {
    const result = await this.#request('tools/call', { name, arguments: args ?? {} }, timeoutMs);
    const parts = [];
    let isError = !!result?.isError;
    for (const c of result?.content ?? []) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'image') parts.push(`[image: ${c.mimeType ?? 'unknown'}]`);
      else if (c.type === 'resource') parts.push(`[resource: ${c.resource?.uri ?? ''}]`);
      else parts.push(`[${c.type}]`);
    }
    if (!parts.length) parts.push('(tool returned no content)');
    return { content: parts.join('\n'), isError };
  }

  async close() {
    this.closed = true;
    this.#failAll(new Error('mcp client closed'));
    if (this.rl) this.rl.close();
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* gone */ }
      await new Promise((r) => setTimeout(r, 200));
      try { this.child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }

  /**
   * Wrap every MCP tool as an xMonkey tool. Tool names are namespaced
   * `mcp__<server>__<tool>` so two servers cannot shadow each other or a
   * built-in tool.
   */
  asXmonkeyTools() {
    return this.tools.map((t) => {
      const client = this;
      return {
        name: `mcp__${this.name}__${t.name}`,
        description: `${t.description}\n\n(Provided by MCP server "${this.name}".)`,
        inputSchema: t.inputSchema,
        isReadOnly: false,        // MCP tools can do anything; the gate treats them as mutating
        isConcurrencySafe: false,
        async run(input) {
          return await client.callTool(t.name, input);
        },
      };
    });
  }
}

/**
 * Connect a set of MCP servers. One broken server must not take down the
 * session: the failure is recorded and the healthy servers still load.
 *
 * @param {Record<string, {transport?:string, command?:string, args?:string[], env?:object, url?:string}>} servers
 */
export async function connectMcpServers(servers = {}) {
  const clients = [];
  const errors = [];
  await Promise.all(Object.entries(servers).map(async ([name, cfg]) => {
    if (cfg.disabled) return;
    const client = new McpClient({ name, ...cfg, transport: cfg.transport ?? (cfg.url ? 'http' : 'stdio') });
    try {
      await client.connect();
      clients.push(client);
    } catch (err) {
      errors.push({ server: name, error: err.message });
      await client.close().catch(() => {});
    }
  }));
  return { clients, errors };
}
