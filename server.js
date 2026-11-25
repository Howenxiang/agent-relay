const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
// 留空 = 开放模式（局域网内任何人/Agent 无需 Token 即可使用）；设置后所有 API 需携带该共享口令
const SHARED_TOKEN = process.env.AGENT_RELAY_TOKEN || '';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.AGENT_RELAY_DATA || path.join(ROOT, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'relay.json');
const GUIDE_FILE = path.join(ROOT, 'AGENT_ONBOARDING_PROMPT.md');

const MAX_TEXT = 20000;
const MAX_MESSAGES = 5000;
const MAX_EVENTS = 100;
const MAX_BODY = 1024 * 1024;
const ONLINE_MS = 90 * 1000;
const MAX_WAIT_SECONDS = 60;
const COLORS = ['#6C63FF', '#4F8DFD', '#2EC4B6', '#5FE1AB', '#F0C36D', '#FF8A65', '#E86AF0', '#76B5FF', '#A3E635', '#F472B6'];

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const httpError = (status, message) => Object.assign(new Error(message), { status });
const within = (dir, file) => {
  const relative = path.relative(dir, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// ---------- 持久化 ----------
function load(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
if (within(PUBLIC_DIR, DATA_DIR)) throw new Error('AGENT_RELAY_DATA must be outside the public directory');
fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(PUBLIC_DIR) && within(fs.realpathSync(PUBLIC_DIR), fs.realpathSync(DATA_DIR))) {
  throw new Error('AGENT_RELAY_DATA must be outside the public directory');
}
const store = load(DATA_FILE, { rooms: [] });
if (!store || typeof store !== 'object' || Array.isArray(store)) throw new Error('Invalid relay data');
if (!Array.isArray(store.rooms)) store.rooms = [];
if (!Object.hasOwn(store, 'identities')) store.identities = {};
else if (!store.identities || typeof store.identities !== 'object' || Array.isArray(store.identities)) throw new Error('Invalid identities in relay data');
for (const room of store.rooms) normalizeRoom(room);
if (!store.rooms.some(r => r.id === 'general')) store.rooms.unshift(normalizeRoom({ id: 'general', name: '大厅 General' }));

let persistTimer = null;
let persistRetryMs = 0;
function persistNow() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  persistRetryMs = 0;
}
function retryPersistence() {
  if (!persistRetryMs) console.error('无法写入群聊数据，保留上一次快照，暂停写入并重试');
  persistRetryMs = Math.min(persistRetryMs ? persistRetryMs * 2 : 1000, 30000);
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistPending, persistRetryMs);
}
function persistPending() {
  persistTimer = null;
  try { persistNow(); } catch { retryPersistence(); }
}
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(persistPending, 200);
}
function requireWritable() {
  if (persistRetryMs) throw httpError(503, 'Relay storage temporarily unavailable');
}

function normalizeRoom(room) {
  room.id = room.id || uid();
  room.name = room.name || room.id;
  room.topic = room.topic || '';
  room.createdAt = room.createdAt || now();
  room.messages = Array.isArray(room.messages) ? room.messages : [];
  room.events = Array.isArray(room.events) ? room.events : [];
  room.seq = Number(room.seq) || 0;
  for (const m of room.messages) {
    if (!m.seq) m.seq = ++room.seq;
    if (!Array.isArray(m.mentions)) m.mentions = parseMentions(m.text || '');
  }
  room.seq = Math.max(room.seq, ...room.messages.map(m => m.seq), 0);
  return room;
}

