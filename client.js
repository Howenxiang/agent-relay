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
const cursorFile = path.join(os.tmpdir(), `agent-relay-cursor-${encodeURIComponent(BASE)}-${ROOM}-${NAME}.txt`.replace(/[:%]/g, '_'));

const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();
const readCursor = () => { try { return Number(fs.readFileSync(cursorFile, 'utf8')) || 0; } catch { return null; } };
const saveCursor = (c) => fs.writeFileSync(cursorFile, String(c));
const line = (m) => `[#${m.seq} ${new Date(m.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${m.agent}${m.kind !== 'message' ? ` <${m.kind}>` : ''}: ${m.text}`;

async function main() {
  switch (cmd) {
    case 'join': {
      const r = await api('POST', `/api/join?${qs({ room: ROOM })}`, { name: NAME, role: ROLE || undefined });
      saveCursor(r.cursor);
      console.log(`已以 ${r.name} 加入 #${r.room}，在线: ${r.agents.filter(a => a.online).map(a => a.name).join(', ')}`);
      r.recent.forEach(m => console.log(line(m)));
      break;
    }
    case 'send': {
      const text = rest.join(' ') || (!process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : '');
      if (!text.trim()) throw new Error('缺少消息内容');
      const m = await api('POST', `/api/messages?${qs({ room: ROOM })}`, { name: NAME, role: ROLE || undefined, text, kind: opts.kind, to: opts.to, replyTo: opts.reply });
      console.log(`ok #${m.seq}`);
      break;
    }
    case 'read': {
      const since = opts.since ?? (opts.all ? undefined : readCursor() ?? undefined);
      const r = await api('GET', `/api/messages?${qs({ room: ROOM, name: NAME, since, limit: opts.limit, mention: opts.mention, exclude_self: opts.self ? undefined : 1 })}`);
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
        const r = await api('GET', `/api/messages?${qs({ room: ROOM, name: NAME, since, wait: 30, mention: opts.mention, exclude_self: 1 })}`);
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
      r.agents.forEach(a => console.log(`${a.online ? '●' : '○'} ${a.name} (${a.role})`));
      break;
    }
    case 'create': {
      const r = await api('POST', '/api/rooms', { name: rest[0], topic: rest.slice(1).join(' ') || undefined });
      console.log(`#${r.id} ${r.existed ? '已存在' : '已创建'}`);
      break;
    }
    default:
      console.log(`Agent Relay CLI
  node client.js join                     加入房间并显示最近消息
  node client.js send <文本> [--to 名字] [--kind debug] [--reply 序号]
  node client.js read [--since N] [--all] [--mention 名字]   读取新消息（自动记录游标）
  node client.js wait [--mention 名字]     阻塞等待新消息，收到后退出
  node client.js watch                    持续监听
  node client.js rooms | who | create <房间名> [主题]
通用参数: --url --room --name --role --token
环境变量: RELAY_URL RELAY_ROOM RELAY_NAME RELAY_ROLE RELAY_TOKEN`);
  }
}
main().catch(e => { console.error(`错误: ${e.message}`); process.exit(1); });
