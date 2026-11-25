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
const DATA_DIR = process.env.AGENT_RELAY_DATA || path.join(ROOT, 'data');
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

// ---------- 持久化 ----------
function load(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
fs.mkdirSync(DATA_DIR, { recursive: true });
const store = load(DATA_FILE, { rooms: [] });
if (!Array.isArray(store.rooms)) store.rooms = [];
for (const room of store.rooms) normalizeRoom(room);
if (!store.rooms.some(r => r.id === 'general')) store.rooms.unshift(normalizeRoom({ id: 'general', name: '大厅 General' }));

let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Token'
};
function send(res, status, body, type = 'application/json') {
  const text = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', ...CORS });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; if (data.length > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } });
    req.on('end', () => {
      if (!data) return resolve({});
      const type = req.headers['content-type'] || '';
      if (type.includes('application/x-www-form-urlencoded')) {
        const form = Object.fromEntries(new URLSearchParams(data));
        return resolve(form.text || form.content || form.message ? form : { ...form, text: data });
      }
      try { resolve(JSON.parse(data)); } catch {
        // 非 JSON 正文直接当作消息文本，方便 curl -d "hello" 这种最简调用
        resolve({ text: data });
      }
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

// ---------- 房间 / Agent ----------
function findRoom(id) { return store.rooms.find(r => r.id === id); }
function getRoom(raw, create = true) {
  const id = slug(raw) || 'general';
  let room = findRoom(id);
  if (!room && create) {
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

const agents = new Map(); // key: roomId:name
const agentKey = (roomId, name) => `${roomId}:${name.toLowerCase()}`;
function publicAgent(a) {
  return { id: a.id, name: a.name, role: a.role, color: a.color, status: a.status, roomId: a.roomId, online: isOnline(a), lastSeen: a.lastSeen, joinedAt: a.joinedAt };
}
function isOnline(a) { return a.sockets > 0 || Date.now() - Date.parse(a.lastSeen) < ONLINE_MS; }
function agentsIn(roomId) { return [...agents.values()].filter(a => a.roomId === roomId).map(publicAgent).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)); }
function findAgentById(id) { return [...agents.values()].find(a => a.id === id); }
function touchAgent(room, info = {}) {
  let agent = info.agentId ? findAgentById(info.agentId) : null;
  if (agent && agent.roomId !== room.id) agent = null;
  const name = cleanName(info.name || agent?.name);
  const key = agentKey(room.id, name);
  agent = agent || agents.get(key);
  const isNew = !agent;
  const wasOnline = agent ? isOnline(agent) : false;
  if (!agent) {
    agent = { id: uid(), name, role: 'Agent', color: colorFor(name), status: 'online', roomId: room.id, joinedAt: now(), lastSeen: now(), sockets: 0 };
    agents.set(key, agent);
  }
  if (info.role) agent.role = String(info.role).slice(0, 30);
  if (info.color) agent.color = String(info.color).slice(0, 20);
  if (info.status) agent.status = String(info.status).slice(0, 60);
  agent.lastSeen = now();
  if (isNew || !wasOnline) {
    addEvent(room, 'join', `${agent.name} 加入了房间`, agent.name);
    broadcast(room.id, { type: 'agents', agents: agentsIn(room.id) });
  }
  return agent;
}

// ---------- 消息 ----------
function addEvent(room, type, detail, agent = 'system') {
  const event = { id: uid(), type, detail, agent, at: now() };
  room.events.unshift(event);
  room.events = room.events.slice(0, MAX_EVENTS);
  persist();
  broadcast(room.id, { type: 'event', event });
}
function postMessage(room, data) {
  const text = String(data.text ?? data.content ?? data.message ?? '').slice(0, MAX_TEXT);
  if (!text.trim()) throw Object.assign(new Error('text is required'), { status: 400 });
  const agent = touchAgent(room, { agentId: data.agentId, name: data.name || data.agent || data.from, role: data.role, color: data.color });
  const mentions = [...new Set([...parseMentions(text), ...toList(data.to)])];
  const message = {
    id: uid(), seq: ++room.seq, room: room.id,
    agentId: agent.id, agent: agent.name, role: agent.role,
    text, kind: String(data.kind || 'message').slice(0, 20), mentions,
    replyTo: data.replyTo ? Number(data.replyTo) || String(data.replyTo) : undefined,
    meta: data.meta && typeof data.meta === 'object' ? data.meta : undefined,
    at: now()
  };
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES) room.messages = room.messages.slice(-MAX_MESSAGES);
  persist();
  broadcast(room.id, { type: 'message', message });
  if (message.kind === 'debug') addEvent(room, 'trace', `${message.agent}: ${text.slice(0, 80)}`, message.agent);
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
  if (q.kind) list = list.filter(m => m.kind === q.kind);
  if (q.excludeSelf) list = list.filter(m => m.agent.toLowerCase() !== q.excludeSelf);
  let truncated = false;
  if (q.since !== null) { truncated = list.length > q.limit; list = list.slice(0, q.limit); } else list = list.slice(-q.limit);
  const cursor = truncated ? list.at(-1).seq : room.seq;
  return { list, cursor };
}
function parseQuery(url) {
  const sinceRaw = url.searchParams.get('since') ?? url.searchParams.get('after');
  const self = url.searchParams.get('name');
  return {
    since: sinceRaw === null || sinceRaw === '' ? null : Number(sinceRaw) || 0,
    limit: Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500),
    mention: (url.searchParams.get('mention') || url.searchParams.get('to') || '').replace(/^@/, '').toLowerCase(),
    from: (url.searchParams.get('from') || '').toLowerCase(),
    kind: url.searchParams.get('kind') || '',
    excludeSelf: url.searchParams.get('exclude_self') === '1' || url.searchParams.get('excludeSelf') === 'true' ? (self || '').toLowerCase() : ''
  };
}
function messagesAsText(room, list, cursor) {
  const lines = list.map(m => `[#${m.seq} ${fmtTime(m.at)}] ${m.agent}${m.role && m.role !== 'Agent' ? `(${m.role})` : ''}${m.kind !== 'message' ? ` <${m.kind}>` : ''}${m.replyTo ? ` ↩#${m.replyTo}` : ''}: ${m.text}`);
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
    .replaceAll('<AUTH_NOTE>', SHARED_TOKEN ? '本服务已启用共享口令：所有请求需带 `Authorization: Bearer <口令>` 或 `?token=<口令>`。' : '本服务为开放模式，无需任何 Token。');
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  try {
    // 免鉴权：首页、静态资源、说明文档、健康检查
    if (req.method === 'GET' && ['/llms.txt', '/agent.md', '/AGENT.md', '/api', '/api/help'].includes(p)) return send(res, 200, guide(req), 'text/markdown');
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, auth: SHARED_TOKEN ? 'shared-token' : 'open', rooms: store.rooms.length, time: now() });
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);

    if (!authorized(req, url)) return send(res, 401, { error: 'Shared token required', hint: 'Authorization: Bearer <token> 或 ?token=<token>' });

    if (p === '/api/auth/verify') return send(res, 200, { ok: true, auth: SHARED_TOKEN ? 'shared-token' : 'open' });

    // 房间
    if (p === '/api/rooms' && req.method === 'GET') return send(res, 200, { rooms: roomList() });
    if (p === '/api/rooms' && req.method === 'POST') {
      const data = await readBody(req);
      const id = slug(data.id || data.name);
      if (!id) return send(res, 400, { error: 'name is required' });
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
      if (data.name) room.name = String(data.name).slice(0, 60);
      if (data.topic !== undefined) room.topic = String(data.topic).slice(0, 200);
      persist();
      broadcastAll({ type: 'rooms', rooms: roomList() });
      return send(res, 200, { id: room.id, name: room.name, topic: room.topic });
    }
    if (roomMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(roomMatch[1]);
      if (id === 'general') return send(res, 400, { error: 'general cannot be deleted' });
      const before = store.rooms.length;
      store.rooms = store.rooms.filter(r => r.id !== id);
      for (const [key, a] of agents) if (a.roomId === id) agents.delete(key);
      persist();
      broadcastAll({ type: 'rooms', rooms: roomList() });
      return send(res, 200, { ok: store.rooms.length !== before });
    }

    const needsBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
    const data = needsBody ? await readBody(req) : {};
    const q = (key) => url.searchParams.get(key);
    const room = getRoom(q('room') || data.room || 'general');

    if (p === '/api/state' && req.method === 'GET') {
      if (q('name')) touchAgent(room, { name: q('name') });
      return send(res, 200, state(room, req));
    }
    if (p === '/api/agents' && req.method === 'GET') return send(res, 200, { room: room.id, agents: agentsIn(room.id) });

    if (p === '/api/join' && req.method === 'POST') {
      const agent = touchAgent(room, { agentId: data.id, name: data.name || q('name'), role: data.role, color: data.color, status: data.status });
      return send(res, 200, { ...publicAgent(agent), room: room.id, cursor: room.seq, recent: room.messages.slice(-20), agents: agentsIn(room.id), guide: `${baseUrl(req)}/llms.txt` });
    }
    if (p === '/api/heartbeat' && req.method === 'POST') {
      const agent = touchAgent(room, { agentId: data.id || data.agentId, name: data.name || q('name'), status: data.status });
      return send(res, 200, { ok: true, agent: publicAgent(agent), lastSeq: room.seq });
    }
    if (p === '/api/leave' && req.method === 'POST') {
      const agent = (data.id && findAgentById(data.id)) || agents.get(agentKey(room.id, cleanName(data.name || q('name'))));
      if (agent) { agents.delete(agentKey(agent.roomId, agent.name)); addEvent(room, 'leave', `${agent.name} 离开了房间`, agent.name); broadcast(room.id, { type: 'agents', agents: agentsIn(room.id) }); }
      return send(res, 200, { ok: !!agent });
    }

    // 发送消息：POST /api/messages | /api/message | /api/send，或 GET /api/send?text=...（只能发 GET 的 Agent 也能用）
    if ((['/api/messages', '/api/message', '/api/send'].includes(p) && req.method === 'POST') || (p === '/api/send' && req.method === 'GET')) {
      const input = req.method === 'GET' ? Object.fromEntries(url.searchParams) : { ...Object.fromEntries(url.searchParams), ...data };
      const message = postMessage(room, input);
      return q('format') === 'text' ? send(res, 201, `ok #${message.seq}\n`, 'text/plain') : send(res, 201, message);
    }

    // 读取消息（支持长轮询 wait=秒）
    if (p === '/api/messages' && req.method === 'GET') {
      const query = parseQuery(url);
      if (q('name')) touchAgent(room, { name: q('name') });
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
    send(res, error.status || 500, { error: error.message });
  }
});

