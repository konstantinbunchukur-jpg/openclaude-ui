#!/usr/bin/env node
/*
 * OpenClaude UI — локальный веб-интерфейс для CLI openclaude (https://github.com/Twigpine/openclaude).
 * Без внешних зависимостей и без развёртывания серверов: ключ API вводится в UI
 * и передаётся напрямую в CLI через переменные окружения.
 * Запуск: node server.js  (или двойной клик по start-ui.bat)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const BASE_PORT = 8321;

const DEFAULT_CONFIG = {
  port: BASE_PORT,
  openclaudeCmd: 'openclaude',
  workspace: '',
  workspaces: [],
  provider: '',                  // флаг --provider ('' | openai | gemini | ollama | ...)
  env: {},                       // переменные окружения для CLI (ключи API и т.п.)
  permissionMode: 'acceptEdits', // plan | default | dontAsk | acceptEdits | bypassPermissions
  allowedTools: '',              // напр. "Bash(git:*),Read,Edit"
  disallowedTools: '',
  model: '',                     // --model
  fallbackModel: '',             // --fallback-model
  effort: '',                    // --effort: low|medium|high|xhigh|max|ultracode
  systemPrompt: '',              // --append-system-prompt-file
  addDirs: [],                   // --add-dir (доп. папки доступа)
  mcpConfigs: [],                // --mcp-config (пути к JSON)
  maxTurns: 0,                   // 0 = без ограничения
  maxBudgetUsd: 0,               // 0 = без ограничения
  sessionsDir: '',               // служебное: переопределение папки сессий (для тестов)
  openBrowser: true,
  sessions: {}                   // рабочаяПапка(ниж.регистр) -> { sessionId, updatedAt }
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return Object.assign({}, DEFAULT_CONFIG, raw);
  } catch {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}
const config = loadConfig();
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }
  catch (e) { console.error('Не удалось сохранить config.json:', e.message); }
}

/* ------------------------------ утилиты ------------------------------ */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 5 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
function wsKey(ws) { return String(ws || '').toLowerCase(); }
function cleanStr(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max || 4000);
}
function cleanPathList(v, maxItems) {
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x).trim().replace(/"/g, '')).filter(Boolean).slice(0, maxItems);
}

/* Canonical path checks: a string prefix does not follow junctions and symlinks. */
function realPath(p) {
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); }
  catch { return null; }
}
function wsRoot() {
  const raw = String(config.workspace || '').trim();
  return raw ? realPath(path.resolve(raw)) : null;
}
function pathIsInside(root, p) {
  const norm = s => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(p));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

/*
 * Start the CLI with a separate executable and argv, never a shell command string:
 * a path with spaces must stay one argument. On Windows only native .exe/.com files
 * are started directly; a bare name or a .cmd/.bat shim installed by npm needs
 * cmd.exe, which is started with an argument array rather than a command string.
 */
function spawnCli(command, args, opts) {
  const bin = String(command || '');
  if (process.platform !== 'win32' || /\.(exe|com)$/i.test(bin)) return spawn(bin, args, opts);
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', bin, ...args], opts);
}

/* --------------------------- запуск процессов --------------------------- */

const runs = new Map(); // id -> run

function makeRun(kind) {
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const run = { id, kind, workspace: '', proc: null, status: 'starting', exitCode: null,
                events: [], clients: new Set(), tmpFile: null, tmpFile2: null, sessionId: null, cost: null, startedAt: Date.now() };
  runs.set(id, run);
  return run;
}
function pushEvent(run, type, data) {
  const ev = { seq: run.events.length, type, data };
  run.events.push(ev);
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of run.clients) { try { res.write(payload); } catch {} }
}
function stopRun(run) {
  if (run.proc && run.proc.pid && run.status === 'running') {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(run.proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      try { run.proc.kill('SIGTERM'); } catch {}
    }
  }
}
function finalizeRun(run, code) {
  if (run.status === 'exited') return;
  run.status = 'exited';
  run.exitCode = code;
  if (run.tmpFile) { try { fs.unlinkSync(run.tmpFile); } catch {} run.tmpFile = null; }
  if (run.tmpFile2) { try { fs.unlinkSync(run.tmpFile2); } catch {} run.tmpFile2 = null; }
  pushEvent(run, 'exit', { code, sessionId: run.sessionId, costUsd: run.cost });
  for (const res of run.clients) { try { res.end(); } catch {} }
  run.clients.clear();
}