// ---------- 工具函数 ----------
function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}
function cleanName(value, fallback = 'anonymous') {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return name || fallback;
}
function colorFor(name) {
  const hash = crypto.createHash('md5').update(name.toLowerCase()).digest();
  return COLORS[hash[0] % COLORS.length];
}
function parseMentions(text) {
  const set = new Set();
  for (const match of String(text).matchAll(/@([\p{L}\p{N}_.-]+)/gu)) set.add(match[1].toLowerCase());
  return [...set];
}
function toList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : String(value).split(',')).map(v => String(v).trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
}
function localAddresses() {
  const list = [];
  for (const group of Object.values(os.networkInterfaces())) for (const item of group || []) if (item.family === 'IPv4' && !item.internal) list.push(item.address);
  const rank = (ip) => /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  list.sort((a, b) => rank(a) - rank(b));
  return list.length ? list : ['localhost'];
}
function baseUrl(req) { return `http://${req.headers.host || `${localAddresses()[0]}:${PORT}`}`; }
function fmtTime(iso) { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Token, X-Agent-Id, X-Agent-Key'
};
function send(res, status, body, type = 'application/json') {
  const text = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', ...CORS });
  res.end(text);
}
const contentType = (req) => (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
// 保留 `[INFO]` 等旧版纯文本，但疑似凭据帧不能降级为聊天内容。
function looksLikeCredentialFrame(text) {
  if (!/^\s*(?:\{|\[)/.test(text)) return false;
  const decoded = text.replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  return /\bagent(?:Id|Key)\b/i.test(decoded);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; if (data.length > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } });
    req.on('end', () => {
      if (!data) return resolve({});
      const type = contentType(req);
      if (type.includes('application/x-www-form-urlencoded')) {
        const form = Object.fromEntries(new URLSearchParams(data));
        return resolve(form.text || form.content || form.message || Object.hasOwn(form, 'agentKey') ? form : { ...form, text: data });
      }
      let payload;
      try { payload = JSON.parse(data); } catch {
        // 声明为 JSON 的正文可能包含凭据，解析失败时不能当作聊天文本转发。
        if (type === 'application/json' || looksLikeCredentialFrame(data)) {
          return reject(httpError(400, 'Invalid JSON body'));
        }
        return resolve({ text: data });
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        if (type === 'application/json' || looksLikeCredentialFrame(typeof payload === 'string' ? payload : data)) {
          return reject(httpError(400, 'Expected a JSON object'));
        }
        return resolve({ text: data });
      }
      resolve(payload);
    });
    req.on('error', reject);
  });
}
function authorized(req, url) {
  if (!SHARED_TOKEN) return true;
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-relay-token'] || url.searchParams.get('token'));
  return given === SHARED_TOKEN;
}

// ---------- 可选的持久化身份 ----------
const LEGACY_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const isRegisteredIdClaim = (id) => typeof id === 'string' && /^agt_/i.test(id.trim());
const keyHash = (key) => crypto.createHash('sha256').update(key).digest();
function registerIdentity(data) {
  requireWritable();
  const name = typeof data.name === 'string' ? cleanName(data.name, '') : '';
  if (!name) throw httpError(400, 'name is required');
  let id;
  do { id = `agt_${uid()}`; } while (Object.hasOwn(store.identities, id));
  const agentKey = crypto.randomBytes(32).toString('base64url');
  const role = typeof data.role === 'string' ? data.role.trim().slice(0, 30) || 'Agent' : 'Agent';
  const createdAt = now();
  store.identities[id] = { id, name, role, createdAt, keyHash: keyHash(agentKey).toString('hex') };
  // 先保管摘要再回传密钥，避免返回一个重启即失效的身份。
  try { persistNow(); }
  catch {
    delete store.identities[id];
    retryPersistence();
    throw httpError(503, 'Relay storage temporarily unavailable');
  }
  return { agentId: id, agentKey, name, role, verified: true, createdAt };
}
function authenticateIdentity(id, key) {
  const identity = typeof id === 'string' && Object.hasOwn(store.identities, id) ? store.identities[id] : null;
  if (!identity || typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)
      || !/^[0-9a-f]{64}$/.test(identity.keyHash)
      || !crypto.timingSafeEqual(keyHash(key), Buffer.from(identity.keyHash, 'hex'))) {
    throw httpError(401, 'Valid Agent ID and key required');
  }
  return identity;
}
function optionalIdentity(id, key) {
  if (key === undefined && (id === undefined || (typeof id === 'string' && LEGACY_ID.test(id)))) return null;
  return authenticateIdentity(id, key);
}

