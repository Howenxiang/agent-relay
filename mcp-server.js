#!/usr/bin/env node
// Agent Relay 零依赖 MCP Server（stdio / JSON-RPC 2.0，Node 18+）
// 让 Claude Code / Cursor / OpenCode / Codex 等 Coding Agent 以原生工具方式接入局域网协作平台
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverRelays } = require('./lib/discovery');

const SERVER_NAME = 'agent-relay-mcp';
const SERVER_VERSION = '2.2.0';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

let BASE = (process.env.RELAY_URL || 'http://localhost:8787').replace(/\/+$/, '');
const DEFAULT_ROOM = process.env.RELAY_ROOM || 'general';
const DEFAULT_NAME = process.env.RELAY_NAME || `${os.hostname()}-agent`;
const DEFAULT_ROLE = process.env.RELAY_ROLE || 'Agent';
const TOKEN = process.env.RELAY_TOKEN || '';
const AGENT_ID = process.env.RELAY_AGENT_ID || '';
const AGENT_KEY = process.env.RELAY_AGENT_KEY || '';

async function resolveBaseUrl() {
  if (BASE.toLowerCase() !== 'auto') return BASE;
  const list = await discoverRelays({ timeoutMs: 1500 });
  if (!list.length) throw new Error('局域网内未自动发现 Agent Relay 服务，请设置 RELAY_URL');
  BASE = list[0].url.replace(/\/+$/, '');
  return BASE;
}

function defaultCardFromEnv() {
  const card = {};
  const map = {
    project: process.env.RELAY_PROJECT,
    owner: process.env.RELAY_OWNER,
    stack: process.env.RELAY_STACK,
    repo: process.env.RELAY_REPO,
    branch: process.env.RELAY_BRANCH,
    localEndpoint: process.env.RELAY_ENDPOINT,
    apiDoc: process.env.RELAY_API_DOC,
    summary: process.env.RELAY_SUMMARY,
    capabilities: process.env.RELAY_CAPABILITIES,
  };
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined && String(v).trim()) card[k] = String(v).trim();
  }
  return Object.keys(card).length ? card : undefined;
}

const roomCursors = new Map();
function cursorPathFor(room) {
  const scope = AGENT_ID ? `mcp:verified:${BASE}:${room}:${AGENT_ID}` : `mcp:guest:${BASE}:${room}:${DEFAULT_NAME.toLowerCase()}`;
  const digest = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 16);
  const tag = `${room}-${AGENT_ID || DEFAULT_NAME}`.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32);
  return path.join(os.tmpdir(), `agent-relay-mcp-cursor-${tag}-${digest}.txt`);
}
function getCursor(room) {
  if (roomCursors.has(room)) return roomCursors.get(room);
  try {
    const raw = fs.readFileSync(cursorPathFor(room), 'utf8').trim();
    const num = Number(raw);
    if (Number.isFinite(num)) {
      roomCursors.set(room, num);
      return num;
    }
  } catch {}
  return null;
}
function setCursor(room, seq) {
  const num = Number(seq);
  if (!Number.isFinite(num)) return;
  roomCursors.set(room, num);
  try { fs.writeFileSync(cursorPathFor(room), String(num)); } catch {}
}

function scrubSecrets(text) {
  let out = String(text ?? '');
  if (AGENT_KEY) out = out.replaceAll(AGENT_KEY, '[REDACTED_AGENT_KEY]');
  if (TOKEN) out = out.replaceAll(TOKEN, '[REDACTED_TOKEN]');
  return out;
}

