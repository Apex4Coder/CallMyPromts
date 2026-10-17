// tests/unit/gates-secret.test.mjs — гейт секретов.
//
// Требование: REQ-GATE-SECRET (docs/SPEC.md §10).
// Проверяемый файл: gates/secret-check.mjs.
// Трасса и храповик — в tests/unit/gates-trace.test.mjs, границы — в gates.test.mjs,
// размер — в gates-chunk.test.mjs.
//
// Выделено из gates-trace.test.mjs, когда тот вышел за 300 строк. Гейт, который
// сам не проходит проверку размера, не имеет права требовать её от остальных.
//
// Гейт секретов существует ради одного: библиотека промптов уходит в Git, промпты
// пишутся руками, и ключ из соседнего окна попадает в них легко. Журнал буфера не
// синхронизируется никогда, но и там секреты не должны лежать в открытом виде.
//
// Половина проверок здесь — про ЛОЖНЫЕ срабатывания. Гейт, который кричит на
// `X-Deck-Token` и `__DECK_TOKEN__`, будет отключён через неделю, и тогда он не
// поймает настоящий ключ.

import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkSecret, PATTERNS } from '../../gates/verify.mjs';

import { tempRoot, cleanup } from '../helpers/harness.mjs';
import { put, cleanProject } from '../helpers/project.mjs';

const said = (res) => res.items.map((i) => `${i.path}:${i.line ?? '-'} ${i.message}`).join('\n');

/**
 * Секрет по форме, но не по существу: значение собрано из частей.
 * Иначе этот файл сам стал бы нарушением — гейт нашёл бы в нём то, что он ищет.
 */
const shape = (...bits) => bits.join('');

// ── чистый проект ────────────────────────────────────────────────────────────

test('на чистом проекте гейт секретов молчит', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    assert.equal(checkSecret(root).count, 0, said(checkSecret(root)));
  } finally { cleanup(root); }
});

// ── находит ──────────────────────────────────────────────────────────────────

test('каждый известный вид секрета в коде поймана', () => {
  const cases = {
    'ключ OpenAI': shape('sk', '-', 'a'.repeat(32)),
    'токен GitHub': shape('ghp', '_', 'b'.repeat(36)),
    'токен Slack': shape('xox', 'b-', 'c'.repeat(24)),
    'ключ AWS': shape('AKIA', 'ABCDEFGHIJKLMNOP'),
    'приватный ключ': shape('-----BEGIN RSA ', 'PRIVATE', ' KEY-----'),
  };

  for (const [name, value] of Object.entries(cases)) {
    const root = tempRoot();
    try {
      cleanProject(root);
      put(root, 'core/index.mjs', `export const KEY = '${value}';\n`);

      assert.match(said(checkSecret(root)), new RegExp(`секрет вида «${name}»`), `${name}: не поймана`);
    } finally { cleanup(root); }
  }
});

test('секрет в промпте поймана: промпты уходят в Git', () => {
  // Журнал буфера не синхронизируется никогда, а библиотека — синхронизируется.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'prompts/code/x.md', `---\nid: x\n---\n\nМой ключ: ${shape('sk', '-', 'z'.repeat(32))}\n`);

    assert.match(said(checkSecret(root)), /prompts\/code\/x\.md/);
  } finally { cleanup(root); }
});

test('значение секрета в отчёт не попадает', () => {
  // Иначе гейт печатал бы секрет в лог сборки — там он живёт дольше, чем в коде.
  const root = tempRoot();
  try {
    cleanProject(root);
    const value = shape('sk', '-', 'q'.repeat(32));
    put(root, 'core/index.mjs', `export const KEY = '${value}';\n`);

    assert.equal(said(checkSecret(root)).includes(value), false, 'секрет напечатан в отчёте');
  } finally { cleanup(root); }
});

test('пароль в коде поймана', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', `export const CFG = { ${shape('pass', 'word')}: '${shape('very', 'Secret', '123')}' };\n`);

    assert.match(said(checkSecret(root)), /секрет вида «пароль в коде»/);
  } finally { cleanup(root); }
});

test('строка подключения с логином и паролем поймана', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', `export const DB = '${shape('postgres://', 'user', ':', 'pw123', '@host:5432/db')}';\n`);

    assert.match(said(checkSecret(root)), /секрет вида «строка подключения»/);
  } finally { cleanup(root); }
});

// ── форма сообщения ──────────────────────────────────────────────────────────

test('название вида секрета читается как метка, а не как часть фразы', () => {
  // Сообщение собирается подстановкой, и без кавычек фраза требовала бы
  // винительного падежа: «похоже на строка подключения». Восемь названий в
  // разных родах — восемь поводов для безграмотного текста, поэтому название
  // взято в кавычки один раз для всех.
  //
  // Проверяется форма, а не отсутствие слов: первая версия искала «похоже на» с
  // буквой после и падала на самой же исправленной фразе «похоже на секрет
  // вида…». Запрет по отрицанию здесь бессмысленен — значение имеет структура.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', `export const DB = '${shape('mysql://', 'root', ':', 'toor12', '@localhost/db')}';\n`);

    const bad = checkSecret(root).items.find((i) => i.path === 'core/index.mjs');
    assert.match(bad.message, /^похоже на секрет вида «[^»]+» — /, bad.message);
  } finally { cleanup(root); }
});

test('вид секрета в сообщении совпадает с названием из таблицы', () => {
  // Иначе сообщение говорило бы одно, а таблица шаблонов — другое, и найти
  // соответствующий шаблон по отчёту было бы нельзя.
  const known = new Set(PATTERNS.map(([name]) => name));
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', `export const KEY = '${shape('sk', '-', 'w'.repeat(32))}';\n`);

    const bad = checkSecret(root).items.find((i) => i.path === 'core/index.mjs');
    const name = /«([^»]+)»/.exec(bad.message)?.[1];

    assert.equal(known.has(name), true, `«${name}» отсутствует в таблице шаблонов`);
  } finally { cleanup(root); }
});

// ── не ложно срабатывает ─────────────────────────────────────────────────────

test('метка токена в разметке секретом не считается', () => {
  // `__DECK_TOKEN__` — место, куда сервер подставляет токен при отдаче HTML.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/page.html', '<script>window.DECK_TOKEN = "__DECK_TOKEN__";</script>\n');

    assert.equal(checkSecret(root).count, 0, said(checkSecret(root)));
  } finally { cleanup(root); }
});

test('имя заголовка секретом не считается', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', "export const HEADER = 'X-Deck-Token';\n");

    assert.equal(checkSecret(root).count, 0, said(checkSecret(root)));
  } finally { cleanup(root); }
});

test('обычный код секретом не считается', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', [
      'export const login = async (user) => {',
      '  const token = await fetchToken(user);',
      '  return { token, password: null };',
      '};',
      '',
    ].join('\n'));

    assert.equal(checkSecret(root).count, 0, said(checkSecret(root)));
  } finally { cleanup(root); }
});

// ── state вне Git ────────────────────────────────────────────────────────────

test('отсутствие .gitignore поймано с объяснением', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n', 'utf8');

    assert.match(said(checkSecret(root)), /нет строки «state\/».*попадёт в Git/s);
  } finally { cleanup(root); }
});

test('state в .gitignore достаточно', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    writeFileSync(join(root, '.gitignore'), 'state\n', 'utf8');

    const complaints = checkSecret(root).items.filter((i) => i.path === '.gitignore');
    assert.equal(complaints.length, 0, said(checkSecret(root)));
  } finally { cleanup(root); }
});
