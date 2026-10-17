// tests/unit/migrate-meta.test.mjs — выбор главной копии и нормализация полей.
//
// Требование: REQ-MIG-APPLY (docs/SPEC.md §11). Сценарий S-11.
// Проверяемые файлы: legacy/sources.mjs (pickWinner), legacy/apply.mjs (migrateMeta).
// Файловые операции миграции — в tests/unit/migrate-apply.test.mjs, отчёт и разбор
// конфликтов — в tests/unit/migrate.test.mjs.
//
// Выделено из migrate-apply.test.mjs, когда тот вышел за 300 строк. Разделение по
// смыслу: здесь чистые решения над данными — «какая копия старше» и «как привести
// поле к схеме», без диска. Там — что миграция записала и вычитала обратно.
//
// Обе функции решают за человека ровно настолько, насколько это безопасно: выбор
// старшей версии обоснован словами, а осмысленное значение вне диапазона не
// трогается — валидатор пометит его warn, и это правильный исход.

import test from 'node:test';
import assert from 'node:assert/strict';

import { pickWinner, migrateMeta } from '../../legacy/index.mjs';

// ── выбор главной копии ──────────────────────────────────────────────────────

test('version важнее всего: она прямо заявляет старшинство', () => {
  const copies = [
    { kind: 'project', meta: { version: 1 }, mtime: 9999, body: 'старое' },
    { kind: 'home', meta: { version: 2 }, mtime: 1, body: 'новое' },
  ];

  const { best, why } = pickWinner(copies);
  assert.equal(best.kind, 'home');
  assert.match(why, /version 2 против 1/);
});

test('при равной version решает updated из метаданных', () => {
  const copies = [
    { kind: 'project', meta: { version: 1, updated: '2026-08-01' }, mtime: 9999, body: 'a' },
    { kind: 'home', meta: { version: 1, updated: '2026-09-01' }, mtime: 1, body: 'b' },
  ];

  const { best, why } = pickWinner(copies);
  assert.equal(best.kind, 'home');
  assert.match(why, /updated 2026-09-01/);
});

test('mtime не первый: копирование переписывает время файла', () => {
  // start4_link.py копировал библиотеку, и у копии mtime оказывался новее
  // оригинала. Доверие к нему потеряло бы настоящую правку.
  const copies = [
    { kind: 'project', meta: { version: 2, updated: '2026-09-01' }, mtime: 1, body: 'правка' },
    { kind: 'home', meta: { version: 1, updated: '2026-08-01' }, mtime: 9999, body: 'копия' },
  ];

  assert.equal(pickWinner(copies).best.body, 'правка');
});

test('при полном равенстве проект важнее домашней копии', () => {
  const copies = [
    { kind: 'home', meta: { version: 1, updated: '2026-09-01' }, mtime: 100, body: 'a' },
    { kind: 'project', meta: { version: 1, updated: '2026-09-01' }, mtime: 100, body: 'b' },
  ];

  const { best, why } = pickWinner(copies);
  assert.equal(best.kind, 'project');
  assert.match(why, /источник/);
});

test('единственная копия названа единственной, а не «победившей»', () => {
  const { why } = pickWinner([{ kind: 'project', meta: {}, mtime: 1, body: 'a' }]);
  assert.equal(why, 'единственная копия');
});

// ── нормализация метаданных ──────────────────────────────────────────────────

test('осмысленное значение вне диапазона НЕ трогается', () => {
  // Решать за человека, что он имел в виду под score: 7, нельзя. Валидатор
  // пометит это warn — правильный исход.
  const meta = migrateMeta({ meta: { score: 7 } }, { id: 'c-x', title: 'Т', group: 'code' });

  assert.equal(meta.score, 7);
});

/**
 * `created` берётся из `updated`, когда даты создания в файле нет.
 *
 * Дефект найден ЖИВЫМ ЗАПУСКОМ, а не тестом: после первой миграции 6 промптов из 32
 * остались с пометкой «updated раньше created». Прежний формат писал только
 * `updated`, а умолчание подставляло в `created` сегодняшнюю дату — файл выходил
 * изменённым за месяц до создания.
 *
 * Ни один из 52 тестов миграции этого не поймал: все они создают фикстуры с полным
 * набором полей либо вообще без дат. Настоящие файлы оказались посередине.
 */
test('created берётся из updated, если даты создания нет', () => {
  const meta = migrateMeta(
    { meta: { updated: '2026-08-07' } },
    { id: 'c-x', title: 'Тест', group: 'code' },
  );

  assert.equal(meta.created, '2026-08-07', 'подставлена сегодняшняя дата вместо даты правки');
  assert.equal(meta.updated, '2026-08-07');
  assert.equal(meta.updated >= meta.created, true, 'хронология нарушена — сработает V-P-9');
});

test('готовая пара дат не переписывается', () => {
  const meta = migrateMeta(
    { meta: { created: '2026-01-01', updated: '2026-08-07' } },
    { id: 'c-x', title: 'Тест', group: 'code' },
  );

  assert.equal(meta.created, '2026-01-01');
  assert.equal(meta.updated, '2026-08-07');
});

/**
 * Битая пара дат исправляется, даже если ОБА поля на месте.
 *
 * Второй дефект той же истории, и он показал, почему первой правки было мало.
 * Миграция читает свой же результат: после первого прогона в файле уже стоят обе
 * даты — `created` сегодня, `updated` из прошлого. Условие «даты создания нет»
 * больше не выполняется, и пара остаётся битой навсегда.
 *
 * Проверяется само НАРУШЕНИЕ, а не отсутствие поля.
 */
test('created позже updated исправляется на повторном прогоне', () => {
  const meta = migrateMeta(
    { meta: { created: '2026-09-07', updated: '2026-08-07' } },
    { id: 'c-x', title: 'Тест', group: 'code' },
  );

  assert.equal(meta.created, '2026-08-07', 'битая пара дат осталась битой');
  assert.equal(meta.updated >= meta.created, true);
});

test('created без updated — это не ошибка, миграция меняет файл сегодня', () => {
  // Обратный случай. Здесь сегодняшняя дата в `updated` верна: миграция файл
  // действительно правит, и утверждать иное было бы ложью.
  const meta = migrateMeta(
    { meta: { created: '2026-01-01' } },
    { id: 'c-x', title: 'Тест', group: 'code' },
  );

  assert.equal(meta.created, '2026-01-01');
  assert.equal(meta.updated >= meta.created, true);
});
