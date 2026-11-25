const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

const serverFile = path.join(__dirname, '..', 'server.js');
const deadline = () => AbortSignal.timeout(8_000);
const options = { timeout: 30_000 };
const randomKey = () => randomBytes(32).toString('base64url');
const digest = (key) => createHash('sha256').update(key).digest('hex');
const uuidPattern = '[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const registeredId = new RegExp(`^agt_${uuidPattern}$`);
const guestId = new RegExp(`^${uuidPattern}$`);
const proof = ({ agentId, agentKey }) => ({ agentId, agentKey });
const headersFor = ({ agentId, agentKey }) => ({ 'X-Agent-Id': agentId, 'X-Agent-Key': agentKey });
const query = (route, params) => `${route}?${new URLSearchParams(params)}`;
const state = (relay, room = 'general') => relay.request(query('/api/state', { room })).then(r => r.body);

const oldMessage = {
  id: 'old-message', seq: 7, room: 'general', agentId: randomUUID(), agent: 'Old Guest',
  role: 'Agent', text: 'History from before identity registration', kind: 'message', at: '2025-01-02T03:04:05.000Z',
};

async function fixture(t, { seed = false, token = '' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-identity-'));
  const file = path.join(dir, 'relay.json');
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
  if (seed) await fs.writeFile(file, JSON.stringify({ rooms: [{ id: 'general', messages: [oldMessage] }] }));

  async function start() {
    const child = fork(serverFile, [], {
      execArgv: [],
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AGENT_RELAY_DATA: dir, AGENT_RELAY_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    }
    const exited = new Promise(resolve => child.once('close', resolve));
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    };
    children.add(stop);
    void exited.then(() => children.delete(stop));

    let ready;
    try {
      ready = await Promise.race([
        once(child, 'message', { signal: deadline() }).then(([msg]) => msg),
        exited.then(code => { throw new Error(`relay exited with code ${code}`); }),
      ]);
      assert.equal(ready?.type, 'ready');
      assert.ok(Number.isInteger(ready.port) && ready.port > 0);
    } catch (error) {
      throw new Error(`relay did not report its ephemeral loopback port: ${error.message}\n${output}`, { cause: error });
    }

    return {
      stop, file,
      async request(route, { method = 'GET', body, raw, headers = {}, status = 200 } = {}) {
        const response = await fetch(`http://127.0.0.1:${ready.port}${route}`, {
          method, signal: deadline(),
          headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: body === undefined ? raw : JSON.stringify(body),
        });
        const text = await response.text();
        const label = `${method} ${route.split('?')[0]}`;
        if (status === '4xx') assert.ok(response.status >= 400 && response.status < 500, `${label}: expected 4xx, got ${response.status}`);
        else assert.equal(response.status, status, label);
        return { body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text, headers: response.headers };
      },
      socket(params = {}, headers = {}) {
        const ws = new WebSocket(`ws://127.0.0.1:${ready.port}${query('/ws', params)}`, { headers, handshakeTimeout: 8_000 });
        sockets.add(ws);
        const notifications = new EventEmitter();
        const frames = [];
        let error;
        let opened = false;
        let closed = false;
        ws.on('open', () => { opened = true; });
        ws.on('error', cause => { error = cause; notifications.emit('change'); });
        ws.on('message', raw => {
          try { frames.push(JSON.parse(raw.toString())); }
          catch (cause) { error = cause; }
          notifications.emit('change');
        });
        ws.on('close', () => {
          sockets.delete(ws);
          closed = true;
          notifications.emit('change');
        });
        return {
          send(data) { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); },
          async next(type) {
            const signal = deadline();
            const matches = frame => frame?.type === type;
            while (!frames.some(matches) && !closed && !error) {
              try { await once(notifications, 'change', { signal }); }
              catch (cause) { throw new Error(`timed out waiting for WS ${type}`, { cause }); }
            }
            const index = frames.findIndex(matches);
            assert.ok(index >= 0, `missing WS ${type} (received: ${frames.map(f => f?.type).join(', ')}; ${error?.message || 'closed'})`);
            return frames.splice(index, 1)[0];
          },
          async closed() {
            const signal = deadline();
            while (!closed) {
              try { await once(notifications, 'change', { signal }); }
              catch (cause) { throw new Error('timed out waiting for WS close', { cause }); }
            }
            return { opened };
          },
        };
      },
    };
  }
  return start;
}