function httpWriter(req, url, data, message, input) {
  const headerId = req.headers['x-agent-id'];
  const headerKey = req.headers['x-agent-key'];
  const hasHeaders = headerId !== undefined || headerKey !== undefined;
  const bodyIds = Object.hasOwn(data, 'agentId') ? [data.agentId] : [];
  if (data.id && (!message || isRegisteredIdClaim(data.id))) bodyIds.push(data.id);
  const queryIds = [...url.searchParams.getAll('agentId'), ...url.searchParams.getAll('id').filter(isRegisteredIdClaim)];
  if (queryIds.some(id => !LEGACY_ID.test(id))) throw httpError(400, 'Pass registered Agent IDs in headers or JSON, not the URL');
  if (hasHeaders && (bodyIds.length || data.agentKey !== undefined)) {
    throw httpError(400, 'Use either Agent credential headers or JSON, not both');
  }
  if (data.agentKey !== undefined && contentType(req) !== 'application/json') throw httpError(415, 'Send Agent credentials as application/json');
  const ids = [...(headerId !== undefined ? [headerId] : []), ...bodyIds, ...queryIds];
  if (new Set(ids).size > 1) throw httpError(400, 'Conflicting Agent IDs');
  const identity = hasHeaders ? authenticateIdentity(headerId, headerKey) : optionalIdentity(ids[0], data.agentKey);
  if (identity && req.method === 'GET') throw httpError(400, 'Use POST to send as a registered Agent');
  const name = input.name || url.searchParams.get('name') || (message ? input.agent || input.from : undefined);
  return { identity, info: { agentId: ids[0], name, role: input.role, color: input.color, status: message ? undefined : input.status } };
}

// ---------- 房间 / Agent ----------
function findRoom(id) { return store.rooms.find(r => r.id === id); }
function getRoom(raw, create = true) {
  const id = slug(raw) || 'general';
  let room = findRoom(id);
  if (!room && create) {
    requireWritable();
    room = normalizeRoom({ id, name: String(raw || id).trim().slice(0, 60) || id });
    store.rooms.push(room);
    persist();
    broadcastAll({ type: 'rooms', rooms: roomList() });
  }
  return room;
}
function roomList() {
  return store.rooms.map(r => ({ id: r.id, name: r.name, topic: r.topic, messageCount: r.messages.length, lastSeq: r.seq, lastMessageAt: r.messages.at(-1)?.at || null, online: agentsIn(r.id).filter(a => a.online).length }));
}

