// tests/unit/rank-suggest.test.mjs — позиции 1..9 и подсказка о закреплении.
//
// Требование: REQ-RANK-SUGGEST (docs/SPEC.md §5). Сценарий: S-06.
//
// Тема файла — механика закрепления целиком: отбор закреплённых, раскладка
// девяти слотов, план закрепления и подсказка. Порядок списка проверяется
// отдельно в tests/unit/rank-order.test.mjs.
//
// Правило, которое здесь закрепляется жёстче остальных: подсказка не закрепляет
// ничего сама, а план закрепления только объясняет последствие. Владелец сказал
// прямо: «никогда не принимай решения за человека» (docs/RULES.md §5).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PIN_MIN,
  PIN_MAX,
  DAY_MS,
  pinned,
  unpinned,
  firstFreePin,
  occupantOf,
  planPin,
  suggestPin,
  pinSlots,
} from '../../rank/index.mjs';

const NOW = Date.parse('2026-09-05T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY_MS).toISOString();

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

const ids = (list) => list.map((i) => i.id);

// ── границы позиций ──────────────────────────────────────────────────────────

test('позиции ограничены одной цифрой', () => {
  // Закрепление вызывается цифрой на клавиатуре — десятой цифры не существует.
  assert.equal(PIN_MIN, 1);
  assert.equal(PIN_MAX, 9);
});

test('закреплённые идут по возрастанию позиции', () => {
  const items = [p('c-c', { pin: 3 }), p('c-a', { pin: 1 }), p('c-b', { pin: 2 })];

  assert.deepEqual(ids(pinned(items)), ['c-a', 'c-b', 'c-c']);
});

test('позиция вне диапазона закреплением не считается', () => {
  // Иначе битое значение в файле создавало бы «нулевую» или «десятую» позицию,
  // которую нельзя нажать.
  const items = [p('c-zero', { pin: 0 }), p('c-ten', { pin: 10 }), p('c-ok', { pin: 5 })];

  assert.deepEqual(ids(pinned(items)), ['c-ok']);
  assert.deepEqual(ids(unpinned(items)), ['c-zero', 'c-ten']);
});

test('нецелая и нечисловая позиция закреплением не считаются', () => {
  const items = [p('c-half', { pin: 2.5 }), p('c-text', { pin: 'три' })];

  assert.deepEqual(pinned(items), []);
});

test('закреплённые и незакреплённые вместе дают исходный список', () => {
  const items = [p('a', { pin: 1 }), p('b', { pin: 2 }), p('c'), p('d')];

  assert.equal(pinned(items).length + unpinned(items).length, items.length);
});

// ── свободные позиции ────────────────────────────────────────────────────────

test('первая свободная позиция — наименьшая из незанятых', () => {
  assert.equal(firstFreePin([]), 1);
  assert.equal(firstFreePin([p('a', { pin: 1 })]), 2);
  assert.equal(firstFreePin([p('a', { pin: 1 }), p('c', { pin: 3 })]), 2, 'дырка в середине заполняется');
});

test('все девять заняты — свободной нет', () => {
  const full = Array.from({ length: 9 }, (_, n) => p(`c-${n}`, { pin: n + 1 }));

  assert.equal(firstFreePin(full), null);
});

test('занимающий позицию находится по номеру', () => {
  const items = [p('c-a', { pin: 1 }), p('c-b', { pin: 2 })];

  assert.equal(occupantOf(items, 2).id, 'c-b');
  assert.equal(occupantOf(items, 5), null);
});

test('раскладка показывает все девять позиций, свободные помечены', () => {
  const slots = pinSlots([p('c-a', { pin: 1 }), p('c-c', { pin: 3 })]);

  assert.equal(slots.length, 9);
  assert.equal(slots[0].id, 'c-a');
  assert.equal(slots[0].free, false);
  assert.equal(slots[1].free, true, 'вторая позиция свободна');
  assert.equal(slots[1].id, null);
  assert.equal(slots[2].id, 'c-c');
});

test('раскладка пустой библиотеки — девять свободных позиций', () => {
  const slots = pinSlots([]);

  assert.equal(slots.length, 9);
  assert.equal(slots.every((s) => s.free), true);
  assert.deepEqual(slots.map((s) => s.pin), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

// ── план закрепления ─────────────────────────────────────────────────────────

test('закрепление на свободную позицию: план без последствий', () => {
  const out = planPin([p('c-x', { used: 5, days: 1 })], 'c-x', 3);

  assert.equal(out.ok, true);
  assert.equal(out.pin, 3);
  assert.equal(out.swapWith, null);
  assert.match(out.note, /будет закреплён на 3/);
});

test('без указания позиции берётся первая свободная', () => {
  const out = planPin([p('c-a', { pin: 1 }), p('c-x')], 'c-x');

  assert.equal(out.pin, 2);
});

test('занятая позиция при обмене: обе стороны названы', () => {
  // Оба промпта закреплены, поэтому это настоящий обмен.
  const items = [p('c-a', { pin: 3, title: 'Обзор кода' }), p('c-x', { pin: 7 })];

  const out = planPin(items, 'c-x', 3);

  assert.equal(out.ok, true);
  assert.deepEqual(out.swapWith, { id: 'c-a', title: 'Обзор кода', from: 3, to: 7 });
  assert.match(out.note, /перейдёт на 7/, 'человек должен знать, куда уедет занимающий');
});

test('занятая позиция без обмена: слово «обмен» скрыло бы потерю', () => {
  // У закрепляемого промпта своей позиции нет, значит занимающий её просто
  // перестанет быть закреплённым. Это надо называть прямо (docs/RULES.md §4).
  const items = [p('c-a', { pin: 3, title: 'Обзор кода' }), p('c-x')];

  const out = planPin(items, 'c-x', 3);

  assert.equal(out.swapWith.to, null);
  assert.match(out.note, /потеряет закрепление/);
  assert.equal(/перейдёт/.test(out.note), false);
});

test('закрепление на свою же позицию — не обмен с самим собой', () => {
  const out = planPin([p('c-x', { pin: 4 })], 'c-x', 4);

  assert.equal(out.ok, true);
  assert.equal(out.swapWith, null);
});

test('позиция вне диапазона отклоняется с указанием границ', () => {
  for (const bad of [0, 10, -1, 2.5]) {
    const out = planPin([p('c-x')], 'c-x', bad);
    assert.equal(out.ok, false, `${bad}: должно быть отклонено`);
    assert.match(out.reason, /1\.\.9/, `${bad}: границы обязаны быть названы`);
  }
});

test('все позиции заняты: показан список занятых, а не просто отказ', () => {
  // «Свободных позиций нет» без списка заставляет человека вспоминать, что где.
  const full = Array.from({ length: 9 }, (_, n) => p(`c-${n}`, { pin: n + 1, title: `Промпт ${n + 1}` }));

  const out = planPin([...full, p('c-new')], 'c-new');

  assert.equal(out.ok, false);
  assert.match(out.reason, /свободных позиций нет/);
  assert.equal(out.occupied.length, 9);
  assert.deepEqual(out.occupied[0], { pin: 1, id: 'c-0', title: 'Промпт 1' });
});

test('несуществующий промпт — понятный отказ', () => {
  const out = planPin([p('c-x')], 'нет-такого', 1);

  assert.equal(out.ok, false);
  assert.match(out.reason, /не найден/);
});

test('архивный промпт закрепить нельзя, причина названа', () => {
  const out = planPin([p('c-old', { status: 'archived' })], 'c-old', 1);

  assert.equal(out.ok, false);
  assert.match(out.reason, /архивный/);
});

test('план ничего не изменяет: это только объяснение', () => {
  const items = [p('c-a', { pin: 3 }), p('c-x')];
  const before = JSON.stringify(items);

  planPin(items, 'c-x', 3);

  assert.equal(JSON.stringify(items), before, 'план обязан быть чистой функцией');
});

// ── подсказка о закреплении ──────────────────────────────────────────────────

test('часто используемый незакреплённый промпт предлагается закрепить', () => {
  const items = [p('c-hot', { title: 'Обзор кода', used: 12, days: 1 }), p('c-rare', { used: 1, days: 1 })];

  const out = suggestPin(items, { after: 5, now: NOW });

  assert.equal(out.id, 'c-hot');
  assert.equal(out.used, 12);
  assert.equal(out.pin, 1, 'предложена свободная позиция');
  assert.match(out.text, /Обзор кода/);
  assert.match(out.text, /12 раз/, 'основание подсказки названо числом');
  assert.match(out.text, /закрепить на 1\?/, 'подсказка спрашивает, а не сообщает о сделанном');
});

test('порог соблюдается: ниже него подсказки нет', () => {
  const items = [p('c-x', { used: 4, days: 1 })];

  assert.equal(suggestPin(items, { after: 5, now: NOW }), null);
  assert.equal(suggestPin(items, { after: 4, now: NOW }) !== null, true, 'ровно на пороге — предлагается');
});

test('уже закреплённый не предлагается повторно', () => {
  const items = [p('c-x', { pin: 1, used: 50, days: 1 })];

  assert.equal(suggestPin(items, { after: 5, now: NOW }), null);
});

test('холодный часто использованный не предлагается', () => {
  // 40 использований год назад — закрытая задача. Закреплять её на позицию 1
  // значило бы занять быструю клавишу мёртвым промптом.
  const items = [p('c-old', { used: 40, days: 365 })];

  assert.equal(suggestPin(items, { after: 5, now: NOW }), null);
});

test('битый и архивный не предлагаются', () => {
  const items = [
    p('c-bad', { used: 50, days: 1, state: 'bad' }),
    p('c-old', { used: 50, days: 1, status: 'archived' }),
  ];

  assert.equal(suggestPin(items, { after: 5, now: NOW }), null);
});

test('из нескольких кандидатов предлагается самый частый', () => {
  const items = [
    p('c-a', { used: 8, days: 1 }),
    p('c-b', { used: 25, days: 1 }),
    p('c-c', { used: 12, days: 1 }),
  ];

  assert.equal(suggestPin(items, { after: 5, now: NOW }).id, 'c-b');
});

test('при занятых позициях подсказка предлагает замену, а не молчит', () => {
  const full = Array.from({ length: 9 }, (_, n) => p(`c-${n}`, { pin: n + 1 }));
  const items = [...full, p('c-new', { title: 'Новый', used: 30, days: 1 })];

  const out = suggestPin(items, { after: 5, now: NOW });

  assert.equal(out.id, 'c-new');
  assert.equal(out.pin, null);
  assert.match(out.text, /позиции заняты/);
  assert.match(out.text, /можно заменить/);
});

test('пустая библиотека подсказки не даёт', () => {
  assert.equal(suggestPin([], { after: 5, now: NOW }), null);
  assert.equal(suggestPin(undefined, { after: 5, now: NOW }), null);
});

test('подсказка ничего не закрепляет сама', () => {
  const items = [p('c-x', { used: 30, days: 1 })];

  suggestPin(items, { after: 5, now: NOW });

  assert.equal(items[0].pin, null, 'решение остаётся за человеком');
});
