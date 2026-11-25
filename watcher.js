#!/usr/bin/env node
// Agent Relay 只读值班监听器（Node 18+，零依赖）
// 在后台监听房间里 @本Agent 的消息：
//   - 默认提醒模式：打印收到的提问，方便人类介入
//   - 自动答疑模式：在 `--` 后指定只读处理器命令（不经过 shell 拼接，杜绝命令注入），
//     通过 stdin JSON 传入上下文，将处理器 stdout 自动回复到群里。
// 用法示例：
//   node watcher.js --url http://192.168.1.10:8787 --room order-sync --name order-bot --project mall-order -- node my-readonly-agent.js
const { spawn } = require('child_process');
const os = require('os');
const { discoverRelays } = require('./lib/discovery');

const BOOL_FLAGS = new Set(['include-all', 'no-ignore-acks', 'dry-run', 'once', 'help']);
const rawArgs = process.argv.slice(2);
const sepIdx = rawArgs.indexOf('--');
const flagArgs = sepIdx === -1 ? rawArgs : rawArgs.slice(0, sepIdx);
const execCmd = sepIdx === -1 ? [] : rawArgs.slice(sepIdx + 1);

const opts = {};
for (let i = 0; i < flagArgs.length; i++) {
  const a = flagArgs[i];
  if (a.startsWith('--') && a.length > 2) {
    const eq = a.indexOf('=');
    if (eq !== -1) opts[a.slice(2, eq)] = a.slice(eq + 1);
    else {
      const k = a.slice(2);
      if (BOOL_FLAGS.has(k)) opts[k] = true;
      else if (i + 1 < flagArgs.length && !flagArgs[i + 1].startsWith('--')) opts[k] = flagArgs[++i];
      else opts[k] = true;
    }
  }
}

if (opts.help) {
  console.log(`Agent Relay 只读值班监听器 v2.1
用法:
  node watcher.js [选项] [-- <可执行程序> [参数...]]

常用选项:
  --url <URL>                Relay 服务地址（或 RELAY_URL，默认 http://localhost:8787）
  --room <房间>              监听房间（或 RELAY_ROOM，默认 general）
  --name <名字>              本机值班 Agent 名字（或 RELAY_NAME）
  --role <角色>              角色名（默认 OnCall-Agent）
  --mention <目标>           监听的点名目标（逗号分隔，默认自动匹配 agentId 与 name）
  --include-all              同时响应 @all（默认仅响应直接点名，避免多值班 Agent 广播风暴）
  --no-ignore-acks           不跳过“收到/谢谢/ok”等纯确认消息
  --max-replies-per-min <N>  每分钟最多自动回复条数（默认 6，防死循环）
  --cooldown-ms <MS>         每次回复后的最小冷却毫秒数（默认 2000）
  --exec-timeout <MS>        单次处理器超时毫秒数（默认 60000）
  --once                     处理完首条有效点名后退出（适合测试或单次任务）
  --dry-run                  仅打印处理结果，不真正回发消息
项目名片选项:
  --project --owner --stack --branch --endpoint --api-doc --summary

处理器协议（使用 -- <命令> 时）:
  - watcher 会以 shell:false 启动命令，通过 stdin 传入 JSON：
    { "room", "message", "recent", "artifacts" }
  - 命令向 stdout 输出的非空文本将作为回复自动发回房间（带 replyTo）。
  - 返回空输出表示无需回复。`);
  process.exit(0);
}

let BASE = (opts.url || process.env.RELAY_URL || 'http://localhost:8787').replace(/\/+$/, '');
const ROOM = opts.room || process.env.RELAY_ROOM || 'general';
const NAME = opts.name || process.env.RELAY_NAME || `${os.hostname()}-oncall`;
const ROLE = opts.role || process.env.RELAY_ROLE || 'OnCall-Agent';
const TOKEN = opts.token || process.env.RELAY_TOKEN || '';
const AGENT_ID = opts['agent-id'] || process.env.RELAY_AGENT_ID || '';
const AGENT_KEY = process.env.RELAY_AGENT_KEY || '';
const INCLUDE_ALL = Boolean(opts['include-all']);
const IGNORE_ACKS = !opts['no-ignore-acks'];
const MAX_REPLIES_PER_MIN = Math.max(1, Number(opts['max-replies-per-min']) || 6);
const COOLDOWN_MS = Math.max(0, Number(opts['cooldown-ms'] ?? 2000));
const EXEC_TIMEOUT = Math.max(1000, Number(opts['exec-timeout']) || 60_000);
const DRY_RUN = Boolean(opts['dry-run']);
const ONCE = Boolean(opts.once);