async function register(relay, name = 'Shared Name', role = 'reviewer', headers = {}) {
  const { body, headers: responseHeaders } = await relay.request('/api/agents/register', {
    method: 'POST', status: 201, headers, body: role === null ? { name } : { name, role },
  });
  assert.equal(responseHeaders.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(body).sort(), ['agentId', 'agentKey', 'createdAt', 'name', 'role', 'verified']);
  assert.match(body.agentId, registeredId);
  assert.ok(typeof body.agentKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.agentKey), 'registration returns a 43-character base64url key');
  assert.equal(body.name, name);
  if (role !== null) assert.equal(body.role, role);
  else assert.ok(typeof body.role === 'string' && body.role.length > 0);
  assert.equal(body.verified, true);
  assert.ok(Number.isFinite(Date.parse(body.createdAt)));
  return body;
}

function assertPublic(data, ...identities) {
  const text = JSON.stringify(data);
  assert.ok(!/"(?:agentkey|keyhash)"\s*:/i.test(text), 'public response contains no credential fields');
  for (const { agentKey } of identities) {
    assert.ok(!text.includes(agentKey), 'public response does not contain the raw key');
    assert.ok(!text.includes(digest(agentKey)), 'public response does not contain the key digest');
  }
}

function assertMember(member, identity) {
  assert.equal(member.id, identity.agentId);
  assert.equal(member.name, identity.name);
  assert.equal(member.role, identity.role);
  assert.equal(member.verified, true);
  assertPublic(member, identity);
}

function assertMessage(message, identity) {
  assert.equal(message.agentId, identity.agentId);
  assert.equal(message.agent, identity.name);
  assert.equal(message.role, identity.role);
  assert.equal(message.verified, true);
  assertPublic(message, identity);
}

test('registration is opt-in, immediate, distinct by ID, and durable without storing raw keys', options, async t => {
  const start = await fixture(t, { seed: true });
  let relay = await start();
  const health = (await relay.request('/api/health')).body;
  assert.equal(health.ok, true);
  assert.equal(health.agentIdentity, 'optional-key');

  const first = await register(relay);
  // Read immediately: a later background save or a shutdown flush is not sufficient.
  const firstFile = await fs.readFile(relay.file, 'utf8');
  assert.ok(JSON.stringify(JSON.parse(firstFile).identities).includes(first.agentId));
  assert.ok(firstFile.includes(digest(first.agentKey)), 'the digest must be committed before registration returns');
  assert.ok(!firstFile.includes(first.agentKey), 'the raw key must never be persisted');

  const second = await register(relay, first.name, null);
  assert.notEqual(first.agentId, second.agentId);
  assert.ok(first.agentKey !== second.agentKey, 'distinct registrations issue distinct keys');
  const saved = await fs.readFile(relay.file, 'utf8');
  const registry = JSON.stringify(JSON.parse(saved).identities);
  for (const identity of [first, second]) {
    assert.ok(registry.includes(identity.agentId) && registry.includes(digest(identity.agentKey)));
    assert.ok(!saved.includes(identity.agentKey), 'the raw key must never be persisted');
  }

  await relay.stop();
  relay = await start();
  for (const identity of [first, second]) {
    const { body } = await relay.request('/api/messages', {
      method: 'POST', status: 201, headers: headersFor(identity), body: { text: 'authenticated after restart' },
    });
    assertMessage(body, identity);
  }
  const current = await state(relay);
  assert.ok(current.messages.some(m => m.id === oldMessage.id), 'pre-registration history survives restart');
  assertPublic(current, first, second);
});

