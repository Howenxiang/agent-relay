const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'relay.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const token = () => crypto.randomBytes(24).toString('hex');
function load(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
fs.mkdirSync(DATA_DIR, { recursive: true });
const auth = load(AUTH_FILE, { tokens: [] });
if (!auth.tokens.length) { auth.tokens.push({ token: process.env.AGENT_RELAY_TOKEN || token(), label: 'local-admin', role: 'Admin', rooms: ['*'], createdAt: now() }); fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2)); }
const store = load(DATA_FILE, { rooms: [{ id: 'general', name: 'LAN Debug Room', code: 'LAN-7F3A', createdAt: now(), messages: [], events: [] }] });
const agents = new Map();
const sockets = new Map();
function persist() { fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2)); }
function localAddress() { for (const group of Object.values(os.networkInterfaces())) for (const item of group || []) if (item.family === 'IPv4' && !item.internal) return item.address; return 'localhost'; }
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); res.end(JSON.stringify(body)); }
function body(req) { return new Promise((resolve, reject) => { let data = ''; req.on('data', c => data += c); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } }); }); }
function authToken(req, url) { const header = req.headers.authorization || ''; return header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token'); }
function verify(raw) { return auth.tokens.find(item => item.token === raw); }
function canUse(key, roomId) { return key && (key.rooms.includes('*') || key.rooms.includes(roomId)); }
function roomOrFail(roomId) { return store.rooms.find(room => room.id === (roomId || 'general')); }
function safeAgent(agent) { return { id: agent.id, name: agent.name, role: agent.role, color: agent.color, status: agent.status, roomId: agent.roomId, lastSeen: agent.lastSeen, joinedAt: agent.joinedAt }; }
function broadcast(roomId, payload) { const set = sockets.get(roomId) || new Set(); const text = JSON.stringify(payload); for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(text); }
function addEvent(room, type, detail, agent = 'system') { room.events.unshift({ id: id(), type, detail, agent, at: now() }); room.events = room.events.slice(0, 40); persist(); broadcast(room.id, { type: 'event', event: room.events[0] }); }
function state(room) { return { room: { id: room.id, name: room.name, code: room.code }, agents: [...agents.values()].filter(a => a.roomId === room.id).map(safeAgent), messages: room.messages.slice(-120), events: room.events.slice(0, 30), server: { host: localAddress(), port: PORT, websocket: true } }; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); return res.end(); }
  try {
    if (url.pathname === '/api/auth/verify' && req.method === 'GET') { const key = verify(authToken(req, url)); return key ? json(res, 200, { ok: true, label: key.label, role: key.role }) : json(res, 401, { error: 'Invalid token' }); }
    if (url.pathname === '/api/tokens' && req.method === 'GET') { const key = verify(authToken(req, url)); if (!key || key.role !== 'Admin') return json(res, 403, { error: 'Admin token required' }); return json(res, 200, { tokens: auth.tokens.map(item => ({ label: item.label, role: item.role, rooms: item.rooms, createdAt: item.createdAt })) }); }
    if (url.pathname === '/api/tokens' && req.method === 'POST') { const key = verify(authToken(req, url)); if (!key || key.role !== 'Admin') return json(res, 403, { error: 'Admin token required' }); const data = await body(req); if (!data.label) return json(res, 400, { error: 'label is required' }); const created = { token: token(), label: String(data.label).slice(0, 60), role: String(data.role || 'Agent').slice(0, 30), rooms: Array.isArray(data.rooms) && data.rooms.length ? data.rooms : ['*'], createdAt: now() }; auth.tokens.push(created); fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2)); return json(res, 201, created); }
    if (url.pathname.startsWith('/api/tokens/') && req.method === 'DELETE') { const key = verify(authToken(req, url)); if (!key || key.role !== 'Admin') return json(res, 403, { error: 'Admin token required' }); const label = decodeURIComponent(url.pathname.split('/').pop()); if (label === 'local-admin') return json(res, 400, { error: 'local-admin cannot be revoked' }); const before = auth.tokens.length; auth.tokens = auth.tokens.filter(item => item.label !== label); fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2)); return json(res, 200, { ok: auth.tokens.length !== before }); }
    if (url.pathname === '/api/rooms' && req.method === 'GET') { const key = verify(authToken(req, url)); if (!key) return json(res, 401, { error: 'Bearer token required' }); return json(res, 200, { rooms: store.rooms.filter(r => canUse(key, r.id)).map(r => ({ id: r.id, name: r.name, code: r.code, messageCount: r.messages.length })) }); }
    if (url.pathname === '/api/rooms' && req.method === 'POST') { const key = verify(authToken(req, url)); if (!key) return json(res, 401, { error: 'Bearer token required' }); const data = await body(req); if (!data.name) return json(res, 400, { error: 'name is required' }); const room = { id: (data.id || data.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || id(), name: String(data.name).slice(0, 60), code: `LAN-${crypto.randomBytes(2).toString('hex').toUpperCase()}`, createdAt: now(), messages: [], events: [] }; if (store.rooms.some(r => r.id === room.id)) return json(res, 409, { error: 'room already exists' }); store.rooms.push(room); persist(); return json(res, 201, room); }
    const roomId = url.searchParams.get('room') || 'general'; const room = roomOrFail(roomId); if (!room) return json(res, 404, { error: 'Room not found' });
    if (url.pathname === '/api/state' && req.method === 'GET') { const key = verify(authToken(req, url)); if (!canUse(key, room.id)) return json(res, 401, { error: 'Bearer token required' }); return json(res, 200, state(room)); }
    if (url.pathname === '/api/join' && req.method === 'POST') { const key = verify(authToken(req, url)); if (!canUse(key, room.id)) return json(res, 401, { error: 'Bearer token required' }); const data = await body(req); if (!data.name && !key.label) return json(res, 400, { error: 'name is required' }); const agent = { id: data.id || id(), name: String(data.name || key.label).slice(0, 40), role: data.role || key.role || 'Agent', status: 'online', color: data.color || '#6C63FF', roomId: room.id, lastSeen: now(), joinedAt: now(), tokenLabel: key.label }; agents.set(agent.id, agent); addEvent(room, 'join', `${agent.name} joined the room`, agent.name); return json(res, 200, safeAgent(agent)); }
    if (url.pathname === '/api/heartbeat' && req.method === 'POST') { const key = verify(authToken(req, url)); const data = await body(req); const agent = agents.get(data.id); if (!key || !agent || !canUse(key, agent.roomId)) return json(res, 401, { error: 'Unauthorized' }); agent.lastSeen = now(); agent.status = 'online'; return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/message' && req.method === 'POST') { const key = verify(authToken(req, url)); const data = await body(req); const agent = agents.get(data.agentId); if (!key || !agent || !canUse(key, agent.roomId)) return json(res, 401, { error: 'Unauthorized' }); if (!data.text) return json(res, 400, { error: 'text is required' }); const message = { id: id(), agentId: agent.id, agent: agent.name, role: agent.role, text: String(data.text).slice(0, 4000), kind: data.kind || 'message', at: now() }; room.messages.push(message); room.messages = room.messages.slice(-5000); addEvent(room, message.kind === 'debug' ? 'trace' : 'message', `${message.agent}: ${message.text.slice(0, 80)}`, message.agent); persist(); broadcast(room.id, { type: 'message', message }); return json(res, 201, message); }
    if (url.pathname === '/api/leave' && req.method === 'POST') { const key = verify(authToken(req, url)); const data = await body(req); const agent = agents.get(data.id); if (!key || !agent || !canUse(key, agent.roomId)) return json(res, 401, { error: 'Unauthorized' }); agents.delete(agent.id); addEvent(room, 'leave', `${agent.name} left the room`, agent.name); return json(res, 200, { ok: true }); }
    if (req.method === 'GET') { const file = url.pathname === '/' ? '/public/index.html' : url.pathname; const safe = path.normalize(file).replace(/^([.][.][\\/])+/, ''); const filePath = path.join(ROOT, safe); if (filePath.startsWith(ROOT) && fs.existsSync(filePath)) { const ext = path.extname(filePath); const type = ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'application/javascript'; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return fs.createReadStream(filePath).pipe(res); } }
    json(res, 404, { error: 'Not found' });
  } catch (error) { json(res, 500, { error: error.message }); }
});

