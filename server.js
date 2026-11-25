const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');
const { diffText } = require('./lib/diff');
const { diffOpenApi } = require('./lib/openapi-diff');
const { buildSyncReportMarkdown, buildRoomExportZip } = require('./lib/export');
const { startDiscoveryResponder, SERVICE_TYPE } = require('./lib/discovery');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const INSTANCE_ID = crypto.randomUUID();
// 留空 = 开放模式（局域网内任何人/Agent 无需 Token 即可使用）；设置后所有受保护 API 需携带该共享口令
const SHARED_TOKEN = process.env.AGENT_RELAY_TOKEN || '';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.AGENT_RELAY_DATA || path.join(ROOT, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'relay.json');
const GUIDE_FILE = path.join(ROOT, 'AGENT_ONBOARDING_PROMPT.md');

const VERSION = '2.2.0';
const MAX_TEXT = 20000;
const MAX_META = 64 * 1024;
const MAX_CARD = 4096;
const MAX_ARTIFACT_BYTES = 100 * 1024;
const MAX_ARTIFACTS_PER_ROOM = 50;
const MAX_ARTIFACT_HISTORY = 10;
const MAX_MESSAGES = 5000;
const MAX_EVENTS = 100;
const MAX_BODY = 1024 * 1024;
const ONLINE_MS = 90 * 1000;
const MAX_WAIT_SECONDS = 60;
const RATE_LIMIT_MAX = process.env.AGENT_RELAY_RATE_LIMIT !== undefined
  ? Math.max(0, Number(process.env.AGENT_RELAY_RATE_LIMIT) || 0)
  : 20;
const RATE_LIMIT_WINDOW_MS = Math.max(1000, (Number(process.env.AGENT_RELAY_RATE_WINDOW_SEC) || 30) * 1000);
const COLORS = ['#6C63FF', '#4F8DFD', '#2EC4B6', '#5FE1AB', '#F0C36D', '#FF8A65', '#E86AF0', '#76B5FF', '#A3E635', '#F472B6'];

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const httpError = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
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
if (!Object.hasOwn(store, 'agentCards') || !store.agentCards || typeof store.agentCards !== 'object' || Array.isArray(store.agentCards)) {
  store.agentCards = {};
}
for (const room of store.rooms) normalizeRoom(room);
if (!store.rooms.some(r => r.id === 'general')) store.rooms.unshift(normalizeRoom({ id: 'general', name: '大厅 General' }));

let persistTimer = null;
let persistRetryMs = 0;
function renameAtomic(tmp, target) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (error) {
      if ((error.code === 'EPERM' || error.code === 'EBUSY') && attempt < 2) continue;
      throw error;
    }
  }
}
function persistNow() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  renameAtomic(tmp, DATA_FILE);
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
function persistImmediate() {
  try { persistNow(); }
  catch { retryPersistence(); }
}
function requireWritable() {
  if (persistRetryMs) throw httpError(503, 'Relay storage temporarily unavailable');
}

