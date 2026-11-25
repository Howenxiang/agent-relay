const assert = require('node:assert/strict');
const { execFile, fork } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const WebSocket = require('ws');

const exec = promisify(execFile);
const serverFile = path.join(__dirname, '..', 'server.js');
const clientFile = path.join(__dirname, '..', 'client.js');
const deadline = () => AbortSignal.timeout(8_000);
const options = { timeout: 30_000 };

async function startRelay(t, extraEnv = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-features-'));
  const children = new Set();
  const sockets = new Set();
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    try {
      await Promise.all([...children].map(stop => stop()));
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  async function spawnServer(overrides = {}) {
    const child = fork(serverFile, [], {
      execArgv: [],
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AGENT_RELAY_DATA: dir, ...extraEnv, ...overrides },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const exited = new Promise(resolve => child.once('close', resolve));
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    };
    children.add(stop);
    void exited.then(() => children.delete(stop));
    const [ready] = await once(child, 'message', { signal: deadline() });
    const baseUrl = `http://127.0.0.1:${ready.port}`;

    return {
      port: ready.port,
      baseUrl,
      stop,
      async req(route, { method = 'GET', body, headers = {}, expectStatus } = {}) {
        const res = await fetch(`${baseUrl}${route}`, {
          method,
          signal: deadline(),
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let data = text;
        if (res.headers.get('content-type')?.includes('application/json')) data = JSON.parse(text);
        if (expectStatus !== undefined) assert.equal(res.status, expectStatus, `${method} ${route}: ${text}`);
        return { status: res.status, body: data, headers: res.headers };
      },
      socket(params = {}) {
        const qs = new URLSearchParams(params).toString();
        const ws = new WebSocket(`ws://127.0.0.1:${ready.port}/ws${qs ? `?${qs}` : ''}`, { handshakeTimeout: 8_000 });
        sockets.add(ws);
        const bus = new EventEmitter();
        const frames = [];
        let closed = false;
        ws.on('message', raw => { frames.push(JSON.parse(raw.toString())); bus.emit('frame'); });
        ws.on('close', () => { sockets.delete(ws); closed = true; bus.emit('frame'); });
        return {
          send(data) { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); },
          async next(type) {
            const signal = deadline();
            while (!frames.some(f => f.type === type) && !closed) {
              await once(bus, 'frame', { signal });
            }
            const idx = frames.findIndex(f => f.type === type);
            assert.ok(idx >= 0, `missing WS ${type}`);
            return frames.splice(idx, 1)[0];
          },
        };
      },
    };
  }

  return { dir, spawnServer };
}

test('read/leave/unknown routes do not create phantom rooms and return availableRooms hint', options, async t => {
  const { spawnServer } = await startRelay(t);
  const relay = await spawnServer();

  const missingRead = await relay.req('/api/messages?room=typo-room', { expectStatus: 404 });
  assert.equal(missingRead.body.room, 'typo-room');
  assert.deepEqual(missingRead.body.availableRooms, ['general']);

  await relay.req('/api/agents?room=typo-room-2', { expectStatus: 404 });
  await relay.req('/api/state?room=typo-room-3', { expectStatus: 404 });
  await relay.req('/api/nonexistent?room=typo-room-4', { expectStatus: 404 });

  const leaveMissing = await relay.req('/api/leave?room=typo-leave', { method: 'POST', body: { name: 'bot' }, expectStatus: 200 });
  assert.equal(leaveMissing.body.ok, false);

  const rooms = (await relay.req('/api/rooms', { expectStatus: 200 })).body.rooms;
  assert.deepEqual(rooms.map(r => r.id), ['general']);

  // Explicit ?create=1 still opts in when requested
  const created = await relay.req('/api/messages?room=explicit-room&create=1', { expectStatus: 200 });
  assert.equal(created.body.room, 'explicit-room');
  assert.ok((await relay.req('/api/rooms')).body.rooms.some(r => r.id === 'explicit-room'));
});

test('mention parsing strips trailing punctuation and supports comma-separated mention targets', options, async t => {
  const { spawnServer } = await startRelay(t);
  const relay = await spawnServer();

  const reg = (await relay.req('/api/agents/register', { method: 'POST', body: { name: 'order-bot', role: 'Backend' }, expectStatus: 201 })).body;
  const m1 = (await relay.req('/api/messages', {
    method: 'POST',
    body: { name: 'web-bot', text: '请 @order-bot. 确认 v1.2 接口，顺便抄送 @v1.2-api, 谢谢' },
    expectStatus: 201,
  })).body;
  assert.deepEqual(m1.mentions, ['order-bot', 'v1.2-api']);

  const m2 = (await relay.req('/api/messages', {
    method: 'POST',
    body: { name: 'web-bot', text: `只发给 @${reg.agentId}.` },
    expectStatus: 201,
  })).body;
  assert.deepEqual(m2.mentions, [reg.agentId.toLowerCase()]);

  // Strict ID filter gets only m2
  const byId = (await relay.req(`/api/messages?mention=${encodeURIComponent(reg.agentId)}`)).body.messages;
  assert.deepEqual(byId.map(m => m.seq), [m2.seq]);

  // Comma-separated ID + name filter gets both m1 and m2
  const byBoth = (await relay.req(`/api/messages?mention=${encodeURIComponent(`${reg.agentId},order-bot`)}`)).body.messages;
  assert.deepEqual(byBoth.map(m => m.seq), [m1.seq, m2.seq]);
});

test('agent project cards attach, sanitize unsafe URLs, and persist across restarts for verified identities', options, async t => {
  const { spawnServer } = await startRelay(t);
  let relay = await spawnServer();

  const reg = (await relay.req('/api/agents/register', { method: 'POST', body: { name: 'order-agent', role: 'Backend' }, expectStatus: 201 })).body;
  const headers = { 'X-Agent-Id': reg.agentId, 'X-Agent-Key': reg.agentKey };

  // Unsafe javascript: URL in card must be rejected
  await relay.req('/api/join', {
    method: 'POST',
    headers,
    body: { card: { project: 'bad', localEndpoint: 'javascript:alert(1)' } },
    expectStatus: 400,
  });

  const card = {
    project: 'mall-order-service',
    owner: '张三',
    stack: 'Java 17 / Spring Boot 3',
    branch: 'feat/refund-v2',
    localEndpoint: 'http://192.168.1.25:8080',
    apiDoc: 'http://192.168.1.25:8080/v3/api-docs',
    summary: '负责订单与退款状态机',
    capabilities: ['swagger', 'read-code'],
  };
  const joined = (await relay.req('/api/join', { method: 'POST', headers, body: { card }, expectStatus: 200 })).body;
  assert.deepEqual(joined.card, card);

  // Update via PUT /api/agents/card
  const updated = (await relay.req('/api/agents/card', {
    method: 'PUT',
    headers,
    body: { card: { ...card, branch: 'feat/refund-v3' } },
    expectStatus: 200,
  })).body;
  assert.equal(updated.agent.card.branch, 'feat/refund-v3');

  // Restart server and verify persisted card is automatically restored upon join
  await relay.stop();
  relay = await spawnServer();
  const rejoined = (await relay.req('/api/join', { method: 'POST', headers, body: {}, expectStatus: 200 })).body;
  assert.equal(rejoined.card.project, 'mall-order-service');
  assert.equal(rejoined.card.branch, 'feat/refund-v3');
});

test('room artifacts support versioning, raw format, optimistic locking (409), WS broadcast, and persistence', options, async t => {
  const { spawnServer } = await startRelay(t);
  let relay = await spawnServer();

  const ws = relay.socket({ room: 'general', name: 'observer' });
  await ws.next('state');

  // Reject path traversal artifact names
  await relay.req('/api/rooms/general/artifacts/..secret', {
    method: 'PUT',
    body: { name: 'backend', content: 'bad' },
    expectStatus: 400,
  });

  // Create v1
  const v1 = (await relay.req('/api/rooms/general/artifacts/refund-api.md', {
    method: 'PUT',
    body: { name: 'backend', summary: '初始契约', expectedVersion: 0, content: '# Refund API v1\nPOST /refunds' },
    expectStatus: 201,
  })).body.artifact;
  assert.equal(v1.version, 1);
  assert.equal(v1.contentType, 'text/markdown');
  const wsUpdate = await ws.next('artifacts');
  assert.equal(wsUpdate.artifacts.length, 1);
  assert.equal(wsUpdate.artifacts[0].version, 1);

  // Stale expectedVersion returns 409 Conflict
  const conflict = await relay.req('/api/rooms/general/artifacts/refund-api.md', {
    method: 'PUT',
    body: { name: 'frontend', expectedVersion: 0, content: 'stale overwrite' },
    expectStatus: 409,
  });
  assert.equal(conflict.body.currentVersion, 1);

  // Update v2 with correct expectedVersion + announce as message
  const v2 = (await relay.req('/api/rooms/general/artifacts/refund-api.md', {
    method: 'PUT',
    body: { name: 'frontend', expectedVersion: 1, summary: '补充错误码', announce: 'message', content: '# Refund API v2\nErrors: 4001' },
    expectStatus: 200,
  })).body.artifact;
  assert.equal(v2.version, 2);
  assert.equal(v2.history.length, 2);

  // Raw format returns plain text
  const raw = await relay.req('/api/rooms/general/artifacts/refund-api.md?format=raw', { expectStatus: 200 });
  assert.equal(raw.body, '# Refund API v2\nErrors: 4001');

  // Survives server restart
  await relay.stop();
  relay = await spawnServer();
  const afterRestart = (await relay.req('/api/rooms/general/artifacts/refund-api.md', { expectStatus: 200 })).body.artifact;
  assert.equal(afterRestart.version, 2);
  assert.equal(afterRestart.content, '# Refund API v2\nErrors: 4001');

  // Delete artifact
  await relay.req('/api/rooms/general/artifacts/refund-api.md', { method: 'DELETE', body: { name: 'frontend' }, expectStatus: 200 });
  await relay.req('/api/rooms/general/artifacts/refund-api.md', { expectStatus: 404 });
});

test('proposals support human approval gate, WS update, and wake long-polling agents', options, async t => {
  const { spawnServer } = await startRelay(t);
  const relay = await spawnServer();

  const ws = relay.socket({ room: 'general', name: 'reviewer', role: 'Human' });
  await ws.next('state');

  const prop = (await relay.req('/api/messages', {
    method: 'POST',
    body: { name: 'backend-agent', role: 'Backend', kind: 'proposal', text: '提案：将 refundStatus 从数字改为字符串枚举' },
    expectStatus: 201,
  })).body;
  assert.equal(prop.proposal.status, 'pending');

  // Start long-poll waiting for @backend-agent decision reply
  const waitPromise = relay.req(`/api/messages?room=general&since=${prop.seq}&wait=10&mention=backend-agent&name=backend-agent&exclude_self=1`, { expectStatus: 200 });

  const decided = (await relay.req(`/api/rooms/general/proposals/${prop.seq}/decision`, {
    method: 'POST',
    body: { name: '张三', role: 'Human', decision: 'approved', comment: '同意，请保留旧字段一个版本' },
    expectStatus: 200,
  })).body;
  assert.equal(decided.message.proposal.status, 'approved');
  assert.equal(decided.message.proposal.decisions.length, 1);
  assert.equal(decided.replyMessage.kind, 'decision');
  assert.equal(decided.replyMessage.replyTo, prop.seq);

  const wsUpdated = await ws.next('message_updated');
  assert.equal(wsUpdated.message.proposal.status, 'approved');

  const woke = await waitPromise;
  assert.equal(woke.body.messages.length, 1);
  assert.equal(woke.body.messages[0].kind, 'decision');
  assert.match(woke.body.messages[0].text, /已通过/);
});

test('room pause circuit breaker (423) and anti-loop rate limiter (429) protect against runaway agents', options, async t => {
  const { spawnServer } = await startRelay(t, { AGENT_RELAY_RATE_LIMIT: '3', AGENT_RELAY_RATE_WINDOW_SEC: '30' });
  const relay = await spawnServer();

  // Send 3 messages quickly (allowed), 4th hits 429
  for (let i = 1; i <= 3; i++) {
    await relay.req('/api/messages', { method: 'POST', body: { name: 'chatty-bot', text: `msg ${i}` }, expectStatus: 201 });
  }
  const limited = await relay.req('/api/messages', { method: 'POST', body: { name: 'chatty-bot', text: 'msg 4' }, expectStatus: 429 });
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);

  // Pause room
  const paused = (await relay.req('/api/rooms/general', {
    method: 'PATCH',
    body: { paused: true, pausedReason: '暂停排查死循环', pausedBy: '张三' },
    expectStatus: 200,
  })).body;
  assert.equal(paused.paused, true);

  // Normal agent gets 423 Locked
  const blocked = await relay.req('/api/messages', {
    method: 'POST',
    body: { name: 'other-bot', role: 'Agent', text: 'should be blocked' },
    expectStatus: 423,
  });
  assert.equal(blocked.body.paused, true);

  // Human role can still speak while paused
  await relay.req('/api/messages', {
    method: 'POST',
    body: { name: '张三', role: 'Human', text: '大家先停一下，按方案 B 来' },
    expectStatus: 201,
  });

  // Resume room allows agent again
  await relay.req('/api/rooms/general', { method: 'PATCH', body: { paused: false, pausedBy: '张三' }, expectStatus: 200 });
  await relay.req('/api/messages', {
    method: 'POST',
    body: { name: 'other-bot', role: 'Agent', text: '收到，继续' },
    expectStatus: 201,
  });
});

test('CLI handles special chars in cursor names, -- flag separator, cards, artifacts and proposals', options, async t => {
  const { spawnServer } = await startRelay(t);
  const relay = await spawnServer();
  const env = { ...process.env, RELAY_URL: relay.baseUrl, RELAY_TOKEN: '' };
  const runCli = (args, extra = {}) => exec(process.execPath, [clientFile, ...args], { env: { ...env, ...extra }, timeout: 8_000 });

  // Name with Windows-illegal characters like ':' and '/' should not crash cursor persistence
  await runCli(['join', '--name', 'dev:bot/1', '--project', 'mall-web', '--branch', 'main']);
  const sent = await runCli(['send', '--name', 'dev:bot/1', '--', '--flag-like-message']);
  assert.match(sent.stdout, /ok #1/);

  const read = await runCli(['read', '--name', 'other:bot', '--all']);
  assert.match(read.stdout, /--flag-like-message/);

  // Artifact put & get via CLI
  const put = await runCli(['artifact-put', 'types.ts', '--name', 'dev:bot/1', '--summary', 'v1 types', 'export type ID = string;']);
  assert.match(put.stdout, /ok types\.ts v1/);
  const got = await runCli(['artifact-get', 'types.ts', '--raw']);
  assert.equal(got.stdout, 'export type ID = string;');

  // Proposal & decide via CLI
  await runCli(['send', '--name', 'dev:bot/1', '--kind', 'proposal', '提案：升级接口版本']);
  const decided = await runCli(['decide', '2', 'approved', '没问题', '--name', '张三', '--role', 'Human']);
  assert.match(decided.stdout, /ok proposal #2 -> approved/);
});
