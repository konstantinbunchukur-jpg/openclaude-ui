#!/usr/bin/env node
/* Фиктивный openclaude для проверки интерфейса: читает stdin, выдаёт stream-json,
 * а полученные флаги печатает в stderr — чтобы тесты могли проверить передачу аргументов. */
'use strict';

const argv = process.argv.slice(2);
process.stderr.write('mock: argv: ' + JSON.stringify(argv) + '\n');

// --version не должен ждать stdin, иначе проверка наличия CLI зависает
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('0.33.0 (mock-openclaude)\n');
  process.exit(0);
}

let resume = null, cont = false, fork = false, spFile = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--resume') resume = argv[i + 1] || 'mock-session';
  if (argv[i] === '--continue') cont = true;
  if (argv[i] === '--fork-session') fork = true;
  if (argv[i] === '--append-system-prompt-file') spFile = argv[i + 1];
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => prompt += d);
process.stdin.on('end', () => {
  const sid = resume || 'mock-' + Math.random().toString(36).slice(2, 10);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  process.stderr.write('mock: предупреждение для проверки журнала\n');

  (async () => {
    const send = o => process.stdout.write(JSON.stringify(o) + '\n');
    const spNote = spFile ? require('fs').readFileSync(spFile, 'utf8').trim().slice(0, 40) : null;
    send({ type: 'system', subtype: 'init', session_id: sid, model: 'mock-model' });
    await sleep(120);
    const head = 'Принял запрос: **' + prompt.trim().slice(0, 50) + '**'
      + (cont ? ' [continue]' : '') + (fork ? ' [fork]' : '')
      + (spNote ? '\nИнструкция: ' + spNote : '');
    send({ type: 'assistant', message: { content: [{ type: 'text', text: head + '\n\nСейчас покажу пример кода:' }] } });
    await sleep(120);
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hello from mock' } }] } });
    await sleep(120);
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hello from mock' }] } });
    await sleep(120);
    send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Готово.\n\n```js\nconsole.log("hello");\n```' }] } });
    send({ type: 'result', subtype: 'success', is_error: false, duration_ms: 480, num_turns: 2, total_cost_usd: 0.0042, result: 'ok', session_id: sid });
    process.exit(0);
  })();
});
