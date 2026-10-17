// tests/unit/rank-usage.test.mjs — учёт использований промптов.
//
// Требование: REQ-RANK-USE (docs/SPEC.md §5). Сценарий: S-01, шаг 4.
//
// Проблема, которую решает модуль: в прежней системе поля `used` во всех 26 файлах
// остались нулями, потому что счётчик надо было править руками. Метрика, которую
// ведёт человек, — это не метрика. Здесь счётчик растёт как побочный эффект
// вставки, и никак иначе.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEBOUNCE_MS,
  UsageTracker,
  usageBadge,
  describeUsage,
  usageStats,
  topUsed,
  DAY_MS,
} from '../../rank/index.mjs';

import { promptPath, readPromptFile } from '../../library/index.mjs';
import { tempRoot, cleanup, promptFile } from '../helpers/harness.mjs';

const NOW = Date.parse('2026-09-05T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY_MS).toISOString();

// ── защитное окно ────────────────────────────────────────────────────────────

test('защитное окно — две секунды', () => {
  // Дребезг хоткея и повторное нажатие в неактивном окне не должны считаться
  // двумя обращениями к промпту.
  assert.equal(DEBOUNCE_MS, 2000);
});

test('первая вставка считается', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 0 });
    const tracker = new UsageTracker(root);

    const out = await tracker.count('c-x', 'code', { now: NOW });

    assert.equal(out.ok, true);
    assert.equal(out.counted, true);
    assert.equal(out.used, 1);
  } finally { cleanup(root); }
});

test('повтор в пределах окна не считается, но и не ошибка', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 0 });
    const tracker = new UsageTracker(root);

    await tracker.count('c-x', 'code', { now: NOW });
    const again = await tracker.count('c-x', 'code', { now: NOW + 500 });

    assert.equal(again.ok, true, 'вставка состоялась — это не сбой');
    assert.equal(again.counted, false);
    assert.match(again.reason, /защитного окна/);

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.used, 1, 'в файле по-прежнему один');
  } finally { cleanup(root); }
});

test('после окна счёт возобновляется', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 0 });
    const tracker = new UsageTracker(root);

    await tracker.count('c-x', 'code', { now: NOW });
    const later = await tracker.count('c-x', 'code', { now: NOW + DEBOUNCE_MS + 1 });

    assert.equal(later.counted, true);
    assert.equal(later.used, 2);
  } finally { cleanup(root); }
});

test('окно у каждого промпта своё', async () => {
  // Иначе вставка двух разных промптов подряд считалась бы одной.
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-a', { used: 0 });
    promptFile(root, 'code', 'c-b', { used: 0 });
    const tracker = new UsageTracker(root);

    const a = await tracker.count('c-a', 'code', { now: NOW });
    const b = await tracker.count('c-b', 'code', { now: NOW + 100 });

    assert.equal(a.counted, true);
    assert.equal(b.counted, true, 'другой промпт — другой счёт');
  } finally { cleanup(root); }
});

test('одинаковые id в разных группах считаются раздельно', async () => {
  // В библиотеке есть s-hagent в chatbox и в inbox. Общий ключ по id склеил бы их.
  const root = tempRoot();
  try {
    promptFile(root, 'chatbox', 's-dup', { used: 0 });
    promptFile(root, 'inbox', 's-dup', { used: 0 });
    const tracker = new UsageTracker(root);

    await tracker.count('s-dup', 'chatbox', { now: NOW });
    const other = await tracker.count('s-dup', 'inbox', { now: NOW + 100 });

    assert.equal(other.counted, true);
  } finally { cleanup(root); }
});

test('сброс окна возвращает возможность счёта', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 0 });
    const tracker = new UsageTracker(root);

    await tracker.count('c-x', 'code', { now: NOW });
    tracker.reset();
    const again = await tracker.count('c-x', 'code', { now: NOW + 100 });

    assert.equal(again.counted, true);
  } finally { cleanup(root); }
});

test('отсутствующий файл — отказ с причиной, а не молчание', async () => {
  const root = tempRoot();
  try {
    const tracker = new UsageTracker(root);

    const out = await tracker.count('нет-такого', 'code', { now: NOW });

    assert.equal(out.ok, false);
    assert.equal(out.counted, false);
    assert.match(out.reason, /не найден/);
  } finally { cleanup(root); }
});

test('битый файл не считается: причина из валидатора', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 0 });
    const tracker = new UsageTracker(root);
    await tracker.count('c-x', 'code', { now: NOW });

    // Портим файл после первой отметки.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(promptPath(root, 'code', 'c-x'), '---\nid: "c-x"\nбитая строка\n---\n\nтело\n', 'utf8');

    const out = await tracker.count('c-x', 'code', { now: NOW + DEBOUNCE_MS + 1 });

    assert.equal(out.ok, false);
    assert.equal(out.counted, false);
    assert.equal(out.reason.trim() !== '', true, 'причина обязана быть названа');
  } finally { cleanup(root); }
});