const wss = new WebSocket.Server({ noServer: true });
server.on('upgrade', (req, socket, head) => { const url = new URL(req.url, `http://${req.headers.host}`); if (url.pathname !== '/ws') return socket.destroy(); const key = verify(url.searchParams.get('token')); const room = roomOrFail(url.searchParams.get('room') || 'general'); if (!key || !room || !canUse(key, room.id)) return socket.destroy(); wss.handleUpgrade(req, socket, head, ws => { ws.roomId = room.id; ws.tokenLabel = key.label; if (!sockets.has(room.id)) sockets.set(room.id, new Set()); sockets.get(room.id).add(ws); ws.send(JSON.stringify({ type: 'state', state: state(room) })); ws.on('message', raw => { try { const data = JSON.parse(raw.toString()); if (data.type === 'heartbeat') { const agent = agents.get(data.agentId); if (agent && agent.tokenLabel === key.label) { agent.lastSeen = now(); agent.status = 'online'; } } if (data.type === 'message') { const agent = agents.get(data.agentId); if (!agent || agent.tokenLabel !== key.label || agent.roomId !== room.id || !data.text) return; const message = { id: id(), agentId: agent.id, agent: agent.name, role: agent.role, text: String(data.text).slice(0, 4000), kind: data.kind || 'message', at: now() }; room.messages.push(message); room.messages = room.messages.slice(-5000); addEvent(room, message.kind === 'debug' ? 'trace' : 'message', `${message.agent}: ${message.text.slice(0, 80)}`, message.agent); persist(); broadcast(room.id, { type: 'message', message }); } } catch {} }); ws.on('close', () => sockets.get(room.id)?.delete(ws)); }); });

server.listen(PORT, '0.0.0.0', () => { const admin = auth.tokens[0]; console.log(`Agent Relay running at http://${localAddress()}:${PORT}`); console.log(`Agent token (${admin.label}): ${admin.token}`); });
