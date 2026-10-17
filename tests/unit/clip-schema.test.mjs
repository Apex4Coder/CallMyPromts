// tests/unit/clip-schema.test.mjs — схема записи журнала и определение типа.
//
// Требование: REQ-CT-CLIP (docs/SPEC.md §2). Правила V-C-*: DATA-CONTRACTS §2.2.
//
// Тип записи — подсказка для значка и фильтра, а не гарантия. Поэтому проверяется
// порядок разрешения: первое совпадение выигрывает, и этот порядок зафиксирован.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectKind, makePreview, countLines, validateClipInput, isBlacklisted,
  clampLimit, KINDS, PREVIEW_LEN, LIMIT_DEFAULT, LIMIT_MIN, LIMIT_MAX, BLACKLIST_DEFAULT,
} from '../../contracts/index.mjs';

test('шесть типов и ни одного лишнего', () => {
  assert.deepEqual(KINDS, ['text', 'url', 'code', 'path', 'email', 'image']);
});

test('распознаёт типы по образцам', () => {
  assert.equal(detectKind('https://example.com/a?b=1'), 'url');
  assert.equal(detectKind('user@example.com'), 'email');
  assert.equal(detectKind('C:\\Users\\Baza\\file.txt'), 'path');
  assert.equal(detectKind('/usr/local/bin/node'), 'path');
  assert.equal(detectKind('\\\\server\\share\\file'), 'path');
  assert.equal(detectKind('def f(x):\n    return x * 2'), 'code');
  assert.equal(detectKind('обычный текст из документа'), 'text');
  assert.equal(detectKind('что угодно', { isImage: true }), 'image');
});

test('картинка сильнее любого текста: признак приходит от ОС, а не из содержимого', () => {
  assert.equal(detectKind('https://example.com', { isImage: true }), 'image');
});

test('ссылка внутри абзаца не делает запись ссылкой', () => {
  assert.equal(detectKind('смотри https://example.com и ещё текст'), 'text');
});

test('одна строка кода не считается кодом: слишком много ложных попаданий', () => {
  assert.equal(detectKind('const x = 1;'), 'text');
  assert.equal(detectKind('const x = 1;\nconst y = 2;'), 'code');
});

test('preview — одна строка не длиннее лимита', () => {
  const long = 'слово '.repeat(80);
  const p = makePreview(long);

  assert.ok(p.length <= PREVIEW_LEN, `${p.length} > ${PREVIEW_LEN}`);
  assert.ok(p.endsWith('…'), 'обрезка обозначена многоточием');
  assert.equal(p.includes('\n'), false);
});

test('переводы строк в preview заменяются разделителем, а не съедаются', () => {
  assert.equal(makePreview('первая\nвторая\nтретья'), 'первая · вторая · третья');
});

test('countLines считает строки', () => {
  assert.equal(countLines('одна'), 1);
  assert.equal(countLines('одна\nдве\nтри'), 3);
});

test('V-C-5 слишком короткое содержимое — bad', () => {
  const issues = validateClipInput('a');
  assert.equal(issues[0].code, 'V-C-5');
  assert.equal(issues[0].level, 'bad');
});

test('пустой буфер не создаёт запись', () => {
  assert.equal(validateClipInput('   ').some((i) => i.level === 'bad'), true);
});

test('V-C-6 больше 1 МБ — warn: запись создаётся, но обрезается', () => {
  const issues = validateClipInput('я'.repeat(600 * 1024));
  assert.equal(issues[0].code, 'V-C-6');
  assert.equal(issues[0].level, 'warn');
});

test('картинка не проверяется на длину текста', () => {
  assert.deepEqual(validateClipInput('', { isImage: true }), []);
});

test('чёрный список ловит имя процесса в любом регистре и с расширением', () => {
  assert.equal(isBlacklisted('KeePassXC.exe'), true);
  assert.equal(isBlacklisted('keepass2'), true);
  assert.equal(isBlacklisted('1Password.exe'), true);
  assert.equal(isBlacklisted('C:\\Program Files\\Bitwarden\\Bitwarden.exe'), true);
  assert.equal(isBlacklisted('Code.exe'), false);
  assert.equal(isBlacklisted(null), false);
});

test('в списке по умолчанию девять менеджеров паролей', () => {
  assert.equal(BLACKLIST_DEFAULT.length, 9);
  assert.ok(BLACKLIST_DEFAULT.includes('keepass'));
});

test('свой список заменяет список по умолчанию', () => {
  assert.equal(isBlacklisted('KeePassXC.exe', ['мой-процесс']), false);
  assert.equal(isBlacklisted('мой-процесс.exe', ['мой-процесс']), true);
});

test('лимит журнала зажимается в границы, мусор даёт значение по умолчанию', () => {
  assert.equal(clampLimit(100), 100);
  assert.equal(clampLimit(5), LIMIT_MIN);
  assert.equal(clampLimit(99999), LIMIT_MAX);
  assert.equal(clampLimit('не число'), LIMIT_DEFAULT);
  assert.equal(clampLimit(null), LIMIT_DEFAULT);
});