/*
 * Запуск openclaude в headless-режиме.
 * opts: { resumeSessionId, cont (--continue), fork (--fork-session), maxTurnsOverride }
 * Сообщение передаётся через stdin (pipe), ответ — построчно stream-json.
 */
function startClaudeRun(message, workspace, opts) {
  opts = opts || {};
  const run = makeRun('claude');
  run.workspace = workspace;

  const args = ['--print', '--output-format', 'stream-json', '--verbose'];
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts.cont) args.push('--continue');
  if (opts.fork && (opts.resumeSessionId || opts.cont)) args.push('--fork-session');

  const mode = config.permissionMode || 'default';
  if (mode && mode !== 'default') args.push('--permission-mode', mode);
  const tools = String(config.allowedTools || '').split(/[\s,]+/).filter(Boolean).join(',');
  if (tools) args.push('--allowedTools', tools);
  const dis = String(config.disallowedTools || '').split(/[\s,]+/).filter(Boolean).join(',');
  if (dis) args.push('--disallowedTools', dis);
  if (config.provider) args.push('--provider', config.provider);
  if (config.model) args.push('--model', config.model);
  if (config.fallbackModel) args.push('--fallback-model', config.fallbackModel);
  if (config.effort) args.push('--effort', config.effort);
  for (const d of cleanPathList(config.addDirs, 16)) args.push('--add-dir', d);
  for (const m of cleanPathList(config.mcpConfigs, 8)) args.push('--mcp-config', m);
  const turns = parseInt(opts.maxTurnsOverride != null ? opts.maxTurnsOverride : config.maxTurns, 10);
  if (turns > 0) args.push('--max-turns', String(turns));
  const budget = parseFloat(config.maxBudgetUsd);
  if (budget > 0) args.push('--max-budget-usd', String(budget));

  const sp = String(config.systemPrompt || '').trim();
  if (sp) {
    run.tmpFile2 = path.join(os.tmpdir(), `openclaude-ui-sp-${run.id}.txt`);
    fs.writeFileSync(run.tmpFile2, sp, 'utf8');
    args.push('--append-system-prompt-file', run.tmpFile2);
  }

  run.status = 'running';
  try {
    run.proc = spawnCli(config.openclaudeCmd || 'openclaude', args, {
      cwd: workspace, windowsHide: true,
      env: Object.assign({}, process.env, config.env || {})
    });
    run.proc.stdin.on('error', () => {});
    run.proc.stdin.end(message, 'utf8');
  } catch (e) {
    pushEvent(run, 'log', { stream: 'stderr', text: 'Не удалось запустить: ' + e.message });
    finalizeRun(run, -1);
    return run;
  }

  let outBuf = '', errBuf = '';
  run.proc.stdout.on('data', d => {
    outBuf += d.toString('utf8');
    let i;
    while ((i = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, i).replace(/\r$/, ''); outBuf = outBuf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'result') {
          if (obj.session_id) run.sessionId = obj.session_id;
          if (typeof obj.total_cost_usd === 'number') run.cost = obj.total_cost_usd;
          if (run.sessionId) {
            config.sessions[wsKey(run.workspace)] = { sessionId: run.sessionId, updatedAt: new Date().toISOString() };
            saveConfig();
          }
        } else if (obj.type === 'system' && obj.session_id && !run.sessionId) {
          run.sessionId = obj.session_id;
        }
        pushEvent(run, 'json', obj);
      } catch { pushEvent(run, 'log', { stream: 'stdout', text: line }); }
    }
  });
  run.proc.stderr.on('data', d => {
    errBuf += d.toString('utf8');
    let i;
    while ((i = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, i).replace(/\r$/, ''); errBuf = errBuf.slice(i + 1);
      if (line.trim()) pushEvent(run, 'log', { stream: 'stderr', text: line });
    }
  });
  run.proc.on('error', e => pushEvent(run, 'log', { stream: 'stderr', text: 'Ошибка процесса: ' + e.message }));
  run.proc.on('close', code => {
    if (outBuf.trim()) {
      try { pushEvent(run, 'json', JSON.parse(outBuf.trim())); }
      catch { pushEvent(run, 'log', { stream: 'stdout', text: outBuf.trim() }); }
      outBuf = '';
    }
    if (errBuf.trim()) pushEvent(run, 'log', { stream: 'stderr', text: errBuf.trim() });
    finalizeRun(run, code);
  });

  return run;
}