test('storage failures keep the last snapshot, reject new writes and retry queued data', options, async t => {
  const relay = await (await fixture(t))();
  const identity = await register(relay);
  const saved = await fs.readFile(relay.file, 'utf8');
  const blocked = `${relay.file}.tmp`;
  await fs.mkdir(blocked);
  const message = (await relay.request('/api/messages', {
    method: 'POST', status: 201, headers: headersFor(identity), body: { text: 'accepted before storage failure was detected' },
  })).body;
  const { body: rejected } = await relay.request('/api/agents/register', {
    method: 'POST', status: 503, body: { name: 'registration that must not be saved' },
  });
  assertPublic(rejected, identity);
  await delay(1100);
  assert.equal(await fs.readFile(relay.file, 'utf8'), saved);
  assert.deepEqual((await state(relay)).messages.map(m => m.id), [message.id]);
  await relay.request('/api/messages?room=not-created-during-outage', {
    method: 'POST', status: 503, body: { text: 'not accepted while storage is unavailable' },
  });
  assert.ok(!(await relay.request('/api/rooms')).body.rooms.some(room => room.id === 'not-created-during-outage'));

  await fs.rmdir(blocked);
  const signal = deadline();
  let restored;
  do {
    await delay(30, undefined, { signal });
    restored = JSON.parse(await fs.readFile(relay.file, 'utf8'));
  } while (!restored.rooms[0].messages.some(m => m.id === message.id));
  assert.deepEqual(Object.keys(restored.identities), [identity.agentId]);
  await register(relay, 'registration after storage recovery');
});

test('all POST aliases authenticate before mutating rooms, messages or presence', options, async t => {
  const relay = await (await fixture(t))();
  const identity = await register(relay);
  const other = await register(relay);
  const room = 'protected-http';
  const endpoint = (name) => query(`/api/${name}`, { room });
  const suppliedProfile = { name: 'Spoofed display name', role: 'owner', verified: false };
  const joined = await relay.request(endpoint('join'), {
    method: 'POST', body: { ...proof(identity), ...suppliedProfile },
  });
  assertMember(joined.body, identity);
  const heartbeat = await relay.request(endpoint('heartbeat'), {
    method: 'POST', headers: headersFor(identity), body: { ...suppliedProfile, status: 'still here' },
  });
  assertMember(heartbeat.body.agent, identity);

  const wrongKey = randomKey();
  const unknownId = `agt_${randomUUID()}`;
  const cases = [
    ['ID only', 401, { agentId: identity.agentId }],
    ['empty ID', 401, { agentId: '' }],
    ['null ID', 401, { agentId: null }],
    ['key only', 401, { agentKey: identity.agentKey }],
    ['wrong key', 401, { agentId: identity.agentId, agentKey: wrongKey }],
    ['invalid key type', 401, { agentId: identity.agentId, agentKey: [identity.agentKey] }],
    ['unknown ID', 401, { agentId: unknownId, agentKey: identity.agentKey }],
    ['header ID only', 401, {}, { 'X-Agent-Id': identity.agentId }],
    ['empty header ID', 401, {}, { 'X-Agent-Id': '' }],
    ['header key only', 401, {}, { 'X-Agent-Key': identity.agentKey }],
    ['partial header with body key', 400, { agentKey: identity.agentKey }, { 'X-Agent-Id': identity.agentId }],
    ['partial header with body ID', 400, { agentId: identity.agentId }, { 'X-Agent-Key': identity.agentKey }],
    ['both sources', 400, proof(identity), headersFor(identity)],
    ['conflicting sources', 400, proof(other), headersFor(identity)],
    ['query key', 400, { agentId: identity.agentId }, {}, { agentKey: identity.agentKey }],
  ];
  const before = await state(relay, room);
  const roomsBefore = (await relay.request('/api/rooms')).body;
  for (const name of ['messages', 'message', 'send', 'join', 'heartbeat', 'leave']) {
    for (const target of [room, 'must-not-be-created']) {
      for (const [label, status, body, headers, search] of cases) {
        const { body: result } = await relay.request(query(`/api/${name}`, { room: target, ...search }), {
          method: 'POST', status, headers, body: { name: 'Rejected', text: `rejected ${label}`, ...body },
        }).catch(error => { throw new Error(`${name}, ${label}, ${target}: ${error.message}`, { cause: error }); });
        assertPublic(result, identity, other);
      }
    }
  }

  for (const auth of [
    { headers: headersFor(identity) },
    { search: { agentId: identity.agentId } },
    { search: { agentKey: identity.agentKey } },
  ]) {
    await relay.request(query('/api/send', { room, name: identity.name, text: 'not a protected GET', ...auth.search }), {
      headers: auth.headers, status: '4xx',
    });
  }
  assert.deepEqual(await state(relay, room), before);
  assert.deepEqual((await relay.request('/api/rooms')).body, roomsBefore);

  const messageAliases = ['messages', 'message', 'send'];
  for (const [index, name] of messageAliases.entries()) {
    const auth = index % 2 === 0 ? { body: proof(identity) } : { headers: headersFor(identity) };
    const { body } = await relay.request(endpoint(name), {
      method: 'POST', status: 201, headers: auth.headers, body: { text: name, ...suppliedProfile, ...auth.body },
    });
    assertMessage(body, identity);
  }
  const { body: members } = await relay.request(endpoint('agents'));
  assert.equal(members.agents.length, 1);
  assertMember(members.agents[0], identity);
  const { body: left } = await relay.request(endpoint('leave'), { method: 'POST', body: proof(identity) });
  assert.equal(left.ok, true);
  assert.deepEqual((await state(relay, room)).agents, []);
});

