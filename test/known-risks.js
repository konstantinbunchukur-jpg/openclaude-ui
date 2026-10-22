// These assertions describe the required safety contract; the unfixed ones FAIL (see docs/REVIEW.md).
// Run separately with npm run test:security. All mutations stay in a disposable copy.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { sandbox, events } = require('./helpers/sandbox');
const options = { timeout: 20000 };

test('P0: rejects cross-origin settings writes', options, async t => {
  const app = await sandbox(t);
  const response = await app.request('/api/settings', {
    method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'text/plain' },
    body: JSON.stringify({ model: 'cross-origin-test' })
  });
  assert.equal(response.status, 403);
});

test('P0: rejects untrusted Host headers (DNS rebinding boundary)', options, async t => {
  const app = await sandbox(t);
  const status = await new Promise((resolve, reject) => {
    http.get(app.base + '/api/state', {
      headers: { Host: 'untrusted.invalid' }, signal: AbortSignal.timeout(10000)
    }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('P0: upload never silently replaces an existing file', options, async t => {
  const app = await sandbox(t);
  const target = path.join(app.workspace, 'keep.txt');
  fs.writeFileSync(target, 'original');
  await app.request('/api/upload?name=keep.txt', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'replacement' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'original');
});

test('P0: directory junction cannot escape the selected workspace', options, async t => {
  const app = await sandbox(t);
  const outside = path.join(app.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'synthetic private data');
  fs.symlinkSync(outside, path.join(app.workspace, 'link'), 'junction');
  const response = await app.request('/api/files?path=link');
  assert.equal(response.status, 400);
});

test('P1: file browsing requires an explicit workspace', options, async t => {
  const app = await sandbox(t);
  await app.post('/api/settings', { workspace: '' });
  assert.equal((await app.request('/api/files')).status, 400);
});

test('P0: CLI receives a path with spaces as one argument', options, async t => {
  const app = await sandbox(t);
  await app.post('/api/settings', { addDirs: [app.workspace] });
  const run = await (await app.post('/api/run', { message: 'argument boundary test', resume: false })).json();
  const output = await events(app, run.runId);
  assert.equal(output.at(-1).data.code, 0);
  const log = output.find(e => e.type === 'log' && e.data.text.startsWith('mock: argv: '));
  assert.ok(log, JSON.stringify(output));
  const argv = JSON.parse(log.data.text.slice('mock: argv: '.length));
  assert.equal(argv[argv.indexOf('--add-dir') + 1], app.workspace);
});

test('P0: cross-origin upload + settings + GET /api/check cannot execute code', options, async t => {
  const app = await sandbox(t);
  const marker = path.join(app.root, 'chain-marker.txt');
  const foreign = { Origin: 'https://untrusted.invalid', 'Content-Type': 'text/plain' };
  // Each step is a "simple" request a foreign page can send without CORS preflight.
  await app.request('/api/upload?name=payload.cmd', {
    method: 'POST', headers: foreign, body: `@echo off\r\necho synthetic> "${marker}"\r\n`
  });
  await app.request('/api/settings', {
    method: 'POST', headers: foreign,
    body: JSON.stringify({ openclaudeCmd: path.join(app.workspace, 'payload.cmd') })
  });
  await app.request('/api/check', { headers: { Origin: 'https://untrusted.invalid' } });
  assert.equal(fs.existsSync(marker), false, 'foreign requests ran an uploaded script');
});
