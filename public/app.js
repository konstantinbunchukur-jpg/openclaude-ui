/* OpenClaude UI — логика интерфейса. Без зависимостей. */
'use strict';

const $ = id => document.getElementById(id);

const PRESETS = {
  openai: {
    hint: 'Ключ можно создать на platform.openai.com/api-keys. Модель — например gpt-4o или gpt-4.1-mini.',
    provider: 'openai',
    env: { CLAUDE_CODE_USE_OPENAI: '1', OPENAI_API_KEY: '', OPENAI_MODEL: 'gpt-4o' }
  },
  ollama: {
    hint: 'Бесплатно и локально. Установите Ollama (ollama.com), затем: ollama pull qwen2.5-coder:7b. Ключ не нужен.',
    provider: '',
    env: { CLAUDE_CODE_USE_OPENAI: '1', OPENAI_BASE_URL: 'http://localhost:11434/v1', OPENAI_API_KEY: 'ollama', OPENAI_MODEL: 'qwen2.5-coder:7b' }
  },
  gemini: {
    hint: 'Ключ можно создать на aistudio.google.com/apikey.',
    provider: 'gemini',
    env: { GEMINI_API_KEY: '' }
  },
  custom: {
    hint: 'Любой OpenAI-совместимый API: укажите адрес, ключ и название модели.',
    provider: '',
    env: { CLAUDE_CODE_USE_OPENAI: '1', OPENAI_BASE_URL: '', OPENAI_API_KEY: '', OPENAI_MODEL: '' }
  }
};

const state = {
  config: null,
  session: null,
  cli: null,
  homeWarning: null,
  auth: null,            // { loggedIn, authMethod } из openclaude auth status
  runId: null,
  lastEventSeq: 0,
  running: false,
  toolsSeen: new Map(),   // tool_use_id -> плашка
  pendingResume: null,    // { id, fork } — выбранная в истории сессия
  logTail: [],            // последние строки журнала для диагностики ошибок
  es: null,
  typingEl: null
};

/* --------------------------- мелкие утилиты --------------------------- */

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(text, ok) {
  const box = $('toast');
  box.textContent = t(text);
  box.classList.toggle('ok', !!ok);
  box.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => box.classList.add('hidden'), 4000);
}
async function api(path, opts) {
  opts = opts || {};
  // Сервер принимает POST только с JSON-типом (защита от запросов чужих страниц).
  if (opts.method && opts.method !== 'GET') opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
  const r = await fetch(path, opts);
  let body = {};
  try { body = await r.json(); } catch {}
  if (!r.ok) throw new Error(t(body.error || ('HTTP ' + r.status)));
  return body;
}
function nearBottom() {
  const c = $('chat');
  return c.scrollHeight - c.scrollTop - c.clientHeight < 120;
}
function scrollDown(force) {
  if (force || nearBottom()) $('chat').scrollTop = $('chat').scrollHeight;
}

/* ------------------------ упрощённый Markdown ------------------------ */

function renderInline(text) {
  let s = esc(text);
  s = s.replace(/`([^`\n]+)`/g, '<code class="inline">$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function renderMd(text) {
  const parts = String(text ?? '').split(/```/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const nl = parts[i].indexOf('\n');
      const lang = nl > 0 ? parts[i].slice(0, nl).trim() : '';
      const code = nl > 0 ? parts[i].slice(nl + 1) : parts[i];
      html += `<pre data-code="${esc(lang)}">${esc(code.replace(/\n$/, ''))}</pre>`;
    } else {
      const lines = parts[i].split('\n');
      let para = [];
      for (const line of lines) {
        if (/^\s*#{1,4}\s+/.test(line)) {
          if (para.length) { html += '<p>' + para.map(renderInline).join('<br>') + '</p>'; para = []; }
          html += '<p><b>' + renderInline(line.replace(/^\s*#{1,4}\s+/, '')) + '</b></p>';
        } else if (line.trim() === '') {
          if (para.length) { html += '<p>' + para.map(renderInline).join('<br>') + '</p>'; para = []; }
        } else para.push(line);
      }
      if (para.length) html += '<p>' + para.map(renderInline).join('<br>') + '</p>';
    }
  }
  return html || '<p></p>';
}

/* --------------------------- чат: отрисовка --------------------------- */

function addMessage(kind, who) {
  $('empty-state').classList.add('hidden');
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.innerHTML = `<div class="who">${esc(t(who))}</div><div class="bubble"></div>`;
  $('messages').appendChild(el);
  scrollDown(true);
  return el.querySelector('.bubble');
}
function addTyping() {
  $('empty-state').classList.add('hidden');
  const el = document.createElement('div');
  el.className = 'result-line';
  el.innerHTML = '<span class="typing"><i></i><i></i><i></i> ' + esc(t('агент работает…')) + '</span>';
  $('messages').appendChild(el);
  scrollDown(true);
  return el;
}
function addToolChip(toolName, input) {
  const el = document.createElement('details');
  el.className = 'tool';
  const brief = toolName === 'Bash' && input.command ? String(input.command).slice(0, 90)
    : toolName === 'Read' && input.file_path ? '📄 ' + input.file_path
    : toolName === 'Edit' || toolName === 'Write' ? (input.file_path ? '✏️ ' + input.file_path : '')
    : Object.keys(input || {}).slice(0, 2).map(k => String(input[k]).slice(0, 60)).join(', ');
  el.innerHTML = `<summary>🔧 ${esc(toolName)} ${esc(brief || '')}</summary><pre>${esc(JSON.stringify(input, null, 2))}</pre>`;
  $('messages').appendChild(el);
  scrollDown();
  return el;
}
function addResultLine(text) {
  const el = document.createElement('div');
  el.className = 'result-line';
  el.textContent = t(text);
  $('messages').appendChild(el);
  scrollDown();
  return el;
}