test('malformed structured credentials are rejected instead of becoming chat text', options, async t => {
  const relay = await (await fixture(t))();
  const a = await register(relay);
  const initial = await state(relay);
  const malformedInputs = [
    ['incomplete object', `{"text":"do not publish","agentId":"${a.agentId}","agentKey":"${a.agentKey}",`],
    ['array instead of object', JSON.stringify([{ text: 'wrong request shape', ...proof(a) }])],
    ['incomplete object with an escaped field', `{"text":"do not publish","agent\\u004bey":"${a.agentKey}",`],
  ];
  for (const contentType of ['application/json', 'text/plain']) {
    for (const [label, raw] of malformedInputs) {
      const { body } = await relay.request('/api/messages', {
        method: 'POST', status: 400, raw, headers: { 'Content-Type': contentType },
      }).catch(error => { throw new Error(`${label} as ${contentType}: ${error.message}`, { cause: error }); });
      assertPublic(body, a);
    }
  }
  const ws = relay.socket();
  await ws.next('state');
  ws.send(`{"type":"message","text":"not public","agentKey":"${a.agentKey}",`);
  assertPublic(await ws.next('error'), a);
  assert.deepEqual(await state(relay), initial);
});

test('legacy guests and history coexist with exact ID selectors and ID mentions', options, async t => {
  const relay = await (await fixture(t, { seed: true }))();
  const a = await register(relay);
  const b = await register(relay, a.name, 'builder');
  const guest = (await relay.request('/api/join', { method: 'POST', body: { name: a.name, verified: true } })).body;
  assert.match(guest.id, guestId);
  assert.equal(guest.verified, false);
  const beat = (await relay.request('/api/heartbeat', { method: 'POST', body: { id: guest.id } })).body;
  assert.equal(beat.agent.id, guest.id);

  const g = (await relay.request(query('/api/send', { name: a.name, text: 'legacy GET' }), { status: 201 })).body;
  assert.equal(g.agentId, guest.id);
  assert.equal(g.verified, false);
  const raw = (await relay.request(query('/api/messages', { name: a.name }), {
    method: 'POST', status: 201, raw: '[INFO] legacy plain body', headers: { 'Content-Type': 'text/plain' },
  })).body;
  assert.equal(raw.agentId, guest.id);
  assert.equal(raw.text, '[INFO] legacy plain body');
  assert.equal(raw.verified, false);

  const aMessage = (await relay.request('/api/messages', {
    method: 'POST', status: 201, body: { ...proof(a), text: 'written by the first ID' },
  })).body;
  const bMessage = (await relay.request('/api/messages', {
    method: 'POST', status: 201, body: { ...proof(b), text: `only for @${a.agentId}` },
  })).body;
  assertMessage(aMessage, a);
  assertMessage(bMessage, b);
  const separate = (await relay.request(query('/api/heartbeat', { room: 'other-guest-room' }), {
    method: 'POST', body: { id: guest.id, name: guest.name },
  })).body.agent;
  assert.equal(separate.verified, false);
  assert.notEqual(separate.id, guest.id, 'guest IDs do not move presence across rooms');
  const joinedIds = (await state(relay)).agents.map(member => member.id).sort();
  assert.deepEqual(joinedIds, [a.agentId, b.agentId, guest.id].sort());
  const joinEvents = (await state(relay)).events.filter(e => e.type === 'join');
  assert.deepEqual(joinEvents.map(e => [e.agentId, e.verified]), [
    [b.agentId, true], [a.agentId, true], [guest.id, false],
  ]);

  const read = async params => (await relay.request(query('/api/messages', params))).body.messages;
  const legacy = await read({ from_id: oldMessage.agentId });
  assert.equal(legacy.length, 1);
  assert.deepEqual(legacy[0], { ...oldMessage, mentions: [] });
  assert.deepEqual((await read({ from_id: a.agentId })).map(m => m.id), [aMessage.id]);
  assert.deepEqual(await read({ from_id: a.agentId.toUpperCase() }), []);
  assert.deepEqual(
    (await read({ exclude_self: '1', self_id: a.agentId, name: a.name })).map(m => m.id),
    [oldMessage.id, g.id, raw.id, bMessage.id],
  );
  assert.deepEqual((await read({ mention: `@${a.agentId}` })).map(m => m.id), [bMessage.id]);
  assertPublic(await read({}), a, b);
  assertPublic((await relay.request(query('/api/messages', { format: 'text' }))).body, a, b);
  const leave = (await relay.request('/api/leave', { method: 'POST', body: { id: guest.id } })).body;
  assert.equal(leave.ok, true);
  assert.deepEqual((await state(relay)).agents.map(member => member.id).sort(), [a.agentId, b.agentId].sort());
});

