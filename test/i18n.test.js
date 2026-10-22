// Every Russian UI string must have an English translation; reads source files only.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

function loadI18n(lang) {
  const html = { lang: '' };
  const context = {
    localStorage: { getItem: () => lang, setItem() {} },
    navigator: { language: lang }, location: { reload() {} },
    document: { documentElement: html, body: null }
  };
  vm.runInNewContext(read('public/i18n.js') + '\n;this.EN = EN; this.t = t; this.LANG = LANG;', context);
  return { ...context, htmlLang: html.lang };
}

const cyr = /[А-Яа-яЁё]/;
const { EN, t } = loadI18n('en');
const known = s => Object.prototype.hasOwnProperty.call(EN, s) || Object.keys(EN).some(k => k.endsWith(': ') && s.startsWith(k));

test('t() translates exact keys, prefixes and placeholders, keeps unknown text', () => {
  assert.equal(t('Закрыть'), 'Close');
  assert.equal(t('Рабочая папка не существует: C:\\x'), 'Workspace folder does not exist: C:\\x');
  assert.equal(t('✖ Ошибка (код {0})', 7), '✖ Error (code 7)');
  assert.equal(t('unknown text'), 'unknown text');
  const ru = loadI18n('ru');
  assert.equal(ru.htmlLang, 'ru');
  assert.equal(ru.t('Закрыть'), 'Закрыть');
  assert.equal(ru.t('✖ Ошибка (код {0})', 7), '✖ Ошибка (код 7)');
});

test('every Russian string literal in app.js has an English translation', () => {
  const code = read('public/app.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const russian = [...code.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map(m => m[1].replace(/\\n/g, '\n'))
    .filter(s => cyr.test(s));
  assert.ok(russian.length > 80, 'literal scan found too few strings: ' + russian.length);
  assert.deepEqual(russian.filter(s => !known(s)), []);
});

test('every Russian API error message in server.js has an English translation', () => {
  const code = read('server.js');
  const errors = [...code.matchAll(/error: '([^']+)'/g), ...code.matchAll(/hint: '([^']+)'/g)].map(m => m[1]).filter(s => cyr.test(s));
  assert.ok(errors.length > 10);
  assert.deepEqual(errors.filter(s => !known(s)), []);
});

test('every Russian text and title/placeholder in index.html has an English translation', () => {
  // Long help text is duplicated as data-ru/data-en blocks instead of the dictionary.
  const html = read('public/index.html').replace(/<!--[\s\S]*?-->/g, '').replace(/<div data-ru>[\s\S]*?<\/div>\s*(?=\s*<div data-en>)/g, '');
  const texts = [...html.matchAll(/>([^<>]+)</g)].map(m => m[1].trim());
  const attrs = [...html.matchAll(/(?:title|placeholder)="([^"]+)"/g)].map(m => m[1]);
  const russian = [...texts, ...attrs].filter(s => cyr.test(s) && s !== 'Язык интерфейса / Interface language');
  assert.ok(russian.length > 100, 'HTML scan found too few strings: ' + russian.length);
  const missing = russian.filter(s => !known(s));
  assert.deepEqual(missing, []);
});