const ACK_WORD = '(?:收到|好的|好哒|明白|了解|谢谢|感谢|辛苦了|不客气|没问题|知道了|可以|行|ok|okay|got\\s+it|thanks|thank\\s+you|thx|noted|lgtm|roger|ack|👍|👌)';
const ACK_PATTERN = new RegExp(`^(?:@[\\p{L}\\p{N}_.-]+\\s*)*${ACK_WORD}(?:[\\s,，、.!！。~～]*${ACK_WORD})*[\\s!！。.？?~～]*$`, 'iu');

const baseHeaders = {
  'Content-Type': 'application/json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function api(method, route, body, agentHeaders) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...baseHeaders, ...agentHeaders },
    redirect: 'error',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${typeof parsed === 'object' && parsed?.error ? parsed.error : text}`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}

let cachedWriterHeaders;
async function getWriterHeaders() {
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

function buildCard() {
  const card = {};
  const map = {
    project: opts.project || process.env.RELAY_PROJECT,
    owner: opts.owner || process.env.RELAY_OWNER,
    stack: opts.stack || process.env.RELAY_STACK,
    repo: opts.repo || process.env.RELAY_REPO,
    branch: opts.branch || process.env.RELAY_BRANCH,
    localEndpoint: opts.endpoint || process.env.RELAY_ENDPOINT,
    apiDoc: opts['api-doc'] || process.env.RELAY_API_DOC,
    summary: opts.summary || process.env.RELAY_SUMMARY,
    capabilities: opts.capabilities || process.env.RELAY_CAPABILITIES || ['on-call', 'read-only'],
  };
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined && v !== '') card[k] = v;
  }
  return Object.keys(card).length ? card : undefined;
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const mentionTargets = (opts.mention || (AGENT_ID ? `${AGENT_ID},${NAME}` : NAME))
  .split(',')
  .map(s => s.trim().replace(/^@/, '').toLowerCase())
  .filter(Boolean);

function shouldRespond(msg) {
  if (msg.kind === 'debug' || msg.kind === 'decision') return false;
  if (IGNORE_ACKS && ACK_PATTERN.test(String(msg.text || '').trim())) return false;
  const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
  const direct = mentionTargets.some(t => mentions.includes(t));
  if (direct) return true;
  if (INCLUDE_ALL && (mentions.includes('all') || mentions.includes('所有人') || mentions.includes('everyone'))) return true;
  return false;
}

function runHandler(payload) {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = execCmd;
    const child = spawn(bin, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        RELAY_MSG_SEQ: String(payload.message.seq),
        RELAY_MSG_ROOM: String(payload.room),
        RELAY_MSG_FROM: String(payload.message.agent),
        RELAY_MSG_KIND: String(payload.message.kind || 'message'),
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`handler timed out after ${EXEC_TIMEOUT}ms`));
    }, EXEC_TIMEOUT);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(0, 20000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 4000); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`handler exited with code ${code}: ${stderr.trim()}`));
      resolve(stdout.trim());
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function main() {
  if (BASE.toLowerCase() === 'auto') {
    const found = await discoverRelays({ timeoutMs: 1500 });
    if (!found.length) throw new Error('局域网内未自动发现 Agent Relay 服务，请指定 --url');
    BASE = found[0].url.replace(/\/+$/, '');
    console.error(`[watcher] 自动发现局域网 Relay 服务: ${BASE}`);
  }
  const wh = await getWriterHeaders();
  const card = buildCard();
  const joined = await api('POST', `/api/join?${qs({ room: ROOM })}`, {
    name: NAME,
    role: ROLE,
    status: execCmd.length ? 'on-call (auto-readonly)' : 'on-call (notify)',
    card,
  }, wh);
  let since = opts.since !== undefined ? Number(opts.since) : joined.cursor;
  console.error(`[watcher] 已值班 #${joined.room}，身份: ${joined.name}${joined.verified ? ` (${joined.id})` : ''}，监听目标: ${mentionTargets.join(', ')}，游标: #${since}`);

  let hbTimer = null;
  if (AGENT_ID && AGENT_KEY) {
    hbTimer = setInterval(() => {
      api('POST', `/api/heartbeat?${qs({ room: ROOM })}`, { status: execCmd.length ? 'on-call (auto-readonly)' : 'on-call (notify)' }, wh).catch(() => {});
    }, 45_000);
    hbTimer.unref();
  }

  const replyTimestamps = [];
  let lastReplyAt = 0;
  let retryMs = 1000;
  const reader = AGENT_ID ? { self_id: AGENT_ID } : { name: NAME };

  try {
    for (;;) {
      let res;
      try {
        res = await api('GET', `/api/messages?${qs({
          room: ROOM,
          ...reader,
          since,
          wait: 30,
          mention: mentionTargets.join(','),
          exclude_self: 1,
        })}`);
        retryMs = 1000;
      } catch (error) {
        console.error(`[watcher] 拉取失败，${Math.round(retryMs / 1000)}s 后重试: ${error.message}`);
        await sleep(retryMs);
        retryMs = Math.min(retryMs * 2, 10_000);
        continue;
      }

      since = res.cursor;
      for (const msg of res.messages) {
        if (!shouldRespond(msg)) continue;
        console.log(`[MENTION #${msg.seq}] ${msg.agent}: ${msg.text}`);
        if (!execCmd.length) {
          if (ONCE) return;
          continue;
        }
        if (res.paused) {
          console.error(`[watcher] 房间 #${ROOM} 当前已暂停，跳过自动回复 #${msg.seq}`);
          continue;
        }
        const nowMs = Date.now();
        while (replyTimestamps.length && replyTimestamps[0] < nowMs - 60_000) replyTimestamps.shift();
        if (replyTimestamps.length >= MAX_REPLIES_PER_MIN) {
          console.error(`[watcher] 已达每分钟自动回复上限 (${MAX_REPLIES_PER_MIN})，跳过 #${msg.seq} 防止循环`);
          continue;
        }
        if (nowMs - lastReplyAt < COOLDOWN_MS) await sleep(COOLDOWN_MS - (nowMs - lastReplyAt));

        try {
          const [recentRes, artifactsRes] = await Promise.all([
            api('GET', `/api/messages?${qs({ room: ROOM, limit: 15 })}`),
            api('GET', `/api/rooms/${encodeURIComponent(ROOM)}/artifacts`),
          ]);
          const replyText = await runHandler({
            room: ROOM,
            message: msg,
            recent: recentRes.messages,
            artifacts: artifactsRes.artifacts,
          });
          if (!replyText) {
            console.error(`[watcher] 处理器对 #${msg.seq} 返回空输出，不发消息`);
            if (ONCE) return;
            continue;
          }
          if (DRY_RUN) {
            console.log(`[DRY-RUN REPLY -> #${msg.seq}] ${replyText}`);
          } else {
            const sent = await api('POST', `/api/messages?${qs({ room: ROOM })}`, {
              name: NAME,
              role: ROLE,
              text: replyText,
              kind: 'message',
              replyTo: msg.seq,
            }, wh);
            replyTimestamps.push(Date.now());
            lastReplyAt = Date.now();
            console.error(`[watcher] 已回复 #${msg.seq} -> #${sent.seq}`);
          }
          if (ONCE) return;
        } catch (error) {
          console.error(`[watcher] 处理 #${msg.seq} 失败: ${error.message}`);
          if (ONCE) throw error;
        }
      }
    }
  } finally {
    if (hbTimer) clearInterval(hbTimer);
  }
}

main().catch(error => {
  console.error(`[watcher] 错误: ${error.message}`);
  process.exit(1);
});
