'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, events } = require('./helpers/sandbox');

const options = { timeout: 20000 };

test('serves the UI, scripts and styles, but not config.json', options, async t => {
  const app = await sandbox(t);
  for (const [route, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
    const response = await app.request(route);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.ok((await response.text()).length > 0);
  }
  assert.equal((await app.request('/config.json')).status, 404);
  assert.equal((await app.request('/api/unknown')).status, 404);
});

test('persists settings only in the disposable config', options, async t => {
  const app = await sandbox(t);
  assert.equal((await app.post('/api/settings', { model: 'smoke-model', maxTurns: 2 })).status, 200);
  const state = await (await app.request('/api/state')).json();
  assert.equal(state.config.model, 'smoke-model');
  assert.equal(state.config.maxTurns, 2);
  assert.equal(state.config.workspace, app.workspace);
  assert.equal(JSON.parse(fs.readFileSync(path.join(app.root, 'config.json'), 'utf8')).model, 'smoke-model');
});

test('discovers the mock CLI without provider credentials', options, async t => {
  const app = await sandbox(t);
  const cli = await (await app.request('/api/check')).json();
  assert.equal(cli.found, true, cli.error);
  assert.match(cli.version, /mock-openclaude/);
});

test('runs a prompt, streams events, saves and resumes the session', options, async t => {
  const app = await sandbox(t);
  const response = await app.post('/api/run', { message: 'Привет', resume: false });
  assert.equal(response.status, 200);
  const run = await response.json();
  const first = await events(app, run.runId);
  assert.deepEqual(first.map(e => e.seq), first.map((_, i) => i));
  assert.equal(first.at(-1).type, 'exit');
  assert.equal(first.at(-1).data.code, 0, JSON.stringify(first));
  assert.ok(first.some(e => e.type === 'json' && e.data.type === 'assistant'));
  const state = await (await app.request('/api/state')).json();
  assert.equal(state.session.sessionId, first.at(-1).data.sessionId);
  const resumed = await (await app.post('/api/run', { message: 'Ещё раз' })).json();
  assert.equal(resumed.resume.resumeSessionId, state.session.sessionId);
  const second = await events(app, resumed.runId);
  assert.equal(second.at(-1).data.code, 0);
  assert.equal(second.at(-1).data.sessionId, state.session.sessionId);
  assert.deepEqual(await events(app, run.runId, 2), first.slice(2));
  assert.deepEqual(fs.readdirSync(path.join(app.root, 'tmp')), []);
});

test('rejects an empty prompt and a missing workspace', options, async t => {
  const app = await sandbox(t);
  assert.equal((await app.post('/api/run', { message: ' ' })).status, 400);
  assert.equal((await app.post('/api/run', { message: 'hello', workspace: path.join(app.root, 'missing') })).status, 400);
});

test('lists and uploads files, rejects lexical parent traversal', options, async t => {
  const app = await sandbox(t);
  const uploaded = await app.request('/api/upload?name=hello.txt', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'hello' });
  assert.equal(uploaded.status, 200);
  assert.equal(fs.readFileSync(path.join(app.workspace, 'hello.txt'), 'utf8'), 'hello');
  const listing = await (await app.request('/api/files')).json();
  assert.ok(listing.items.some(f => f.name === 'hello.txt' && f.size === 5));
  assert.equal((await app.request('/api/files?path=..')).status, 400);
  assert.equal((await app.request('/api/upload?name=escape.txt&dir=..', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'no' })).status, 400);
  assert.equal(fs.existsSync(path.join(app.root, 'escape.txt')), false);
});

test('reads and deletes generated session fixtures, clears the session mapping', options, async t => {
  const app = await sandbox(t);
  const id = '11111111-2222-3333-4444-555555555555';
  const project = path.join(app.sessionsDir, 'Demo');
  fs.mkdirSync(project);
  const file = path.join(project, id + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ sessionId: id, cwd: app.workspace,
    timestamp: '2026-01-01T00:00:00Z', type: 'user', message: { content: 'Synthetic test conversation' } }) + '\n');
  const listing = await (await app.request('/api/sessions')).json();
  assert.equal(listing.sessions.length, 1);
  assert.equal(listing.sessions[0].id, id);
  const run = await (await app.post('/api/run', { message: 'create mapping before clear', resume: false })).json();
  const output = await events(app, run.runId);
  assert.equal(output.at(-1).data.code, 0);
  const beforeClear = await (await app.request('/api/state')).json();
  assert.ok(beforeClear.session?.sessionId);
  assert.equal(beforeClear.session.sessionId, output.at(-1).data.sessionId);
  assert.equal((await app.post('/api/session/clear', { workspace: app.workspace })).status, 200);
  assert.equal((await (await app.request('/api/state')).json()).session, null);
  const deleted = await (await app.post('/api/session/delete', { id })).json();
  assert.equal(deleted.deleted, 1);
  assert.equal(fs.existsSync(file), false);
});

test('accepts same-origin UI requests at the API boundary', options, async t => {
  const app = await sandbox(t);
  const response = await app.request('/api/settings', {
    method: 'POST', headers: { Origin: app.base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'same-origin-model' })
  });
  assert.equal(response.status, 200);
  assert.equal((await app.request('/api/state', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await app.request('/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});