function applyJsonEvent(data) {
  switch (data.type) {
    case 'system': {
      state.authMissingRun = data.apiKeySource === 'none';
      if (data.session_id) {
        state.session = { sessionId: data.session_id };
        updateSessionUi();
      }
      break;
    }
    case 'stream_event':
      break; // промежуточные куски — пропускаем, ждём готовые блоки
    case 'assistant': {
      const content = data.message && data.message.content || [];
      for (const block of content) {
        if (block.type === 'text') {
          const b = addMessage('assistant', 'OpenClaude');
          b.innerHTML = renderMd(block.text);
        } else if (block.type === 'tool_use') {
          const chip = addToolChip(block.name, block.input || {});
          if (block.id) state.toolsSeen.set(block.id, chip);
        }
      }
      scrollDown();
      break;
    }
    case 'user': {
      const content = data.message && data.message.content;
      const arr = Array.isArray(content) ? content : [];
      for (const block of arr) {
        if (block.type === 'tool_result') {
          const chip = state.toolsSeen.get(block.tool_use_id);
          if (chip) { chip.classList.add('done'); chip.querySelector('summary').textContent += '  ✓'; }
        }
      }
      break;
    }
    case 'result': {
      state.session = { sessionId: data.session_id || (state.session && state.session.sessionId) };
      const secs = data.duration_ms ? (data.duration_ms / 1000).toFixed(1) + ' ' + t('с') : '';
      const cost = data.total_cost_usd ? '$' + data.total_cost_usd.toFixed(4) : '';
      if (data.is_error) {
        const diag = diagError();
        if (diag) addErrorBlock(diag, data.result);
        else addResultLine(t('⚠️ Запрос завершился с ошибкой') + (data.result ? ': ' + data.result : ''));
      } else {
        addResultLine([t('✔ Готово'), secs, cost].filter(Boolean).join(' · '));
      }
      updateSessionUi();
      break;
    }
    default:
      consoleAppend(JSON.stringify(data).slice(0, 300));
  }
}

/* --------------------------- консоль (журнал) --------------------------- */

function consoleAppend(text, isErr) {
  state.logTail.push(text);
  if (state.logTail.length > 60) state.logTail.shift();
  const pre = $('console-log');
  const line = document.createElement('span');
  if (isErr) line.className = 'err';
  line.textContent = text + '\n';
  pre.appendChild(line);
  while (pre.childNodes.length > 500) pre.removeChild(pre.firstChild);
  pre.scrollTop = pre.scrollHeight;
  if (isErr && !$('console-panel').open) $('console-panel').open = true;
}

/* -------------------- понятные сообщения об ошибках -------------------- */