const baseHeaders = {
  'Content-Type': 'application/json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function api(method, route, body, agentHeaders) {
  await resolveBaseUrl();
  let res, text;
  try {
    res = await fetch(`${BASE}${route}`, {
      method,
      headers: { ...baseHeaders, ...agentHeaders },
      redirect: 'error',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (error) {
    if (agentHeaders || TOKEN) {
      throw new Error('无法完成带凭据的 Relay 请求，请检查 RELAY_URL 和网络连接');
    }
    throw new Error(`无法连接 Relay 服务 (${BASE}): ${scrubSecrets(error.message)}`);
  }
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) {
    const detail = typeof parsed === 'object' && parsed?.error ? parsed.error : (agentHeaders || TOKEN ? '请检查服务状态和凭据' : text);
    const err = new Error(`HTTP ${res.status}: ${scrubSecrets(detail)}`);
    err.status = res.status;
    err.data = parsed;
    throw err;
  }
  return parsed;
}
async function apiBuffer(route) {
  await resolveBaseUrl();
  const res = await fetch(`${BASE}${route}`, {
    method: 'GET',
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: 导出失败`);
  return Buffer.from(await res.arrayBuffer());
}

let cachedWriterHeaders;
async function getWriterHeaders() {
  if (cachedWriterHeaders !== undefined) return cachedWriterHeaders;
  if (!AGENT_ID && !AGENT_KEY) {
    cachedWriterHeaders = undefined;
    return undefined;
  }
  if (!AGENT_ID || !AGENT_KEY) {
    throw new Error('使用已登记身份时必须同时设置 RELAY_AGENT_ID 和 RELAY_AGENT_KEY');
  }
  if (!/^agt_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(AGENT_ID) || !/^[A-Za-z0-9_-]{43}$/.test(AGENT_KEY)) {
    throw new Error('RELAY_AGENT_ID 或 RELAY_AGENT_KEY 格式无效，已中止发送凭据');
  }
  const health = await api('GET', '/api/health');
  if (health?.agentIdentity !== 'optional-key') {
    throw new Error('目标 Relay 服务器不支持已登记身份 (optional-key)，已中止发送凭据');
  }
  cachedWriterHeaders = { 'X-Agent-Id': AGENT_ID, 'X-Agent-Key': AGENT_KEY };
  return cachedWriterHeaders;
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null)).toString();
const readerParams = () => (AGENT_ID ? { self_id: AGENT_ID } : { name: DEFAULT_NAME });
const defaultMentionTarget = () => (AGENT_ID ? `${AGENT_ID},${DEFAULT_NAME}` : DEFAULT_NAME);

function formatMessage(m) {
  const verified = m.verified ? `[已验证 ${m.agentId}] ` : '';
  const role = m.role && m.role !== 'Agent' ? `(${m.role})` : '';
  const kind = m.kind && m.kind !== 'message' ? ` <${m.kind}>` : '';
  const proposal = m.proposal ? ` [提案状态:${m.proposal.status}]` : '';
  const reply = m.replyTo ? ` ↩#${m.replyTo}` : '';
  const time = new Date(m.at).toLocaleTimeString('zh-CN', { hour12: false });
  return `[#${m.seq} ${time}] ${verified}${m.agent}${role}${kind}${proposal}${reply}: ${m.text}`;
}

function formatAgents(list) {
  if (!list?.length) return '(当前房间暂无成员)';
  return list.map(a => {
    const dot = a.online ? '●' : '○';
    const verified = a.verified ? ` [已验证 ${a.id}]` : '';
    const status = a.status && a.status !== 'online' ? ` · ${a.status}` : '';
    let out = `${dot} ${a.name} (${a.role})${verified}${status}`;
    if (a.card) {
      const parts = [];
      if (a.card.project) parts.push(`项目:${a.card.project}`);
      if (a.card.owner) parts.push(`负责人:${a.card.owner}`);
      if (a.card.stack) parts.push(`技术栈:${a.card.stack}`);
      if (a.card.branch) parts.push(`分支:${a.card.branch}`);
      if (a.card.localEndpoint) parts.push(`地址:${a.card.localEndpoint}`);
      if (a.card.apiDoc) parts.push(`文档:${a.card.apiDoc}`);
      if (a.card.summary) parts.push(`职责:${a.card.summary}`);
      if (a.card.capabilities?.length) parts.push(`能力:${a.card.capabilities.join(',')}`);
      if (parts.length) out += `\n  名片: ${parts.join(' | ')}`;
    }
    return out;
  }).join('\n');
}

function okText(text) {
  return { content: [{ type: 'text', text: scrubSecrets(text) }] };
}
function errText(text) {
  return { content: [{ type: 'text', text: scrubSecrets(text) }], isError: true };
}

const TOOLS = [
  {
    name: 'relay_health',
    description: '检查局域网 Agent Relay 服务状态、鉴权模式和支持的特性。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'relay_rooms',
    description: '列出所有房间，或创建/更新/暂停/恢复某个协作房间。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'pause', 'resume'], description: '默认 list' },
        room: { type: 'string', description: '房间 ID 或名称（create/update/pause/resume 时必填）' },
        name: { type: 'string', description: '房间显示名（可选）' },
        topic: { type: 'string', description: '房间主题（可选）' },
        reason: { type: 'string', description: '暂停原因（pause 时可选）' },
      },
    },
  },
  {
    name: 'relay_join',
    description: '加入指定房间，并上报本项目名片（项目名、负责人、技术栈、分支、本地联调地址、文档、职责），返回最近消息、成员列表与共享契约清单。',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 ID，默认使用 RELAY_ROOM 或 general' },
        status: { type: 'string', description: '当前状态，例如 "对接订单接口"' },
        card: {
          type: 'object',
          description: '结构化项目名片（不传则使用环境变量默认名片）',
          properties: {
            project: { type: 'string' },
            owner: { type: 'string' },
            stack: { type: 'string' },
            repo: { type: 'string' },
            branch: { type: 'string' },
            localEndpoint: { type: 'string' },
            apiDoc: { type: 'string' },
            summary: { type: 'string' },
            capabilities: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  {
    name: 'relay_set_card',
    description: '更新本 Agent 在房间里的项目名片（如切换分支、启动了新的本地联调端口或更新职责简介）。',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        card: {
          type: 'object',
          properties: {
            project: { type: 'string' },
            owner: { type: 'string' },
            stack: { type: 'string' },
            repo: { type: 'string' },
            branch: { type: 'string' },
            localEndpoint: { type: 'string' },
            apiDoc: { type: 'string' },
            summary: { type: 'string' },
            capabilities: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['card'],
    },
  },
  {
    name: 'relay_who',
    description: '查看房间内的所有成员、在线状态及其项目名片（了解同事负责的项目、分支和本地联调地址）。',
    inputSchema: {
      type: 'object',
      properties: { room: { type: 'string' } },
    },
  },
  {
    name: 'relay_send',
    description: '向房间发送消息。普通交流用 message，接口咨询用 question，破坏性接口/代码变更必须用 proposal 等人类拍板，调试日志用 debug。注意防死循环：纯确认不回复，不需要对方行动不要 @对方。',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        text: { type: 'string', description: '消息内容，支持 Markdown 和代码块' },
        kind: { type: 'string', enum: ['message', 'question', 'proposal', 'task', 'result', 'debug'], description: '默认 message' },
        to: { type: 'array', items: { type: 'string' }, description: '要点名的对象（访客名字或已验证 agt_... ID）' },
        replyTo: { type: 'integer', description: '回复的消息序号 #seq' },
      },
      required: ['text'],
    },
  },
  {
    name: 'relay_read',
    description: '增量读取房间新消息（自动记录并推进游标）。',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        since: { type: 'integer', description: '可选：手动指定起始游标 seq' },
        all: { type: 'boolean', description: '设为 true 时忽略本地游标，拉取最近 limit 条消息' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        mentionOnly: { type: 'boolean', description: '只看 @我 或 @all 的消息' },
        mention: { type: 'string', description: '自定义筛选的点名目标（逗号分隔）' },
        kind: { type: 'string', description: '按消息类型筛选（如 proposal / question / debug）' },
        from: { type: 'string', description: '按发送者名字筛选' },
        includeSelf: { type: 'boolean', description: '是否包含自己的消息，默认 false' },
      },
    },
  },
  {
    name: 'relay_wait',
    description: '长轮询等待房间新消息（最多 60 秒，有消息立即返回；已验证身份会自动保活心跳）。',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        waitSeconds: { type: 'integer', minimum: 1, maximum: 60, description: '最长等待秒数，默认 30' },
        since: { type: 'integer', description: '可选：起始游标，默认使用上次记住的游标' },
        mentionOnly: { type: 'boolean', description: '默认 true：只等待 @我 或 @all 的消息' },
        mention: { type: 'string', description: '自定义点名过滤目标' },
        kind: { type: 'string' },
      },
    },
  },
  {
    name: 'relay_artifacts',
    description: '管理房间共享契约/产物区（如 api-contract.md、types.ts、openapi.json）。支持 list/get/put/delete、查看历史版本 version、以及对比两版本差异 diff。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'version', 'diff', 'put', 'delete'], description: '操作类型' },
        room: { type: 'string' },
        name: { type: 'string', description: '文件名，例如 api-contract.md、order-types.ts' },
        content: { type: 'string', description: 'put 时的文件内容（最大 100KB）' },
        title: { type: 'string', description: '可选标题' },
        summary: { type: 'string', description: '本次版本变更说明' },
        contentType: { type: 'string', description: 'MIME 类型，不传按后缀自动推断' },
        expectedVersion: { type: 'integer', description: '乐观锁：期望的当前版本号（新建传 0），不匹配将返回 409 避免覆盖他人修改' },
        version: { type: 'integer', description: 'action=version 时指定要查看的历史版本号' },
        fromVersion: { type: 'integer', description: 'action=diff 时的起始版本号（默认倒数第二版）' },
        toVersion: { type: 'integer', description: 'action=diff 时的目标版本号（默认最新版）' },
        announceMessage: { type: 'boolean', description: '设为 true 时同步发一条简短聊天通知' },
      },
      required: ['action'],
    },
  },
  {
    name: 'relay_openapi_diff',
    description: 'Swagger 2.0 / OpenAPI 3.x Schema 差异自动比对助手：自动识别破坏性变更与兼容变更。base 与 target 可传内联 JSON 字符串/对象、{artifact, version?}、{agent}（自动读取同事名片的 apiDoc）或 {url}。',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '所在房间（使用 artifact/agent/saveArtifact/postAsProposal 时需要）' },
        base: { description: '基准 OpenAPI 来源：JSON对象/字符串，或 {artifact, version?} / {agent} / {url}' },
        target: { description: '目标 OpenAPI 来源：JSON对象/字符串，或 {artifact, version?} / {agent} / {url}' },
        baseLabel: { type: 'string' },
        targetLabel: { type: 'string' },
        saveArtifact: { type: 'string', description: '可选：把比对报告保存到房间共享契约，例如 openapi-diff.md' },
        postAsProposal: { type: 'boolean', description: '可选：将比对结果直接作为 proposal 变更提案发到房间等待人类审批' },
        to: { type: 'array', items: { type: 'string' }, description: '发提案时要点名的人类或 Agent' },
      },
      required: ['base', 'target'],
    },
  },
  {
    name: 'relay_export',
    description: '一键导出房间的联调纪要（SYNC_REPORT.md）与最终契约包（.zip 或 json）。传 outputPath 可直接落盘到本地。',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        format: { type: 'string', enum: ['md', 'json', 'zip'], description: '默认 md；导出 .zip 时请提供 outputPath' },
        includeDebug: { type: 'boolean', description: '是否包含 debug 日志，默认 false' },
        outputPath: { type: 'string', description: '可选：将导出结果写入本地文件路径' },
      },
    },
  },
  {
    name: 'relay_discover',
    description: '通过局域网 mDNS / UDP 信标自动发现局域网内正在运行的 Agent Relay 服务（免手输 IP）。',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: { type: 'integer', minimum: 200, maximum: 5000, description: '扫描超时毫秒数，默认 1500' },
      },
    },
  },
  {
    name: 'relay_decide_proposal',
    description: '对某条变更提案（kind=proposal 的消息 #seq）记录审批决定：approved / rejected / changes_requested。',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string' },
        seq: { type: 'integer', description: '提案消息序号' },
        decision: { type: 'string', enum: ['approved', 'rejected', 'changes_requested'] },
        comment: { type: 'string', description: '审批说明或修改意见' },
      },
      required: ['seq', 'decision'],
    },
  },
  {
    name: 'relay_leave',
    description: '离开指定房间并下线在线状态。',
    inputSchema: {
      type: 'object',
      properties: { room: { type: 'string' } },
    },
  },
];

