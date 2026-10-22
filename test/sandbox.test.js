'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

// Keep the colliding process alive: rejection must not depend on its exit timing.
test('sandbox rejects an already-running notice without sending API requests', { timeout: 10000 }, async t => {
  const spawn = childProcess.spawn;
  let requestsFile;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    requestsFile = path.join(options.cwd, 'foreign-requests.json');
    fs.writeFileSync(requestsFile, '[]');
    return spawn(command, ['-e', `
      const fs = require('node:fs');
      const http = require('node:http');
      const { port } = require('./config.json');
      const requests = [];
      http.createServer((req, res) => {
        requests.push(req.method + ' ' + req.url);
        fs.writeFileSync('foreign-requests.json', JSON.stringify(requests));
        res.end('{}');
      }).listen(port, '127.0.0.1', () => {
        console.log('OpenClaude UI уже запущен: http://127.0.0.1:' + port);
      });
    `], options);
  });
  // sandbox captures spawn on import; do not change its public API for this test.
  delete require.cache[require.resolve('./helpers/sandbox')];
  const { sandbox } = require('./helpers/sandbox');
  try {
    await assert.rejects(async () => {
      const app = await sandbox(t);
      await app.post('/api/settings', { model: 'must-not-reach-foreign-server' });
    }, /already running|уже запущен/);
  } finally {
    assert.deepEqual(JSON.parse(fs.readFileSync(requestsFile, 'utf8')), [], 'no API request may reach the foreign server');
    delete require.cache[require.resolve('./helpers/sandbox')];
  }
});

test('sandbox rejects a child that exits before binding', { timeout: 10000 }, async t => {
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (command, args, options) =>
    spawn(command, ['-e', 'process.exit(7)'], options));
  delete require.cache[require.resolve('./helpers/sandbox')];
  const { sandbox } = require('./helpers/sandbox');
  try {
    await assert.rejects(sandbox(t), /server exited/);
  } finally {
    delete require.cache[require.resolve('./helpers/sandbox')];
  }
});