function startInstallRun() {
  const run = makeRun('install');
  run.status = 'running';
  run.proc = spawnCli('npm', ['install', '-g', '@twigpine/openclaude@latest'], { cwd: ROOT, windowsHide: true });
  let buf = '';
  const forward = (stream) => d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (line.trim()) pushEvent(run, 'log', { stream, text: line });
    }
  };
  run.proc.stdout.on('data', forward('stdout'));
  run.proc.stderr.on('data', forward('stderr'));
  run.proc.on('error', e => pushEvent(run, 'log', { stream: 'stderr', text: 'Ошибка: ' + e.message }));
  run.proc.on('close', code => finalizeRun(run, code));
  return run;
}

/* -------------------------- проверка openclaude -------------------------- */

let cliCheck = { found: false, version: null, error: null, checkedAt: 0 };
function checkOpenclaude(cb) {
  const p = spawnCli(config.openclaudeCmd || 'openclaude', ['--version'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', done = false;
  const timer = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch {} cb({ found: false, version: null, error: 'таймаут проверки' }); } }, 20000);
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', d => err += d);
  p.on('error', e => { if (!done) { done = true; clearTimeout(timer); cb({ found: false, version: null, error: e.message }); } });
  p.on('close', code => {
    if (done) return; done = true; clearTimeout(timer);
    const text = (out || err).trim();
    if (code === 0 && text) cb({ found: true, version: text.split(/\r?\n/)[0], error: null });
    else cb({ found: false, version: null, error: text || ('код выхода ' + code) });
  });
}
function refreshCliCheck(force) {
  return new Promise(resolve => {
    if (!force && Date.now() - cliCheck.checkedAt < 60000) return resolve(cliCheck);
    checkOpenclaude(r => {
      cliCheck = Object.assign(r, { checkedAt: Date.now() });
      resolve(cliCheck);
    });
  });
}
function homeConfigWarning() {
  const target = path.join(os.homedir(), '.openclaude.json');
  if (fs.existsSync(target)) return null;
  const backup = path.join(os.homedir(), '.claude.json.backup');
  return {
    target,
    backupExists: fs.existsSync(backup),
    hint: 'Файл настроек CLI не найден. Провайдера можно задать в настройках этого интерфейса, либо запустите openclaude в терминале и выполните /provider.'
  };
}

/* --------------------------- история сессий CLI --------------------------- */

function projectsDir() {
  if (config.sessionsDir) return path.resolve(config.sessionsDir);
  const envCd = (config.env && (config.env.CLAUDE_CONFIG_DIR || config.env.OPENCLAUDE_CONFIG_DIR)) || process.env.CLAUDE_CONFIG_DIR;
  const base = envCd ? path.resolve(envCd) : path.join(os.homedir(), '.openclaude');
  return path.join(base, 'projects');
}

// Читает журнал сессии (.jsonl) достаточно, чтобы узнать id, папку и первый вопрос.
function readSessionMeta(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    fs.closeSync(fd);
    let id = null, cwd = null, title = null, ts = null;
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!id && o.sessionId) id = o.sessionId;
      if (!cwd && o.cwd) cwd = o.cwd;
      if (!ts && o.timestamp) ts = o.timestamp;
      if (!title && o.type === 'user' && o.message) {
        const c = o.message.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(b => b.type === 'text') || {}).text : null;
        if (text && String(text).trim()) title = cleanStr(text, 90);
      }
      if (id && cwd && title) break;
    }
    return id ? { id, cwd: cwd || '', title: title || '(без текста)', ts } : null;
  } catch { return null; }
}

