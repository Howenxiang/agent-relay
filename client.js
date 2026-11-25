#!/usr/bin/env node
// Agent Relay 零依赖命令行客户端（Node 18+）
// 用法见 node client.js help
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverRelays } = require('./lib/discovery');

const BOOL_FLAGS = new Set(['all', 'self', 'raw', 'no-announce', 'override-pause', 'json', 'announce-message', 'include-debug', 'propose']);
const args = process.argv.slice(2);
const cmd = args.shift() || 'help';
const opts = {};
const rest = [];
let stopFlags = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!stopFlags && a === '--') { stopFlags = true; continue; }
  if (!stopFlags && a.startsWith('--') && a.length > 2) {
    const eq = a.indexOf('=');
    if (eq !== -1) {
      opts[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const k = a.slice(2);
      if (BOOL_FLAGS.has(k)) {
        opts[k] = true;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        opts[k] = args[++i];
      } else {
        opts[k] = 'true';
      }
    }
  } else {
    rest.push(a);
  }
}

let BASE = (opts.url || process.env.RELAY_URL || 'http://localhost:8787').replace(/\/+$/, '');
const ROOM = opts.room || process.env.RELAY_ROOM || 'general';
const NAME = opts.name || process.env.RELAY_NAME || `${os.hostname()}-agent`;
const ROLE = opts.role || process.env.RELAY_ROLE || '';
const TOKEN = opts.token || process.env.RELAY_TOKEN || '';
const AGENT_ID = opts['agent-id'] || process.env.RELAY_AGENT_ID || '';
const AGENT_KEY = process.env.RELAY_AGENT_KEY || '';

async function resolveBaseUrl() {
  if (BASE.toLowerCase() !== 'auto') return BASE;
  const list = await discoverRelays({ timeoutMs: Number(opts.timeout) || 1500 });
  if (!list.length) throw new Error('局域网内未自动发现 Agent Relay 服务，请手动指定 --url 或设置 RELAY_URL');
  BASE = list[0].url.replace(/\/+$/, '');
  return BASE;
}

function safeCursorPath() {
  const scope = AGENT_ID ? `verified:${BASE}:${ROOM}:${AGENT_ID}` : `guest:${BASE}:${ROOM}:${NAME.toLowerCase()}`;
  const digest = crypto.createHash('sha256').update(scope).digest('hex').slice(0, 16);
  const tag = `${ROOM}-${AGENT_ID || NAME}`.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32);
  return path.join(os.tmpdir(), `agent-relay-cursor-${tag}-${digest}.txt`);
}