function normalizeRoom(room) {
  room.id = room.id || uid();
  room.name = room.name || room.id;
  room.topic = room.topic || '';
  room.createdAt = room.createdAt || now();
  room.paused = Boolean(room.paused);
  room.pausedReason = typeof room.pausedReason === 'string' ? room.pausedReason : '';
  room.pausedBy = typeof room.pausedBy === 'string' ? room.pausedBy : '';
  room.pausedAt = room.pausedAt || null;
  room.messages = Array.isArray(room.messages) ? room.messages : [];
  room.events = Array.isArray(room.events) ? room.events : [];
  room.artifacts = room.artifacts && typeof room.artifacts === 'object' && !Array.isArray(room.artifacts) ? room.artifacts : {};
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
function cleanArtifactName(raw) {
  const name = String(raw || '').trim();
  if (!name || name.length > 80 || name.startsWith('.') || name.includes('..') || !/^[\p{L}\p{N}._-]+$/u.test(name)) {
    throw httpError(400, 'Invalid artifact name (use letters, numbers, ".", "_", "-", max 80 chars)');
  }
  return name;
}
function inferContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.sql': 'text/sql',
    '.proto': 'text/plain',
    '.graphql': 'text/plain',
    '.http': 'text/plain',
    '.txt': 'text/plain',
  };
  return map[ext] || 'text/markdown';
}
function colorFor(name) {
  const hash = crypto.createHash('md5').update(name.toLowerCase()).digest();
  return COLORS[hash[0] % COLORS.length];
}
function parseMentions(text) {
  const set = new Set();
  for (const match of String(text).matchAll(/@([\p{L}\p{N}_.-]+)/gu)) {
    const token = match[1].replace(/[.,:;!?]+$/g, '').toLowerCase();
    if (token) set.add(token);
  }
  return [...set];
}
function toList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : String(value).split(','))
    .map(v => String(v).trim().replace(/^@/, '').replace(/[.,:;!?]+$/g, '').toLowerCase())
    .filter(Boolean);
}
function safeHttpUrl(value, maxLen = 200) {
  const raw = String(value || '').trim().slice(0, maxLen);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw httpError(400, 'Card URLs must use http:// or https://');
    }
    return raw;
  } catch (error) {
    if (error.status) throw error;
    throw httpError(400, 'Invalid URL in agent card');
  }
}
function sanitizeCard(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'card must be a JSON object');
  const card = {};
  const str = (key, max) => {
    if (raw[key] === undefined || raw[key] === null) return;
    const val = String(raw[key]).trim().slice(0, max);
    if (val) card[key] = val;
  };
  str('project', 80);
  str('owner', 40);
  str('stack', 120);
  str('repo', 120);
  str('branch', 80);
  str('summary', 300);
  if (raw.localEndpoint !== undefined && raw.localEndpoint !== null && String(raw.localEndpoint).trim()) {
    card.localEndpoint = safeHttpUrl(raw.localEndpoint, 200);
  }
  if (raw.apiDoc !== undefined && raw.apiDoc !== null && String(raw.apiDoc).trim()) {
    card.apiDoc = safeHttpUrl(raw.apiDoc, 200);
  }
  if (raw.capabilities !== undefined && raw.capabilities !== null) {
    const list = (Array.isArray(raw.capabilities) ? raw.capabilities : String(raw.capabilities).split(','))
      .map(item => String(item).trim().slice(0, 32))
      .filter(Boolean)
      .slice(0, 10);
    if (list.length) card.capabilities = [...new Set(list)];
  }
  if (Object.keys(card).length === 0) return null;
  if (JSON.stringify(card).length > MAX_CARD) throw httpError(400, 'Agent card too large');
  return card;
}
function localAddresses() {
  const list = [];
  for (const group of Object.values(os.networkInterfaces())) {
    for (const item of group || []) {
      if (item.family === 'IPv4' && !item.internal) list.push(item.address);
    }
  }
  const rank = (ip) => /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  list.sort((a, b) => rank(a) - rank(b));
  return list.length ? list : ['localhost'];
}
function baseUrl(req) { return `http://${req.headers.host || `${localAddresses()[0]}:${PORT}`}`; }
function fmtTime(iso) { return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }); }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Relay-Token, X-Agent-Id, X-Agent-Key',
};
function send(res, status, body, type = 'application/json', extraHeaders = {}) {
  const text = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', ...CORS, ...extraHeaders });
  res.end(text);
}
function sendBinary(res, status, buf, type = 'application/octet-stream', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...CORS, ...extraHeaders });
  res.end(buf);
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
    req.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      }
    });
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
  return {
    identity,
    info: {
      agentId: ids[0],
      name,
      role: input.role,
      color: input.color,
      status: message ? undefined : input.status,
      card: input.card,
    },
  };
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
function requireExistingRoom(raw, allowCreate = false) {
  const id = slug(raw) || 'general';
  const room = getRoom(raw, allowCreate);
  if (!room) {
    throw httpError(404, `Room "${id}" not found`, {
      payload: {
        error: `Room "${id}" not found`,
        room: id,
        availableRooms: store.rooms.map(r => r.id),
        hint: '请检查房间名，或通过 POST /api/rooms / POST /api/join 创建房间（也可传 ?create=1 自动建房）',
      },
    });
  }
  return room;
}
function publicRoom(r) {
  return {
    id: r.id,
    name: r.name,
    topic: r.topic,
    lastSeq: r.seq,
    paused: Boolean(r.paused),
    pausedReason: r.pausedReason || '',
    pausedBy: r.pausedBy || '',
    pausedAt: r.pausedAt || null,
  };
}
function artifactRevisions(a) {
  if (Array.isArray(a.revisions) && a.revisions.length) return a.revisions;
  return [{
    version: a.version,
    content: a.content,
    title: a.title,
    summary: a.summary,
    updatedBy: a.updatedBy,
    updatedById: a.updatedById,
    verified: a.verified,
    size: a.size,
    updatedAt: a.updatedAt,
  }];
}
function publicArtifact(a) {
  const revs = artifactRevisions(a);
  const { revisions, ...rest } = a;
  return { ...rest, availableVersions: revs.map(r => r.version) };
}
function artifactSummary(a) {
  return {
    name: a.name,
    title: a.title,
    contentType: a.contentType,
    version: a.version,
    availableVersions: artifactRevisions(a).map(r => r.version),
    summary: a.summary,
    size: a.size,
    updatedBy: a.updatedBy,
    updatedById: a.updatedById,
    verified: a.verified,
    updatedAt: a.updatedAt,
  };
}
function artifactList(room) {
  return Object.values(room.artifacts || {})
    .map(artifactSummary)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
function saveArtifact(room, name, data, getAgent) {
  if (typeof data.content !== 'string') throw httpError(400, 'content string is required');
  if (Buffer.byteLength(data.content, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw httpError(413, `Artifact content exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const existing = Object.hasOwn(room.artifacts, name) ? room.artifacts[name] : null;
  if (!existing && Object.keys(room.artifacts).length >= MAX_ARTIFACTS_PER_ROOM) {
    throw httpError(400, `Room artifact limit reached (${MAX_ARTIFACTS_PER_ROOM})`);
  }
  if (data.expectedVersion !== undefined && data.expectedVersion !== null && data.expectedVersion !== '') {
    const expected = Number(data.expectedVersion);
    const current = existing ? existing.version : 0;
    if (!Number.isInteger(expected) || expected !== current) {
      throw httpError(409, `Artifact version conflict: expected v${expected}, current is v${current}`, {
        payload: {
          error: `Artifact version conflict: expected v${expected}, current is v${current}`,
          currentVersion: current,
          artifact: existing ? publicArtifact(existing) : null,
        },
      });
    }
  }
  const agent = typeof getAgent === 'function' ? getAgent() : getAgent;
  const version = (existing ? existing.version : 0) + 1;
  const updatedAt = now();
  const summary = String(data.summary || '').trim().slice(0, 200);
  const title = String(data.title || existing?.title || name).trim().slice(0, 120) || name;
  const size = Buffer.byteLength(data.content, 'utf8');
  const historyEntry = {
    version,
    updatedBy: agent.name,
    updatedById: agent.id,
    verified: agent.verified,
    summary,
    size,
    updatedAt,
  };
  const revisionEntry = { ...historyEntry, title, content: data.content };
  const history = existing && Array.isArray(existing.history)
    ? [...existing.history, historyEntry].slice(-MAX_ARTIFACT_HISTORY)
    : [historyEntry];
  const prevRevisions = existing ? artifactRevisions(existing) : [];
  const revisions = [...prevRevisions, revisionEntry].slice(-MAX_ARTIFACT_HISTORY);

  const artifact = {
    name,
    title,
    contentType: String(data.contentType || existing?.contentType || inferContentType(name)).trim().slice(0, 60),
    content: data.content,
    version,
    summary,
    size,
    updatedBy: agent.name,
    updatedById: agent.id,
    verified: agent.verified,
    createdAt: existing?.createdAt || updatedAt,
    updatedAt,
    history,
    revisions,
  };
  room.artifacts[name] = artifact;
  persistImmediate();
  addEvent(room, 'artifact', `${agent.name} ${existing ? '更新' : '创建'}了契约 ${name} (v${version})${summary ? `：${summary}` : ''}`, agent);
  broadcast(room.id, { type: 'artifacts', artifacts: artifactList(room) });
  broadcastAll({ type: 'rooms', rooms: roomList() });
  if (data.announce === 'message') {
    postMessage(
      room,
      {
        text: `📄 共享契约 \`${name}\` 已更新至 **v${version}**${summary ? `：${summary}` : ''}`,
        kind: 'result',
        to: data.to,
      },
      () => agent,
    );
  }
  return { artifact, existed: Boolean(existing) };
}
async function fetchOpenApiJson(rawUrl) {
  const safe = safeHttpUrl(rawUrl, 500);
  let res;
  try {
    res = await fetch(safe, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    throw httpError(502, `无法拉取 OpenAPI 文档 (${safe}): ${error.message}`);
  }
  if (!res.ok) throw httpError(502, `拉取 OpenAPI 文档失败 (${safe}): HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 2 * 1024 * 1024) throw httpError(413, 'Remote OpenAPI document exceeds 2MB limit');
  try { return JSON.parse(text); } catch {
    throw httpError(400, `远端地址未返回合法 JSON (${safe})`);
  }
}
async function resolveOpenApiSource(source, room, fallbackLabel) {
  if (source === undefined || source === null) throw httpError(400, `${fallbackLabel} source is required`);
  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return { spec: await fetchOpenApiJson(trimmed), label: trimmed };
    }
    try { return { spec: JSON.parse(trimmed), label: fallbackLabel }; }
    catch { throw httpError(400, `${fallbackLabel} 不是合法 JSON 或 URL`); }
  }
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw httpError(400, `${fallbackLabel} 必须是 OpenAPI 对象、URL 或来源描述符`);
  }
  if (source.artifact) {
    if (!room) throw httpError(400, '按 artifact 比对时必须指定房间');
    const name = cleanArtifactName(source.artifact);
    const art = Object.hasOwn(room.artifacts, name) ? room.artifacts[name] : null;
    if (!art) throw httpError(404, `Artifact "${name}" not found in room "${room.id}"`);
    let content = art.content;
    let ver = art.version;
    if (source.version !== undefined && source.version !== null && source.version !== '') {
      ver = Number(source.version);
      const rev = artifactRevisions(art).find(r => r.version === ver);
      if (!rev) throw httpError(404, `Artifact "${name}" version v${ver} not found`);
      content = rev.content;
    }
    try { return { spec: JSON.parse(content), label: `${name}@v${ver}` }; }
    catch { throw httpError(400, `契约 ${name}@v${ver} 不是合法的 OpenAPI JSON`); }
  }
  if (source.agent) {
    if (!room) throw httpError(400, '按成员名片比对时必须指定房间');
    const needle = String(source.agent).trim().toLowerCase();
    const member = agentsIn(room.id).find(a => a.id.toLowerCase() === needle || a.name.toLowerCase() === needle);
    if (!member) throw httpError(404, `Room "${room.id}" 中未找到成员 "${source.agent}"`);
    if (!member.card?.apiDoc) throw httpError(400, `成员 "${member.name}" 的项目名片未配置 apiDoc 地址`);
    return { spec: await fetchOpenApiJson(member.card.apiDoc), label: `${member.name} (${member.card.apiDoc})` };
  }
  if (source.url) {
    return { spec: await fetchOpenApiJson(source.url), label: source.label || source.url };
  }
  return { spec: source, label: fallbackLabel };
}
function roomList() {
  return store.rooms.map(r => ({
    id: r.id,
    name: r.name,
    topic: r.topic,
    paused: Boolean(r.paused),
    artifactCount: Object.keys(r.artifacts || {}).length,
    messageCount: r.messages.length,
    lastSeq: r.seq,
    lastMessageAt: r.messages.at(-1)?.at || null,
    online: agentsIn(r.id).filter(a => a.online).length,
  }));
}

const agents = new Map();
const guestPresenceKey = (roomId, name) => `guest:${roomId}:${name.toLowerCase()}`;
const verifiedPresenceKey = (roomId, id) => `verified:${roomId}:${id}`;
const presenceKey = (a) => a.verified ? verifiedPresenceKey(a.roomId, a.id) : guestPresenceKey(a.roomId, a.name);
function publicAgent(a) {
  const out = {
    id: a.id,
    verified: a.verified,
    name: a.name,
    role: a.role,
    color: a.color,
    status: a.status,
    roomId: a.roomId,
    online: isOnline(a),
    lastSeen: a.lastSeen,
    joinedAt: a.joinedAt,
  };
  if (a.card) out.card = a.card;
  return out;
}
function isOnline(a) { return a.sockets > 0 || Date.now() - Date.parse(a.lastSeen) < ONLINE_MS; }
function agentsIn(roomId) {
  return [...agents.values()]
    .filter(a => a.roomId === roomId)
    .map(publicAgent)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}
function findPresence(room, info, identity) {
  if (identity) return agents.get(verifiedPresenceKey(room.id, identity.id));
  if (info.agentId) {
    for (const a of agents.values()) if (!a.verified && a.roomId === room.id && a.id === info.agentId) return a;
  }
  return agents.get(guestPresenceKey(room.id, cleanName(info.name)));
}
function touchAgent(room, info, identity = null) {
  const nextCard = sanitizeCard(info.card);
  let agent = findPresence(room, info, identity);
  const isNew = !agent;
  const wasOnline = agent ? isOnline(agent) : false;
  if (!agent) {
    const name = identity ? identity.name : cleanName(info.name);
    const savedCard = identity && Object.hasOwn(store.agentCards, identity.id) ? store.agentCards[identity.id] : undefined;
    agent = {
      id: identity?.id || uid(),
      verified: !!identity,
      name,
      role: identity?.role || 'Agent',
      color: colorFor(identity?.id || name),
      status: 'online',
      roomId: room.id,
      joinedAt: now(),
      lastSeen: now(),
      sockets: 0,
      ...(savedCard ? { card: savedCard } : {}),
    };
    agents.set(presenceKey(agent), agent);
  }
  if (!identity && info.role) agent.role = String(info.role).slice(0, 30);
  if (!identity && info.color) agent.color = String(info.color).slice(0, 20);
  if (info.status) agent.status = String(info.status).slice(0, 60);
  let cardChanged = false;
  if (nextCard !== undefined) {
    const prevJson = JSON.stringify(agent.card || null);
    const nextJson = JSON.stringify(nextCard);
    if (prevJson !== nextJson) {
      if (nextCard === null) delete agent.card;
      else agent.card = nextCard;
      cardChanged = true;
      if (identity) {
        if (nextCard === null) delete store.agentCards[identity.id];
        else store.agentCards[identity.id] = nextCard;
        persistImmediate();
      }
    }
  }
  agent.lastSeen = now();
  if (isNew || !wasOnline) {
    addEvent(room, 'join', `${agent.name} 加入了房间`, agent);
    broadcast(room.id, { type: 'agents', agents: agentsIn(room.id) });
  } else if (cardChanged) {
    addEvent(room, 'card', `${agent.name} 更新了项目名片${agent.card?.project ? ` (${agent.card.project})` : ''}`, agent);
    broadcast(room.id, { type: 'agents', agents: agentsIn(room.id) });
  }
  return agent;
}

// ---------- 防死循环速率保护 ----------
const rateBuckets = new Map(); // `${roomId}:${agentId}` -> number[]
const rateAlertAt = new Map();
function checkRateLimit(room, agent) {
  if (!RATE_LIMIT_MAX) return;
  if (String(agent.role || '').toLowerCase() === 'human') return;
  const key = `${room.id}:${agent.id}`;
  const ts = Date.now();
  const cutoff = ts - RATE_LIMIT_WINDOW_MS;
  const bucket = (rateBuckets.get(key) || []).filter(t => t > cutoff);
  if (bucket.length >= RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((bucket[0] + RATE_LIMIT_WINDOW_MS - ts) / 1000));
    rateBuckets.set(key, bucket);
    if (ts - (rateAlertAt.get(key) || 0) > RATE_LIMIT_WINDOW_MS) {
      rateAlertAt.set(key, ts);
      addEvent(room, 'loop_guard', `${agent.name} 短时间发言过快，触发防死循环限流（${RATE_LIMIT_MAX} 条/${Math.round(RATE_LIMIT_WINDOW_MS / 1000)}s）`, agent);
    }
    throw httpError(429, `Rate limit exceeded (anti-loop guard). Retry after ${retryAfter}s.`, {
      headers: { 'Retry-After': String(retryAfter) },
    });
  }
  bucket.push(ts);
  rateBuckets.set(key, bucket);
}

// ---------- 消息 ----------
function addEvent(room, type, detail, agent) {
  const event = { id: uid(), type, detail, agent: agent.name, agentId: agent.id, verified: agent.verified, at: now() };
  room.events.unshift(event);
  room.events = room.events.slice(0, MAX_EVENTS);
  persist();
  broadcast(room.id, { type: 'event', event });
}
function isHumanModerator(agent, data) {
  return data?.overridePause === true || String(agent.role || '').trim().toLowerCase() === 'human';
}
function postMessage(room, data, getAgent, options = {}) {
  const text = String(data.text ?? data.content ?? data.message ?? '').slice(0, MAX_TEXT);
  if (!text.trim()) throw httpError(400, 'text is required');
  let meta;
  if (data.meta !== undefined && data.meta !== null) {
    if (typeof data.meta === 'object' && !Array.isArray(data.meta)) {
      if (JSON.stringify(data.meta).length > MAX_META) throw httpError(400, 'meta payload too large');
      meta = data.meta;
    }
  }
  const agent = getAgent();
  if (room.paused && !options.ignorePause && !isHumanModerator(agent, data)) {
    throw httpError(423, room.pausedReason ? `Room is paused: ${room.pausedReason}` : 'Room is paused by human moderator', {
      payload: {
        error: room.pausedReason ? `Room is paused: ${room.pausedReason}` : 'Room is paused by human moderator',
        paused: true,
        pausedReason: room.pausedReason || '',
        pausedBy: room.pausedBy || '',
      },
    });
  }
  if (!options.ignoreRateLimit) checkRateLimit(room, agent);
  const kind = String(data.kind || 'message').slice(0, 20);
  const mentions = [...new Set([...parseMentions(text), ...toList(data.to)])];
  const message = {
    id: uid(),
    seq: ++room.seq,
    room: room.id,
    agentId: agent.id,
    verified: agent.verified,
    agent: agent.name,
    role: agent.role,
    text,
    kind,
    mentions,
    replyTo: data.replyTo ? Number(data.replyTo) || String(data.replyTo) : undefined,
    meta,
    ...(kind === 'proposal' ? { proposal: { status: 'pending', decisions: [] } } : {}),
    at: now(),
  };
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES) room.messages = room.messages.slice(-MAX_MESSAGES);
  persist();
  broadcast(room.id, { type: 'message', message });
  if (message.kind === 'debug') addEvent(room, 'trace', `${message.agent}: ${text.slice(0, 80)}`, agent);
  if (message.kind === 'proposal') addEvent(room, 'proposal', `${message.agent} 发起了变更提案 #${message.seq}`, agent);
  wakeWaiters(room);
  return message;
}
function mentionsYou(message, targetParam) {
  const targets = String(targetParam || '')
    .split(',')
    .map(s => s.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
  if (!targets.length) return false;
  if (message.mentions.includes('all') || message.mentions.includes('所有人') || message.mentions.includes('everyone')) return true;
  return targets.some(t => message.mentions.includes(t));
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
    excludeSelf: excludeSelf ? (url.searchParams.get('name') || '').toLowerCase() : '',
  };
}
function messagesAsText(room, list, cursor) {
  const lines = list.map(m => {
    const proposalTag = m.proposal ? ` [${m.proposal.status}]` : '';
    return `[#${m.seq} ${fmtTime(m.at)}] ${m.verified ? `[已验证 ${m.agentId}] ` : ''}${m.agent}${m.role && m.role !== 'Agent' ? `(${m.role})` : ''}${m.kind !== 'message' ? ` <${m.kind}>` : ''}${proposalTag}${m.replyTo ? ` ↩#${m.replyTo}` : ''}: ${m.text}`;
  });
  return `# room=${room.id} cursor=${cursor} count=${list.length}${room.paused ? ' paused=1' : ''}\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
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
    room: publicRoom(room),
    rooms: roomList(),
    agents: agentsIn(room.id),
    artifacts: artifactList(room),
    messages: room.messages.slice(-200),
    events: room.events.slice(0, 40),
    server: {
      version: VERSION,
      hosts: localAddresses(),
      port: PORT,
      auth: SHARED_TOKEN ? 'shared-token' : 'open',
      baseUrl: req ? baseUrl(req) : null,
      rateLimit: RATE_LIMIT_MAX,
    },
  };
}

function guide(req) {
  const base = baseUrl(req);
  let text = '';
  try { text = fs.readFileSync(GUIDE_FILE, 'utf8'); } catch { text = '# Agent Relay\n'; }
  return text
    .replaceAll('<RELAY_BASE_URL>', base)
    .replaceAll('<RELAY_WS_URL>', base.replace(/^http/, 'ws'))
    .replaceAll('<AUTH_NOTE>', SHARED_TOKEN ? '本服务已启用共享口令：受保护的接口需带 `Authorization: Bearer <口令>` 或 `?token=<口令>`。' : '本服务为开放模式，无需全局共享口令。');
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  try {
    // 免鉴权：首页、静态资源、说明文档、健康检查、服务发现信息
    if (req.method === 'GET' && ['/llms.txt', '/agent.md', '/AGENT.md', '/api', '/api/help'].includes(p)) return send(res, 200, guide(req), 'text/markdown');
    if (req.method === 'GET' && p === '/api/health') {
      return send(res, 200, {
        ok: true,
        version: VERSION,
        auth: SHARED_TOKEN ? 'shared-token' : 'open',
        agentIdentity: 'optional-key',
        features: ['cards', 'artifacts', 'artifact-diff', 'proposals', 'pause', 'rate-limit', 'export-zip', 'openapi-diff', 'discovery'],
        rooms: store.rooms.length,
        time: now(),
      });
    }
    if (req.method === 'GET' && p === '/api/discovery') {
      const addr = server.address();
      return send(res, 200, {
        serviceType: SERVICE_TYPE,
        instanceId: INSTANCE_ID,
        hostname: os.hostname(),
        version: VERSION,
        port: addr ? addr.port : PORT,
        hosts: localAddresses(),
        auth: SHARED_TOKEN ? 'shared-token' : 'open',
        discovery: discoveryHandle ? discoveryHandle.status : { enabled: false, serviceType: SERVICE_TYPE },
      });
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(res, p);

    if (!authorized(req, url)) return send(res, 401, { error: 'Shared token required', hint: 'Authorization: Bearer <token> 或 ?token=<token>' });
    if (url.searchParams.has('agentKey')) throw httpError(400, 'Do not pass the Agent key in the URL');

    if (p === '/api/auth/verify') return send(res, 200, { ok: true, auth: SHARED_TOKEN ? 'shared-token' : 'open' });
    if (p === '/api/agents/register' && req.method === 'POST') {
      if (contentType(req) !== 'application/json') throw httpError(415, 'Expected application/json');
      return send(res, 201, registerIdentity(await readBody(req)));
    }

    // 房间管理
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
      if (typeof data.paused === 'boolean' && data.paused !== room.paused) {
        room.paused = data.paused;
        room.pausedReason = data.paused ? String(data.pausedReason || '').trim().slice(0, 200) : '';
        room.pausedBy = data.paused ? cleanName(data.pausedBy || data.name, 'moderator') : '';
        room.pausedAt = data.paused ? now() : null;
        addEvent(
          room,
          room.paused ? 'pause' : 'resume',
          room.paused
            ? `${room.pausedBy} 暂停了 Agent 发言${room.pausedReason ? `：${room.pausedReason}` : ''}`
            : `${cleanName(data.pausedBy || data.name, 'moderator')} 恢复了房间对话`,
          { name: room.pausedBy || cleanName(data.name, 'moderator'), id: 'moderator', verified: false },
        );
      } else if (room.paused && data.pausedReason !== undefined) {
        room.pausedReason = String(data.pausedReason).trim().slice(0, 200);
      }
      persistImmediate();
      broadcast(room.id, { type: 'room', room: publicRoom(room) });
      broadcastAll({ type: 'rooms', rooms: roomList() });
      return send(res, 200, publicRoom(room));
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

    // 房间导出（联调纪要 SYNC_REPORT.md + 最终契约包 .zip / JSON）
    const roomExportMatch = p.match(/^\/api\/rooms\/([^/]+)\/export$/);
    if (roomExportMatch && req.method === 'GET') {
      const room = requireExistingRoom(decodeURIComponent(roomExportMatch[1]), false);
      const format = (url.searchParams.get('format') || 'zip').toLowerCase();
      const includeDebug = url.searchParams.get('include_debug') === '1' || url.searchParams.get('includeDebug') === 'true';
      const members = agentsIn(room.id);
      if (format === 'md' || format === 'markdown') {
        const md = buildSyncReportMarkdown(room, members, { includeDebug });
        return send(res, 200, md, 'text/markdown', {
          'Content-Disposition': `attachment; filename="${room.id}-sync-report.md"`,
        });
      }
      const bundle = buildRoomExportZip(room, members, { includeDebug });
      if (format === 'json') {
        return send(res, 200, bundle.transcript);
      }
      if (format === 'zip') {
        return sendBinary(res, 200, bundle.zip, 'application/zip', {
          'Content-Disposition': `attachment; filename="${bundle.filename}"`,
        });
      }
      return send(res, 400, { error: 'Unsupported export format; use zip, md, or json' });
    }

    // Swagger / OpenAPI Schema 差异自动比对助手
    const openApiRoomMatch = p.match(/^\/api\/rooms\/([^/]+)\/openapi\/diff$/);
    if ((p === '/api/openapi/diff' || openApiRoomMatch) && req.method === 'POST') {
      const data = await readBody(req);
      const targetRoomRaw = openApiRoomMatch ? decodeURIComponent(openApiRoomMatch[1]) : (data.room || url.searchParams.get('room') || '');
      const needsWrite = Boolean(data.saveArtifact || data.postAsProposal);
      const writer = needsWrite ? httpWriter(req, url, data, false, data) : null;
      if (writer) requireWritable();
      const room = targetRoomRaw ? requireExistingRoom(targetRoomRaw, false) : null;
      if (needsWrite && !room) throw httpError(400, '保存契约或发提案时必须指定房间');

      const baseResolved = await resolveOpenApiSource(data.base, room, data.baseLabel || 'base');
      const targetResolved = await resolveOpenApiSource(data.target, room, data.targetLabel || 'target');
      let report;
      try {
        report = diffOpenApi(baseResolved.spec, targetResolved.spec, {
          baseLabel: data.baseLabel || baseResolved.label,
          targetLabel: data.targetLabel || targetResolved.label,
        });
      } catch (error) {
        throw httpError(400, error.message);
      }

      let savedArtifact = null;
      let proposalMessage = null;
      if (needsWrite) {
        const agent = touchAgent(room, writer.info, writer.identity);
        if (data.saveArtifact) {
          const artName = cleanArtifactName(typeof data.saveArtifact === 'string' ? data.saveArtifact : 'openapi-diff.md');
          const { artifact } = saveArtifact(room, artName, {
            content: report.markdown,
            title: `OpenAPI 差异比对 (${report.base.label} → ${report.target.label})`,
            summary: `破坏性:${report.summary.breakingCount} / 兼容:${report.summary.nonBreakingCount}`,
            contentType: 'text/markdown',
          }, agent);
          savedArtifact = publicArtifact(artifact);
        }
        if (data.postAsProposal) {
          const mentionTo = data.to;
          const intro = `🔍 OpenAPI Schema 自动比对完成（\`${report.base.label}\` → \`${report.target.label}\`）：破坏性变更 **${report.summary.breakingCount}** 项，兼容变更 **${report.summary.nonBreakingCount}** 项。\n\n`;
          proposalMessage = postMessage(room, {
            text: `${intro}${report.markdown}`.slice(0, MAX_TEXT),
            kind: 'proposal',
            to: mentionTo,
            meta: { openapiDiff: report.summary },
          }, () => agent);
        }
      }
      return send(res, 200, { ...report, savedArtifact, proposalMessage });
    }

    // 房间共享契约 / 产物（Artifacts）
    const artifactsListMatch = p.match(/^\/api\/rooms\/([^/]+)\/artifacts$/);
    if (artifactsListMatch && req.method === 'GET') {
      const room = requireExistingRoom(decodeURIComponent(artifactsListMatch[1]), false);
      return send(res, 200, { room: room.id, artifacts: artifactList(room) });
    }
    const artifactDiffMatch = p.match(/^\/api\/rooms\/([^/]+)\/artifacts\/([^/]+)\/diff$/);
    if (artifactDiffMatch && req.method === 'GET') {
      const room = requireExistingRoom(decodeURIComponent(artifactDiffMatch[1]), false);
      const name = cleanArtifactName(decodeURIComponent(artifactDiffMatch[2]));
      const artifact = Object.hasOwn(room.artifacts, name) ? room.artifacts[name] : null;
      if (!artifact) return send(res, 404, { error: 'Artifact not found', room: room.id, name });
      const revs = artifactRevisions(artifact);
      const versions = revs.map(r => r.version);
      const toVer = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : versions.at(-1);
      const defaultFrom = versions.length >= 2 ? versions.at(-2) : versions[0];
      const fromVer = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : defaultFrom;
      const fromRev = revs.find(r => r.version === fromVer);
      const toRev = revs.find(r => r.version === toVer);
      if (!fromRev || !toRev) {
        return send(res, 404, { error: `Requested version not available (available: ${versions.map(v => `v${v}`).join(', ')})`, availableVersions: versions });
      }
      const diff = diffText(fromRev.content, toRev.content, { fromLabel: `${name}@v${fromVer}`, toLabel: `${name}@v${toVer}` });
      if (url.searchParams.get('format') === 'text') {
        return send(res, 200, diff.unified || `# ${name} v${fromVer} -> v${toVer} (无变更)\n`, 'text/plain');
      }
      const { content: _fc, ...fromMeta } = fromRev;
      const { content: _tc, ...toMeta } = toRev;
      return send(res, 200, {
        room: room.id,
        name,
        fromVersion: fromVer,
        toVersion: toVer,
        fromMeta,
        toMeta,
        availableVersions: versions,
        ...diff,
      });
    }
    const artifactVersionMatch = p.match(/^\/api\/rooms\/([^/]+)\/artifacts\/([^/]+)\/versions\/(\d+)$/);
    if (artifactVersionMatch && req.method === 'GET') {
      const room = requireExistingRoom(decodeURIComponent(artifactVersionMatch[1]), false);
      const name = cleanArtifactName(decodeURIComponent(artifactVersionMatch[2]));
      const ver = Number(artifactVersionMatch[3]);
      const artifact = Object.hasOwn(room.artifacts, name) ? room.artifacts[name] : null;
      if (!artifact) return send(res, 404, { error: 'Artifact not found', room: room.id, name });
      const rev = artifactRevisions(artifact).find(r => r.version === ver);
      if (!rev) return send(res, 404, { error: `Version v${ver} not found`, availableVersions: artifactRevisions(artifact).map(r => r.version) });
      if (url.searchParams.get('format') === 'raw') return send(res, 200, rev.content, 'text/plain');
      return send(res, 200, { room: room.id, name, revision: rev });
    }
    const artifactItemMatch = p.match(/^\/api\/rooms\/([^/]+)\/artifacts\/([^/]+)$/);
    if (artifactItemMatch) {
      const targetRoomId = decodeURIComponent(artifactItemMatch[1]);
      const name = cleanArtifactName(decodeURIComponent(artifactItemMatch[2]));
      if (req.method === 'GET') {
        const room = requireExistingRoom(targetRoomId, false);
        const artifact = Object.hasOwn(room.artifacts, name) ? room.artifacts[name] : null;
        if (!artifact) return send(res, 404, { error: 'Artifact not found', room: room.id, name });
        if (url.searchParams.get('format') === 'raw') return send(res, 200, artifact.content, 'text/plain');
        return send(res, 200, { room: room.id, artifact: publicArtifact(artifact) });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const data = await readBody(req);
        const writer = httpWriter(req, url, data, false, data);
        requireWritable();
        const room = requireExistingRoom(targetRoomId, Boolean(data.createRoom));
        const { artifact, existed } = saveArtifact(room, name, data, () => touchAgent(room, writer.info, writer.identity));
        return send(res, existed ? 200 : 201, { room: room.id, artifact: publicArtifact(artifact) });
      }
      if (req.method === 'DELETE') {
        const data = await readBody(req);
        const writer = httpWriter(req, url, data, false, data);
        requireWritable();
        const room = requireExistingRoom(targetRoomId, false);
        if (!Object.hasOwn(room.artifacts, name)) return send(res, 404, { error: 'Artifact not found', room: room.id, name });
        const agent = touchAgent(room, writer.info, writer.identity);
        delete room.artifacts[name];
        persistImmediate();
        addEvent(room, 'artifact', `${agent.name} 删除了契约 ${name}`, agent);
        broadcast(room.id, { type: 'artifacts', artifacts: artifactList(room) });
        broadcastAll({ type: 'rooms', rooms: roomList() });
        return send(res, 200, { ok: true, room: room.id, name });
      }
    }

    // 变更提案审批门禁
    const proposalDecisionMatch = p.match(/^\/api\/rooms\/([^/]+)\/proposals\/(\d+)\/decision$/);
    if (proposalDecisionMatch && req.method === 'POST') {
      const targetRoomId = decodeURIComponent(proposalDecisionMatch[1]);
      const seq = Number(proposalDecisionMatch[2]);
      const data = await readBody(req);
      const writer = httpWriter(req, url, data, false, data);
      requireWritable();
      const room = requireExistingRoom(targetRoomId, false);
      const target = room.messages.find(m => m.seq === seq);
      if (!target) return send(res, 404, { error: `Message #${seq} not found` });
      if (target.kind !== 'proposal' && !target.proposal) {
        return send(res, 400, { error: `Message #${seq} is not a proposal` });
      }
      const decision = String(data.decision || '').trim().toLowerCase();
      if (!['approved', 'rejected', 'changes_requested'].includes(decision)) {
        return send(res, 400, { error: 'decision must be one of: approved, rejected, changes_requested' });
      }
      const comment = String(data.comment || '').trim().slice(0, 2000);
      const actor = touchAgent(room, writer.info, writer.identity);
      if (!target.proposal) target.proposal = { status: 'pending', decisions: [] };
      const entry = {
        by: actor.name,
        byId: actor.id,
        verified: actor.verified,
        role: actor.role,
        decision,
        comment,
        at: now(),
      };
      target.proposal.status = decision;
      target.proposal.decisions = [...(target.proposal.decisions || []), entry].slice(-50);
      persistImmediate();
      const labels = { approved: '已通过', rejected: '已驳回', changes_requested: '需修改' };
      addEvent(room, 'proposal', `${actor.name} 对提案 #${seq} 做出决定：${labels[decision]}${comment ? `（${comment.slice(0, 60)}）` : ''}`, actor);
      broadcast(room.id, { type: 'message_updated', message: target });
      let replyMessage = null;
      if (data.announce !== false) {
        const mentionTarget = target.verified ? target.agentId : target.agent;
        replyMessage = postMessage(
          room,
          {
            text: `提案 #${seq} 审批结果：**${labels[decision]}**${comment ? `\n${comment}` : ''}`,
            kind: 'decision',
            replyTo: seq,
            to: [mentionTarget],
            meta: { proposalSeq: seq, decision },
            overridePause: true,
          },
          () => actor,
          { ignorePause: true, ignoreRateLimit: true },
        );
      }
      return send(res, 200, { ok: true, message: target, replyMessage });
    }

    const needsBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
    const data = needsBody ? await readBody(req) : {};
    const q = (key) => url.searchParams.get(key);
    const isMessage = (['/api/messages', '/api/message', '/api/send'].includes(p) && req.method === 'POST') || (p === '/api/send' && req.method === 'GET');
    const isPresence = (['/api/join', '/api/heartbeat', '/api/leave', '/api/card'].includes(p) && req.method === 'POST')
      || (p === '/api/agents/card' && (req.method === 'PUT' || req.method === 'POST'));
    const input = isMessage ? { ...Object.fromEntries(url.searchParams), ...data } : data;
    const writer = isMessage || isPresence ? httpWriter(req, url, data, isMessage, input) : null;
    if (writer) requireWritable();

    const rawRoom = q('room') || data.room || 'general';
    const allowCreateOnRead = q('create') === '1' || q('create') === 'true';

    if (p === '/api/state' && req.method === 'GET') {
      const room = requireExistingRoom(rawRoom, allowCreateOnRead);
      if (q('name') && !persistRetryMs) touchAgent(room, { name: q('name') });
      return send(res, 200, state(room, req));
    }
    if (p === '/api/agents' && req.method === 'GET') {
      const room = requireExistingRoom(rawRoom, allowCreateOnRead);
      return send(res, 200, { room: room.id, agents: agentsIn(room.id) });
    }

    if (p === '/api/join' && req.method === 'POST') {
      const room = getRoom(rawRoom, true);
      const agent = touchAgent(room, writer.info, writer.identity);
      return send(res, 200, {
        ...publicAgent(agent),
        room: room.id,
        paused: Boolean(room.paused),
        cursor: room.seq,
        recent: room.messages.slice(-20),
        agents: agentsIn(room.id),
        artifacts: artifactList(room),
        guide: `${baseUrl(req)}/llms.txt`,
      });
    }
    if (p === '/api/heartbeat' && req.method === 'POST') {
      const room = getRoom(rawRoom, true);
      const agent = touchAgent(room, writer.info, writer.identity);
      return send(res, 200, { ok: true, agent: publicAgent(agent), lastSeq: room.seq, paused: Boolean(room.paused) });
    }
    if ((p === '/api/agents/card' && (req.method === 'PUT' || req.method === 'POST')) || (p === '/api/card' && req.method === 'POST')) {
      const room = getRoom(rawRoom, true);
      const cardInput = Object.hasOwn(data, 'card') ? data.card : {
        project: data.project,
        owner: data.owner,
        stack: data.stack,
        repo: data.repo,
        branch: data.branch,
        localEndpoint: data.localEndpoint,
        apiDoc: data.apiDoc,
        summary: data.summary,
        capabilities: data.capabilities,
      };
      const agent = touchAgent(room, { ...writer.info, card: cardInput }, writer.identity);
      return send(res, 200, { ok: true, agent: publicAgent(agent) });
    }
    if (p === '/api/leave' && req.method === 'POST') {
      const room = getRoom(rawRoom, false);
      if (!room) return send(res, 200, { ok: false });
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
      const room = getRoom(rawRoom, true);
      const message = postMessage(room, input, () => touchAgent(room, writer.info, writer.identity));
      return q('format') === 'text' ? send(res, 201, `ok #${message.seq}\n`, 'text/plain') : send(res, 201, message);
    }

    // 读取消息（支持长轮询 wait=秒）
    if (p === '/api/messages' && req.method === 'GET') {
      const room = requireExistingRoom(rawRoom, allowCreateOnRead);
      const query = parseQuery(url);
      if (q('name') && !persistRetryMs) touchAgent(room, { name: q('name') });
      const reply = ({ list, cursor }) => q('format') === 'text'
        ? send(res, 200, messagesAsText(room, list, cursor), 'text/plain')
        : send(res, 200, { room: room.id, paused: Boolean(room.paused), cursor, count: list.length, messages: list });
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
    const body = error.payload || { error: error.status ? error.message : 'Internal server error' };
    send(res, error.status || 500, body, 'application/json', error.headers || {});
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
const wss = new WebSocket.Server({ noServer: true, maxPayload: MAX_BODY });
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
        } else if (data.type === 'card') {
          const proof = requireBoundIdentity(data);
          requireWritable();
          const a = bind({ ...data, name: data.name || agent?.name }, proof);
          ws.send(JSON.stringify({ type: 'card_updated', agent: publicAgent(a) }));
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

// 定期刷新在线状态 & 清理过期限流桶
const lastOnline = new Map();
setInterval(() => {
  for (const room of store.rooms) {
    const sig = agentsIn(room.id).filter(a => a.online).map(a => a.id).join(',');
    if (lastOnline.get(room.id) !== sig) { lastOnline.set(room.id, sig); broadcast(room.id, { type: 'agents', agents: agentsIn(room.id) }); }
  }
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [key, bucket] of rateBuckets) {
    const fresh = bucket.filter(t => t > cutoff);
    if (fresh.length) rateBuckets.set(key, fresh);
    else rateBuckets.delete(key);
  }
}, 15000).unref();

let discoveryHandle = null;
function shutdown() {
  if (discoveryHandle) discoveryHandle.close();
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
  const actualPort = server.address().port;
  const discoveryFlag = process.env.AGENT_RELAY_DISCOVERY;
  const shouldDiscover = discoveryFlag === '1' || (discoveryFlag !== '0' && process.env.PORT !== '0');
  if (shouldDiscover) {
    discoveryHandle = startDiscoveryResponder(() => ({
      instanceId: INSTANCE_ID,
      hostname: os.hostname(),
      version: VERSION,
      auth: SHARED_TOKEN ? 'shared-token' : 'open',
      rooms: store.rooms.length,
      port: actualPort,
      hosts: localAddresses(),
    }), {
      mdns: process.env.AGENT_RELAY_MDNS !== '0',
    });
  }
  process.send?.({ type: 'ready', port: actualPort });
  console.log(`Agent Relay v${VERSION} 局域网 Agent 协作平台已启动`);
  for (const host of localAddresses()) console.log(`  浏览器/Agent 地址: http://${host}:${actualPort}`);
  console.log(`  Agent 接入说明:   http://${localAddresses()[0]}:${actualPort}/llms.txt`);
  console.log(`  MCP Server 入口:  node ${path.join(ROOT, 'mcp-server.js')}`);
  if (discoveryHandle) console.log(`  局域网自动发现:   已启用 (${SERVICE_TYPE} + UDP :${discoveryHandle.status.beaconPort})`);
  console.log(SHARED_TOKEN ? '  鉴权模式: 共享口令 (AGENT_RELAY_TOKEN)' : '  鉴权模式: 开放（无需 Token）');
});
