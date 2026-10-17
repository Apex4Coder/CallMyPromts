// tests/unit/prompt-schema.test.mjs — схема промпта и её правила V-P-*.
//
// Требование: REQ-CT-PROMPT (docs/SPEC.md §2). Правила: DATA-CONTRACTS §1.3.
//
// Разделение уровней проверяется отдельно, потому что от него зависит поведение:
// `bad` блокирует вставку, `warn` только предупреждает. Ошибка в уровне означает
// либо неработающий промпт без объяснения, либо мусор, улетевший в чат.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withDefaults, validatePrompt, validateUnique, FIELD_ORDER, MACHINE_FIELDS } from '../../contracts/index.mjs';

const ok = { id: 'c-review', title: 'Ревью кода', group: 'code' };
const check = (over = {}, body = 'Тело промпта.', ctx = {}) => validatePrompt(
  withDefaults({ ...ok, ...over }),
  body,
  { hasFrontmatter: true, ...ctx },
);

const codes = (issues) => issues.map((i) => i.code);
const level = (issues, code) => issues.find((i) => i.code === code)?.level;

test('валидный промпт не даёт замечаний', () => {
  assert.deepEqual(check(), []);
});

test('withDefaults заполняет поля, но не придумывает id', () => {
  const meta = withDefaults({});
  assert.equal(meta.id, null);
  assert.equal(meta.status, 'active');
  assert.equal(meta.used, 0);
  assert.equal(meta.pin, null);
  assert.deepEqual(meta.tags, []);
});

test('V-P-1 нет frontmatter — bad: без метаданных промпт не отличить от заметки', () => {
  const issues = check({}, 'тело', { hasFrontmatter: false });
  assert.ok(codes(issues).includes('V-P-1'));
  assert.equal(level(issues, 'V-P-1'), 'bad');
});

test('V-P-1 различает «нет вовсе» и «не закрыт»', () => {
  const none = check({}, 'тело', { hasFrontmatter: false, reason: 'no_fence' });
  const open = check({}, 'тело', { hasFrontmatter: false, reason: 'unclosed' });

  assert.match(none.find((i) => i.code === 'V-P-1').message, /не начинается/);
  assert.match(open.find((i) => i.code === 'V-P-1').message, /не закрыт/);
});

test('V-P-2 недопустимый id — bad', () => {
  for (const id of ['', 'Верхний', 'с пробелом', '1начинается-с-цифры', 'a'.repeat(45)]) {
    const issues = check({ id });
    assert.ok(codes(issues).includes('V-P-2'), `id «${id}» должен быть отвергнут`);
    assert.equal(level(issues, 'V-P-2'), 'bad');
  }
});

test('V-P-3 пустой title — bad: в списке нужна читаемая строка', () => {
  const issues = check({ title: '   ' });
  assert.equal(level(issues, 'V-P-3'), 'bad');
});

test('V-P-3 слишком длинный title — только warn: промпт остаётся рабочим', () => {
  const issues = check({ title: 'о'.repeat(80) });
  assert.equal(level(issues, 'V-P-3'), 'warn');
});

test('V-P-4 pin вне 1..9 — bad', () => {
  for (const pin of [0, 10, -1, 3.5]) {
    assert.equal(level(check({ pin }), 'V-P-4'), 'bad', `pin ${pin} должен быть отвергнут`);
  }
  assert.deepEqual(check({ pin: 9 }), [], 'pin 9 допустим');
});

test('V-P-5 и V-P-6 неверный формат хоткея и триггера — warn: каналы опциональные', () => {
  assert.equal(level(check({ hotkey: 'просто-текст' }), 'V-P-5'), 'warn');
  assert.equal(level(check({ trigger: 'без-двоеточия' }), 'V-P-6'), 'warn');
});

test('V-P-7 группа не совпадает с папкой — warn с указанием папки', () => {
  const issues = check({ group: 'core' }, 'тело', { folder: 'code' });
  const issue = issues.find((i) => i.code === 'V-P-7');
  assert.equal(issue.level, 'warn');
  assert.equal(issue.expected, 'code');
});

test('V-P-8 пустое тело — bad: вставлять пустоту нельзя', () => {
  assert.equal(level(check({}, '   \n  '), 'V-P-8'), 'bad');
});

test('V-P-9 updated раньше created — warn', () => {
  assert.equal(level(check({ created: '2026-05-01', updated: '2026-01-01' }), 'V-P-9'), 'warn');
});