function serveStatic(res, p) {
  const file = p === '/' ? 'index.html' : p.replace(/^\/(public\/)?/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, file));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return send(res, 404, { error: 'Not found' });
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  res.writeHead(200, { 'Content-Type': `${types[path.extname(filePath)] || 'application/octet-stream'}; charset=utf-8` });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- WebSocket ----------
const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname !== '/ws' || !authorized(req, url)) return socket.destroy();
  const room = getRoom(url.searchParams.get('room') || 'general');
  wss.handleUpgrade(req, socket, head, ws => {
    let agent = null;
    const bind = (info) => {
      const next = touchAgent(room, info);
      if (agent !== next) { if (agent) agent.sockets = Math.max(0, agent.sockets - 1); next.sockets += 1; agent = next; }
      return agent;
    };
    if (url.searchParams.get('name')) bind({ name: url.searchParams.get('name'), role: url.searchParams.get('role') });
    if (!sockets.has(room.id)) sockets.set(room.id, new Set());
    sockets.get(room.id).add(ws);
    ws.send(JSON.stringify({ type: 'state', state: state(room, req), you: agent ? publicAgent(agent) : null }));

    ws.on('message', raw => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { data = { type: 'message', text: raw.toString() }; }
      try {
        if (data.type === 'join') { const a = bind({ agentId: data.agentId, name: data.name, role: data.role, color: data.color }); ws.send(JSON.stringify({ type: 'joined', agent: publicAgent(a), cursor: room.seq })); }
        else if (data.type === 'heartbeat' || data.type === 'ping') { if (agent || data.name || data.agentId) bind({ agentId: data.agentId, name: data.name || agent?.name, status: data.status }); ws.send(JSON.stringify({ type: 'pong', lastSeq: room.seq })); }
        else if (data.type === 'message' || data.text) {
          const name = data.name || agent?.name;
          if (name || data.agentId) bind({ agentId: data.agentId, name });
          const message = postMessage(room, { ...data, name: name || 'anonymous', agentId: data.agentId || agent?.id });
          ws.send(JSON.stringify({ type: 'ack', ref: data.ref, seq: message.seq, id: message.id }));
        }
      } catch (error) { ws.send(JSON.stringify({ type: 'error', ref: data.ref, error: error.message })); }
    });
    ws.on('close', () => {
      sockets.get(room.id)?.delete(ws);
      if (agent) { agent.sockets = Math.max(0, agent.sockets - 1); agent.lastSeen = now(); broadcast(room.id, { type: 'agents', agents: agentsIn(room.id) }); }
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

function flush() { if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); } }
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log('Agent Relay 群聊平台已启动');
  for (const host of localAddresses()) console.log(`  浏览器/Agent 地址: http://${host}:${PORT}`);
  console.log(`  Agent 接入说明:   http://${localAddresses()[0]}:${PORT}/llms.txt`);
  console.log(SHARED_TOKEN ? '  鉴权模式: 共享口令 (AGENT_RELAY_TOKEN)' : '  鉴权模式: 开放（无需 Token）');
});
