// Test only a disposable copy; never read the user's config or CLI history.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

async function sandbox(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'openclaude-ui-test-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      // The guarantee is that the child closes. taskkill's exit code is not a reliable
      // signal: it returns non-zero when the process exited between the check and the
      // call (seen on GitHub Actions runners), so wait for 'close' and bound that wait.
      const closed = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : once(child, 'close');
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else child.kill('SIGTERM');
      await Promise.race([
        closed,
        delay(5000).then(() => { throw new Error('test server process tree must stop'); })
      ]);
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const source = path.resolve(__dirname, '../..');
  fs.copyFileSync(path.join(source, 'server.js'), path.join(root, 'server.js'));
  fs.cpSync(path.join(source, 'public'), path.join(root, 'public'), { recursive: true });
  for (const name of ['mock-openclaude.js', 'mock-openclaude.cmd']) {
    fs.copyFileSync(path.join(source, 'test', name), path.join(root, name));
  }
  const workspace = path.join(root, 'workspace with spaces');
  const sessionsDir = path.join(root, 'sessions');
  const tmp = path.join(root, 'tmp');
  for (const dir of [workspace, sessionsDir, tmp]) fs.mkdirSync(dir);
  // shortcut: Windows is the supported test target; add a POSIX launcher before testing other OSes.
  assert.equal(process.platform, 'win32', 'these integration tests target Windows');
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(err => err ? reject(err) : resolve()));
  const config = { port, openBrowser: false, openclaudeCmd: path.join(root, 'mock-openclaude.cmd'),
    workspace, sessionsDir, env: {}, sessions: {}, permissionMode: 'default' };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  child = spawn(process.execPath, ['server.js'], {
    cwd: root, windowsHide: true,
    env: { ...process.env, OPEN_BROWSER: '0', TMPDIR: tmp, TEMP: tmp, TMP: tmp }
  });
  let log = '', spawnError;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  child.on('error', err => { spawnError = err; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (spawnError) throw spawnError;
    assert.ok(!log.includes('OpenClaude UI уже запущен:'), 'port collision: ' + log);
    assert.equal(child.exitCode, null, 'server exited: ' + log);
    assert.equal(child.signalCode, null, 'server stopped: ' + log);
    // Only the complete successful-bind line proves this child owns the port.
    if (log.split(/\r?\n/).slice(0, -1).includes('  OpenClaude UI запущен: ' + base)) break;
    assert.ok(i < 100, 'server did not start: ' + log);
    await delay(50);
  }
  async function request(route, options = {}) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, 'test server exited');
    assert.equal(child.signalCode, null, 'test server stopped');
    return fetch(base + route, { ...options, signal: AbortSignal.timeout(10000) });
  }
  async function post(route, body) {
    return request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  return { root, workspace, sessionsDir, base, request, post };
}

async function events(app, runId, from = 0) {
  const response = await app.request(`/api/run/${runId}/stream?from=${from}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  return (await response.text()).split('\n').filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
}

module.exports = { sandbox, events };