test('V-P-10 HTML в теле — warn: разметка уйдёт в чат', () => {
  assert.equal(level(check({}, '<p style="x">текст</p>'), 'V-P-10'), 'warn');
});

// Через чтение библиотеки текст приходит УЖЕ очищенным (DATA-CONTRACTS §1.4),
// поэтому проверка по тексту там не срабатывает. Факт очистки — единственный
// способ узнать, что в файле осталась разметка.
test('V-P-10 срабатывает по факту очистки, а не только по тексту', () => {
  const issues = check({}, 'чистый текст после очистки', { cleaned: ['html'] });
  assert.equal(level(issues, 'V-P-10'), 'warn');
  assert.match(issues.find((i) => i.code === 'V-P-10').message, /в файле остался HTML/);
});

test('V-P-11 срабатывает по факту снятия префикса TODO', () => {
  assert.equal(level(check({}, 'дописать промпт', { cleaned: ['todo'] }), 'V-P-11'), 'warn');
});

test('замечание об очистке не дублируется, если текст и так похож на HTML', () => {
  const issues = check({}, '<p style="x">текст</p>', { cleaned: ['html'] });
  assert.equal(codes(issues).filter((c) => c === 'V-P-10').length, 1);
});

test('обрезка краёв не даёт замечаний: это не порча файла', () => {
  assert.deepEqual(check({}, 'тело', { cleaned: ['trim'] }), []);
});

test('V-P-11 тело начинается с TODO — warn, но текст не стирается', () => {
  const issues = check({}, 'TODO: дописать промпт');
  assert.equal(level(issues, 'V-P-11'), 'warn');
  assert.ok(!codes(issues).includes('V-P-8'), 'тело не считается пустым');
});

test('V-P-12 файл больше 256 КБ — bad', () => {
  assert.equal(level(check({}, 'тело', { bytes: 300 * 1024 }), 'V-P-12'), 'bad');
});

test('V-P-13 неизвестный status — warn', () => {
  assert.equal(level(check({ status: 'выдуманный' }), 'V-P-13'), 'warn');
});

test('дубликат id — bad у обоих файлов, и назван конкретный файл', () => {
  const items = [
    { id: 'c-x', path: 'code/c-x.md', status: 'active' },
    { id: 'c-x', path: 'inbox/c-x.md', status: 'active' },
  ];
  const map = validateUnique(items);

  assert.equal(map.get('code/c-x.md')[0].level, 'bad');
  assert.match(map.get('code/c-x.md')[0].message, /inbox\/c-x\.md/);
  assert.match(map.get('inbox/c-x.md')[0].message, /code\/c-x\.md/);
});

test('дубликат pin — bad: две «позиции 3» ломают моторную память', () => {
  const map = validateUnique([
    { id: 'a', path: 'code/a.md', pin: 3, status: 'active' },
    { id: 'b', path: 'code/b.md', pin: 3, status: 'active' },
  ]);
  assert.equal(map.get('code/a.md')[0].level, 'bad');
});

test('архивный промпт не участвует в проверке pin', () => {
  const map = validateUnique([
    { id: 'a', path: 'code/a.md', pin: 3, status: 'active' },
    { id: 'b', path: 'code/b.md', pin: 3, status: 'archived' },
  ]);
  assert.deepEqual(map.get('code/a.md'), []);
});

test('дубликат hotkey и trigger — warn: конфликт решается в настройках', () => {
  const map = validateUnique([
    { id: 'a', path: 'code/a.md', hotkey: '^!r', trigger: ':x', status: 'active' },
    { id: 'b', path: 'code/b.md', hotkey: '^!r', trigger: ':x', status: 'active' },
  ]);
  assert.deepEqual(map.get('code/a.md').map((i) => i.level), ['warn', 'warn']);
});

test('пустые значения не считаются дубликатами', () => {
  const map = validateUnique([
    { id: 'a', path: 'code/a.md', hotkey: null, trigger: '', pin: null, status: 'active' },
    { id: 'b', path: 'code/b.md', hotkey: null, trigger: '', pin: null, status: 'active' },
  ]);
  assert.deepEqual(map.get('code/a.md'), []);
});

test('служебные поля перечислены: их правит только программа', () => {
  assert.deepEqual(MACHINE_FIELDS, ['used', 'last_used', 'updated']);
  for (const f of MACHINE_FIELDS) assert.ok(FIELD_ORDER.includes(f), `${f} должно быть в порядке полей`);
});