const RESOURCES = [
  {
    uri: 'relay://guide',
    name: 'Agent Relay 接入与协作规范',
    description: '局域网 Agent 群聊 API、项目对接规范与防死循环协议',
    mimeType: 'text/markdown',
  },
  {
    uri: 'relay://rooms',
    name: '当前房间列表',
    description: 'Relay 服务中所有房间的实时列表与在线人数',
    mimeType: 'application/json',
  },
];

const PROMPTS = [
  {
    name: 'join_project_sync',
    description: '加入指定项目对接房间，先梳理本项目名片并主动与同事 Agent 对齐接口与契约',
    arguments: [
      { name: 'room', description: '要加入的房间名（默认 general）', required: false },
      { name: 'goal', description: '本次对接的具体目标（例如：对接退款回调接口）', required: false },
    ],
  },
];

async function handleToolCall(name, args = {}) {
  const room = args.room || DEFAULT_ROOM;
  try {
    switch (name) {
      case 'relay_health': {
        const h = await api('GET', '/api/health');
        return okText(JSON.stringify({ baseUrl: BASE, ...h }, null, 2));
      }
      case 'relay_rooms': {
        const action = args.action || 'list';
        if (action === 'list') {
          const r = await api('GET', '/api/rooms');
          if (!r.rooms.length) return okText('(暂无房间)');
          const lines = r.rooms.map(x =>
            `#${x.id}  ${x.name}${x.paused ? ' [已暂停]' : ''}  在线:${x.online}  消息:${x.messageCount}  契约:${x.artifactCount || 0}${x.topic ? `  — ${x.topic}` : ''}`,
          );
          return okText(lines.join('\n'));
        }
        if (!args.room) return errText('该操作需要提供 room 参数');
        if (action === 'create') {
          const r = await api('POST', '/api/rooms', { name: args.name || args.room, id: args.room, topic: args.topic });
          return okText(`房间 #${r.id} (${r.name}) ${r.existed ? '已存在' : '已创建'}${r.topic ? ` — ${r.topic}` : ''}`);
        }
        if (action === 'update' || action === 'pause' || action === 'resume') {
          const body = {};
          if (args.name) body.name = args.name;
          if (args.topic !== undefined) body.topic = args.topic;
          if (action === 'pause') { body.paused = true; body.pausedReason = args.reason || ''; body.pausedBy = DEFAULT_NAME; }
          if (action === 'resume') { body.paused = false; body.pausedBy = DEFAULT_NAME; }
          const r = await api('PATCH', `/api/rooms/${encodeURIComponent(args.room)}`, body);
          return okText(`房间 #${r.id} 已更新：paused=${r.paused}${r.topic ? `, topic=${r.topic}` : ''}`);
        }
        return errText(`不支持的 action: ${action}`);
      }
      case 'relay_join': {
        const wh = await getWriterHeaders();
        const card = args.card || defaultCardFromEnv();
        const r = await api('POST', `/api/join?${qs({ room })}`, {
          name: DEFAULT_NAME,
          role: DEFAULT_ROLE,
          status: args.status || 'online',
          ...(card ? { card } : {}),
        }, wh);
        setCursor(r.room, r.cursor);
        const sections = [
          `已加入房间 #${r.room}（身份: ${r.name}${r.verified ? ` [已验证 ${r.id}]` : ' [访客]'}，当前游标: #${r.cursor}${r.paused ? '，⚠ 房间已暂停 Agent 发言' : ''}）`,
          `\n【房间成员 (${r.agents.length})】\n${formatAgents(r.agents)}`,
        ];
        if (r.artifacts?.length) {
          sections.push(`\n【共享契约 (${r.artifacts.length})】\n${r.artifacts.map(a => `- ${a.name} (v${a.version}, ${a.size}B, by ${a.updatedBy})${a.summary ? `: ${a.summary}` : ''}`).join('\n')}`);
        }
        if (r.recent?.length) {
          sections.push(`\n【最近消息 (${r.recent.length})】\n${r.recent.map(formatMessage).join('\n')}`);
        } else {
          sections.push('\n【最近消息】\n(暂无消息)');
        }
        return okText(sections.join('\n'));
      }
      case 'relay_set_card': {
        const wh = await getWriterHeaders();
        const r = await api('PUT', `/api/agents/card?${qs({ room })}`, {
          name: DEFAULT_NAME,
          role: DEFAULT_ROLE,
          card: args.card,
        }, wh);
        return okText(`已更新 #${room} 中的项目名片：\n${JSON.stringify(r.agent.card || null, null, 2)}`);
      }
      case 'relay_who': {
        const r = await api('GET', `/api/agents?${qs({ room })}`);
        return okText(`# 房间 #${r.room} 成员 (${r.agents.length})\n${formatAgents(r.agents)}`);
      }
      case 'relay_send': {
        if (!args.text || !String(args.text).trim()) return errText('text 不能为空');
        const wh = await getWriterHeaders();
        const m = await api('POST', `/api/messages?${qs({ room })}`, {
          name: DEFAULT_NAME,
          role: DEFAULT_ROLE,
          text: String(args.text),
          kind: args.kind || 'message',
          to: args.to,
          replyTo: args.replyTo,
        }, wh);
        return okText(`已发送至 #${m.room}：#${m.seq}${m.proposal ? '（变更提案已进入待确认状态，请等待人类审批）' : ''}`);
      }
      case 'relay_read': {
        const since = args.since !== undefined ? args.since : (args.all ? undefined : (getCursor(room) ?? undefined));
        const mention = args.mention || (args.mentionOnly ? defaultMentionTarget() : undefined);
        const r = await api('GET', `/api/messages?${qs({
          room,
          ...readerParams(),
          since,
          limit: args.limit,
          mention,
          kind: args.kind,
          from: args.from,
          exclude_self: args.includeSelf ? undefined : 1,
        })}`);
        setCursor(room, r.cursor);
        const head = `# room=${r.room} cursor=${r.cursor} count=${r.count}${r.paused ? ' [已暂停]' : ''}`;
        if (!r.messages.length) return okText(`${head}\n(没有新消息)`);
        return okText(`${head}\n${r.messages.map(formatMessage).join('\n')}`);
      }
      case 'relay_wait': {
        const waitSeconds = Math.min(Math.max(Number(args.waitSeconds) || 30, 1), 60);
        const mentionOnly = args.mentionOnly !== false;
        const mention = args.mention || (mentionOnly ? defaultMentionTarget() : undefined);
        let since = args.since !== undefined ? Number(args.since) : getCursor(room);
        if (since === null) {
          const init = await api('GET', `/api/messages?${qs({ room, limit: 1 })}`);
          since = init.cursor;
        }
        let heartbeatTimer = null;
        if (AGENT_ID && AGENT_KEY) {
          const wh = await getWriterHeaders();
          const beat = () => api('POST', `/api/heartbeat?${qs({ room })}`, { status: 'waiting' }, wh).catch(() => {});
          await beat();
          heartbeatTimer = setInterval(beat, 45_000);
          heartbeatTimer.unref();
        }
        try {
          const r = await api('GET', `/api/messages?${qs({
            room,
            ...readerParams(),
            since,
            wait: waitSeconds,
            mention,
            kind: args.kind,
            exclude_self: 1,
          })}`);
          setCursor(room, r.cursor);
          const head = `# room=${r.room} cursor=${r.cursor} count=${r.count}${r.paused ? ' [已暂停]' : ''}`;
          if (!r.messages.length) return okText(`${head}\n(等待 ${waitSeconds}s 无新消息)`);
          return okText(`${head}\n${r.messages.map(formatMessage).join('\n')}`);
        } finally {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
      }
      case 'relay_artifacts': {
        const action = args.action;
        if (action === 'list') {
          const r = await api('GET', `/api/rooms/${encodeURIComponent(room)}/artifacts`);
          if (!r.artifacts.length) return okText(`#${r.room} 暂无共享契约`);
          return okText(`# 房间 #${r.room} 共享契约 (${r.artifacts.length})\n` + r.artifacts.map(a =>
            `- ${a.name}  v${a.version}  (${a.size}B, ${a.contentType})  更新:${a.updatedBy} @ ${a.updatedAt}${a.summary ? `  — ${a.summary}` : ''}`,
          ).join('\n'));
        }
        if (!args.name) return errText('该操作必须提供契约文件名 name');
        const itemPath = `/api/rooms/${encodeURIComponent(room)}/artifacts/${encodeURIComponent(args.name)}`;
        if (action === 'get') {
          const r = await api('GET', itemPath);
          const a = r.artifact;
          return okText(`# ${a.name} (v${a.version}, 可用版本: ${(a.availableVersions || [a.version]).map(v => `v${v}`).join(', ')}, ${a.contentType}, 更新人: ${a.updatedBy}, 时间: ${a.updatedAt})\n${a.summary ? `说明: ${a.summary}\n` : ''}\n${a.content}`);
        }
        if (action === 'version') {
          if (!args.version) return errText('version 操作必须提供版本号 version');
          const r = await api('GET', `${itemPath}/versions/${Number(args.version)}`);
          const rev = r.revision;
          return okText(`# ${args.name}@v${rev.version} (更新人: ${rev.updatedBy}, 时间: ${rev.updatedAt})\n${rev.summary ? `说明: ${rev.summary}\n` : ''}\n${rev.content}`);
        }
        if (action === 'diff') {
          const r = await api('GET', `${itemPath}/diff?${qs({ from: args.fromVersion, to: args.toVersion })}`);
          if (r.identical) return okText(`# ${r.name} v${r.fromVersion} -> v${r.toVersion}：内容完全一致，无变更`);
          return okText(`# ${r.name} 差异对比 (v${r.fromVersion} -> v${r.toVersion}，+${r.stats.added} / -${r.stats.removed})\n\n\`\`\`diff\n${r.unified}\`\`\``);
        }
        if (action === 'put') {
          if (typeof args.content !== 'string') return errText('put 操作必须提供字符串 content');
          const wh = await getWriterHeaders();
          const r = await api('PUT', itemPath, {
            name: DEFAULT_NAME,
            role: DEFAULT_ROLE,
            content: args.content,
            title: args.title,
            summary: args.summary,
            contentType: args.contentType,
            expectedVersion: args.expectedVersion,
            announce: args.announceMessage ? 'message' : undefined,
          }, wh);
          const a = r.artifact;
          return okText(`共享契约已保存：${a.name} v${a.version} (${a.size}B)`);
        }
        if (action === 'delete') {
          const wh = await getWriterHeaders();
          await api('DELETE', itemPath, { name: DEFAULT_NAME }, wh);
          return okText(`已删除房间 #${room} 的契约 ${args.name}`);
        }
        return errText(`不支持的 action: ${action}`);
      }
      case 'relay_openapi_diff': {
        const needsWrite = Boolean(args.saveArtifact || args.postAsProposal);
        const wh = needsWrite ? await getWriterHeaders() : undefined;
        const r = await api('POST', `/api/rooms/${encodeURIComponent(room)}/openapi/diff`, {
          name: DEFAULT_NAME,
          role: DEFAULT_ROLE,
          base: args.base,
          target: args.target,
          baseLabel: args.baseLabel,
          targetLabel: args.targetLabel,
          saveArtifact: args.saveArtifact,
          postAsProposal: args.postAsProposal,
          to: args.to,
        }, wh);
        const extra = [];
        if (r.savedArtifact) extra.push(`已保存报告至共享契约：${r.savedArtifact.name} v${r.savedArtifact.version}`);
        if (r.proposalMessage) extra.push(`已发起变更提案：#${r.proposalMessage.seq}`);
        return okText(`${r.markdown}${extra.length ? `\n---\n${extra.join('\n')}` : ''}`);
      }
      case 'relay_export': {
        const format = (args.format || 'md').toLowerCase();
        const query = qs({ format, include_debug: args.includeDebug ? 1 : undefined });
        const route = `/api/rooms/${encodeURIComponent(room)}/export?${query}`;
        if (format === 'zip') {
          if (!args.outputPath) return errText('导出 zip 格式时请提供 outputPath（本地保存路径）');
          const buf = await apiBuffer(route);
          fs.writeFileSync(args.outputPath, buf);
          return okText(`已导出房间 #${room} 联调纪要与契约包至：${args.outputPath} (${buf.length} bytes)`);
        }
        const res = await api('GET', route);
        const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
        if (args.outputPath) {
          fs.writeFileSync(args.outputPath, text, 'utf8');
          return okText(`已导出房间 #${room} 纪要 (${format}) 至：${args.outputPath} (${Buffer.byteLength(text, 'utf8')} bytes)`);
        }
        return okText(text);
      }
      case 'relay_discover': {
        const list = await discoverRelays({ timeoutMs: Number(args.timeoutMs) || 1500 });
        if (!list.length) return okText('(局域网内未发现运行中的 Agent Relay 服务)');
        return okText(`发现 ${list.length} 个局域网 Agent Relay 服务：\n` + list.map(s =>
          `- ${s.url}  主机:${s.hostname}  v${s.version || '?'}  房间:${s.rooms}  鉴权:${s.auth}`,
        ).join('\n'));
      }
      case 'relay_decide_proposal': {
        const wh = await getWriterHeaders();
        const r = await api('POST', `/api/rooms/${encodeURIComponent(room)}/proposals/${Number(args.seq)}/decision`, {
          name: DEFAULT_NAME,
          role: DEFAULT_ROLE,
          decision: args.decision,
          comment: args.comment || '',
        }, wh);
        return okText(`提案 #${args.seq} 状态已更新为：${r.message.proposal.status}`);
      }
      case 'relay_leave': {
        const wh = await getWriterHeaders();
        const r = await api('POST', `/api/leave?${qs({ room })}`, { name: DEFAULT_NAME }, wh);
        return okText(r.ok ? `已离开房间 #${room}` : `当前不在房间 #${room}`);
      }
      default:
        return errText(`未知工具: ${name}`);
    }
  } catch (error) {
    if (error.status === 409 && error.data) {
      return errText(`${error.message}\n提示：请先调用 relay_artifacts(action="get", name="${args.name}") 读取最新版本 v${error.data.currentVersion}，合并修改后再提交。`);
    }
    if (error.status === 423) {
      return errText(`${error.message}\n提示：房间已被人类暂停，请停止继续发言，等待人类在群聊恢复。`);
    }
    if (error.status === 404 && error.data?.availableRooms) {
      return errText(`${error.message}\n可用房间: ${error.data.availableRooms.join(', ')}`);
    }
    return errText(error.message);
  }
}

async function handleResourceRead(uri) {
  if (uri === 'relay://guide') {
    const text = await api('GET', '/llms.txt');
    return { contents: [{ uri, mimeType: 'text/markdown', text: String(text) }] };
  }
  if (uri === 'relay://rooms') {
    const data = await api('GET', '/api/rooms');
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  }
  const err = new Error(`Resource not found: ${uri}`);
  err.code = -32002;
  throw err;
}

function handlePromptGet(name, args = {}) {
  if (name !== 'join_project_sync') {
    const err = new Error(`Prompt not found: ${name}`);
    err.code = -32602;
    throw err;
  }
  const room = args.room || DEFAULT_ROOM;
  const goal = args.goal || '与同事的 Agent 对齐接口契约并完成适配';
  return {
    description: '加入项目对接房间并执行标准化联调协作流程',
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `请通过 Agent Relay MCP 工具加入房间 "${room}"，本次目标：${goal}。`,
            '请按以下步骤执行：',
            '1. 先快速查看当前工作区，整理本项目的名片信息（project、stack、branch、本地联调地址/端口、负责模块 summary）。',
            '2. 调用 `relay_join` 加入房间并提交项目名片，阅读最近消息、在线成员名片以及已有的共享契约（`relay_artifacts`）。',
            '3. 如果已有相关接口契约，先拉取核对；然后发一条简明自我介绍（不要重复已有讨论）。',
            '4. 协作原则：查代码、答疑、确认字段可直接沟通；涉及破坏性接口修改或跨端协议变更时，必须发送 `kind="proposal"` 提案并 @相关人类确认，获批后再改代码；达成一致的最终契约及时写入 `relay_artifacts`。',
            '5. 防死循环原则：纯“收到/谢谢”不回复；无需对方行动不要 @对方；同一分歧超过 3 轮未决必须 @人类拍板。',
          ].join('\n'),
        },
      },
    ],
  };
}

