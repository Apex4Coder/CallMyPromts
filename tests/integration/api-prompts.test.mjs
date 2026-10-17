// tests/integration/api-prompts.test.mjs — API библиотеки промптов через живой сервер.
//
// Требование: REQ-API-PROMPTS (docs/SPEC.md §6). Сценарии S-01, S-02, S-03.
// Проверяемый файл: server/routes-prompts.mjs.
// Привязка, заголовки и состояние — в tests/integration/api.test.mjs.
//
// Выделено из api.test.mjs вслед за разделением самого обработчика: файл вырос за
// 300 строк, и раскладка повторяет раскладку кода — один файл маршрутов, один файл
// тестов к нему.
//
// Здесь поднимается настоящий сервер на свободном порту и запросы идут по HTTP.
// Разница с unit-тестами существенная: unit проверяет функцию, а этот файл — что
// маршрут заведён, обработчик к нему привязан, коды ответов те, что обещаны
// интерфейсу, и наружу не уходит то, что уходить не должно.

import test from 'node:test';
import assert from 'node:assert/strict';

import { tempRoot, cleanup, promptFile, startServer } from '../helpers/harness.mjs';

/** Сервер с библиотекой из фикстур. Закрытие обязательно: иначе порт останется. */
const withServer = async (fn, { prompts = [] } = {}) => {
  const root = tempRoot();
  const libRoot = `${root}/prompts`;

  for (const p of prompts) promptFile(libRoot, p.group ?? 'code', p.id, p);

  const up = await startServer(root);
  try {
    await fn(up, { root, libRoot });
  } finally {
    await up.close();
    cleanup(root);
  }
};

const THREE = [
  { id: 'c-review', group: 'code', title: 'Ревью кода', pin: 1, used: 12, last_used: '2026-09-05T10:00:00.000Z' },
  { id: 'c-bug', group: 'code', title: 'Поиск ошибки', used: 3 },
  { id: 'r-deep', group: 'research', title: 'Глубокое исследование', used: 0 },
];

// ── список промптов ──────────────────────────────────────────────────────────

test('список отдаёт все промпты с группами и статистикой', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/prompts');

    assert.equal(res.status, 200);
    assert.equal(res.data.items.length, 3);
    assert.equal(res.data.groups.length, 2, 'code и research');
    assert.equal(res.data.stats.total, 3);
  }, { prompts: THREE });
});

test('тело промпта в списке не передаётся', async () => {
  // На 26 файлах это сотни килобайт на каждый кадр поиска.
  await withServer(async (up) => {
    const res = await up.call('/api/prompts');

    for (const item of res.data.items) {
      assert.equal(item.body, undefined, `${item.id}: тело в списке`);
      assert.equal(item.raw, undefined, `${item.id}: исходник в списке`);
    }
  }, { prompts: THREE });
});

test('закреплённый промпт идёт первым и знает свою позицию', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/prompts');

    assert.equal(res.data.items[0].id, 'c-review');
    assert.equal(res.data.items[0].pin, 1);
    assert.equal(res.data.pins.length >= 1, true, 'позиции закреплённых отданы');
  }, { prompts: THREE });
});

test('поиск сужает список и помечает совпадение', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/prompts?q=ревью');

    assert.equal(res.data.items.length, 1);
    assert.equal(res.data.items[0].id, 'c-review');
    assert.notEqual(res.data.items[0].match, null, 'совпадение не отмечено');
  }, { prompts: THREE });
});

test('подсветка уходит частями, а не разметкой', async () => {
  // Содержимое промпта не должно становиться HTML: подсветку собирает DOM.
  await withServer(async (up) => {
    const res = await up.call('/api/prompts?q=ревью');
    const parts = res.data.items[0].match.parts;

    assert.equal(Array.isArray(parts), true);
    assert.equal(parts.map((p) => p.text).join(''), 'Ревью кода', 'склейка не равна исходнику');
    assert.equal(parts.some((p) => p.hit), true, 'ни одна часть не помечена');
  }, { prompts: THREE });
});

test('фильтр по группе работает', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/prompts?group=research');

    assert.equal(res.data.items.length, 1);
    assert.equal(res.data.items[0].group, 'research');
  }, { prompts: THREE });
});

test('пустая библиотека объясняет пустоту, а не молчит', async () => {
  // S-01, плохой путь 2: окно открылось, а промптов нет.
  await withServer(async (up) => {
    const res = await up.call('/api/prompts');

    assert.equal(res.data.items.length, 0);
    assert.equal(res.data.empty.reason, 'no_prompts');
    assert.match(res.data.empty.message, /Ctrl\+Shift\+S/, 'сказано, как создать первый');
  });
});

test('ничего не найдено — это другая пустота, с запросом в тексте', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/prompts?q=такогонет');

    assert.equal(res.data.empty.reason, 'no_match');
    assert.match(res.data.empty.message, /такогонет/);
  }, { prompts: THREE });
});

// ── один промпт ──────────────────────────────────────────────────────────────

test('промпт по идентификатору отдаётся с телом', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/prompt/c-review');

    assert.equal(res.status, 200);
    assert.equal(res.data.item.id, 'c-review');
    assert.match(res.data.item.body, /Тело промпта/);
  }, { prompts: THREE });
});

test('несуществующий промпт даёт 404 с именем', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/prompt/нет-такого');

    assert.equal(res.status, 404);
    assert.equal(res.data.error, 'not_found');
    assert.match(res.data.message, /нет-такого/);
  }, { prompts: THREE });
});

// ── создание ─────────────────────────────────────────────────────────────────

test('промпт создаётся и сразу виден в списке', async () => {
  // S-03, шаг 4: без перезапуска сервиса.
  await withServer(async (up) => {
    const made = await up.call('/api/prompt', {
      method: 'POST',
      body: { title: 'Новый промпт', group: 'code', body: 'Текст нового промпта.' },
    });

    assert.equal(made.status, 201);
    const list = await up.call('/api/prompts');
    assert.equal(list.data.items.some((i) => i.id === made.data.id), true, 'нет в списке');
  }, { prompts: THREE });
});

test('создание без имени отвергается с указанием поля', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/prompt', { method: 'POST', body: { group: 'code', body: 'Текст.' } });

    assert.equal(res.status, 400);
    assert.equal(res.data.field, 'title');
    assert.equal(typeof res.data.message, 'string');
  });
});

test('битое тело запроса объясняется, а не даёт 500', async () => {
  await withServer(async (up) => {
    const res = await fetch(`${up.url}api/prompt`, {
      method: 'POST',
      headers: { 'X-Deck-Token': up.token, 'Content-Type': 'application/json' },
      body: '{ это не json',
    });
    const data = await res.json();

    assert.equal(res.status, 400);
    assert.equal(data.error, 'bad_json');
  });
});

// ── счётчик использований ────────────────────────────────────────────────────

test('счётчик растёт после вставки', async () => {
  // Утверждение U-19. Метрика, которую ведёт человек, — это не метрика.
  await withServer(async (up) => {
    const before = (await up.call('/api/prompt/c-bug')).data.item.usage.used;
    const counted = await up.call('/api/prompt/c-bug/used?group=code', { method: 'POST' });

    assert.equal(counted.status, 200);
    const after = (await up.call('/api/prompt/c-bug')).data.item.usage.used;
    assert.equal(after, before + 1);
  }, { prompts: THREE });
});

test('счёт без группы отвергается: файл иначе не найти', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/prompt/c-bug/used', { method: 'POST' });

    assert.equal(res.status, 400);
    assert.equal(res.data.field, 'group');
  }, { prompts: THREE });
});
