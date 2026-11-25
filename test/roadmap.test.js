const assert = require('node:assert/strict');
const { execFile, fork, spawn } = require('node:child_process');
const dgram = require('node:dgram');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const zlib = require('node:zlib');

const { crc32 } = require('../lib/zip');
const { diffText } = require('../lib/diff');
const { diffOpenApi } = require('../lib/openapi-diff');
const { buildMdnsResponse, startDiscoveryResponder, discoverRelays } = require('../lib/discovery');

const exec = promisify(execFile);
const serverFile = path.join(__dirname, '..', 'server.js');
const clientFile = path.join(__dirname, '..', 'client.js');
const mcpFile = path.join(__dirname, '..', 'mcp-server.js');
const deadline = () => AbortSignal.timeout(8_000);
const options = { timeout: 30_000 };

// 简单验证并解压标准 ZIP Buffer，确认我们的零依赖 ZIP 器符合 PKZIP 规范
function parseZipEntries(buf) {
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'ZIP must start with local file header signature');
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8);
    const expectedCrc = buf.readUInt32LE(offset + 14);
    const compSize = buf.readUInt32LE(offset + 18);
    const uncompSize = buf.readUInt32LE(offset + 22);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.toString('utf8', offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    const raw = method === 8 ? zlib.inflateRawSync(comp) : comp;
    assert.equal(raw.length, uncompSize, `size mismatch for ${name}`);
    assert.equal(crc32(raw), expectedCrc, `CRC32 mismatch for ${name}`);
    entries.set(name, raw.toString('utf8'));
    offset = dataStart + compSize;
  }
  return entries;
}