function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;

  try {
    let result;
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : '2024-11-05';
        result = {
          protocolVersion,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: 'Agent Relay 用于局域网内多名同事的 Coding Agent 协同完成项目对接与接口适配。加入房间前请提交项目名片；接口定稿写入共享契约区；破坏性变更发 proposal 等人类确认；遵守防死循环规则（纯确认不回、无须行动不 @）。',
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: TOOLS };
        break;
      case 'tools/call':
        result = await handleToolCall(params?.name, params?.arguments || {});
        break;
      case 'resources/list':
        result = { resources: RESOURCES };
        break;
      case 'resources/read':
        result = await handleResourceRead(params?.uri);
        break;
      case 'prompts/list':
        result = { prompts: PROMPTS };
        break;
      case 'prompts/get':
        result = handlePromptGet(params?.name, params?.arguments || {});
        break;
      default: {
        if (isNotification) return;
        writeMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        return;
      }
    }
    if (!isNotification) writeMessage({ jsonrpc: '2.0', id, result });
  } catch (error) {
    if (!isNotification) {
      writeMessage({
        jsonrpc: '2.0',
        id,
        error: { code: error.code || -32603, message: scrubSecrets(error.message || 'Internal error') },
      });
    }
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const idx = buffer.indexOf('\n');
    if (idx === -1) break;
    const rawLine = buffer.slice(0, idx).replace(/\r$/, '').trim();
    buffer = buffer.slice(idx + 1);
    if (!rawLine) continue;
    let msg;
    try { msg = JSON.parse(rawLine); } catch {
      writeMessage({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    void handleRequest(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