const agents = new Map();
const guestPresenceKey = (roomId, name) => `guest:${roomId}:${name.toLowerCase()}`;
const verifiedPresenceKey = (roomId, id) => `verified:${roomId}:${id}`;
const presenceKey = (a) => a.verified ? verifiedPresenceKey(a.roomId, a.id) : guestPresenceKey(a.roomId, a.name);
function publicAgent(a) {
  return { id: a.id, verified: a.verified, name: a.name, role: a.role, color: a.color, status: a.status, roomId: a.roomId, online: isOnline(a), lastSeen: a.lastSeen, joinedAt: a.joinedAt };
}
function isOnline(a) { return a.sockets > 0 || Date.now() - Date.parse(a.lastSeen) < ONLINE_MS; }
function agentsIn(roomId) { return [...agents.values()].filter(a => a.roomId === roomId).map(publicAgent).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)); }
function findPresence(room, info, identity) {
  if (identity) return agents.get(verifiedPresenceKey(room.id, identity.id));
  if (info.agentId) {
    for (const a of agents.values()) if (!a.verified && a.roomId === room.id && a.id === info.agentId) return a;
  }
  return agents.get(guestPresenceKey(room.id, cleanName(info.name)));
}
function touchAgent(room, info, identity = null) {
  let agent = findPresence(room, info, identity);
  const isNew = !agent;
  const wasOnline = agent ? isOnline(agent) : false;
  if (!agent) {
    const name = identity ? identity.name : cleanName(info.name);
    agent = { id: identity?.id || uid(), verified: !!identity, name, role: identity?.role || 'Agent', color: colorFor(identity?.id || name), status: 'online', roomId: room.id, joinedAt: now(), lastSeen: now(), sockets: 0 };
    agents.set(presenceKey(agent), agent);
  }
  if (!identity && info.role) agent.role = String(info.role).slice(0, 30);
  if (!identity && info.color) agent.color = String(info.color).slice(0, 20);
  if (info.status) agent.status = String(info.status).slice(0, 60);
  agent.lastSeen = now();
  if (isNew || !wasOnline) {
    addEvent(room, 'join', `${agent.name} 加入了房间`, agent);
    broadcast(room.id, { type: 'agents', agents: agentsIn(room.id) });
  }
  return agent;
}

