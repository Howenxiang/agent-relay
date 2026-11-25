#!/usr/bin/env node
// Agent Relay 零依赖命令行客户端（Node 18+）
// 用法见 node client.js help
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const cmd = args.shift() || 'help';
const opts = {};
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); opts[k] = v !== undefined ? v : (args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true'); }
  else rest.push(a);
}

const BASE = (opts.url || process.env.RELAY_URL || 'http://localhost:8787').replace(/\/+$/, '');
const ROOM = opts.room || process.env.RELAY_ROOM || 'general';
const NAME = opts.name || process.env.RELAY_NAME || `${os.hostname()}-agent`;
const ROLE = opts.role || process.env.RELAY_ROLE || '';
const TOKEN = opts.token || process.env.RELAY_TOKEN || '';
const AGENT_ID = opts['agent-id'] || process.env.RELAY_AGENT_ID || '';
const AGENT_KEY = process.env.RELAY_AGENT_KEY || '';
const cursorName = AGENT_ID ? `agent-relay-verified-cursor-${encodeURIComponent(BASE)}-${encodeURIComponent(ROOM)}-${encodeURIComponent(AGENT_ID)}` : `agent-relay-cursor-${encodeURIComponent(BASE)}-${ROOM}-${NAME}`;
const cursorFile = path.join(os.tmpdir(), `${cursorName}.txt`.replace(/[:%]/g, '_'));