test('счётчик в файле растёт сам, без правки руками', async () => {
  const root = tempRoot();
  try {
    promptFile(root, 'code', 'c-x', { used: 0 });
    const tracker = new UsageTracker(root);

    for (let i = 0; i < 5; i += 1) {
      await tracker.count('c-x', 'code', { now: NOW + i * (DEBOUNCE_MS + 1) });
    }

    const item = await readPromptFile(root, promptPath(root, 'code', 'c-x'));
    assert.equal(item.used, 5);
    assert.equal(item.last_used !== null, true, 'дата тоже заполняется программой');
  } finally { cleanup(root); }
});

// ── бейдж ────────────────────────────────────────────────────────────────────

test('бейдж не показывается на малых числах', () => {
  // «1» рядом с каждым названием — шум, который не помогает выбирать.
  assert.equal(usageBadge({ used: 0 }), null);
  assert.equal(usageBadge({ used: 2 }), null);
  assert.equal(usageBadge({}), null);
});

test('бейдж появляется с третьего использования', () => {
  const out = usageBadge({ used: 3 });

  assert.equal(out.text, '3');
  assert.match(out.title, /использован 3 раз/);
});

test('большие числа обрезаются до 999+', () => {
  // Четырёхзначное число сдвигает всю строку списка.
  assert.equal(usageBadge({ used: 1500 }).text, '999+');
  assert.equal(usageBadge({ used: 999 }).text, '999');
});

test('порог бейджа настраиваемый', () => {
  assert.equal(usageBadge({ used: 1 }, { min: 1 }).text, '1');
});

// ── описание ─────────────────────────────────────────────────────────────────

test('описание собирает счётчик, срок и температуру в одном месте', () => {
  const out = describeUsage({ used: 12, last_used: ago(3) }, NOW);

  assert.equal(out.used, 12);
  assert.equal(out.lastUsedHuman, '3 дня назад');
  assert.equal(out.temperature, 'hot');
  assert.equal(out.temperatureLabel, 'горячий');
  assert.equal(out.badge.text, '12');
  assert.match(out.why, /12 раз/);
});

test('неиспользованный промпт описан честно', () => {
  const out = describeUsage({ used: 0, last_used: null }, NOW);

  assert.equal(out.lastUsedHuman, 'никогда');
  assert.equal(out.temperature, 'cold');
  assert.equal(out.badge, null);
});

// ── сводка по библиотеке ─────────────────────────────────────────────────────

test('сводка отвечает, сколько из библиотеки реально работает', () => {
  // Именно это число объясняет, зачем нужна температура: из 26 промптов работают
  // пять-шесть.
  const items = [
    { used: 30 }, { used: 6 }, { used: 1 },
    { used: 0 }, { used: 0 }, { used: 0 }, { used: 0 },
  ];

  const out = usageStats(items);

  assert.equal(out.total, 7);
  assert.equal(out.everUsed, 3);
  assert.equal(out.neverUsed, 4);
  assert.equal(out.totalInsertions, 37);
  assert.equal(out.share, 43, 'доля в процентах, округлённая');
});

test('пустая библиотека не даёт деления на ноль', () => {
  const out = usageStats([]);

  assert.equal(out.share, 0);
  assert.equal(Number.isFinite(out.share), true);
});

test('сводка сходится: использованные плюс неиспользованные равно всем', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ used: i % 3 }));

  const out = usageStats(items);

  assert.equal(out.everUsed + out.neverUsed, out.total);
});

test('мусор в счётчике не превращается в NaN', () => {
  const out = usageStats([{ used: 'много' }, { used: null }, { used: 5 }]);

  assert.equal(Number.isFinite(out.totalInsertions), true);
  assert.equal(Number.isFinite(out.share), true);
});

// ── топ ──────────────────────────────────────────────────────────────────────

test('топ упорядочен по убыванию использований', () => {
  const items = [
    { id: 'a', used: 5 }, { id: 'b', used: 40 }, { id: 'c', used: 12 },
  ];

  assert.deepEqual(topUsed(items).map((i) => i.id), ['b', 'c', 'a']);
});

test('топ ограничен по длине', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `c-${i}`, used: i }));

  assert.equal(topUsed(items, 5).length, 5);
  assert.equal(topUsed(items)[0].id, 'c-29', 'по умолчанию тоже сортировка верная');
});

test('топ не изменяет исходный массив', () => {
  const items = [{ id: 'a', used: 5 }, { id: 'b', used: 40 }];

  topUsed(items);

  assert.deepEqual(items.map((i) => i.id), ['a', 'b']);
});

test('в топе есть название для показа, даже когда его нет в файле', () => {
  const out = topUsed([{ id: 'c-x', group: 'code', used: 3 }]);

  assert.equal(out[0].title, 'c-x', 'вместо пустоты подставляется id');
  assert.equal(out[0].group, 'code', 'группа нужна, чтобы открыть промпт');
});