async function joinSocket(socket, identity) {
  const initial = await socket.next('state');
  assertPublic(initial, identity);
  socket.send({ type: 'join', ...proof(identity), name: 'untrusted socket name', role: 'owner' });
  assertMember((await socket.next('joined')).agent, identity);
}

test('WebSockets bind protected joins, reject switching, and scope leave and room deletion', options, async t => {
  const relay = await (await fixture(t))();
  const a = await register(relay);
  const b = await register(relay, a.name, 'builder');
  const rejectedUpgrade = relay.socket({ room: 'invalid-upgrade', ...proof(a) });
  assert.equal((await rejectedUpgrade.closed()).opened, false, 'agent proof is not sent in an upgrade URL');
  assert.ok(!(await relay.request('/api/rooms')).body.rooms.some(room => room.id === 'invalid-upgrade'));

  const invalid = relay.socket();
  await invalid.next('state');
  const initial = await state(relay);
  invalid.send({ type: 'join', agentId: a.agentId, agentKey: randomKey() });
  assertPublic(await invalid.next('error'), a);
  assert.ok((await invalid.closed()).opened, 'invalid proof returns an error on the upgraded socket, then closes');
  const unjoined = relay.socket();
  await unjoined.next('state');
  unjoined.send({ type: 'message', ...proof(a), text: 'must authenticate via join first' });
  assertPublic(await unjoined.next('error'), a);
  assert.deepEqual(await state(relay), initial);

  const primary = relay.socket();
  const twin = relay.socket();
  const peer = relay.socket();
  const elsewhere = relay.socket({ room: 'removable' });
  await Promise.all([joinSocket(primary, a), joinSocket(twin, a), joinSocket(peer, b), joinSocket(elsewhere, a)]);

  primary.send({ type: 'message', text: 'bound JSON', name: b.name, role: b.role });
  await primary.next('ack');
  primary.send('bound plain');
  await primary.next('ack');
  primary.send({ type: 'ping' });
  assert.equal((await primary.next('pong')).lastSeq, 2);
  for (const attempt of [
    { type: 'join', ...proof(b) },
    { type: 'join', name: 'downgraded guest' },
    { type: 'message', ...proof(b), text: 'rejected switch' },
  ]) {
    primary.send(attempt);
    assertPublic(await primary.next('error'), a, b);
  }
  primary.send('still bound to original ID');
  await primary.next('ack');
  const current = await state(relay);
  assert.deepEqual(current.messages.map(m => m.text), ['bound JSON', 'bound plain', 'still bound to original ID']);
  for (const message of current.messages) assertMessage(message, a);
  assertPublic(await peer.next('message'), a, b);

  const { body: left } = await relay.request('/api/leave', { method: 'POST', headers: headersFor(a), body: {} });
  assert.equal(left.ok, true);
  await Promise.all([primary.closed(), twin.closed()]);
  assert.deepEqual((await state(relay)).agents.map(member => member.id), [b.agentId]);
  for (const alive of [peer, elsewhere]) {
    alive.send({ type: 'ping' });
    await alive.next('pong');
  }

  await relay.request('/api/rooms/removable', { method: 'DELETE' });
  await elsewhere.closed();
  const replacement = relay.socket({ room: 'removable' });
  const fresh = await replacement.next('state');
  assert.deepEqual(fresh.state.agents, []);
  assert.deepEqual(fresh.state.messages, []);

  const guest = relay.socket({ name: 'guest-over-ws' });
  const guestState = await guest.next('state');
  assert.equal(guestState.you.verified, false);
  guest.send({ type: 'join', agentId: guestState.you.id });
  assert.equal((await guest.next('joined')).agent.id, guestState.you.id);
  const plain = ['[INFO] guest plain frame', '[2026-11-25] job completed', '{build} ready'];
  for (const text of plain) {
    guest.send(text);
    await guest.next('ack');
  }
  const messages = (await state(relay)).messages;
  assert.deepEqual(messages.slice(-plain.length).map(m => m.text), plain);
  assert.equal(messages.at(-1).agentId, guestState.you.id);
  assert.equal(messages.at(-1).verified, false);
});