function listSessions() {
  const dir = projectsDir();
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return { projectsDir: dir, exists: false, sessions: out }; }
  const files = [];
  for (const d of dirs) {
    const pd = path.join(dir, d);
    let names = [];
    try { names = fs.readdirSync(pd); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const st = fs.statSync(path.join(pd, name));
        files.push({ f: path.join(pd, name), mtime: st.mtimeMs });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  for (const { f, mtime } of files.slice(0, 150)) {
    const meta = readSessionMeta(f);
    if (meta) out.push(Object.assign(meta, { mtime }));
  }
  return { projectsDir: dir, exists: true, sessions: out };
}

/* --------------------------------- API --------------------------------- */

async function handleApi(req, res, url) {
  const route = url.pathname;

  if (req.method === 'GET' && route === '/api/state') {
    const s = wsKey(config.workspace);
    return json(res, 200, {
      config: {
        workspace: config.workspace, workspaces: config.workspaces,
        provider: config.provider, env: config.env,
        permissionMode: config.permissionMode,
        allowedTools: config.allowedTools, disallowedTools: config.disallowedTools,
        model: config.model, fallbackModel: config.fallbackModel, effort: config.effort,
        systemPrompt: config.systemPrompt, addDirs: config.addDirs, mcpConfigs: config.mcpConfigs,
        maxTurns: config.maxTurns, maxBudgetUsd: config.maxBudgetUsd,
        openclaudeCmd: config.openclaudeCmd, openBrowser: config.openBrowser
      },
      cli: cliCheck,
      session: config.sessions[s] || null,
      node: process.version,
      homeConfigWarning: homeConfigWarning(),
      platform: process.platform
    });
  }

  if (req.method === 'GET' && route === '/api/check') {
    const r = await refreshCliCheck(true);
    return json(res, 200, r);
  }

  /* Статус входа в аккаунт Anthropic (openclaude auth status) */
  if (req.method === 'GET' && route === '/api/auth') {
    const out = await new Promise(resolve => {
      const p = spawnCli(config.openclaudeCmd || 'openclaude', ['auth', 'status'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '', done = false;
      const t = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch {} resolve(''); } }, 15000);
      p.stdout.on('data', d => o += d);
      p.stderr.on('data', d => o += d);
      p.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve(''); } });
      p.on('close', () => { if (!done) { done = true; clearTimeout(t); resolve(o); } });
    });
    let auth = { loggedIn: false, authMethod: 'none' };
    const m = out.match(/\{[\s\S]*\}/);
    if (m) { try { auth = Object.assign(auth, JSON.parse(m[0])); } catch {} }
    return json(res, 200, auth);
  }

  /* Вход в аккаунт через браузер: запускаем openclaude auth login и показываем вывод */
  if (req.method === 'POST' && route === '/api/login') {
    const run = makeRun('login');
    run.status = 'running';
    run.proc = spawnCli(config.openclaudeCmd || 'openclaude', ['auth', 'login'], { cwd: ROOT, windowsHide: true });
    const forward = (stream) => d => {
      for (const line of d.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) pushEvent(run, 'log', { stream, text: line });
      }
    };
    run.proc.stdout.on('data', forward('stdout'));
    run.proc.stderr.on('data', forward('stderr'));
    run.proc.on('error', e => pushEvent(run, 'log', { stream: 'stderr', text: 'Ошибка: ' + e.message }));
    run.proc.on('close', code => finalizeRun(run, code));
    return json(res, 200, { runId: run.id });
  }

  if (req.method === 'GET' && route === '/api/sessions') {
    return json(res, 200, listSessions());
  }

  if (req.method === 'POST' && route === '/api/settings') {
    const b = await readBody(req);
    const strings = ['openclaudeCmd', 'workspace', 'provider', 'allowedTools', 'disallowedTools',
                     'model', 'fallbackModel', 'systemPrompt', 'sessionsDir'];
    for (const k of strings) if (typeof b[k] === 'string') config[k] = b[k].trim();
    if (b.env && typeof b.env === 'object') {
      const env = {};
      for (const [k, v] of Object.entries(b.env)) {
        const key = String(k).trim();
        if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) env[key] = String(v);
      }
      config.env = env;
    }
    if (['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].includes(b.effort)) config.effort = b.effort;
    if (['plan', 'default', 'dontAsk', 'acceptEdits', 'bypassPermissions'].includes(b.permissionMode)) config.permissionMode = b.permissionMode;
    if (b.addDirs !== undefined) config.addDirs = cleanPathList(b.addDirs, 16);
    if (b.mcpConfigs !== undefined) config.mcpConfigs = cleanPathList(b.mcpConfigs, 8);
    if (b.maxTurns !== undefined) config.maxTurns = Math.max(0, parseInt(b.maxTurns, 10) || 0);
    if (b.maxBudgetUsd !== undefined) config.maxBudgetUsd = Math.max(0, parseFloat(b.maxBudgetUsd) || 0);
    if (b.openBrowser !== undefined) config.openBrowser = !!b.openBrowser;
    if (config.workspace) {
      config.workspaces = [config.workspace, ...config.workspaces.filter(w => w !== config.workspace)].slice(0, 8);
    }
    saveConfig();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && route === '/api/run') {
    const b = await readBody(req);
    const message = String(b.message || '').trim();
    const workspace = path.resolve(String(b.workspace || config.workspace || ROOT));
    if (!message) return json(res, 400, { error: 'Пустое сообщение' });
    if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory())
      return json(res, 400, { error: 'Рабочая папка не существует: ' + workspace });

    config.workspace = workspace;
    config.workspaces = [workspace, ...config.workspaces.filter(w => w !== workspace)].slice(0, 8);
    saveConfig();

    let opts = {};
    if (b.cont) opts = { cont: true, fork: !!b.fork };
    else if (b.resumeId) opts = { resumeSessionId: String(b.resumeId), fork: !!b.fork };
    else {
      const prev = config.sessions[wsKey(workspace)];
      if (b.resume !== false && prev && prev.sessionId) opts = { resumeSessionId: prev.sessionId };
    }
    const run = startClaudeRun(message, workspace, opts);
    return json(res, 200, { runId: run.id, resume: opts });
  }

  if (req.method === 'POST' && route === '/api/test-connection') {
    const workspace = path.resolve(String(config.workspace || ROOT));
    const wsOk = fs.existsSync(workspace) && fs.statSync(workspace).isDirectory();
    const run = startClaudeRun('Проверка связи. Ответь ровно одним словом: ок', wsOk ? workspace : ROOT, { maxTurnsOverride: 1 });
    return json(res, 200, { runId: run.id });
  }

  if (req.method === 'GET' && route.startsWith('/api/run/') && route.endsWith('/stream')) {
    const id = route.slice('/api/run/'.length, -'/stream'.length);
    const from = parseInt(url.searchParams.get('from') || '0', 10) || 0;
    const run = runs.get(id);
    if (!run) return json(res, 404, { error: 'Запуск не найден' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    const send = payload => { try { res.write(payload); } catch {} };
    for (const ev of run.events.slice(from)) send(`data: ${JSON.stringify(ev)}\n\n`);
    if (run.status === 'exited') { return res.end(); }
    run.clients.add(res);
    const hb = setInterval(() => send(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); run.clients.delete(res); });
    return;
  }

  if (req.method === 'POST' && route.startsWith('/api/stop/')) {
    const run = runs.get(route.slice('/api/stop/'.length));
    if (!run) return json(res, 404, { error: 'Запуск не найден' });
    stopRun(run);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && route === '/api/install') {
    const run = startInstallRun();
    return json(res, 200, { runId: run.id });
  }

  if (req.method === 'POST' && route === '/api/session/clear') {
    const b = await readBody(req);
    delete config.sessions[wsKey(b.workspace || config.workspace)];
    saveConfig();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && route === '/api/open-folder') {
    const b = await readBody(req);
    const dir = String(b.path || config.workspace || '');
    if (!fs.existsSync(dir)) return json(res, 400, { error: 'Папка не найдена' });
    if (process.platform === 'win32') spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && route === '/api/open-terminal') {
    if (process.platform !== 'win32') return json(res, 400, { error: 'Доступно только в Windows' });
    const b = await readBody(req);
    const dir = String(b.path || config.workspace || '');
    if (!fs.existsSync(dir)) return json(res, 400, { error: 'Папка не найдена' });
    const safe = dir.replace(/"/g, '');
    spawn(`start "" cmd /k "cd /d ${safe}"`, { shell: 'cmd.exe', detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && route === '/api/mkdir') {
    const b = await readBody(req);
    const dir = path.resolve(String(b.path || ''));
    if (!dir) return json(res, 400, { error: 'Укажите путь' });
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return json(res, 400, { error: e.message }); }
    return json(res, 200, { ok: true, path: dir });
  }

  if (req.method === 'POST' && route === '/api/restore-config') {
    const target = path.join(os.homedir(), '.openclaude.json');
    const backup = path.join(os.homedir(), '.claude.json.backup');
    if (fs.existsSync(target)) return json(res, 400, { error: 'Файл уже существует' });
    if (!fs.existsSync(backup)) return json(res, 400, { error: 'Резервная копия не найдена' });
    try { fs.copyFileSync(backup, target); } catch (e) { return json(res, 500, { error: e.message }); }
    return json(res, 200, { ok: true });
  }

  /* Автоопределение локального Ollama: запущен ли и какие модели есть */
  if (req.method === 'GET' && route === '/api/ollama') {
    const base = (config.env && config.env.OPENAI_BASE_URL) || 'http://127.0.0.1:11434';
    let host = '127.0.0.1', port = 11434;
    try {
      const u = new URL(base);
      host = u.hostname; port = u.port || 11434;
    } catch {}
    return new Promise(resolve => {
      const r = http.get({ host, port, path: '/api/tags', timeout: 1500 }, resp => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          try {
            const models = (JSON.parse(data).models || []).map(m => m.name).slice(0, 30);
            resolve(json(res, 200, { running: true, models }));
          } catch { resolve(json(res, 200, { running: true, models: [] })); }
        });
      });
      r.on('timeout', () => { r.destroy(); resolve(json(res, 200, { running: false, models: [] })); });
      r.on('error', () => resolve(json(res, 200, { running: false, models: [] })));
    });
  }

  /* Список файлов рабочей папки (с подпапками, без выхода за её пределы) */
  if (req.method === 'GET' && route === '/api/files') {
    const ws = wsRoot();
    if (!ws) return json(res, 400, { error: 'Сначала укажите рабочую папку в настройках' });
    let dir = ws;
    const rel = url.searchParams.get('path') || '';
    if (rel) {
      const cand = realPath(path.resolve(ws, rel));
      if (!cand || !pathIsInside(ws, cand)) return json(res, 400, { error: 'Путь вне рабочей папки' });
      dir = cand;
    }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return json(res, 400, { error: 'Не удалось прочитать папку: ' + e.message }); }
    const items = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      let size = 0;
      try { if (e.isFile()) size = fs.statSync(path.join(dir, e.name)).size; } catch {}
      items.push({ name: e.name, dir: e.isDirectory(), size });
    }
    items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    const relNow = path.relative(ws, dir) || '.';
    return json(res, 200, { path: relNow, isRoot: relNow === '.', items: items.slice(0, 500) });
  }

  /* Загрузка файла в рабочую папку (тело запроса — содержимое файла) */
  if (req.method === 'POST' && route === '/api/upload') {
    const ws = wsRoot();
    if (!ws) return json(res, 400, { error: 'Сначала укажите рабочую папку' });
    const name = path.basename(String(url.searchParams.get('name') || '')).replace(/[<>:"/\\|?*]/g, '_');
    if (!name || name === '.' || name === '..') return json(res, 400, { error: 'Не указано имя файла' });
    let dir = ws;
    const rel = url.searchParams.get('dir') || '';
    if (rel) {
      const cand = realPath(path.resolve(ws, rel));
      if (!cand || !pathIsInside(ws, cand)) return json(res, 400, { error: 'Путь вне рабочей папки' });
      dir = cand;
    }
    const target = path.join(dir, name);
    const chunks = []; let size = 0, aborted = false;
    await new Promise((resolve) => {
      req.on('data', c => { size += c.length; if (size > 20 * 1024 * 1024) { aborted = true; req.destroy(); resolve(); } else chunks.push(c); });
      req.on('end', resolve);
      req.on('error', resolve);
    });
    if (aborted) return json(res, 400, { error: 'Файл больше 20 МБ' });
    try { fs.writeFileSync(target, Buffer.concat(chunks), { flag: 'wx' }); }
    catch (e) {
      if (e.code === 'EEXIST') return json(res, 409, { error: 'Файл уже существует' });
      return json(res, 500, { error: 'Не удалось записать: ' + e.message });
    }
    return json(res, 200, { ok: true, path: path.relative(ws, target) });
  }

  /* Удаление сохранённого чата (файла сессии openclaude) */
  if (req.method === 'POST' && route === '/api/session/delete') {
    const b = await readBody(req);
    const id = String(b.id || '').replace(/[^a-zA-Z0-9-]/g, '');
    if (!id) return json(res, 400, { error: 'Не указан id чата' });
    const dir = projectsDir();
    let dirs = [];
    try { dirs = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
    catch { return json(res, 200, { deleted: 0 }); }
    let deleted = 0;
    for (const d of dirs) {
      const pd = path.join(dir, d);
      let names = [];
      try { names = fs.readdirSync(pd); } catch { continue; }
      for (const n of names.filter(n => n.endsWith('.jsonl'))) {
        const f = path.join(pd, n);
        const meta = readSessionMeta(f);
        if (meta && meta.id === id) {
          try { fs.unlinkSync(f); deleted++; } catch {}
        }
      }
    }
    for (const [k, v] of Object.entries(config.sessions)) {
      if (v && v.sessionId === id) { delete config.sessions[k]; }
    }
    saveConfig();
    return json(res, 200, { deleted });
  }

  return json(res, 404, { error: 'Нет такого API-маршрута: ' + route });
}

/* ------------------------------- статика ------------------------------- */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };

function serveStatic(res, filePath) {
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(data);
}

/* -------------------------------- сервер -------------------------------- */

// Граница API: только наш Host (DNS rebinding), только наш Origin/Fetch Metadata (CSRF),
// а POST — только с типом тела, который чужая страница не отправит без CORS preflight.
function trustedApiRequest(req) {
  const port = server.address().port;
  const own = ['127.0.0.1:' + port, 'localhost:' + port];
  if (!own.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && !own.some(h => origin === 'http://' + h)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json' || type === 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!trustedApiRequest(req)) return json(res, 403, { error: 'Запрос отклонён: разрешены только запросы со страницы этого интерфейса' });
      return await handleApi(req, res, url);
    }
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const filePath = path.normalize(path.join(PUBLIC, p));
    if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return serveStatic(res, filePath);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

function openBrowser(u) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', u], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

let browserOpened = false;
function listenOn(port, attempt) {
  server.once('error', err => {
    if (err.code !== 'EADDRINUSE' || attempt > 10) {
      console.error('Не удалось занять порт ' + port + ': ' + err.message);
      process.exit(1);
    }
    // Если на этом порту уже работает наш UI — просто открываем браузер.
    http.get('http://127.0.0.1:' + port + '/api/state', r => {
      if (!browserOpened && config.openBrowser) { browserOpened = true; openBrowser('http://127.0.0.1:' + port); }
      console.log('OpenClaude UI уже запущен: http://127.0.0.1:' + port);
      process.exit(0);
    }).on('error', () => listenOn(port + 1, attempt + 1));
  });
  server.listen(port, '127.0.0.1', async () => {
    config.port = port; saveConfig();
    const u = 'http://127.0.0.1:' + port;
    console.log('');
    console.log('  OpenClaude UI запущен: ' + u);
    console.log('  Остановить: закрыть это окно или Ctrl+C');
    console.log('');
    refreshCliCheck(true).then(r => {
      console.log(r.found ? '  CLI: ' + r.version : '  CLI не найден — установите: npm install -g @twigpine/openclaude@latest');
    });
    if (process.env.OPEN_BROWSER === '1' && config.openBrowser && !browserOpened) {
      browserOpened = true;
      setTimeout(() => openBrowser(u), 400);
    }
  });
}

listenOn(config.port || BASE_PORT, 0);
