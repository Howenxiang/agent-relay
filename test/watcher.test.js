const assert = require('node:assert/strict');
const { fork, spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const serverFile = path.join(__dirname, '..', 'server.js');
const watcherFile = path.join(__dirname, '..', 'watcher.js');
const deadline = () => AbortSignal.timeout(10_000);
const options = { timeout: 30_000 };

test('watcher ignores acks and @all by default, safely invokes readonly handler via stdin JSON, and replies with replyTo', options, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-watcher-'));
  const handlerScript = path.join(dir, 'handler.js');
  await fs.writeFile(handlerScript, `
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => {
      const payload = JSON.parse(data);
      process.stdout.write('自动只读答复：收到 ' + payload.message.agent + ' 关于 #' + payload.message.seq + ' 的提问，当前契约数=' + payload.artifacts.length);
    });
  `);

  const relay = fork(serverFile, [], {
    execArgv: [],
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', AGENT_RELAY_DATA: dir, AGENT_RELAY_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const relayExited = new Promise(r => relay.once('close', r));
  let watcher;
  t.after(async () => {
    if (watcher && watcher.exitCode === null) watcher.kill();
    if (relay.exitCode === null) relay.kill();
    await relayExited;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const [ready] = await once(relay, 'message', { signal: deadline() });
  const baseUrl = `http://127.0.0.1:${ready.port}`;

  // Seed one room artifact so handler sees it in context
  await fetch(`${baseUrl}/api/rooms/general/artifacts/spec.md`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'seed', content: '# spec' }),
  });

  watcher = spawn(process.execPath, [
    watcherFile,
    '--url', baseUrl,
    '--room', 'general',
    '--name', 'order-oncall',
    '--project', 'mall-order',
    '--cooldown-ms', '0',
    '--once',
    '--',
    process.execPath,
    handlerScript,
  ], {
    env: { ...process.env, RELAY_TOKEN: '', RELAY_AGENT_ID: '', RELAY_AGENT_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let watcherErr = '';
  watcher.stderr.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`watcher did not start: ${watcherErr}`)), 8_000);
    watcher.stderr.on('data', chunk => {
      watcherErr += chunk;
      if (watcherErr.includes('已值班')) { clearTimeout(timer); resolve(); }
    });
    watcher.once('exit', code => { clearTimeout(timer); reject(new Error(`watcher exited early (${code}): ${watcherErr}`)); });
  });

  const post = (body) => fetch(`${baseUrl}/api/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json());

  // 1. @all should be ignored (direct-only by default)
  await post({ name: 'web-agent', text: '@all 大家同步一下进度' });
  // 2. Polite ack directed at watcher should be ignored
  await post({ name: 'web-agent', text: '@order-oncall 收到，谢谢！' });
  // 3. Real direct question triggers handler and posts reply
  const question = await post({ name: 'web-agent', kind: 'question', text: '@order-oncall 退款接口字段有哪些？' });

  const [exitCode] = await once(watcher, 'close', { signal: deadline() });
  assert.equal(exitCode, 0, watcherErr);

  const msgs = (await fetch(`${baseUrl}/api/messages?room=general&limit=20`).then(r => r.json())).messages;
  const replies = msgs.filter(m => m.agent === 'order-oncall');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].replyTo, question.seq);
  assert.match(replies[0].text, /自动只读答复：收到 web-agent/);
  assert.match(replies[0].text, /当前契约数=1/);
});
