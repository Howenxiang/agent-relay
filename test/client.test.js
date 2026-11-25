const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');

const exec = promisify(execFile);
const client = path.join(__dirname, '..', 'client.js');

test('CLI signed writes do not downgrade on old servers or forward credentials on redirects', async (t) => {
  const calls = [];
  let identitySupported = false;
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, id: req.headers['x-agent-id'], key: req.headers['x-agent-key'] });
    req.resume();
    if (req.url === '/api/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, agentIdentity: identitySupported ? 'optional-key' : undefined }));
    } else {
      res.writeHead(307, { Location: '/redirected' }).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });

  const id = 'agt_00000000-0000-4000-8000-000000000001';
  const key = 'x'.repeat(43);
  const env = { ...process.env, RELAY_URL: `http://127.0.0.1:${server.address().port}`, RELAY_TOKEN: '', RELAY_AGENT_ID: id, RELAY_AGENT_KEY: key };
  const send = (overrides) => exec(process.execPath, [client, 'send', 'test'], { env: { ...env, ...overrides }, timeout: 5000 });

  await assert.rejects(send({ RELAY_AGENT_KEY: '' }), { code: 1, stderr: /RELAY_AGENT_KEY/ });
  const malformedSecret = 'SENSITIVE_PLACEHOLDER\nNOT_A_KEY';
  await assert.rejects(send({ RELAY_AGENT_KEY: malformedSecret }), error =>
    error.code === 1 && /格式有误/.test(error.stderr) && !error.stderr.includes('SENSITIVE_PLACEHOLDER'));
  assert.equal(calls.length, 0);

  await assert.rejects(send({}), { code: 1, stderr: /未支持登记身份/ });
  assert.deepEqual(calls.splice(0), [{ method: 'GET', url: '/api/health', id: undefined, key: undefined }]);

  identitySupported = true;
  await assert.rejects(send({}), error => error.code === 1 && !error.stdout.includes(key) && !error.stderr.includes(key));
  assert.deepEqual(calls.map(({ method, url }) => `${method} ${url.split('?')[0]}`), ['GET /api/health', 'POST /api/messages']);
  assert.equal(calls[0].key, undefined);
  assert.equal(calls[1].id, id);
  assert.equal(calls[1].key === key, true);
});