const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
async function api(method, p, body, agentHeaders) {
  await resolveBaseUrl();
  let res, text;
  try {
    res = await fetch(`${BASE}${p}`, {
      method,
      headers: { ...headers, ...agentHeaders },
      redirect: 'error',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (error) {
    if (agentHeaders || TOKEN) throw new Error('无法完成带凭据的请求，请检查连接和服务地址');
    throw error;
  }
  if (!res.ok) throw new Error(`${res.status} ${agentHeaders || TOKEN ? '请求失败，请检查服务状态和凭据' : text}`);
  try { return JSON.parse(text); } catch { return text; }
}
async function apiBuffer(p) {
  await resolveBaseUrl();
  const res = await fetch(`${BASE}${p}`, {
    method: 'GET',
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

let cachedWriterHeaders;
async function writerHeaders() {
  if (cachedWriterHeaders !== undefined) return cachedWriterHeaders;
  if (!AGENT_ID && !AGENT_KEY) { cachedWriterHeaders = undefined; return undefined; }
  if (!AGENT_ID || !AGENT_KEY) throw new Error('登记身份需要同时设置 RELAY_AGENT_ID 和 RELAY_AGENT_KEY');
  if (!/^agt_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(AGENT_ID) || !/^[A-Za-z0-9_-]{43}$/.test(AGENT_KEY)) {
    throw new Error('Agent ID 或密钥格式有误；未发送请求');
  }
  const health = await api('GET', '/api/health');
  if (health?.agentIdentity !== 'optional-key') throw new Error('该服务器未支持登记身份；未发送请求');
  cachedWriterHeaders = { 'X-Agent-Id': AGENT_ID, 'X-Agent-Key': AGENT_KEY };
  return cachedWriterHeaders;
}
function checkWriter(result, id) {
  if (AGENT_ID && (result.verified !== true || id !== AGENT_ID)) throw new Error('服务端未返回匹配的登记身份');
}
function buildCardFromOpts() {
  const card = {};
  const map = {
    project: opts.project || process.env.RELAY_PROJECT,
    owner: opts.owner || process.env.RELAY_OWNER,
    stack: opts.stack || process.env.RELAY_STACK,
    repo: opts.repo || process.env.RELAY_REPO,
    branch: opts.branch || process.env.RELAY_BRANCH,
    localEndpoint: opts.endpoint || opts['local-endpoint'] || process.env.RELAY_ENDPOINT,
    apiDoc: opts['api-doc'] || process.env.RELAY_API_DOC,
    summary: opts.summary || process.env.RELAY_SUMMARY,
    capabilities: opts.capabilities || process.env.RELAY_CAPABILITIES,
  };
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined && v !== '') card[k] = v;
  }
  return Object.keys(card).length ? card : undefined;
}
function parseOpenApiArg(raw) {
  if (!raw) throw new Error('请指定 --base 和 --target 来源');
  const s = String(raw).trim();
  if (s.startsWith('artifact:')) {
    const spec = s.slice('artifact:'.length);
    const at = spec.lastIndexOf('@');
    if (at > 0 && /^v?\d+$/.test(spec.slice(at + 1))) {
      return { artifact: spec.slice(0, at), version: Number(spec.slice(at + 1).replace(/^v/, '')) };
    }
    return { artifact: spec };
  }
  if (s.startsWith('agent:')) return { agent: s.slice('agent:'.length) };
  if (/^https?:\/\//i.test(s)) return { url: s };
  return JSON.parse(fs.readFileSync(s, 'utf8'));
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();
const reader = AGENT_ID ? { self_id: AGENT_ID } : { name: NAME };
const readCursor = () => { try { return Number(fs.readFileSync(safeCursorPath(), 'utf8')) || 0; } catch { return null; } };
const saveCursor = (c) => fs.writeFileSync(safeCursorPath(), String(c));
const identityLabel = (id, verified) => verified ? `[已验证 ${id}] ` : '';
const line = (m) => {
  const proposal = m.proposal ? ` [${m.proposal.status}]` : '';
  const reply = m.replyTo ? ` ↩#${m.replyTo}` : '';
  return `[#${m.seq} ${new Date(m.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${identityLabel(m.agentId, m.verified)}${m.agent}${m.kind !== 'message' ? ` <${m.kind}>` : ''}${proposal}${reply}: ${m.text}`;
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function startVerifiedHeartbeat() {
  if (!AGENT_ID || !AGENT_KEY) return () => {};
  const wh = await writerHeaders();
  const beat = () => api('POST', `/api/heartbeat?${qs({ room: ROOM })}`, { status: opts.status || 'listening' }, wh).catch(() => {});
  await beat();
  const timer = setInterval(beat, 45_000);
  timer.unref();
  return () => clearInterval(timer);
}

async function main() {
  switch (cmd) {
    case 'discover': {
      const list = await discoverRelays({ timeoutMs: Number(opts.timeout) || 1500 });
      if (opts.json) { console.log(JSON.stringify(list, null, 2)); break; }
      if (!list.length) { console.log('(局域网内未发现 Agent Relay 服务)'); break; }
      list.forEach(s => console.log(`${s.url}  主机:${s.hostname}  v${s.version || '?'}  房间:${s.rooms}  鉴权:${s.auth}`));
      break;
    }
    case 'register': {
      const r = await api('POST', '/api/agents/register', { name: NAME, role: ROLE || undefined });
      if (!r?.agentId || !r.agentKey || r.verified !== true) throw new Error('服务端未返回登记身份');
      console.log(JSON.stringify(r));
      break;
    }
    case 'join': {
      const card = buildCardFromOpts();
      const r = await api('POST', `/api/join?${qs({ room: ROOM })}`, { name: NAME, role: ROLE || undefined, status: opts.status, card }, await writerHeaders());
      checkWriter(r, r.id);
      saveCursor(r.cursor);
      console.log(`已以 ${identityLabel(r.id, r.verified)}${r.name} 加入 #${r.room}${r.paused ? ' [已暂停]' : ''}，在线: ${r.agents.filter(a => a.online).map(a => a.name).join(', ')}`);
      if (r.artifacts?.length) {
        console.log(`共享契约 (${r.artifacts.length}): ${r.artifacts.map(a => `${a.name}@v${a.version}`).join(', ')}`);
      }
      r.recent.forEach(m => console.log(line(m)));
      break;
    }
    case 'heartbeat': {
      const r = await api('POST', `/api/heartbeat?${qs({ room: ROOM })}`, { name: NAME, role: ROLE || undefined, status: opts.status || 'online' }, await writerHeaders());
      checkWriter(r.agent, r.agent.id);
      console.log(`ok heartbeat #${ROOM} lastSeq=${r.lastSeq}`);
      break;
    }
    case 'leave': {
      const r = await api('POST', `/api/leave?${qs({ room: ROOM })}`, { name: NAME }, await writerHeaders());
      console.log(r.ok ? `已离开 #${ROOM}` : `当前不在 #${ROOM}`);
      break;
    }
    case 'card': {
      const card = buildCardFromOpts();
      if (!card) {
        const r = await api('GET', `/api/agents?${qs({ room: ROOM })}`);
        for (const a of r.agents) {
          console.log(`${a.online ? '●' : '○'} ${identityLabel(a.id, a.verified)}${a.name} (${a.role})`);
          if (a.card) console.log(`  名片: ${JSON.stringify(a.card)}`);
        }
        break;
      }
      const r = await api('PUT', `/api/agents/card?${qs({ room: ROOM })}`, { name: NAME, role: ROLE || undefined, card }, await writerHeaders());
      checkWriter(r.agent, r.agent.id);
      console.log(`已更新 #${ROOM} 名片: ${JSON.stringify(r.agent.card || null)}`);
      break;
    }
    case 'send': {
      const text = rest.join(' ') || (!process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : '');
      if (!text.trim()) throw new Error('缺少消息内容');
      const m = await api(
        'POST',
        `/api/messages?${qs({ room: ROOM })}`,
        {
          name: NAME,
          role: ROLE || undefined,
          text,
          kind: opts.kind,
          to: opts.to,
          replyTo: opts.reply,
          overridePause: opts['override-pause'] ? true : undefined,
        },
        await writerHeaders(),
      );
      checkWriter(m, m.agentId);
      console.log(`ok #${m.seq}`);
      break;
    }
    case 'read': {
      await resolveBaseUrl();
      const since = opts.since ?? (opts.all ? undefined : readCursor() ?? undefined);
      const r = await api('GET', `/api/messages?${qs({ room: ROOM, ...reader, since, limit: opts.limit, mention: opts.mention, kind: opts.kind, exclude_self: opts.self ? undefined : 1 })}`);
      r.messages.forEach(m => console.log(line(m)));
      saveCursor(r.cursor);
      if (!r.messages.length) console.log('(没有新消息)');
      break;
    }
    case 'wait':
    case 'watch': {
      await resolveBaseUrl();
      const stopHeartbeat = await startVerifiedHeartbeat();
      let retryMs = 1000;
      try {
        let since = opts.since !== undefined ? Number(opts.since) : readCursor();
        if (since === null) since = (await api('GET', `/api/messages?${qs({ room: ROOM, limit: 1 })}`)).cursor;
        for (;;) {
          try {
            const r = await api('GET', `/api/messages?${qs({ room: ROOM, ...reader, since, wait: 30, mention: opts.mention, kind: opts.kind, exclude_self: opts.self ? undefined : 1 })}`);
            retryMs = 1000;
            r.messages.forEach(m => console.log(line(m)));
            since = r.cursor;
            saveCursor(since);
            if (cmd === 'wait' && r.messages.length) break;
          } catch (error) {
            if (cmd === 'wait') throw error;
            console.error(`监听中断，${Math.round(retryMs / 1000)}s 后重连: ${error.message}`);
            await sleep(retryMs);
            retryMs = Math.min(retryMs * 2, 10_000);
          }
        }
      } finally {
        stopHeartbeat();
      }
      break;
    }
    case 'rooms': {
      const r = await api('GET', '/api/rooms');
      r.rooms.forEach(x => console.log(`#${x.id}  ${x.name}${x.paused ? ' [已暂停]' : ''}  消息:${x.messageCount}  契约:${x.artifactCount || 0}  在线:${x.online}${x.topic ? `  — ${x.topic}` : ''}`));
      break;
    }
    case 'who': {
      const r = await api('GET', `/api/agents?${qs({ room: ROOM })}`);
      r.agents.forEach(a => {
        const cardBrief = a.card?.project ? ` [${a.card.project}${a.card.branch ? `@${a.card.branch}` : ''}${a.card.owner ? ` · ${a.card.owner}` : ''}]` : '';
        console.log(`${a.online ? '●' : '○'} ${identityLabel(a.id, a.verified)}${a.name} (${a.role})${cardBrief}`);
        if (a.card?.localEndpoint || a.card?.summary) {
          console.log(`    ${[a.card.stack, a.card.localEndpoint, a.card.summary].filter(Boolean).join(' | ')}`);
        }
      });
      break;
    }
    case 'create': {
      const r = await api('POST', '/api/rooms', { name: rest[0], topic: rest.slice(1).join(' ') || undefined });
      console.log(`#${r.id} ${r.existed ? '已存在' : '已创建'}`);
      break;
    }
    case 'pause':
    case 'resume': {
      const paused = cmd === 'pause';
      const r = await api('PATCH', `/api/rooms/${encodeURIComponent(ROOM)}`, {
        paused,
        pausedReason: paused ? (rest.join(' ') || opts.reason || '') : '',
        pausedBy: NAME,
      });
      console.log(r.paused ? `已暂停 #${r.id} Agent 发言${r.pausedReason ? `：${r.pausedReason}` : ''}` : `已恢复 #${r.id} 对话`);
      break;
    }
    case 'artifacts': {
      const r = await api('GET', `/api/rooms/${encodeURIComponent(ROOM)}/artifacts`);
      if (!r.artifacts.length) console.log('(暂无共享契约)');
      r.artifacts.forEach(a => console.log(`${a.name}  v${a.version}  (${a.size}B)  更新:${a.updatedBy}  ${a.summary || a.title}`));
      break;
    }
    case 'artifact-get': {
      const name = rest[0];
      if (!name) throw new Error('请指定契约文件名');
      const verPath = opts.version ? `/versions/${Number(opts.version)}` : '';
      const r = await api('GET', `/api/rooms/${encodeURIComponent(ROOM)}/artifacts/${encodeURIComponent(name)}${verPath}${opts.raw ? '?format=raw' : ''}`);
      if (opts.raw) process.stdout.write(String(r));
      else if (opts.json) console.log(JSON.stringify(r.artifact || r.revision, null, 2));
      else {
        const a = r.artifact || r.revision;
        console.log(`# ${name} (v${a.version}, by ${a.updatedBy})\n${a.content}`);
      }
      break;
    }
    case 'artifact-diff': {
      const name = rest[0];
      if (!name) throw new Error('请指定契约文件名');
      const query = qs({ from: opts.from, to: opts.to, format: opts.json ? undefined : 'text' });
      const r = await api('GET', `/api/rooms/${encodeURIComponent(ROOM)}/artifacts/${encodeURIComponent(name)}/diff${query ? `?${query}` : ''}`);
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else process.stdout.write(String(r));
      break;
    }
    case 'artifact-put': {
      const name = rest[0];
      if (!name) throw new Error('请指定契约文件名');
      const content = opts.file
        ? fs.readFileSync(opts.file, 'utf8')
        : (rest.slice(1).join(' ') || (!process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : ''));
      if (!content) throw new Error('请通过 --file、参数或标准输入提供契约内容');
      const body = {
        name: NAME,
        role: ROLE || undefined,
        content,
        title: opts.title,
        summary: opts.summary,
        contentType: opts['content-type'],
        expectedVersion: opts.version !== undefined ? Number(opts.version) : undefined,
        announce: opts['announce-message'] ? 'message' : undefined,
      };
      const r = await api('PUT', `/api/rooms/${encodeURIComponent(ROOM)}/artifacts/${encodeURIComponent(name)}`, body, await writerHeaders());
      checkWriter(r.artifact, r.artifact.updatedById);
      console.log(`ok ${r.artifact.name} v${r.artifact.version}`);
      break;
    }
    case 'artifact-rm': {
      const name = rest[0];
      if (!name) throw new Error('请指定契约文件名');
      await api('DELETE', `/api/rooms/${encodeURIComponent(ROOM)}/artifacts/${encodeURIComponent(name)}`, { name: NAME }, await writerHeaders());
      console.log(`已删除契约 ${name}`);
      break;
    }
    case 'export': {
      const format = (opts.format || 'zip').toLowerCase();
      const query = qs({ format, include_debug: opts['include-debug'] ? 1 : undefined });
      const route = `/api/rooms/${encodeURIComponent(ROOM)}/export?${query}`;
      if (format === 'zip') {
        const buf = await apiBuffer(route);
        const outPath = opts.out || `${ROOM}-sync.zip`;
        fs.writeFileSync(outPath, buf);
        console.log(`已导出契约纪要包: ${outPath} (${buf.length} bytes)`);
      } else {
        const res = await api('GET', route);
        const text = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
        if (opts.out) {
          fs.writeFileSync(opts.out, text, 'utf8');
          console.log(`已导出: ${opts.out}`);
        } else {
          process.stdout.write(text);
        }
      }
      break;
    }
    case 'openapi-diff': {
      const base = parseOpenApiArg(opts.base || rest[0]);
      const target = parseOpenApiArg(opts.target || rest[1]);
      const needsWrite = Boolean(opts.save || opts.propose);
      const r = await api(
        'POST',
        `/api/rooms/${encodeURIComponent(ROOM)}/openapi/diff`,
        {
          name: NAME,
          role: ROLE || undefined,
          base,
          target,
          saveArtifact: opts.save || undefined,
          postAsProposal: opts.propose ? true : undefined,
          to: opts.to,
        },
        needsWrite ? await writerHeaders() : undefined,
      );
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(r.markdown);
        if (r.savedArtifact) console.log(`已保存比对报告到共享契约: ${r.savedArtifact.name} v${r.savedArtifact.version}`);
        if (r.proposalMessage) console.log(`已自动发起变更提案: #${r.proposalMessage.seq}`);
      }
      break;
    }
    case 'decide': {
      const seq = Number(rest[0]);
      const decision = rest[1];
      const comment = rest.slice(2).join(' ') || opts.comment || '';
      if (!seq || !decision) throw new Error('用法: node client.js decide <序号> <approved|rejected|changes_requested> [说明]');
      const r = await api('POST', `/api/rooms/${encodeURIComponent(ROOM)}/proposals/${seq}/decision`, {
        name: NAME,
        role: ROLE || 'Human',
        decision,
        comment,
        announce: opts['no-announce'] ? false : true,
      }, await writerHeaders());
      console.log(`ok proposal #${seq} -> ${r.message.proposal.status}`);
      break;
    }
    default:
      console.log(`Agent Relay CLI v2.2
  node client.js discover [--timeout 1500] 局域网自动发现 Agent Relay 服务（也可设置 --url auto）
  node client.js register --name <名字>    创建登记身份（仅此时输出密钥，请私下保存）
  node client.js join [--project P ...]   加入房间（可附带项目名片）并显示最近消息
  node client.js card [--project P --owner O --stack S --branch B --endpoint URL --api-doc URL --summary 简介]
  node client.js send <文本> [--to 名字] [--kind message|question|proposal|task|result|debug] [--reply 序号]
  node client.js read [--since N] [--all] [--mention 名字] [--kind 类型]
  node client.js wait [--mention 名字]     阻塞等待新消息（已验证身份自动保活心跳）
  node client.js watch [--mention 名字]    持续监听（断线自动重连）
  node client.js heartbeat | leave
  node client.js rooms | who | create <房间名> [主题]
  node client.js pause [原因] | resume     暂停 / 恢复房间内 Agent 发言
  node client.js artifacts                 列出房间共享契约/产物
  node client.js artifact-get <文件名> [--version N] [--raw]
  node client.js artifact-diff <文件名> [--from 1] [--to 2]
  node client.js artifact-put <文件名> --file <路径> [--summary 变更说明] [--version 期望版本]
  node client.js artifact-rm <文件名>
  node client.js export [--format zip|md|json] [--out 路径] [--include-debug]
  node client.js openapi-diff --base <文件|URL|artifact:名[@v]|agent:名> --target <同左> [--save diff.md] [--propose]
  node client.js decide <提案序号> <approved|rejected|changes_requested> [审批意见]
通用参数: --url (支持 auto 自动发现) --room --name --role --token --agent-id（可用 -- 结束参数解析）
环境变量: RELAY_URL RELAY_ROOM RELAY_NAME RELAY_ROLE RELAY_TOKEN
项目名片: RELAY_PROJECT RELAY_OWNER RELAY_STACK RELAY_BRANCH RELAY_ENDPOINT RELAY_API_DOC RELAY_SUMMARY
登记身份: RELAY_AGENT_ID 和 RELAY_AGENT_KEY（密钥请仅用环境变量，不要放在命令参数中）`);
  }
}
main().catch(e => { console.error(`错误: ${e.message}`); process.exit(1); });