// ---------- 消息 ----------
function addEvent(room, type, detail, agent) {
  const event = { id: uid(), type, detail, agent: agent.name, agentId: agent.id, verified: agent.verified, at: now() };
  room.events.unshift(event);
  room.events = room.events.slice(0, MAX_EVENTS);
  persist();
  broadcast(room.id, { type: 'event', event });
}
function postMessage(room, data, getAgent) {
  const text = String(data.text ?? data.content ?? data.message ?? '').slice(0, MAX_TEXT);
  if (!text.trim()) throw httpError(400, 'text is required');
  const agent = getAgent();
  const mentions = [...new Set([...parseMentions(text), ...toList(data.to)])];
  const message = {
    id: uid(), seq: ++room.seq, room: room.id,
    agentId: agent.id, verified: agent.verified, agent: agent.name, role: agent.role,
    text, kind: String(data.kind || 'message').slice(0, 20), mentions,
    replyTo: data.replyTo ? Number(data.replyTo) || String(data.replyTo) : undefined,
    meta: data.meta && typeof data.meta === 'object' ? data.meta : undefined,
    at: now()
  };
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES) room.messages = room.messages.slice(-MAX_MESSAGES);
  persist();
  broadcast(room.id, { type: 'message', message });
  if (message.kind === 'debug') addEvent(room, 'trace', `${message.agent}: ${text.slice(0, 80)}`, agent);
  wakeWaiters(room);
  return message;
}
function mentionsYou(message, name) {
  const n = name.toLowerCase();
  return message.mentions.includes(n) || message.mentions.includes('all') || message.mentions.includes('所有人') || message.mentions.includes('everyone');
}
function queryMessages(room, q) {
  let list = room.messages;
  if (q.since !== null) list = list.filter(m => m.seq > q.since);
  if (q.mention) list = list.filter(m => mentionsYou(m, q.mention));
  if (q.from) list = list.filter(m => m.agent.toLowerCase() === q.from);
  if (q.fromId) list = list.filter(m => m.agentId === q.fromId);
  if (q.kind) list = list.filter(m => m.kind === q.kind);
  if (q.excludeId) list = list.filter(m => m.agentId !== q.excludeId);
  else if (q.excludeSelf) list = list.filter(m => m.verified || m.agent.toLowerCase() !== q.excludeSelf);
  let truncated = false;
  if (q.since !== null) { truncated = list.length > q.limit; list = list.slice(0, q.limit); } else list = list.slice(-q.limit);
  const cursor = truncated ? list.at(-1).seq : room.seq;
  return { list, cursor };
}
function parseQuery(url) {
  const sinceRaw = url.searchParams.get('since') ?? url.searchParams.get('after');
  const excludeSelf = url.searchParams.get('exclude_self') === '1' || url.searchParams.get('excludeSelf') === 'true';
  return {
    since: sinceRaw === null || sinceRaw === '' ? null : Number(sinceRaw) || 0,
    limit: Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500),
    mention: (url.searchParams.get('mention') || url.searchParams.get('to') || '').replace(/^@/, '').toLowerCase(),
    from: (url.searchParams.get('from') || '').toLowerCase(),
    fromId: url.searchParams.get('from_id'),
    kind: url.searchParams.get('kind') || '',
    excludeId: excludeSelf ? url.searchParams.get('self_id') : null,
    excludeSelf: excludeSelf ? (url.searchParams.get('name') || '').toLowerCase() : ''
  };
}
function messagesAsText(room, list, cursor) {
  const lines = list.map(m => `[#${m.seq} ${fmtTime(m.at)}] ${m.verified ? `[已验证 ${m.agentId}] ` : ''}${m.agent}${m.role && m.role !== 'Agent' ? `(${m.role})` : ''}${m.kind !== 'message' ? ` <${m.kind}>` : ''}${m.replyTo ? ` ↩#${m.replyTo}` : ''}: ${m.text}`);
  return `# room=${room.id} cursor=${cursor} count=${list.length}\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

// ---------- 长轮询 ----------
const waiters = new Set();
function wakeWaiters(room) {
  for (const w of [...waiters]) {
    if (w.roomId !== room.id) continue;
    const result = queryMessages(room, w.q);
    if (result.list.length) { waiters.delete(w); clearTimeout(w.timer); w.done(result); }
  }
}

// ---------- WebSocket 广播 ----------
const sockets = new Map(); // roomId -> Set<ws>
function broadcast(roomId, payload) {
  const text = JSON.stringify(payload);
  for (const ws of sockets.get(roomId) || []) if (ws.readyState === WebSocket.OPEN) ws.send(text);
}
function broadcastAll(payload) {
  const text = JSON.stringify(payload);
  for (const set of sockets.values()) for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(text);
}
function state(room, req) {
  return {
    room: { id: room.id, name: room.name, topic: room.topic, lastSeq: room.seq },
    rooms: roomList(),
    agents: agentsIn(room.id),
    messages: room.messages.slice(-200),
    events: room.events.slice(0, 40),
    server: { hosts: localAddresses(), port: PORT, auth: SHARED_TOKEN ? 'shared-token' : 'open', baseUrl: req ? baseUrl(req) : null }
  };
}

function guide(req) {
  const base = baseUrl(req);
  let text = '';
  try { text = fs.readFileSync(GUIDE_FILE, 'utf8'); } catch { text = '# Agent Relay\n'; }
  return text.replaceAll('<RELAY_BASE_URL>', base).replaceAll('<RELAY_WS_URL>', base.replace(/^http/, 'ws'))
    .replaceAll('<AUTH_NOTE>', SHARED_TOKEN ? '本服务已启用共享口令：受保护的接口需带 `Authorization: Bearer <口令>` 或 `?token=<口令>`。' : '本服务为开放模式，无需全局共享口令。');
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  try {
    // 免鉴权：首页、静态资源、说明文档、健康检查
    if (req.method === 'GET' && ['/llms.txt', '/agent.md', '/AGENT.md', '/api', '/api/help'].includes(p)) return send(res, 200, guide(req), 'text/markdown');
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, auth: SHARED_TOKEN ? 'shared-token' : 'open', agentIdentity: 'optional-key', rooms: store.rooms.length, time: now() });
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);

    if (!authorized(req, url)) return send(res, 401, { error: 'Shared token required', hint: 'Authorization: Bearer <token> 或 ?token=<token>' });
    if (url.searchParams.has('agentKey')) throw httpError(400, 'Do not pass the Agent key in the URL');

    if (p === '/api/auth/verify') return send(res, 200, { ok: true, auth: SHARED_TOKEN ? 'shared-token' : 'open' });
    if (p === '/api/agents/register' && req.method === 'POST') {
      if (contentType(req) !== 'application/json') throw httpError(415, 'Expected application/json');
      return send(res, 201, registerIdentity(await readBody(req)));
    }

    // 房间
    if (p === '/api/rooms' && req.method === 'GET') return send(res, 200, { rooms: roomList() });
    if (p === '/api/rooms' && req.method === 'POST') {
      const data = await readBody(req);
      const id = slug(data.id || data.name);
      if (!id) return send(res, 400, { error: 'name is required' });
      requireWritable();
      const existed = !!findRoom(id);
      const room = getRoom(id);
      if (!existed) { room.name = String(data.name || id).slice(0, 60); }
      if (data.topic !== undefined) room.topic = String(data.topic).slice(0, 200);
      persist();
      broadcastAll({ type: 'rooms', rooms: roomList() });
      return send(res, existed ? 200 : 201, { id: room.id, name: room.name, topic: room.topic, existed });
    }
    const roomMatch = p.match(/^\/api\/rooms\/([^/]+)$/);
    if (roomMatch && (req.method === 'PATCH' || req.method === 'PUT')) {
      const room = findRoom(decodeURIComponent(roomMatch[1]));
      if (!room) return send(res, 404, { error: 'Room not found' });
      const data = await readBody(req);
      requireWritable();
      if (data.name) room.name = String(data.name).slice(0, 60);
      if (data.topic !== undefined) room.topic = String(data.topic).slice(0, 200);
      persist();
      broadcastAll({ type: 'rooms', rooms: roomList() });
      return send(res, 200, { id: room.id, name: room.name, topic: room.topic });
    }
    if (roomMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(roomMatch[1]);
      if (id === 'general') return send(res, 400, { error: 'general cannot be deleted' });
      requireWritable();
      const before = store.rooms.length;
      store.rooms = store.rooms.filter(r => r.id !== id);
      closeRoomSockets(id, 'Room deleted');
      for (const [key, a] of agents) if (a.roomId === id) agents.delete(key);
      persist();
      broadcastAll({ type: 'rooms', rooms: roomList() });
      return send(res, 200, { ok: store.rooms.length !== before });
    }

    const needsBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
    const data = needsBody ? await readBody(req) : {};
    const q = (key) => url.searchParams.get(key);
    const isMessage = (['/api/messages', '/api/message', '/api/send'].includes(p) && req.method === 'POST') || (p === '/api/send' && req.method === 'GET');
    const isPresence = ['/api/join', '/api/heartbeat', '/api/leave'].includes(p) && req.method === 'POST';
    const input = isMessage ? { ...Object.fromEntries(url.searchParams), ...data } : data;
    const writer = isMessage || isPresence ? httpWriter(req, url, data, isMessage, input) : null;
    if (writer) requireWritable();
    const room = getRoom(q('room') || data.room || 'general');

    if (p === '/api/state' && req.method === 'GET') {
      if (q('name') && !persistRetryMs) touchAgent(room, { name: q('name') });
      return send(res, 200, state(room, req));
    }
    if (p === '/api/agents' && req.method === 'GET') return send(res, 200, { room: room.id, agents: agentsIn(room.id) });

    if (p === '/api/join' && req.method === 'POST') {
      const agent = touchAgent(room, writer.info, writer.identity);
      return send(res, 200, { ...publicAgent(agent), room: room.id, cursor: room.seq, recent: room.messages.slice(-20), agents: agentsIn(room.id), guide: `${baseUrl(req)}/llms.txt` });
    }
    if (p === '/api/heartbeat' && req.method === 'POST') {
      const agent = touchAgent(room, writer.info, writer.identity);
      return send(res, 200, { ok: true, agent: publicAgent(agent), lastSeq: room.seq });
    }
    if (p === '/api/leave' && req.method === 'POST') {
      const agent = findPresence(room, writer.info, writer.identity);
      if (agent) {
        if (agent.verified) closeRoomSockets(room.id, 'Agent left', agent);
        agents.delete(presenceKey(agent));
        addEvent(room, 'leave', `${agent.name} 离开了房间`, agent);
        broadcast(room.id, { type: 'agents', agents: agentsIn(room.id) });
      }
      return send(res, 200, { ok: !!agent });
    }

    // 发送消息：POST /api/messages | /api/message | /api/send，或 GET /api/send?text=...（只能发 GET 的 Agent 也能用）
    if (isMessage) {
      const message = postMessage(room, input, () => touchAgent(room, writer.info, writer.identity));
      return q('format') === 'text' ? send(res, 201, `ok #${message.seq}\n`, 'text/plain') : send(res, 201, message);
    }

    // 读取消息（支持长轮询 wait=秒）
    if (p === '/api/messages' && req.method === 'GET') {
      const query = parseQuery(url);
      if (q('name') && !persistRetryMs) touchAgent(room, { name: q('name') });
      const reply = ({ list, cursor }) => q('format') === 'text'
        ? send(res, 200, messagesAsText(room, list, cursor), 'text/plain')
        : send(res, 200, { room: room.id, cursor, count: list.length, messages: list });
      const first = queryMessages(room, query);
      const wait = Math.min(Number(q('wait')) || 0, MAX_WAIT_SECONDS);
      if (first.list.length || !wait || query.since === null) return reply(first);
      const waiter = { roomId: room.id, q: query, done: reply, timer: null };
      waiter.timer = setTimeout(() => { waiters.delete(waiter); reply(queryMessages(room, query)); }, wait * 1000);
      waiters.add(waiter);
      req.on('close', () => { if (waiters.delete(waiter)) clearTimeout(waiter.timer); });
      return;
    }

    send(res, 404, { error: 'Not found', help: `${baseUrl(req)}/llms.txt` });
  } catch (error) {
    send(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
  }
});

