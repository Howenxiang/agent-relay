const assert = require('node:assert/strict');
const { fork, spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const serverFile = path.join(__dirname, '..', 'server.js');
const mcpFile = path.join(__dirname, '..', 'mcp-server.js');
const deadline = () => AbortSignal.timeout(8_000);
const options = { timeout: 30_000 };

async function startRelay(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-mcp-'));
  const child = fork(serverFile, [], {
    execArgv: [],
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AGENT_RELAY_DATA: dir, AGENT_RELAY_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const [ready] = await once(child, 'message', { signal: deadline() });
  return { baseUrl: `http://127.0.0.1:${ready.port}` };
}

function startMcpClient(t, envOverrides = {}) {
  const child = spawn(process.execPath, [mcpFile], {
    env: { ...process.env, RELAY_TOKEN: '', RELAY_AGENT_ID: '', RELAY_AGENT_KEY: '', ...envOverrides },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const bus = new EventEmitter();
  const responses = new Map();
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', c => { stderr += c; });
  child.stdout.on('data', chunk => {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf('\n');
      if (idx === -1) break;
      const line = buf.slice(0, idx).replace(/\r$/, '').trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) {
        responses.set(msg.id, msg);
        bus.emit(`res:${msg.id}`, msg);
      }
    }
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let nextId = 1;
  return {
    stderr: () => stderr,
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async call(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      if (responses.has(id)) return responses.get(id);
      const [msg] = await once(bus, `res:${id}`, { signal: deadline() });
      return msg;
    },
    async tool(name, args = {}) {
      const res = await this.call('tools/call', { name, arguments: args });
      assert.equal(res.error, undefined, `RPC error: ${JSON.stringify(res.error)}`);
      return res.result;
    },
  };
}

test('MCP server supports full stdio JSON-RPC lifecycle and end-to-end project sync tools', options, async t => {
  const relay = await startRelay(t);
  const mcp = startMcpClient(t, {
    RELAY_URL: relay.baseUrl,
    RELAY_ROOM: 'sync-room',
    RELAY_NAME: 'order-mcp',
    RELAY_ROLE: 'Backend',
    RELAY_PROJECT: 'mall-order',
    RELAY_OWNER: '张三',
  });

  // 1. Handshake
  const init = await mcp.call('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0' },
  });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'agent-relay-mcp');
  mcp.notify('notifications/initialized');

  const ping = await mcp.call('ping');
  assert.deepEqual(ping.result, {});

  // 2. Tools, resources, prompts discovery
  const tools = (await mcp.call('tools/list')).result.tools;
  assert.ok(tools.length >= 11);
  assert.ok(tools.some(x => x.name === 'relay_artifacts'));
  assert.ok(tools.some(x => x.name === 'relay_decide_proposal'));

  const resources = (await mcp.call('resources/list')).result.resources;
  assert.ok(resources.some(r => r.uri === 'relay://guide'));
  const guide = (await mcp.call('resources/read', { uri: 'relay://guide' })).result.contents[0];
  assert.match(guide.text, /防死循环/);

  const prompts = (await mcp.call('prompts/list')).result.prompts;
  assert.ok(prompts.some(p => p.name === 'join_project_sync'));
  const prompt = (await mcp.call('prompts/get', { name: 'join_project_sync', arguments: { room: 'sync-room', goal: '对接退款接口' } })).result;
  assert.match(prompt.messages[0].content.text, /对接退款接口/);

  // 3. Health & join with default env card
  const health = await mcp.tool('relay_health');
  assert.match(health.content[0].text, /optional-key/);

  const joined = await mcp.tool('relay_join', { status: '准备对接' });
  assert.equal(joined.isError, undefined);
  assert.match(joined.content[0].text, /mall-order/);

  // 4. Update card & verify via relay_who
  await mcp.tool('relay_set_card', {
    card: { project: 'mall-order', branch: 'feat/refund-v2', localEndpoint: 'http://192.168.1.9:8080' },
  });
  const who = await mcp.tool('relay_who');
  assert.match(who.content[0].text, /feat\/refund-v2/);

  // 5. Artifacts put / conflict / get / list
  const put1 = await mcp.tool('relay_artifacts', {
    action: 'put',
    name: 'refund.ts',
    content: 'export interface RefundReq { orderId: string; }',
    summary: 'v1',
    expectedVersion: 0,
  });
  assert.match(put1.content[0].text, /v1/);

  const conflict = await mcp.tool('relay_artifacts', {
    action: 'put',
    name: 'refund.ts',
    content: 'overwrite',
    expectedVersion: 0,
  });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /409/);

  const got = await mcp.tool('relay_artifacts', { action: 'get', name: 'refund.ts' });
  assert.match(got.content[0].text, /RefundReq/);

  // 6. Send proposal & decide
  const prop = await mcp.tool('relay_send', { kind: 'proposal', text: '提案：orderId 改为字符串' });
  assert.match(prop.content[0].text, /#1/);
  const dec = await mcp.tool('relay_decide_proposal', { seq: 1, decision: 'approved', comment: '同意' });
  assert.match(dec.content[0].text, /approved/);

  // 7. relay_wait wakes immediately when another agent mentions us
  const waiting = mcp.tool('relay_wait', { waitSeconds: 10, mentionOnly: true });
  await new Promise(r => setTimeout(r, 120));
  await fetch(`${relay.baseUrl}/api/messages?room=sync-room`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'web-agent', text: '@order-mcp 请确认退款错误码' }),
  });
  const woke = await waiting;
  assert.match(woke.content[0].text, /请确认退款错误码/);

  // 8. Leave cleanly
  const left = await mcp.tool('relay_leave');
  assert.match(left.content[0].text, /已离开/);
});

test('MCP server enforces verified-identity capability check and never leaks secrets', options, async t => {
  const calls = [];
  const mockServer = http.createServer((req, res) => {
    calls.push({ url: req.url, key: req.headers['x-agent-key'] });
    req.resume();
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(307, { Location: '/elsewhere' }).end();
    }
  });
  mockServer.listen(0, '127.0.0.1');
  await once(mockServer, 'listening');
  t.after(() => { mockServer.closeAllConnections(); return new Promise(r => mockServer.close(r)); });

  const secretKey = 'S'.repeat(43);
  const mcp = startMcpClient(t, {
    RELAY_URL: `http://127.0.0.1:${mockServer.address().port}`,
    RELAY_AGENT_ID: 'agt_00000000-0000-4000-8000-000000000099',
    RELAY_AGENT_KEY: secretKey,
  });
  await mcp.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });

  const failed = await mcp.tool('relay_send', { text: 'hello' });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /optional-key/);
  assert.ok(!failed.content[0].text.includes(secretKey));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, undefined);
});
