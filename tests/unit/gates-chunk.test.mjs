// tests/unit/gates-chunk.test.mjs — гейт размера чанков.
//
// Требование: REQ-GATE-CHUNK (docs/SPEC.md §10).
// Проверяемый файл: gates/chunk-check.mjs.
// Границы — в tests/unit/gates.test.mjs, трасса и секреты — в gates-trace.test.mjs.
//
// Выделено из gates.test.mjs, когда тот сам вышел за 300 строк. Гейт, который не
// проходит собственную проверку, не имеет права требовать её от остальных.
//
// Гейт, который ничего не ловит, хуже отсутствия гейта: он даёт уверенность без
// оснований. Поэтому каждая проверка делает нарушение НАМЕРЕННО и требует, чтобы
// гейт назвал его с местом.

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkChunk, measure, LIMITS } from '../../gates/verify.mjs';

import { tempRoot, cleanup } from '../helpers/harness.mjs';
import { put, cleanProject } from '../helpers/project.mjs';

/** Сообщения одной строкой: искать подстроку удобнее, чем обходить массив. */
const said = (res) => res.items.map((i) => `${i.path}:${i.line ?? '-'} ${i.message}`).join('\n');

// ── размер: файл ─────────────────────────────────────────────────────────────

test('на чистом проекте гейт размера молчит', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    assert.equal(checkChunk(root).count, 0, said(checkChunk(root)));
  } finally { cleanup(root); }
});

test('слишком длинный файл назван с числом строк', () => {
  // Прежняя система держала тексты 25 промптов в fill.py на 425 строках, и одна
  // ошибка в условии молча стирала содержимое файла.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', `${'// строка\n'.repeat(LIMITS.fileLines + 5)}`);

    const res = checkChunk(root);
    assert.match(said(res), new RegExp(`${LIMITS.fileLines + 6} строк, порог ${LIMITS.fileLines}`));
    assert.match(said(res), /разделите по смыслу/, 'сказано, что делать');
  } finally { cleanup(root); }
});

test('стили и разметка мерятся свободнее кода', () => {
  // В CSS нет ветвлений, которые надо держать в голове, поэтому порог другой.
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/wide.css', `${'.a { color: red; }\n'.repeat(LIMITS.fileLines + 20)}`);

    assert.equal(checkChunk(root).count, 0, said(checkChunk(root)));
  } finally { cleanup(root); }
});

test('очень длинный CSS всё же ловится', () => {
  // «Свободнее» не значит «без предела».
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/huge.css', `${'.a { color: red; }\n'.repeat(500)}`);

    assert.match(said(checkChunk(root)), /строк, порог 400/);
  } finally { cleanup(root); }
});

// ── размер: строка ───────────────────────────────────────────────────────────

test('слишком длинная строка названа с номером', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', `const a = 1;\nconst b = '${'x'.repeat(LIMITS.lineChars + 10)}';\n`);

    const bad = checkChunk(root).items.find((i) => i.message.includes('знаков'));
    assert.equal(bad.line, 2);
  } finally { cleanup(root); }
});

// ── размер: функция ──────────────────────────────────────────────────────────

test('слишком длинная функция названа с началом', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    const body = '  const x = 1;\n'.repeat(LIMITS.funcLines + 5);
    put(root, 'core/index.mjs', `export const big = () => {\n${body}  return 0;\n};\n`);

    const bad = checkChunk(root).items.find((i) => i.message.includes('функция'));
    assert.notEqual(bad, undefined, said(checkChunk(root)));
    assert.equal(bad.line, 1, 'место — первая строка функции');
  } finally { cleanup(root); }
});

test('стрелочная функция в const видна измерителю', () => {
  // Основная форма в этом проекте. Первая версия шаблона её не видела, и гейт
  // показывал «0 функций» на файлах, состоящих из функций.
  const m = measure('export const f = () => {\n  return 1;\n};\n');

  assert.equal(m.funcs.length, 1, 'функция не найдена');
});

test('обычное объявление функции видно тоже', () => {
  assert.equal(measure('function f() {\n  return 1;\n}\n').funcs.length, 1);
});

test('метод класса виден', () => {
  const m = measure('class A {\n  go(x) {\n    return x;\n  }\n}\n');

  assert.equal(m.funcs.length, 1, 'метод не найден');
});

test('условие функцией не считается', () => {
  // Иначе каждый if измерялся бы как функция, и порог 60 строк ловил бы ерунду.
  const m = measure('const f = () => {\n  if (true) {\n    return 1;\n  }\n  return 0;\n};\n');

  assert.equal(m.funcs.length, 1, 'найдено больше одной функции');
});

// ── размер: вложенность ──────────────────────────────────────────────────────

test('глубокая вложенность ветвлений названа с местом', () => {
  const root = tempRoot();
  try {
    cleanProject(root);
    put(root, 'core/index.mjs', [
      'export const f = (a) => {',
      '  if (a) {',
      '    for (const x of a) {',
      '      while (x) {',
      '        if (x) {',
      '          return x;',
      '        }',
      '      }',
      '    }',
      '  }',
      '  return null;',
      '};',
      '',
    ].join('\n'));

    const bad = checkChunk(root).items.find((i) => i.message.includes('вложенность'));
    assert.notEqual(bad, undefined, said(checkChunk(root)));
    assert.equal(bad.line > 1, true, 'место — самая глубокая строка');
  } finally { cleanup(root); }
});

test('вложенные объекты вложенностью кода не считаются', () => {
  // Объект с объектом внутри выглядел бы как код глубиной 3, и метрика
  // перестала бы что-то значить.
  const m = measure([
    'export const CONFIG = {',
    '  ui: {',
    '    theme: {',
    '      dark: {',
    '        bg: "#000",',
    '      },',
    '    },',
    '  },',
    '};',
  ].join('\n'));

  assert.equal(m.maxDepth, 0, `объект дал глубину ${m.maxDepth}`);
});

test('комментарии в подсчёте не участвуют', () => {
  const m = measure([
    'export const f = () => {',
    '  // if (a) {',
    '  //   for (;;) {',
    '  return 1;',
    '};',
  ].join('\n'));

  assert.equal(m.maxDepth, 0);
});
