// tests/unit/rank-order.test.mjs — порядок списка промптов.
//
// Требование: REQ-RANK-ORDER (docs/SPEC.md §5). Сценарий: S-06.
//
// Главное свойство порядка — предсказуемость. Список, который сам себя
// переставляет, ломает мышечную память; список, который не реагирует на частоту,
// заставляет искать одно и то же каждый день. Отсюда разделение: позиции 1..9
// не двигаются никогда, всё остальное упорядочено по температуре.
//
// Механика самих позиций — отбор закреплённых, раскладка слотов, границы 1..9 —
// проверяется в tests/unit/rank-suggest.test.mjs вместе с планированием
// закрепления: это одна тема, и вместе файлы вышли бы за 300 строк
// (docs/RULES.md §3).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODES,
  DAY_MS,
  weight,
  order,
} from '../../rank/index.mjs';

const NOW = Date.parse('2026-09-05T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY_MS).toISOString();

/** Промпт с полями, от которых зависит порядок. Остальное для порядка не важно. */
const p = (id, over = {}) => ({
  id,
  title: over.title ?? id,
  group: over.group ?? 'code',
  pin: over.pin ?? null,
  used: over.used ?? 0,
  last_used: over.used ? ago(over.days ?? 1) : null,
  status: over.status ?? 'active',
  state: over.state ?? 'good',
});

/**
 * Библиотека из смоук-прогона, на которой был найден дефект сортировки:
 * холодный p-parse с 40 использованиями год назад вставал выше тёплого c-bug.
 */
const LIB = () => [
  p('c-review', { used: 30, days: 1 }),
  p('c-bug', { used: 6, days: 5 }),
  p('r-deep', { used: 5, days: 20 }),
  p('p-parse', { used: 40, days: 365 }),
  p('x-plan', { used: 0 }),
];

const ids = (list) => list.map((i) => i.id);

// ── режимы ───────────────────────────────────────────────────────────────────

test('режимов ровно два: автоматический и ручной', () => {
  assert.deepEqual(MODES, ['pinned-frequency', 'manual']);
});

// ── вес ──────────────────────────────────────────────────────────────────────

test('вес — это частота и только она', () => {
  // Поправочный коэффициент здесь был дефектом: он позволял холодному промпту
  // обогнать тёплый. Свежесть учитывается отдельным ключом сортировки.
  assert.equal(weight({ used: 40 }), 40);
  assert.equal(weight({ used: 40, last_used: ago(1000) }), 40, 'давность вес не меняет');
  assert.equal(weight({}), 0);
  assert.equal(weight(null), 0);
});

// ── автоматический порядок ───────────────────────────────────────────────────

test('свежесть выигрывает у частоты: тёплый выше холодного', () => {
  const out = order(LIB(), { now: NOW });

  assert.deepEqual(ids(out), ['c-review', 'c-bug', 'r-deep', 'p-parse', 'x-plan']);
});

test('внутри одной температуры порядок по частоте', () => {
  const items = [
    p('c-few', { used: 5, days: 2 }),
    p('c-many', { used: 25, days: 2 }),
    p('c-mid', { used: 12, days: 2 }),
  ];

  assert.deepEqual(ids(order(items, { now: NOW })), ['c-many', 'c-mid', 'c-few']);
});

test('при равной частоте порядок по названию, а не случайный', () => {
  // Случайный порядок равных элементов означал бы, что список меняется между
  // открытиями окна без причины.
  const items = [
    p('c-3', { title: 'Ясень', used: 5, days: 2 }),
    p('c-1', { title: 'Астра', used: 5, days: 2 }),
    p('c-2', { title: 'Берёза', used: 5, days: 2 }),
  ];

  assert.deepEqual(order(items, { now: NOW }).map((i) => i.title), ['Астра', 'Берёза', 'Ясень']);
});

test('русские названия сортируются по русскому алфавиту', () => {
  const items = [
    p('a', { title: 'Яблоко', used: 1, days: 1 }),
    p('b', { title: 'Автор', used: 1, days: 1 }),
    p('c', { title: 'Полка', used: 1, days: 1 }),
  ];

  assert.deepEqual(order(items, { now: NOW }).map((i) => i.title), ['Автор', 'Полка', 'Яблоко']);
});

test('«ё» стоит на месте «е», как в словаре', () => {
  // Русское сравнение считает «ё» вариантом «е», а не отдельной буквой в конце
  // алфавита: «Ёлка» раньше «Ели», потому что различие возникает на третьей
  // букве (к < ь). Так устроены бумажные словари, и человек ищет там же.
  const items = [
    p('a', { title: 'Ель', used: 1, days: 1 }),
    p('b', { title: 'Ёлка', used: 1, days: 1 }),
    p('c', { title: 'Ежевика', used: 1, days: 1 }),
  ];

  assert.deepEqual(order(items, { now: NOW }).map((i) => i.title), ['Ежевика', 'Ёлка', 'Ель']);
});

test('латиница и кириллица не перемешиваются случайно', () => {
  // Библиотека содержит и русские, и английские названия. Порядок обязан быть
  // одним и тем же при каждом открытии окна.
  const items = [
    p('a', { title: 'Review', used: 1, days: 1 }),
    p('b', { title: 'Астра', used: 1, days: 1 }),
    p('c', { title: 'Debug', used: 1, days: 1 }),
  ];

  const once = order(items, { now: NOW }).map((i) => i.title);
  const twice = order(items, { now: NOW }).map((i) => i.title);

  assert.deepEqual(once, twice);
  assert.deepEqual(once.filter((t) => /^[A-Z]/.test(t)), ['Debug', 'Review'], 'внутри латиницы порядок верный');
});

test('порядок устойчив: два вызова подряд дают одно и то же', () => {
  const first = ids(order(LIB(), { now: NOW }));
  const second = ids(order(LIB(), { now: NOW }));

  assert.deepEqual(first, second);
});

// ── закреплённые не двигаются ────────────────────────────────────────────────

test('закреплённые всегда сверху, независимо от частоты', () => {
  const items = [
    p('c-hot', { used: 100, days: 0 }),
    p('c-pinned', { pin: 1, used: 0 }),
  ];

  assert.deepEqual(ids(order(items, { now: NOW })), ['c-pinned', 'c-hot']);
});

test('позиция важнее температуры и в ручном режиме тоже', () => {
  const items = [
    p('c-hot', { used: 100, days: 0 }),
    p('c-pin2', { pin: 2 }),
    p('c-pin1', { pin: 1 }),
  ];

  for (const mode of MODES) {
    assert.deepEqual(ids(order(items, { mode, now: NOW })).slice(0, 2), ['c-pin1', 'c-pin2'],
      `${mode}: закреплённые обязаны быть первыми`);
  }
});

test('цифра для вызова совпадает с позицией', () => {
  // Расхождение сделало бы закрепление бессмысленным: человек жмёт 3, получает
  // другое.
  const items = [p('c-a', { pin: 3 }), p('c-b', { pin: 1 })];

  const out = order(items, { now: NOW });

  assert.equal(out[0]._digit, 1);
  assert.equal(out[1]._digit, 3);
});

test('у незакреплённых цифры нет', () => {
  const out = order([p('c-x', { used: 5, days: 1 })], { now: NOW });

  assert.equal(out[0]._digit, null);
});

test('позиция в списке нумеруется с единицы и без пропусков', () => {
  const out = order(LIB(), { now: NOW });

  assert.deepEqual(out.map((i) => i._pos), [1, 2, 3, 4, 5]);
});

// ── ручной режим ─────────────────────────────────────────────────────────────

test('ручной режим не реагирует на частоту', () => {
  // Названия выбраны так, что алфавитный порядок противоположен частотному:
  // иначе тест прошёл бы при любом из двух правил и ничего не проверял.
  const items = [
    p('c-hot', { title: 'Яблоко', used: 100, days: 0 }),
    p('c-cold', { title: 'Астра', used: 0 }),
  ];

  assert.deepEqual(order(items, { mode: 'manual', now: NOW }).map((i) => i.title),
    ['Астра', 'Яблоко'], 'ручной режим: только алфавит');

  assert.deepEqual(order(items, { now: NOW }).map((i) => i.title),
    ['Яблоко', 'Астра'], 'автоматический режим: частота и свежесть');
});

test('ручной режим группирует по группам', () => {
  const items = [
    p('r-x', { group: 'research', title: 'Аналог', used: 50, days: 0 }),
    p('c-y', { group: 'code', title: 'Яблоко' }),
    p('c-a', { group: 'code', title: 'Астра' }),
  ];

  assert.deepEqual(ids(order(items, { mode: 'manual', now: NOW })), ['c-a', 'c-y', 'r-x']);
});

test('неизвестный режим ведёт себя как автоматический, а не падает', () => {
  const out = order(LIB(), { mode: 'придуманный', now: NOW });

  assert.deepEqual(ids(out), ['c-review', 'c-bug', 'r-deep', 'p-parse', 'x-plan']);
});

// ── непригодные в конец ──────────────────────────────────────────────────────

test('битые уходят в конец, но остаются в списке', () => {
  // Скрыть битый файл значило бы спрятать проблему: он есть на диске, и человек
  // должен видеть его с причиной (REQ-LIB-ISOLATE).
  const items = [
    p('c-bad', { state: 'bad', used: 100, days: 0 }),
    p('c-ok', { used: 1, days: 1 }),
  ];

  assert.deepEqual(ids(order(items, { now: NOW })), ['c-ok', 'c-bad']);
});

test('битый закреплённый тоже уходит в конец', () => {
  // Закрепление не отменяет непригодности: вставить его всё равно нельзя.
  const items = [p('c-bad', { pin: 1, state: 'bad' }), p('c-ok', { used: 1, days: 1 })];

  assert.deepEqual(ids(order(items, { now: NOW })), ['c-ok', 'c-bad']);
});

test('архивные в конце вместе с битыми', () => {
  const items = [
    p('c-old', { status: 'archived', used: 100, days: 0 }),
    p('c-new', { used: 1, days: 1 }),
  ];

  assert.deepEqual(ids(order(items, { now: NOW })), ['c-new', 'c-old']);
});

test('предупреждения не понижают промпт: он рабочий', () => {
  const items = [p('c-warn', { state: 'warn', used: 50, days: 1 }), p('c-good', { used: 1, days: 1 })];

  assert.deepEqual(ids(order(items, { now: NOW })), ['c-warn', 'c-good']);
});

// ── края ─────────────────────────────────────────────────────────────────────

test('пустой список не роняет сортировку', () => {
  assert.deepEqual(order([], { now: NOW }), []);
  assert.deepEqual(order(undefined, { now: NOW }), []);
});

test('порядок не изменяет исходный массив на месте', () => {
  // Иначе кэш библиотеки менялся бы при отрисовке, и следующий запрос получил бы
  // другой порядок.
  const items = LIB();
  const before = ids(items);

  order(items, { now: NOW });

  assert.deepEqual(ids(items), before);
});

test('исходные поля промпта не затираются служебными', () => {
  const out = order([p('c-x', { used: 7, days: 1 })], { now: NOW })[0];

  assert.equal(out.id, 'c-x');
  assert.equal(out.used, 7);
  assert.equal(out.title, 'c-x');
});
