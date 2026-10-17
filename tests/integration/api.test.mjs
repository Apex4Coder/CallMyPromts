// tests/integration/api.test.mjs — привязка сервера и состояние системы.
//
// Требования: REQ-API-BIND, REQ-API-SYSTEM (docs/SPEC.md §6).
// Сценарии: S-08, S-12. Формат ошибок: docs/DATA-CONTRACTS.md §6.
// Промпты — в tests/integration/api-prompts.test.mjs, журнал буфера — в
// tests/integration/promote.test.mjs, настройки — в api-settings.test.mjs.
//
// Здесь поднимается настоящий сервер на свободном порту и запросы идут по HTTP.
// Разница с unit-тестами существенная: unit проверяет функцию, а этот файл —
// что маршрут заведён, обработчик к нему привязан, коды ответов те, что обещаны
// интерфейсу, и наружу не уходит то, что уходить не должно.
//
// Порт всегда 0: тесты не занимают 8791 и не мешают работающему сервису.
// Журнал буфера и настройки — во временном корне, настоящие данные не тронуты.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { tempRoot, cleanup, promptFile, settingsFile, startServer } from '../helpers/harness.mjs';

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

// ── привязка и адрес ─────────────────────────────────────────────────────────

test('сервер отвечает на 127.0.0.1', async () => {
  await withServer(async (up) => {
    assert.match(up.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal((await up.call('/api/system')).status, 200);
  });
});

test('порт 0 даёт свободный порт, а не 8791', async () => {
  // Тест, занимающий рабочий порт, ломает работающее приложение.
  await withServer(async (up) => {
    assert.equal(up.port > 0, true);
    assert.notEqual(up.port, 8791);
  });
});

test('занятый настроенный порт приводит к выбору следующего свободного', async () => {
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });

  const occupied = blocker.address().port;
  const root = tempRoot();
  settingsFile(root, { server: { port: occupied } });

  let up = null;
  try {
    const { start } = await import('../../server/index.mjs');
    up = await start({ root });

    assert.equal(up.ok, true);
    assert.equal(up.port > occupied, true);
    assert.notEqual(up.port, occupied);
    assert.equal(up.portFallback?.from, occupied);
    assert.equal(up.portFallback?.to, up.port);
  } finally {
    if (up?.ok) await up.close();
    await new Promise((resolve) => blocker.close(resolve));
    cleanup(root);
  }
});

test('несуществующий маршрут даёт 404 с методом и путём', async () => {
  // «404» без указания, чего именно нет, бесполезен при отладке моста.
  // Путь в сообщении раскодирован: сопоставление маршрутов идёт по сырому пути,
  // но «/api/%D0%BD%D0%B5%D1%82» человеку ничего не говорит.
  await withServer(async (up) => {
    const res = await up.call('/api/нет-такого');

    assert.equal(res.status, 404);
    assert.equal(res.data.error, 'no_route');
    assert.match(res.data.message, /GET \/api\/нет-такого/);
  });
});

test('страница интерфейса отдаётся без токена', async () => {
  // Браузер не может добавить заголовок к навигационному запросу.
  await withServer(async (up) => {
    const res = await fetch(up.url);

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});

test('заголовки безопасности стоят на каждом ответе', async () => {
  await withServer(async (up) => {
    const res = await up.call('/api/system');

    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  });
});

test('токен не отдаётся ни одной формой обхода пути', async () => {
  // Требование сформулировано по результату, а не по коду ответа: важно, что
  // содержимое state/token не уходит в браузер. Первая версия проверки ждала
  // 403 и падала на 401 — сервер защитился раньше, чем ожидалось, потому что
  // `/state/token` не входит в список публичных путей.
  //
  // Проверяются три формы, и все три обезврежены разными механизмами:
  //   • обычный обход `fetch` сворачивает сам до запроса;
  //   • закодированный доходит до сервера, но `normalize` от абсолютного пути
  //     съедает лишние `..` — за корень выйти нельзя;
  //   • прямой путь к файлу не публичный и требует токена.
  await withServer(async (up) => {
    for (const attack of [
      'styles/../../state/token',
      'styles/%2e%2e%2f%2e%2e%2fstate/token',
      'state/token',
    ]) {
      const res = await fetch(up.url + attack);
      const body = await res.text();

      assert.notEqual(res.status, 200, `${attack}: отдан код 200`);
      assert.equal(/^[0-9a-f]{32}$/m.test(body.trim()), false, `${attack}: в ответе токен`);
      assert.equal(body.includes(up.token), false, `${attack}: в ответе токен`);
    }
  });
});

// ── состояние ────────────────────────────────────────────────────────────────

test('состояние системы отдаёт сервис, библиотеку и счётчики', async () => {
  // S-12: проверка целостности одним запросом.
  await withServer(async (up) => {
    const res = await up.call('/api/system');

    assert.equal(res.data.service.state, 'good');
    assert.equal(res.data.service.port, up.port);
    assert.equal(res.data.library.total, 3);
    assert.equal(typeof res.data.usage, 'object');
  }, { prompts: THREE });
});

test('в состоянии нет технических значений вместо данных', async () => {
  // Утверждение U-14: undefined и NaN до экрана не доходят.
  await withServer(async (up) => {
    const text = JSON.stringify((await up.call('/api/system')).data);

    assert.equal(text.includes('null,"port":null'), false);
    assert.equal(/NaN|undefined/.test(text), false, text.slice(0, 400));
  }, { prompts: THREE });
});

test('битый промпт назван в проблемах, но не ломает ответ', async () => {
  // REQ-LIB-ISOLATE через API: один испорченный файл виден в диагностике.
  await withServer(async (up, { libRoot }) => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(`${libRoot}/code`, { recursive: true });
    writeFileSync(`${libRoot}/code/broken.md`, 'просто текст без метаданных\n', 'utf8');

    const res = await up.call('/api/system');
    assert.equal(res.status, 200);
    assert.equal(res.data.problems.length >= 1, true, 'проблема не показана');
    assert.equal(res.data.problems[0].issues.length >= 1, true, 'причина не названа');
  }, { prompts: THREE });
});
