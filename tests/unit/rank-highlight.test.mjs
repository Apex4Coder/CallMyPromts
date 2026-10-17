// tests/unit/rank-highlight.test.mjs — показ результата поиска.
//
// Требование: REQ-RANK-SEARCH (docs/SPEC.md §5). Сценарий: S-02, плохой путь
// «ничего не найдено». Отделено от tests/unit/rank-search.test.mjs по размеру
// чанка (docs/RULES.md §3): там отбор и вес полей, здесь — что видит человек.
//
// Главное свойство: подсветка отдаёт массив частей, а не строку с тегами. Текст
// промпта приходит из файла, который правит человек, и он не должен иметь
// возможности стать разметкой — ни случайно, ни намеренно.

import test from 'node:test';
import assert from 'node:assert/strict';

import { highlightParts, emptyMessage, matchSpan } from '../../rank/index.mjs';

// ── подсветка ────────────────────────────────────────────────────────────────

test('подсветка возвращает части, а не разметку', () => {
  const parts = highlightParts('Ревью кода', { start: 6, end: 10 });

  assert.deepEqual(parts, [
    { text: 'Ревью ', hit: false },
    { text: 'кода', hit: true },
  ]);
});

test('совпадение в начале не даёт пустой части', () => {
  // Пустая часть создала бы лишний узел в разметке на каждой строке списка.
  const parts = highlightParts('Ревью кода', { start: 0, end: 5 });

  assert.deepEqual(parts, [
    { text: 'Ревью', hit: true },
    { text: ' кода', hit: false },
  ]);
});

test('совпадение в конце тоже не даёт пустой части', () => {
  const parts = highlightParts('Ревью кода', { start: 6, end: 10 });

  assert.equal(parts.length, 2);
  assert.equal(parts.at(-1).hit, true);
});

test('совпадение во всю строку — одна часть', () => {
  assert.deepEqual(highlightParts('Ревью', { start: 0, end: 5 }), [{ text: 'Ревью', hit: true }]);
});

test('без совпадения текст возвращается целиком одной частью', () => {
  assert.deepEqual(highlightParts('Ревью кода', null), [{ text: 'Ревью кода', hit: false }]);
});

test('отрезок за пределами строки игнорируется, текст не обрезается', () => {
  // Рассинхронизация между поиском и отрисовкой не должна съедать текст промпта.
  assert.deepEqual(highlightParts('короткий', { start: 0, end: 500 }), [{ text: 'короткий', hit: false }]);
  assert.deepEqual(highlightParts('короткий', { start: -1, end: 3 }), [{ text: 'короткий', hit: false }]);
});

test('разметка внутри текста остаётся текстом', () => {
  const parts = highlightParts('<script>alert(1)</script> ревью', { start: 26, end: 31 });

  assert.equal(parts[0].text, '<script>alert(1)</script> ', 'угловые скобки не тронуты');
  assert.equal(parts[1].hit, true);
  assert.equal(parts.map((x) => x.text).join(''), '<script>alert(1)</script> ревью', 'склейка даёт исходник');
});

test('склейка частей всегда равна исходной строке', () => {
  // Инвариант: подсветка не имеет права ни добавить, ни потерять ни одного знака.
  const text = 'Проверь код на ошибки и предложи исправление';

  for (const q of ['код', 'ошибки', 'Проверь', 'исправление', 'нет-такого']) {
    const parts = highlightParts(text, matchSpan(text, q));
    assert.equal(parts.map((x) => x.text).join(''), text, `${q}: текст изменён`);
  }
});

test('пустой текст даёт одну пустую часть, а не пустой массив', () => {
  // Пустой массив пришлось бы отличать в каждом месте отрисовки.
  assert.deepEqual(highlightParts('', null), [{ text: '', hit: false }]);
  assert.deepEqual(highlightParts(null, null), [{ text: '', hit: false }]);
});

// ── пустая выдача ────────────────────────────────────────────────────────────

test('пустая выдача показывает запрос целиком', () => {
  const msg = emptyMessage('абракадабра');

  assert.match(msg, /абракадабра/, 'человек должен видеть, что именно искалось');
  assert.match(msg, /Ничего не найдено/);
});

test('пустая выдача сообщает, что раскладки проверены', () => {
  // Подсказки «возможно, имелось в виду» нет намеренно: поиск уже проверил вторую
  // раскладку сам. Предлагать то, что только что не нашлось, — ложь интерфейса
  // (docs/RULES.md §4). Прежняя версия предлагала «яяя» на запрос «zzz».
  const msg = emptyMessage('zzz');

  assert.match(msg, /Проверены обе раскладки/);
  assert.equal(/возможно/i.test(msg), false);
  assert.equal(/яяя/.test(msg), false);
});

test('запрос без второй раскладки не обещает лишнего', () => {
  const msg = emptyMessage('12345');

  assert.equal(/раскладки/.test(msg), false);
});

test('пустой запрос не даёт сообщения с пустыми кавычками внутри текста', () => {
  // Вырожденный случай: сообщение всё равно должно читаться как предложение.
  const msg = emptyMessage('');

  assert.match(msg, /Ничего не найдено/);
  assert.equal(msg.trim().endsWith('.'), true);
});