function diagError() {
  const tail = state.logTail.join('\n');
  if (/api[_ ]?key(is)?\s*required|key.*is required.*when/i.test(tail)) {
    const varName = (tail.match(/([A-Z][A-Z0-9_]{3,})\s+or\s+[A-Z_]+ is required/i) || [])[1] || t('API-ключ');
    return { kind: 'key', title: t('Не задан ключ API ({0})', varName),
      text: 'Сохранённые настройки провайдера требуют ключ. Откройте настройки (☰ → Провайдер и ключ API), вставьте ключ и сохраните — или войдите через аккаунт Claude.' };
  }
  if (state.authMissingRun || /Not logged in|run \/login|loggedIn": false/i.test(tail))
    return { kind: 'auth', title: 'Агент не вошёл в систему',
      text: 'Для работы нужен вход в аккаунт Claude или ключ API провайдера.' };
  if (/incorrect api key|invalid api key|unauthorized|401/i.test(tail))
    return { kind: 'key', title: 'Ключ API отклонён',
      text: 'Провайдер не принял ключ. Проверьте его значение в настройках (☰ → Провайдер и ключ API).' };
  if (/econnrefused|enotfound|fetch failed|getaddrinfo/i.test(tail))
    return { kind: 'net', title: 'Сервер провайдера недоступен',
      text: 'Проверьте интернет или адрес API. Если используете Ollama — запустите её (ollama serve) и нажмите «🔎 Найти Ollama» в настройках.' };
  if (/insufficient|quota|credit|balance|429/i.test(tail))
    return { kind: 'quota', title: 'Нет доступа к модели (лимит/баланс)',
      text: 'На аккаунте провайдера закончились средства или исчерпан лимит. Попробуйте другую модель или бесплатную локальную Ollama.' };
  if (/not found|command not found|не является внутренней/i.test(tail))
    return { kind: 'cli', title: 'Программа openclaude не найдена',
      text: 'Установите её: npm install -g @twigpine/openclaude@latest (кнопка в приветствии) или укажите путь в настройках.' };
  return null;
}

function addErrorBlock(diag, rawText) {
  const b = addMessage('error', '⚠ Проблема');
  const html = `<b class="etitle">${esc(t(diag.title))}</b><span>${esc(t(diag.text))}</span>` +
    (rawText ? `<br><span class="muted mini">${esc(t('Ответ CLI: '))}${esc(String(rawText).slice(0, 200))}</span>` : '');
  b.innerHTML = html;
  const mk = (label, fn, primary) => {
    const btn = document.createElement('button');
    btn.className = 'btn small' + (primary ? ' primary' : ' ghost');
    btn.textContent = t(label);
    btn.onclick = fn;
    b.appendChild(btn);
  };
  if (diag.kind === 'auth') {
    mk('🔐 Войти через аккаунт Claude', startLogin, true);
    mk('🔑 Настроить ключ API', openSidebar);
    mk('❓ Что это значит', () => $('btn-help').click());
  } else if (diag.kind === 'key' || diag.kind === 'quota') {
    mk('🔑 Открыть настройки', openSidebar, true);
  } else if (diag.kind === 'net') {
    mk('🔎 Найти Ollama', () => { openSidebar(); checkOllama(); }, true);
  } else if (diag.kind === 'cli') {
    mk('🔧 Проверить CLI', () => checkCli(true), true);
  }
  scrollDown(true);
}

/* --------------------------- вход через аккаунт --------------------------- */

function startLogin() {
  $('login-modal').classList.remove('hidden');
  const log = $('login-log');
  log.textContent = t('Запускаю вход…');
  api('/api/login', { method: 'POST' }).then(({ runId }) => {
    const es = new EventSource(`/api/run/${runId}/stream`);
    es.onmessage = e => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'log') {
        const m = ev.data.text.match(/https?:\/\/\S+/);
        log.innerHTML = '';
        log.appendChild(document.createTextNode(ev.data.text + '\n'));
        if (m) {
          const a = document.createElement('a');
          a.href = m[0];
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = t('→ Открыть страницу входа в браузере');
          log.appendChild(document.createElement('br'));
          log.appendChild(a);
        }
        log.scrollTop = log.scrollHeight;
      }
      if (ev.type === 'exit') {
        es.close();
        checkAuth().then(ok => {
          log.textContent += '\n' + (ok ? t('✔ Вход выполнен! Можете писать задачу в чат.')
                                 : t('Вход не завершён (код {0}). Попробуйте ещё раз или используйте ключ API.', ev.data.code));
          if (ok) setTimeout(() => $('login-modal').classList.add('hidden'), 1800);
        });
      }
    };
  }).catch(err => { log.textContent = t('Ошибка: ') + err.message; });
}

async function checkAuth() {
  try { state.auth = await api('/api/auth'); } catch { state.auth = null; }
  const loggedIn = !!(state.auth && state.auth.loggedIn);
  const hasKeys = state.config && Object.keys(state.config.env || {}).length > 0;
  const banner = $('warning-banner');
  if (!loggedIn && !hasKeys && !state.homeWarning) {
    banner.innerHTML = `<b>${esc(t('Агент ещё не настроен.'))}</b> ${esc(t('Войдите в аккаунт Claude или укажите ключ API провайдера (OpenAI, Gemini) — или используйте бесплатную локальную Ollama.'))}<br>
      <button id="btn-login" class="btn primary small">${esc(t('🔐 Войти через аккаунт'))}</button>
      <button id="btn-keys" class="btn ghost small">${esc(t('🔑 Настроить ключ'))}</button>`;
    banner.classList.remove('hidden');
    $('btn-login').onclick = startLogin;
    $('btn-keys').onclick = openSidebar;
  } else if (!state.homeWarning) {
    banner.classList.add('hidden');
  }
  return loggedIn;
}

/* ------------------------------ SSE поток ------------------------------ */