const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
async function api(method, p, body, agentHeaders) {
  let res, text;
  try {
    res = await fetch(`${BASE}${p}`, {
      method, headers: { ...headers, ...agentHeaders }, redirect: 'error', body: body ? JSON.stringify(body) : undefined
    });
    text = await res.text();
  } catch (error) {
    if (agentHeaders || TOKEN) throw new Error('无法完成带凭据的请求，请检查连接和服务地址');
    throw error;
  }
  if (!res.ok) throw new Error(`${res.status} ${agentHeaders || TOKEN ? '请求失败，请检查服务状态和凭据' : text}`);
  try { return JSON.parse(text); } catch { return text; }
}
async function writerHeaders() {
  if (!AGENT_ID && !AGENT_KEY) return undefined;
  if (!AGENT_ID || !AGENT_KEY) throw new Error('登记身份需要同时设置 RELAY_AGENT_ID 和 RELAY_AGENT_KEY');
  if (!/^agt_[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(AGENT_ID) || !/^[A-Za-z0-9_-]{43}$/.test(AGENT_KEY)) {
    throw new Error('Agent ID 或密钥格式有误；未发送请求');
  }
  const health = await api('GET', '/api/health');
  if (health?.agentIdentity !== 'optional-key') throw new Error('该服务器未支持登记身份；未发送请求');
  return { 'X-Agent-Id': AGENT_ID, 'X-Agent-Key': AGENT_KEY };
}
function checkWriter(result, id) {
  if (AGENT_ID && (result.verified !== true || id !== AGENT_ID)) throw new Error('服务端未返回匹配的登记身份');
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();
const reader = AGENT_ID ? { self_id: AGENT_ID } : { name: NAME };
const readCursor = () => { try { return Number(fs.readFileSync(cursorFile, 'utf8')) || 0; } catch { return null; } };
const saveCursor = (c) => fs.writeFileSync(cursorFile, String(c));
const identityLabel = (id, verified) => verified ? `[已验证 ${id}] ` : '';
const line = (m) => `[#${m.seq} ${new Date(m.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${identityLabel(m.agentId, m.verified)}${m.agent}${m.kind !== 'message' ? ` <${m.kind}>` : ''}: ${m.text}`;

async function main() {
  switch (cmd) {
    case 'register': {
      const r = await api('POST', '/api/agents/register', { name: NAME, role: ROLE || undefined });
      if (!r?.agentId || !r.agentKey || r.verified !== true) throw new Error('服务端未返回登记身份');
      console.log(JSON.stringify(r));
      break;
    }
    case 'join': {
      const r = await api('POST', `/api/join?${qs({ room: ROOM })}`, { name: NAME, role: ROLE || undefined }, await writerHeaders());
      checkWriter(r, r.id);
      saveCursor(r.cursor);
      console.log(`已以 ${identityLabel(r.id, r.verified)}${r.name} 加入 #${r.room}，在线: ${r.agents.filter(a => a.online).map(a => a.name).join(', ')}`);
      r.recent.forEach(m => console.log(line(m)));
      break;
    }
    case 'send': {
      const text = rest.join(' ') || (!process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : '');
      if (!text.trim()) throw new Error('缺少消息内容');
      const m = await api('POST', `/api/messages?${qs({ room: ROOM })}`, { name: NAME, role: ROLE || undefined, text, kind: opts.kind, to: opts.to, replyTo: opts.reply }, await writerHeaders());
      checkWriter(m, m.agentId);
      console.log(`ok #${m.seq}`);
      break;
    }
    case 'read': {
      const since = opts.since ?? (opts.all ? undefined : readCursor() ?? undefined);
      const r = await api('GET', `/api/messages?${qs({ room: ROOM, ...reader, since, limit: opts.limit, mention: opts.mention, exclude_self: opts.self ? undefined : 1 })}`);
      r.messages.forEach(m => console.log(line(m)));
      saveCursor(r.cursor);
      if (!r.messages.length) console.log('(没有新消息)');
      break;
    }
    case 'wait': // 阻塞直到有新消息（可配合 --mention 只等 @自己 的消息），打印后退出
    case 'watch': { // 持续监听
      let since = opts.since !== undefined ? Number(opts.since) : readCursor();
      if (since === null) since = (await api('GET', `/api/messages?${qs({ room: ROOM, limit: 1 })}`)).cursor;
      for (;;) {
        const r = await api('GET', `/api/messages?${qs({ room: ROOM, ...reader, since, wait: 30, mention: opts.mention, exclude_self: 1 })}`);
        r.messages.forEach(m => console.log(line(m)));
        since = r.cursor; saveCursor(since);
        if (cmd === 'wait' && r.messages.length) break;
      }
      break;
    }
    case 'rooms': {
      const r = await api('GET', '/api/rooms');
      r.rooms.forEach(x => console.log(`#${x.id}  ${x.name}  消息:${x.messageCount}  在线:${x.online}${x.topic ? `  — ${x.topic}` : ''}`));
      break;
    }
    case 'who': {
      const r = await api('GET', `/api/agents?${qs({ room: ROOM })}`);
      r.agents.forEach(a => console.log(`${a.online ? '●' : '○'} ${identityLabel(a.id, a.verified)}${a.name} (${a.role})`));
      break;
    }
    case 'create': {
      const r = await api('POST', '/api/rooms', { name: rest[0], topic: rest.slice(1).join(' ') || undefined });
      console.log(`#${r.id} ${r.existed ? '已存在' : '已创建'}`);
      break;
    }
    default:
      console.log(`Agent Relay CLI
  node client.js register --name <名字>    创建登记身份（仅此时输出密钥，请私下保存）
  node client.js join                     加入房间并显示最近消息
  node client.js send <文本> [--to 名字] [--kind debug] [--reply 序号]
  node client.js read [--since N] [--all] [--mention 名字]   读取新消息（自动记录游标）
  node client.js wait [--mention 名字]     阻塞等待新消息，收到后退出
  node client.js watch                    持续监听
  node client.js rooms | who | create <房间名> [主题]
通用参数: --url --room --name --role --token --agent-id
环境变量: RELAY_URL RELAY_ROOM RELAY_NAME RELAY_ROLE RELAY_TOKEN
登记身份: RELAY_AGENT_ID 和 RELAY_AGENT_KEY（密钥请仅用环境变量，不要放在命令参数中）`);
  }
}
main().catch(e => { console.error(`错误: ${e.message}`); process.exit(1); });