function serveStatic(res, p) {
  const file = p === '/' ? 'index.html' : p.replace(/^\/(public\/)?/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, file));
  if (!within(PUBLIC_DIR, filePath) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()
      || !within(fs.realpathSync(PUBLIC_DIR), fs.realpathSync(filePath))) return send(res, 404, { error: 'Not found' });
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  res.writeHead(200, { 'Content-Type': `${types[path.extname(filePath)] || 'application/octet-stream'}; charset=utf-8` });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- WebSocket ----------
const wss = new WebSocket.Server({ noServer: true });
function closeRoomSockets(roomId, reason, agent) {
  for (const ws of sockets.get(roomId) || []) if (!agent || ws.agent === agent) ws.close(1008, reason);
  if (!agent) sockets.delete(roomId);
}
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname !== '/ws' || !authorized(req, url) || url.searchParams.has('agentKey') || url.searchParams.has('agentId')) return socket.destroy();
  const roomName = url.searchParams.get('room') || 'general';
  if (persistRetryMs && !getRoom(roomName, false)) {
    return socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
  const room = getRoom(roomName);
  wss.handleUpgrade(req, socket, head, ws => {
    let agent = null;
    let identity = null;
    const bind = (info, proof) => {
      const next = touchAgent(room, info, proof);
      if (agent !== next) {
        if (agent) agent.sockets = Math.max(0, agent.sockets - 1);
        next.sockets += 1;
        ws.agent = agent = next;
      }
      return agent;
    };
    const requireBoundIdentity = (data) => {
      if (!identity) {
        if (optionalIdentity(data.agentId, data.agentKey)) throw httpError(401, 'Send an authenticated join frame first');
      } else {
        if (data.agentId !== undefined && data.agentId !== identity.id) throw httpError(401, 'Join before changing the bound Agent ID');
        if (data.agentKey !== undefined) authenticateIdentity(identity.id, data.agentKey);
      }
      return identity;
    };
    if (url.searchParams.get('name') && !persistRetryMs) bind({ name: url.searchParams.get('name'), role: url.searchParams.get('role') });
    if (!sockets.has(room.id)) sockets.set(room.id, new Set());
    sockets.get(room.id).add(ws);
    ws.send(JSON.stringify({ type: 'state', state: state(room, req), you: agent ? publicAgent(agent) : null }));

    ws.on('message', raw => {
      if (ws.readyState !== WebSocket.OPEN || findRoom(room.id) !== room) return;
      let data;
      try {
        const text = raw.toString();
        try { data = JSON.parse(text); } catch {
          if (looksLikeCredentialFrame(text)) throw httpError(400, 'Invalid Agent credential frame');
          data = { type: 'message', text };
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw httpError(400, 'Expected a JSON object');
        if (isRegisteredIdClaim(data.id)) {
          if (data.agentId && data.agentId !== data.id) throw httpError(400, 'Conflicting Agent IDs');
          data.agentId = data.id;
        }
        if (data.type === 'join') {
          const proof = optionalIdentity(data.agentId, data.agentKey);
          if (identity && proof !== identity) throw httpError(401, 'Reconnect before changing the bound Agent ID');
          requireWritable();
          const a = bind(data, proof);
          identity = proof;
          ws.send(JSON.stringify({ type: 'joined', agent: publicAgent(a), cursor: room.seq }));
        } else if (data.type === 'heartbeat' || data.type === 'ping') {
          const proof = requireBoundIdentity(data);
          if (agent || data.name || data.agentId) {
            requireWritable();
            bind({ ...data, name: data.name || agent?.name }, proof);
          }
          ws.send(JSON.stringify({ type: 'pong', lastSeq: room.seq }));
        } else if (data.type === 'message' || data.text) {
          const proof = requireBoundIdentity(data);
          requireWritable();
          const message = postMessage(room, data, () => bind({ ...data, name: data.name || agent?.name, status: undefined }, proof));
          ws.send(JSON.stringify({ type: 'ack', ref: data.ref, seq: message.seq, id: message.id }));
        }
      } catch (error) {
        ws.send(JSON.stringify({ type: 'error', ref: data?.ref, status: error.status || 500, error: error.status ? error.message : 'Internal server error' }));
        if (!identity && error.status === 401) ws.close(1008, 'Agent authentication failed');
      }
    });
    ws.on('close', () => {
      sockets.get(room.id)?.delete(ws);
      if (agent) {
        agent.sockets = Math.max(0, agent.sockets - 1);
        if (agents.get(presenceKey(agent)) === agent) {
          agent.lastSeen = now();
          broadcast(room.id, { type: 'agents', agents: agentsIn(room.id) });
        }
      }
    });
  });
});

// 定期刷新在线状态
const lastOnline = new Map();
setInterval(() => {
  for (const room of store.rooms) {
    const sig = agentsIn(room.id).filter(a => a.online).map(a => a.id).join(',');
    if (lastOnline.get(room.id) !== sig) { lastOnline.set(room.id, sig); broadcast(room.id, { type: 'agents', agents: agentsIn(room.id) }); }
  }
}, 15000).unref();

function shutdown() {
  try { if (persistTimer) persistNow(); }
  catch {
    console.error('关闭时未能写入群聊数据，磁盘上的上一次快照仍保留');
    process.exit(1);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  process.send?.({ type: 'ready', port: server.address().port });
  console.log('Agent Relay 群聊平台已启动');
  for (const host of localAddresses()) console.log(`  浏览器/Agent 地址: http://${host}:${PORT}`);
  console.log(`  Agent 接入说明:   http://${localAddresses()[0]}:${PORT}/llms.txt`);
  console.log(SHARED_TOKEN ? '  鉴权模式: 共享口令 (AGENT_RELAY_TOKEN)' : '  鉴权模式: 开放（无需 Token）');
});