function openStream(runId) {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/run/${runId}/stream?from=${state.lastEventSeq}`);
  state.es = es;
  es.onmessage = e => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.seq !== undefined) state.lastEventSeq = ev.seq + 1;
    switch (ev.type) {
      case 'json': applyJsonEvent(ev.data); break;
      case 'log': consoleAppend(ev.data.text, ev.data.stream === 'stderr'); break;
      case 'exit': onRunExit(ev.data); break;
    }
  };
  es.onerror = () => { /* сервер сам закроет поток после exit */ };
}

function onRunExit(info) {
  state.running = false;
  state.runId = null;
  if (state.es) { state.es.close(); state.es = null; }
  if (state.typingEl) { state.typingEl.remove(); state.typingEl = null; }
  setRunningUi(false);
  if (state.session && state.session.sessionId) consoleAppend(t('Сессия сохранена: ') + state.session.sessionId);
  if (info && typeof info.costUsd === 'number' && info.costUsd > 0)
    $('st-cost').textContent = t('последний запрос: $') + info.costUsd.toFixed(4);
  if (info && info.code !== 0 && !info.sessionId) {
    const diag = diagError();
    if (diag) addErrorBlock(diag);
    else toast(t('CLI завершился с ошибкой (код {0}). Подробности в журнале внизу экрана.', info.code));
  }
}

function setRunningUi(on) {
  $('btn-send').disabled = on;
  $('btn-stop').classList.toggle('hidden', !on);
  $('input').placeholder = t(on ? 'Агент работает…' : 'Опишите задачу… (Enter — отправить, Shift+Enter — новая строка)');
}

/* ------------------------------ отправка ------------------------------ */

async function send() {
  const input = $('input');
  const message = input.value.trim();
  if (!message || state.running) return;
  const workspace = $('set-workspace').value.trim();
  if (!workspace) { toast('Сначала укажите рабочую папку в настройках (☰)'); openSidebar(); return; }

  await saveSettings({ silent: true });

  const b = addMessage('user', 'Вы');
  b.textContent = message;
  input.value = '';
  autosize(input);

  state.running = true;
  state.lastEventSeq = 0;
  state.toolsSeen.clear();
  state.authMissingRun = false;
  setRunningUi(true);
  state.typingEl = addTyping();

  const body = { message, workspace };
  if (state.pendingResume) {
    body.resumeId = state.pendingResume.id;
    body.fork = !!state.pendingResume.fork;
  }
  const pendingWasFork = state.pendingResume && state.pendingResume.fork;
  state.pendingResume = null;

  try {
    const r = await api('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    state.runId = r.runId;
    if (r.resume && r.resume.resumeSessionId) state.session = { sessionId: r.resume.resumeSessionId };
    openStream(r.runId);
    if (pendingWasFork) toast('Отвечаю в копии чата', true);
  } catch (e) {
    state.running = false;
    setRunningUi(false);
    if (state.typingEl) { state.typingEl.remove(); state.typingEl = null; }
    addResultLine('❌ ' + e.message);
    toast(e.message);
  }
}

async function stopRun() {
  if (!state.runId) return;
  try { await api('/api/stop/' + state.runId, { method: 'POST' }); } catch {}
}

/* ------------------------------- сессии ------------------------------- */

function updateSessionUi() {
  const has = !!(state.session && state.session.sessionId);
  $('chip-session').classList.toggle('hidden', !has);
  $('st-session').textContent = has ? t('сессия: ') + String(state.session.sessionId).slice(0, 8) + '…' : '';
}
async function newChat() {
  try { await api('/api/session/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: $('set-workspace').value.trim() }) }); } catch {}
  state.session = null;
  state.pendingResume = null;
  updateSessionUi();
  $('messages').innerHTML = '';
  $('empty-state').classList.remove('hidden');
  $('st-cost').textContent = '';
  consoleAppend(t('— новый чат —'));
}

async function continueLast() {
  const ws = $('set-workspace').value.trim();
  if (!ws) { toast('Сначала укажите рабочую папку'); openSidebar(); return; }
  try {
    const r = await api('/api/sessions');
    const mine = r.sessions.filter(s => (s.cwd || '').toLowerCase() === ws.toLowerCase());
    if (!mine.length) {
      toast('В этой папке прошлых чатов нет');
      $('btn-history').click();
      return;
    }
    state.pendingResume = { id: mine[0].id };
    state.session = { sessionId: mine[0].id };
    updateSessionUi();
    toast(t('Продолжаю чат: ') + (mine[0].title || t('без названия')), true);
    $('input').focus();
  } catch (e) { toast(t('Не удалось открыть историю: ') + e.message); }
}

async function openHistory() {
  $('history-modal').classList.remove('hidden');
  const list = $('hist-list');
  list.textContent = t('Загружаю…');
  try {
    const r = await api('/api/sessions');
    const ws = $('set-workspace').value.trim().toLowerCase();
    if (!r.sessions.length) {
      list.innerHTML = '<p class="hint">' + esc(t('Пока нет сохранённых чатов. Они появятся после первого запроса.')) + '</p>';
      return;
    }
    list.innerHTML = '';
    const sorted = r.sessions.slice().sort((a, b) => {
      const aw = (a.cwd || '').toLowerCase() === ws ? 0 : 1;
      const bw = (b.cwd || '').toLowerCase() === ws ? 0 : 1;
      return aw - bw || b.mtime - a.mtime;
    });
    for (const s of sorted) {
      const el = document.createElement('div');
      el.className = 'hist-item' + ((s.cwd || '').toLowerCase() === ws ? ' current' : '');
      const when = new Date(s.mtime).toLocaleString(LANG === 'ru' ? 'ru-RU' : 'en-US');
      const folder = s.cwd || '';
      el.innerHTML = `<div class="hist-main">
          <div class="hist-title">${esc(s.title)}</div>
          <div class="hist-meta">${esc(when)} · 📁 ${esc(folder)}</div>
        </div>
        <button class="btn ghost small hist-go">${esc(t('Продолжить'))}</button>
        <button class="icon-btn hist-del" title="${esc(t('Удалить чат'))}">🗑</button>`;
      el.querySelector('.hist-go').onclick = () => {
        state.pendingResume = { id: s.id, fork: $('hist-fork').checked };
        state.session = { sessionId: s.id };
        updateSessionUi();
        $('history-modal').classList.add('hidden');
        toast(state.pendingResume.fork ? 'Следующий ответ — в копии чата' : 'Чат выбран — пишите сообщение', true);
        $('input').focus();
      };
      el.querySelector('.hist-del').onclick = async () => {
        if (!confirm(t('Удалить чат «{0}»? Это действие необратимо.', s.title || t('без названия')))) return;
        try {
          const r = await api('/api/session/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: s.id }) });
          if (!r.deleted) { toast('Файл чата не найден (уже удалён)'); el.remove(); return; }
          el.remove();
          if (state.session && state.session.sessionId === s.id) { state.session = null; state.pendingResume = null; updateSessionUi(); }
          if (state.pendingResume && state.pendingResume.id === s.id) state.pendingResume = null;
          toast('Чат удалён', true);
        } catch (e) { toast(t('Не удалось удалить: ') + e.message); }
      };
      list.appendChild(el);
    }
  } catch (e) {
    list.innerHTML = '<p class="hint">' + esc(t('Ошибка: ') + e.message) + '</p>';
  }
}

/* ------------------------------ настройки ------------------------------ */

function envRows() {
  const wrap = $('env-editor');
  const rows = [];
  for (const row of wrap.querySelectorAll('.env-row')) {
    const k = row.querySelector('.env-key').value.trim();
    const v = row.querySelector('.env-val').value;
    if (k) rows.push([k, v]);
  }
  return rows;
}
function addEnvRow(key, val) {
  const wrap = $('env-editor');
  const row = document.createElement('div');
  row.className = 'env-row';
  row.innerHTML = `<input class="env-key" type="text" placeholder="${esc(t('ПЕРЕМЕННАЯ'))}" value="${esc(key || '')}">
                   <input class="env-val" type="password" placeholder="${esc(t('значение'))}" value="${esc(val || '')}">
                   <button class="icon-btn env-del" title="${esc(t('Удалить'))}">✕</button>`;
  row.querySelector('.env-del').onclick = () => row.remove();
  const valInp = row.querySelector('.env-val');
  valInp.addEventListener('dblclick', () => { valInp.type = valInp.type === 'password' ? 'text' : 'password'; });
  wrap.appendChild(row);
}
function applyPreset(name) {
  const p = PRESETS[name];
  $('env-editor').innerHTML = '';
  $('provider-hint').textContent = p ? t(p.hint) : '';
  if (p) {
    $('set-provider-flag').value = p.provider;
    for (const [k, v] of Object.entries(p.env)) addEnvRow(k, v);
    if (name === 'ollama') checkOllama();
  }
}

function linesToArray(text) {
  return String(text || '').split('\n').map(s => s.trim()).filter(Boolean);
}

function fillSettingsForm(cfg) {
  $('set-cmd').value = cfg.openclaudeCmd || 'openclaude';
  $('set-workspace').value = cfg.workspace || '';
  $('ws-list').innerHTML = (cfg.workspaces || []).map(w => `<option value="${esc(w)}">`).join('');
  $('ws-label').textContent = cfg.workspace || t('папка не выбрана');
  $('set-provider').value = cfg.provider && PRESETS[cfg.provider] ? cfg.provider : '';
  $('set-provider-flag').value = cfg.provider || '';
  $('set-model').value = cfg.model || '';
  $('set-fallback').value = cfg.fallbackModel || '';
  $('set-effort').value = cfg.effort || '';
  $('set-sysprompt').value = cfg.systemPrompt || '';
  $('set-adddirs').value = (cfg.addDirs || []).join('\n');
  $('set-mcp').value = (cfg.mcpConfigs || []).join('\n');
  $('set-allowed').value = cfg.allowedTools || '';
  $('set-disallowed').value = cfg.disallowedTools || '';
  $('set-maxturns').value = cfg.maxTurns || 0;
  $('set-budget').value = cfg.maxBudgetUsd || 0;
  document.querySelector(`input[name=perm][value="${cfg.permissionMode || 'acceptEdits'}"]`).checked = true;

  $('env-editor').innerHTML = '';
  const env = cfg.env || {};
  if (Object.keys(env).length) {
    $('provider-hint').textContent = '';
    for (const [k, v] of Object.entries(env)) addEnvRow(k, v);
  } else if (cfg.provider && PRESETS[cfg.provider]) {
    applyPreset(cfg.provider);
  }
}

async function saveSettings(opts) {
  const env = {};
  for (const [k, v] of envRows()) env[k] = v;
  const body = {
    openclaudeCmd: $('set-cmd').value.trim() || 'openclaude',
    workspace: $('set-workspace').value.trim(),
    provider: $('set-provider-flag').value.trim(),
    env,
    permissionMode: document.querySelector('input[name=perm]:checked').value,
    allowedTools: $('set-allowed').value.trim(),
    disallowedTools: $('set-disallowed').value.trim(),
    model: $('set-model').value.trim(),
    fallbackModel: $('set-fallback').value.trim(),
    effort: $('set-effort').value,
    systemPrompt: $('set-sysprompt').value,
    addDirs: linesToArray($('set-adddirs').value),
    mcpConfigs: linesToArray($('set-mcp').value),
    maxTurns: parseInt($('set-maxturns').value, 10) || 0,
    maxBudgetUsd: parseFloat($('set-budget').value) || 0
  };
  try {
    await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    state.config = Object.assign(state.config || {}, body);
    $('ws-label').textContent = body.workspace || t('папка не выбрана');
    if (!opts || !opts.silent) $('save-status').textContent = t('Сохранено ✔ ({0})', new Date().toLocaleTimeString());
  } catch (e) {
    $('save-status').textContent = t('Ошибка: ') + e.message;
    if (!opts || !opts.silent) toast(t('Не удалось сохранить настройки: ') + e.message);
  }
}

/* -------------------------- проверка соединения -------------------------- */

async function testConnection() {
  const box = $('test-result');
  await saveSettings({ silent: true });
  box.classList.remove('hidden', 'ok', 'err');
  box.classList.add('muted');
  box.textContent = t('Проверяю… (уходит один короткий запрос)');
  $('btn-test').disabled = true;
  let lastText = '', hadError = false, errTail = '';
  try {
    const { runId } = await api('/api/test-connection', { method: 'POST' });
    const es = new EventSource(`/api/run/${runId}/stream`);
    es.onmessage = e => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'json') {
        const d = ev.data;
        if (d.type === 'assistant' && d.message && Array.isArray(d.message.content))
          lastText = (d.message.content.find(b => b.type === 'text') || {}).text || lastText;
        if (d.type === 'result' && d.is_error) hadError = true;
      }
      if (ev.type === 'log' && ev.data.stream === 'stderr') errTail = (ev.data.text + '\n' + errTail).split('\n').slice(0, 3).join('\n');
      if (ev.type === 'exit') {
        es.close();
        $('btn-test').disabled = false;
        if (ev.data.code === 0 && !hadError) {
          box.className = 'mini testok';
          box.textContent = t('✔ Соединение работает') + (lastText ? t(' — ответ: ') + '«' + lastText.trim().slice(0, 60) + '»' : '');
        } else {
          box.className = 'mini testerr';
          box.textContent = t('✖ Не получилось (код {0})', ev.data.code) + '\n' + (errTail || t('См. журнал внизу экрана'));
        }
      }
    };
    es.onerror = () => { /* закрытие после exit обрабатывается выше */ };
  } catch (e) {
    $('btn-test').disabled = false;
    box.className = 'mini testerr';
    box.textContent = '✖ ' + e.message;
  }
}

/* -------------------------- проверка CLI/версий -------------------------- */

function cliChip() {
  const chip = $('chip-cli');
  const st = $('st-cli');
  if (state.cli && state.cli.found) {
    chip.textContent = '✔ openclaude ' + state.cli.version;
    chip.className = 'chip ok';
    st.textContent = 'openclaude: ' + state.cli.version;
  } else {
    chip.textContent = t('✖ openclaude не найден');
    chip.className = 'chip bad';
    st.textContent = t('openclaude: не найден');
  }
}

async function checkCli(showOnboardIfMissing) {
  try { state.cli = await api('/api/check'); } catch { state.cli = { found: false }; }
  cliChip();
  $('cli-status').textContent = state.cli.found
    ? t('Найден: ') + state.cli.version
    : t('Не найден в PATH. Установите командой ниже или укажите путь.');
  $('ob-cli-state').textContent = state.cli.found ? t('уже установлен ({0})', state.cli.version) : t('не найден');
  $('ob-install').disabled = state.cli.found;
  if (!state.cli.found && showOnboardIfMissing) $('onboarding').classList.remove('hidden');
}

async function installOpenclaude() {
  const log = $('ob-log');
  log.classList.remove('hidden');
  log.textContent = t('Устанавливаю @twigpine/openclaude (может занять минуту)…') + '\n';
  $('ob-install').disabled = true;
  try {
    const { runId } = await api('/api/install', { method: 'POST' });
    const es = new EventSource(`/api/run/${runId}/stream`);
    es.onmessage = e => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'log') { log.textContent += ev.data.text + '\n'; log.scrollTop = log.scrollHeight; }
      if (ev.type === 'exit') {
        es.close();
        log.textContent += '\n' + (ev.data.code === 0 ? t('✔ Установка завершена') : t('✖ Ошибка (код {0})', ev.data.code));
        checkCli(true);
      }
    };
  } catch (e) { log.textContent += t('Ошибка: ') + e.message; }
}

function showHomeWarning() {
  const w = state.homeWarning;
  const banner = $('warning-banner');
  if (!w) { banner.classList.add('hidden'); return; }
  banner.innerHTML = `<b>${esc(t('Настройки CLI не найдены.'))}</b> ${esc(t(w.hint))}
    ${w.backupExists ? '<br><button id="btn-restore" class="btn ghost small">' + esc(t('Восстановить из резервной копии (.claude.json.backup)')) + '</button>' : ''}`;
  banner.classList.remove('hidden');
  const btn = $('btn-restore');
  if (btn) btn.onclick = async () => {
    try {
      await api('/api/restore-config', { method: 'POST' });
      banner.classList.add('hidden');
      toast('Конфигурация восстановлена', true);
    } catch (e) { toast(e.message); }
  };
}

/* --------------------------- файлы рабочей папки --------------------------- */

async function openFiles(rel) {
  const ws = $('set-workspace').value.trim();
  if (!ws) { toast('Сначала укажите рабочую папку в настройках (☰)'); openSidebar(); return; }
  $('files-modal').classList.remove('hidden');
  const list = $('files-list');
  list.textContent = t('Загружаю…');
  try {
    const r = await api('/api/files' + (rel ? '?path=' + encodeURIComponent(rel) : ''));
    $('files-crumb').textContent = t('Папка: ') + (r.isRoot ? t('(корень рабочей папки)') : r.path);
    list.innerHTML = '';
    if (!r.isRoot) {
      const up = document.createElement('div');
      up.className = 'hist-item';
      const parent = rel.includes('/') || rel.includes('\\') ? rel.replace(/[\\/][^\\/]+$/, '') : '';
      up.innerHTML = `<div class="hist-main"><div class="hist-title">⬆ ..</div></div>`;
      up.onclick = () => openFiles(parent);
      list.appendChild(up);
    }
    if (!r.items.length && r.isRoot) {
      list.innerHTML = '<p class="hint">' + esc(t('Папка пуста. Можно загрузить сюда файл кнопкой снизу.')) + '</p>';
      return;
    }
    for (const it of r.items) {
      const el = document.createElement('div');
      el.className = 'hist-item';
      const full = r.isRoot ? it.name : r.path.replace(/\\/g, '/') + '/' + it.name;
      const size = it.dir ? '' : ' · ' + (it.size < 1024 ? it.size + ' ' + t('Б') : (it.size / 1024).toFixed(1) + ' ' + t('КБ'));
      el.innerHTML = `<div class="hist-main"><div class="hist-title">${it.dir ? '📁' : '📄'} ${esc(it.name)}</div>
        <div class="hist-meta">${esc(it.dir ? t('папка') : t('файл') + size)}</div></div>`;
      el.onclick = () => {
        if (it.dir) openFiles(full);
        else {
          $('files-modal').classList.add('hidden');
          const input = $('input');
          input.value = t('Открой файл {0} и объясни простыми словами, что он делает', full);
          autosize(input);
          input.focus();
        }
      };
      list.appendChild(el);
    }
    openFiles._currentDir = r.isRoot ? '' : r.path;
  } catch (e) {
    list.innerHTML = '<p class="hint">' + esc(t('Ошибка: ') + e.message) + '</p>';
  }
}

async function uploadFile(file) {
  const dir = openFiles._currentDir || '';
  try {
    const buf = await file.arrayBuffer();
    const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name) + '&dir=' + encodeURIComponent(dir), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf
    });
    const j = await r.json();
    if (!r.ok) throw new Error(t(j.error || ('HTTP ' + r.status)));
    toast(t('Файл загружен: ') + j.path, true);
    openFiles(dir);
  } catch (e) { toast(t('Загрузка не удалась: ') + e.message); }
}

/* ------------------------------- Ollama ------------------------------- */

function ensureEnvRow(key) {
  for (const row of document.querySelectorAll('#env-editor .env-row')) {
    if (row.querySelector('.env-key').value.trim().toUpperCase() === key.toUpperCase())
      return row.querySelector('.env-val');
  }
  addEnvRow(key, '');
  const rows = document.querySelectorAll('#env-editor .env-row');
  return rows[rows.length - 1].querySelector('.env-val');
}

async function checkOllama() {
  const box = $('ollama-status');
  box.classList.remove('hidden');
  box.className = 'mini muted';
  box.textContent = t('Ищу запущенный Ollama…');
  try {
    const r = await api('/api/ollama');
    if (!r.running) {
      box.className = 'mini';
      box.textContent = t('Ollama не запущен. Установите его с ollama.com, затем выполните в терминале: ollama pull qwen2.5-coder:7b');
      return;
    }
    box.className = 'mini testok';
    box.textContent = '';
    const head = document.createElement('div');
    head.textContent = t('✔ Ollama запущен. Модели (кликните, чтобы подставить):');
    box.appendChild(head);
    if (!r.models.length) {
      const note = document.createElement('div');
      note.textContent = t('Моделей нет — скачайте хотя бы одну: ollama pull qwen2.5-coder:7b');
      box.appendChild(note);
    }
    const chips = document.createElement('div');
    chips.className = 'row';
    for (const m of r.models) {
      const c = document.createElement('button');
      c.className = 'btn ghost tiny model-chip';
      c.textContent = m;
      c.onclick = () => {
        const val = ensureEnvRow('OPENAI_MODEL');
        val.value = m;
        toast(t('Модель подставлена: ') + m, true);
      };
      chips.appendChild(c);
    }
    box.appendChild(chips);
  } catch (e) {
    box.className = 'mini testerr';
    box.textContent = t('Ошибка проверки: ') + e.message;
  }
}

/* ------------------------------ панель (sidebar) ------------------------------ */

// Приветствие показываем при первом запуске, даже если CLI уже установлен.
function onboardingSeen() { try { return localStorage.getItem('ocui.onboarded') === '1'; } catch { return false; } }
function closeOnboarding() {
  $('onboarding').classList.add('hidden');
  try { localStorage.setItem('ocui.onboarded', '1'); } catch {}
}

function openSidebar() { $('sidebar').classList.add('open'); }
function closeSidebar() { $('sidebar').classList.remove('open'); }

/* --------------------------------- init --------------------------------- */

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
}

async function init() {
  $('st-node').textContent = 'node: …';

  try {
    const st = await api('/api/state');
    state.config = st.config;
    state.session = st.session;
    state.cli = st.cli;
    state.homeWarning = st.homeConfigWarning;
    $('st-node').textContent = 'node: ' + st.node.replace('v', '');
    fillSettingsForm(st.config);
    updateSessionUi();
    showHomeWarning();
    checkAuth();
  } catch (e) {
    toast(t('Сервер недоступен: ') + e.message);
    return;
  }

  cliChip();
  checkCli(false).then(() => { if (!onboardingSeen()) $('onboarding').classList.remove('hidden'); });

  // события UI
  $('btn-send').onclick = send;
  $('btn-stop').onclick = stopRun;
  $('btn-newchat').onclick = newChat;
  $('chip-session').onclick = newChat;
  $('btn-continue').onclick = continueLast;
  $('btn-history').onclick = openHistory;
  $('hist-close').onclick = () => $('history-modal').classList.add('hidden');
  $('btn-files').onclick = () => openFiles('');
  $('files-close').onclick = () => $('files-modal').classList.add('hidden');
  $('files-upload').onclick = () => $('files-input').click();
  $('files-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) uploadFile(f);
    e.target.value = '';
  });
  $('btn-ollama').onclick = checkOllama;
  $('btn-help').onclick = () => $('help-modal').classList.remove('hidden');
  $('help-close').onclick = () => $('help-modal').classList.add('hidden');
  $('side-open').onclick = openSidebar;
  $('side-close').onclick = closeSidebar;
  $('ws-chip').onclick = openSidebar;
  $('btn-save').onclick = () => saveSettings();
  $('btn-recheck').onclick = () => checkCli(false);
  $('btn-add-env').onclick = () => addEnvRow('', '');
  $('btn-test').onclick = testConnection;
  $('btn-mkdir').onclick = async () => {
    const p = $('set-workspace').value.trim();
    if (!p) return toast('Введите путь новой папки в поле «Путь к папке»');
    try {
      const r = await api('/api/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
      $('set-workspace').value = r.path;
      toast(t('Папка создана: ') + r.path, true);
    } catch (e) { toast(e.message); }
  };
  $('btn-open-folder').onclick = async () => {
    const p = $('set-workspace').value.trim();
    if (!p) return toast('Сначала укажите папку');
    try { await api('/api/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) }); }
    catch (e) { toast(e.message); }
  };
  $('btn-open-term').onclick = async () => {
    const p = $('set-workspace').value.trim();
    if (!p) return toast('Сначала укажите папку');
    try { await api('/api/open-terminal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) }); }
    catch (e) { toast(e.message); }
  };
  $('set-provider').onchange = e => applyPreset(e.target.value);
  $('login-close').onclick = () => $('login-modal').classList.add('hidden');
  $('ob-install').onclick = installOpenclaude;
  $('ob-recheck').onclick = () => checkCli(true);
  $('ob-close').onclick = closeOnboarding;
  $('ob-settings').onclick = () => { closeOnboarding(); openSidebar(); };
  $('ob-plan').onclick = async () => {
    document.querySelector('input[name=perm][value="plan"]').checked = true;
    await saveSettings({ silent: true });
    toast('Режим «Только план» включён', true);
  };
  for (const b of document.querySelectorAll('.tools-preset'))
    b.onclick = () => { $('set-allowed').value = b.dataset.tools; };
  $('btn-lang').textContent = LANG === 'ru' ? 'EN' : 'RU';
  $('btn-lang').onclick = () => {
    if (state.running) return toast('Дождитесь окончания работы агента');
    setLang(LANG === 'ru' ? 'en' : 'ru');
  };

  const input = $('input');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', () => autosize(input));
  for (const tip of document.querySelectorAll('.tip'))
    tip.onclick = () => { input.value = tip.textContent.replace(/[«»“”]/g, ''); autosize(input); input.focus(); };

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeSidebar();
      $('history-modal').classList.add('hidden');
      $('help-modal').classList.add('hidden');
      $('login-modal').classList.add('hidden');
      $('files-modal').classList.add('hidden');
    }
    if (e.key === 'F1') { e.preventDefault(); $('help-modal').classList.remove('hidden'); }
  });
}

init();