async function startRelay(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-roadmap-'));
  const child = fork(serverFile, [], {
    execArgv: [],
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AGENT_RELAY_DATA: dir, AGENT_RELAY_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = new Promise(r => child.once('close', r));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const [ready] = await once(child, 'message', { signal: deadline() });
  const baseUrl = `http://127.0.0.1:${ready.port}`;
  return {
    dir,
    baseUrl,
    async req(route, { method = 'GET', body, expectStatus = 200 } = {}) {
      const res = await fetch(`${baseUrl}${route}`, {
        method,
        signal: deadline(),
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = text;
      if (res.headers.get('content-type')?.includes('application/json')) data = JSON.parse(text);
      assert.equal(res.status, expectStatus, `${method} ${route}: ${text}`);
      return { body: data, headers: res.headers };
    },
  };
}

test('room export generates valid compressed .zip archive, SYNC_REPORT.md, and JSON transcript', options, async t => {
  const relay = await startRelay(t);

  await relay.req('/api/join', {
    method: 'POST',
    body: {
      room: 'general',
      name: 'order-agent',
      role: 'Backend',
      card: { project: 'mall-order', owner: '张三', stack: 'Spring Boot 3', branch: 'feat/refund', localEndpoint: 'http://127.0.0.1:8080' },
    },
  });
  const prop = (await relay.req('/api/messages', {
    method: 'POST',
    body: { name: 'order-agent', kind: 'proposal', text: '提案：新增 refundReason 字段' },
    expectStatus: 201,
  })).body;
  await relay.req('/api/messages', {
    method: 'POST',
    body: { name: 'order-agent', kind: 'debug', text: 'STACKTRACE_DEBUG_ONLY' },
    expectStatus: 201,
  });
  await relay.req(`/api/rooms/general/proposals/${prop.seq}/decision`, {
    method: 'POST',
    body: { name: '张三', role: 'Human', decision: 'approved', comment: '同意' },
  });
  await relay.req('/api/rooms/general/artifacts/refund-api.md', {
    method: 'PUT',
    body: { name: 'order-agent', summary: '定稿 v1', content: '# Refund API\nPOST /api/v2/refunds\n' },
    expectStatus: 201,
  });

  // 1. Export ZIP and verify integrity + contents
  const zipRes = await fetch(`${relay.baseUrl}/api/rooms/general/export?format=zip`, { signal: deadline() });
  assert.equal(zipRes.status, 200);
  assert.equal(zipRes.headers.get('content-type'), 'application/zip');
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  const files = parseZipEntries(zipBuf);
  assert.ok(files.has('SYNC_REPORT.md'));
  assert.ok(files.has('transcript.json'));
  assert.ok(files.has('artifacts/refund-api.md'));
  assert.equal(files.get('artifacts/refund-api.md'), '# Refund API\nPOST /api/v2/refunds\n');

  const report = files.get('SYNC_REPORT.md');
  assert.match(report, /mall-order/);
  assert.match(report, /提案 #1/);
  assert.match(report, /已通过/);
  assert.ok(!report.includes('STACKTRACE_DEBUG_ONLY'), 'debug logs omitted by default');

  // 2. Markdown export with include_debug=1 includes debug log
  const mdRes = await relay.req('/api/rooms/general/export?format=md&include_debug=1');
  assert.match(mdRes.body, /STACKTRACE_DEBUG_ONLY/);

  // 3. CLI export writes valid zip file
  const outZip = path.join(relay.dir, 'cli-export.zip');
  await exec(process.execPath, [clientFile, 'export', '--url', relay.baseUrl, '--room', 'general', '--out', outZip], { timeout: 8_000 });
  const cliFiles = parseZipEntries(await fs.readFile(outZip));
  assert.ok(cliFiles.has('SYNC_REPORT.md'));
  assert.ok(cliFiles.has('artifacts/refund-api.md'));
});

test('artifact version history and line-level Diff API + CLI work across multiple revisions', options, async t => {
  const relay = await startRelay(t);

  await relay.req('/api/rooms/general/artifacts/types.ts', {
    method: 'PUT',
    body: { name: 'be', summary: '初始类型', content: 'export interface Refund {\n  id: number;\n  status: number;\n}\n' },
    expectStatus: 201,
  });
  await relay.req('/api/rooms/general/artifacts/types.ts', {
    method: 'PUT',
    body: { name: 'fe', summary: '改字符串状态', content: 'export interface Refund {\n  id: string;\n  status: "PENDING" | "DONE";\n}\n' },
  });
  const v3 = (await relay.req('/api/rooms/general/artifacts/types.ts', {
    method: 'PUT',
    body: { name: 'be', summary: '加原因字段', content: 'export interface Refund {\n  id: string;\n  status: "PENDING" | "DONE";\n  reason?: string;\n}\n' },
  })).body.artifact;
  assert.deepEqual(v3.availableVersions, [1, 2, 3]);

  // Fetch historical v1 directly
  const rev1 = (await relay.req('/api/rooms/general/artifacts/types.ts/versions/1')).body.revision;
  assert.match(rev1.content, /status: number/);

  // Default diff compares v2 -> v3
  const defaultDiff = (await relay.req('/api/rooms/general/artifacts/types.ts/diff')).body;
  assert.equal(defaultDiff.fromVersion, 2);
  assert.equal(defaultDiff.toVersion, 3);
  assert.equal(defaultDiff.stats.added, 1);
  assert.equal(defaultDiff.stats.removed, 0);
  assert.match(defaultDiff.unified, /\+  reason\?: string;/);

  // Explicit diff v1 -> v3
  const fullDiff = (await relay.req('/api/rooms/general/artifacts/types.ts/diff?from=1&to=3')).body;
  assert.equal(fullDiff.stats.removed, 2);
  assert.equal(fullDiff.stats.added, 3);

  // CLI artifact-diff
  const cli = await exec(process.execPath, [clientFile, 'artifact-diff', 'types.ts', '--url', relay.baseUrl, '--from', '1', '--to', '3'], { timeout: 8_000 });
  assert.match(cli.stdout, /--- types\.ts@v1/);
  assert.match(cli.stdout, /\+  reason\?: string;/);

  // Direct unit check on diffText identical case
  assert.equal(diffText('a\nb', 'a\nb').identical, true);
});

test('OpenAPI 3.x & Swagger 2.0 Schema Diff detects breaking vs non-breaking changes from artifacts and agent apiDoc', options, async t => {
  const relay = await startRelay(t);

  const openApiV1 = {
    openapi: '3.0.3',
    info: { title: 'Order API', version: '1.0.0' },
    components: {
      schemas: {
        RefundResp: {
          type: 'object',
          required: ['refundId', 'status'],
          properties: {
            refundId: { type: 'string' },
            status: { type: 'integer', enum: [0, 1, 2] },
            legacyField: { type: 'string' },
          },
        },
      },
    },
    paths: {
      '/api/refunds': {
        post: {
          parameters: [{ name: 'X-Tenant', in: 'header', required: false, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['orderId'],
                  properties: { orderId: { type: 'string' }, amount: { type: 'number' } },
                },
              },
            },
          },
          responses: {
            200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/RefundResp' } } } },
          },
        },
      },
      '/api/legacy-delete': {
        delete: { responses: { 204: { description: 'ok' } } },
      },
    },
  };

  const openApiV2 = {
    openapi: '3.0.3',
    info: { title: 'Order API', version: '2.0.0' },
    components: {
      schemas: {
        RefundResp: {
          type: 'object',
          required: ['refundId', 'status'],
          properties: {
            refundId: { type: 'string' },
            status: { type: 'string', enum: ['PENDING', 'DONE'] },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    paths: {
      '/api/refunds': {
        post: {
          parameters: [{ name: 'X-Tenant', in: 'header', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['orderId', 'reason'],
                  properties: { orderId: { type: 'string' }, amount: { type: 'number' }, reason: { type: 'string' }, note: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/RefundResp' } } } },
          },
        },
      },
      '/api/refunds/summary': {
        get: { summary: '退款汇总', responses: { 200: { description: 'ok' } } },
      },
    },
  };

  // Serve v2 live on a mock backend colleague server
  const backendMock = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(openApiV2));
  });
  backendMock.listen(0, '127.0.0.1');
  await once(backendMock, 'listening');
  t.after(() => { backendMock.closeAllConnections(); return new Promise(r => backendMock.close(r)); });
  const liveApiDoc = `http://127.0.0.1:${backendMock.address().port}/v3/api-docs`;

  // Save v1 as room artifact and register colleague agent card with liveApiDoc
  await relay.req('/api/rooms/general/artifacts/order-openapi.json', {
    method: 'PUT',
    body: { name: 'be-agent', content: JSON.stringify(openApiV1) },
    expectStatus: 201,
  });
  await relay.req('/api/join', {
    method: 'POST',
    body: { room: 'general', name: 'be-agent', card: { project: 'mall-order', apiDoc: liveApiDoc } },
  });

  // Compare artifact v1 vs colleague's live card.apiDoc, save report AND post as proposal!
  const diffRes = (await relay.req('/api/rooms/general/openapi/diff', {
    method: 'POST',
    body: {
      name: 'fe-agent',
      base: { artifact: 'order-openapi.json', version: 1 },
      target: { agent: 'be-agent' },
      saveArtifact: 'refund-diff.md',
      postAsProposal: true,
    },
  })).body;

  assert.equal(diffRes.summary.compatible, false);
  assert.ok(diffRes.breaking.some(x => x.category === 'endpoint_removed' && x.endpoint === 'DELETE /api/legacy-delete'));
  assert.ok(diffRes.breaking.some(x => x.category === 'param_now_required'));
  assert.ok(diffRes.breaking.some(x => x.category === 'request_required_field_added' && x.field === 'reason'));
  assert.ok(diffRes.breaking.some(x => x.category === 'response_field_removed' && x.field === 'legacyField'));
  assert.ok(diffRes.breaking.some(x => x.category === 'response_type_changed' && x.field === 'status'));
  assert.ok(diffRes.nonBreaking.some(x => x.category === 'endpoint_added' && x.endpoint === 'GET /api/refunds/summary'));
  assert.ok(diffRes.nonBreaking.some(x => x.category === 'request_field_added' && x.field === 'note'));
  assert.equal(diffRes.savedArtifact.name, 'refund-diff.md');
  assert.equal(diffRes.proposalMessage.kind, 'proposal');
  assert.equal(diffRes.proposalMessage.proposal.status, 'pending');

  // Verify Swagger 2.0 normalization directly too
  const sw1 = { swagger: '2.0', info: { title: 'Legacy', version: '1' }, paths: { '/u': { post: { parameters: [{ in: 'body', name: 'b', required: true, schema: { type: 'object', properties: { a: { type: 'string' } } } }], responses: { 200: { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } } } };
  const sw2 = { swagger: '2.0', info: { title: 'Legacy', version: '2' }, paths: { '/u': { post: { parameters: [{ in: 'body', name: 'b', required: true, schema: { type: 'object', properties: { a: { type: 'integer' } } } }], responses: { 200: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, extra: { type: 'string' } } } } } } } } };
  const swDiff = diffOpenApi(sw1, sw2);
  assert.equal(swDiff.summary.breakingCount, 1);
  assert.equal(swDiff.summary.nonBreakingCount, 1);
});

test('LAN discovery responder advertises and discoverRelays finds server without hardcoding IP', options, async t => {
  // Pick an ephemeral UDP port for isolated testing
  const probeSock = dgram.createSocket('udp4');
  await new Promise(resolve => probeSock.bind(0, '127.0.0.1', resolve));
  const beaconPort = probeSock.address().port;
  await new Promise(resolve => probeSock.close(resolve));

  const responder = startDiscoveryResponder(() => ({
    instanceId: 'test-instance-1',
    hostname: 'dev-lan-host',
    version: '2.2.0',
    auth: 'open',
    rooms: 3,
    port: 18787,
    hosts: ['127.0.0.1'],
  }), { beaconPort, mdns: false, bindHost: '127.0.0.1' });
  t.after(() => responder.close());

  // Wait briefly for socket bind
  await new Promise(r => setTimeout(r, 80));
  const found = await discoverRelays({ timeoutMs: 600, beaconPort, hosts: ['127.0.0.1'] });
  assert.equal(found.length, 1);
  assert.equal(found[0].url, 'http://127.0.0.1:18787');
  assert.equal(found[0].hostname, 'dev-lan-host');
  assert.equal(found[0].rooms, 3);

  // Verify mDNS packet builder includes service name and TXT metadata
  const pkt = buildMdnsResponse({ hostname: 'dev-lan-host', port: 8787, version: '2.2.0', auth: 'open', rooms: 2, hosts: ['192.168.1.10'] });
  assert.ok(pkt.includes(Buffer.from('_agent-relay')));
  assert.ok(pkt.includes(Buffer.from('version=2.2.0')));

  // Verify /api/discovery endpoint on live HTTP relay
  const relay = await startRelay(t);
  const info = (await relay.req('/api/discovery')).body;
  assert.equal(info.serviceType, '_agent-relay._tcp.local');
  assert.equal(info.version, '2.2.0');
});

test('MCP server exposes new roadmap tools: artifact diff, openapi diff, export, and discover', options, async t => {
  const relay = await startRelay(t);
  const child = spawn(process.execPath, [mcpFile], {
    env: { ...process.env, RELAY_URL: relay.baseUrl, RELAY_ROOM: 'general', RELAY_NAME: 'mcp-roadmap', RELAY_TOKEN: '', RELAY_AGENT_ID: '', RELAY_AGENT_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });

  const bus = new EventEmitter();
  const responses = new Map();
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf('\n');
      if (idx === -1) break;
      const line = buf.slice(0, idx).replace(/\r$/, '').trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) { responses.set(msg.id, msg); bus.emit(`res:${msg.id}`, msg); }
    }
  });
  let seqId = 1;
  const call = async (method, params) => {
    const id = seqId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    if (responses.has(id)) return responses.get(id);
    const [msg] = await once(bus, `res:${id}`, { signal: deadline() });
    return msg;
  };
  const tool = async (name, args = {}) => (await call('tools/call', { name, arguments: args })).result;

  await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  const list = (await call('tools/list')).result.tools;
  assert.ok(list.some(x => x.name === 'relay_openapi_diff'));
  assert.ok(list.some(x => x.name === 'relay_export'));
  assert.ok(list.some(x => x.name === 'relay_discover'));

  // Artifact diff via MCP
  await tool('relay_artifacts', { action: 'put', name: 'spec.md', content: 'line1\nline2\n' });
  await tool('relay_artifacts', { action: 'put', name: 'spec.md', content: 'line1\nline2-updated\nline3\n' });
  const diffRes = await tool('relay_artifacts', { action: 'diff', name: 'spec.md', fromVersion: 1, toVersion: 2 });
  assert.match(diffRes.content[0].text, /\+line2-updated/);

  // OpenAPI diff via MCP
  const oa = await tool('relay_openapi_diff', {
    base: { openapi: '3.0.0', paths: { '/a': { get: { responses: { 200: { description: 'ok' } } } } } },
    target: { openapi: '3.0.0', paths: { '/b': { get: { responses: { 200: { description: 'ok' } } } } } },
  });
  assert.match(oa.content[0].text, /破坏性变更/);

  // Export .zip to local path via MCP
  const outZip = path.join(relay.dir, 'mcp-out.zip');
  const exp = await tool('relay_export', { format: 'zip', outputPath: outZip });
  assert.match(exp.content[0].text, /已导出/);
  const files = parseZipEntries(await fs.readFile(outZip));
  assert.ok(files.has('artifacts/spec.md'));
});