test('the shared token is enforced independently of the Agent ID and key', options, async t => {
  const token = randomKey();
  const relay = await (await fixture(t, { token }))();
  const global = { Authorization: `Bearer ${token}` };
  const health = (await relay.request('/api/health')).body;
  assert.equal(health.auth, 'shared-token');
  assert.equal(health.agentIdentity, 'optional-key');
  await relay.request('/api/agents/register', { method: 'POST', status: 401, body: { name: 'No shared token' } });
  const identity = await register(relay, 'Protected Agent', 'tester', global);
  await relay.request('/api/messages', {
    method: 'POST', status: 401, body: { ...proof(identity), text: 'agent proof without relay token' },
  });
  await relay.request('/api/messages', {
    method: 'POST', status: 401, headers: global, body: { agentId: identity.agentId, agentKey: token, text: 'relay token as agent key' },
  });
  const guest = await relay.request('/api/messages', {
    method: 'POST', status: 201, headers: global, body: { name: identity.name, text: 'authorized guest' },
  });
  assert.equal(guest.body.verified, false);
  assert.notEqual(guest.body.agentId, identity.agentId);
  assert.equal((await relay.socket().closed()).opened, false);
  const ws = relay.socket({}, global);
  await joinSocket(ws, identity);
  ws.send('authorized protected message');
  await ws.next('ack');
  const { body } = await relay.request('/api/state', { headers: global });
  assert.deepEqual(body.messages.map(m => m.text), ['authorized guest', 'authorized protected message']);
  assertMessage(body.messages[1], identity);
  assertPublic(body, identity, { agentKey: token });
});
